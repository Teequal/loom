import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { updateEntity } from "@/core/entities";
import type { EntityTraits } from "@/core/entity-fields";
import { campaignId, jsonRoute } from "@/server/route";
import { readMoment } from "@/core/moment-reading";
import { travelOf, travelWords, viewOf } from "@/core/world/engine";
import { loadGraph } from "@/core/world/load";
import type { NodeKey } from "@/core/world/nodes";

const KINDS = ["road", "path", "river", "closed"] as const;

// The campaign map: every place with its pin (if it has one), who is recorded where, and where the
// party is. With `pin`, a place is pinned, moved or unpinned first, as the GM's own entry (undoable).
export const POST = jsonRoute(
  z.object({
    campaignId,
    pin: z.object({ placeId: z.number().int().positive(), x: z.number().min(-100000).max(100000).nullable(), y: z.number().min(-100000).max(100000).nullable() }).optional(),
    // A way between two places (road, path, river, or closed), or none to take it away.
    route: z.object({ from: z.number().int().positive(), to: z.number().int().positive(), kind: z.enum(KINDS).nullable() }).optional(),
  }),
  async ({ campaignId, pin, route }) => {
    if (route) {
      if (route.from === route.to) throw new Error("A way needs two different places.");
      const two = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
      const [a, b] = [two.find((e) => e.id === route.from), two.find((e) => e.id === route.to)];
      if (!a || !b || a.type !== "location" || b.type !== "location") throw new Error("Those places aren't in this campaign.");
      const batch = `map ${new Date().toISOString().slice(0, 16)} way #${a.id}-${b.id}`;
      // One way per pair: whichever side held it before gives it up, and the "from" side keeps it.
      const without = (e: typeof a, other: number) => ((e.traits as EntityTraits).routes ?? []).filter((r) => r.to !== other);
      if (((b.traits as EntityTraits).routes ?? []).some((r) => r.to === a.id)) await updateEntity(b.id, { traits: { routes: without(b, a.id) } }, { source: "dm", batch });
      await updateEntity(a.id, { traits: { routes: [...without(a, b.id), ...(route.kind ? [{ to: b.id, kind: route.kind }] : [])] } }, { source: "dm", batch });
    }
    if (pin) {
      const [p] = await db.select().from(schema.entities).where(and(eq(schema.entities.id, pin.placeId), eq(schema.entities.campaignId, campaignId)));
      if (!p || p.type !== "location") throw new Error("That place isn't in this campaign.");
      const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
      await updateEntity(p.id, { mapX: round(pin.x), mapY: round(pin.y) }, { source: "dm", batch: `map ${new Date().toISOString().slice(0, 16)} #${p.id}` });
    }
    const [camp] = await db.select({ party: schema.campaigns.partyLocationId }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    // How long each place is from the party, by the engine's own reckoning (roads where drawn).
    const v = viewOf(await loadGraph(campaignId), readMoment([], ""));
    const travel: Record<number, string> = {};
    if (camp?.party) for (const e of ents.filter((x) => x.type === "location" && x.id !== camp.party)) {
      const t = travelOf(v, `place:${e.id}` as NodeKey, `place:${camp.party}` as NodeKey);
      if (t) travel[e.id] = travelWords(t);
    }
    return {
      party: camp?.party ?? null,
      travel,
      places: ents
        .filter((e) => e.type === "location")
        .map((e) => ({ id: e.id, name: e.name, parentId: e.parentId, x: e.mapX, y: e.mapY, kind: (e.traits as EntityTraits).location_type ?? "", status: e.status, routes: (e.traits as EntityTraits).routes ?? [] })),
      people: ents
        .filter((e) => (e.type === "npc" || e.type === "faction") && e.status !== "dead" && (e.actualLocationId ?? e.lastKnownLocationId) != null)
        .map((e) => ({ id: e.id, name: e.name, placeId: (e.actualLocationId ?? e.lastKnownLocationId)! })),
    };
  },
);
