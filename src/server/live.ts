import { eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { FIXTURE_NAME } from "@/core/seed";
import { liveEntries, liveSessionNumber } from "@/core/live";

type Entry = typeof schema.liveEntries.$inferSelect;

// One log entry as the table page shows it.
export function entryView(e: Entry) {
  return {
    id: e.id,
    parentId: e.parentId,
    moment: e.moment,
    choiceKind: e.choiceKind,
    choiceLabel: e.choiceLabel,
    choice: e.choice,
    status: e.status,
    summary: e.summary,
    questions: e.questions.filter((q) => !q.answer).map((q) => ({ n: q.n, group: q.group, summary: q.summary, reasons: q.reasons, evidence: q.evidence })),
    developments: e.developments,
    awaiting: e.resultState === "pending" ? e.awaiting : null,
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
  return {
    session: await liveSessionNumber(campaignId),
    autoApprove: !!camp?.auto,
    empty: !thread && !entity,
    sample: camp?.name === FIXTURE_NAME,
    entries: (await liveEntries(campaignId)).map(entryView),
  };
}
