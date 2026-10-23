import { and, desc, eq, or } from "drizzle-orm";
import { db, schema } from "./db/client";

// L4 history: the automatic change log. Writes go through entities.ts, which calls logChanges;
// nobody has to remember to record anything.

type Change = Omit<typeof schema.stateChanges.$inferInsert, "id" | "createdAt" | "sessionId"> & { sessionId?: number | null };

// The session a change belongs to: the one being recapped, or the latest one at the time.
async function sessionFor(campaignId: number, sessionId?: number | null) {
  if (sessionId != null) return sessionId;
  const [latest] = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .orderBy(desc(schema.sessions.number))
    .limit(1);
  return latest?.id ?? null;
}

export async function logChanges(changes: Change[]) {
  if (!changes.length) return;
  const sessionId = await sessionFor(changes[0].campaignId, changes[0].sessionId);
  await db.insert(schema.stateChanges).values(changes.map((c) => ({ ...c, sessionId: c.sessionId ?? sessionId })));
}

export interface HistoryLine {
  session: number | null;
  when: string;
  text: string;
  source: string;
}

// Everything recorded about one entity (its own fields, and relationships it's part of), oldest
// first, with ids turned back into names.
export async function historyOf(campaignId: number, entity: { id: number; name: string }): Promise<HistoryLine[]> {
  const rows = await db
    .select()
    .from(schema.stateChanges)
    .where(
      and(
        eq(schema.stateChanges.campaignId, campaignId),
        or(eq(schema.stateChanges.entityId, entity.id), eq(schema.stateChanges.subject, entity.name)),
      ),
    )
    .orderBy(schema.stateChanges.id);
  const relRows = (await db.select().from(schema.stateChanges).where(eq(schema.stateChanges.campaignId, campaignId))).filter(
    (r) => r.kind.startsWith("relation") && r.entityId !== entity.id && new RegExp(`(^|\\s)${entity.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`).test(r.subject),
  );
  const all = [...rows, ...relRows].sort((a, b) => a.id - b.id);
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const names = new Map((await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId))).map((e) => [e.id, e.name]));
  const show = (field: string, v: unknown) => {
    if (v == null || v === "") return "—";
    if (/(LocationId|parentId)$/.test(field) && typeof v === "number") return names.get(v) ?? `#${v}`;
    return Array.isArray(v) ? v.join("; ") : String(v);
  };
  return all.map((r) => {
    const field = r.field.replace(/^traits\./, "").replace(/LocationId$/, " location").replace(/Id$/, "").replace(/_/g, " ");
    const text =
      r.kind === "field"
        ? `${field}: ${show(r.field, r.before)} → ${show(r.field, r.after)}`
        : r.kind === "created"
          ? "first recorded"
          : `${r.kind === "relation-added" ? "+" : r.kind === "relation-removed" ? "−" : "~"} ${r.subject}${r.after && typeof r.after === "object" && "note" in (r.after as object) && (r.after as { note: string }).note ? ` (${(r.after as { note: string }).note})` : ""}`;
    return { session: sessions.find((s) => s.id === r.sessionId)?.number ?? null, when: r.createdAt, text, source: r.source };
  });
}
