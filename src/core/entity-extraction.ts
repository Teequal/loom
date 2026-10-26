import { PAIR_WEIGHTS, type PairWeight } from "./db/schema";
import { setPairWeights, setSubProperty } from "./entities";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { setRelation, updateCampaign, updateEntity, type EntityPatch, type Proposal as FieldProposal } from "./entities";
import {
  ATTITUDES,
  ENTITY_STATUSES,
  IMPORTANCE,
  LIST_TRAITS,
  STRUCTURED_TRAITS,
  RELATION_TYPES,
  TRAIT_KEYS,
  TraitsSchema,
  type EntityTraits,
  DISPOSITIONS,
  STATES,
  hasTrait,
  traitText,
} from "./entity-fields";
import { RELATION_LAWS } from "./rules";

// The entity side of extraction: field updates, relationships and where the party is.
// Shared by `recap` (alongside thread changes) and `enrich` (backfill from stored recaps).
// Everything is applied as source "extracted", so the DM's own entries are never overwritten.

// Traits extraction may propose. Settings the DM controls (possession: single or shared) are left out.
const EXTRACTABLE_TRAITS = TRAIT_KEYS.filter((k) => k !== "possession" && !STRUCTURED_TRAITS.has(k)) as [string, ...string[]];

export const EntityUpdateSchema = z.object({
  name: z.string(),
  status: z.string(), // "" if not stated
  attitude: z.enum(["", ...ATTITUDES]),
  importance: z.enum(["", ...IMPORTANCE]),
  last_known_location: z.string(),
  parent_location: z.string(),
  traits: z.array(z.object({ key: z.enum(EXTRACTABLE_TRAITS), value: z.string() })),
  evidence: z.string(), // a short exact quote from the notes that supports this
});
export const RelationChangeSchema = z.object({
  from: z.string(),
  type: z.enum(RELATION_TYPES),
  to: z.string(),
  note: z.string(),
  strength: z.number(),
  evidence: z.string(),
});
// The property model's sub-properties, as notes show them (docs/design-2026-10-26-property-model.md
// §10): a goal's intent or commitment (named by its text), a disposition, a state; and how one
// stands toward another (pair weights). Only what the notes show; blanks beat guesses.
export const SUB_KEYS = ["intent", "commitment", ...DISPOSITIONS, ...STATES] as const;
// key and weight are checked in code too; the call that writes them (proposeProperties) enforces
// them as lists.
export const SubChangeSchema = z.object({ name: z.string(), key: z.string(), goal: z.string(), value: z.number().int(), evidence: z.string() });
export const WeightChangeSchema = z.object({ from: z.string(), to: z.string(), weight: z.string(), value: z.number().int(), evidence: z.string() });
// The inference pass also says whether the notes state a value or only imply it.
// Code adds a few fields of its own: table nudges name the path directly (a faction's "alert"),
// say why in plain words, and mark a weight that would flip between warm and cold.
export type SubChange = z.infer<typeof SubChangeSchema> & { basis?: "stated" | "implied"; path?: string; because?: string };
export type WeightChange = z.infer<typeof WeightChangeSchema> & { basis?: "stated" | "implied"; because?: string; crosses?: boolean };

export const EntityChangesShape = {
  entity_updates: z.array(EntityUpdateSchema),
  relations: z.array(RelationChangeSchema),
  party_location: z.string(),
  party_evidence: z.string(),
};
export type EntityUpdate = z.infer<typeof EntityUpdateSchema>;
export type RelationChange = z.infer<typeof RelationChangeSchema>;

// What each constrained relationship can point at, from the laws, so proposals respect them.
const LAW_TEXT = Object.entries(RELATION_LAWS)
  .filter(([, law]) => law?.to || law?.from)
  .map(([type, law]) => `${type}${law!.from ? ` (from ${law!.from.join("/")})` : ""}${law!.to ? ` → ${law!.to.join("/")} only` : ""}`)
  .join("; ");

export const PROPERTY_RULES = `sub_properties (what a character is like, and how they are, as the notes clearly show; leave out anything they don't):
- key "intent" or "commitment", with goal = the text of one of their recorded goals: intent is who the goal is good for, -3 harms others … +3 helps others (0 self-serving or neutral); commitment is how hard they push for it, 0-3.
- a disposition (${DISPOSITIONS.join(", ")}), -3 … +3: what they're like underneath (compassion: cruel -3 … kind +3; honesty: deceitful … honest; boldness: timid … daring; temper: calm … volatile; pride: humble … proud; greed: content … grasping; curiosity: incurious … prying; discipline: impulsive … controlled; faith: cynical … devout; fidelity: fickle … steadfast). goal is "".
- a state (${STATES.join(", ")}), as of the end of the notes: confidence -3 … +3; fear, anger, hope, strain 0-3. goal is "".
pair_weights: how one character stands toward another (one direction), as the notes show: warmth -3 hostile … +3 affectionate; trust -3 … +3; respect -3 … +3; fear 0-3 (how afraid "from" is of "to"); debt 0-3 (how much "from" owes "to"); loyalty 0-3 (how bound "from" is to "to", a person or faction).
For both: a quote as evidence, as for everything else. Never infer a disposition from one act alone; a state needs the notes to show it at the end. Blanks are better than guesses.`;

export const ENTITY_RULES = `EVIDENCE: every entity update, relationship and the party location carries evidence: a short exact quote (under 20 words) copied word for word from the notes that supports it. If nothing in the notes supports a change, don't propose it.

entity_updates
- For characters, places, items and factions (new or existing) whose details the notes state or clearly show. One entry per entity; only fields that are new or changed compared with the current state below.
- status: for characters alive / dead / missing / captured / transformed; for places intact / destroyed / occupied / abandoned; for items intact / used / broken / lost; otherwise "".
- attitude: the entity's attitude toward the party (hostile / unfriendly / indifferent / friendly / helpful), otherwise "".
- importance: major / minor / walk-on, otherwise "".
- last_known_location: the name of the place the party last saw them (characters) or last saw it (items), otherwise "".
- parent_location: for places only, the larger place they are inside (the Tannery is inside Duradan), otherwise "".
- traits: a list of {key, value} pairs, only for what the notes state. Use the field that fits: what a character can do (spells, wildshape, special powers) goes in abilities; known_properties and true_properties are for items only. health is one of healthy / wounded / bloodied / critical / unconscious, as of the end of the notes. conditions are short-term game conditions (charmed, frightened, poisoned, exhaustion 2…); lasting story afflictions are threads, not conditions. Never record numbers from a character sheet (ability scores, AC, hit points). Keys: ${EXTRACTABLE_TRAITS.join(", ")}. For ${[...LIST_TRAITS].join(", ")}, separate several values with "; ". alignment must be one of: lawful good, neutral good, chaotic good, lawful neutral, true neutral, chaotic neutral, lawful evil, neutral evil, chaotic evil, unaligned. Only set alignment, age, motives or secrets when the notes make them clear; blanks are better than guesses.
- Any place used as a location must exist as an entity or be added in new_entities.

relations
- Relationships the notes state or clearly show, between named entities: from, type, to, note (a few words of context), strength from -3 (strongly negative) to +3 (strongly positive), 0 if neutral.
- type is one of: ${RELATION_TYPES.join(", ")}.
- Some types only connect certain kinds of thing: ${LAW_TEXT}. "leads" means is the leader of a faction or group; guiding, escorting or taking someone somewhere is an event for a thread, not a relationship.
- Include possession (a character "holds" an item), membership ("member_of" a faction), service and hunting. Skip ones already listed below unless they changed.

party_location
- The name of the place where the party is at the end of the notes, otherwise "".`;

// Current entity state, compact, so the model only proposes what's new or changed.
export async function entityStateText(campaignId: number) {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const relations = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId));
  const name = new Map(entities.map((e) => [e.id, e.name]));

  const entityLines = entities.map((e) => {
    const facts = [
      e.status && `status ${e.status}`,
      e.attitude && `attitude ${e.attitude}`,
      e.lastKnownLocationId && `last seen at ${name.get(e.lastKnownLocationId)}`,
      e.parentId && `${e.type === "location" ? "inside" : "part of"} ${name.get(e.parentId)}`,
      ...Object.entries(e.traits)
        .filter(([k]) => !e.fieldMeta[`traits.${k}`]?.secret)
        .filter(([, v]) => hasTrait(v))
        .map(([k, v]) => `${k} ${traitText(k, v, true)}`),
    ].filter(Boolean);
    return `- ${e.name} (${e.type})${e.aliases.length ? ` aka ${e.aliases.join(", ")}` : ""}: ${e.description}${facts.length ? ` [${facts.join("; ")}]` : ""}`;
  });
  const relationLines = relations
    .filter((r) => !r.secret)
    .map((r) => `- ${name.get(r.fromEntityId)} ${r.type} ${name.get(r.toEntityId)}${r.note ? ` (${r.note})` : ""}`);
  const party = campaign?.partyLocationId ? name.get(campaign.partyLocationId) : null;
  const pairs = await db.select().from(schema.pairWeights).where(eq(schema.pairWeights.campaignId, campaignId));
  const pairLines = pairs
    .map((r) => {
      const ws = PAIR_WEIGHTS.filter((w) => r[w] != null).map((w) => `${w} ${r[w]! > 0 ? "+" : ""}${r[w]}`);
      return ws.length ? `- ${name.get(r.fromEntityId)} → ${name.get(r.toEntityId)}: ${ws.join(", ")}` : "";
    })
    .filter(Boolean);

  return `EXISTING ENTITIES
${entityLines.join("\n") || "(none yet)"}

EXISTING RELATIONSHIPS
${relationLines.join("\n") || "(none yet)"}
${pairLines.length ? `\nHOW THEY STAND (recorded weights)\n${pairLines.join("\n")}\n` : ""}
PARTY LOCATION: ${party ?? "(unknown)"}`;
}

export interface EntityApplyResult {
  updated: number;
  relations: number;
  party: boolean;
  warnings: string[];
  conflicts: { entity: string; proposals: FieldProposal[] }[]; // extraction disagreed with DM entries
}

const norm = (s: string) => s.trim().toLowerCase();

// Applies extracted entity changes as source "extracted". Writes that would overwrite the
// DM's own values come back as conflicts instead.
export async function applyEntityChanges(
  campaignId: number,
  sessionId: number | null,
  changes: { entity_updates: EntityUpdate[]; relations: RelationChange[]; party_location: string | null },
  batch?: string,
  source: "dm" | "extracted" = "extracted", // "dm" when the GM explicitly confirmed these
): Promise<EntityApplyResult> {
  const result: EntityApplyResult = { updated: 0, relations: 0, party: false, warnings: [], conflicts: [] };
  const opts = { source, sessionId, batch };
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const byName = new Map<string, (typeof entities)[number]>();
  for (const e of entities) for (const n of [e.name, ...e.aliases]) byName.set(norm(n), e);
  const find = (n: string) => byName.get(norm(n));
  const location = (n: string, why: string) => {
    if (!n.trim()) return undefined;
    const e = find(n);
    if (e?.type === "location") return e.id;
    result.warnings.push(`${why}: "${n}" isn't a known location, skipped`);
    return undefined;
  };

  for (const u of changes.entity_updates) {
    const e = find(u.name);
    if (!e) {
      result.warnings.push(`No entity named "${u.name}", update skipped`);
      continue;
    }
    const patch: EntityPatch = {};
    if (u.status) {
      if ((ENTITY_STATUSES[e.type] as readonly string[]).includes(u.status)) patch.status = u.status;
      else result.warnings.push(`${e.name}: "${u.status}" isn't a valid status for a ${e.type}, skipped`);
    }
    if (u.attitude && (e.type === "npc" || e.type === "faction")) patch.attitude = u.attitude;
    if (u.importance) patch.importance = u.importance;
    if (e.type !== "location") patch.lastKnownLocationId = location(u.last_known_location, `${e.name}'s last known location`);
    if (e.type === "location") patch.parentId = location(u.parent_location, `${e.name}'s parent location`);

    const traits: Record<string, unknown> = {};
    for (const { key, value } of u.traits) {
      if (!value.trim()) continue;
      const v = LIST_TRAITS.has(key) ? value.split(";").map((s) => s.trim()).filter(Boolean) : value.trim();
      if (TraitsSchema.safeParse({ [key]: v }).success) traits[key] = v;
      else result.warnings.push(`${e.name}: "${value}" isn't a valid ${key}, skipped`);
    }
    if (Object.keys(traits).length) patch.traits = traits as EntityTraits;

    // One change that breaks a rule (a wrong kind of place, say) is skipped with a warning; it
    // never stops the rest of the save.
    try {
      const r = await updateEntity(e.id, patch, opts);
      if (r.written.length) result.updated++;
      if (r.proposed.length) result.conflicts.push({ entity: e.name, proposals: r.proposed });
    } catch (err) {
      result.warnings.push(`${e.name}: skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  for (const rel of changes.relations) {
    const from = find(rel.from);
    const to = find(rel.to);
    if (!from || !to || from.id === to.id) {
      result.warnings.push(`Relationship ${rel.from} ${rel.type} ${rel.to} skipped (unknown entity)`);
      continue;
    }
    try {
      const r = await setRelation(campaignId, { fromEntityId: from.id, toEntityId: to.id, type: rel.type, note: rel.note, strength: rel.strength }, opts);
      if (r.written.length) result.relations++;
      if (r.proposed.length) result.conflicts.push({ entity: `${from.name} ${rel.type} ${to.name}`, proposals: r.proposed });
    } catch (err) {
      result.warnings.push(`Relationship ${from.name} ${rel.type} ${to.name} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (changes.party_location) {
    const id = location(changes.party_location, "Party location");
    if (id) {
      try {
        const r = await updateCampaign(campaignId, { partyLocationId: id }, opts);
        result.party = r.written.length > 0;
        if (r.proposed.length) result.conflicts.push({ entity: "Party location", proposals: r.proposed });
      } catch (err) {
        result.warnings.push(`Party location skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/**
 * Applies proposed sub-properties and pair weights, through the provenance rules (setSubProperty,
 * setPairWeights). A goal is found by its text. `blanksOnly` (the inference pass) never changes a
 * value someone already set.
 */
export async function applyPropertyChanges(
  campaignId: number,
  sessionId: number | null,
  changes: { subs: SubChange[]; weights: WeightChange[] },
  batch: string | undefined,
  source: "dm" | "extracted" | "inferred" | "table",
  blanksOnly = false,
) {
  const result = { written: 0, warnings: [] as string[] };
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const find = (n: string) => entities.find((e) => [e.name, ...e.aliases].some((a) => norm(a) === norm(n)));
  const opts = { source, sessionId, batch };
  for (const c of changes.subs) {
    if (!c.path && !(SUB_KEYS as readonly string[]).includes(c.key)) {
      result.warnings.push(`"${c.key}" isn't something Loom records; skipped for ${c.name}`);
      continue;
    }
    const e = find(c.name);
    if (!e) {
      result.warnings.push(`No one named "${c.name}"; ${c.key} skipped`);
      continue;
    }
    let path: string;
    if (c.path) path = c.path;
    else if (c.key === "intent" || c.key === "commitment") {
      const goals = ((e.traits as EntityTraits).goals ?? []) as { id?: string; text: string }[];
      const g = goals.find((x) => norm(x.text) === norm(c.goal)) ?? goals.find((x) => norm(x.text).includes(norm(c.goal)) || norm(c.goal).includes(norm(x.text)));
      if (!g?.id) {
        result.warnings.push(`${e.name} has no recorded goal "${c.goal}"; ${c.key} skipped`);
        continue;
      }
      path = `goals.${g.id}.${c.key}`;
    } else path = `${(DISPOSITIONS as readonly string[]).includes(c.key) ? "disposition" : "state"}.${c.key}`;
    const current = path.split(".").reduce<unknown>((o, k) => (Array.isArray(o) ? o.find((x) => x?.id === k) : (o as Record<string, unknown> | undefined)?.[k]), e.traits);
    if (blanksOnly && current != null) continue;
    try {
      result.written += (await setSubProperty(e.id, path, c.value, { ...opts, note: c.because })).written.length;
    } catch (err) {
      result.warnings.push(`${e.name} ${path}: ${(err as Error).message}`);
    }
  }
  const rows = await db.select().from(schema.pairWeights).where(eq(schema.pairWeights.campaignId, campaignId));
  for (const w of changes.weights) {
    if (!(PAIR_WEIGHTS as readonly string[]).includes(w.weight)) {
      result.warnings.push(`"${w.weight}" isn't a weight Loom records; skipped for ${w.from} → ${w.to}`);
      continue;
    }
    const [a, b] = [find(w.from), find(w.to)];
    if (!a || !b) {
      result.warnings.push(`"${w.from}" → "${w.to}": not both known; ${w.weight} skipped`);
      continue;
    }
    if (blanksOnly && rows.find((r) => r.fromEntityId === a.id && r.toEntityId === b.id)?.[w.weight as PairWeight] != null) continue;
    try {
      result.written += (await setPairWeights(campaignId, a.id, b.id, { [w.weight as PairWeight]: w.value }, { ...opts, note: w.because })).written.length;
    } catch (err) {
      result.warnings.push(`${a.name} → ${b.name} ${w.weight}: ${(err as Error).message}`);
    }
  }
  return result;
}
