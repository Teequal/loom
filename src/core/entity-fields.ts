import { z } from "zod";

// The entity model from docs/entity-model.md. Tier 1 fields (checked by code) are real columns
// in the schema; tier 2/3 fields live in a validated `traits` object so the catalogue can grow
// without a migration for every new attribute.

export const ENTITY_STATUSES = {
  pc: ["alive", "dead", "missing", "captured", "transformed", "unknown"],
  npc: ["alive", "dead", "missing", "captured", "transformed", "unknown"],
  location: ["intact", "destroyed", "occupied", "abandoned", "unknown"],
  item: ["intact", "used", "broken", "lost", "unknown"],
  faction: ["active", "disbanded", "destroyed", "unknown"],
  other: ["unknown"],
} as const;

export const ATTITUDES = ["hostile", "unfriendly", "indifferent", "friendly", "helpful"] as const;
export const IMPORTANCE = ["major", "minor", "walk-on"] as const;
export const ALIGNMENTS = [
  "lawful good", "neutral good", "chaotic good",
  "lawful neutral", "true neutral", "chaotic neutral",
  "lawful evil", "neutral evil", "chaotic evil",
  "unaligned",
] as const;

// A rough health band rather than hit points: enough to keep stories consistent
// ("still in critical condition"), without duplicating the character sheet.
export const HEALTH = ["healthy", "wounded", "bloodied", "critical", "unconscious"] as const;

export const RELATION_TYPES = [
  // feelings
  "loves", "cherishes", "likes", "trusts", "distrusts", "dislikes", "hates", "fears", "rivals",
  // ties
  "family", "romance", "ally", "enemy", "serves", "leads", "member_of",
  // obligations
  "owes", "promised", "hunts",
  // possession
  "holds", "made", "wants",
  // knowledge
  "knows_about", "knows_secret_of",
  // place
  "lives_at", "controls", "located_at",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

const list = z.array(z.string());
const scale = z.number().int().min(-3).max(3);
const level03 = z.number().int().min(0).max(3);

// The property model (docs/design-2026-10-26-property-model.md): sub-properties, each typed,
// sourced and addressable by path. Temperament is layered: dispositions (what someone is like
// underneath, slow to change) and states (how they are right now; they move and settle).
export const DISPOSITIONS = ["compassion", "honesty", "boldness", "temper", "pride", "greed", "curiosity", "discipline", "faith", "fidelity"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const STATES = ["confidence", "fear", "anger", "hope", "strain"] as const;
export type State = (typeof STATES)[number];
export const GOAL_STATUSES = ["active", "achieved", "abandoned", "blocked"] as const;
// A goal (or a faction's aim): what, how high it ranks, who it's good for (intent: −3 harms
// others … +3 helps others), how hard they'll push, whom it's about, where it stands.
const Goal = z.object({
  id: z.string().optional(), // stable ("g2"), so a sub-property of it can be found and undone
  text: z.string(),
  priority: z.number().int().min(1).max(3),
  intent: scale.optional(),
  commitment: level03.optional(),
  target: z.number().int().optional(), // an entity id
  status: z.enum(GOAL_STATUSES).optional(),
  secret: z.boolean().optional(),
});
export type Goal = z.infer<typeof Goal>;

// Tier 2/3 attributes. All optional: blanks beat guesses.
export const TraitsSchema = z
  .object({
    // characters
    race: z.string(),
    occupation: z.string(), // class for PCs, role or job for NPCs
    level: z.string(), // PC level or rough NPC power/CR
    age: z.string(), // a number or a band: child / young / adult / old / ancient
    gender: z.string(),
    appearance: list, // 2-3 descriptors
    voice: z.string(), // voice and mannerisms
    alignment: z.enum(ALIGNMENTS),
    goal: z.string(), // current goal or off-screen activity
    goals: z.array(Goal), // ranked goals; "goal" stays for a single line
    mood: z.number().int().min(-3).max(3), // -3 despairing … 0 steady … +3 elated
    beliefs: z.array(z.object({ id: z.string().optional(), text: z.string(), true: z.boolean().optional(), conviction: z.number().int().min(1).max(3).optional() })), // "he can't die" (true: false)
    // Dispositions, −3 … +3 (compassion: cruel ↔ kind; boldness: timid ↔ daring; temper: calm ↔ volatile…).
    disposition: z.object(Object.fromEntries(DISPOSITIONS.map((d) => [d, scale])) as Record<Disposition, typeof scale>).partial(),
    // States: confidence −3 … +3, the others 0–3.
    state: z.object({ confidence: scale, fear: level03, anger: level03, hope: level03, strain: level03 }).partial(),
    // Who caused a condition, and at whom it's aimed: "charmed by Iresia", "frightened of Varek".
    condition_sources: z.array(z.object({ condition: z.string(), by: z.number().int().optional(), target: z.number().int().optional() })),
    // The DM's word on an interplay for this character: on or off, whatever the numbers say ("other": an entity id).
    interplay_overrides: z.array(z.object({ id: z.string(), on: z.boolean(), other: z.number().int().optional() })),
    wants: list,
    fears: list,
    ideals: list,
    bonds: list,
    flaws: list,
    abilities: list, // what they can do: spells, features, powers ("wildshape: alley cat", "Temporal Echoes")
    secrets: list, // secrets this character holds
    knowledge: list, // rumours and facts they'd share if asked
    player: z.string(), // PCs: who plays them
    backstory_hooks: list,
    party_role: z.string(),
    // 5e character details that change what's worth suggesting (stats stay on the character sheet)
    background: z.string(), // acolyte, criminal, noble …
    personality_traits: list,
    languages: list,
    health: z.enum(HEALTH),
    conditions: list, // short-term mechanical: charmed, frightened, poisoned, exhaustion 2 …
    gear: list, // notable mundane gear a clever option could use: rope, disguise kit, holy symbol
    wealth: z.string(), // rough band: broke / ~50 gp / flush
    passive_perception: z.string(),
    passive_insight: z.string(),
    // locations
    location_type: z.string(),
    hazards: list, // location effects, e.g. mind-affecting butterflies
    atmosphere: list,
    // items
    known_properties: z.string(),
    true_properties: z.string(),
    cost: z.string(), // side effects or price of use, e.g. a madness roll per use
    rarity: z.string(),
    possession: z.enum(["single", "shared"]), // items: one holder at a time (default) or several
    power: level03, // items: how much it can do
    pull: level03, // items: how much it draws its holder to use it
    cost_severity: level03, // items: how bad the price of use is
    cost_grows: z.boolean(), // items: whether the price rises with use
    // factions
    faction_goal: z.string(),
    plan: z.string(), // current plan between sessions
    clock: z.string(), // progress toward the plan, e.g. "3 of 6"
    aims: z.array(Goal), // factions: what it wants, as goals
    aggression: level03, // factions: how readily it uses force
    alert: level03, // factions: how wary of the party it is
    // places
    danger: level03,
  })
  .partial();
export type EntityTraits = z.infer<typeof TraitsSchema>;
export const TRAIT_KEYS = Object.keys(TraitsSchema.shape) as (keyof EntityTraits)[];
// Structured traits: written by the DM, the CLI, the table or a reviewed inference pass, never as
// "key: text" by the extractor (its schema can't express them yet).
export const STRUCTURED_TRAITS = new Set<string>(["goals", "beliefs", "mood", "disposition", "state", "condition_sources", "power", "pull", "cost_severity", "cost_grows", "aims", "aggression", "alert", "danger", "interplay_overrides"]);
// Arrays whose items carry stable ids, and the letter their ids start with.
export const ID_LISTS: Record<string, string> = { goals: "g", beliefs: "b", aims: "a" };
export const LIST_TRAITS = new Set<string>([
  "appearance", "wants", "fears", "ideals", "bonds", "flaws", "abilities", "secrets", "knowledge", "backstory_hooks", "hazards", "atmosphere",
  "personality_traits", "languages", "conditions", "gear",
]);

// Provenance: where each value came from. Keyed by column name ("status") or
// trait path ("traits.race"). Manual entries win over extraction.
// "table": nudged by what happened at the table; "inferred": a reviewed one-off suggestion.
export type Source = "dm" | "extracted" | "table" | "inferred";
export interface FieldMeta {
  source: Source;
  sessionId?: number | null;
  secret?: boolean; // GM-only: shapes outcomes, never handed to characters for free
  at: string; // ISO timestamp of the last write
}
export type FieldMetaMap = Record<string, FieldMeta>;

export interface CampaignMechanic {
  name: string; // "Figurine madness"
  rule: string; // "Every figurine use triggers a madness roll"
}

const MOODS: Record<string, string> = { "-3": "despairing", "-2": "low", "-1": "uneasy", "0": "steady", "1": "content", "2": "high-spirited", "3": "elated" };

/** A trait's value in words, for people and prompts: ranked goals in order, beliefs marked when untrue, mood as a word. */
export function traitText(key: string, value: unknown): string {
  if (key === "mood" && typeof value === "number") return MOODS[String(value)] ?? String(value);
  // A set of numbers (dispositions, states): "boldness −1, temper +2".
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value).map(([k, n]) => `${k} ${typeof n === "number" && n > 0 && key !== "state" ? `+${n}` : n}`).join(", ");
  if (!Array.isArray(value)) return String(value);
  const items = key === "goals" ? [...value].sort((a, b) => (a?.priority ?? 9) - (b?.priority ?? 9)) : value;
  return items
    .map((v) => {
      if (v == null || typeof v !== "object") return String(v);
      const o = v as { text?: string; true?: boolean };
      return `${o.text ?? JSON.stringify(v)}${key === "beliefs" && o.true === false ? " (not true)" : ""}`;
    })
    .join("; ");
}

/** Whether a trait has anything to show (0 is a value: a steady mood). */
export const hasTrait = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v != null && v !== "");
