import { z } from "zod";
import { applyRecap } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

const ns = z.array(z.number().int().positive());
export const POST = jsonRoute(
  z.object({ campaignId, sessionNumber: z.number().int().positive(), skip: ns, confirmed: ns, answers: z.array(z.object({ question: z.string().max(400), answer: z.string().trim().min(1).max(500) })).max(3).optional() }),
  ({ campaignId, sessionNumber, skip, confirmed, answers }) => applyRecap(campaignId, sessionNumber, skip, confirmed, answers),
  "Couldn't save those changes.",
);
