import { after } from "next/server";
import { z } from "zod";
import { extractEntry, queueRetry } from "@/core/live";
import { jsonRoute } from "@/server/route";

// Try again, after a choice couldn't be added to the loom.
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive() }), async ({ entryId }) => {
  await queueRetry(entryId);
  after(() => extractEntry(entryId));
  return { ok: true };
});
