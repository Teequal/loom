import { z } from "zod";
import { prepIdeas } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => prepIdeas(campaignId), "Loom couldn't come up with prep ideas this time. Try again.");
