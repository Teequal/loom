import { z } from "zod";
import { saveEncounter, type Encounter } from "@/core/encounter";
import { jsonRoute } from "@/server/route";

// The GM moved the difficulty or changed the enemies: keep it on the moment.
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive(), encounter: z.record(z.string(), z.unknown()) }), async ({ entryId, encounter }) => {
  await saveEncounter(entryId, encounter as unknown as Encounter);
  return { ok: true };
});
