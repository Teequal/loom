import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";

export type ThreadWithEntities = typeof schema.threads.$inferSelect & { entities: string[] };

export async function listThreads(campaignId: number): Promise<ThreadWithEntities[]> {
  const rows = await db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.campaignId, campaignId))
    .orderBy(asc(schema.threads.status), asc(schema.threads.id));
  if (rows.length === 0) return [];

  const links = await db
    .select({ threadId: schema.threadEntities.threadId, name: schema.entities.name })
    .from(schema.threadEntities)
    .innerJoin(schema.entities, eq(schema.entities.id, schema.threadEntities.entityId))
    .where(inArray(schema.threadEntities.threadId, rows.map((r) => r.id)));

  return rows.map((r) => ({ ...r, entities: links.filter((l) => l.threadId === r.id).map((l) => l.name) }));
}
