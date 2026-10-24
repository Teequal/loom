import { z } from "zod";
import { starMoment } from "@/server/campaign";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId, id: z.number().int().positive(), status: z.enum(["key", "suggested", "dismissed"]) }), async ({ campaignId, id, status }) => {
  await starMoment(campaignId, id, status);
  return { ok: true };
});
