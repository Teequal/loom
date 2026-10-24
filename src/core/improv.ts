import { eq } from "drizzle-orm";
import { z } from "zod";
import { callLlm, type LlmResult } from "./llm";
import { findMentions, loadThreadContexts, retrieveThreads, selectThreads, type SelectedThread, type ThreadContext } from "./retrieval";
import { PILLARS, type Pillar } from "./db/schema";
import { db, schema } from "./db/client";
import { embeddingProvider, ensureEmbeddings, searchByMeaning, type MeaningSearch } from "./embeddings";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { listMoments, momentLine } from "./moments";
import { personalLines, spotlightScore, tableSeats, tableText } from "./players";
import { buildScene, type Scene } from "./scene";
import { capabilitiesOf, checkBeat, checkOnFail, checkPossession, holdersOf, makeTagger, type CheckContext, type Possession, type ScaffoldBeat, type Tagger } from "./scaffold";

// The improv box answers with a scaffold, not free prose. The answer format is built for each
// request: the "who acts" slot only offers characters allowed to act right now, the thread slot
// only the threads that were sent, the hand-off slot only conscious PCs. The API enforces those
// lists while the model writes, so a PC or a dead NPC can't be put in the acting slot at all.
// Names are written as {tags}; code renders the text and checks the free-text parts.

export interface ScaffoldOption {
  thread: string; // "T12"
  also_ties_to: string[];
  label: string;
  setup: ScaffoldBeat[];
  hand_off: { to: string; kind: "question" | "roll"; mechanic: string; text: string };
  on_fail: { target: string; effect: string };
  why: string;
  callback?: string; // "M12" if it calls back a key moment, else "none"
  pillar?: Pillar; // what kind of play it offers: combat, social, exploration, mystery, comedy, drama
}

export interface ImprovOption {
  thread_id: number;
  also_ties_to: number[];
  label: string;
  option: string; // readable text rendered from the scaffold
  why: string;
  callback: { id: number; title: string } | null;
  scaffold: ScaffoldOption; // kept for the flavour pass
}

const SYSTEM = `You are Loom, a game master's assistant used live at the table. The players just did something unexpected. Offer 4 short, playable options that tie the moment back to threads already in the campaign, instead of inventing new material.

Rules:
- Every option builds on one of the listed threads (thread). Prefer options that pay off, complicate or collide existing threads. also_ties_to lists other threads the option genuinely uses; one strong tie beats three loose ones.
- Get the facts right: who did what to whom must match the threads and cards exactly.
- Match the energy of the moment: comedic stays comedic, tense stays tense. LENGTH and TONE at the end say how much to write and how dramatic to be.
- Serve where the story is going: when the GM has said where they want it to head, options should move toward that, not away from it. Build on what this session has already established.
- The GM controls the world, NPCs and consequences; the players control their characters (PCs). Never decide what a PC does, says, thinks or feels.
- Use what's already established: characters' abilities, health and gear, relationships, and the GM's mechanics. Threads and fields marked as GM secrets shape what happens but are never stated outright.
- Small table-level details (a sound, a line of dialogue, an unnamed extra) are fine; new plots, factions or major NPCs are not. Never include anything on the safety lines.
- Make the options genuinely different from each other.

TAGS: write every named character, place, item and mechanic in curly braces, exactly as named in the scene, e.g. {Zara the Unbound}, {Figurine madness}. To make it read naturally, add how it should read after a bar: {Figurines of a knight and a monk|the monk figurine}, {Zara the Unbound|Zara}.

Each option is a scaffold:
- setup: short beats of what happens right now, as many and as long as LENGTH says. Each beat has a kind and an actor from the allowed list:
  - "world": the environment, magic or events. actor "world". does is a full sentence; things may happen to or around a PC ("{Khayiulad}'s figurine grows warm against his palm").
  - "npc": a character who is here acts or speaks. actor is their name. does is what they do, without repeating the name ("turns the figurine over and goes pale").
  - "walk_on": an unnamed extra (a merchant, a guard). actor "walk-on", walk_on describes them ("a nervous merchant"), does is what they do.
  - "arrival": a character who isn't here arrives ("bursts through the door, breathless").
  - "remote": a character who isn't here acts from afar ("sends a runner with a sealed note").
  - "outcome": the immediate physical result of what a PC just declared in this moment ("hits the cobblestones hard"). actor is that PC. No new decisions, words, thoughts or feelings.
  PCs never act in any other kind, and never act inside another beat's sentence.
  Describe what happens TO a PC (sensations, forces, what they see or feel), never how they react: no swaying, bracing, staggering, flinching, clutching, stepping back or gripping tighter. Write "The vision tears through {Khayiulad}, and the corridor tilts", not "{Khayiulad} sways as the vision tears through him, one hand braced against the wall". The player decides the reaction; only on_fail may move a PC's body.
- hand_off: how the players get involved. to is a PC or "table". kind "question" asks the player what their character does; kind "roll" names the roll. mechanic is a rule from RULES IN PLAY if this roll is one, else "none"; a rule's roll can only go to someone it applies to right now (listed after "now"), or to "table" if it applies to everyone. text is one short sentence for the GM, e.g. "Ask {Salaena}'s player whether she reaches for him." or "{Khayiulad} makes a madness roll."
- on_fail: for rolls only. target is the PC who rolled, effect is what happens if the roll fails, one short sentence that adds something new. For a roll by the table, the effect says who it hits ("whoever fails…"), never "he" or "she". This is the only place a PC may act against their player's will. Otherwise target "none" and effect "".
- label: 2-5 words. why: under 15 words, why this fits now; don't repeat the thread title or use thread numbers.
- callback: if the option echoes or pays off one of the KEY MOMENTS listed, its id ("M12"); otherwise "none". Use one only when it genuinely fits.
- pillar: the kind of play the option mostly offers: combat, social, exploration, mystery, comedy or drama.
- THE TABLE says who has been quiet. Hand-offs mostly go to whoever the moment is about; at most one option goes to a quiet player instead, and only when it fits. Never mention players.`;

// Conditions the moment itself states ("Iresia, at 0 HP and unconscious…"). The moment wins for
// this call, like possession, and the GM is told the records disagree.
const MOMENT_CONDITIONS: [RegExp, string][] = [
  [/\b(?:unconscious|knocked out|out cold|passed out|at 0 hp|at 0 hit points|at zero hit points|dropped to 0)\b/i, "unconscious"],
  [/\bparaly[sz]ed\b/i, "paralyzed"],
  [/\bstunned\b/i, "stunned"],
  [/\bpetrified\b|\bturned to stone\b/i, "petrified"],
  [/\brestrained\b|\btied up\b|\bbound\b/i, "restrained"],
  [/\bblinded\b/i, "blinded"],
  [/\bdeafened\b/i, "deafened"],
  [/\bcharmed\b/i, "charmed"],
  [/\bfrightened\b/i, "frightened"],
];

function momentConditions(scene: Scene, moment: string, mentioned: Set<string>) {
  const notes: string[] = [];
  const stated: string[] = [];
  const pcs = scene.pcs.filter((p) => mentioned.has(p.name));
  if (!pcs.length) return { notes, stated };
  for (const clause of moment.split(/[.;!?]+/)) {
    // The condition belongs to the PC named last before it in the same sentence (or the only one named).
    for (const [re, condition] of MOMENT_CONDITIONS) {
      const m = clause.match(re);
      if (!m) continue;
      const before = clause.slice(0, m.index).toLowerCase();
      const pc =
        pcs.length === 1
          ? pcs[0]
          : pcs
              .map((p) => ({ p, at: before.lastIndexOf(p.name.split(" ")[0].toLowerCase()) }))
              .filter((x) => x.at >= 0)
              .sort((a, b) => b.at - a.at)[0]?.p;
      if (!pc) continue;
      const t = pc.traits as { health?: string; conditions?: string[] };
      const has = condition === "unconscious" ? t.health === "unconscious" || t.conditions?.includes("unconscious") : t.conditions?.includes(condition);
      if (has) continue;
      const traits = condition === "unconscious" ? { ...t, health: "unconscious" } : { ...t, conditions: [...(t.conditions ?? []), condition] };
      for (const e of [pc, ...scene.entities.filter((x) => x.id === pc.id)]) e.traits = traits as typeof e.traits;
      const field = condition === "unconscious" ? "health=unconscious" : `conditions="${traits.conditions!.join(", ")}"`;
      notes.push(`This moment has ${pc.name} ${condition}; your records don't. Update with: entity set "${pc.name}" ${field}`);
      stated.push(`${pc.name} is ${condition} (${condition === "unconscious" ? "can't act, speak or notice anything; death saves only" : "per the 5e condition"})`);
    }
  }
  return { notes, stated };
}

// Moments where the players themselves reach someone at a distance; that NPC may then act from afar.
const REMOTE_CONTACT =
  /\b(?:sending|message|messenger|letter|scry|scrying|telepath\w*|dream\w*|commune|whisper\w* to|call\w* out to|contact\w*|reach(?:es|ing)? out|speak\w* with|crystal ball)\b/i;
// Moments about the whole party, so any PC's declared action can have an outcome.
const WHOLE_PARTY = /\b(?:the party|everyone|the group|they all|we)\b/i;

const nonEmpty = (xs: string[], fallback: string): [string, ...string[]] => (xs.length ? (xs as [string, ...string[]]) : [fallback]);

function optionsSchema(lists: { threads: string[]; actors: string[]; handOff: string[]; pcs: string[]; mechanics: string[]; moments: string[] }) {
  const Beat = z.object({
    kind: z.enum(["world", "npc", "walk_on", "arrival", "remote", "outcome"]),
    actor: z.enum(nonEmpty(["world", "walk-on", ...lists.actors], "world")),
    walk_on: z.string(),
    does: z.string(),
  });
  const thread = z.enum(nonEmpty(lists.threads, "T0"));
  return z.object({
    options: z.array(
      z.object({
        thread,
        also_ties_to: z.array(thread),
        label: z.string(),
        setup: z.array(Beat),
        hand_off: z.object({
          to: z.enum(nonEmpty(["table", ...lists.handOff], "table")),
          kind: z.enum(["question", "roll"]),
          mechanic: z.enum(nonEmpty(["none", ...lists.mechanics], "none")),
          text: z.string(),
        }),
        // Free text, normalised in code (normaliseHandOff): one odd target ("everyone") used to make the
        // whole answer unparseable.
        on_fail: z.object({ target: z.string(), effect: z.string() }),
        why: z.string(),
        // Free text, checked in code: with no key moments the enum was just "none", and a model that
        // wrote anything else made the whole answer unparseable.
        callback: z.string(),
        pillar: z.enum(PILLARS),
      }),
    ),
  });
}

function threadBlock(t: ThreadContext, titleOf: Map<number, string>, typeOf: Map<string, string>) {
  const lines = [`T${t.id} [${t.kind}${t.status === "progressing" ? ", in progress" : ""}] ${t.title}`, `  ${t.summary}`];
  if (t.latestNote) lines.push(`  Latest: ${t.latestNote}`);
  if (t.entities.length) {
    const label = (n: string) => (typeOf.get(n) === "pc" ? `${n} (PC)` : typeOf.get(n) === "npc" ? `${n} (NPC)` : n);
    lines.push(`  Involves: ${t.entities.map(label).join(", ")}`);
  }
  const links = t.links.filter((l) => titleOf.has(l.threadId));
  if (links.length) lines.push(`  Linked: ${links.map((l) => `T${l.threadId} (${l.note})`).join("; ")}`);
  return lines.join("\n");
}

const sentence = (s: string) => {
  const t = s.trim();
  return t && !/[.!?"'”’]$/.test(t) ? `${t}.` : t;
};
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// One beat as readable text: the actor's name is put in front by code, so the subject is
// always the actor the scaffold named.
export function renderBeat(b: ScaffoldBeat, tagger: Tagger) {
  const tagged = tagger.tag(b.does).trim();
  // "Uses the tables as cover" after a name reads "Vex'ahlia uses…"; names (tagged) keep their capital.
  const does = tagger.render(b.kind === "world" || b.actor === "world" || tagged.startsWith("{") ? tagged : tagged.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())).trim();
  // "world" as the actor of another kind of beat is still the world talking, not a character called World.
  if (b.kind === "world" || b.actor === "world") return sentence(capitalise(does));
  const subject = b.kind === "walk_on" || b.actor === "walk-on" ? capitalise(tagger.render(b.walk_on).trim() || "someone") : b.actor;
  const startsWithSubject = does.toLowerCase().startsWith(subject.toLowerCase()) || does.toLowerCase().startsWith(subject.split(/[\s,]+/)[0].toLowerCase());
  return sentence(startsWithSubject ? capitalise(does) : `${subject} ${does}`);
}

export function renderOption(o: ScaffoldOption, tagger: Tagger) {
  const parts = o.setup.map((b) => renderBeat(b, tagger));
  const mech = o.hand_off.mechanic !== "none" && !tagger.render(o.hand_off.text).includes(o.hand_off.mechanic) ? ` (${o.hand_off.mechanic})` : "";
  parts.push(sentence(tagger.render(tagger.tag(o.hand_off.text)).replace(/[.]$/, "") + mech));
  if (o.hand_off.kind === "roll" && o.on_fail.target !== "none" && o.on_fail.effect.trim()) {
    parts.push(`On a failure: ${renderOnFail(o.on_fail.target, o.on_fail.effect, tagger)}`);
  }
  return parts.filter(Boolean).join(" ");
}

// "loses her grip…" → "Salaena loses her grip…"; drops a repeated "On a failure," prefix.
export function renderOnFail(target: string, effect: string, tagger: Tagger) {
  const text = tagger.render(tagger.tag(effect)).trim().replace(/^on a fail(?:ure|ed roll)?[,:]?\s*/i, "");
  const startsWithVerb = target !== "table" && /^[a-z]/.test(text) && !/^(?:he|she|they|it|his|her|their|its|the|a|an|for|as|while|when|with)\b/.test(text);
  return sentence(capitalise(startsWithVerb ? `${target} ${text}` : text));
}

// The table notes (who's been quiet, what players enjoy) steer ranking; they must never show.
const TABLE_TALK = /\b(?:spotlight|quiet (?:soul|one|player|lately|this session)|hasn'?t had (?:a|the|their) (?:moment|turn)|(?:their|the) player enjoys|player'?s? (?:preference|taste)s?)\b/i;

// A hand-off to "the table" whose text names exactly one PC is really to that PC.
export function normaliseHandOff(o: ScaffoldOption, c: CheckContext) {
  if (o.hand_off.to === "table") {
    const named = [...new Set(c.tagger.tagsIn(c.tagger.tag(o.hand_off.text)).filter((n) => c.tagger.entityOf(n)?.type === "pc"))];
    if (named.length === 1) o.hand_off.to = named[0];
  }
  // The failure lands on whoever rolled; for a table roll, on whoever fails.
  const pcs = new Set(c.scene.pcs.map((p) => p.name));
  if (o.on_fail.target !== "none" && !pcs.has(o.on_fail.target)) o.on_fail.target = o.hand_off.to;
  if (!o.on_fail.effect.trim()) o.on_fail.target = "none";
}

export function checkOption(o: ScaffoldOption, c: CheckContext): string | null {
  if (!o.setup.length) return "has no setup";
  if ([o.hand_off.text, o.why, o.on_fail.effect, ...o.setup.map((b) => b.does)].some((t) => TABLE_TALK.test(t))) return "mentions the table notes";
  // The real people at the table are never named, only their characters.
  const texts = [o.label, o.hand_off.text, o.why, o.on_fail.effect, ...o.setup.map((b) => b.does), ...o.setup.map((b) => b.walk_on)];
  const real = c.scene.realNames.find((n) => texts.some((t) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)));
  if (real) return `names a real player (${real})`;
  for (const b of o.setup) {
    const r = checkBeat(b, c);
    if (r) return r;
  }
  // Items are used or held only by whoever has them; hand-overs in the beats count from then on.
  const poss = checkPossession(o.setup, c);
  if (poss.problem) return poss.problem;
  // Who's being asked must be able to answer: a question needs someone who can act; a roll needs
  // someone aware (except death saves).
  const pc = o.hand_off.to !== "table" ? c.tagger.entityOf(o.hand_off.to) : undefined;
  if (pc) {
    const caps = capabilitiesOf(pc);
    const why = caps.causes?.join(", ") || "incapacitated";
    if (o.hand_off.kind === "question" && !caps.act) return `asks what ${pc.name} does, but ${pc.name} can't act (${why})`;
    if (o.hand_off.kind === "roll" && !caps.aware && !/death sav/i.test(o.hand_off.text)) return `asks ${pc.name} for a roll, but ${pc.name} isn't aware (${why})`;
  }

  // An effect's roll only goes to someone it applies to right now.
  if (o.hand_off.mechanic !== "none") {
    const eff = c.scene.effects.find((e) => e.effect.name === o.hand_off.mechanic);
    if (!eff) return `uses an unknown rule "${o.hand_off.mechanic}"`;
    if (o.hand_off.kind !== "roll") return `uses "${eff.effect.name}" without a roll`;
    if (o.hand_off.to === "table") {
      if (!eff.tableWide) return `calls "${eff.effect.name}" for the whole table, but it only applies to ${eff.targets.join(", ") || "nobody right now"}`;
    } else if (!eff.targets.includes(o.hand_off.to) && !gainsSource(eff, o.hand_off.to, poss.gained, c)) {
      return `"${eff.effect.name}" doesn't apply to ${o.hand_off.to} (applies to ${eff.effect.appliesTo.replace(/-/g, " ")}: ${eff.targets.join(", ") || "nobody right now"})`;
    }
  }

  if (o.on_fail.target !== "none") {
    if (o.hand_off.kind !== "roll") return "has a failure consequence but no roll";
    if (o.hand_off.to !== "table" && o.on_fail.target !== o.hand_off.to) return `the failure lands on ${o.on_fail.target}, but ${o.hand_off.to} made the roll`;
    if (o.hand_off.to === "table" && /\b(?:he|she|him|her|his|hers|himself|herself)\b/i.test(o.on_fail.effect)) return "the whole table rolls, but the failure says he or she";
    const r = checkOnFail(o.on_fail.target, o.on_fail.effect, c);
    if (r) return r;
  }
  return null;
}

function isInside(item: string, container: string, parentOf: Map<string, string>) {
  for (let cur = parentOf.get(item), hops = 0; cur && hops < 10; cur = parentOf.get(cur), hops++) if (cur === container) return true;
  return false;
}

// A holder- or user-bound rule also reaches someone who gains its item in this option (a beat
// hands it over), or whom the moment itself puts with it.
function gainsSource(eff: Scene["effects"][number], who: string, gained: Map<string, Set<string>>, c: CheckContext) {
  if (!["holder", "user"].includes(eff.effect.appliesTo) || eff.sourceName == null) return false;
  const inSource = (item: string) => {
    for (let cur: string | undefined = item, hops = 0; cur && hops < 10; cur = c.possession.parentOf.get(cur), hops++) if (cur === eff.sourceName) return true;
    return false;
  };
  for (const [item, people] of gained) if (people.has(who) && inSource(item)) return true;
  for (const [item, people] of c.possession.holders) if (people.has(who) && inSource(item)) return true;
  return false;
}

// What meaning search found, for --why.
function meaningSummary(m: MeaningSearch | undefined, entities: Scene["entities"], sessionNumber: Map<number, number>, model: string | null, note: string | null) {
  if (!m) return { model, note, lines: [] as string[] };
  const nameOf = (id: number) => entities.find((e) => e.id === id)?.name ?? `#${id}`;
  const lines = [
    ...m.entities.filter((h) => h.z >= 1.5).slice(0, 3).map((h) => `entity ${nameOf(h.ownerId)} (${h.sim.toFixed(2)})`),
    ...m.scenes.filter((h) => h.z >= 1.5).slice(0, 2).map((h) => `scene from session ${sessionNumber.get(h.ownerId) ?? "?"} (${h.sim.toFixed(2)}): ${h.text.slice(0, 70)}…`),
  ];
  return { model, note, lines };
}

// The lists that shape the answer format, and the context the checks use.
// `reach`: entity ids close enough to the moment to be offered as actors (see graph.ts). Without
// it, every entity is offered.
export function buildLists(scene: Scene, moment: string, mentioned: Set<string>, reach?: Map<number, number>) {
  const { notes, stated } = momentConditions(scene, moment, mentioned);
  const tagger = makeTagger(scene);
  const alive = (e: Scene["entities"][number]) => e.status !== "dead";
  const free = (e: Scene["entities"][number]) => e.status !== "captured" && e.status !== "missing";
  // Who may act directly: NPCs, factions and items that are here, plus NPCs the players brought
  // in by naming them (going to see them, calling to them), unless captured or missing.
  const present = new Set(
    scene.entities
      .filter((e) => (e.type === "npc" || e.type === "faction" || e.type === "item") && alive(e) && free(e))
      // NPCs act directly only when they're travelling with the party or the moment brings them in;
      // anyone else (unknown whereabouts, or recorded nearby) has to arrive first.
      .filter((e) => e.type !== "npc" || scene.presence(e) === "with-party" || mentioned.has(e.name))
      .map((e) => e.name),
  );
  const remoteOk = new Set(REMOTE_CONTACT.test(moment) ? scene.entities.filter((e) => e.type === "npc" && mentioned.has(e.name) && alive(e)).map((e) => e.name) : []);
  const absentNpcs = scene.entities.filter((e) => e.type === "npc" && alive(e) && !present.has(e.name)).map((e) => e.name);
  const outcomePcs = new Set(WHOLE_PARTY.test(moment) ? scene.pcs.map((p) => p.name) : scene.pcs.filter((p) => mentioned.has(p.name)).map((p) => p.name));

  // Possession: who holds what, from the records. If the moment itself puts an item with a PC
  // ("Khayiulad sells the monk figurine"), the moment wins for this call, and the GM is told the
  // records disagree.
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  const holders = new Map<string, Set<string>>();
  for (const h of scene.holds) holders.set(h.item, new Set([...(holders.get(h.item) ?? []), h.holder]));
  const parentOf = new Map<string, string>();
  for (const e of scene.entities) if (e.type === "item" && e.parentId != null && byId.get(e.parentId)) parentOf.set(e.name, byId.get(e.parentId)!.name);
  const possession: Possession = { holders, parentOf };
  const momentPcs = scene.pcs.filter((p) => mentioned.has(p.name));
  // The most specific item named: "the monk figurine" means the Monk figurine, not its whole set.
  const named = scene.entities.filter((e) => e.type === "item" && mentioned.has(e.name));
  const momentItems = named.filter((item) => !named.some((other) => other !== item && isInside(other.name, item.name, parentOf)));
  if (momentPcs.length) {
    for (const item of momentItems) {
      const recorded = holdersOf(item.name, possession);
      const withItem = momentPcs.filter((p) => recorded.size && !recorded.has(p.name));
      if (!withItem.length) continue;
      holders.set(item.name, new Set([...(holders.get(item.name) ?? []), ...withItem.map((p) => p.name)]));
      const who = [...recorded];
      notes.push(
        `Your records say ${who.join(" and ")} ${who.length > 1 ? "hold" : "holds"} ${item.name}; this moment has ${withItem.map((p) => p.name).join(" and ")} with it. Update with: relate "${withItem[0].name}" holds "${item.name}"`,
      );
    }
  }

  return {
    tagger,
    notes,
    stated,
    check: { scene, tagger, present, remoteOk, outcomePcs, possession } satisfies CheckContext,
    // Actors on offer: those within reach of the moment (and anyone it names), plus the PCs. A
    // shorter list is cheaper to send and more reliable for the model to choose from.
    actors: [...present, ...absentNpcs]
      .filter((n) => {
        const e = scene.entities.find((x) => x.name === n);
        return !reach || mentioned.has(n) || (e != null && reach.has(e.id));
      })
      .concat(scene.pcs.map((p) => p.name)),
    // Every living PC stays on the list: a name the model insists on (an unconscious PC) then fails
    // one option's check instead of making the whole answer unparseable.
    handOff: scene.pcs.filter((p) => p.status !== "dead").map((p) => p.name),
    pcs: scene.pcs.map((p) => p.name),
    // Only effects that reach someone right now can be offered for a roll.
    mechanics: scene.effects.filter((e) => e.targets.length > 0).map((e) => e.effect.name),
  };
}

const SafetySchema = z.object({ flagged: z.array(z.object({ option: z.number(), line: z.string() })) });

// Safety lines can't be enforced by structure, so when the GM has set any, a fast second look
// drops options that cross one.
async function safetyCheck(lines: string[], texts: string[]) {
  if (!lines.length || !texts.length) return { flagged: new Set<number>(), call: null };
  const prompt = `The table has agreed never to include these topics:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nOptions:\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nList every option that includes, depicts or threatens any of those topics, even indirectly. Options that stay clear of them are not listed.`;
  const call = await callLlm({ feature: "safety", system: "You check tabletop RPG content against the table's safety lines. Be strict.", prompt, schema: SafetySchema, maxTokens: 1000, effort: "low", model: "haiku", fast: true });
  return { flagged: new Set(call.data.flagged.map((f) => f.option - 1)), call };
}

// How much to write follows how much the GM wrote: a quick line gets a quick answer.
export function lengthFor(moment: string) {
  const words = moment.trim().split(/\s+/).length;
  if (words <= 10) return "LENGTH: the GM wrote a quick line, so answer quickly: setup is 1 beat, under 20 words; hand-off one short sentence; why under 10 words.";
  if (words <= 35) return "LENGTH: setup is 1-2 beats, under 35 words in total.";
  return "LENGTH: the GM gave detail, so answer in kind: setup is 2-3 beats, up to 60 words in total, and an option may tie in a second or third thread where it genuinely fits.";
}

// 0 grounded … 4 theatrical. Changes only how things are told, never the rules.
export const TONES = ["Grounded", "Restrained", "Balanced", "Dramatic", "Theatrical"] as const;
const TONE_TEXT = [
  "TONE: grounded. Plain, plausible and understated: no flourishes, no sudden magic or reveals unless a thread already calls for it. Consequences follow from what's established.",
  "TONE: restrained. Mostly plain and plausible, with one vivid detail where it earns its place. Avoid melodrama.",
  "TONE: balanced. Match the campaign's tone; vivid where it matters, never overwrought.",
  "TONE: dramatic. Lean into striking images and rising stakes, while staying true to the threads.",
  "TONE: theatrical. Big, dramatic and cinematic: bold reveals and high stakes, but every beat still ties to a thread.",
];

export interface ImprovOptions {
  tone?: number; // 0 grounded … 4 theatrical (default 1: Jacob found the default a bit theatrical)
  focused?: boolean; // a tighter scene and fewer threads (cheapest); the default is wide
  threads?: number; // send exactly this many threads (plus any tied to what the moment names)
  embeddings?: string; // "local" | "voyage" | "off"; default from LOOM_EMBEDDINGS (local)
  // Called with each option the moment it's written and has passed the checks (up to 3), so a
  // page can show the first one in ~2 s instead of waiting for all of them. With safety lines set,
  // options are held until the safety check has seen them.
  onOption?: (o: ImprovOption) => void;
}

// The complete objects so far in the "options" array of a JSON answer that's still being written.
export function completedOptions(text: string): string[] {
  const at = text.indexOf("[", text.indexOf('"options"'));
  if (at < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" && --depth === 0) out.push(text.slice(start, i + 1));
    else if (ch === "]" && depth === 0) break;
  }
  return out;
}

// mode "ranked" selects threads adaptively; "all" sends every open thread (baseline for comparison).
export async function improv(campaignId: number, moment: string, mode: "ranked" | "all" = "ranked", model?: string, opts: ImprovOptions = {}) {
  const budget = opts.focused ? BUDGETS.improvFocused : BUDGETS.improv;
  const allThreads = await loadThreadContexts(campaignId);

  // What the moment names decides which threads are guaranteed a place.
  const base = await buildScene(campaignId, { mentioned: new Set(), threadEntities: [] });
  const mentioned = new Set(findMentions(base.entities, moment).keys());

  // Meaning (embeddings): finds what the moment is about even when it names nothing. It adds
  // evidence and entry points; the structure still decides what's allowed. If it fails, carry on.
  const provider = embeddingProvider(opts.embeddings);
  let meaning: MeaningSearch | undefined;
  let meaningNote: string | null = null;
  if (provider && mode !== "all") {
    try {
      await ensureEmbeddings(campaignId, provider);
      meaning = await searchByMeaning(campaignId, provider, moment);
    } catch (err) {
      meaningNote = `Meaning search skipped (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const threads: SelectedThread[] =
    mode === "all"
      ? allThreads.map((t) => ({ ...t, score: 0, reasons: [] as string[], detail: "full" as const, guaranteed: false }))
      : selectThreads(await retrieveThreads(campaignId, moment, Number.POSITIVE_INFINITY, meaning), mentioned, { ...budget.threads, exact: opts.threads });
  if (threads.length === 0) throw new Error("This campaign has no open threads yet.");

  const storyConditions = new Map(
    base.pcs.map((p) => [p.name, allThreads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)]),
  );
  // Context by distance: start from who and what the moment names, where the party is, and who
  // is on the two most relevant threads; walk two links out.
  const nameToId = new Map(base.entities.map((e) => [e.name, e.id]));
  const seeds = [
    ...[...mentioned].map((n) => nameToId.get(n)),
    base.partyLocation?.id,
    ...threads.slice(0, 2).flatMap((t) => t.entities.map((n) => nameToId.get(n))),
    // Up to three characters, places or things unusually close in meaning.
    ...(meaning?.entities.filter((h) => h.z >= 1.5).slice(0, 3).map((h) => h.ownerId) ?? []),
  ].filter((id): id is number => id != null);
  const distances = await distancesFrom(campaignId, seeds, budget.depth);
  const scene = await buildScene(campaignId, { mentioned, threadEntities: threads.flatMap((t) => t.entities), storyConditions, distances, budget });
  const lists = buildLists(scene, moment, mentioned, mode === "all" ? undefined : distances);
  const typeOf = new Map(scene.entities.map((e) => [e.name, e.type]));

  // The player layer: who has been quiet and what their players enjoy (ranking only).
  const seats = await tableSeats(campaignId);
  const quietest = seats
    .filter((x) => x.quietFor >= 2 && x.pc.status !== "dead" && capabilitiesOf(x.pc).act)
    .sort((a, b) => b.quietFor - a.quietFor)[0];
  const tableBlock = [
    tableText(seats),
    quietest && `Spotlight: if the moment allows, make exactly one option hand off to ${quietest.pc.name}; the others go to whoever the moment is about.`,
  ]
    .filter(Boolean)
    .join("\n");
  const lines = [...scene.safetyLines, ...(await personalLines(campaignId))];

  // Key moments involving who and what is in play: what a callback could draw on (up to 3).
  const inPlay = new Set([...mentioned, ...threads.slice(0, 4).flatMap((t) => t.entities)]);
  const callbacks = (await listMoments(campaignId, ["key"]))
    .map((m) => ({
      m,
      overlap:
        m.entities.filter((e) => inPlay.has(e)).length +
        (m.threads.some((t) => threads.some((x) => x.id === t.id)) ? 1 : 0) +
        ((meaning?.moments.find((h) => h.ownerId === m.id)?.z ?? 0) >= 1.2 ? 2 : 0),
    }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.m.id - a.m.id)
    .slice(0, 3)
    .map((x) => x.m);

  // The closest scenes from the recaps themselves: things that may never have become threads.
  const sessionNumber = new Map((await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId))).map((x) => [x.id, x.number]));
  const closeScenes = meaning?.scenes.filter((h) => h.z >= 1.5).slice(0, 2) ?? [];
  const sceneBlock = closeScenes.length
    ? `\nFROM YOUR NOTES (closest in meaning; facts only, use if they fit)\n${closeScenes.map((h) => `- Session ${sessionNumber.get(h.ownerId) ?? "?"}: "${h.text.slice(0, 320)}${h.text.length > 320 ? "…" : ""}"`).join("\n")}\n`
    : "";

  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  // The GM's direction for the story, and what this session has already established at the table.
  const [campaignRow] = await db.select({ direction: schema.campaigns.direction }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const direction = campaignRow?.direction.trim() ?? "";
  const soFar = await sessionSoFar(campaignId);
  const OptionsSchema = optionsSchema({ threads: threads.map((t) => `T${t.id}`), actors: lists.actors, handOff: lists.handOff, pcs: lists.pcs, mechanics: lists.mechanics, moments: callbacks.map((m) => `M${m.id}`) });
  const prompt = `${scene.text}

WHO MAY ACT
- Here now (kind "npc"): ${[...lists.check.present].filter((n) => typeOf.get(n) === "npc").join(", ") || "nobody named; use walk-ons"}
- Not here (only kind "arrival" or "remote"): ${lists.actors.filter((n) => typeOf.get(n) === "npc" && !lists.check.present.has(n)).join(", ") || "nobody"}. Bring one in only when it pays off their thread, at most one per option; otherwise use walk-ons.
${lists.stated.length ? `- As of this moment: ${lists.stated.join("; ")}\n` : ""}${lists.check.remoteOk.size ? `- The players reached out to: ${[...lists.check.remoteOk].join(", ")} (they may answer remotely)\n` : ""}${lists.check.possession.holders.size ? `- Who holds what: ${[...lists.check.possession.holders].map(([item, who]) => `${item} (${[...who].join(", ")})`).join("; ")}. Only a holder can use or carry an item, unless a beat hands it over first ("tosses the {X} to {Y}"). A rule tied to an item reaches whoever holds it.\n` : ""}
OPEN THREADS
${threads.map((t) => (t.detail === "full" ? threadBlock(t, titleOf, typeOf) : `T${t.id} [${t.kind}] ${t.title}: ${t.summary}`)).join("\n")}
${sceneBlock}${callbacks.length ? `\nKEY MOMENTS YOU COULD CALL BACK\n${callbacks.map(momentLine).join("\n")}\n` : ""}${tableBlock ? `\n${tableBlock}\n` : ""}
${direction ? `\nWHERE THE GM WANTS THE STORY TO GO\n${direction}\n` : ""}${soFar ? `\nTHIS SESSION SO FAR (what already happened at the table, oldest first)\n${soFar}\n` : ""}
${lengthFor(moment)}
${TONE_TEXT[Math.max(0, Math.min(4, opts.tone ?? 1))]}

WHAT JUST HAPPENED AT THE TABLE
${moment}`;

  const idOf = (ref: string) => Number(ref.replace(/^T/, ""));
  const toOption = (o: ScaffoldOption): ImprovOption => ({
    thread_id: idOf(o.thread),
    also_ties_to: [...new Set(o.also_ties_to.map(idOf))].filter((id) => titleOf.has(id) && id !== idOf(o.thread)),
    label: o.label,
    option: renderOption(o, lists.tagger),
    why: lists.tagger.render(lists.tagger.tag(o.why)),
    callback: (() => {
      const m = callbacks.find((x) => `M${x.id}` === o.callback?.trim());
      return m ? { id: m.id, title: m.title } : null;
    })(),
    scaffold: o,
  });

  // Ask once; if fewer than two options survive the checks, ask once more. Each option is checked
  // as soon as it's complete in the stream, and shown straight away when it passes (no safety lines).
  const calls: LlmResult<unknown>[] = [];
  const accepted: ScaffoldOption[] = [];
  const shown: ScaffoldOption[] = [];
  const rejected: { label: string; reason: string }[] = [];
  const OptionSchema = OptionsSchema.shape.options.element;
  const showEarly = opts.onOption && !lines.length;
  for (let attempt = 0; attempt < 2 && accepted.length < 2; attempt++) {
    let seen = 0;
    const take = (raw: unknown) => {
      const parsed = OptionSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({ label: (raw as { label?: string })?.label ?? "an option", reason: "unusable answer (a value outside the allowed lists)" });
        return;
      }
      const o = parsed.data as ScaffoldOption;
      normaliseHandOff(o, lists.check);
      const reason = checkOption(o, lists.check);
      if (reason) return rejected.push({ label: o.label, reason });
      accepted.push(o);
      if (showEarly && shown.length < 3) {
        shown.push(o);
        opts.onOption!(toOption(o));
      }
    };
    const onText = (snapshot: string) => {
      const done = completedOptions(snapshot);
      for (; seen < done.length; seen++) {
        try {
          take(JSON.parse(done[seen]));
        } catch {
          // not valid JSON yet; the final answer settles it
        }
      }
    };
    // A malformed answer (e.g. a name outside the allowed list) counts as a failed attempt, but any
    // options that streamed in whole before it went wrong still count.
    let res: LlmResult<z.infer<typeof OptionsSchema>>;
    try {
      res = await callLlm({ feature: "improv", campaignId, system: SYSTEM, prompt, schema: OptionsSchema, maxTokens: 4000, effort: "low", model, fast: true, onText });
    } catch (err) {
      rejected.push({ label: `attempt ${attempt + 1}`, reason: `unusable answer (${err instanceof Error ? err.message.slice(0, 60) : "error"}…)` });
      continue;
    }
    calls.push(res);
    for (const o of (res.data.options as ScaffoldOption[]).slice(seen)) take(o);
  }

  // Ranking: whoever the moment is about comes first; the quiet-player nudge is smaller than that.
  // Options already on screen keep their place.
  const score = (o: ScaffoldOption) => spotlightScore(seats, o.hand_off.to, o.pillar ?? "drama") + (mentioned.has(o.hand_off.to) ? 0.7 : 0);
  let kept = [...shown, ...accepted.filter((o) => !shown.includes(o)).sort((a, b) => score(b) - score(a))].slice(0, 3);
  const safety = await safetyCheck(lines, kept.map((o) => renderOption(o, lists.tagger)));
  if (safety.call) calls.push(safety.call);
  for (const i of safety.flagged) if (kept[i]) rejected.push({ label: kept[i].label, reason: "crosses a safety line" });
  kept = kept.filter((_, i) => !safety.flagged.has(i));

  // If the moment itself runs into a safety line, ask again with an explicit instruction to steer
  // away, rather than leaving the GM with nothing.
  let safetyNote: string | null = null;
  if (safety.flagged.size && kept.length < 2) {
    safetyNote = `This moment touches a safety line (${lines.join("; ")}), so these options steer away from it.`;
    const steer = `${prompt}

IMPORTANT: this moment runs into the table's safety line(s): ${lines.join("; ")}. Every option must steer away from it: keep it off-screen, redirect the danger elsewhere (often onto the party or the villain's plans), or resolve it without depicting or threatening it.`;
    const res = await callLlm({ feature: "improv", campaignId, system: SYSTEM, prompt: steer, schema: OptionsSchema, maxTokens: 4000, effort: "low", model, fast: true });
    calls.push(res);
    const fresh = (res.data.options as ScaffoldOption[]).filter((o) => {
      normaliseHandOff(o, lists.check);
      const reason = checkOption(o, lists.check);
      if (reason) rejected.push({ label: o.label, reason });
      return !reason;
    });
    const recheck = await safetyCheck(lines, fresh.map((o) => renderOption(o, lists.tagger)));
    if (recheck.call) calls.push(recheck.call);
    for (const i of recheck.flagged) rejected.push({ label: fresh[i].label, reason: "crosses a safety line" });
    kept = [...kept, ...fresh.filter((_, i) => !recheck.flagged.has(i))].slice(0, 3);
  }

  const options: ImprovOption[] = kept.map(toOption);
  // Anything not shown while streaming (a retry's options, or all of them once safety has checked).
  if (opts.onOption) for (const [i, o] of kept.entries()) if (!shown.includes(o)) opts.onOption(options[i]);

  const llm = {
    model: calls[0]?.model ?? "(no answer)",
    latencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    costUsd: calls.reduce((s, c) => s + c.costUsd, 0),
    attempts: calls.filter((c) => c.model !== "safety" && c !== safety.call).length,
  };
  return { options, dropped: rejected.length, rejected, threads, titleOf, llm, moment, campaignId, safetyNote, notes: lists.notes, quiet: new Map(seats.map((x) => [x.pc.name, x.quietFor])), meaning: meaningSummary(meaning, base.entities, sessionNumber, provider?.model ?? null, meaningNote) };
}
