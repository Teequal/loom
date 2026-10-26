import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { history, undo } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

// Undoing a lot at once (a whole session's notes, an invented world) has to be confirmed by typing
// "delete": one stray tap shouldn't take it back.
const BIG_UNDO = 10;

export const POST = jsonRoute(z.object({ campaignId, batch: z.string().min(1), confirm: z.string().optional() }), async ({ campaignId, batch, confirm }) => {
  const rows = await db.select({ id: schema.stateChanges.id }).from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId), eq(schema.stateChanges.batch, batch), isNull(schema.stateChanges.undoneAt)));
  if (rows.length > BIG_UNDO && confirm?.trim().toLowerCase() !== "delete") throw new Error(`This would undo ${rows.length} changes. Type delete to confirm.`);
  return { ...(await undo(campaignId, batch)), history: await history(campaignId) };
});
