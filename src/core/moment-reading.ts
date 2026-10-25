// Reading the moment, in code. What the GM typed is read once, here, into structure: who it brings
// into the scene, who it only mentions, who the players reach from afar, which PCs are acting,
// what's in whose hand, what's being used, conditions it states, and where the party goes.
// Everything downstream (the scene model, the answer format, the checks) works from this, so the
// model is never the one deciding who can be where.
//
// The rules are a table: each says what it recognises and carries the moments it was written
// for, which the engine tests run. A phrasing it misses is one new row and one new example.

export type MentionRole = "brings-in" | "refers" | "contacts" | "acts" | "named" | "goes-to";

export interface ReadEntity {
  id: number;
  name: string;
  aliases: string[];
  type: string;
}

export interface Mention {
  entity: ReadEntity;
  at: number;
  end: number;
  role: MentionRole;
  rule: string; // which reading rule decided it
}

export interface MomentReading {
  mentions: Mention[];
  broughtIn: Set<string>; // NPCs and factions the moment puts in the scene
  referred: Set<string>; // named, but not here ("Bhen's mother", "looks for Bhen")
  contacted: Set<string>; // reached from afar (Sending, a letter, scrying)
  acting: Set<string>; // PCs whose declared action this is
  wholeParty: boolean; // the moment is about the whole party
  inHand: { pc: string; item: string }[]; // items the moment puts with a PC
  used: Set<string>; // items being used (for "on use" rules)
  conditions: { pc: string; condition: string }[];
  goesTo: string | null; // a place the party heads to or arrives at
}

type Rule = { id: string; says: string; examples: { moment: string; name: string; expect: MentionRole | "used" | "in-hand" | "whole-party" | string }[] };

// Words just before a name that make it a reference, not a presence.
const REFERS_BEFORE =
  /\b(?:for|about|after|of|from|without|where|find|finding|finds|search(?:es|ing)?(?: for)?|rescue|rescuing|save|saving|track(?:ing|s)?|hunt(?:s|ing)?(?: for)?|remember(?:s|ing)?|mourn(?:s|ing)?|miss(?:es|ing)?|ask(?:s|ing)? about|think(?:s|ing)? (?:of|about)|news of|word of|like)\s+(?:(?:the|poor|little|young|old|professor|captain|lord|lady|sir|mother|father|brother|sister|master|mistress|elder|dame)\s+){0,2}$/i;
// Reaching someone at a distance, earlier in the same sentence.
const CONTACT_BEFORE =
  /\b(?:sending|sends? (?:a )?(?:message|letter|note|word|runner|messenger)|message|messages|letter|writes? to|scry(?:ing|es)?|telepath\w*|dream\w*|commune\w*|crystal ball|calls? out to|whispers? (?:through|across)|reach(?:es|ing)? out to|contact\w*)\b[^.!?]*$/i;
const PLACE_BEFORE = /\b(?:heads?|head|goes|go|going|returns?|return|back|travels?|walks?|rides?|sails?|arrives?|arriving|enters?|runs?|flees?|sneaks?|moves?|hurries|hurry|rushes?)\b[^.!?]{0,25}?\b(?:to|into|at|in|towards?|toward)\s+(?:the\s+)?$/i;
const USE_BEFORE =
  /\b(?:uses?|using|pulls? out|takes? out|draws?|holds? up|raises?|lifts?|activates?|wields?|touches?|rubs?|consults?|looks? into|peers? into|asks?|invokes?|calls? on|opens?|drinks?|reads?|plays?|clutches?|grips?|casts? (?:a )?(?:spell )?(?:on|into|through))\b[^.!?,]{0,25}$/i;
const GIVE_TO_AFTER = /^[^.!?]{0,40}?\b(?:to|for)\s+$/i;
export const WHOLE_PARTY = /\b(?:the party|everyone|the group|they all|we|the players|the heroes|the adventurers)\b/i;
export const MOMENT_CONDITIONS: [RegExp, string][] = [
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

export const READING_RULES: Rule[] = [
  {
    id: "possessive-refers",
    says: "A name in the possessive is about someone else: “Bhen's mother” doesn't bring Bhen.",
    examples: [{ moment: "The party admits to Bhen's mother they never looked for him", name: "Bhen", expect: "refers" }],
  },
  {
    id: "reference-words",
    says: "Looking for, asking about, news of, a note from: the name is referred to, not here.",
    examples: [
      { moment: "They finally look for Bhen in the woods", name: "Bhen", expect: "refers" },
      { moment: "Iresia asks the barkeep about Professor Vex", name: "Professor Aldric Vex", expect: "refers" },
      { moment: "Khayiulad reads a note from Zara aloud", name: "Zara the Unbound", expect: "refers" },
    ],
  },
  {
    id: "contact-from-afar",
    says: "Sending, a letter, scrying or a message reaches someone who isn't here; they may answer from afar.",
    examples: [
      { moment: "Iresia casts Sending to Zara", name: "Zara the Unbound", expect: "contacts" },
      { moment: "Darius writes to Mother Ysolde asking for the cure", name: "Mother Ysolde", expect: "contacts" },
    ],
  },
  {
    id: "brings-in",
    says: "Otherwise a named NPC or faction is in the scene: “confront Zara”, “Zara bursts in”, “tells Tomas”.",
    examples: [
      { moment: "The party heads back to the Resistance HQ to confront Zara", name: "Zara the Unbound", expect: "brings-in" },
      { moment: "Bhen runs up to the party", name: "Bhen", expect: "brings-in" },
      { moment: "Darius punches Vex", name: "Professor Aldric Vex", expect: "brings-in" },
    ],
  },
  {
    id: "pc-acts",
    says: "A PC named other than in the possessive is acting: their player declared it.",
    examples: [
      { moment: "Salaena kicks Darius to prove he can bleed", name: "Salaena", expect: "acts" },
      { moment: "Salaena kicks Darius to prove he can bleed", name: "Darius", expect: "acts" },
    ],
  },
  {
    id: "whole-party",
    says: "“The party”, “everyone”, “we”: every PC is acting.",
    examples: [{ moment: "The party starts a bar fight", name: "", expect: "whole-party" }],
  },
  {
    id: "goes-to",
    says: "Heading to, returning to or arriving at a place moves the party there for this moment.",
    examples: [{ moment: "The party heads back to the Resistance HQ to confront Zara", name: "Resistance Headquarters", expect: "goes-to" }],
  },
  {
    id: "item-in-hand",
    says: "An item named after a PC in the same sentence is with that PC, unless it's given to someone (“gives the vial to Tomas”).",
    examples: [
      { moment: "Khayiulad tries to sell the monk figurine to a shady merchant", name: "Monk figurine", expect: "in-hand:Khayiulad" },
      { moment: "Iresia grabs the monk figurine", name: "Monk figurine", expect: "in-hand:Iresia" },
    ],
  },
  {
    id: "item-used",
    says: "Pulling out, using, consulting or holding up an item is using it (for “on use” rules). Selling or carrying it isn't.",
    examples: [
      { moment: "Khayiulad pulls out the knight figurine yet again", name: "Knight figurine", expect: "used" },
      { moment: "Khayiulad tries to sell the monk figurine to a shady merchant", name: "Monk figurine", expect: "not-used" },
    ],
  },
  {
    id: "conditions",
    says: "A condition the moment states (unconscious, restrained…) belongs to the PC named last before it.",
    examples: [{ moment: "Iresia, at 0 HP and unconscious, is dragged away", name: "Iresia", expect: "condition:unconscious" }],
  },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentenceStart = (text: string, at: number) => Math.max(text.lastIndexOf(".", at - 1), text.lastIndexOf("!", at - 1), text.lastIndexOf("?", at - 1), text.lastIndexOf(";", at - 1)) + 1;
const sentenceEnd = (text: string, at: number) => {
  const ends = [".", "!", "?", ";"].map((c) => text.indexOf(c, at)).filter((i) => i >= 0);
  return ends.length ? Math.min(...ends) : text.length;
};

// Every mention of a known name, longest names first, so "Vex" inside "Professor Aldric Vex" is
// the same mention. First names count for characters when they belong to only one.
function findSpans(entities: ReadEntity[], moment: string) {
  const firstCount = new Map<string, number>();
  for (const e of entities) {
    const f = e.name.split(/[\s,]+/)[0].toLowerCase();
    firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  const names: { e: ReadEntity; n: string }[] = [];
  for (const e of entities) {
    const first = e.name.split(/[\s,]+/)[0];
    const forms = [e.name, ...e.aliases];
    if ((e.type === "pc" || e.type === "npc") && first.length >= 3 && firstCount.get(first.toLowerCase()) === 1) forms.push(first);
    // Items and places read with or without "the", and in lower case ("the monk figurine").
    for (const n of new Set(forms)) if (n.length >= 3) names.push({ e, n: n.replace(/^the\s+/i, "") });
  }
  names.sort((a, b) => b.n.length - a.n.length);
  const spans: { e: ReadEntity; at: number; end: number }[] = [];
  for (const { e, n } of names) {
    for (const m of moment.matchAll(new RegExp(`\\b${escape(n)}\\b`, "gi"))) {
      if (spans.some((s) => m.index < s.end && m.index + m[0].length > s.at)) continue;
      spans.push({ e, at: m.index, end: m.index + m[0].length });
    }
  }
  return spans.sort((a, b) => a.at - b.at);
}

export function readMoment(entities: ReadEntity[], moment: string): MomentReading {
  const r: MomentReading = {
    mentions: [],
    broughtIn: new Set(),
    referred: new Set(),
    contacted: new Set(),
    acting: new Set(),
    wholeParty: WHOLE_PARTY.test(moment),
    inHand: [],
    used: new Set(),
    conditions: [],
    goesTo: null,
  };
  const spans = findSpans(entities, moment);
  for (const s of spans) {
    const before = moment.slice(sentenceStart(moment, s.at), s.at);
    const after = moment.slice(s.end);
    const possessive = /^['’]s?\b/.test(after);
    const push = (role: MentionRole, rule: string) => r.mentions.push({ entity: s.e, at: s.at, end: s.end, role, rule });
    if (s.e.type === "npc" || s.e.type === "faction") {
      if (possessive) push("refers", "possessive-refers");
      else if (CONTACT_BEFORE.test(before)) push("contacts", "contact-from-afar");
      else if (REFERS_BEFORE.test(moment.slice(Math.max(0, s.at - 40), s.at))) push("refers", "reference-words");
      else push("brings-in", "brings-in");
    } else if (s.e.type === "pc") {
      push(possessive ? "named" : "acts", "pc-acts");
    } else if (s.e.type === "location") {
      push(PLACE_BEFORE.test(moment.slice(Math.max(0, s.at - 60), s.at)) ? "goes-to" : "named", "goes-to");
    } else {
      push("named", "item-in-hand");
    }
  }
  // A name counts once: here if any mention brings them in, else contacted, else referred.
  for (const m of r.mentions) {
    const n = m.entity.name;
    if (m.role === "brings-in") r.broughtIn.add(n);
    if (m.role === "acts") r.acting.add(n);
    if (m.role === "goes-to") r.goesTo = n;
  }
  for (const m of r.mentions) {
    const n = m.entity.name;
    if (m.role === "contacts" && !r.broughtIn.has(n)) r.contacted.add(n);
  }
  for (const m of r.mentions) {
    const n = m.entity.name;
    if (m.role === "refers" && !r.broughtIn.has(n) && !r.contacted.has(n)) r.referred.add(n);
  }

  // Items: with the PC named before them in the same sentence (or after "to"/"for" when given),
  // and used when a use word comes just before.
  const pcSpans = spans.filter((s) => s.e.type === "pc" && !/^['’]s?\b/.test(moment.slice(s.end)));
  for (const s of spans.filter((x) => x.e.type === "item")) {
    const start = sentenceStart(moment, s.at);
    const end = sentenceEnd(moment, s.end);
    const before = moment.slice(start, s.at);
    if (USE_BEFORE.test(before)) r.used.add(s.e.name);
    const givenTo = pcSpans.find((p) => p.at > s.end && p.at < end && GIVE_TO_AFTER.test(moment.slice(s.end, p.at)));
    const holder = givenTo ?? [...pcSpans].reverse().find((p) => p.at < s.at && p.at >= start);
    if (holder) r.inHand.push({ pc: holder.e.name, item: s.e.name });
  }

  // Conditions: the PC named last before the condition word, in the same sentence.
  for (const clause of moment.matchAll(/[^.;!?]+/g)) {
    for (const [re, condition] of MOMENT_CONDITIONS) {
      const m = clause[0].match(re);
      if (!m) continue;
      const at = clause.index + (m.index ?? 0);
      const pc = [...pcSpans].reverse().find((p) => p.at < at && p.at >= clause.index) ?? (pcSpans.length === 1 ? pcSpans[0] : undefined);
      if (pc) r.conditions.push({ pc: pc.e.name, condition });
    }
  }
  return r;
}

// Runs every rule's examples against a small cast; the engine tests call this.
export function checkReadingRules(cast: ReadEntity[]) {
  const results: { rule: string; moment: string; ok: boolean; got: string }[] = [];
  for (const rule of READING_RULES) {
    for (const ex of rule.examples) {
      const r = readMoment(cast, ex.moment);
      let got: string;
      if (ex.expect === "whole-party") got = r.wholeParty ? "whole-party" : "not whole";
      else if (ex.expect === "used" || ex.expect === "not-used") got = r.used.has(ex.name) ? "used" : "not-used";
      else if (ex.expect.startsWith("in-hand:")) got = `in-hand:${r.inHand.find((h) => h.item === ex.name)?.pc ?? "nobody"}`;
      else if (ex.expect.startsWith("condition:")) got = `condition:${r.conditions.find((c) => c.pc === ex.name)?.condition ?? "none"}`;
      else got = r.mentions.find((m) => m.entity.name === ex.name)?.role ?? "not found";
      results.push({ rule: rule.id, moment: ex.moment, ok: got === ex.expect, got });
    }
  }
  return results;
}
