// Copies a campaign: its world (entities, relationships, threads and their history and links, key
// moments, house rules, players, sessions and notes), under a new name. The table log, change log,
// embeddings and call logs aren't copied: the copy starts with a clean history.
// Run: npx tsx --env-file=.env scripts/copy-campaign.ts <campaignId> "<new name>"
import { eq, inArray } from "drizzle-orm";
import { db, initDb, schema } from "../src/core/db/client";
import type { FieldMetaMap } from "../src/core/entity-fields";

(async () => {
  await initDb();
  const [from, name] = [Number(process.argv[2]), process.argv[3]];
  if (!from || !name) throw new Error('Usage: copy-campaign.ts <campaignId> "<new name>"');
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, from));
  if (!camp) throw new Error(`No campaign ${from}`);

  const [sessions, entities, relations, threads, moments, effects, players] = await Promise.all([
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, from)),
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, from)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, from)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, from)),
    db.select().from(schema.keyMoments).where(eq(schema.keyMoments.campaignId, from)),
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, from)),
    db.select().from(schema.players).where(eq(schema.players.campaignId, from)),
  ]);
  const tids = threads.map((t) => t.id);
  const [threadEntities, threadLinks, threadEvents] = tids.length
    ? await Promise.all([
        db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, tids)),
        db.select().from(schema.threadLinks).where(inArray(schema.threadLinks.fromThreadId, tids)),
        db.select().from(schema.threadEvents).where(inArray(schema.threadEvents.threadId, tids)),
      ])
    : [[], [], []];

  const sMap = new Map<number, number>();
  const eMap = new Map<number, number>();
  const tMap = new Map<number, number>();
  const pMap = new Map<number, number>();
  const s = (id: number | null) => (id == null ? null : (sMap.get(id) ?? null));
  const e = (id: number | null) => (id == null ? null : (eMap.get(id) ?? null));
  const meta = (fm: FieldMetaMap) => Object.fromEntries(Object.entries(fm ?? {}).map(([k, m]) => [k, { ...m, sessionId: s(m.sessionId ?? null) }]));

  const { id: _c, createdAt: _cc, ...campRow } = camp;
  void [_c, _cc];
  const [copy] = await db.insert(schema.campaigns).values({ ...campRow, name, partyLocationId: null }).returning();
  const to = copy.id;

  for (const p of players) {
    const { id, createdAt: _x, ...row } = p;
    void _x;
    const [n] = await db.insert(schema.players).values({ ...row, campaignId: to }).returning();
    pMap.set(id, n.id);
  }
  for (const x of sessions) {
    const { id, createdAt: _x, ...row } = x;
    void _x;
    const [n] = await db.insert(schema.sessions).values({ ...row, campaignId: to }).returning();
    sMap.set(id, n.id);
  }
  // Entities in two passes: rows first, then the references between them.
  for (const x of entities) {
    const { id, createdAt: _x, ...row } = x;
    void _x;
    const [n] = await db
      .insert(schema.entities)
      .values({ ...row, campaignId: to, parentId: null, parentLocationId: null, lastKnownLocationId: null, actualLocationId: null, playerId: x.playerId != null ? (pMap.get(x.playerId) ?? null) : null, fieldMeta: meta(x.fieldMeta) })
      .returning();
    eMap.set(id, n.id);
  }
  for (const x of entities) {
    await db
      .update(schema.entities)
      .set({ parentId: e(x.parentId), parentLocationId: e(x.parentLocationId), lastKnownLocationId: e(x.lastKnownLocationId), actualLocationId: e(x.actualLocationId) })
      .where(eq(schema.entities.id, eMap.get(x.id)!));
  }
  await db.update(schema.campaigns).set({ partyLocationId: e(camp.partyLocationId) }).where(eq(schema.campaigns.id, to));
  for (const r of relations) {
    const { id: _i, createdAt: _x, ...row } = r;
    void [_i, _x];
    await db.insert(schema.entityRelations).values({ ...row, campaignId: to, fromEntityId: e(r.fromEntityId)!, toEntityId: e(r.toEntityId)!, sinceSessionId: s(r.sinceSessionId) });
  }
  for (const t of threads) {
    const { id, createdAt: _x, ...row } = t;
    void _x;
    const [n] = await db.insert(schema.threads).values({ ...row, campaignId: to, firstSeenSessionId: s(t.firstSeenSessionId), lastTouchedSessionId: s(t.lastTouchedSessionId) }).returning();
    tMap.set(id, n.id);
  }
  for (const te of threadEntities) await db.insert(schema.threadEntities).values({ ...te, threadId: tMap.get(te.threadId)!, entityId: e(te.entityId)! });
  for (const tl of threadLinks) if (tMap.has(tl.toThreadId)) await db.insert(schema.threadLinks).values({ ...tl, fromThreadId: tMap.get(tl.fromThreadId)!, toThreadId: tMap.get(tl.toThreadId)! });
  for (const ev of threadEvents) {
    const { id: _i, createdAt: _x, ...row } = ev;
    void [_i, _x];
    await db.insert(schema.threadEvents).values({ ...row, threadId: tMap.get(ev.threadId)!, sessionId: s(ev.sessionId) });
  }
  for (const m of moments) {
    const { id: _i, createdAt: _x, ...row } = m;
    void [_i, _x];
    await db.insert(schema.keyMoments).values({ ...row, campaignId: to, sessionId: s(m.sessionId), entityIds: m.entityIds.map((id) => e(id)).filter((x): x is number => x != null), threadIds: m.threadIds.map((id) => tMap.get(id)).filter((x): x is number => x != null) });
  }
  for (const r of effects) {
    const { id: _i, createdAt: _x, ...row } = r;
    void [_i, _x];
    await db.insert(schema.effects).values({ ...row, campaignId: to, sourceEntityId: e(r.sourceEntityId), sourceThreadId: r.sourceThreadId != null ? (tMap.get(r.sourceThreadId) ?? null) : null });
  }
  console.log(`Copied "${camp.name}" (${from}) to "${name}" (${to}): ${entities.length} entities, ${relations.length} relationships, ${threads.length} threads, ${moments.length} moments, ${effects.length} rules, ${sessions.length} sessions.`);
  process.exit(0);
})();
