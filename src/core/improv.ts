import { z } from "zod";
import { callLlm, type LlmResult } from "./llm";
import { findMentions, loadThreadContexts, retrieveThreads, type ThreadContext } from "./retrieval";
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
}

export interface ImprovOption {
  thread_id: number;
  also_ties_to: number[];
  label: string;
  option: string; // readable text rendered from the scaffold
  why: string;
  scaffold: ScaffoldOption; // kept for the flavour pass
}

const SYSTEM = `You are Loom, a game master's assistant used live at the table. The players just did something unexpected. Offer 3 short, playable options that tie the moment back to threads already in the campaign, instead of inventing new material.

Rules:
- Every option builds on one of the listed threads (thread). Prefer options that pay off, complicate or collide existing threads. also_ties_to lists other threads the option genuinely uses; one strong tie beats three loose ones.
- Get the facts right: who did what to whom must match the threads and cards exactly.
- Match the energy of the moment: comedic stays comedic, tense stays tense.
- The GM controls the world, NPCs and consequences; the players control their characters (PCs). Never decide what a PC does, says, thinks or feels.
- Use what's already established: characters' abilities, health and gear, relationships, and the GM's mechanics. Threads and fields marked as GM secrets shape what happens but are never stated outright.
- Small table-level details (a sound, a line of dialogue, an unnamed extra) are fine; new plots, factions or major NPCs are not. Never include anything on the safety lines.
- Make the options genuinely different from each other.

TAGS: write every named character, place, item and mechanic in curly braces, exactly as named in the scene, e.g. {Zara the Unbound}, {Figurine madness}. To make it read naturally, add how it should read after a bar: {Figurines of a knight and a monk|the monk figurine}, {Zara the Unbound|Zara}.

Each option is a scaffold:
- setup: 1-2 short beats of what happens right now, under 35 words in total. Each beat has a kind and an actor from the allowed list:
  - "world": the environment, magic or events. actor "world". does is a full sentence; things may happen to or around a PC ("{Khayiulad}'s figurine grows warm against his palm").
  - "npc": a character who is here acts or speaks. actor is their name. does is what they do, without repeating the name ("turns the figurine over and goes pale").
  - "walk_on": an unnamed extra (a merchant, a guard). actor "walk-on", walk_on describes them ("a nervous merchant"), does is what they do.
  - "arrival": a character who isn't here arrives ("bursts through the door, breathless").
  - "remote": a character who isn't here acts from afar ("sends a runner with a sealed note").
  - "outcome": the immediate physical result of what a PC just declared in this moment ("hits the cobblestones hard"). actor is that PC. No new decisions, words, thoughts or feelings.
  PCs never act in any other kind, and never act inside another beat's sentence.
- hand_off: how the players get involved. to is a PC or "table". kind "question" asks the player what their character does; kind "roll" names the roll. mechanic is a rule from RULES IN PLAY if this roll is one, else "none"; a rule's roll can only go to someone it applies to right now (listed after "now"), or to "table" if it applies to everyone. text is one short sentence for the GM, e.g. "Ask {Salaena}'s player whether she reaches for him." or "{Khayiulad} makes a madness roll."
- on_fail: for rolls only. target is the PC who rolled, effect is what happens if the roll fails, one short sentence that adds something new. This is the only place a PC may act against their player's will. Otherwise target "none" and effect "".
- label: 2-5 words. why: under 15 words, why this fits now; don't repeat the thread title or use thread numbers.`;

// Moments where the players themselves reach someone at a distance; that NPC may then act from afar.
const REMOTE_CONTACT =
  /\b(?:sending|message|messenger|letter|scry|scrying|telepath\w*|dream\w*|commune|whisper\w* to|call\w* out to|contact\w*|reach(?:es|ing)? out|speak\w* with|crystal ball)\b/i;
// Moments about the whole party, so any PC's declared action can have an outcome.
const WHOLE_PARTY = /\b(?:the party|everyone|the group|they all|we)\b/i;

const nonEmpty = (xs: string[], fallback: string): [string, ...string[]] => (xs.length ? (xs as [string, ...string[]]) : [fallback]);

function optionsSchema(lists: { threads: string[]; actors: string[]; handOff: string[]; pcs: string[]; mechanics: string[] }) {
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
        on_fail: z.object({ target: z.enum(nonEmpty(["none", ...lists.pcs], "none")), effect: z.string() }),
        why: z.string(),
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
  const does = tagger.render(tagger.tag(b.does)).trim();
  if (b.kind === "world") return sentence(capitalise(does));
  const subject = b.kind === "walk_on" ? capitalise(tagger.render(b.walk_on).trim()) : b.actor;
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
  const startsWithVerb = /^[a-z]/.test(text) && !/^(?:his|her|their|its|the|a|an|for|as|while|when|with)\b/.test(text);
  return sentence(capitalise(startsWithVerb ? `${target} ${text}` : text));
}

export function checkOption(o: ScaffoldOption, c: CheckContext): string | null {
  if (!o.setup.length) return "has no setup";
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

// The lists that shape the answer format, and the context the checks use.
export function buildLists(scene: Scene, moment: string, mentioned: Set<string>) {
  const tagger = makeTagger(scene);
  const alive = (e: Scene["entities"][number]) => e.status !== "dead";
  const free = (e: Scene["entities"][number]) => e.status !== "captured" && e.status !== "missing";
  // Who may act directly: NPCs, factions and items that are here, plus NPCs the players brought
  // in by naming them (going to see them, calling to them), unless captured or missing.
  const present = new Set(
    scene.entities
      .filter((e) => (e.type === "npc" || e.type === "faction" || e.type === "item") && alive(e) && free(e))
      .filter((e) => e.type !== "npc" || scene.presence(e) !== "elsewhere" || mentioned.has(e.name))
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
  const notes: string[] = [];
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
    check: { scene, tagger, present, remoteOk, outcomePcs, possession } satisfies CheckContext,
    actors: [...present, ...absentNpcs, ...scene.pcs.map((p) => p.name)],
    handOff: scene.pcs.filter((p) => p.status !== "dead" && capabilitiesOf(p).aware).map((p) => p.name),
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

// mode "ranked" sends the top retrieved threads; "all" sends every open thread (baseline for comparison).
export async function improv(campaignId: number, moment: string, mode: "ranked" | "all" = "ranked", model?: string) {
  const allThreads = await loadThreadContexts(campaignId);
  const threads = mode === "all" ? allThreads.map((t) => ({ ...t, score: 0, reasons: [] as string[] })) : await retrieveThreads(campaignId, moment);
  if (threads.length === 0) throw new Error("This campaign has no open threads yet.");

  // The scene (party location, who's here, roster, cards for what's in play) comes from
  // structured data; each PC also lists the story conditions on their threads.
  const base = await buildScene(campaignId, { mentioned: new Set(), threadEntities: [] });
  const mentioned = new Set(findMentions(base.entities, moment).keys());
  const storyConditions = new Map(
    base.pcs.map((p) => [p.name, allThreads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)]),
  );
  const scene = await buildScene(campaignId, { mentioned, threadEntities: threads.flatMap((t) => t.entities), storyConditions });
  const lists = buildLists(scene, moment, mentioned);
  const typeOf = new Map(scene.entities.map((e) => [e.name, e.type]));

  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const OptionsSchema = optionsSchema({ threads: threads.map((t) => `T${t.id}`), actors: lists.actors, handOff: lists.handOff, pcs: lists.pcs, mechanics: lists.mechanics });
  const prompt = `${scene.text}

WHO MAY ACT
- Here now (kind "npc"): ${[...lists.check.present].filter((n) => typeOf.get(n) === "npc").join(", ") || "nobody named; use walk-ons"}
- Not here (only kind "arrival" or "remote"): ${lists.actors.filter((n) => typeOf.get(n) === "npc" && !lists.check.present.has(n)).join(", ") || "nobody"}
${lists.check.remoteOk.size ? `- The players reached out to: ${[...lists.check.remoteOk].join(", ")} (they may answer remotely)\n` : ""}${lists.check.possession.holders.size ? `- Who holds what: ${[...lists.check.possession.holders].map(([item, who]) => `${item} (${[...who].join(", ")})`).join("; ")}. Only a holder can use or carry an item, unless a beat hands it over first ("tosses the {X} to {Y}"). A rule tied to an item reaches whoever holds it.\n` : ""}
OPEN THREADS
${threads.map((t) => threadBlock(t, titleOf, typeOf)).join("\n\n")}

WHAT JUST HAPPENED AT THE TABLE
${moment}`;

  // Ask once; if fewer than two options survive the checks, ask once more.
  const calls: LlmResult<unknown>[] = [];
  const accepted: ScaffoldOption[] = [];
  const rejected: { label: string; reason: string }[] = [];
  for (let attempt = 0; attempt < 2 && accepted.length < 2; attempt++) {
    const res = await callLlm({ feature: "improv", system: SYSTEM, prompt, schema: OptionsSchema, maxTokens: 4000, effort: "low", model, fast: true });
    calls.push(res);
    for (const o of res.data.options as ScaffoldOption[]) {
      const reason = checkOption(o, lists.check);
      if (reason) rejected.push({ label: o.label, reason });
      else accepted.push(o);
    }
  }

  let kept = accepted.slice(0, 3);
  const safety = await safetyCheck(scene.safetyLines, kept.map((o) => renderOption(o, lists.tagger)));
  if (safety.call) calls.push(safety.call);
  for (const i of safety.flagged) if (kept[i]) rejected.push({ label: kept[i].label, reason: "crosses a safety line" });
  kept = kept.filter((_, i) => !safety.flagged.has(i));

  // If the moment itself runs into a safety line, ask again with an explicit instruction to steer
  // away, rather than leaving the GM with nothing.
  let safetyNote: string | null = null;
  if (safety.flagged.size && kept.length < 2) {
    safetyNote = `This moment touches your safety line${scene.safetyLines.length > 1 ? "s" : ""} (${scene.safetyLines.join("; ")}), so these options steer away from it.`;
    const steer = `${prompt}

IMPORTANT: this moment runs into the table's safety line(s): ${scene.safetyLines.join("; ")}. Every option must steer away from it: keep it off-screen, redirect the danger elsewhere (often onto the party or the villain's plans), or resolve it without depicting or threatening it.`;
    const res = await callLlm({ feature: "improv", system: SYSTEM, prompt: steer, schema: OptionsSchema, maxTokens: 4000, effort: "low", model, fast: true });
    calls.push(res);
    const fresh = (res.data.options as ScaffoldOption[]).filter((o) => {
      const reason = checkOption(o, lists.check);
      if (reason) rejected.push({ label: o.label, reason });
      return !reason;
    });
    const recheck = await safetyCheck(scene.safetyLines, fresh.map((o) => renderOption(o, lists.tagger)));
    if (recheck.call) calls.push(recheck.call);
    for (const i of recheck.flagged) rejected.push({ label: fresh[i].label, reason: "crosses a safety line" });
    kept = [...kept, ...fresh.filter((_, i) => !recheck.flagged.has(i))].slice(0, 3);
  }

  const idOf = (ref: string) => Number(ref.replace(/^T/, ""));
  const options: ImprovOption[] = kept.map((o) => ({
    thread_id: idOf(o.thread),
    also_ties_to: [...new Set(o.also_ties_to.map(idOf))].filter((id) => titleOf.has(id) && id !== idOf(o.thread)),
    label: o.label,
    option: renderOption(o, lists.tagger),
    why: lists.tagger.render(lists.tagger.tag(o.why)),
    scaffold: o,
  }));

  const llm = {
    model: calls[0].model,
    latencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    costUsd: calls.reduce((s, c) => s + c.costUsd, 0),
    attempts: calls.filter((c) => c.model !== "safety" && c !== safety.call).length,
  };
  return { options, dropped: rejected.length, rejected, threads, titleOf, llm, moment, campaignId, safetyNote, notes: lists.notes };
}
