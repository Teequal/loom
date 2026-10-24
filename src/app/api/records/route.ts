import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { setRelation, updateEntity } from "@/core/entities";
import type { EntityTraits } from "@/core/entity-fields";
import { campaignId, jsonRoute } from "@/server/route";

// "Update the records" from a note at the table: record a condition the moment stated, or move an
// item to who has it now. Saved as the GM's own entries (logged, undoable).
const Fix = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("condition"), entityId: z.number().int(), condition: z.string().min(2).max(40) }),
  z.object({ kind: z.literal("holds"), holderId: z.number().int(), itemId: z.number().int() }),
]);

export const POST = jsonRoute(z.object({ campaignId, fix: Fix }), async ({ campaignId, fix }) => {
  if (fix.kind === "holds") {
    await setRelation(campaignId, { fromEntityId: fix.holderId, toEntityId: fix.itemId, type: "holds" }, { source: "dm" });
    return { ok: true };
  }
  const [e] = await db.select().from(schema.entities).where(eq(schema.entities.id, fix.entityId));
  if (!e || e.campaignId !== campaignId) throw new Error("That character isn't in this campaign.");
  const t = e.traits as EntityTraits;
  const traits = fix.condition === "unconscious" ? { health: "unconscious" as const } : { conditions: [...new Set([...(t.conditions ?? []), fix.condition])] };
  await updateEntity(e.id, { traits }, { source: "dm" });
  return { ok: true };
});
