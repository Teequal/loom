import { z } from "zod";
import { THREAD_KINDS } from "@/core/db/schema";
import { addThread } from "@/core/fresh";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId, title: z.string().trim().min(2).max(200), kind: z.enum(THREAD_KINDS), summary: z.string().max(2000), entities: z.array(z.string()).max(12).default([]), linkTo: z.array(z.number().int()).max(6).default([]) }),
  async ({ campaignId, ...input }) => ({ thread: await addThread(campaignId, input) }),
);
