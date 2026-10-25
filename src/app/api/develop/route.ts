import { z } from "zod";
import { develop } from "@/core/develop";
import { saveDevelopment } from "@/core/live";
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
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
    entryId: z.number().int().positive().optional(), // the logged choice this develops; the result is kept on it
    picks: z.array(z.object({ part: z.enum(["open", "setup", "lead"]), headline: z.string().max(200) })).max(6).optional(),
  }),
  async ({ campaignId, model, entryId, ...input }) => {
    const plan = await develop(campaignId, input, model);
    if (entryId) await saveDevelopment(entryId, plan);
    return plan;
  },
  "Loom couldn't plan that ahead this time. Try again.",
);
