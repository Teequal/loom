import { z } from "zod";
import { PAIR_WEIGHTS } from "@/core/db/schema";
import { removeRelation, setPairWeights, setRelation, setSubProperty, updateEntity, updateThread } from "@/core/entities";
import { HEALTH } from "@/core/entity-fields";
import { setThreadPart, setThreadStakes } from "@/core/thread-parts";
import { recordInterplayChanges } from "@/core/interplay-history";
import { loomNode } from "@/core/loom";
import { INTERPLAYS } from "@/core/world/interplays";
import { db, schema } from "@/core/db/client";
import { and, eq } from "drizzle-orm";
import { campaignId, jsonRoute } from "@/server/route";

// The DM's own edits from the inspector: one value, one weight, or an interplay switched on, off or
// back to worked out. Saved as the DM's (so nothing else overwrites them), logged in one batch each
// so they can be undone, and the entity comes back as it now reads.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("state"), campaignId, entityId: z.number().int(), status: z.string().max(30).optional(), health: z.enum(HEALTH).optional(), conditions: z.array(z.string().max(40)).max(20).optional() }),
  z.object({ action: z.literal("holder"), campaignId, entityId: z.number().int(), holderId: z.number().int().nullable() }),
  z.object({ action: z.literal("part"), campaignId, threadId: z.number().int(), entityId: z.number().int(), role: z.string().max(30) }),
  z.object({ action: z.literal("stakes"), campaignId, threadId: z.number().int(), level: z.number().int().min(1).max(5).nullable() }),
  // The thread itself: resolve or reopen it, set it aside or bring it back, give it a deadline.
  z.object({ action: z.literal("thread"), campaignId, threadId: z.number().int(), status: z.enum(["open", "resolved"]).optional(), parked: z.boolean().optional(), deadline: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("sub"), campaignId, entityId: z.number().int(), path: z.string().max(80), value: z.union([z.number().int().min(-3).max(3), z.boolean(), z.null()]) }),
  z.object({ action: z.literal("pair"), campaignId, entityId: z.number().int(), from: z.number().int(), to: z.number().int(), weight: z.enum(PAIR_WEIGHTS), value: z.number().int().min(-3).max(3).nullable() }),
  z.object({ action: z.literal("interplay"), campaignId, entityId: z.number().int(), id: z.string().max(40), state: z.enum(["on", "off", "auto"]), other: z.number().int().optional() }),
]);

const batchNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `inspector ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} #${Math.random().toString(36).slice(2, 6)}`;
};

export const POST = jsonRoute(Body, async (b) => {
  if (b.action === "thread") {
    const [t] = await db.select().from(schema.threads).where(and(eq(schema.threads.id, b.threadId), eq(schema.threads.campaignId, b.campaignId)));
    if (!t) throw new Error("That isn't in this campaign.");
    const opts = { source: "dm" as const, batch: batchNow() };
    await updateThread(t.id, { ...(b.status ? { status: b.status } : {}), ...(b.parked != null ? { parked: b.parked } : {}), ...(b.deadline != null ? { deadline: b.deadline } : {}) }, opts);
    await recordInterplayChanges(b.campaignId, opts.batch).catch(() => {});
    return loomNode(b.campaignId, "thread", t.id);
  }
  if (b.action === "part" || b.action === "stakes") {
    const [t] = await db.select().from(schema.threads).where(and(eq(schema.threads.id, b.threadId), eq(schema.threads.campaignId, b.campaignId)));
    if (!t) throw new Error("That isn't in this campaign.");
    const opts = { source: "dm" as const, batch: batchNow() };
    if (b.action === "part") await setThreadPart(t.id, b.entityId, b.role, opts);
    else await setThreadStakes(t.id, b.level, opts);
    await recordInterplayChanges(b.campaignId, opts.batch).catch(() => {});
    return loomNode(b.campaignId, "thread", t.id);
  }
  const [e] = await db.select().from(schema.entities).where(and(eq(schema.entities.id, b.entityId), eq(schema.entities.campaignId, b.campaignId)));
  if (!e) throw new Error("That isn't in this campaign.");
  // Pulls already true before this edit are logged on their own first (campaigns older than the
  // pull history have none yet), so this edit's batch holds only what the edit changed.
  await recordInterplayChanges(b.campaignId).catch(() => {});
  const opts = { source: "dm" as const, batch: batchNow() };
  if (b.action === "state") {
    const traits = { ...(b.health ? { health: b.health } : {}), ...(b.conditions ? { conditions: b.conditions } : {}) };
    await updateEntity(e.id, { ...(b.status ? { status: b.status } : {}), ...(Object.keys(traits).length ? { traits } : {}) }, opts);
  }
  if (b.action === "holder") {
    if (e.type !== "item") throw new Error("Only an item has a holder.");
    const rows = await db.select().from(schema.entityRelations).where(and(eq(schema.entityRelations.toEntityId, e.id), eq(schema.entityRelations.type, "holds")));
    if (b.holderId == null) for (const r of rows) await removeRelation(r.id, "dm", opts.batch);
    else await setRelation(b.campaignId, { fromEntityId: b.holderId, toEntityId: e.id, type: "holds" }, opts);
  }
  if (b.action === "sub") await setSubProperty(e.id, b.path, b.value, opts);
  if (b.action === "pair") {
    if (b.from !== e.id && b.to !== e.id) throw new Error("That weight isn't this character's.");
    await setPairWeights(b.campaignId, b.from, b.to, { [b.weight]: b.value }, opts);
  }
  if (b.action === "interplay") {
    const def = INTERPLAYS.find((d) => d.id === b.id);
    if (!def) throw new Error("Loom doesn't know that pull.");
    const rest = (e.traits.interplay_overrides ?? []).filter((o) => !(o.id === def.id && o.other === b.other));
    const next = b.state === "auto" ? rest : [...rest, { id: def.id, on: b.state === "on", ...(b.other ? { other: b.other } : {}) }];
    await updateEntity(e.id, { traits: { interplay_overrides: next } }, opts);
  }
  await recordInterplayChanges(b.campaignId, opts.batch).catch(() => {});
  return loomNode(b.campaignId, "entity", e.id);
});
