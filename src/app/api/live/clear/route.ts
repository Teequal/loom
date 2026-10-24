import { z } from "zod";
import { clearChoice } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

// Takes back a logged choice and undoes what it added to the loom.
export const POST = jsonRoute(z.object({ entryId: z.number().int().positive() }), async ({ entryId }) => {
  const r = await clearChoice(entryId);
  return { entry: entryView(r.entry), undone: r.undone };
});
