import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { setRelation, updateCampaign, updateEntity, type EntityPatch, type Proposal as FieldProposal } from "./entities";
import {
  ATTITUDES,
  ENTITY_STATUSES,
  IMPORTANCE,
  LIST_TRAITS,
  RELATION_TYPES,
  TRAIT_KEYS,
  TraitsSchema,
  type EntityTraits,
} from "./entity-fields";
import { RELATION_LAWS } from "./rules";

// The entity side of extraction: field updates, relationships and where the party is.
// Shared by `recap` (alongside thread changes) and `enrich` (backfill from stored recaps).
// Everything is applied as source "extracted", so the DM's own entries are never overwritten.

// Traits extraction may propose. Settings the DM controls (possession: single or shared) are left out.
const EXTRACTABLE_TRAITS = TRAIT_KEYS.filter((k) => k !== "possession") as [string, ...string[]];

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
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("; ") : v}`),
    ].filter(Boolean);
    return `- ${e.name} (${e.type})${e.aliases.length ? ` aka ${e.aliases.join(", ")}` : ""}: ${e.description}${facts.length ? ` [${facts.join("; ")}]` : ""}`;
  });
  const relationLines = relations
    .filter((r) => !r.secret)
    .map((r) => `- ${name.get(r.fromEntityId)} ${r.type} ${name.get(r.toEntityId)}${r.note ? ` (${r.note})` : ""}`);
  const party = campaign?.partyLocationId ? name.get(campaign.partyLocationId) : null;

  return `EXISTING ENTITIES
${entityLines.join("\n") || "(none yet)"}

EXISTING RELATIONSHIPS
${relationLines.join("\n") || "(none yet)"}

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
