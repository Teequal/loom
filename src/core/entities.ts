import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "./db/client";
import {
  ENTITY_STATUSES,
  type CampaignMechanic,
  type EntityTraits,
  type FieldMetaMap,
  type RelationType,
  type Source,
  ID_LISTS,
  TraitsSchema,
} from "./entity-fields";
import { PAIR_WEIGHTS, type PairWeight } from "./db/schema";
import { checkValue, getPath, setPath, specOf, withIds, type EntityType } from "./sub-properties";
import { logChanges } from "./history";
import { OPPOSITE_TIES, RELATION_LAWS } from "./rules";

// Writes to entities, relationships and the campaign, applying the provenance rule:
// the DM can always write; extraction writes only where the DM hasn't, and otherwise
// returns a proposal for the DM to accept. Extraction never clears a value.

export interface WriteOptions {
  source: Source;
  sessionId?: number | null;
  secret?: string[]; // fields (e.g. "actualLocationId", "traits.secrets") to mark GM-only
  batch?: string; // groups changes for undo (a recap, an enrich, one command)
}

export interface Proposal {
  field: string;
  current: unknown;
  proposed: unknown;
}

export interface WriteResult {
  written: string[];
  proposed: Proposal[];
  notes?: string[]; // knock-on changes, e.g. the previous holder replaced
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
    // Only the DM writes freely: extraction, the table and inference fill blanks and propose
    // over the DM's own values, and never erase.
    if (opts.source !== "dm") {
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
  parentId?: number | null; // the place it's inside, the set it belongs to, the kind it is
  traits?: EntityTraits;
}

const LOCATION_FIELDS = ["lastKnownLocationId", "actualLocationId"] as const;

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
  // A parent is the same kind of thing: a place inside a place, an item in a set, an NPC in a
  // creature kind, a faction cell in a faction. No loops.
  if (patch.parentId != null) {
    const [parent] = await db.select().from(schema.entities).where(eq(schema.entities.id, patch.parentId));
    if (!parent || parent.campaignId !== entity.campaignId) throw new Error(`Entity ${patch.parentId} isn't in this campaign`);
    if (parent.type !== entity.type) throw new Error(`${entity.name} (${entity.type}) can't be part of ${parent.name} (${parent.type}); a parent is the same kind of thing`);
    if (parent.id === entity.id || (await isWithin(parent.id, entity.id))) throw new Error(`${parent.name} is already inside ${entity.name}; that would make a loop`);
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
    // Goals, beliefs and aims keep stable ids, so a sub-property of one can be found and undone.
    for (const [key, prefix] of Object.entries(ID_LISTS)) {
      const next = (traits as Record<string, unknown>)[key] as { id?: string; text: string }[] | undefined;
      if (next) (traits as Record<string, unknown>)[key] = withIds(next, (entity.traits as Record<string, unknown>)[key] as { id?: string; text: string }[] | undefined, prefix);
    }
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
  // A lost item has no holder: losing it ends whoever held it (logged, so undo restores both).
  if (entity.type === "item" && apply.status === "lost") {
    const held = await db.select().from(schema.entityRelations).where(and(eq(schema.entityRelations.toEntityId, entity.id), eq(schema.entityRelations.type, "holds")));
    for (const r of held) await removeRelation(r.id, opts.source, opts.batch);
  }
  await logChanges(
    Object.keys(apply).map((field) => ({
      campaignId: entity.campaignId,
      sessionId: opts.sessionId,
      subject: entity.name,
      entityId: entity.id,
      kind: "field" as const,
      field,
      before: current[field] ?? null,
      after: apply[field] ?? null,
      source: opts.source,
      batch: opts.batch,
    })),
  );
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

const verb = (t: string) => t.replace(/_/g, " ");

// Adds or updates the relationship identified by (from, to, type), obeying its law
// (rules.ts RELATION_LAWS): what it can connect, how many are allowed, and whether it runs both
// ways. The DM's writes move things (a new holder replaces the old one); extraction proposes
// instead of overriding the DM.
export async function setRelation(campaignId: number, input: RelationInput, opts: WriteOptions): Promise<WriteResult> {
  if (input.fromEntityId === input.toEntityId) throw new Error("A relationship needs two different entities");
  const all = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const from = all.find((e) => e.id === input.fromEntityId);
  const to = all.find((e) => e.id === input.toEntityId);
  if (!from || !to) throw new Error("Both entities must be in this campaign");
  const law = RELATION_LAWS[input.type] ?? {};
  if (law.from && !law.from.includes(from.type)) throw new Error(`${from.name} (${from.type}) can't be the one who ${verb(input.type)} something`);
  if (law.to && !law.to.includes(to.type)) throw new Error(`"${verb(input.type)}" can't point at ${to.name} (${to.type}); it needs ${law.to.join(" or ")}`);

  const notes: string[] = [];
  const related = async (where: ReturnType<typeof and>) => db.select().from(schema.entityRelations).where(where);

  // Possession across a set: you can't hold the set while someone else holds a piece of it, or
  // a piece while someone else holds the whole set.
  if (input.type === "holds") {
    const byId = new Map(all.map((e) => [e.id, e]));
    const ancestors: number[] = [];
    for (let cur = to.parentId, hops = 0; cur != null && hops < 20; cur = byId.get(cur)?.parentId ?? null, hops++) ancestors.push(cur);
    const descendants = new Set<number>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of all) {
        if (e.parentId != null && (e.parentId === to.id || descendants.has(e.parentId)) && !descendants.has(e.id)) {
          descendants.add(e.id);
          grew = true;
        }
      }
    }
    const family = [...ancestors, ...descendants];
    if (family.length) {
      const others = (await related(and(eq(schema.entityRelations.type, "holds"), inArray(schema.entityRelations.toEntityId, family)))).filter(
        (r) => r.fromEntityId !== from.id,
      );
      if (others.length) {
        const r = others[0];
        const msg = `${byId.get(r.fromEntityId)?.name} holds ${byId.get(r.toEntityId)?.name}, which is ${ancestors.includes(r.toEntityId) ? "the set" : "part of"} ${to.name}${ancestors.includes(r.toEntityId) ? " belongs to" : ""}; hand that over first`;
        if (opts.source === "extracted") return { written: [], proposed: [{ field: `${from.name} holds ${to.name}`, current: msg, proposed: "new holder" }] };
        throw new Error(msg);
      }
    }
  }

  // Cardinality: the old holder, leader or location gives way to the new one.
  const shared = (to.traits as EntityTraits).possession === "shared";
  const clash =
    law.cardinality === "one-per-target" && !shared
      ? (await related(and(eq(schema.entityRelations.type, input.type), eq(schema.entityRelations.toEntityId, to.id)))).filter((r) => r.fromEntityId !== from.id)
      : law.cardinality === "one-per-source"
        ? (await related(and(eq(schema.entityRelations.type, input.type), eq(schema.entityRelations.fromEntityId, from.id)))).filter((r) => r.toEntityId !== to.id)
        : [];
  if (clash.length) {
    const nameOf = (id: number) => all.find((e) => e.id === id)?.name ?? `#${id}`;
    if (opts.source === "extracted" && clash.some((r) => r.source === "dm")) {
      const r = clash.find((x) => x.source === "dm")!;
      return { written: [], proposed: [{ field: `${from.name} ${verb(input.type)} ${to.name}`, current: `${nameOf(r.fromEntityId)} ${verb(input.type)} ${nameOf(r.toEntityId)}`, proposed: `${from.name} ${verb(input.type)} ${to.name}` }] };
    }
    for (const r of clash) {
      await db.delete(schema.entityRelations).where(eq(schema.entityRelations.id, r.id));
      const subject = `${nameOf(r.fromEntityId)} ${verb(input.type)} ${nameOf(r.toEntityId)}`;
      await logChanges([{ campaignId, sessionId: opts.sessionId, subject, entityId: r.fromEntityId, kind: "relation-removed", field: input.type, before: { from: r.fromEntityId, to: r.toEntityId, type: r.type, note: r.note, strength: r.strength, secret: r.secret, source: r.source }, after: null, source: opts.source, batch: opts.batch }]);
      notes.push(`replaces: ${subject}`);
    }
  }

  // A tie and its opposite can't both hold: enemies who become allies stop being enemies. Two-way
  // ties are matched in either direction; feelings only in the same direction.
  const opposite = OPPOSITE_TIES[input.type] ?? [];
  if (opposite.length) {
    const pair = or(
      and(eq(schema.entityRelations.fromEntityId, from.id), eq(schema.entityRelations.toEntityId, to.id)),
      and(eq(schema.entityRelations.fromEntityId, to.id), eq(schema.entityRelations.toEntityId, from.id)),
    );
    const gone = (await related(and(inArray(schema.entityRelations.type, opposite as RelationType[]), pair))).filter((r) => r.fromEntityId === from.id || RELATION_LAWS[r.type]?.symmetric);
    if (gone.length && opts.source === "extracted" && gone.some((r) => r.source === "dm")) {
      const r = gone.find((x) => x.source === "dm")!;
      return { written: [], proposed: [{ field: `${from.name} ${verb(input.type)} ${to.name}`, current: `${r.type} (your entry)`, proposed: input.type }] };
    }
    const nameOf = (id: number) => all.find((e) => e.id === id)?.name ?? `#${id}`;
    for (const r of gone) {
      await db.delete(schema.entityRelations).where(eq(schema.entityRelations.id, r.id));
      const subject = `${nameOf(r.fromEntityId)} ${verb(r.type)} ${nameOf(r.toEntityId)}`;
      await logChanges([{ campaignId, sessionId: opts.sessionId, subject, entityId: r.fromEntityId, kind: "relation-removed", field: r.type, before: { from: r.fromEntityId, to: r.toEntityId, type: r.type, note: r.note, strength: r.strength, secret: r.secret, source: r.source }, after: { becameType: input.type }, source: opts.source, batch: opts.batch }]);
      if (r.fromEntityId === from.id) notes.push(`no longer: ${subject}`);
    }
  }

  const result = await upsertRelation(campaignId, input, opts, `${from.name} ${verb(input.type)} ${to.name}`);
  result.notes = [...notes, ...(result.notes ?? [])];

  // Someone holding a lost item has found it.
  if (input.type === "holds" && result.written.length && to.status === "lost") {
    const found = await updateEntity(to.id, { status: "intact" }, opts);
    if (found.written.length) result.notes.push(`${to.name} is no longer lost`);
  }

  // Two-way relationships are recorded both ways.
  if (law.symmetric && result.written.length) {
    const back = await upsertRelation(campaignId, { ...input, fromEntityId: input.toEntityId, toEntityId: input.fromEntityId }, opts, `${to.name} ${verb(input.type)} ${from.name}`);
    if (back.written.length) result.notes.push(`also recorded: ${to.name} ${verb(input.type)} ${from.name}`);
  }
  return result;
}

async function upsertRelation(campaignId: number, input: RelationInput, opts: WriteOptions, subject: string): Promise<WriteResult> {
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
    await logChanges([{ campaignId, sessionId: opts.sessionId, subject, entityId: input.fromEntityId, kind: "relation-added", field: input.type, before: null, after: { from: input.fromEntityId, to: input.toEntityId, type: input.type, note: input.note ?? "", strength }, source: opts.source, batch: opts.batch }]);
    return { written: [label], proposed: [] };
  }

  const next = { note: input.note ?? existing.note, strength: input.strength === undefined ? existing.strength : strength, secret: input.secret ?? existing.secret };
  if (same(next, { note: existing.note, strength: existing.strength, secret: existing.secret })) return { written: [], proposed: [] };
  if (opts.source === "extracted" && existing.source === "dm") {
    return { written: [], proposed: [{ field: label, current: { note: existing.note, strength: existing.strength }, proposed: next }] };
  }
  await db.update(schema.entityRelations).set({ ...next, source: opts.source }).where(eq(schema.entityRelations.id, existing.id));
  await logChanges([{ campaignId, sessionId: opts.sessionId, subject, entityId: input.fromEntityId, kind: "relation-changed", field: input.type, before: { from: existing.fromEntityId, to: existing.toEntityId, type: existing.type, note: existing.note, strength: existing.strength, secret: existing.secret }, after: { from: existing.fromEntityId, to: existing.toEntityId, type: existing.type, ...next }, source: opts.source, batch: opts.batch }]);
  return { written: [label], proposed: [] };
}

// Removes a relationship; a two-way one is removed in both directions.
export async function removeRelation(relationId: number, source: Source = "dm", batch?: string) {
  const [rel] = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.id, relationId));
  if (!rel) return;
  await db.delete(schema.entityRelations).where(eq(schema.entityRelations.id, relationId));
  const ents = await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(inArray(schema.entities.id, [rel.fromEntityId, rel.toEntityId]));
  const n = (id: number) => ents.find((e) => e.id === id)?.name ?? `#${id}`;
  await logChanges([{ campaignId: rel.campaignId, subject: `${n(rel.fromEntityId)} ${verb(rel.type)} ${n(rel.toEntityId)}`, entityId: rel.fromEntityId, kind: "relation-removed", field: rel.type, before: { from: rel.fromEntityId, to: rel.toEntityId, type: rel.type, note: rel.note, strength: rel.strength, secret: rel.secret, source: rel.source }, after: null, source, batch }]);
  if (RELATION_LAWS[rel.type]?.symmetric) {
    await db
      .delete(schema.entityRelations)
      .where(
        and(
          eq(schema.entityRelations.fromEntityId, rel.toEntityId),
          eq(schema.entityRelations.toEntityId, rel.fromEntityId),
          eq(schema.entityRelations.type, rel.type),
        ),
      );
  }
}

export interface CampaignPatch {
  partyLocationId?: number | null;
  inGameDate?: string;
  tone?: string;
  direction?: string;
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
  if (result.written.length) {
    await db.update(schema.campaigns).set({ ...apply, fieldMeta: nextMeta }).where(eq(schema.campaigns.id, campaignId));
    const current = campaign as Record<string, unknown>;
    await logChanges(Object.keys(apply).map((field) => ({ campaignId, sessionId: opts.sessionId, subject: "campaign", kind: "field" as const, field, before: current[field] ?? null, after: apply[field] ?? null, source: opts.source, batch: opts.batch })));
  }
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
    const current = thread as Record<string, unknown>;
    await logChanges(Object.keys(apply).map((field) => ({ campaignId: thread.campaignId, sessionId: opts.sessionId, subject: thread.title, threadId, kind: "field" as const, field, before: current[field] ?? null, after: apply[field] ?? null, source: opts.source, batch: opts.batch })));
    await db.insert(schema.threadEvents).values({
      threadId,
      sessionId: opts.sessionId ?? null,
      change: "edited",
      note: `${opts.source === "dm" ? "GM" : "Extraction"} set ${result.written.join(", ")}`,
    });
  }
  return result;
}

// Is this entity inside (or part of) the given one? Walks parent links, so being in the Tannery
// counts as being in Duradan, and the Monk figurine is part of the figurine set.
export async function isWithin(entityId: number, ancestorId: number) {
  let current: number | null = entityId;
  for (let hops = 0; current != null && hops < 20; hops++) {
    if (current === ancestorId) return true;
    const [row] = await db
      .select({ parent: schema.entities.parentId })
      .from(schema.entities)
      .where(eq(schema.entities.id, current));
    current = row?.parent ?? null;
  }
  return false;
}

// Two records turned out to be one character ("the mysterious guard" was Vex'ahlia all along).
// The duplicate's name and aliases become aliases, its threads, relationships, moments and rules
// move over, and the duplicate is deleted. Not undoable: the duplicate's row is gone.
// `secret`: the players don't know they're the same. Threads stay unlinked from the real record (a
// prompt would show "Involves: Vex'ahlia" on the mystery), and the identity becomes a GM-only secret.
export async function mergeEntities(campaignId: number, fromId: number, intoId: number, opts: { secret?: boolean } = {}) {
  if (fromId === intoId) throw new Error("That's the same record.");
  const [from] = await db.select().from(schema.entities).where(and(eq(schema.entities.id, fromId), eq(schema.entities.campaignId, campaignId)));
  const [into] = await db.select().from(schema.entities).where(and(eq(schema.entities.id, intoId), eq(schema.entities.campaignId, campaignId)));
  if (!from || !into) throw new Error("Both records must be in this campaign.");
  if (from.type !== into.type) throw new Error(`${from.name} is ${from.type === "pc" ? "a PC" : `a ${from.type}`} and ${into.name} is ${into.type === "pc" ? "a PC" : `a ${into.type}`}; only records of the same type can merge.`);

  const moved = { threads: 0, relations: 0, moments: 0 };
  // Threads: move links, dropping any the survivor already has.
  const has = new Set((await db.select().from(schema.threadEntities).where(eq(schema.threadEntities.entityId, intoId))).map((r) => r.threadId));
  for (const r of await db.select().from(schema.threadEntities).where(eq(schema.threadEntities.entityId, fromId))) {
    if (has.has(r.threadId) || opts.secret) continue;
    await db.insert(schema.threadEntities).values({ ...r, entityId: intoId });
    moved.threads++;
  }
  // Relationships: repoint both ends, skipping self-links and ones the survivor already has.
  const existing = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId));
  const key = (a: number, b: number, t: string) => `${a}:${b}:${t}`;
  const seen = new Set(existing.filter((r) => r.fromEntityId !== fromId && r.toEntityId !== fromId).map((r) => key(r.fromEntityId, r.toEntityId, r.type)));
  for (const r of existing.filter((r) => r.fromEntityId === fromId || r.toEntityId === fromId)) {
    const a = r.fromEntityId === fromId ? intoId : r.fromEntityId;
    const b = r.toEntityId === fromId ? intoId : r.toEntityId;
    if (a === b || seen.has(key(a, b, r.type))) continue;
    seen.add(key(a, b, r.type));
    await db.update(schema.entityRelations).set({ fromEntityId: a, toEntityId: b }).where(eq(schema.entityRelations.id, r.id));
    moved.relations++;
  }
  for (const m of await db.select().from(schema.keyMoments).where(eq(schema.keyMoments.campaignId, campaignId))) {
    if (!m.entityIds.includes(fromId)) continue;
    await db.update(schema.keyMoments).set({ entityIds: [...new Set(m.entityIds.map((id) => (id === fromId ? intoId : id)))] }).where(eq(schema.keyMoments.id, m.id));
    moved.moments++;
  }
  await db.update(schema.effects).set({ sourceEntityId: intoId }).where(eq(schema.effects.sourceEntityId, fromId));
  for (const col of ["parentId", "lastKnownLocationId", "actualLocationId"] as const) {
    await db.update(schema.entities).set({ [col]: intoId }).where(eq(schema.entities[col], fromId));
  }

  // The survivor learns the duplicate's names, and its description if it had none.
  const aliases = [...new Set([...into.aliases, from.name, ...from.aliases])].filter((a) => a !== into.name);
  const traits = into.traits as EntityTraits;
  const identity = `Secretly also "${from.name}"${from.description ? `: ${from.description}` : ""} The players don't know.`;
  const result = await updateEntity(
    intoId,
    {
      aliases,
      ...(!into.description && from.description && !opts.secret ? { description: from.description } : {}),
      ...(opts.secret ? { traits: { secrets: [...(traits.secrets ?? []), identity] } } : {}),
    },
    { source: "dm", ...(opts.secret ? { secret: ["traits.secrets"] } : {}) },
  );
  await db.delete(schema.entities).where(eq(schema.entities.id, fromId));
  await logChanges([{ campaignId, subject: into.name, entityId: intoId, kind: "field", field: "merged", before: from.name, after: into.name, source: "dm" }]);
  return { from, into, moved, notes: result.notes ?? [], keptDescription: from.description && into.description && !opts.secret ? from.description : null };
}

/**
 * Sets one sub-property ("disposition.boldness", "goals.g2.intent", "state.anger") with its own
 * provenance and history, under the usual rule: the DM always writes; extraction, the table and
 * inference fill blanks and propose over the DM's value. null clears it (the DM only).
 */
export async function setSubProperty(entityId: number, path: string, value: unknown, opts: WriteOptions): Promise<WriteResult> {
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId));
  if (!entity) throw new Error(`No entity with id ${entityId}`);
  const spec = specOf(path);
  if (!spec) throw new Error(`"${path}" isn't a known property`);
  const problem = checkValue(spec, value, entity.type as EntityType);
  if (problem) throw new Error(problem);
  const traits = (entity.traits ?? {}) as Record<string, unknown>;
  // A list item ("goals.g2") has to exist before a property of it can be set.
  if (path.split(".").length > 2 && getPath(traits, path.split(".").slice(0, 2).join(".")) == null) throw new Error(`${entity.name} has no ${path.split(".").slice(0, 2).join(" ")}`);
  const field = `traits.${path}`;
  const { apply, nextMeta, result } = planWrites({ [field]: getPath(traits, path) }, entity.fieldMeta, { [field]: value }, opts);
  if (!(field in apply)) return result;
  const next = setPath(traits, path, value);
  if (!next) throw new Error(`${entity.name} has no ${path}`);
  if (TraitsSchema.safeParse(next).success === false) throw new Error(`"${String(value)}" doesn't fit ${path}`);
  await db.update(schema.entities).set({ traits: next as EntityTraits, fieldMeta: nextMeta }).where(eq(schema.entities.id, entityId));
  await logChanges([{ campaignId: entity.campaignId, sessionId: opts.sessionId, subject: entity.name, entityId: entity.id, kind: "field", field, before: getPath(traits, path) ?? null, after: value ?? null, source: opts.source, batch: opts.batch }]);
  return result;
}

/**
 * Sets how A stands toward B (warmth, trust, fear, respect, debt, loyalty), one direction of the
 * pair, each weight with its own provenance and history. Same rule as everything else: the DM
 * always writes; other sources fill blanks and propose over the DM's values.
 */
export async function setPairWeights(campaignId: number, fromEntityId: number, toEntityId: number, weights: Partial<Record<PairWeight, number | null>>, opts: WriteOptions): Promise<WriteResult> {
  if (fromEntityId === toEntityId) throw new Error("Weights are between two different characters");
  const ents = await db.select().from(schema.entities).where(and(eq(schema.entities.campaignId, campaignId), inArray(schema.entities.id, [fromEntityId, toEntityId])));
  const from = ents.find((e) => e.id === fromEntityId);
  const to = ents.find((e) => e.id === toEntityId);
  if (!from || !to) throw new Error("Both must be in this campaign");
  for (const [w, v] of Object.entries(weights)) {
    if (!PAIR_WEIGHTS.includes(w as PairWeight)) throw new Error(`"${w}" isn't a weight (${PAIR_WEIGHTS.join(", ")})`);
    const [lo, hi] = w === "fear" || w === "debt" || w === "loyalty" ? [0, 3] : [-3, 3];
    if (v != null && !(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`${w} is a whole number from ${lo} to ${hi}`);
  }
  const [row] = await db.select().from(schema.pairWeights).where(and(eq(schema.pairWeights.fromEntityId, fromEntityId), eq(schema.pairWeights.toEntityId, toEntityId)));
  const current: Record<string, unknown> = Object.fromEntries(PAIR_WEIGHTS.map((w) => [w, row?.[w] ?? null]));
  const { apply, nextMeta, result } = planWrites(current, row?.fieldMeta ?? {}, weights, opts);
  if (!Object.keys(apply).length) return result;
  const values = Object.fromEntries(Object.entries(apply).map(([w, v]) => [w, v ?? null]));
  if (row) await db.update(schema.pairWeights).set({ ...values, fieldMeta: nextMeta }).where(eq(schema.pairWeights.id, row.id));
  else await db.insert(schema.pairWeights).values({ campaignId, fromEntityId, toEntityId, ...values, fieldMeta: nextMeta });
  await logChanges(
    Object.entries(apply).map(([w, v]) => ({ campaignId, sessionId: opts.sessionId, subject: `${from.name} → ${to.name}`, entityId: fromEntityId, kind: "field" as const, field: `pair.${toEntityId}.${w}`, before: current[w] ?? null, after: v ?? null, source: opts.source, batch: opts.batch })),
  );
  return result;
}
