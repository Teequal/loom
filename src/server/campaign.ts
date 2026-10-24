import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { updateCampaign } from "@/core/entities";
import type { EntityTraits } from "@/core/entity-fields";
import { listMoments, setMomentStatus } from "@/core/moments";

// Everything in the loom for one campaign, shaped for the campaign page: the story's direction,
// threads with their history, the cast, key moments, sessions, and what's been done with Loom.

export async function overview(campaignId: number) {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error("That campaign isn't here any more.");
  const [entities, threads, links, sessions, relations] = await Promise.all([
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
    db.select().from(schema.threadEntities),
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
  ]);
  const events = threads.length
    ? await db.select().from(schema.threadEvents).where(inArray(schema.threadEvents.threadId, threads.map((t) => t.id))).orderBy(desc(schema.threadEvents.id))
    : [];
  const sessionNo = new Map(sessions.map((s) => [s.id, s.number]));
  const nameOf = new Map(entities.map((e) => [e.id, e.name]));
  const threadIds = new Set(threads.map((t) => t.id));
  const linksOf = (threadId: number) => links.filter((l) => l.threadId === threadId).map((l) => nameOf.get(l.entityId)).filter(Boolean) as string[];

  const order = { progressing: 0, open: 1, resolved: 2 } as Record<string, number>;
  const threadViews = threads
    .map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      status: t.status,
      summary: t.summary,
      secret: t.secret,
      involves: linksOf(t.id),
      firstSeen: t.firstSeenSessionId ? (sessionNo.get(t.firstSeenSessionId) ?? null) : null,
      lastTouched: t.lastTouchedSessionId ? (sessionNo.get(t.lastTouchedSessionId) ?? null) : null,
      history: events
        .filter((e) => e.threadId === t.id)
        .map((e) => ({ session: e.sessionId ? (sessionNo.get(e.sessionId) ?? null) : null, change: e.change, note: e.note }))
        .reverse(),
    }))
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (b.lastTouched ?? 0) - (a.lastTouched ?? 0));

  const cast = entities
    .map((e) => {
      const traits = e.traits as EntityTraits;
      const secretField = (f: string) => !!e.fieldMeta[f]?.secret;
      const details = Object.entries(traits)
        .filter(([, v]) => (Array.isArray(v) ? v.length : v))
        .map(([k, v]) => ({ key: k.replace(/_/g, " "), value: Array.isArray(v) ? v.join("; ") : String(v), secret: secretField(`traits.${k}`) }));
      return {
        id: e.id,
        name: e.name,
        type: e.type,
        status: e.status,
        attitude: e.attitude,
        importance: e.importance,
        description: e.description,
        location: nameOf.get(e.actualLocationId ?? e.lastKnownLocationId ?? -1) ?? null,
        within: e.parentId ? (nameOf.get(e.parentId) ?? null) : null,
        details,
        relations: relations
          .filter((r) => r.fromEntityId === e.id)
          .map((r) => ({ type: r.type.replace(/_/g, " "), other: nameOf.get(r.toEntityId) ?? "?", note: r.note, secret: r.secret })),
        threads: links.filter((l) => l.entityId === e.id && threadIds.has(l.threadId)).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const moments = await listMoments(campaignId, ["key", "suggested"]);
  const party = campaign.partyLocationId ? (nameOf.get(campaign.partyLocationId) ?? null) : null;

  return {
    campaign: { id: campaign.id, name: campaign.name, direction: campaign.direction, tone: campaign.tone, party, partyId: campaign.partyLocationId, date: campaign.inGameDate, safety: campaign.safetyLines, autoApprove: campaign.autoApprove },
    latestSession: Math.max(0, ...sessions.map((s) => s.number)),
    threads: threadViews,
    cast,
    moments: moments.map((m) => ({ id: m.id, title: m.title, description: m.description, callback: m.callback, session: m.session, status: m.status, entities: m.entities })),
    sessions: sessions.sort((a, b) => b.number - a.number).map((s) => ({ number: s.number, notes: s.recap, at: s.createdAt })),
    activity: await activity(campaignId),
  };
}

// What's been done with Loom: moments asked and used at the table, saves and undos, and cost.
async function activity(campaignId: number) {
  const [calls, entries, changes] = await Promise.all([
    db.select().from(schema.llmCalls).where(eq(schema.llmCalls.campaignId, campaignId)).orderBy(desc(schema.llmCalls.id)).limit(500),
    db.select().from(schema.liveEntries).where(eq(schema.liveEntries.campaignId, campaignId)).orderBy(desc(schema.liveEntries.id)).limit(100),
    db.select().from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId))).orderBy(desc(schema.stateChanges.id)).limit(1000),
  ]);
  const byFeature = new Map<string, { calls: number; costUsd: number }>();
  for (const c of calls) {
    const f = byFeature.get(c.feature) ?? { calls: 0, costUsd: 0 };
    byFeature.set(c.feature, { calls: f.calls + 1, costUsd: f.costUsd + c.costUsd });
  }
  const batches = new Map<string, { label: string; at: string; changes: number; undone: boolean }>();
  for (const ch of changes) {
    if (!ch.batch) continue;
    const b = batches.get(ch.batch) ?? { label: ch.batch, at: ch.createdAt, changes: 0, undone: true };
    batches.set(ch.batch, { ...b, changes: b.changes + 1, undone: b.undone && !!ch.undoneAt, at: ch.createdAt < b.at ? ch.createdAt : b.at });
  }
  const items = [
    ...entries.map((e) => ({
      at: e.createdAt,
      kind: e.choiceKind ? ("used" as const) : ("asked" as const),
      text: e.choiceKind ? `${e.moment} → ${e.choiceLabel || "your own"}` : e.moment,
      session: e.sessionNumber,
    })),
    ...[...batches.values()]
      .filter((b) => !b.label.startsWith("live "))
      .map((b) => ({ at: b.at, kind: b.undone ? ("undone" as const) : ("saved" as const), text: `${b.label}|${b.changes}`, session: null })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 80);
  return {
    items,
    cost: [...byFeature.entries()].map(([feature, v]) => ({ feature, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    totalUsd: calls.reduce((s, c) => s + c.costUsd, 0),
  };
}

export async function saveCampaign(campaignId: number, patch: { direction?: string; tone?: string; autoApprove?: boolean }) {
  const { autoApprove, ...fields } = patch;
  if (Object.keys(fields).length) await updateCampaign(campaignId, fields, { source: "dm" });
  // A table preference, not story data: no provenance or change log.
  if (autoApprove !== undefined) await db.update(schema.campaigns).set({ autoApprove }).where(eq(schema.campaigns.id, campaignId));
}

export async function starMoment(campaignId: number, id: number, status: "key" | "suggested" | "dismissed") {
  await setMomentStatus(campaignId, id, status);
}
