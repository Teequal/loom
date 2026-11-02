import { after } from "next/server";
import { z } from "zod";
import { readThreadParts } from "@/core/thread-parts";
import { applyRecap } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

const ns = z.array(z.number().int().positive());
export const POST = jsonRoute(
  z.object({ campaignId, sessionNumber: z.number().int().positive(), skip: ns, confirmed: ns, answers: z.array(z.object({ question: z.string().max(400), answer: z.string().trim().min(1).max(500) })).max(3).optional() }),
  async ({ campaignId, sessionNumber, skip, confirmed, answers }) => {
    const r = await applyRecap(campaignId, sessionNumber, skip, confirmed, answers);
    // Who plays what in the threads is read once the notes are in (thread-parts.ts); nobody waits.
    after(() => readThreadParts(campaignId).catch(() => null));
    return r;
  },
  "Couldn't save those changes.",
);
