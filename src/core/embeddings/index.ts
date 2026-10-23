import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { EntityTraits } from "../entity-fields";
import { loadThreadContexts } from "../retrieval";
import { cosine, type EmbeddingProvider } from "./providers";

export { cosine, embeddingProvider, localProvider, voyageProvider, type EmbeddingProvider } from "./providers";

// Embeddings as a derived property: what text represents each thread, entity, key moment and
// recap scene; keeping vectors fresh (only re-embedding what changed); and searching by meaning.

type OwnerType = "thread" | "entity" | "moment" | "scene";
interface Doc {
  ownerType: OwnerType;
  ownerId: number;
  chunk: number;
  text: string;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");
const toBuffer = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBuffer = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// Splits a recap into scenes of a few sentences, so a callback can quote the right part.
function scenes(recap: string) {
  const parts: string[] = [];
  let cur = "";
  for (const line of recap.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    cur = cur ? `${cur} ${line}` : line;
    if (cur.length >= 350) {
      parts.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function documents(campaignId: number): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const t of await loadThreadContexts(campaignId)) {
    docs.push({ ownerType: "thread", ownerId: t.id, chunk: 0, text: `${t.title}. ${t.summary} ${t.latestNote}${t.entities.length ? ` Involves: ${t.entities.join(", ")}.` : ""}` });
  }

  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const relations = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId));
  const name = new Map(entities.map((e) => [e.id, e.name]));
  for (const e of entities) {
    const t = e.traits as EntityTraits;
    const traitText = (["race", "occupation", "goal", "wants", "fears", "abilities", "known_properties", "hazards", "atmosphere", "location_type", "plan"] as const)
      .map((k) => t[k])
      .filter((v) => (Array.isArray(v) ? v.length : v))
      .map((v) => (Array.isArray(v) ? v.join("; ") : v))
      .join(". ");
    const rels = relations
      .filter((r) => (r.fromEntityId === e.id || r.toEntityId === e.id) && !r.secret)
      .slice(0, 6)
      .map((r) => `${name.get(r.fromEntityId)} ${r.type.replace(/_/g, " ")} ${name.get(r.toEntityId)}`);
    docs.push({
      ownerType: "entity",
      ownerId: e.id,
      chunk: 0,
      text: `${e.name} (${e.type})${e.aliases.length ? `, also called ${e.aliases.join(", ")}` : ""}. ${e.description} ${traitText}${rels.length ? `. ${rels.join("; ")}` : ""}`,
    });
  }

  const moments = await db
    .select()
    .from(schema.keyMoments)
    .where(and(eq(schema.keyMoments.campaignId, campaignId), inArray(schema.keyMoments.status, ["key", "suggested"])));
  for (const m of moments) docs.push({ ownerType: "moment", ownerId: m.id, chunk: 0, text: `${m.title}. ${m.description} ${m.callback}` });

  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  for (const s of sessions) scenes(s.recap).forEach((text, i) => docs.push({ ownerType: "scene", ownerId: s.id, chunk: i, text }));
  return docs;
}

// Brings vectors up to date: embeds only what's new or whose text changed, drops what's gone.
export async function ensureEmbeddings(campaignId: number, provider: EmbeddingProvider) {
  const docs = await documents(campaignId);
  const existing = await db
    .select({ id: schema.embeddings.id, ownerType: schema.embeddings.ownerType, ownerId: schema.embeddings.ownerId, chunk: schema.embeddings.chunk, textHash: schema.embeddings.textHash })
    .from(schema.embeddings)
    .where(and(eq(schema.embeddings.campaignId, campaignId), eq(schema.embeddings.model, provider.model)));
  const key = (d: { ownerType: string; ownerId: number; chunk: number }) => `${d.ownerType}:${d.ownerId}:${d.chunk}`;
  const have = new Map(existing.map((e) => [key(e), e]));
  const wanted = new Set(docs.map(key));

  const stale = docs.filter((d) => have.get(key(d))?.textHash !== hash(d.text));
  const gone = existing.filter((e) => !wanted.has(key(e)));
  if (gone.length) await db.delete(schema.embeddings).where(inArray(schema.embeddings.id, gone.map((g) => g.id)));

  for (let i = 0; i < stale.length; i += 32) {
    const batch = stale.slice(i, i + 32);
    const vectors = await provider.embed(batch.map((d) => d.text), "document");
    for (const [j, d] of batch.entries()) {
      const row = { campaignId, ownerType: d.ownerType, ownerId: d.ownerId, chunk: d.chunk, model: provider.model, textHash: hash(d.text), text: d.text, vector: toBuffer(vectors[j]) };
      const prev = have.get(key(d));
      if (prev) await db.update(schema.embeddings).set(row).where(eq(schema.embeddings.id, prev.id));
      else await db.insert(schema.embeddings).values(row);
    }
  }
  return { total: docs.length, embedded: stale.length, removed: gone.length };
}

export interface Hit {
  ownerType: OwnerType;
  ownerId: number;
  chunk: number;
  text: string;
  sim: number;
  z: number; // how far above the typical match for its kind (standard deviations)
}

// Searches by meaning. Scores are compared within each kind (threads with threads…), so "z" says
// how unusually close a match is, which works across models without hand-tuned thresholds.
export async function searchByMeaning(campaignId: number, provider: EmbeddingProvider, query: string) {
  const [q] = await provider.embed([query], "query");
  const rows = await db
    .select()
    .from(schema.embeddings)
    .where(and(eq(schema.embeddings.campaignId, campaignId), eq(schema.embeddings.model, provider.model)));
  const byType = new Map<OwnerType, Hit[]>();
  for (const r of rows) {
    const hit: Hit = { ownerType: r.ownerType, ownerId: r.ownerId, chunk: r.chunk, text: r.text, sim: cosine(q, fromBuffer(r.vector as Buffer)), z: 0 };
    byType.set(r.ownerType, [...(byType.get(r.ownerType) ?? []), hit]);
  }
  for (const hits of byType.values()) {
    const mean = hits.reduce((s, h) => s + h.sim, 0) / hits.length;
    const sd = Math.sqrt(hits.reduce((s, h) => s + (h.sim - mean) ** 2, 0) / hits.length) || 1;
    for (const h of hits) h.z = (h.sim - mean) / sd;
    hits.sort((a, b) => b.sim - a.sim);
  }
  return {
    threads: byType.get("thread") ?? [],
    entities: byType.get("entity") ?? [],
    moments: byType.get("moment") ?? [],
    scenes: byType.get("scene") ?? [],
  };
}
export type MeaningSearch = Awaited<ReturnType<typeof searchByMeaning>>;
