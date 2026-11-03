import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import type { EntityTraits } from "@/core/entity-fields";
import { campaignId, jsonRoute } from "@/server/route";

// What the GM's tools need: who can be rolled for, and the GM's own random tables. Passive scores
// stand in for a modifier (passive − 10), since Loom keeps no character sheets.
export const POST = jsonRoute(
  z.object({
    campaignId,
    addTable: z.object({ name: z.string().trim().min(1).max(80), lines: z.array(z.string().trim().min(1).max(300)).min(2).max(100) }).optional(),
    removeTable: z.number().int().positive().optional(),
  }),
  async ({ campaignId, addTable, removeTable }) => {
    if (addTable) await db.insert(schema.gmTables).values({ campaignId, ...addTable });
    if (removeTable) await db.delete(schema.gmTables).where(and(eq(schema.gmTables.campaignId, campaignId), eq(schema.gmTables.id, removeTable)));
    const pcs = await db.select().from(schema.entities).where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.type, "pc")));
    const score = (v: string | undefined) => (/^\d+$/.test(v ?? "") ? Number(v) : null);
    return {
      pcs: pcs.filter((p) => p.status !== "dead").map((p) => {
        const t = p.traits as EntityTraits;
        return { name: p.name, perception: score(t.passive_perception), insight: score(t.passive_insight) };
      }),
      tables: await db.select().from(schema.gmTables).where(eq(schema.gmTables.campaignId, campaignId)),
      // The campaign's own house rules, to roll for by hand when Loom didn't set one up.
      rules: (await db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId))).map((r) => ({ id: r.id, name: r.name, check: r.check, onFail: r.onFail, onSuccess: r.onSuccess, rule: r.rule, secret: r.secret })),
    };
  },
);
