import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { logChanges } from "./history";
import { callLlm } from "./llm";
import { recordInterplayChanges } from "./interplay-history";
import { checkEvidence } from "./review";
import { THREAD_ROLES } from "./world/links";

// The part each character plays in a thread (seeker, cause, key…) and how much a thread matters.
// The engine's moves are built from these. Manual and read-from-notes values are equal citizens:
// the DM's always stand, and reading only fills what's still blank.

type Source = "dm" | "inferred";
interface WriteOpts {
  source: Source;
  batch?: string;
  note?: string;
}

export async function setThreadPart(threadId: number, entityId: number, role: string, opts: WriteOpts) {
  if (!THREAD_ROLES[role]) throw new Error("Loom doesn't know that part.");
  const [row] = await db.select().from(schema.threadEntities).where(and(eq(schema.threadEntities.threadId, threadId), eq(schema.threadEntities.entityId, entityId)));
  if (!row) throw new Error("They aren't in that thread.");
  if (opts.source !== "dm" && row.role !== "involved") return false;
  if (row.role === role && row.roleSource === opts.source) return false;
  const [t] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
  await db.update(schema.threadEntities).set({ role, roleSource: opts.source }).where(and(eq(schema.threadEntities.threadId, threadId), eq(schema.threadEntities.entityId, entityId)));
  await logChanges([{ campaignId: t.campaignId, subject: t.title, entityId, threadId, kind: "thread-detail", field: `role:${entityId}`, before: { entityId, role: row.role, roleSource: row.roleSource }, after: { entityId, role }, source: opts.source, batch: opts.batch, note: opts.note }]);
  return true;
}

export async function setThreadStakes(threadId: number, level: number | null, opts: WriteOpts) {
  const [t] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
  if (!t) throw new Error("That isn't in the loom any more.");
  if (opts.source !== "dm" && (t.stakesLevel != null || t.fieldMeta.stakesLevel?.source === "dm")) return false;
  if (t.stakesLevel === level) return false;
  const fieldMeta = { ...t.fieldMeta };
  if (level == null) delete fieldMeta.stakesLevel;
  else fieldMeta.stakesLevel = { source: opts.source, at: new Date().toISOString() };
  await db.update(schema.threads).set({ stakesLevel: level, fieldMeta }).where(eq(schema.threads.id, threadId));
  await logChanges([{ campaignId: t.campaignId, subject: t.title, threadId, kind: "thread-detail", field: "stakesLevel", before: { stakesLevel: t.stakesLevel, meta: t.fieldMeta.stakesLevel ?? null }, after: { stakesLevel: level }, source: opts.source, batch: opts.batch, note: opts.note }]);
  return true;
}

/** Undo for the two writes above. */
export async function reverseThreadDetail(threadId: number, before: Record<string, unknown>) {
  if (before.entityId != null) {
    await db.update(schema.threadEntities).set({ role: String(before.role), roleSource: (before.roleSource as string | null) ?? null }).where(and(eq(schema.threadEntities.threadId, threadId), eq(schema.threadEntities.entityId, Number(before.entityId))));
    return;
  }
  const [t] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
  if (!t) return;
  const fieldMeta = { ...t.fieldMeta };
  if (before.meta) fieldMeta.stakesLevel = before.meta as (typeof fieldMeta)[string];
  else delete fieldMeta.stakesLevel;
  await db.update(schema.threads).set({ stakesLevel: (before.stakesLevel as number | null) ?? null, fieldMeta }).where(eq(schema.threads.id, threadId));
}

const ROLES = Object.keys(THREAD_ROLES) as [string, ...string[]];
const roleLines = Object.entries(THREAD_ROLES).filter(([r]) => r !== "involved").map(([r, d]) => `- ${r}: ${d.says}`).join("\n");

const SYSTEM = `You read a tabletop game master's session notes and say what part each character, item, place or faction plays in each open thread, and how much each thread matters.

Parts:
${roleLines}
- involved: the notes don't say; leave it unknown.

Rules:
- Only what the notes or the thread's own summary support. "involved" beats a guess: blanks are better than wrong values.
- "evidence" is a short exact quote from the notes or the summary that shows it.
- A place where it happens is "place"; use another part for a place only if the thread turns on it (a prize, a key).
- Pick the part that gives the thread somewhere to go: someone chasing it is a seeker, someone who could explain it an informant, what would open it a key.
- Stakes: 1 a loose end, 2 a small matter, 3 it matters to someone at the table, 4 a big problem, 5 the campaign turns on it. Leave out any thread the notes give no sense of.`;

/**
 * Reads every stored recap for the parts and stakes still blank, and fills them in as Loom's reading.
 * Nothing the DM set changes, and one undo takes it all back. Runs after notes are saved, and
 * from the "parts" command for a campaign that already has notes.
 */
export async function readThreadParts(campaignId: number, opts: { batch?: string; model?: string } = {}) {
  const open = await db.select().from(schema.threads).where(and(eq(schema.threads.campaignId, campaignId), ne(schema.threads.status, "resolved")));
  if (!open.length) return null;
  const allLinks = await db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, open.map((t) => t.id)));
  // Each part and stake is read once: what the notes didn't support is marked, so saving more notes
  // only pays for what's new.
  const blank = allLinks.filter((l) => l.role === "involved" && l.roleSource == null);
  const unrated = open.filter((t) => t.stakesLevel == null && !t.fieldMeta.stakesLevel);
  if (!blank.length && !unrated.length) return null;
  const threads = open.filter((t) => unrated.includes(t) || blank.some((l) => l.threadId === t.id));
  const links = allLinks.filter((l) => threads.some((t) => t.id === l.threadId));
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const nameOf = new Map(entities.map((e) => [e.id, e.name]));
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(schema.sessions.number);
  const notes = sessions.filter((s) => s.recap.trim()).map((s) => `Session ${s.number}\n${s.recap}`).join("\n\n");
  if (!notes && !threads.some((t) => t.summary)) return null;
  const threadLines = threads.map((t) => {
    const who = links.filter((l) => l.threadId === t.id);
    return `T${t.id} [${t.kind}] ${t.title}: ${t.summary}\n  Who's in it: ${who.map((l) => `${nameOf.get(l.entityId)}${blank.includes(l) ? " (?)" : ` (${l.role})`}`).join(", ") || "nobody listed"}`;
  });
  const names = [...new Set(blank.map((l) => nameOf.get(l.entityId)).filter((n): n is string => !!n))] as [string, ...string[]];
  const ids = threads.map((t) => `T${t.id}`) as [string, ...string[]];
  const Schema = z.object({
    parts: z.array(z.object({ thread: z.enum(ids), who: names.length ? z.enum(names) : z.string(), part: z.enum(ROLES), evidence: z.string() })),
    stakes: z.array(z.object({ thread: z.enum(ids), level: z.number().int().min(1).max(5), evidence: z.string() })),
  });
  const res = await callLlm({ feature: "parts", campaignId, system: SYSTEM, prompt: `THREADS (a "?" is a part to fill in; give a part for each one the notes support)\n${threadLines.join("\n")}\n\nTHE NOTES\n${notes || "(no session notes yet; use the summaries)"}`, schema: Schema, maxTokens: 6000, effort: "low", model: opts.model });
  const hay = `${notes}\n${threads.map((t) => `${t.title} ${t.summary}`).join("\n")}`;
  const backed = (e: string) => checkEvidence(e, hay) !== "not-found" && checkEvidence(e, hay) !== "missing";
  const batch = opts.batch ?? `parts c${campaignId} ${new Date().toISOString().slice(0, 16)}`;
  const idOf = new Map(entities.map((e) => [e.name, e.id]));
  let parts = 0;
  let stakes = 0;
  let skipped = 0;
  for (const p of res.data.parts) {
    const threadId = Number(p.thread.slice(1));
    const entityId = idOf.get(p.who);
    if (p.part === "involved" || !entityId || !blank.some((l) => l.threadId === threadId && l.entityId === entityId)) continue;
    if (!backed(p.evidence)) {
      skipped++;
      continue;
    }
    if (await setThreadPart(threadId, entityId, p.part, { source: "inferred", batch, note: `read from: "${p.evidence.slice(0, 80)}"` })) parts++;
  }
  for (const s of res.data.stakes) {
    if (!backed(s.evidence)) {
      skipped++;
      continue;
    }
    if (await setThreadStakes(Number(s.thread.slice(1)), s.level, { source: "inferred", batch, note: `read from: "${s.evidence.slice(0, 80)}"` })) stakes++;
  }
  for (const l of blank) await db.update(schema.threadEntities).set({ roleSource: "read" }).where(and(eq(schema.threadEntities.threadId, l.threadId), eq(schema.threadEntities.entityId, l.entityId), eq(schema.threadEntities.role, "involved")));
  for (const t of unrated) {
    const [now] = await db.select().from(schema.threads).where(eq(schema.threads.id, t.id));
    if (now.stakesLevel == null) await db.update(schema.threads).set({ fieldMeta: { ...now.fieldMeta, stakesLevel: { source: "inferred", at: new Date().toISOString() } } }).where(eq(schema.threads.id, t.id));
  }
  await recordInterplayChanges(campaignId, batch).catch(() => {});
  return { parts, stakes, skipped, of: blank.length, batch, model: res.model, latencyMs: res.latencyMs, costUsd: res.costUsd };
}
