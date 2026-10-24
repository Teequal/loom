import { after } from "next/server";
import { z } from "zod";
import { commitChoice, extractEntry } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

// The GM used an option (or wrote their own): log it now, extract it into the loom after replying.
export const POST = jsonRoute(
  z.object({ entryId: z.number().int().positive(), kind: z.enum(["option", "own"]), label: z.string().max(200).default(""), text: z.string().trim().min(2, "Write what happened.").max(4000), awaiting: z.enum(["roll", "fight"]).nullable().optional() }),
  async ({ entryId, kind, label, text, awaiting }) => {
    const e = await commitChoice(entryId, { kind, label, text, awaiting });
    if (!e) throw new Error("That moment isn't in the log any more.");
    after(() => extractEntry(e.id));
    return { entry: entryView(e) };
  },
);
