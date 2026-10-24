import { z } from "zod";
import { liveState } from "@/server/live";
import { campaignId, jsonRoute } from "@/server/route";

// The session in progress: its number and the log so far.
export const POST = jsonRoute(z.object({ campaignId }), ({ campaignId }) => liveState(campaignId));
