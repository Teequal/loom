import { z } from "zod";
import { history, nextSessionNumber } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

// What the between-sessions page needs to open: the next session's number and recent changes.
export const POST = jsonRoute(z.object({ campaignId }), async ({ campaignId }) => ({
  nextSession: await nextSessionNumber(campaignId),
  history: await history(campaignId),
}));
