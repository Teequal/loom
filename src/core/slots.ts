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
  const lastBefore = (at: number) => {
    const named = [...tagged.slice(0, at).matchAll(/\{([^{}|]+)(?:\|[^{}]*)?\}/g)].map((x) => tagger.entityOf(x[1])).filter((e) => e?.type === "pc" || e?.type === "npc");
    return named[named.length - 1];
  };
  const say = (who: string, at: number) => `${who} does something, through a word standing for them ("…${tagger.render(tagged.slice(at, at + 40)).trim()}…")`;
  const offsets = (re: RegExp) => [...tagged.matchAll(re)].map((m) => ({ m, at: m.index ?? 0 }));
  for (const { m, at } of offsets(/\b(he|she|they)\b(?!['’])/gi)) {
    if (!CLAUSE_START.test(tagger.render(tagged.slice(0, at)).trimEnd())) continue;
    const who = lastBefore(at);
    if (who?.type === "pc" && who.name !== except) return `${who.name} opens a clause, as if doing something ("…${m[0]} ${tagger.render(tagged.slice(at + m[0].length, at + 40)).trim()}…")`;
  }
  for (const { m, at } of offsets(/\b(?:his|her|their)\s+(\w+)(?:\s+(\w+))?/gi)) {
    if (!(BODY.test(m[1]) || BODY.test(m[2] ?? "")) || !CLAUSE_START.test(tagger.render(tagged.slice(0, at)).trimEnd())) continue;
    const who = lastBefore(at);
    if (who?.type === "pc" && who.name !== except) return say(who.name, at);
  }
  for (const { at } of offsets(/\b(?:himself|herself|themselves|themself)\b/gi)) {
    const who = lastBefore(at);
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

/** A "happens" beat as a sentence, written by code. */
export function renderHappens(h: Happens, refs: Ref[], tagger: Tagger): string {
  const cause = h.cause.trim() ? expand(h.cause.trim().replace(/[.!]+$/, ""), refs, tagger).tagged : "";
  if (h.part === "none") return cause ? `{${h.pc}} feels ${cause}.` : `A shiver runs through {${h.pc}}.`;
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
    else setup.push({ ...b, does: r.tagged });
  }
  if (!setup.length && dropped.length) problem = dropped[0];
  // A failure may move the PC who rolled; nobody else's PC.
  const fail = expand(o.on_fail.effect, refs, tagger);
  const otherPc = pcOpensClause(fail.tagged, tagger, o.on_fail.target);
  if (otherPc && o.on_fail.effect.trim()) problem ??= `on a failure, ${otherPc}`;
  return { option: { ...o, setup, on_fail: { ...o.on_fail, effect: fail.tagged } }, problem, dropped };
}
