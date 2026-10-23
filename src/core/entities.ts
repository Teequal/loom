import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import {
  ENTITY_STATUSES,
  type CampaignMechanic,
  type EntityTraits,
  type FieldMetaMap,
  type RelationType,
  type Source,
  TraitsSchema,
} from "./entity-fields";

// Writes to entities, relationships and the campaign, applying the provenance rule:
// the DM can always write; extraction writes only where the DM hasn't, and otherwise
// returns a proposal for the DM to accept. Extraction never clears a value.

export interface WriteOptions {
  source: Source;
  sessionId?: number | null;
  secret?: string[]; // fields (e.g. "actualLocationId", "traits.secrets") to mark GM-only
}

export interface Proposal {
  field: string;
  current: unknown;
  proposed: unknown;
}

export interface WriteResult {
  written: string[];
  proposed: Proposal[];
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Decides, field by field, what gets written and what becomes a proposal.
function planWrites(current: Record<string, unknown>, meta: FieldMetaMap, changes: Record<string, unknown>, opts: WriteOptions) {
  const apply: Record<string, unknown> = {};
  const nextMeta: FieldMetaMap = { ...meta };
  const result: WriteResult = { written: [], proposed: [] };
  const at = new Date().toISOString();

  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined || same(current[field], value)) continue;
    if (opts.source === "extracted") {
      if (isBlank(value)) continue; // blanks beat guesses: extraction never erases
      if (meta[field]?.source === "dm") {
        result.proposed.push({ field, current: current[field], proposed: value });
        continue;
      }
    }
    apply[field] = value;
    nextMeta[field] = {
      source: opts.source,
      sessionId: opts.sessionId ?? null,
      secret: opts.secret?.includes(field) ?? meta[field]?.secret ?? false,
      at,
    };
    result.written.push(field);
  }
  return { apply, nextMeta, result };
}

export interface EntityPatch {
  description?: string;
  aliases?: string[];
  status?: string | null;
  attitude?: (typeof schema.entities.$inferSelect)["attitude"];
  importance?: (typeof schema.entities.$inferSelect)["importance"];
  lastKnownLocationId?: number | null;
  actualLocationId?: number | null;
  parentLocationId?: number | null;
  traits?: EntityTraits;
}

const LOCATION_FIELDS = ["lastKnownLocationId", "actualLocationId", "parentLocationId"] as const;

export async function updateEntity(entityId: number, patch: EntityPatch, opts: WriteOptions): Promise<WriteResult> {
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId));
  if (!entity) throw new Error(`No entity with id ${entityId}`);

  if (patch.status != null && !(ENTITY_STATUSES[entity.type] as readonly string[]).includes(patch.status)) {
    throw new Error(`"${patch.status}" isn't a valid status for ${entity.name} (${entity.type.toUpperCase()}). Use: ${ENTITY_STATUSES[entity.type].join(", ")}`);
  }
  for (const f of LOCATION_FIELDS) {
    const id = patch[f];
    if (id == null) continue;
    const [loc] = await db.select().from(schema.entities).where(eq(schema.entities.id, id));
    if (!loc || loc.campaignId !== entity.campaignId || loc.type !== "location") {
      throw new Error(`${loc?.name ?? `Entity ${id}`} isn't a location in this campaign, so it can't be ${entity.name}'s ${f.replace("LocationId", "").replace(/([A-Z])/g, " $1").toLowerCase().trim()} location`);
    }
  }
  let traits: EntityTraits = {};
  if (patch.traits) {
    const parsed = TraitsSchema.safeParse(patch.traits);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = String(issue.path[0] ?? "trait");
      const allowed = "values" in issue && Array.isArray(issue.values) ? ` Use: ${issue.values.join(", ")}` : "";
      throw new Error(`"${String((patch.traits as Record<string, unknown>)[key])}" isn't a valid ${key.replace(/_/g, " ")}.${allowed}`);
    }
    traits = parsed.data;
  }

  // Flatten traits to "traits.<key>" so each attribute carries its own provenance.
  const { traits: _omit, ...columns } = patch;
  void _omit;
  const current: Record<string, unknown> = { ...entity };
  for (const [k, v] of Object.entries(entity.traits)) current[`traits.${k}`] = v;
  const changes: Record<string, unknown> = { ...columns };
  for (const [k, v] of Object.entries(traits)) changes[`traits.${k}`] = v;

  const { apply, nextMeta, result } = planWrites(current, entity.fieldMeta, changes, opts);
  if (result.written.length === 0) return result;

  const nextTraits: Record<string, unknown> = { ...entity.traits };
  const update: Record<string, unknown> = { fieldMeta: nextMeta };
  for (const [field, value] of Object.entries(apply)) {
    if (field.startsWith("traits.")) {
      const key = field.slice("traits.".length);
      if (isBlank(value)) delete nextTraits[key];
      else nextTraits[key] = value;
    } else update[field] = value;
  }
  update.traits = nextTraits;
  await db.update(schema.entities).set(update).where(eq(schema.entities.id, entityId));
  return result;
}

export interface RelationInput {
  fromEntityId: number;
  toEntityId: number;
  type: RelationType;
  note?: string;
  strength?: number; // -3 … +3
  secret?: boolean;
}

// Adds or updates the relationship identified by (from, to, type).
export async function setRelation(campaignId: number, input: RelationInput, opts: WriteOptions): Promise<WriteResult> {
  if (input.fromEntityId === input.toEntityId) throw new Error("A relationship needs two different entities");
  const strength = Math.max(-3, Math.min(3, Math.round(input.strength ?? 0)));
  const [existing] = await db
    .select()
    .from(schema.entityRelations)
    .where(
      and(
        eq(schema.entityRelations.fromEntityId, input.fromEntityId),
        eq(schema.entityRelations.toEntityId, input.toEntityId),
        eq(schema.entityRelations.type, input.type),
      ),
    );
  const label = `relation ${input.fromEntityId} ${input.type} ${input.toEntityId}`;

  if (!existing) {
    await db.insert(schema.entityRelations).values({
      campaignId,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      type: input.type,
      note: input.note ?? "",
      strength,
      secret: input.secret ?? false,
      sinceSessionId: opts.sessionId ?? null,
      source: opts.source,
    });
    return { written: [label], proposed: [] };
  }

  const next = { note: input.note ?? existing.note, strength: input.strength === undefined ? existing.strength : strength, secret: input.secret ?? existing.secret };
  if (same(next, { note: existing.note, strength: existing.strength, secret: existing.secret })) return { written: [], proposed: [] };
  if (opts.source === "extracted" && existing.source === "dm") {
    return { written: [], proposed: [{ field: label, current: { note: existing.note, strength: existing.strength }, proposed: next }] };
  }
  await db.update(schema.entityRelations).set({ ...next, source: opts.source }).where(eq(schema.entityRelations.id, existing.id));
  return { written: [label], proposed: [] };
}

export async function removeRelation(relationId: number) {
  await db.delete(schema.entityRelations).where(eq(schema.entityRelations.id, relationId));
}

export interface CampaignPatch {
  partyLocationId?: number | null;
  inGameDate?: string;
  tone?: string;
  mechanics?: CampaignMechanic[];
  safetyLines?: string[];
}

export async function updateCampaign(campaignId: number, patch: CampaignPatch, opts: WriteOptions): Promise<WriteResult> {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`No campaign with id ${campaignId}`);
  if (patch.partyLocationId != null) {
    const [loc] = await db.select().from(schema.entities).where(eq(schema.entities.id, patch.partyLocationId));
    if (!loc || loc.campaignId !== campaignId || loc.type !== "location") throw new Error(`Entity ${patch.partyLocationId} isn't a location in this campaign`);
  }
  const { apply, nextMeta, result } = planWrites({ ...campaign }, campaign.fieldMeta, { ...patch }, opts);
  if (result.written.length) await db.update(schema.campaigns).set({ ...apply, fieldMeta: nextMeta }).where(eq(schema.campaigns.id, campaignId));
  return result;
}

export interface ThreadPatch {
  deadline?: string;
  stakes?: string;
  secret?: boolean;
}

export async function updateThread(threadId: number, patch: ThreadPatch, opts: WriteOptions): Promise<WriteResult> {
  const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
  if (!thread) throw new Error(`No thread with id ${threadId}`);
  const { apply, nextMeta, result } = planWrites({ ...thread }, thread.fieldMeta, { ...patch }, opts);
  if (result.written.length) {
    await db.update(schema.threads).set({ ...apply, fieldMeta: nextMeta }).where(eq(schema.threads.id, threadId));
    await db.insert(schema.threadEvents).values({
      threadId,
      sessionId: opts.sessionId ?? null,
      change: "edited",
      note: `${opts.source === "dm" ? "GM" : "Extraction"} set ${result.written.join(", ")}`,
    });
  }
  return result;
}

// Is this location (or anything inside it) where the given place is? Walks parent links,
// so being in the Tannery counts as being in Duradan.
export async function isWithin(locationId: number, ancestorId: number) {
  let current: number | null = locationId;
  for (let hops = 0; current != null && hops < 20; hops++) {
    if (current === ancestorId) return true;
    const [row] = await db
      .select({ parent: schema.entities.parentLocationId })
      .from(schema.entities)
      .where(eq(schema.entities.id, current));
    current = row?.parent ?? null;
  }
  return false;
}
