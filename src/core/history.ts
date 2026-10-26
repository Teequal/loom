import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "./db/client";
import { traitText } from "./entity-fields";

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
  note?: string; // why, when code made the change ("fought the party")
  batch?: string | null; // the change batch: lines from one moment or one set of notes belong together
  moment?: string; // for a change made at the table: the moment it came from, as the log shows it
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
  // How others stand toward this one (pair weights recorded on their side).
  const towardRows = (await db.select().from(schema.stateChanges).where(eq(schema.stateChanges.campaignId, campaignId))).filter((r) => r.entityId !== entity.id && r.field.startsWith(`pair.${entity.id}.`));
  const all = [...rows, ...relRows, ...towardRows].sort((a, b) => a.id - b.id);
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const names = new Map((await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId))).map((e) => [e.id, e.name]));
  const show = (field: string, v: unknown) => {
    if (v == null || v === "") return "—";
    if (/(LocationId|parentId)$/.test(field) && typeof v === "number") return names.get(v) ?? `#${v}`;
    return traitText(field.replace(/^traits\./, ""), v);
  };
  // The moment each table batch came from ("live s6 14:02 #e41" → entry 41).
  const entryIds = [...new Set(all.map((r) => Number(r.batch?.match(/#e(\d+)$/)?.[1])).filter((n) => n > 0))];
  const entries = entryIds.length ? await db.select().from(schema.liveEntries).where(inArray(schema.liveEntries.id, entryIds)) : [];
  const momentOf = (batch: string | null) => {
    const e = entries.find((x) => x.id === Number(batch?.match(/#e(\d+)$/)?.[1]));
    if (!e) return undefined;
    const said = (x: typeof e) => x.choiceLabel || (x.choice.length > 60 ? `${x.choice.slice(0, 57)}…` : x.choice);
    if (e.choiceKind === "result" && e.parentId) {
      const p = entries.find((x) => x.id === e.parentId);
      return p ? `${said(p)}: ${e.choiceLabel}` : e.moment;
    }
    return said(e);
  };
  const missing = entries.filter((e) => e.choiceKind === "result" && e.parentId && !entries.some((x) => x.id === e.parentId)).map((e) => e.parentId!);
  if (missing.length) entries.push(...(await db.select().from(schema.liveEntries).where(inArray(schema.liveEntries.id, missing))));
  return all.map((r) => {
    // Pair weights read as sentences, from whichever side is looking.
    const pair = r.field.match(/^pair\.(\d+)\.(\w+)$/);
    if (pair) {
      const [, to, w] = pair;
      const amount = (v: unknown) => (v == null ? "—" : typeof v === "number" && v > 0 && !["fear", "debt", "loyalty"].includes(w) ? `+${v}` : String(v));
      const mine = r.entityId === entity.id;
      const text = mine ? `${w} toward ${names.get(Number(to)) ?? "?"}: ${amount(r.before)} → ${amount(r.after)}` : `${names.get(r.entityId ?? 0) ?? r.subject.split(" → ")[0]}'s ${w} toward ${entity.name}: ${amount(r.before)} → ${amount(r.after)}`;
      return { session: sessions.find((s) => s.id === r.sessionId)?.number ?? null, when: r.createdAt, text: r.undoneAt ? `${text} (undone)` : text, source: r.source, note: r.note ?? undefined, batch: r.batch, moment: momentOf(r.batch) };
    }
    const field = r.field.replace(/^traits\./, "").replace(/^(?:state|disposition)\./, "").replace(/^goals\.(g\d+)\./, "goal $1 ").replace(/LocationId$/, " location").replace(/Id$/, "").replace(/_/g, " ");
    const text =
      r.kind === "interplay"
        ? (r.after as { on?: boolean; name?: string; handle?: string })?.on
          ? `now ${(r.after as { name: string }).name}: ${(r.after as { handle: string }).handle}`
          : `no longer ${(r.after as { name?: string })?.name ?? "so"}`
        : r.kind === "field"
        ? `${field}: ${show(r.field, r.before)} → ${show(r.field, r.after)}`
        : r.kind === "created"
          ? "first recorded"
          : `${r.kind === "relation-added" ? "+" : r.kind === "relation-removed" ? "−" : "~"} ${r.subject}${r.after && typeof r.after === "object" && "note" in (r.after as object) && (r.after as { note: string }).note ? ` (${(r.after as { note: string }).note})` : ""}`;
    return { session: sessions.find((s) => s.id === r.sessionId)?.number ?? null, when: r.createdAt, text: r.undoneAt ? `${text} (undone)` : text, source: r.source, note: r.note ?? undefined, batch: r.batch, moment: momentOf(r.batch) };
  });
}
