import { z } from "zod";
import { overview } from "@/server/campaign";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => overview(campaignId));
