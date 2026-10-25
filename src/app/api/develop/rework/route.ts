import { z } from "zod";
import { reworkPiece } from "@/core/develop";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId, text: z.string().trim().min(2).max(3000), how: z.string().trim().min(2).max(300), context: z.string().max(3000).default("") }),
  ({ campaignId, ...input }) => reworkPiece(campaignId, input),
  "Loom couldn't rework that this time. Try again.",
);
