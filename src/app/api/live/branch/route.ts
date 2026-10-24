import { after } from "next/server";
import { z } from "zod";
import { extractEntry, logBranch } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

// Continue from a development: it joins the session as a child of the choice it grew from.
export const POST = jsonRoute(
  z.object({ parentId: z.number().int().positive(), label: z.string().max(200).default(""), text: z.string().trim().min(2).max(4000) }),
  async ({ parentId, label, text }) => {
    const e = await logBranch(parentId, { label, text });
    after(() => extractEntry(e.id));
    return { entry: entryView(e) };
  },
);
