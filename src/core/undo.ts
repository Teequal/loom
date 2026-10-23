import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "./db/client";
import { RELATION_LAWS } from "./rules";

// Undo from the change log. Every write records what it was before; undo puts it back and marks
// the change as undone (history keeps it, so the record stays honest).

type Change = typeof schema.stateChanges.$inferSelect;
interface RelationSnapshot {
  from: number;
  to: number;
  type: string;
  note?: string;
  strength?: number;
  secret?: boolean;
  source?: "dm" | "extracted";
}

export async function recentBatches(campaignId: number, limit = 10) {
  const rows = await db
    .select()
    .from(schema.stateChanges)
    .where(eq(schema.stateChanges.campaignId, campaignId))
    .orderBy(desc(schema.stateChanges.id))
    .limit(500);
  const batches = new Map<string, Change[]>();
  for (const r of rows) {
    const key = r.batch ?? `#${r.id}`;
    batches.set(key, [...(batches.get(key) ?? []), r]);
  }
  return [...batches.entries()].slice(0, limit).map(([batch, changes]) => ({ batch, changes, undone: changes.every((c) => c.undoneAt) }));
}

export async function latestBatch(campaignId: number) {
  return (await recentBatches(campaignId, 50)).find((b) => !b.undone && !b.batch.startsWith("#"));
}

async function setField(c: Change, value: unknown) {
  const field = c.field;
  if (c.entityId != null && c.subject !== "campaign") {
    const [e] = await db.select().from(schema.entities).where(eq(schema.entities.id, c.entityId));
    if (!e) return;
    const meta = { ...e.fieldMeta };
    if (value == null) delete meta[field];
    if (field.startsWith("traits.")) {
      const traits = { ...(e.traits as Record<string, unknown>) };
      if (value == null || value === "") delete traits[field.slice(7)];
      else traits[field.slice(7)] = value;
      await db.update(schema.entities).set({ traits, fieldMeta: meta }).where(eq(schema.entities.id, e.id));
    } else {
      await db.update(schema.entities).set({ [field]: value ?? null, fieldMeta: meta }).where(eq(schema.entities.id, e.id));
    }
  } else if (c.subject === "campaign") {
    await db.update(schema.campaigns).set({ [field]: value ?? null }).where(eq(schema.campaigns.id, c.campaignId));
  } else if (c.threadId != null) {
    await db.update(schema.threads).set({ [field]: value ?? "" }).where(eq(schema.threads.id, c.threadId));
  }
}

async function deleteRelation(r: RelationSnapshot) {
  const both = RELATION_LAWS[r.type]?.symmetric;
  for (const [from, to] of both ? [[r.from, r.to], [r.to, r.from]] : [[r.from, r.to]]) {
    await db
      .delete(schema.entityRelations)
      .where(and(eq(schema.entityRelations.fromEntityId, from), eq(schema.entityRelations.toEntityId, to), eq(schema.entityRelations.type, r.type as never)));
  }
}

async function restoreRelation(campaignId: number, r: RelationSnapshot) {
  const both = RELATION_LAWS[r.type]?.symmetric;
  for (const [from, to] of both ? [[r.from, r.to], [r.to, r.from]] : [[r.from, r.to]]) {
    await db
      .insert(schema.entityRelations)
      .values({ campaignId, fromEntityId: from, toEntityId: to, type: r.type as never, note: r.note ?? "", strength: r.strength ?? 0, secret: r.secret ?? false, source: r.source ?? "dm" })
      .onConflictDoNothing();
  }
}

// Reverses one change. Returns a note when it couldn't be fully reversed.
async function reverse(c: Change): Promise<string | null> {
  const before = c.before as Record<string, unknown> | null;
  const after = c.after as Record<string, unknown> | null;
  switch (c.kind) {
    case "field":
      await setField(c, c.before);
      return null;
    case "created":
      if (c.entityId != null) await db.delete(schema.entities).where(eq(schema.entities.id, c.entityId));
      return null;
    case "relation-added":
      if (after?.from != null) await deleteRelation(after as unknown as RelationSnapshot);
      else return `can't undo "${c.subject}" (logged before undo existed)`;
      return null;
    case "relation-removed":
      if (before?.from != null) await restoreRelation(c.campaignId, before as unknown as RelationSnapshot);
      else return `can't restore "${c.subject}" (logged before undo existed)`;
      return null;
    case "relation-changed":
      if (before?.from != null) {
        const b = before as unknown as RelationSnapshot;
        await db
          .update(schema.entityRelations)
          .set({ note: b.note ?? "", strength: b.strength ?? 0, secret: b.secret ?? false })
          .where(and(eq(schema.entityRelations.fromEntityId, b.from), eq(schema.entityRelations.toEntityId, b.to), eq(schema.entityRelations.type, b.type as never)));
      }
      return null;
    case "thread-created":
      if (c.threadId != null) await db.delete(schema.threads).where(eq(schema.threads.id, c.threadId));
      return null;
    case "thread-updated":
      if (c.threadId != null && before) {
        await db
          .update(schema.threads)
          .set({ status: before.status as never, summary: String(before.summary ?? ""), lastTouchedSessionId: (before.lastTouchedSessionId as number | null) ?? null })
          .where(eq(schema.threads.id, c.threadId));
        if (after?.eventId != null) await db.delete(schema.threadEvents).where(eq(schema.threadEvents.id, Number(after.eventId)));
      }
      return null;
    case "link-added":
      if (after?.from != null) {
        await db.delete(schema.threadLinks).where(and(eq(schema.threadLinks.fromThreadId, Number(after.from)), eq(schema.threadLinks.toThreadId, Number(after.to))));
      }
      return null;
    case "moment-added":
      if (after?.momentId != null) await db.delete(schema.keyMoments).where(eq(schema.keyMoments.id, Number(after.momentId)));
      return null;
  }
}

// Has anything later (not undone) changed the same thing? Then undoing this would silently
// overwrite it.
async function laterChanges(c: Change) {
  const later = await db
    .select()
    .from(schema.stateChanges)
    .where(and(eq(schema.stateChanges.campaignId, c.campaignId), gt(schema.stateChanges.id, c.id), isNull(schema.stateChanges.undoneAt)));
  return later.filter((l) => l.batch !== c.batch && l.subject === c.subject && l.field === c.field);
}

export async function undoChanges(changes: Change[], opts: { force?: boolean } = {}) {
  const todo = changes.filter((c) => !c.undoneAt).sort((a, b) => b.id - a.id); // newest first
  const blocked: string[] = [];
  if (!opts.force) {
    for (const c of todo) {
      const later = await laterChanges(c);
      if (later.length) blocked.push(`${c.subject}${c.field ? ` · ${c.field}` : ""} was changed again later (change #${later[0].id})`);
    }
    if (blocked.length) return { undone: 0, notes: [], blocked };
  }
  const notes: string[] = [];
  let undone = 0;
  const now = new Date().toISOString();
  for (const c of todo) {
    const note = await reverse(c);
    if (note) notes.push(note);
    else undone++;
    await db.update(schema.stateChanges).set({ undoneAt: now }).where(eq(schema.stateChanges.id, c.id));
  }
  return { undone, notes, blocked };
}

export async function undoBatch(campaignId: number, batch: string, opts: { force?: boolean } = {}) {
  const rows = await db.select().from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId), eq(schema.stateChanges.batch, batch)));
  return { ...(await undoChanges(rows, opts)), total: rows.length };
}

export async function undoOne(campaignId: number, id: number, opts: { force?: boolean } = {}) {
  const rows = await db.select().from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId), eq(schema.stateChanges.id, id)));
  return { ...(await undoChanges(rows, opts)), total: rows.length };
}
