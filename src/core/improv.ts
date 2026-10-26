import { eq } from "drizzle-orm";
import { z } from "zod";
import { callLlm, type LlmResult } from "./llm";
import { findMentions, loadThreadContexts, retrieveThreads, selectThreads, type SelectedThread, type ThreadContext } from "./retrieval";
import { PILLARS, type Pillar } from "./db/schema";
import { db, schema } from "./db/client";
import { embeddingProvider, ensureEmbeddings, searchByMeaning, type MeaningSearch } from "./embeddings";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { planSlips } from "./plan-agency";
import { listMoments, momentLine } from "./moments";
import { personalLines, spotlightScore, tableSeats } from "./players";
import { buildScene, type Scene } from "./scene";
import { findMoves, movesBlock, type Move } from "./moves";
import { derivedLines } from "./world/derived";
import { BODY_PARTS, expand, fillSlots, pcOpensClause, SENSATIONS, type Ref } from "./slots";
import type { Overrides, RecordFix } from "./situation";
export type { RecordFix };
import { capabilitiesOf, checkBeat, checkOnFail, checkPossession, makeTagger, notInScene, type CheckContext, type Possession, type ScaffoldBeat, type Tagger } from "./scaffold";

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
  hand_off: { to: string; kind: "question" | "roll"; mechanic: string; text: string }; // the sentence code writes from `hand`
  hand?: Hand; // what the model chose, in parts
  refs?: Ref[]; // who and what the sentences name, with the part each plays ({1}, {2} in the text)
  move?: string; // the engine's move it builds on ("M2"), from moves.ts
  on_fail: { target: string; effect: string };
  why: string;
  callback?: string; // "M12" if it calls back a key moment, else "none"
  pillar?: Pillar; // what kind of play it offers: combat, social, exploration, mystery, comedy, drama
  headline?: string; // the option in one glanceable line, read before anything else
  flavour?: Flavour; // what kind of option it is, shown as a small tag
}

// How the players get involved, chosen in parts. Code writes the sentence, so a hand-off can't
// decide what a PC does or feels ("makes a reckless grab for his arm"), can't answer its own
// question, and can't ask for a roll the rules don't call for:
// - check / contest / attack: only for a PC acting on what their player declared in this moment;
// - notice: a perception or knowledge check, for anyone (or the table);
// - save: anyone reacting to a danger;
// - rule: a house rule's roll; death_save: a dying PC.
export const ABILITIES = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"] as const;
export const SKILLS = ["none", "Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature", "Perception", "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"] as const;
const NOTICE_SKILLS = ["Perception", "Insight", "Investigation", "Arcana", "History", "Nature", "Religion", "Medicine", "Survival"] as const;
const SKILL_ABILITY: Record<string, (typeof ABILITIES)[number]> = {
  Acrobatics: "Dexterity", "Animal Handling": "Wisdom", Arcana: "Intelligence", Athletics: "Strength", Deception: "Charisma", History: "Intelligence", Insight: "Wisdom", Intimidation: "Charisma", Investigation: "Intelligence",
  Medicine: "Wisdom", Nature: "Intelligence", Perception: "Wisdom", Performance: "Charisma", Persuasion: "Charisma", Religion: "Intelligence", "Sleight of Hand": "Dexterity", Stealth: "Dexterity", Survival: "Wisdom",
};
// How each side of a choice is done, so what follows can hold to it: a check after "talk her
// round" is a talking skill, not Athletics.
export const APPROACHES = ["talk", "force", "sneak", "study", "magic", "item", "move", "wait"] as const;
export type Approach = (typeof APPROACHES)[number];
export const APPROACH_SKILLS: Record<Approach, string[]> = {
  talk: ["Persuasion", "Deception", "Intimidation", "Insight", "Performance"],
  force: ["Athletics"],
  sneak: ["Stealth", "Sleight of Hand", "Acrobatics"],
  study: ["Investigation", "Arcana", "History", "Nature", "Religion", "Medicine", "Perception", "Insight", "Survival"],
  magic: ["Arcana", "Religion", "Nature"],
  move: ["Acrobatics", "Athletics", "Survival"],
  item: [],
  wait: ["Perception", "Insight"],
};
export type Hand = {
  kind: "question" | "choice" | "check" | "contest" | "attack" | "notice" | "save" | "rule" | "death_save";
  to: string;
  what?: string; // what they face (question), the first choice, what they're up against, or what a notice roll is about
  or?: string; // the second choice
  approach?: string; // how the first choice is done (APPROACHES), for a choice
  or_approach?: string; // how the second is done
  ability?: string;
  skill?: string;
  mechanic?: string;
};

const an = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
const phrase = (t: string) => t.trim().replace(/[.?!]+$/, "").replace(/^(?:you\s+)/i, "");
// The hand-off sentence, written by code. Names stay tagged; the caller renders them.
export function handText(h: Hand): Pick<ScaffoldOption["hand_off"], "kind" | "mechanic" | "text"> {
  const pc = h.to === "table" ? null : `{${h.to}}`;
  const player = pc ? `${pc}'s player` : "the table";
  const who = pc ?? "Everyone";
  // "against the current", never "against resist the urge": a phrase that doesn't start like a
  // noun (an article, a name or a possessive) is left out.
  const against = (x = "") => (phrase(x) && /^(?:the|a|an|his|her|their|its|this|that|every|any|some|\{|[A-Z])/.test(phrase(x)) ? ` against ${phrase(x)}` : "");
  const skill = h.skill && h.skill !== "none" ? h.skill : null;
  const roll = (text: string, mechanic = "none") => ({ kind: "roll" as const, mechanic, text });
  switch (h.kind) {
    case "question":
      // "what" names what they face; one that's a question itself ("what the table does with…") isn't.
      const facing = phrase(h.what ?? "");
      return { kind: "question", mechanic: "none", text: facing && !/^(?:what|how|whether|if|who|which|where|why)\b/i.test(facing) ? `Ask ${player}: what do you do about ${facing}?` : `Ask ${player}: what do you do?` };
    case "choice":
      return { kind: "question", mechanic: "none", text: `Ask ${player}: do you ${phrase(h.what ?? "")}, or ${phrase(h.or ?? "")}?` };
    case "check":
    case "contest": {
      const ability = (skill && SKILL_ABILITY[skill]) || (h.ability && h.ability !== "none" ? h.ability : "Strength");
      return roll(`${who} makes ${an(ability)}${skill ? ` (${skill})` : ""} ${h.kind}${against(h.what)}.`);
    }
    case "attack":
      return roll(`${who} makes an attack roll${against(h.what)}.`);
    case "notice":
      // What it's for, in Loom's words: perceiving and recalling, never doing.
      const s2 = skill ?? "Perception";
      const verb = s2 === "Perception" ? "to notice" : s2 === "Insight" ? "to read" : s2 === "Investigation" ? "to work out" : s2 === "Medicine" || s2 === "Survival" ? "to make sense of" : "to recall what they know about";
      return roll(`${who} makes ${an(SKILL_ABILITY[s2] || "Wisdom")} (${s2}) check${phrase(h.what ?? "") ? ` ${verb} ${phrase(h.what ?? "")}` : ""}.`);
    case "save":
      return roll(`${who} makes ${an(h.ability && h.ability !== "none" ? h.ability : (skill && SKILL_ABILITY[skill]) || "Dexterity")} saving throw${against(h.what)}.`);
    case "rule":
      return roll(`${who} makes a {${h.mechanic}} roll.`, h.mechanic ?? "none");
    case "death_save":
      return roll(`${who} makes a death saving throw.`);
  }
}

// What kind of option it is, at a glance. The default mix asks for one of each of the first three.
export const FLAVOURS = ["payoff", "twist", "callback", "character", "tense", "funny", "mystery", "fight"] as const;
export type Flavour = (typeof FLAVOURS)[number];

// The kinds of option to offer. "mix" is the default most DMs will never change.
export const MIXES = {
  mix: "Offer a mix: one that pays off or advances a thread (payoff), one that turns things in an unexpected direction (twist), and one that calls back to something earlier or gives a character a moment (callback or character). The fourth is your best other idea.",
  fights: "Lean toward action: at least three of the four options should be fights or physical danger (fight, tense), still tied to threads.",
  mystery: "Lean toward mystery: at least three of the four options should reveal or deepen a mystery (mystery, payoff).",
  light: "Keep it light: at least three of the four options should be funny or warm (flavour funny or character) (funny, character), without undercutting the threads.",
  character: "Lean toward character: at least three of the four options should give a player character a moment of their own (character, callback).",
} as const;
export type Mix = keyof typeof MIXES;
const MIX_FLAVOURS: Record<Mix, Flavour[]> = { mix: [], fights: ["fight", "tense"], mystery: ["mystery", "payoff"], light: ["funny", "character"], character: ["character", "callback"] };

export interface ImprovOption {
  headline: string;
  flavour: Flavour | null;
  thread_id: number;
  also_ties_to: number[];
  label: string;
  option: string; // readable text rendered from the scaffold
  why: string;
  callback: { id: number; title: string } | null;
  scaffold: ScaffoldOption; // kept for the flavour pass
}

// How names go in and what a scaffold is: shared by improv options and Develop's chain steps.
export const SCAFFOLD_TEXT = `REFERENCES: list the characters, places and items an option names in refs, and write each in braces exactly as listed where it goes ("{Iresia}", "{Shard of Azarath's Mirror|the Shard}"), as "object" (something happens to it, it's seen, given or talked about) or "possessor" (it owns what follows: "{2}'s seal is broken"). Player characters are only ever objects or owners of things ("the guard eyes {1}'s pack"); no sentence or clause starts with one.

Each option is a scaffold:
- setup: short beats of what happens next, as many and as long as LENGTH says. What the players declared isn't narrated: the world responds to it, and the hand settles how it turns out. Each beat has a kind:
  - "world": the environment, magic or events. actor "world". does is a full sentence ("a hairline crack of light opens above {1}").
  - "npc": a character who is here acts or speaks. actor is their name. does is what they do, without the name ("turns {1} over and goes pale").
  - "walk_on": an unnamed extra. actor "walk-on", walk_on describes them ("a nervous merchant"), does is what they do.
  - "arrival": a character who isn't here arrives ("bursts through the door, breathless").
  - "remote": a character who isn't here acts from afar ("sends a runner with a sealed note").
  - "happens": what a PC feels, chosen from parts: pc, part (a body part, or "none" for all of them), sense, and cause (a thing or force in at most 5 words: "the river's cold grip", "the figurine's pull"; never a thought or a feeling). Code writes it ("Bram's chest aches: the river's cold grip").
- hand: how the players get involved, chosen in parts; code writes the sentence. to is a PC or "table". Fill only the fields its kind uses, and leave the others "" (or "none"). Pick the kind:
  - "question": ask what they do. what is a short noun phrase for what they're facing ("the heckling patron"), or "".
  - "choice": offer two clear choices: what and or are short verb phrases a player would say ("write a note", "wave him off"), and approach and or_approach say how each is done: talk, force, sneak, study, magic, item, move or wait. For other kinds, approach and or_approach are "wait".
  - "check" or "contest": only for a PC doing what their player declared in this moment. Pick the ability and skill (or "none"); what is who or what they're up against ("the captain", "the current"), or "".
  - "attack": only for a PC who declared an attack. what is the target.
  - "notice": a perception or knowledge check (Perception, Insight, Investigation, Arcana, History…), for anyone or the table. what is a noun phrase for what it's about ("what's bobbing in the current", "the sigil on the crates").
  - "save": a saving throw against a danger that hits them, for anyone. what is the danger ("the falling beam"). Only real dangers: a fall, a blast, poison, a spell, a curse.
  - "rule": a rule from RULES IN PLAY; it can only go to someone it applies to right now (listed after "now"), or to "table" if it applies to everyone.
  - "death_save": a PC who is dying.
  Rolls are for player characters only; what NPCs notice or decide is the GM's call, never a roll.
- on_fail: for rolls only. target is the PC who rolled, effect is what happens if the roll fails, one short sentence that adds something new. For a roll by the table, the effect says who it hits ("whoever fails…"), never "he" or "she". This is the only place a PC may act against their player's will. Otherwise target "none" and effect "".`;

const SYSTEM = `You are Loom, a game master's assistant used live at the table. The players just did something unexpected. Offer 4 short, playable options that tie the moment back to threads already in the campaign, instead of inventing new material.

Rules:
- Every option builds on one of the engine's MOVES (move), a different one for each option. Its main thread is thread; also_ties_to lists the move's other threads it genuinely uses. Only the move's cast may be named as actors: those "here" in npc beats, those who "can arrive or send word" in arrival or remote beats; a "support" character may have one line. Characters "resting" sit this move out. Anyone else is a walk-on.
- Get the facts right: who did what to whom must match the threads and cards exactly.
- Match the energy of the moment: comedic stays comedic, tense stays tense. LENGTH and TONE at the end say how much to write and how dramatic to be.
- Serve where the story is going: when the GM has said where they want it to head, options should move toward that, not away from it. Build on what this session has already established.
- The GM controls the world, NPCs and consequences; the players control their characters (PCs). Never decide what a PC does, says, thinks or feels.
- Use what's already established: characters' abilities, health and gear, relationships, and the GM's mechanics. Threads and fields marked as GM secrets shape what happens but are never stated outright.
- Small table-level details (a sound, a line of dialogue, an unnamed extra) are fine; new plots, factions or major NPCs are not. Never include anything on the safety lines.
- Make the options genuinely different from each other.

${SCAFFOLD_TEXT}
- headline: plain words (names as words here, no braces), written after the option, as its summary in one glanceable line, under 12 words, present tense, the hook first ("The lookout bolts for the alarm bell"). Use only the characters, objects and place the setup and hand actually use, called the same thing (if the setup has a fishmonger, so does the headline). Its subject is the world or an NPC, never a player character or the party; an unnamed extra is "a merchant", "a guard", never "a walk-on". The GM reads only this before choosing. flavour: one of payoff, twist, callback, character, tense, funny, mystery, fight. MIX at the end says which kinds to offer.
- label: 2-5 words. why: the move's "because", in your own words, under 15 words; don't repeat the thread title or use thread numbers.
- callback: if the option echoes or pays off one of the KEY MOMENTS listed, its id ("M12"); otherwise "none". Use one only when it genuinely fits.
- pillar: the kind of play the option mostly offers: combat, social, exploration, mystery, comedy or drama.
- Hand-offs mostly go to whoever the moment is about. HAND ONE OPTION TO, when given, names one PC to give one option to, if it fits. Never mention players.`;

const nonEmpty = (xs: string[], fallback: string): [string, ...string[]] => (xs.length ? (xs as [string, ...string[]]) : [fallback]);

export type SchemaLists = { moves: string[]; threads: string[]; nameable: string[]; npcActors: string[]; absentActors: string[]; outcomeActors: string[]; handOff: string[]; pcs: string[]; mechanics: string[]; moments: string[] };

/** The shapes a scaffold is built from, each with only the values allowed right now. */
export function scaffoldParts(lists: SchemaLists) {
  // One shape per kind of beat, each with only the actors that kind allows. A kind with nobody to
  // offer is left out.
  const beat = <K extends ScaffoldBeat["kind"]>(kind: K, actors: string[]) => z.object({ kind: z.literal(kind), actor: z.enum(nonEmpty(actors, "world")), walk_on: z.string(), does: z.string() });
  const kinds = [
    beat("world", ["world"]),
    beat("walk_on", ["walk-on"]),
    ...(lists.npcActors.length ? [beat("npc", lists.npcActors)] : []),
    beat("arrival", ["walk-on", ...lists.absentActors]),
    beat("remote", ["walk-on", ...lists.absentActors]),
  ];
  // What happens to a PC, from parts: code writes the sentence.
  const happens = z.object({ kind: z.literal("happens"), pc: z.enum(nonEmpty(lists.handOff, "none")), part: z.enum(BODY_PARTS), sense: z.enum(SENSATIONS), cause: z.string() });
  const all = [...kinds, happens];
  const Beat = z.union(all as unknown as [(typeof all)[number], (typeof all)[number], ...(typeof all)[number][]]);
  const thread = z.enum(nonEmpty(lists.threads, "T0"));
  // The hand-off, in one flat shape (a union per kind made the format too large for the API to
  // compile); code checks who each kind may go to (see Hand and checkOption).
  const Hand = z.object({
    kind: z.enum(["question", "choice", "check", "contest", "attack", "notice", "save", ...(lists.mechanics.length ? (["rule"] as const) : []), "death_save"]),
    to: z.enum(nonEmpty(["table", ...lists.handOff], "table")),
    what: z.string(),
    or: z.string(),
    approach: z.enum(APPROACHES),
    or_approach: z.enum(APPROACHES),
    ability: z.enum(["none", ...ABILITIES]),
    skill: z.enum(SKILLS),
    mechanic: z.enum(nonEmpty(["none", ...lists.mechanics], "none")),
  });
  const refs = z.array(z.object({ name: z.enum(nonEmpty(lists.nameable, "none")), as: z.enum(["object", "possessor"]) }));
  return { Beat, Hand, thread, refs, move: z.enum(nonEmpty(lists.moves, "M1")) };
}

function optionsSchema(lists: SchemaLists) {
  const { Beat, Hand, thread, refs, move } = scaffoldParts(lists);
  return z.object({
    options: z.array(
      z.object({
        move,
        thread,
        also_ties_to: z.array(thread),
        label: z.string(),
        // Who and what the sentences name, numbered {1}, {2}…, each with the part it plays.
        refs,
        // What physically happens because of what the players declared, before anything else.
        setup: z.array(Beat),
        hand: Hand,
        // Free text, normalised in code (normaliseHandOff): one odd target ("everyone") used to make the
        // whole answer unparseable.
        on_fail: z.object({ target: z.string(), effect: z.string() }),
        // Written after the option, so it sums up what was written instead of a plan the option
        // then drifts from (a "street mime" headline over a scribe).
        headline: z.string(),
        flavour: z.enum(FLAVOURS),
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
  const tagged = tagger.tag(b.does.replace(/\b(an?\s+)?walk-on\s+/gi, "$1")).trim();
  // "Uses the tables as cover" after a name reads "Vex'ahlia uses…"; names (tagged) keep their capital.
  const does = tagger.render(b.kind === "world" || b.actor === "world" || tagged.startsWith("{") ? tagged : tagged.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())).trim();
  const extra = b.kind === "walk_on" || b.actor === "walk-on" || (b.actor === "world" && b.kind !== "world" && b.walk_on.trim());
  // "world" as the actor of another kind of beat is still the world talking, not a character called
  // World. A world sentence that starts with a verb ("asks loudly whether…") lost its subject:
  // someone did it.
  if (!extra && (b.kind === "world" || b.actor === "world")) return sentence(capitalise(/^[a-z]+s\b/.test(does) && !/^(?:this|its|has|is|was)\b/.test(does) ? `someone ${does}` : does));
  const subject = extra ? capitalise(tagger.render(b.walk_on).replace(/\bwalk-on\b\s*/gi, "").trim() || "someone") : b.actor;
  const startsWithSubject = does.toLowerCase().startsWith(subject.toLowerCase()) || does.toLowerCase().startsWith(subject.split(/[\s,]+/)[0].toLowerCase());
  // "a voice rasps through the murmur…" after a named actor: their part, set off with a dash.
  if (!startsWithSubject && !extra && /^(?:a|an|the|some)\b/i.test(does)) return sentence(`${subject}: ${does}`);
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

// The model's hand-off parts become the sentence the rest of Loom reads (checks, rendering, the page).
export function adoptHand(o: ScaffoldOption): ScaffoldOption {
  if (!o.hand) return o;
  // What the engine knows fills a gap rather than failing the option: a notice roll without a
  // skill is Perception; a check whose skill isn't a notice skill but was asked as "notice" keeps
  // its skill as a check of that kind.
  const hand = { ...o.hand };
  if (hand.kind === "notice" && (!hand.skill || hand.skill === "none")) hand.skill = "Perception";
  // References in the hand-off's phrases ("reach for {1}'s falling body", or "1's" without braces)
  // become the names they stand for, tagged like everywhere else.
  const refs = o.refs ?? [];
  const named = (t?: string) => t?.replace(/\{(\d+)\}|\b(\d+)(?=['’]s\b)/g, (w, a?: string, b?: string) => (refs[Number(a ?? b) - 1] ? `{${refs[Number(a ?? b) - 1].name}}` : w));
  if (refs.length) Object.assign(hand, { what: named(hand.what), or: named(hand.or) });
  return { ...o, hand, hand_off: { to: hand.to, ...handText(hand) } };
}

// A hand-off to "the table" whose text names exactly one PC is really to that PC.
export function normaliseHandOff(o: ScaffoldOption, c: CheckContext) {
  // A beat whose actor is "world" or "walk-on" is the world or an extra, whatever kind it says;
  // an extra without a description is "someone".
  for (const b of o.setup) {
    if (b.kind === "outcome") continue;
    if (b.actor === "walk-on" || (b.kind !== "world" && b.actor === "world" && b.walk_on.trim())) b.kind = "walk_on";
    else if (b.actor === "world") b.kind = "world";
    // An extra with no description whose sentence starts with a thing ("a folded note is passed…")
    // is the world happening; otherwise the extra is "someone".
    if (b.kind === "walk_on" && !b.walk_on.trim() && /^(?:a|an|the|some)\b/i.test(b.does.trim())) b.kind = "world";
    else if (b.kind === "walk_on" && !b.walk_on.trim()) b.walk_on = "someone";
  }
  // Rolls the engine can put right from what it knows, rather than throwing the option away.
  if (o.hand) {
    const h = o.hand;
    const declared = c.checkTo.includes(h.to);
    if ((h.kind === "check" || h.kind === "contest" || h.kind === "attack") && !declared) {
      // A PC who didn't declare this doesn't attempt it: noticing is a notice roll, anything else
      // that comes at them is a save.
      const notice = h.skill && NOTICE_SKILLS.includes(h.skill as (typeof NOTICE_SKILLS)[number]);
      o.hand = notice ? { ...h, kind: "notice" } : { ...h, kind: "save", ability: h.skill && h.skill !== "none" ? (SKILL_ABILITY[h.skill] ?? h.ability) : h.ability, skill: "none" };
    }
    // A choice is something the player would do: a phrase that starts with someone's name ("Tomas
    // proposes a tavern…") isn't one, so it becomes a question.
    if (o.hand.kind === "choice" && [o.hand.what, o.hand.or].some((x) => /^\s*\{?[A-Z][\w'’-]+/.test(x ?? "") && c.tagger.entityOf((x ?? "").replace(/^\s*\{?/, "").split(/[|}\s]/)[0]))) o.hand = { ...o.hand, kind: "question", what: "" };
    // A rule roll with no rule named is a question about what they face.
    if (o.hand.kind === "rule" && (!o.hand.mechanic || o.hand.mechanic === "none")) o.hand = { ...o.hand, kind: "question" };
    if (o.hand.kind === "death_save" && o.hand.to !== "table") {
      const e = c.tagger.entityOf(o.hand.to);
      if (e && capabilitiesOf(e).aware) o.hand = { ...o.hand, kind: "question", what: "" };
    }
    if (o.hand !== h) o.hand_off = { to: o.hand.to, ...handText(o.hand) };
  }
  // A failure line with no roll to fail is dropped, not the option.
  if (o.hand_off.kind !== "roll" && o.on_fail.target !== "none") o.on_fail = { target: "none", effect: "" };
  // A failure for the whole table says who it hits, not "he" or "she".
  if (o.hand_off.to === "table" && o.on_fail.effect) {
    o.on_fail.effect = o.on_fail.effect.replace(/\b(he|she)\b/gi, (w) => (w[0] === "H" || w[0] === "S" ? "They" : "they")).replace(/\b(him|her)\b/gi, "them").replace(/\b(his|hers)\b/gi, "their");
  }

  if (o.hand_off.to === "table" && !o.hand) {
    const named = [...new Set(c.tagger.tagsIn(c.tagger.tag(o.hand_off.text)).filter((n) => c.tagger.entityOf(n)?.type === "pc"))];
    if (named.length === 1) o.hand_off.to = named[0];
  }
  // The failure lands on whoever rolled; for a table roll, on whoever fails.
  const pcs = new Set(c.scene.pcs.map((p) => p.name));
  if (o.on_fail.target !== "none" && !pcs.has(o.on_fail.target)) o.on_fail.target = o.hand_off.to;
  if (!o.on_fail.effect.trim()) o.on_fail.target = "none";
}

// The hand-off gives the choice to the player, so it can't make it for them: a roll names the
// roll, not what the PC does for it ("makes a reckless grab for his arm"); neither narrates how
// they feel or react ("; he feels no pain and keeps pushing", "…as he surfaces, grinning"); and
// a question never asks the players to decide what an NPC does ("whether the guard asks…").
const ROLL_NOUN = /\b(?:roll|check|save|saving throw|contest|test)s?\b|\brolls\b/i;
const NPC_DOES = "asks|says|tells|lets|agrees|accepts|attacks|follows|believes|wants|decides|gives|takes|leaves|helps|answers|reacts|responds|notices|chooses|refuses";
export function checkHandOff(o: ScaffoldOption, c: CheckContext): string | null {
  const tagged = c.tagger.tag(o.hand_off.text);
  const text = c.tagger.render(tagged);
  const pcNames = c.scene.pcs.flatMap((p) => [p.name, p.name.split(/\s+/)[0], ...(p.aliases ?? [])]).filter((n) => n.length >= 3);
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const who = `(?:${[...pcNames.map(esc), "he", "she", "they"].join("|")})`;
  if (o.hand_off.kind === "roll") {
    const tries = new RegExp(`\\b${who}\\s+(?:makes|attempts|tries)\\s+(?:a|an|to)\\s+((?:\\S+\\s+){0,4}\\S+)`, "i").exec(text);
    if (tries && !ROLL_NOUN.test(tries[1])) return "the roll decides what the character does";
    const noun = ROLL_NOUN.exec(text);
    const after = noun ? text.slice(noun.index + noun[0].length) : text;
    if (new RegExp(`[;,]\\s*(?:and\\s+|then\\s+)?${who}\\s+(?!can|could|may|might|must|needs?|has|have|is|are)[a-z]+`, "i").test(after)) return "the roll narrates how the character reacts";
  } else {
    const ask = text.replace(/^.*?\b(?:what|whether|if|how)\b/i, "");
    if (/,\s*(?:still\s+)?(?!using|including|according)[a-z]+ing\b/i.test(ask)) return "the question answers itself (how the character reacts)";
  }
  if (new RegExp(`\\b(?:whether|if)\\s+(?:the|a|an)\\s+[a-z-]+\\s+(?:${NPC_DOES})\\b`, "i").test(text)) return "asks the players to decide what an NPC does";
  for (const [, n, read] of tagged.matchAll(/\{([^}|]+)(?:\|([^}]+))?\}/g)) {
    const e = c.tagger.entityOf(n.trim());
    if (e?.type !== "npc") continue;
    const shown = (read ?? n).trim();
    if (new RegExp(`\\b(?:whether|if)\\s+${esc(shown)}\\s+(?:${NPC_DOES})\\b`, "i").test(text)) return `asks the players to decide what ${e.name} does`;
  }
  return null;
}

export function checkOption(o: ScaffoldOption, c: CheckContext): string | null {
  if (!o.setup.length) return "has no setup";
  // "The Red Hand nothing.": a beat whose text is one lowercase word after its actor says nothing.
  if (o.setup.some((b) => !b.does.trim() || (b.kind !== "world" && /^[a-z]+[.!]?$/.test(b.does.trim())))) return "a beat has no real content";
  if ([o.headline ?? "", o.hand_off.text, o.why, o.on_fail.effect, ...o.setup.map((b) => b.does)].some((t) => TABLE_TALK.test(t))) return "mentions the table notes";
  // The real people at the table are never named, only their characters.
  const texts = [o.label, o.headline ?? "", o.hand_off.text, o.why, o.on_fail.effect, ...o.setup.map((b) => b.does), ...o.setup.map((b) => b.walk_on)];
  const real = c.scene.realNames.find((n) => texts.some((t) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)));
  if (real) return `names a real player (${real})`;
  for (const b of o.setup) {
    const r = checkBeat(b, c);
    if (r) return r;
  }
  // Items are used or held only by whoever has them; hand-overs in the beats count from then on.
  const poss = checkPossession(o.setup, c);
  if (poss.problem) return poss.problem;
  const hand = checkHandOff(o, c);
  if (hand) return hand;
  // The few words the model still writes in a hand-off (what they face, the two choices, what
  // they're up against) can't have a PC doing something either.
  if (o.hand) {
    const h = o.hand as Record<string, string>;
    const used: Record<string, string[]> = { question: ["what"], choice: ["what", "or"], check: ["what"], contest: ["what"], attack: ["what"], save: ["what"], notice: ["what"] };
    for (const field of used[o.hand.kind] ?? []) {
      if (!h[field]) continue;
      // Read like any sentence: a PC may be named ("signal Bram", "Bram with gestures"), but not
      // open a phrase as its subject ("Bram grabbing the captain's arm").
      const r = expand(h[field], o.refs ?? [], c.tagger);
      if (r.problem) return `the hand-off: ${r.problem}`;
    }
    const k = o.hand.kind;
    if ((k === "check" || k === "contest" || k === "attack") && !c.checkTo.includes(o.hand.to))
      return `${k === "attack" ? "an attack" : `a ${k}`} for ${o.hand.to === "table" ? "the whole table" : o.hand.to}, who didn't declare that action`;
    if (k === "notice" && !NOTICE_SKILLS.includes(o.hand.skill as (typeof NOTICE_SKILLS)[number])) return `a notice roll with ${o.hand.skill ?? "no skill"}`;
    if (k === "rule" && (!o.hand.mechanic || o.hand.mechanic === "none")) return "a rule roll without a rule";
    if (k === "death_save" && o.hand.to === "table") return "a death save for the whole table";
    if (o.hand.kind === "death_save" && o.hand.to !== "table") {
      const e = c.tagger.entityOf(o.hand.to);
      if (e && capabilitiesOf(e).aware) return `asks ${e.name} for a death save, but ${e.name} isn't dying`;
    }
  }
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
    const live = c.scene.situation.effects.find((e) => e.effect.id === eff.effect.id);
    if (live && !live.live) return `"${eff.effect.name}" isn't triggered in this moment (${live.why})`;
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
// The lists that shape the answer format, and the context the checks use, all read from the
// scene model (situation.ts): who's here, who the players reached, who's acting, who has what.
// `reach`: entity ids close enough to the moment to be offered as actors (see graph.ts). Without
// it, every entity is offered.
export function buildLists(scene: Scene, moment: string, mentioned: Set<string>, reach?: Map<number, number>) {
  // The moment is read once, into the situation; a different one here would be a caller's mistake.
  if (moment !== scene.situation.moment) throw new Error("buildLists: the scene was built for a different moment (pass `moment` to buildScene)");
  const s = scene.situation;
  const tagger = makeTagger(scene);
  const present = s.here;
  const remoteOk = s.contacted;
  const outcomePcs = s.acting;
  const absentNpcs = scene.entities.filter((e) => e.type === "npc" && e.status !== "dead" && !present.has(e.name)).map((e) => e.name);
  const possession: Possession = { holders: s.holders, parentOf: s.parentOf, lost: s.lost };
  // A check, contest or attack is for a PC acting on what their player declared; the whole table
  // when the moment is about the whole party.
  const checkTo = [...outcomePcs].filter((n) => scene.pcs.some((p) => p.name === n && p.status !== "dead")).concat(s.reading.wholeParty ? ["table"] : []);
  const inReach = (n: string) => {
    const e = scene.entities.find((x) => x.name === n);
    return !reach || mentioned.has(n) || (e != null && reach.has(e.id));
  };
  return {
    tagger,
    notes: [...s.notes],
    fixes: [...s.fixes],
    stated: s.stated,
    check: { scene, tagger, present, remoteOk, outcomePcs, checkTo, possession } satisfies CheckContext,
    // Who each kind of beat may name, within reach of the moment (and anyone it names). The answer
    // format offers each kind only its own list, so an absent NPC can't be written acting here and a
    // PC can't be written as an NPC: the model can't choose them, rather than code catching it.
    npcActors: [...present].filter(inReach),
    absentActors: absentNpcs.filter(inReach),
    outcomeActors: [...outcomePcs],
    checkTo,
    actors: [...present, ...absentNpcs].filter(inReach).concat(scene.pcs.map((p) => p.name)),
    // Everything a sentence may name through a slot: who and what is within reach of the moment
    // (here, reachable or remembered), plus the PCs.
    nameable: [...new Set([...scene.entities.filter((e) => e.type !== "pc" && inReach(e.name)).map((e) => e.name), ...scene.pcs.map((p) => p.name)])],
    // Every living PC stays on the list: a name the model insists on (an unconscious PC) then fails
    // one option's check instead of making the whole answer unparseable.
    handOff: scene.pcs.filter((p) => p.status !== "dead").map((p) => p.name),
    pcs: scene.pcs.map((p) => p.name),
    // Only rules whose trigger has happened and that reach someone can be offered for a roll.
    mechanics: s.effects.filter((e) => e.live).map((e) => e.effect.name),
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
export const TONE_TEXT = [
  "TONE: grounded. Plain, plausible and understated: no flourishes, no sudden magic or reveals unless a thread already calls for it. Consequences follow from what's established.",
  "TONE: restrained. Mostly plain and plausible, with one vivid detail where it earns its place. Avoid melodrama.",
  "TONE: balanced. Match the campaign's tone; vivid where it matters, never overwrought.",
  "TONE: dramatic. Lean into striking images and rising stakes, while staying true to the threads.",
  "TONE: theatrical. Big, dramatic and cinematic: bold reveals and high stakes, but every beat still ties to a thread.",
];

export interface ImprovOptions {
  tone?: number; // 0 grounded … 4 theatrical (default 1: Jacob found the default a bit theatrical)
  mix?: Mix; // which kinds of option to offer; default a mix
  steer?: string; // a one-tap nudge from the GM: "darker", "bring in Zara"
  overrides?: Overrides; // the GM's corrections to who's here and what's in hand (the chips)
  focused?: boolean; // a tighter scene and fewer threads (cheapest); the default is wide
  threads?: number; // send exactly this many threads (plus any tied to what the moment names)
  embeddings?: string; // "local" | "voyage" | "off"; default from LOOM_EMBEDDINGS (local)
  // Called with each option the moment it's written and has passed the checks (up to 3), so a
  // page can show the first one in ~2 s instead of waiting for all of them. With safety lines set,
  // options are held until the safety check has seen them.
  onOption?: (o: ImprovOption) => void;
}

// The complete objects so far in the "options" array of a JSON answer that's still being written.
export function completedOptions(text: string, key = "options", from = 0): string[] {
  const k = text.indexOf(`"${key}"`, from);
  const at = k < 0 ? -1 : text.indexOf("[", k);
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

export interface PrepareOptions {
  mode?: "ranked" | "all";
  overrides?: Overrides;
  focused?: boolean;
  threads?: number;
  embeddings?: string;
}

/**
 * Everything the engine works out for a moment before the model is asked anything: the threads in
 * play, the scene, who may act and how, the table, callbacks, notes close in meaning, the GM's
 * direction and the session so far. Shared by improv and Develop's chains.
 */
export async function prepareMoment(campaignId: number, moment: string, opts: PrepareOptions = {}) {
  const mode = opts.mode ?? "ranked";
  const budget = opts.focused ? BUDGETS.improvFocused : BUDGETS.improv;
  const allThreads = await loadThreadContexts(campaignId);

  // What the moment names decides which threads are guaranteed a place.
  const base = await buildScene(campaignId, { mentioned: new Set(), threadEntities: [], moment, overrides: opts.overrides });
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
  const scene = await buildScene(campaignId, { mentioned, threadEntities: threads.flatMap((t) => t.entities), storyConditions, distances, budget, situation: base.situation });
  const lists = buildLists(scene, moment, mentioned, mode === "all" ? undefined : distances);
  const typeOf = new Map(scene.entities.map((e) => [e.name, e.type]));

  // The player layer: who has been quiet and what their players enjoy (ranking only).
  const seats = await tableSeats(campaignId);
  const quietest = seats
    .filter((x) => x.quietFor >= 2 && x.pc.status !== "dead" && capabilitiesOf(x.pc).act)
    .sort((a, b) => b.quietFor - a.quietFor)[0];
  // The table notes rank options in code; the model only hears which PC to give one option to.
  const tableBlock = quietest ? `HAND ONE OPTION TO: ${quietest.pc.name}, if the moment allows; the others go to whoever the moment is about.` : "";
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
  return { budget, allThreads, base, mentioned, provider, meaning, meaningNote, threads, distances, scene, lists, typeOf, seats, quietest, tableBlock, lines, callbacks, sessionNumber, sceneBlock, titleOf, direction, soFar };
}
export type Prepared = Awaited<ReturnType<typeof prepareMoment>>;

export const liveRulesOf = (scene: Scene) => scene.situation.effects.filter((e) => e.live).map((e) => ({ name: e.effect.name, why: e.why, sourceName: e.sourceName }));

/** The prompt's context: the scene, who may act, the threads, the engine's moves and the rest. */
export function contextPrompt(p: Prepared, moves: Move[], unit = "option") {
  return `${p.scene.text}

WHO MAY ACT
- Here now (kind "npc"): ${[...p.lists.check.present].filter((n) => p.typeOf.get(n) === "npc").join(", ") || "nobody named; use walk-ons"}
- Not here (only kind "arrival" or "remote"): ${p.lists.actors.filter((n) => p.typeOf.get(n) === "npc" && !p.lists.check.present.has(n)).join(", ") || "nobody"}. Bring one in only when it pays off their thread, at most one per option; otherwise use walk-ons.
- Acting in this moment (what they declared is settled by the hand and the world's response, never narrated): ${p.lists.outcomeActors.join(", ") || "no PC in particular"}
- Checks, contests and attacks only for: ${p.lists.check.checkTo.map((n) => (n === "table" ? "the table" : n)).join(", ") || "nobody (use a question, a choice, a notice roll or a save)"}
${p.lists.stated.length ? `- As of this moment: ${p.lists.stated.join("; ")}\n` : ""}${p.lists.check.remoteOk.size ? `- The players reached out to: ${[...p.lists.check.remoteOk].join(", ")} (they may answer remotely)\n` : ""}${p.lists.check.possession.holders.size ? `- Who holds what: ${[...p.lists.check.possession.holders].map(([item, who]) => `${item} (${[...who].join(", ")})`).join("; ")}. Only a holder can use or carry an item, unless a beat hands it over first ("tosses the {X} to {Y}"). A rule tied to an item reaches whoever holds it.\n` : ""}
OPEN THREADS
${p.threads.map((t) => (t.detail === "full" ? threadBlock(t, p.titleOf, p.typeOf) : `T${t.id} [${t.kind}] ${t.title}: ${t.summary}`)).join("\n")}

MOVES (the engine's picks for this moment: build each ${unit} on a different one)
${movesBlock(moves, p.titleOf)}
${(() => {
    const lately = derivedLines(p.scene.situation.view);
    return lately.length ? `\nLATELY (worked out from this session, not recorded)\n${lately.map((l) => `- ${l}`).join("\n")}\n` : "";
  })()}${p.sceneBlock}${p.callbacks.length ? `\nKEY MOMENTS YOU COULD CALL BACK\n${p.callbacks.map(momentLine).join("\n")}\n` : ""}${p.tableBlock ? `\n${p.tableBlock}\n` : ""}
${p.direction ? `\nWHERE THE GM WANTS THE STORY TO GO\n${p.direction}\n` : ""}${p.soFar ? `\nTHIS SESSION SO FAR (what already happened at the table, oldest first)\n${p.soFar}\n` : ""}`;
}

/**
 * Fits an option to the engine's move it names: the move sets its thread, and a named character
 * outside the move's cast is dropped with their sentence (anyone else is a walk-on), as is any
 * sentence breaking a world-model check. Only an option left with nothing loses its setup.
 */
export function fitToMove(o: ScaffoldOption, moves: Move[], c: CheckContext, droppedSentences: { label: string; reason: string }[]) {
  const move = moves.find((m) => m.id === o.move);
  if (move && !move.threads.includes(Number(o.thread.replace(/^T/, "")))) o.thread = `T${move.threads[0]}`;
  let supportLines = 0;
  const outsideCast = (b: ScaffoldBeat) => {
    if (!move || (b.kind !== "npc" && b.kind !== "arrival" && b.kind !== "remote") || b.actor === "walk-on" || b.actor === "world") return null;
    const member = move.cast.find((x) => x.name === b.actor);
    if (!member) return move.resting.includes(b.actor) ? `${b.actor} is resting in this move (very active lately)` : `${b.actor} isn't in this move's cast`;
    if (b.kind === "npc" && member.can !== "act") return `${b.actor} isn't here; in this move they can only arrive or send word`;
    if (member.part === "support" && ++supportLines > 1) return `${b.actor} is support in this move: one line at most`;
    return null;
  };
  const kept = o.setup.filter((b) => {
    const r = outsideCast(b) ?? checkBeat(b, c);
    if (r) droppedSentences.push({ label: o.label, reason: `sentence dropped: ${r}` });
    return !r;
  });
  if (kept.length) o.setup = kept;
}

// mode "ranked" selects threads adaptively; "all" sends every open thread (baseline for comparison).
export async function improv(campaignId: number, moment: string, mode: "ranked" | "all" = "ranked", model?: string, opts: ImprovOptions = {}) {
  const P = await prepareMoment(campaignId, moment, { ...opts, mode });
  const { threads, scene, lists, seats, lines, callbacks, titleOf, mentioned, meaning, meaningNote, provider, base, sessionNumber } = P;
  // The engine's moves for this moment: what could happen, on which threads, with whom (moves.ts).
  const moves = findMoves(scene.situation.view, threads, { callbacks, liveRules: liveRulesOf(scene) });
  const OptionsSchema = optionsSchema({ moves: moves.map((m) => m.id), threads: threads.map((t) => `T${t.id}`), nameable: lists.nameable, npcActors: lists.npcActors, absentActors: lists.absentActors, outcomeActors: lists.outcomeActors, handOff: lists.handOff, pcs: lists.pcs, mechanics: lists.mechanics, moments: callbacks.map((m) => `M${m.id}`) });
  const prompt = `${contextPrompt(P, moves)}
${lengthFor(moment)}
MIX: ${MIXES[opts.mix ?? "mix"]}${
    opts.steer
      ? /^bring in /i.test(opts.steer)
        ? `\nSTEER (the GM asked for this; follow it): every option brings in ${opts.steer.replace(/^bring in /i, "")}, as kind "arrival" or "remote" if they aren't here, tied to their threads.`
        : `\nSTEER (the GM asked for this; follow it): make every option ${opts.steer}, still tied to threads.`
      : ""
  }
${TONE_TEXT[Math.max(0, Math.min(4, opts.tone ?? 1))]}

WHAT JUST HAPPENED AT THE TABLE
${moment}`;

  const idOf = (ref: string) => Number(ref.replace(/^T/, ""));
  const toOption = (o: ScaffoldOption): ImprovOption => ({
    // A headline that decides for the players falls back to the option's first beat (which the
    // scaffold already guarantees is the world or an NPC), shortened.
    headline: (() => {
      // A headline is about the world or an NPC: one that opens with a PC ("Kira must signal Bram…")
      // is about what the player does, so it falls back.
      const pcLed = (t: string) => scene.pcs.some((p) => new RegExp(`^${p.name.split(/\s+/)[0]}\\b(?!['’]s)`, "i").test(t));
      const fine = (t: string) => !!t && t.split(/\s+/).length <= 13 && !planSlips(t, scene.pcs).length && !/\bwalk-on\b/i.test(t) && !pcLed(t) && !notInScene(lists.tagger.tag(t), lists.check) && !pcOpensClause(lists.tagger.tag(t), lists.tagger);
      const h = lists.tagger.render(lists.tagger.tag(o.headline ?? ""));
      if (fine(h)) return h;
      // Otherwise the first beat, or its first clause, or the label: whole words, never cut off.
      const first = o.setup[0] ? renderBeat(o.setup[0], lists.tagger).replace(/[.!?]$/, "") : "";
      const clause = first.split(/[,;:—]\s*/)[0];
      const label = lists.tagger.render(lists.tagger.tag(o.label));
      return [first, clause.split(/\s+/).length >= 4 ? clause : "", label].find(fine) ?? label;
    })(),
    flavour: o.flavour ?? null,
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
  const droppedSentences: { label: string; reason: string }[] = []; // logged, but the option survived
  const OptionSchema = OptionsSchema.shape.options.element;
  const wanted = MIX_FLAVOURS[opts.mix ?? "mix"];
  const showEarly = opts.onOption && !lines.length;
  for (let attempt = 0; attempt < 2 && accepted.length < 2; attempt++) {
    let seen = 0;
    const take = (raw: unknown) => {
      const parsed = OptionSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({ label: (raw as { label?: string })?.label ?? "an option", reason: "unusable answer (a value outside the allowed lists)" });
        return;
      }
      const filled = fillSlots(adoptHand(parsed.data as unknown as ScaffoldOption), lists.tagger);
      for (const d of filled.dropped) droppedSentences.push({ label: (parsed.data as { label: string }).label, reason: `sentence dropped: ${d}` });
      if (filled.problem) return rejected.push({ label: (parsed.data as { label: string }).label, reason: filled.problem });
      const o = filled.option;
      normaliseHandOff(o, lists.check);
      fitToMove(o, moves, lists.check, droppedSentences);
      const reason = checkOption(o, lists.check);
      if (reason) return rejected.push({ label: o.label, reason });
      accepted.push(o);
      const fits = !wanted.length || (!!o.flavour && wanted.includes(o.flavour));
      if (showEarly && shown.length < 3 && fits) {
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
      if (err instanceof Error && /credit has run out/.test(err.message)) throw err; // retrying won't help
      rejected.push({ label: `attempt ${attempt + 1}`, reason: `unusable answer (${err instanceof Error ? err.message.slice(0, 60) : "error"}…)` });
      continue;
    }
    calls.push(res);
    for (const o of res.data.options.slice(seen)) take(o);
  }

  // Ranking: whoever the moment is about comes first; the quiet-player nudge is smaller than that.
  // Options already on screen keep their place.
  // A leaned mix (action, light…) keeps the options of that kind first.
  const score = (o: ScaffoldOption) =>
    spotlightScore(seats, o.hand_off.to, o.pillar ?? "drama") + (mentioned.has(o.hand_off.to) ? 0.7 : 0) + (wanted.length && o.flavour && wanted.includes(o.flavour) ? 2 : 0);
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
    const fresh = (res.data.options as unknown as ScaffoldOption[]).map(adoptHand).map((o) => fillSlots(o, lists.tagger)).filter((f) => {
      if (f.problem) rejected.push({ label: f.option.label, reason: f.problem });
      return !f.problem;
    }).map((f) => f.option).filter((o) => {
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
  if (rejected.length || droppedSentences.length) {
    await db
      .insert(schema.optionRejections)
      .values([...rejected, ...droppedSentences].map((r) => ({ campaignId, model: llm.model, moment, label: r.label, reason: r.reason, kept: options.length })))
      .catch(() => {}); // the log must never cost the GM their options
  }
  // One-tap steering: a few nudges, plus up to two characters from the threads in play who could
  // be brought in (alive, not already in the moment or the options).
  const optionText = options.map((o) => o.option).join(" ");
  const bring = [...new Set(threads.slice(0, 6).flatMap((t) => t.entities))]
    .map((n) => base.entities.find((e) => e.name === n))
    .filter((e): e is NonNullable<typeof e> => !!e && e.type === "npc" && e.status !== "dead" && !mentioned.has(e.name) && !optionText.includes(e.name.split(/[\s,]+/)[0]))
    .slice(0, 2)
    .map((e) => `bring in ${e.name.split(",")[0]}`);
  const steers = ["darker", "funnier", "smaller stakes", ...bring];
  return { options, steers, dropped: rejected.length, rejected, threads, titleOf, llm, moment, campaignId, safetyNote, notes: lists.notes, fixes: lists.fixes, quiet: new Map(seats.map((x) => [x.pc.name, x.quietFor])), meaning: meaningSummary(meaning, base.entities, sessionNumber, provider?.model ?? null, meaningNote) };
}
