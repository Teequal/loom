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
    wants: list,
    fears: list,
    ideals: list,
    bonds: list,
    flaws: list,
    secrets: list, // secrets this character holds
    knowledge: list, // rumours and facts they'd share if asked
    player: z.string(), // PCs: who plays them
    backstory_hooks: list,
    party_role: z.string(),
    // locations
    location_type: z.string(),
    hazards: list, // location effects, e.g. mind-affecting butterflies
    atmosphere: list,
    // items
    known_properties: z.string(),
    true_properties: z.string(),
    cost: z.string(), // side effects or price of use, e.g. a madness roll per use
    rarity: z.string(),
    // factions
    faction_goal: z.string(),
    plan: z.string(), // current plan between sessions
    clock: z.string(), // progress toward the plan, e.g. "3 of 6"
  })
  .partial();
export type EntityTraits = z.infer<typeof TraitsSchema>;

// Provenance: where each value came from. Keyed by column name ("status") or
// trait path ("traits.race"). Manual entries win over extraction.
export type Source = "dm" | "extracted";
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
