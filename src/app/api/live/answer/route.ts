import { z } from "zod";
import { answerQuestion } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ entryId: z.number().int().positive(), n: z.number().int().positive(), yes: z.boolean() }), async ({ entryId, n, yes }) => ({
  entry: entryView(await answerQuestion(entryId, n, yes)),
}));
