import { z } from "zod";
import { applyRecap } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

const ns = z.array(z.number().int().positive());
export const POST = jsonRoute(
  z.object({ campaignId, sessionNumber: z.number().int().positive(), skip: ns, confirmed: ns }),
  ({ campaignId, sessionNumber, skip, confirmed }) => applyRecap(campaignId, sessionNumber, skip, confirmed),
  "Couldn't save those changes.",
);
