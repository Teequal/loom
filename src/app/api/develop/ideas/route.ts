import { z } from "zod";
import { developIdeas } from "@/core/develop";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({
    campaignId,
    moment: z.string().trim().min(1).max(2000),
    label: z.string().max(200).default(""),
    text: z.string().trim().min(2).max(4000),
    threadIds: z.array(z.number().int()).max(10).default([]),
    reach: z.number().int().min(0).max(3).default(1),
    tone: z.number().int().min(0).max(4).optional(),
  }),
  ({ campaignId, ...input }) => developIdeas(campaignId, input),
  "Loom couldn't come up with ideas this time. Try again.",
);
