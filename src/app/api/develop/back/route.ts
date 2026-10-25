import { z } from "zod";
import { chainBack, chainView } from "@/server/develop";
import { jsonRoute } from "@/server/route";

// Back: the chain as it read before its last rework.
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive(), devId: z.number().int().positive(), chain: z.number().int().min(0).max(9) }), async ({ entryId, devId, chain }) => ({
  chain: chainView(await chainBack(entryId, devId, chain)),
}));
