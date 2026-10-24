import { z } from "zod";
import { saveCampaign } from "@/server/campaign";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId, direction: z.string().max(4000).optional(), tone: z.string().max(200).optional() }), async ({ campaignId, ...patch }) => {
  await saveCampaign(campaignId, patch);
  return { ok: true };
});
