import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { updateEntity } from "@/core/entities";
import type { EntityTraits } from "@/core/entity-fields";
import { campaignId, jsonRoute } from "@/server/route";

// The campaign map: every place with its pin (if it has one), who is recorded where, and where the
// party is. With `pin`, a place is pinned, moved or unpinned first, as the GM's own entry (undoable).
export const POST = jsonRoute(
  z.object({
    campaignId,
    pin: z.object({ placeId: z.number().int().positive(), x: z.number().min(-100000).max(100000).nullable(), y: z.number().min(-100000).max(100000).nullable() }).optional(),
  }),
  async ({ campaignId, pin }) => {
    if (pin) {
      const [p] = await db.select().from(schema.entities).where(and(eq(schema.entities.id, pin.placeId), eq(schema.entities.campaignId, campaignId)));
      if (!p || p.type !== "location") throw new Error("That place isn't in this campaign.");
      const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
      await updateEntity(p.id, { mapX: round(pin.x), mapY: round(pin.y) }, { source: "dm", batch: `map ${new Date().toISOString().slice(0, 16)} #${p.id}` });
    }
    const [camp] = await db.select({ party: schema.campaigns.partyLocationId }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    return {
      party: camp?.party ?? null,
      places: ents
        .filter((e) => e.type === "location")
        .map((e) => ({ id: e.id, name: e.name, parentId: e.parentId, x: e.mapX, y: e.mapY, kind: (e.traits as EntityTraits).location_type ?? "", status: e.status })),
      people: ents
        .filter((e) => (e.type === "npc" || e.type === "faction") && e.status !== "dead" && (e.actualLocationId ?? e.lastKnownLocationId) != null)
        .map((e) => ({ id: e.id, name: e.name, placeId: (e.actualLocationId ?? e.lastKnownLocationId)! })),
    };
  },
);
