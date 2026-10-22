import { desc, sql } from "drizzle-orm";
import { db, schema } from "./db/client";

const c = schema.llmCalls;

export async function costSummary() {
  const byFeature = await db
    .select({
      feature: c.feature,
      calls: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${c.ok} then 0 else 1 end)`,
      avgLatencyMs: sql<number>`round(avg(case when ${c.ok} then ${c.latencyMs} end))`,
      inputTokens: sql<number>`sum(${c.inputTokens})`,
      outputTokens: sql<number>`sum(${c.outputTokens})`,
      costUsd: sql<number>`sum(${c.costUsd})`,
    })
    .from(c)
    .groupBy(c.feature);

  const recent = await db.select().from(c).orderBy(desc(c.id)).limit(10);
  return { byFeature, recent };
}
