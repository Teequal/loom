import { z } from "zod";
import { proposeRecap } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId, recap: z.string().trim().min(20, "Paste a little more of the session notes.").max(60000), sessionNumber: z.number().int().positive().optional() }),
  ({ campaignId, recap, sessionNumber }) => proposeRecap(campaignId, recap, sessionNumber),
  "Loom couldn't read those notes this time. Try again.",
);
