import { after } from "next/server";
import { z } from "zod";
import { extractEntry, recordResult, skipResult } from "@/core/live";
import { entryView } from "@/server/live";
import { jsonRoute } from "@/server/route";

// How a roll or fight turned out, or skip it (allowed, and remembered for wrap-up).
export const POST = jsonRoute(
  z.object({
    entryId: z.number().int().positive(),
    skip: z.boolean().default(false),
    outcome: z.string().trim().max(80).default(""),
    detail: z.string().trim().max(1000).default(""),
    // From the roll panel: each character's roll and how it went, and the DC if the GM set one.
    rolls: z.array(z.object({ name: z.string().trim().min(1).max(80), total: z.number().int().min(-20).max(99).nullable(), outcome: z.enum(["success", "failure", "partial"]) })).max(12).optional(),
    dc: z.number().int().min(1).max(40).nullable().optional(),
  }),
  async ({ entryId, skip, outcome, detail, rolls, dc }) => {
    if (skip) {
      await skipResult(entryId);
      return { ok: true };
    }
    if (rolls?.length) {
      // The overall outcome, in the words the rest of Loom reads; each roll is kept too.
      const all = (o: string) => rolls.every((r) => r.outcome === o);
      outcome = all("success") ? "Succeeded" : all("failure") ? "Failed" : "Partly";
      const WORD = { success: "made it", failure: "failed", partial: "partly" } as const;
      const each = rolls.map((r) => `${r.name}${r.total != null ? ` ${r.total}` : ""}, ${WORD[r.outcome]}`).join("; ");
      detail = [`${each}${dc ? ` (DC ${dc})` : ""}`, detail].filter(Boolean).join(". ");
    }
    if (!outcome && !detail) throw new Error("Say how it turned out, or skip it.");
    const e = await recordResult(entryId, outcome || "It turned out", detail, rolls);
    after(() => extractEntry(e.id));
    return { entry: entryView(e) };
  },
);
