import { z } from "zod";
import { wrapWithoutAdding } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => wrapWithoutAdding(campaignId));
