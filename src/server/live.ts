import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { FIXTURE_NAME } from "@/core/seed";
import { liveEntries, liveSessionNumber } from "@/core/live";
import { developmentView } from "./develop";

type Entry = typeof schema.liveEntries.$inferSelect;

// One log entry as the table page shows it.
export function entryView(e: Entry, titleOf = new Map<number, string>()) {
  return {
    id: e.id,
    parentId: e.parentId,
    moment: e.moment,
    // The options Loom gave, as the page showed them, so they can be reopened after a reload.
    options: e.options.map((o) => ({
      headline: o.headline ?? o.label,
      flavour: o.flavour ?? null,
      label: o.label,
      text: o.text,
      why: o.why ?? "",
      threads: o.threadIds.filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! })),
      callback: o.callback ?? null,
      needs: o.needs ?? null,
      pillar: o.pillar ?? null,
      surprise: o.surprise ?? null,
    })),
    choiceKind: e.choiceKind,
    choiceLabel: e.choiceLabel,
    choice: e.choice,
    status: e.status,
    summary: e.summary,
    questions: e.questions.filter((q) => !q.answer).map((q) => ({ n: q.n, group: q.group, summary: q.summary, reasons: q.reasons, evidence: q.evidence })),
    // Chains keep their scaffolds on the server; the page gets the readable parts.
    developments: e.developments.map(developmentView),
    awaiting: e.resultState === "pending" ? e.awaiting : null,
    sides: e.sides ?? [], // a choice's two sides, while Loom waits to hear which was taken
    resultState: e.resultState,
    encounter: e.encounter,
    at: e.createdAt,
  };
}

export async function liveState(campaignId: number) {
  const [camp] = await db.select({ auto: schema.campaigns.autoApprove, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  // A campaign with nothing in it yet gets a welcome instead of an empty box.
  const [thread] = await db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId)).limit(1);
  const [entity] = await db.select({ id: schema.entities.id }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId)).limit(1);
  const titleOf = new Map(
    (await db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId))).map((t) => [t.id, t.title]),
  );
  const session = await liveSessionNumber(campaignId);
  const entries = (await liveEntries(campaignId)).map((e) => entryView(e, titleOf));
  return {
    session,
    autoApprove: !!camp?.auto,
    empty: !thread && !entity,
    sample: camp?.name === FIXTURE_NAME,
    entries,
    lastTime: entries.length || (!thread && !entity) ? null : await lastTime(campaignId, session),
  };
}

/**
 * For a session that hasn't started yet: what happened last time (the start of its notes), the
 * threads moving most, and the kept prep ideas, so the GM picks up where they left off.
 */
async function lastTime(campaignId: number, session: number) {
  const sessions = await db.select({ number: schema.sessions.number, recap: schema.sessions.recap }).from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(desc(schema.sessions.number));
  const last = sessions.find((x) => x.number < session && x.recap.trim());
  const threads = await db
    .select({ id: schema.threads.id, title: schema.threads.title, lastTouched: schema.threads.lastTouchedSessionId, status: schema.threads.status })
    .from(schema.threads)
    .where(eq(schema.threads.campaignId, campaignId));
  const sessionIds = new Map((await db.select({ id: schema.sessions.id, number: schema.sessions.number }).from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId))).map((x) => [x.id, x.number]));
  const inPlay = threads
    .filter((t) => t.status !== "resolved")
    .sort((a, b) => (sessionIds.get(b.lastTouched ?? -1) ?? -1) - (sessionIds.get(a.lastTouched ?? -1) ?? -1))
    .slice(0, 4)
    .map((t) => ({ id: t.id, title: t.title }));
  const [camp] = await db.select({ saved: schema.campaigns.savedIdeas }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const prep = camp?.saved?.prep?.data as { collisions?: { title: string }[] } | undefined;
  // The notes, without the wrap-up's own headings, cut at a sentence near 320 characters.
  const text = (last?.recap ?? "").replace(/^Before the first session \(the hook\)\s*/i, "").replace(/\n+/g, " ").trim();
  const cut = text.length > 320 ? `${text.slice(0, 320).replace(/[^.!?]*$/, "").trim() || text.slice(0, 317)}…` : text;
  return last || inPlay.length ? { session: last?.number ?? null, notes: cut, threads: inPlay, prep: (prep?.collisions ?? []).slice(0, 3).map((c) => c.title) } : null;
}
