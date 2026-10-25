import { z } from "zod";
import { startFromHook } from "@/core/hook";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId, party: z.string().max(400).default(""), theme: z.string().max(200).default("") }),
  ({ campaignId, ...input }) => startFromHook(campaignId, input),
  "Loom couldn't start from a hook this time. Try again.",
);
