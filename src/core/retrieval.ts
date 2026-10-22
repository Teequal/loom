import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";

// Finds the open threads most relevant to a moment, without calling an LLM.
// Signals: entities named in the moment (and their aliases), word overlap with the
// thread's title/summary/history, links to other relevant threads, and recency.
// A campaign has tens of threads, so scoring them all in memory is instant.

export interface ThreadContext {
  id: number;
  title: string;
  kind: string;
  status: string;
  summary: string;
  entities: string[];
  latestNote: string;
  links: { threadId: number; note: string }[];
  lastTouchedSession: number | null;
}

export interface ScoredThread extends ThreadContext {
  score: number;
  reasons: string[];
}

const STOPWORDS = new Set(
  "the a an and or of to in on at for with from by is are was were be been it its his her their they them he she we you i our your this that these those into out up down over as not no but so if then than too very can will just what who whom which when where why how all any each some more most other such only own same about after before again against while does did doing have has had having do".split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && /[^sui]s$/.test(t) ? t.slice(0, -1) : t)); // "potions" → "potion", not "Darius" → "dariu"
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, phrase: string) =>
  new RegExp(`(^|[^a-z0-9])${escape(phrase.toLowerCase())}([^a-z0-9]|$)`).test(text);

export async function loadThreadContexts(campaignId: number): Promise<ThreadContext[]> {
  const threads = await db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.campaignId, campaignId), inArray(schema.threads.status, ["open", "progressing"])));
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id);

  const [entityRows, linkRows, events, sessions] = await Promise.all([
    db
      .select({ threadId: schema.threadEntities.threadId, name: schema.entities.name })
      .from(schema.threadEntities)
      .innerJoin(schema.entities, eq(schema.entities.id, schema.threadEntities.entityId))
      .where(inArray(schema.threadEntities.threadId, ids)),
    db.select().from(schema.threadLinks),
    db
      .select()
      .from(schema.threadEvents)
      .where(inArray(schema.threadEvents.threadId, ids))
      .orderBy(desc(schema.threadEvents.id)),
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)),
  ]);
  const sessionNumber = new Map(sessions.map((s) => [s.id, s.number]));
  const open = new Set(ids);

  return threads.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    summary: t.summary,
    entities: entityRows.filter((r) => r.threadId === t.id).map((r) => r.name),
    latestNote: events.find((e) => e.threadId === t.id && e.note)?.note ?? "",
    links: linkRows.flatMap((l) =>
      l.fromThreadId === t.id && open.has(l.toThreadId)
        ? [{ threadId: l.toThreadId, note: l.note }]
        : l.toThreadId === t.id && open.has(l.fromThreadId)
          ? [{ threadId: l.fromThreadId, note: l.note }]
          : [],
    ),
    lastTouchedSession: t.lastTouchedSessionId ? (sessionNumber.get(t.lastTouchedSessionId) ?? null) : null,
  }));
}

export async function retrieveThreads(campaignId: number, moment: string, limit = 8): Promise<ScoredThread[]> {
  const threads = await loadThreadContexts(campaignId);
  if (threads.length === 0) return [];
  const text = moment.toLowerCase();
  const momentTokens = new Set(tokens(moment));

  // 1. Entities named in the moment. A full name or alias counts more than a single
  //    distinctive word from a name ("Vex" for "Professor Aldric Vex").
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const nameTokenCounts = new Map<string, number>();
  for (const e of entities) for (const t of new Set(tokens(e.name))) nameTokenCounts.set(t, (nameTokenCounts.get(t) ?? 0) + 1);

  const entityHits = new Map<string, number>(); // entity name -> weight
  for (const e of entities) {
    if ([e.name, ...e.aliases].some((n) => mentions(text, n))) entityHits.set(e.name, 3);
    else if (tokens(e.name).some((t) => t.length >= 4 && (nameTokenCounts.get(t) ?? 0) <= 2 && momentTokens.has(t)))
      entityHits.set(e.name, 2);
  }

  // 2. Word overlap, weighted so rare words count more than common ones.
  const docs = threads.map((t) => new Set(tokens(`${t.title} ${t.title} ${t.summary} ${t.latestNote}`)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + threads.length / (df.get(t) ?? threads.length));

  const latestSession = Math.max(0, ...threads.map((t) => t.lastTouchedSession ?? 0));

  const scored: ScoredThread[] = threads.map((t, i) => {
    const reasons: string[] = [];
    let score = 0;
    for (const name of t.entities) {
      const w = entityHits.get(name);
      if (w) {
        score += w * 1.5;
        reasons.push(`names ${name}`);
      }
    }
    const shared = [...momentTokens].filter((tok) => docs[i].has(tok));
    if (shared.length) {
      score += shared.reduce((s, tok) => s + idf(tok), 0);
      reasons.push(`words: ${shared.join(", ")}`);
    }
    return { ...t, score, reasons };
  });

  // 3. Threads linked to strongly matching threads get a share of their score.
  const base = new Map(scored.map((t) => [t.id, t.score]));
  for (const t of scored) {
    const best = Math.max(0, ...t.links.map((l) => base.get(l.threadId) ?? 0));
    if (best > 0) {
      t.score += best * 0.3;
      t.reasons.push("linked to a match");
    }
  }

  // 4. Small tie-breaker for recently active threads.
  for (const t of scored) {
    if (t.lastTouchedSession === latestSession) t.score += 0.5;
    else if (t.lastTouchedSession === latestSession - 1) t.score += 0.25;
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
