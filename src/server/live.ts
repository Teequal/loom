import type { schema } from "@/core/db/client";
import { liveEntries, liveSessionNumber } from "@/core/live";

type Entry = typeof schema.liveEntries.$inferSelect;

// One log entry as the table page shows it.
export function entryView(e: Entry) {
  return {
    id: e.id,
    moment: e.moment,
    choiceKind: e.choiceKind,
    choiceLabel: e.choiceLabel,
    choice: e.choice,
    status: e.status,
    summary: e.summary,
    questions: e.questions.filter((q) => !q.answer).map((q) => ({ n: q.n, group: q.group, summary: q.summary, reasons: q.reasons, evidence: q.evidence })),
    at: e.createdAt,
  };
}

export async function liveState(campaignId: number) {
  return { session: await liveSessionNumber(campaignId), entries: (await liveEntries(campaignId)).map(entryView) };
}
