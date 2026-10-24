// L0, the rules layer (docs/loom-model.md §3): 5e conditions as capabilities, the DM's toggles
// for common variants, and the structured shape every house rule or effect uses.

// ---------- Conditions → capabilities (SRD 5.1) ----------

export interface Capabilities {
  act: boolean; // take actions at all
  move: boolean;
  speak: boolean;
  aware: boolean; // perceives anything / knows what's happening
  sees: boolean;
  hears: boolean;
  laws: string[]; // narrative laws worth telling the model
  causes?: string[]; // which conditions or states set these limits, for messages
}

const FULL: Capabilities = { act: true, move: true, speak: true, aware: true, sees: true, hears: true, laws: [] };

export const CONDITIONS: Record<string, Partial<Capabilities>> = {
  blinded: { sees: false, laws: ["can't see"] },
  charmed: { laws: ["can't attack or harm the one who charmed them; that creature has the upper hand socially"] },
  deafened: { hears: false, laws: ["can't hear"] },
  frightened: { laws: ["won't willingly move closer to the source of its fear"] },
  grappled: { move: false },
  incapacitated: { act: false },
  invisible: { laws: ["can't be seen without magic"] },
  paralyzed: { act: false, move: false, speak: false },
  petrified: { act: false, move: false, speak: false, aware: false, sees: false, hears: false, laws: ["turned to stone"] },
  poisoned: {},
  prone: { laws: ["can only crawl until it stands"] },
  restrained: { move: false },
  stunned: { act: false, move: false, laws: ["can speak only falteringly"] },
  unconscious: { act: false, move: false, speak: false, aware: false, sees: false, hears: false, laws: ["drops whatever it's holding"] },
};

// Exhaustion: 2014 levels 1-6 (5 = speed 0, 6 = death); 2024 levels 1-6 (6 = death).
function exhaustion(level: number): Partial<Capabilities> {
  if (level >= 6) return { act: false, move: false, speak: false, aware: false, sees: false, hears: false, laws: ["dead from exhaustion"] };
  if (level >= 5) return { move: false, laws: [`exhaustion ${level}`] };
  return { laws: [`exhaustion ${level}`] };
}

export interface Capable {
  status?: string | null;
  traits: { health?: string; conditions?: string[] };
}

// Everything that limits a creature right now: status, health band and 5e conditions.
export function capabilitiesOf(e: Capable): Capabilities {
  const c: Capabilities = { ...FULL, laws: [], causes: [] };
  const apply = (cause: string, p: Partial<Capabilities>) => {
    for (const k of ["act", "move", "speak", "aware", "sees", "hears"] as const) if (p[k] === false) c[k] = false;
    if (p.laws) c.laws.push(...p.laws);
    c.causes!.push(cause);
  };
  if (e.status === "dead") apply("dead", { act: false, move: false, speak: false, aware: false, sees: false, hears: false, laws: ["dead"] });
  if (e.status === "captured") apply("captured", { laws: ["captured: acts only within captivity unless they escape"] });
  if (e.traits.health === "unconscious") apply("unconscious", CONDITIONS.unconscious);
  for (const raw of e.traits.conditions ?? []) {
    const name = raw.trim().toLowerCase();
    const ex = name.match(/^exhaustion\s*(\d)/);
    if (ex) apply(name, exhaustion(Number(ex[1])));
    else if (CONDITIONS[name]) apply(name, CONDITIONS[name]);
  }
  return c;
}

// ---------- DM toggles for common variants that change the story ----------

export const TOGGLES = {
  edition: { options: ["2014", "2024"], default: "2014", label: "Rules edition" },
  resting: { options: ["standard", "gritty", "heroic"], default: "standard", label: "Resting" },
  death: { options: ["standard", "lingering-injuries", "harsh", "no-permanent-death"], default: "standard", label: "Death" },
  death_saves: { options: ["public", "secret"], default: "public", label: "Death saves" },
  madness: { options: ["off", "dmg-tables", "sanity"], default: "off", label: "Madness" },
  healing_potions: { options: ["action", "bonus-action"], default: "action", label: "Healing potions" },
  inspiration: { options: ["standard", "hero-points", "off"], default: "standard", label: "Inspiration" },
  encumbrance: { options: ["off", "standard", "variant"], default: "off", label: "Encumbrance" },
  alignment: { options: ["ignored", "descriptive", "enforced"], default: "descriptive", label: "Alignment" },
  lethality: { options: ["forgiving", "standard", "deadly"], default: "standard", label: "Lethality" },
  magic: { options: ["rare", "standard", "common"], default: "standard", label: "Magic availability" },
} as const;
export type ToggleName = keyof typeof TOGGLES;
export type Toggles = Partial<Record<ToggleName, string>>;

export const toggleValue = (t: Toggles, name: ToggleName) => t[name] ?? TOGGLES[name].default;

// One line per toggle that differs from the default, for prompts.
export function togglesText(t: Toggles) {
  return (Object.keys(TOGGLES) as ToggleName[])
    .filter((k) => t[k] && t[k] !== TOGGLES[k].default)
    .map((k) => `${TOGGLES[k].label}: ${t[k]}`);
}

// ---------- L3 laws on relationships (docs/loom-model.md §4) ----------

type EntityType = "pc" | "npc" | "location" | "item" | "faction" | "other";

export interface RelationLaw {
  to?: EntityType[]; // what the relationship can point at
  from?: EntityType[]; // what can hold the relationship
  // "one-per-target": the target has at most one of these (an item has one holder, a faction one
  //   leader), unless the target is marked shared.
  // "one-per-source": the source has at most one (you live in one place, stand in one place).
  cardinality?: "one-per-target" | "one-per-source";
  symmetric?: boolean; // A ally B means B ally A
}

const CHARACTERS: EntityType[] = ["pc", "npc"];
const ACTORS: EntityType[] = ["pc", "npc", "faction"];

// Ties that can't both be true at once between the same two: a new one replaces its opposite
// (the old one stays in the change log, which is how "enemies, now allies" is remembered).
export const OPPOSITE_TIES: Partial<Record<string, string[]>> = {
  ally: ["enemy", "rivals"],
  enemy: ["ally", "romance"],
  rivals: ["ally"],
  romance: ["enemy"],
  loves: ["hates", "dislikes"],
  cherishes: ["hates", "dislikes"],
  likes: ["dislikes", "hates"],
  dislikes: ["likes", "loves", "cherishes"],
  hates: ["loves", "cherishes", "likes"],
  trusts: ["distrusts"],
  distrusts: ["trusts"],
};

export const RELATION_LAWS: Partial<Record<string, RelationLaw>> = {
  holds: { from: CHARACTERS, to: ["item"], cardinality: "one-per-target" },
  made: { to: ["item", "location"] },
  wants: {},
  lives_at: { from: CHARACTERS, to: ["location"], cardinality: "one-per-source" },
  located_at: { from: ["pc", "npc", "item", "faction"], to: ["location"], cardinality: "one-per-source" },
  controls: { from: ACTORS, to: ["location", "item", "faction"] },
  leads: { from: CHARACTERS, to: ["faction"], cardinality: "one-per-target" },
  member_of: { from: CHARACTERS, to: ["faction"] },
  serves: { from: CHARACTERS },
  family: { from: CHARACTERS, to: CHARACTERS, symmetric: true },
  romance: { from: CHARACTERS, to: CHARACTERS, symmetric: true },
  ally: { from: ACTORS, to: ACTORS, symmetric: true },
  enemy: { from: ACTORS, to: ACTORS, symmetric: true },
  rivals: { from: ACTORS, to: ACTORS, symmetric: true },
  hunts: { from: ACTORS },
  owes: { from: ACTORS, to: ACTORS },
  promised: { from: ACTORS },
};

// ---------- House rules and effects ----------

export const TRIGGERS = ["on-use", "on-exposure", "on-touch", "on-rest", "on-condition", "per-session", "on-event", "always"] as const;
export const APPLIES_TO = ["holder", "user", "everyone-except-holder", "everyone-present", "party", "listed", "source-target"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export type AppliesTo = (typeof APPLIES_TO)[number];
