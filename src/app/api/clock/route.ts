import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { updateCampaign, updateEntity } from "@/core/entities";
import { readMoment } from "@/core/moment-reading";
import { clockWords, journeyOf, presenceOf, viewOf } from "@/core/world/engine";
import { loadGraph } from "@/core/world/load";
import type { NodeKey } from "@/core/world/nodes";
import { campaignId, jsonRoute } from "@/server/route";

// The in-game clock: read it, move it on ("time passes"), or set it. When it moves, anyone whose
// journey is over by then is recorded where they were going (one undoable batch, as the GM's).
const START = 8 * 60; // a clock that hasn't started begins on day 1 at eight in the morning

export const POST = jsonRoute(
  z.object({ campaignId, advance: z.number().int().min(1).max(60 * 24 * 60).optional(), set: z.number().int().min(0).max(60 * 24 * 3650).optional() }),
  async ({ campaignId, advance, set }) => {
    const [camp] = await db.select({ clock: schema.campaigns.clockMinutes }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    let clock = camp?.clock ?? null;
    const arrived: { name: string; place: string }[] = [];
    if (advance != null || set != null) {
      clock = set ?? (clock ?? START) + advance!;
      const batch = `clock ${new Date().toISOString().slice(0, 16)} ${clockWords(clock)}`;
      await updateCampaign(campaignId, { clockMinutes: clock }, { source: "dm", batch });
      // Who has got where they were going by now.
      const v = viewOf(await loadGraph(campaignId), readMoment([], ""));
      for (const n of v.g.nodes.values()) {
        if (n.kind !== "character" || !n.travel) continue;
        const j = journeyOf(v, n);
        if (!j?.arrived) continue;
        await updateEntity(n.id, { lastKnownLocationId: j.to.id, traits: { travel: null } }, { source: "dm", batch });
        arrived.push({ name: n.name, place: j.to.name });
      }
    }
    // Everyone on the move, with where they are on the way.
    const v = viewOf(await loadGraph(campaignId), readMoment([], ""));
    const moving = [...v.g.nodes.values()].filter((n) => n.kind === "character" && n.travel).map((n) => ({ id: n.id, name: n.name, standing: presenceOf(v, n.key as NodeKey, new Map()).standing }));
    return { clock, words: clock == null ? null : clockWords(clock), arrived, moving };
  },
);
