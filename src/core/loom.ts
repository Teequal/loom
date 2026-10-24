import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { EntityTraits } from "./entity-fields";
import { historyOf } from "./history";

// The loom as something you can walk: every thread, character, place, item, faction, key moment
// and session is a node, and every connection in a node's detail points at another node. The
// index lets any text link the names in it; `node` gives one node's detail and its neighbours.

export type NodeKind = "thread" | "entity" | "moment" | "session";
export interface NodeRef {
  kind: NodeKind;
  id: number; // session nodes use the session number
  name: string;
  sub: string; // what it is: "NPC", "mystery thread", "key moment"…
  status?: string | null;
}

const TYPE_LABEL: Record<string, string> = { pc: "Player character", npc: "Character", location: "Place", item: "Item", faction: "Faction", other: "Other" };
const threadSub = (t: { kind: string; status: string }) => `${t.kind} thread${t.status === "resolved" ? ", resolved" : t.status === "progressing" ? ", in progress" : ""}`;

// Names to link inside text: every entity name and alias, every thread title.
export async function loomIndex(campaignId: number) {
  const [entities, threads, moments, sessions] = await Promise.all([
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
    db.select().from(schema.keyMoments).where(and(eq(schema.keyMoments.campaignId, campaignId), inArray(schema.keyMoments.status, ["key", "suggested"]))),
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)),
  ]);
  return {
    nodes: [
      ...entities.map((e) => ({ kind: "entity" as const, id: e.id, name: e.name, aliases: e.aliases, sub: TYPE_LABEL[e.type] ?? e.type, status: e.status, line: e.description })),
      ...threads.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title, aliases: [], sub: threadSub(t), status: t.status, line: t.summary })),
      ...moments.map((m) => ({ kind: "moment" as const, id: m.id, name: m.title, aliases: [], sub: m.status === "key" ? "Key moment" : "Suggested moment", status: m.status, line: m.description })),
      ...sessions
        .filter((x) => x.recap.trim())
        .map((x) => ({ kind: "session" as const, id: x.number, name: `Session ${x.number}`, aliases: [], sub: "Session", status: null, line: x.recap.replace(/\s+/g, " ").slice(0, 160) })),
    ],
  };
}

export async function loomNode(campaignId: number, kind: NodeKind, id: number) {
  if (kind === "entity") return entityNode(campaignId, id);
  if (kind === "thread") return threadNode(campaignId, id);
  if (kind === "moment") return momentNode(campaignId, id);
  return sessionNode(campaignId, id);
}

async function lookups(campaignId: number) {
  const [entities, threads, sessions] = await Promise.all([
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)),
  ]);
  const ent = new Map(entities.map((e) => [e.id, e]));
  const thr = new Map(threads.map((t) => [t.id, t]));
  const sessionNo = new Map(sessions.map((s) => [s.id, s.number]));
  const entRef = (id: number | null | undefined): NodeRef | null => {
    const e = id == null ? undefined : ent.get(id);
    return e ? { kind: "entity", id: e.id, name: e.name, sub: TYPE_LABEL[e.type] ?? e.type, status: e.status } : null;
  };
  const thrRef = (id: number): NodeRef | null => {
    const t = thr.get(id);
    return t ? { kind: "thread", id: t.id, name: t.title, sub: threadSub(t), status: t.status } : null;
  };
  return { entities, threads, sessions, ent, thr, sessionNo, entRef, thrRef };
}

const present = <T>(xs: (T | null | undefined)[]) => xs.filter((x): x is T => x != null);

async function entityNode(campaignId: number, id: number) {
  const L = await lookups(campaignId);
  const e = L.ent.get(id);
  if (!e) throw new Error("That isn't in the loom any more.");
  const [relations, links, moments] = await Promise.all([
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
    db.select().from(schema.threadEntities).where(eq(schema.threadEntities.entityId, id)),
    db.select().from(schema.keyMoments).where(eq(schema.keyMoments.campaignId, campaignId)),
  ]);
  const traits = e.traits as EntityTraits;
  const secret = (f: string) => !!e.fieldMeta[f]?.secret;
  // Where it is, as a chain of places (the Ritual Site › the Time Pocket › the Woods).
  const chain: NodeRef[] = [];
  for (let cur = e.actualLocationId ?? e.lastKnownLocationId ?? (e.type === "location" ? e.parentId : null), hops = 0; cur != null && hops < 6; hops++) {
    const r = L.entRef(cur);
    if (!r) break;
    chain.push(r);
    cur = L.ent.get(cur)?.parentId ?? null;
  }
  const seen = new Set<string>();
  const ties = relations
    .filter((r) => r.fromEntityId === id || r.toEntityId === id)
    .map((r) => {
      const out = r.fromEntityId === id;
      const other = L.entRef(out ? r.toEntityId : r.fromEntityId);
      return other && { type: r.type.replace(/_/g, " "), out, other, note: r.note, strength: r.strength, secret: r.secret };
    })
    .filter((r): r is NonNullable<typeof r> => {
      if (!r) return false;
      const k = `${r.type}:${r.other.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    kind: "entity" as const,
    id: e.id,
    name: e.name,
    sub: TYPE_LABEL[e.type] ?? e.type,
    type: e.type,
    status: e.status,
    attitude: e.attitude,
    importance: e.importance,
    description: e.description,
    aliases: e.aliases,
    where: chain,
    partOf: e.type !== "location" ? L.entRef(e.parentId) : null,
    contains: L.entities.filter((x) => x.parentId === id || x.lastKnownLocationId === id || x.actualLocationId === id).map((x) => L.entRef(x.id)!).slice(0, 30),
    details: Object.entries(traits)
      .filter(([, v]) => (Array.isArray(v) ? v.length : v))
      .map(([k, v]) => ({ key: k.replace(/_/g, " "), value: Array.isArray(v) ? v.join("; ") : String(v), secret: secret(`traits.${k}`) })),
    ties,
    threads: present(links.map((l) => L.thrRef(l.threadId))).sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved")),
    moments: moments.filter((m) => m.entityIds.includes(id) && m.status !== "dismissed").map((m) => ({ kind: "moment" as const, id: m.id, name: m.title, sub: m.status === "key" ? "Key moment" : "Suggested moment" })),
    history: (await historyOf(campaignId, e)).slice(-30),
  };
}

async function threadNode(campaignId: number, id: number) {
  const L = await lookups(campaignId);
  const t = L.thr.get(id);
  if (!t) throw new Error("That isn't in the loom any more.");
  const [links, tlinks, events, moments] = await Promise.all([
    db.select().from(schema.threadEntities).where(eq(schema.threadEntities.threadId, id)),
    db.select().from(schema.threadLinks),
    db.select().from(schema.threadEvents).where(eq(schema.threadEvents.threadId, id)).orderBy(desc(schema.threadEvents.id)),
    db.select().from(schema.keyMoments).where(eq(schema.keyMoments.campaignId, campaignId)),
  ]);
  const meta = (f: string) => !!t.fieldMeta[f]?.secret;
  return {
    kind: "thread" as const,
    id: t.id,
    name: t.title,
    sub: threadSub(t),
    threadKind: t.kind,
    status: t.status,
    summary: t.summary,
    secret: t.secret,
    stakes: t.stakes ? { text: t.stakes, secret: meta("stakes") } : null,
    deadline: t.deadline ? { text: t.deadline, secret: meta("deadline") } : null,
    involves: present(links.map((l) => L.entRef(l.entityId))),
    // A link recorded both ways shows once, with both notes.
    linked: [
      ...tlinks
        .filter((l) => l.fromThreadId === id || l.toThreadId === id)
        .reduce((m, l) => {
          const otherId = l.fromThreadId === id ? l.toThreadId : l.fromThreadId;
          const other = L.thrRef(otherId);
          if (!other) return m;
          const prev = m.get(otherId);
          m.set(otherId, { ...other, note: prev ? [prev.note, l.note].filter(Boolean).join("; ") : l.note });
          return m;
        }, new Map<number, NodeRef & { note: string }>())
        .values(),
    ],
    history: events
      .map((e) => ({ session: e.sessionId ? (L.sessionNo.get(e.sessionId) ?? null) : null, change: e.change, note: e.note }))
      .reverse(),
    moments: moments.filter((m) => m.threadIds.includes(id) && m.status !== "dismissed").map((m) => ({ kind: "moment" as const, id: m.id, name: m.title, sub: m.status === "key" ? "Key moment" : "Suggested moment" })),
    firstSeen: t.firstSeenSessionId ? (L.sessionNo.get(t.firstSeenSessionId) ?? null) : null,
    lastTouched: t.lastTouchedSessionId ? (L.sessionNo.get(t.lastTouchedSessionId) ?? null) : null,
  };
}

async function momentNode(campaignId: number, id: number) {
  const L = await lookups(campaignId);
  const [m] = await db.select().from(schema.keyMoments).where(and(eq(schema.keyMoments.id, id), eq(schema.keyMoments.campaignId, campaignId)));
  if (!m) throw new Error("That isn't in the loom any more.");
  return {
    kind: "moment" as const,
    id: m.id,
    name: m.title,
    sub: m.status === "key" ? "Key moment" : m.status === "suggested" ? "Suggested moment" : "Dismissed moment",
    status: m.status,
    description: m.description,
    callback: m.callback,
    session: m.sessionId ? (L.sessionNo.get(m.sessionId) ?? null) : null,
    involves: present(m.entityIds.map((x) => L.entRef(x))),
    threads: present(m.threadIds.map((x) => L.thrRef(x))),
  };
}

async function sessionNode(campaignId: number, number: number) {
  const L = await lookups(campaignId);
  const s = L.sessions.find((x) => x.number === number);
  if (!s) throw new Error("That session isn't recorded.");
  const events = await db.select().from(schema.threadEvents).where(eq(schema.threadEvents.sessionId, s.id));
  const touched = new Map<number, string>();
  for (const e of events) touched.set(e.threadId, e.change);
  return {
    kind: "session" as const,
    id: s.number,
    name: `Session ${s.number}`,
    sub: "Session",
    notes: s.recap,
    threads: present([...touched].map(([tid, change]) => {
      const r = L.thrRef(tid);
      return r && { ...r, change };
    })),
  };
}

export type LoomNode = Awaited<ReturnType<typeof loomNode>>;
