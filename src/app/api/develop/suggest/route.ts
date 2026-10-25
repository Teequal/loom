import { z } from "zod";
import { suggestedSteer } from "@/core/chain";
import { chainBase } from "@/server/develop";
import { jsonRoute } from "@/server/route";

// The steer Loom would ring for a choice, before anything is written (code only, no model call).
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive() }), async ({ entryId }) => {
  const base = await chainBase(entryId);
  return { suggested: await suggestedSteer(base.campaignId, base) };
});
