import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { ThreadSelection } from "./retrieval";

// Context by graph distance (docs/loom-model.md §7). Starting from what the moment is about, walk
// the network: relationships, possession, location, sets and kinds, and shared threads. What's
// close gets full detail; what's further gets less; what's far is left out. Prompts stay small
// however big the campaign grows.

export interface Budget {
  depth: number; // how far to walk from the moment
  full: number; // full cards
  brief: number; // 2-3 line cards
  names: number; // name-and-role mentions
  threads: ThreadSelection; // which open threads to send, and how many in full
}

export const BUDGETS = {
  // Wide (the default): reaches further. Measured no slower than focused, misses less, ~8% more cost.
  improv: { depth: 3, full: 6, brief: 10, names: 16, threads: { min: 8, max: 20, cutoff: 0.15, full: 6 } },
  // Focused (--focused): a tighter scene and fewer threads, for the cheapest calls.
  improvFocused: { depth: 2, full: 4, brief: 6, names: 10, threads: { min: 4, max: 12, cutoff: 0.35, full: 4 } },
  suggest: { depth: 3, full: 8, brief: 10, names: 16, threads: { min: 40, max: 40, cutoff: 0, full: 40 } },
  flavour: { depth: 1, full: 8, brief: 0, names: 0, threads: { min: 0, max: 0, cutoff: 1, full: 0 } },
} satisfies Record<string, Budget>;

// Shortest number of links from any seed to every entity within `depth`.
export async function distancesFrom(campaignId: number, seeds: number[], depth: number): Promise<Map<number, number>> {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const relations = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId));
  const threads = await db.select({ id: schema.threads.id, status: schema.threads.status }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
  const open = threads.filter((t) => t.status !== "resolved").map((t) => t.id);
  const links = open.length ? await db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, open)) : [];

  const adj = new Map<number, Set<number>>();
  const edge = (a: number | null, b: number | null) => {
    if (a == null || b == null || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const r of relations) edge(r.fromEntityId, r.toEntityId);
  for (const e of entities) {
    edge(e.id, e.parentId);
    edge(e.id, e.lastKnownLocationId);
    edge(e.id, e.actualLocationId);
  }
  // Entities on the same thread are one step apart. Very large threads ("why each came to
  // Duradan") would connect everything, so only threads with up to 4 entities count.
  const byThread = new Map<number, number[]>();
  for (const l of links) byThread.set(l.threadId, [...(byThread.get(l.threadId) ?? []), l.entityId]);
  for (const members of byThread.values()) {
    if (members.length > 4) continue;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) edge(members[i], members[j]);
  }

  const dist = new Map<number, number>();
  let frontier = [...new Set(seeds)];
  for (const s of frontier) dist.set(s, 0);
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: number[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!dist.has(m)) {
          dist.set(m, d);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return dist;
}
