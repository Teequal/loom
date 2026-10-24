import { z } from "zod";
import { loomIndex } from "@/core/loom";
import { campaignId, jsonRoute } from "@/server/route";

// Every name in the campaign, for linking text and hover previews.
export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => loomIndex(campaignId));
