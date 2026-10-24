import { z } from "zod";
import { updateEntity } from "@/core/entities";
import { campaignId, jsonRoute } from "@/server/route";

// PC levels, asked for the first time a fight needs them; recorded as the GM's own entries.
export const POST = jsonRoute(z.object({ campaignId, levels: z.record(z.string(), z.number().int().min(1).max(20)) }), async ({ levels }) => {
  for (const [id, level] of Object.entries(levels)) await updateEntity(Number(id), { traits: { level: String(level) } }, { source: "dm" });
  return { ok: true };
});
