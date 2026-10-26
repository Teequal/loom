import { couldBe, pronounsOf } from "./pronouns";
import type { ScaffoldBeat, Tagger } from "./scaffold";

// Typed slots (docs/design-2026-10-25-world-model.md §7). The model never writes a sentence with a
// player character as its subject, so there is nothing about PCs to read back out of its words:
// - names go in through references ({1}, {2}), and a PC reference is only ever an object
//   ("a vision tears through {1}", "the guard eyes {1}'s pack");
// - what happens TO a PC is a "happens" beat chosen from parts (who, a body part, a sensation,
//   a cause in words), and code writes the sentence;
// - what the players declared isn't narrated at all: the roll and the world's response settle it.
// The one check left is where a PC stands in a sentence, read structurally.

export interface Ref {
  name: string;
  as: "object" | "possessor";
}

// What a "happens" beat can be: a body part (or "none" for the whole of them) and a sensation.
export const BODY_PARTS = ["none", "hands", "fingers", "palm", "arm", "legs", "chest", "heart", "head", "eyes", "ears", "skin", "throat", "stomach", "back", "wound", "scar", "tail", "horns", "scales"] as const;
export const SENSATIONS = ["goes cold", "grows warm", "burns", "tingles", "aches", "throbs", "stings", "goes numb", "prickles", "feels heavy", "pounds", "itches", "trembles", "rings"] as const;
const BODY = new RegExp(`^(?:${BODY_PARTS.filter((p) => p !== "none").join("|")}|hand|finger|palms|arms|leg|eyes?|knees?|feet|foot|body|mouth|jaw|lips|teeth|shoulders?|breath|voice|mind|thoughts|vision|blood|pulse|grip)$`, "i");

const PLURAL: Record<(typeof SENSATIONS)[number], string> = {
  "goes cold": "go cold", "grows warm": "grow warm", burns: "burn", tingles: "tingle", aches: "ache", throbs: "throb", stings: "sting",
  "goes numb": "go numb", prickles: "prickle", "feels heavy": "feel heavy", pounds: "pound", itches: "itch", trembles: "tremble", rings: "ring",
};

export interface Happens {
  kind: "happens";
  pc: string;
  part: (typeof BODY_PARTS)[number];
  sense: (typeof SENSATIONS)[number];
  cause: string; // a noun phrase ("the river's cold grip"); may hold references
}

// A clause starts at the beginning, after sentence punctuation, or after a comma or joining word.
const CLAUSE_START = /(?:^|[.;:!?—,]|\b(?:and|then|but|so|yet|while|as|until|when|before|after|because|though|whereupon))\s*$/i;

/**
 * Where a player character stands in a sentence, read structurally: opening a clause as its
 * subject ("{Bram} lunges", "…, and {Bram}…") is the PC doing something; so is their body opening
 * one ("{Bram}'s hand…"). Anywhere else they're an object. No verbs are read.
 */
export function pcOpensClause(tagged: string, tagger: Tagger, except?: string): string | null {
  for (const m of tagged.matchAll(/\{([^{}|]+)(?:\|[^{}]*)?\}(['’]s\b)?\s*([\w'’-]*)/g)) {
    const e = tagger.entityOf(m[1]);
    if (e?.type !== "pc" || e.name === except) continue;
    const before = tagger.render(tagged.slice(0, m.index)).trimEnd();
    if (!CLAUSE_START.test(before)) continue;
    if (m[2] && !BODY.test(m[3] ?? "")) continue; // "{Bram}'s pack splits open": something of theirs, not them
    if (!m[2] && /^(?:is|was|are|were|remains|remained)$/i.test(m[3] ?? "")) continue; // "{Darius} is still caged": what state they're in
    return `${e.name} opens a clause, as if doing something ("…${tagger.render(tagged.slice(m.index ?? 0, (m.index ?? 0) + 40))}…")`;
  }
  // A reference without a name stands for the last character named before it in the sentence,
  // and is read as if that name were written. If it's a PC, these are the PC doing something:
  // - "he/she/they" opening a clause ("…in {Khayiulad}'s palm, and he staggers");
  // - "his/her/their" + a body part opening a clause ("…, and his grip tightens");
  // - "himself/herself/themselves" anywhere ("steadies himself");
  // - after a comma, a phrase with no subject of its own: one opening on an -ing word, or a body
  //   part with no verb of its own ("…, one hand braced"). (A phrase opening on an -ing word
  //   belongs to the sentence's subject, which isn't always the last name: not read.)
  // With pronouns known, "she" stands for the last named character she could be ("…eyes Bram,
  // and she…" is the guard, not Bram); unknown pronouns fall back to the last name.
  const lastBefore = (at: number, word?: string) => {
    const named = [...tagged.slice(0, at).matchAll(/\{([^{}|]+)(?:\|[^{}]*)?\}/g)].map((x) => tagger.entityOf(x[1])).filter((e) => e?.type === "pc" || e?.type === "npc");
    const fits = word ? named.filter((e) => couldBe(word, pronounsOf(e!))) : named;
    return fits[fits.length - 1];
  };
  const say = (who: string, at: number) => `${who} does something, through a word standing for them ("…${tagger.render(tagged.slice(at, at + 40)).trim()}…")`;
  const offsets = (re: RegExp) => [...tagged.matchAll(re)].map((m) => ({ m, at: m.index ?? 0 }));
  for (const { m, at } of offsets(/\b(he|she|they)\b(?!['’])/gi)) {
    if (!CLAUSE_START.test(tagger.render(tagged.slice(0, at)).trimEnd())) continue;
    const who = lastBefore(at, m[1]);
    if (who?.type === "pc" && who.name !== except) return `${who.name} opens a clause, as if doing something ("…${m[0]} ${tagger.render(tagged.slice(at + m[0].length, at + 40)).trim()}…")`;
  }
  for (const { m, at } of offsets(/\b(his|her|their)\s+(\w+)(?:\s+(\w+))?/gi)) {
    if (!(BODY.test(m[2]) || BODY.test(m[3] ?? "")) || !CLAUSE_START.test(tagger.render(tagged.slice(0, at)).trimEnd())) continue;
    const who = lastBefore(at, m[1]);
    if (who?.type === "pc" && who.name !== except) return say(who.name, at);
  }
  for (const { m, at } of offsets(/\b(?:himself|herself|themselves|themself)\b/gi)) {
    const who = lastBefore(at, m[0]);
    if (who?.type === "pc" && who.name !== except) return say(who.name, at);
  }
  for (const { m, at } of offsets(/,\s+(?:one|a|both|his|her|their)\s+(?:\w+\s+)?(\w+)\s+(\w+ed|\w+ing)\b/gi)) {
    if (!BODY.test(m[1])) continue;
    const who = lastBefore(at);
    if (who?.type === "pc" && who.name !== except) return say(who.name, at + 1);
  }
  return null;
}

/** Replaces {1}, {2} with the references, tagged for the checks: "{Bram}", "{Bram}'s". */
export function expand(text: string, refs: Ref[], tagger: Tagger): { tagged: string; problem: string | null } {
  let problem: string | null = null;
  // References counted from {0} instead of {1}: the same list, shifted.
  if (/\{0\}/.test(text)) text = text.replace(/\{(\d+)\}/g, (_, n: string) => `{${Number(n) + 1}}`);
  const tagged = text.replace(/\{(\d+)\}(['’]s\b)?/g, (whole, n: string, owned: string | undefined, at: number) => {
    const ref = refs[Number(n) - 1];
    if (!ref) {
      problem ??= `uses {${n}} but lists only ${refs.length} reference${refs.length === 1 ? "" : "s"}`;
      return whole;
    }
    // "{2}'s" or a possessor reference: one "'s". Only characters and factions own things without
    // an "'s" written, and only when something follows to be owned.
    const next = text.slice(at + whole.length).trimStart().split(/\s+/)[0]?.toLowerCase() ?? "";
    const kind = tagger.entityOf(ref.name)?.type;
    const canOwn = kind === "pc" || kind === "npc" || kind === "faction";
    const owns = owned || (ref.as === "possessor" && canOwn && next && !/^[.,;:!?—]|^(?:with|and|or|but|to|at|in|on|as|from|for|of|by|who|which|that|the|a|an)$/.test(next));
    return owns ? `{${ref.name}}'s` : `{${ref.name}}`;
  });
  // A reference written by name in braces ("{Iresia}'s hands") is the same reference: numbers are
  // easy to mix up, names aren't. Its part comes from the list.
  const byName = tagged.replace(/\{([^{}|\d][^{}|]*)\}(?!['’]s\b)(\s+\w+)?/g, (whole, name: string, next: string | undefined) => {
    const ref = refs.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    const kind = tagger.entityOf(name.trim())?.type;
    const owns = ref?.as === "possessor" && (kind === "pc" || kind === "npc" || kind === "faction") && next && !/^\s+(?:with|and|or|but|to|at|in|on|as|from|for|of|by|who|which|that|the|a|an)$/i.test(next);
    return owns ? `{${name}}'s${next}` : whole;
  });
  // Names written as words are tagged too, and read the same way as references.
  const named = tagger.tag(byName);
  problem ??= pcOpensClause(named, tagger);
  return { tagged: named, problem };
}

// What a cause may be: a thing or a force, in a few words ("the river's cold grip", "the
// figurine's pull"). A clause can carry a thought or a feeling ("the certainty that no blade can
// touch him", "the fear he has never admitted to"), so a cause that reads as one is left out.
const CLAUSE_WORDS = /\b(?:that|who|whom|whose|which|he|she|they|him|them|i|we|you|never|ever|feels?|felt|fears?|certain(?:ty)?|believes?|knows?|thinks?|wants?|hopes?|wonders?|remembers?|admit(?:s|ted)?|is|are|was|were|has|have|had|will|would|can|could|should|must)\b/i;
export function causeOf(cause: string, refs: Ref[], tagger: Tagger): string {
  const c = cause.trim().replace(/[.!]+$/, "");
  if (!c) return "";
  const tagged = expand(c, refs, tagger).tagged;
  const words = tagger.render(tagged).split(/\s+/).filter(Boolean);
  return words.length <= 6 && !CLAUSE_WORDS.test(tagger.render(tagged)) ? tagged : "";
}

/**
 * A character named as owner inside their own sentence ("{Mother Ysolde} wipes {Mother Ysolde}'s
 * hands") reads "her own hands", from their pronouns ("their own" when unknown).
 */
export function ownPossessive(actor: string, tagged: string, tagger: Tagger): string {
  const e = tagger.entityOf(actor);
  if (!e || (e.type !== "npc" && e.type !== "pc")) return tagged;
  const own = pronounsOf(e)?.own ?? "their own";
  // At the very start, "{Vex'ahlia}'s gaze hardens" is the sentence's own subject: it stays, and
  // reads "Vex'ahlia's gaze hardens" (not "Vex'ahlia her own gaze…").
  return tagged.replace(/\{([^{}|]+)(?:\|[^{}]*)?\}['’]s\b/g, (whole, n: string, at: number) => (at > 0 && tagger.entityOf(n.trim())?.name === e.name ? own : whole));
}

/**
 * Whether a character's own sentence names them again as someone else: "{Varek} sends word to
 * {Varek}", "{Tomas} warns {Tomas}". The model wrote it from another character's side, and code put
 * the actor in front. Their own possessive ("{Varek}'s men") is fine, and so is opening with their name.
 */
export function selfReference(actor: string, tagged: string, tagger: Tagger) {
  const e = tagger.entityOf(actor);
  if (!e || (e.type !== "npc" && e.type !== "pc")) return false;
  for (const m of tagged.matchAll(/\{([^{}|]+)(?:\|[^{}]*)?\}(['’]s\b)?/g)) {
    if (m.index === 0 || m[2]) continue;
    if (tagger.entityOf(m[1].trim())?.name === e.name) return true;
  }
  return false;
}

/** A "happens" beat as a sentence, written by code. */
export function renderHappens(h: Happens, refs: Ref[], tagger: Tagger): string {
  const cause = causeOf(h.cause, refs, tagger);
  if (h.part === "none") return `{${h.pc}}'s whole body ${h.sense}${cause ? `: ${cause}` : ""}.`;
  // "eyes burn", "palm burns": the sensation agrees with the part.
  const plural = /^(?:hands|fingers|legs|eyes|ears|horns|scales)$/.test(h.part);
  const sense = plural ? PLURAL[h.sense] : h.sense;
  return `{${h.pc}}'s ${h.part} ${sense}${cause ? `: ${cause}` : ""}.`;
}

export interface SlotOption {
  refs?: Ref[];
  setup: (ScaffoldBeat | Happens)[];
  on_fail: { target: string; effect: string };
}

/** The option with its slots filled: names in place, "happens" beats written as sentences. */
export function fillSlots<O extends SlotOption>(o: O, tagger: Tagger): { option: O & { setup: ScaffoldBeat[] }; problem: string | null; dropped: string[] } {
  const refs = o.refs ?? [];
  let problem: string | null = null;
  const setup: ScaffoldBeat[] = [];
  const dropped: string[] = [];
  // A sentence that breaks a rule is dropped, not the whole option; only an option left with
  // nothing is.
  for (const b of o.setup) {
    if (b.kind === "happens") {
      setup.push({ kind: "world", actor: "world", walk_on: "", does: renderHappens(b, refs, tagger), byCode: true });
      continue;
    }
    const r = expand(b.does, refs, tagger);
    if (r.problem) dropped.push(r.problem);
    else if (selfReference(b.actor, r.tagged, tagger)) dropped.push(`${b.actor} names themself as someone else ("${tagger.render(r.tagged).slice(0, 60)}…"): the sentence was written from another character's side`);
    else setup.push({ ...b, does: ownPossessive(b.actor, r.tagged, tagger) });
  }
  if (!setup.length && dropped.length) problem = dropped[0];
  // A failure may move the PC who rolled; nobody else's PC.
  const fail = expand(o.on_fail.effect, refs, tagger);
  const otherPc = pcOpensClause(fail.tagged, tagger, o.on_fail.target);
  if (otherPc && o.on_fail.effect.trim()) problem ??= `on a failure, ${otherPc}`;
  return { option: { ...o, setup, on_fail: { ...o.on_fail, effect: fail.tagged } }, problem, dropped };
}

// ---------- What a dropped sentence set up stays gone ----------
// A sentence can be dropped by any check (a cast rule, presence, agency, a self-reference). Whatever
// it introduced ("a scrawled note", "a courier") never happened, so nothing later in the option may
// refer back to it ("pocket the note?"): a later sentence that does is dropped too, a choice or a
// question about it becomes a plain question, a failure line about it goes, and so does a headline.

const STOP_HEAD = new Set("moment word words look glance way time while bit sound voice breath step hush pause beat second chance sense smile nod shiver flicker chill silence stillness little few lot single thing something someone name part kind sort piece side half".split(" "));
const PREP = new Set("of from by to in on at with near for into onto across through over under beside behind against about toward towards around along and or but as that who which while".split(" "));
const plain = (t: string) => t.replace(/\{([^{}|]+)(?:\|([^{}]*))?\}/g, (_, n: string, r?: string) => (r ?? n).trim());

/** The things a sentence brings in with "a", "an", "some" or "another": their head nouns. */
export function introducedNouns(text: string): string[] {
  const out: string[] = [];
  const words = plain(text).replace(/[.,;:!?—"“”()]/g, " | ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:a|an|some|another)$/i.test(words[i])) continue;
    let head = "";
    for (let j = i + 1; j < Math.min(words.length, i + 5); j++) {
      const w = words[j].toLowerCase();
      if (w === "|" || PREP.has(w)) break;
      // After the first word, a verb-looking word ends the phrase ("a faint hum rises").
      if (j > i + 1 && /^[a-z]{4,}(?:s|ed|ing)$/.test(w) && !/(?:ss|us|is)$/.test(w)) break;
      head = w.replace(/['’]s$/, "");
    }
    if (head.length >= 3 && !STOP_HEAD.has(head)) out.push(head);
  }
  return [...new Set(out)];
}

/** Whether a text refers back to one of these things ("the note", "Vex's note", "his courier"). */
export function refersTo(text: string, nouns: Iterable<string>) {
  const t = plain(text);
  for (const n of nouns) {
    const head = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:\\b(?:the|that|this|those|these|his|her|their|its|your)|['’]s)\\s+(?:[\\w'’-]+\\s+){0,2}?${head}(?:s|es)?\\b`, "i").test(t)) return n;
  }
  return null;
}

/**
 * After the checks: the raw sentences that didn't survive (by position, `src`), what they introduced,
 * and everything later that refers back to it. `carried` brings losses forward from earlier steps of
 * a chain. Returns what's now lost (for the headline, and the next step).
 */
export function cascadeDropped(o: { setup: ScaffoldBeat[]; hand?: { kind: string; what?: string; or?: string }; on_fail: { target: string; effect: string } }, raw: { does?: string; kind?: string }[], dropped: (reason: string) => void, carried: Iterable<string> = []) {
  const kept = new Set(o.setup.map((b) => b.src).filter((x): x is number => x != null));
  const lost = new Set(carried);
  raw.forEach((b, i) => {
    if (kept.has(i) || b.kind === "happens" || !b.does) return;
    for (const n of introducedNouns(b.does)) lost.add(n);
  });
  // Something a kept sentence brings in itself isn't lost.
  for (const b of o.setup) for (const n of introducedNouns(b.does)) lost.delete(n);
  if (!lost.size) return lost;
  o.setup = o.setup.filter((b) => {
    if (b.byCode) return true;
    const hit = refersTo(b.does, lost);
    if (!hit) return true;
    dropped(`refers to "${hit}", set up by a sentence that was dropped`);
    for (const n of introducedNouns(b.does)) lost.add(n);
    return false;
  });
  const h = o.hand;
  if (h) {
    const sides = [h.what, h.kind === "choice" ? h.or : ""].filter(Boolean).join(" · ");
    const hit = refersTo(sides, lost) ?? (h.kind === "choice" ? [...lost].find((n) => new RegExp(`\\b${n}(?:s|es)?\\b`, "i").test(plain(sides))) : null);
    if (hit) {
      dropped(`the hand-off referred to "${hit}", set up by a sentence that was dropped`);
      if (h.kind === "choice" || h.kind === "question" || h.kind === "notice") Object.assign(h, { kind: "question", what: "", or: "" });
      else h.what = "";
    }
  }
  const failHit = refersTo(o.on_fail.effect, lost);
  if (failHit) {
    dropped(`the failure line referred to "${failHit}", set up by a sentence that was dropped`);
    o.on_fail = { target: "none", effect: "" };
  }
  return lost;
}
