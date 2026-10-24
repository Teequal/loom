import { eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
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
    at: e.createdAt,
  };
}

export async function liveState(campaignId: number) {
  const [camp] = await db.select({ auto: schema.campaigns.autoApprove }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  return { session: await liveSessionNumber(campaignId), autoApprove: !!camp?.auto, entries: (await liveEntries(campaignId)).map(entryView) };
}
