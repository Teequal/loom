import { z } from "zod";
import { loomNode } from "@/core/loom";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId, kind: z.enum(["thread", "entity", "moment", "session"]), id: z.number().int() }),
  ({ campaignId, kind, id }) => loomNode(campaignId, kind, id),
);
