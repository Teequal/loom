import { z } from "zod";
import { freshIdeas } from "@/core/fresh";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => freshIdeas(campaignId), "Loom couldn't come up with fresh ideas this time. Try again.");
