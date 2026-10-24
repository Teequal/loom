import { z } from "zod";
import { setupEncounter } from "@/core/encounter";
import { jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ entryId: z.number().int().positive() }), ({ entryId }) => setupEncounter(entryId), "Loom couldn't set up the fight this time. Try again.");
