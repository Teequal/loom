import { z } from "zod";
import { history, undo } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId, batch: z.string().min(1) }), async ({ campaignId, batch }) => ({
  ...(await undo(campaignId, batch)),
  history: await history(campaignId),
}));
