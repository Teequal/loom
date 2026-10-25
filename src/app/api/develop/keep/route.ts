import { z } from "zod";
import { replaceLatestDevelopment } from "@/core/live";
import { jsonRoute } from "@/server/route";

// After a rework: keep the plan as it now reads.
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive(), plan: z.record(z.string(), z.unknown()) }), async ({ entryId, plan }) => {
  await replaceLatestDevelopment(entryId, plan);
  return { ok: true };
});
