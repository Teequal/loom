import { z } from "zod";
import { exportCampaign } from "@/core/export";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId, format: z.enum(["markdown", "data"]) }), ({ campaignId, format }) => exportCampaign(campaignId, format), "Couldn't export this campaign.");
