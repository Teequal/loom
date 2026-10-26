import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import { logChanges } from "./history";
import { readMoment } from "./moment-reading";
import { viewOf } from "./world/engine";
import { interplaysOf } from "./world/interplays";
import { loadGraph } from "./world/load";

// Interplays are worked out, never stored; when one starts or stops holding (outside any scene),
// that's written to the change log, so the inspector can say "conflicted since session 5" and a
// callback can use the moment it began. Called after saves, table choices and undos.

export async function recordInterplayChanges(campaignId: number, batch?: string) {
  const g = await loadGraph(campaignId);
  const now = interplaysOf(viewOf(g, readMoment([], "")));
  const keyOf = (i: { id: string; subject: string; other?: string }) => `${i.id}|${i.subject}|${i.other ?? ""}`;
  const current = new Map(now.map((i) => [keyOf(i), i]));
  // The latest record for each interplay that has ever been logged.
  const rows = await db.select().from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId), eq(schema.stateChanges.kind, "interplay"))).orderBy(desc(schema.stateChanges.id));
  const last = new Map<string, boolean>();
  for (const r of rows) if (!last.has(r.field)) last.set(r.field, !!(r.after as { on?: boolean } | null)?.on);
  const changes = [];
  const entityOf = (k: string) => (/^(?:character|faction|item|place):\d+$/.test(k) ? Number(k.split(":")[1]) : null);
  for (const [k, i] of current) {
    if (last.get(k)) continue;
    changes.push({ campaignId, subject: g.nodes.get(i.subject)?.name ?? i.subject, entityId: entityOf(i.subject), kind: "interplay" as const, field: k, before: { on: false }, after: { on: true, name: i.name, handle: i.handle, strength: i.strength }, source: "dm" as const, batch });
  }
  for (const [k, on] of last) {
    if (!on || current.has(k)) continue;
    const [id, subject] = k.split("|");
    changes.push({ campaignId, subject: g.nodes.get(subject as never)?.name ?? subject, entityId: entityOf(subject), kind: "interplay" as const, field: k, before: { on: true }, after: { on: false, name: id }, source: "dm" as const, batch });
  }
  await logChanges(changes);
  return changes.length;
}
