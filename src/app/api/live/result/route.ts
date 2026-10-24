import { after } from "next/server";
import { z } from "zod";
import { extractEntry, recordResult, skipResult } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

// How a roll or fight turned out, or skip it (allowed, and remembered for wrap-up).
export const POST = jsonRoute(
  z.object({ entryId: z.number().int().positive(), skip: z.boolean().default(false), outcome: z.string().trim().max(80).default(""), detail: z.string().trim().max(1000).default("") }),
  async ({ entryId, skip, outcome, detail }) => {
    if (skip) {
      await skipResult(entryId);
      return { ok: true };
    }
    if (!outcome && !detail) throw new Error("Say how it turned out, or skip it.");
    const e = await recordResult(entryId, outcome || "It turned out", detail);
    after(() => extractEntry(e.id));
    return { entry: entryView(e) };
  },
);
