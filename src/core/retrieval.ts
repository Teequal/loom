import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { MeaningSearch } from "./embeddings";

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

const MEANING_WEIGHT = 2;

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

// Entities named in a piece of text, by name → weight. A full name or alias counts more than
// a single distinctive word from a name ("Vex" for "Professor Aldric Vex").
export function findMentions(entities: { name: string; aliases: string[] }[], text: string) {
  const lower = text.toLowerCase();
  const textTokens = new Set(tokens(text));
  const nameTokenCounts = new Map<string, number>();
  for (const e of entities) for (const t of new Set(tokens(e.name))) nameTokenCounts.set(t, (nameTokenCounts.get(t) ?? 0) + 1);

  const hits = new Map<string, number>();
  for (const e of entities) {
    if ([e.name, ...e.aliases].some((n) => mentions(lower, n))) hits.set(e.name, 3);
    else if (tokens(e.name).some((t) => t.length >= 4 && (nameTokenCounts.get(t) ?? 0) <= 2 && textTokens.has(t))) hits.set(e.name, 2);
  }
  return hits;
}

export interface ThreadSelection {
  min: number; // always send at least this many (by rank)
  max: number; // never more than this
  cutoff: number; // also send anything scoring at least this share of the best match (0-1)
  full: number; // how many get full detail; the rest go as one-liners
  exact?: number; // a fixed count instead (the --threads override), plus guaranteed ones
}

export interface SelectedThread extends ScoredThread {
  detail: "full" | "line";
  guaranteed: boolean; // tied to something the moment names
}

// Adaptive thread selection: a focused moment gets a few threads, a sprawling one more.
// Threads tied directly to anything the moment names are always kept, whatever their rank
// (Khayiulad's heresy bounty when Khayiulad is named). The strongest few go in full; the rest as
// one-liners, which cost almost nothing (latency is output-bound).
export function selectThreads(ranked: ScoredThread[], named: Set<string>, sel: ThreadSelection): SelectedThread[] {
  if (!ranked.length) return [];
  const top = ranked[0].score;
  const guaranteed = new Set(ranked.filter((t) => t.entities.some((n) => named.has(n))).map((t) => t.id));
  const picked: ScoredThread[] = [];
  const add = (t: ScoredThread) => {
    if (!picked.includes(t)) picked.push(t);
  };

  if (sel.exact != null) {
    ranked.slice(0, sel.exact).forEach(add);
    ranked.filter((t) => guaranteed.has(t.id)).forEach(add);
  } else {
    ranked.filter((t) => guaranteed.has(t.id)).slice(0, sel.max).forEach(add);
    // A moment that names nothing ("they start a bar fight") gets a few more hooks to choose from.
    ranked.slice(0, named.size ? sel.min : Math.max(sel.min, 6)).forEach(add);
    for (const t of ranked) if (picked.length < sel.max && t.score > 0 && t.score >= top * sel.cutoff) add(t);
  }
  const ordered = picked.sort((a, b) => b.score - a.score);
  const limit = sel.exact != null ? ordered.length : sel.max;
  return ordered.slice(0, Math.max(limit, 1)).map((t, i) => ({ ...t, detail: i < sel.full ? "full" : "line", guaranteed: guaranteed.has(t.id) }));
}

// `meaning`: optional results of searching by meaning (embeddings), blended in as extra evidence.
export async function retrieveThreads(campaignId: number, moment: string, limit = 8, meaning?: MeaningSearch): Promise<ScoredThread[]> {
  const threads = await loadThreadContexts(campaignId);
  if (threads.length === 0) return [];
  const momentTokens = new Set(tokens(moment));

  // 1. Entities named in the moment.
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const entityHits = findMentions(entities, moment);

  // 2. Word overlap, weighted so rare words count more than common ones.
  const docs = threads.map((t) => new Set(tokens(`${t.title} ${t.title} ${t.summary} ${t.latestNote}`)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + threads.length / (df.get(t) ?? threads.length));

  const latestSession = Math.max(0, ...threads.map((t) => t.lastTouchedSession ?? 0));

  // Meaning finds a scene in the notes; structure reads who's named in it. Threads involving
  // them get a boost (the tavern moment → "Locate Professor Vex" → Vex's thread).
  const inCloseScenes = new Map<string, number>();
  for (const h of meaning?.scenes.filter((x) => x.z >= 1.5).slice(0, 2) ?? []) {
    for (const [name] of findMentions(entities, h.text)) inCloseScenes.set(name, Math.max(inCloseScenes.get(name) ?? 0, h.z));
  }

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
    // Meaning: a thread unusually close to the moment (above the typical match) gains score;
    // so does one involving a character or thing that's unusually close.
    const near = meaning?.threads.find((h) => h.ownerId === t.id);
    if (near && near.z > 0.5) {
      score += (near.z - 0.5) * MEANING_WEIGHT;
      reasons.push(`meaning ${near.sim.toFixed(2)}`);
    }
    for (const name of t.entities) {
      const id = entities.find((e) => e.name === name)?.id;
      const e = meaning?.entities.find((h) => h.ownerId === id && h.z >= 1.5);
      if (e) {
        score += 1;
        reasons.push(`close in meaning: ${name}`);
        break;
      }
    }
    // A character or thing named in a scene that's close in meaning. Party-wide names (the PCs)
    // are in most scenes, so only non-PCs count.
    const fromScene = t.entities.find((n) => inCloseScenes.has(n) && entities.find((e) => e.name === n)?.type !== "pc");
    if (fromScene) {
      score += 1.5;
      reasons.push(`in a close scene: ${fromScene}`);
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
