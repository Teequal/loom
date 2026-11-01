import { eq, max } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { loadTaste, tasteLines } from "@/core/taste";
import { campaignId, jsonRoute } from "@/server/route";

// What Loom has learned about this GM; turning it off; starting over.
export const POST = jsonRoute(z.object({ campaignId, on: z.boolean().optional(), reset: z.boolean().optional() }), async ({ campaignId, on, reset }) => {
  if (on !== undefined) await db.update(schema.campaigns).set({ learn: on }).where(eq(schema.campaigns.id, campaignId));
  if (reset) {
    const [m] = await db.select({ id: max(schema.liveEntries.id) }).from(schema.liveEntries).where(eq(schema.liveEntries.campaignId, campaignId));
    await db.update(schema.campaigns).set({ learnFrom: m?.id ?? 0 }).where(eq(schema.campaigns.id, campaignId));
  }
  const taste = await loadTaste(campaignId);
  return { on: taste.on, lines: tasteLines(taste) };
});
