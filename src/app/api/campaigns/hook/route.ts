import { z } from "zod";
import { startFromHook } from "@/core/hook";
import { campaignId, streamRoute } from "@/server/route";

// Streams its stages (writing the world, reading it in, weaving it into the loom), then what it made.
export const POST = streamRoute(
  z.object({ campaignId, party: z.string().max(400).default(""), theme: z.string().max(200).default("") }),
  ({ campaignId, ...input }, send) => startFromHook(campaignId, input, (stage, title) => send({ type: "stage", stage, title })),
  "Loom couldn't start from a hook this time. Try again.",
);
