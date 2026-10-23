import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import { MOMENT_TONES } from "./db/schema";

// Key moments (L4): the curated history callbacks draw on. The DM flags them, or accepts the ones
// Loom suggests from recaps.

export type Tone = (typeof MOMENT_TONES)[number];
export type MomentStatus = "key" | "suggested" | "dismissed";

export interface MomentInput {
  title: string;
  description?: string;
  tone?: Tone;
  callback?: string;
  entityIds?: number[];
  threadIds?: number[];
  sessionId?: number | null;
}

export async function addMoment(campaignId: number, input: MomentInput, source: "dm" | "extracted", status: MomentStatus) {
  let sessionId = input.sessionId ?? null;
  if (sessionId == null) {
    const [latest] = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(desc(schema.sessions.number)).limit(1);
    sessionId = latest?.id ?? null;
  }
  const tone = input.tone && (MOMENT_TONES as readonly string[]).includes(input.tone) ? input.tone : "other";
  const [row] = await db
    .insert(schema.keyMoments)
    .values({
      campaignId,
      sessionId,
      title: input.title,
      description: input.description ?? "",
      tone,
      callback: input.callback ?? "",
      entityIds: [...new Set(input.entityIds ?? [])],
      threadIds: [...new Set(input.threadIds ?? [])],
      status,
      source,
    })
    .returning();
  return row;
}

export async function setMomentStatus(campaignId: number, id: number, status: MomentStatus) {
  const rows = await db
    .update(schema.keyMoments)
    .set({ status })
    .where(and(eq(schema.keyMoments.campaignId, campaignId), eq(schema.keyMoments.id, id)))
    .returning();
  return rows[0];
}

export interface MomentView {
  id: number;
  session: number | null;
  title: string;
  description: string;
  tone: string;
  callback: string;
  entities: string[];
  threads: { id: number; title: string }[];
  status: MomentStatus;
}

export async function listMoments(campaignId: number, statuses: MomentStatus[] = ["key"]): Promise<MomentView[]> {
  const rows = await db
    .select()
    .from(schema.keyMoments)
    .where(and(eq(schema.keyMoments.campaignId, campaignId), inArray(schema.keyMoments.status, statuses)))
    .orderBy(schema.keyMoments.id);
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const entities = await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const threads = await db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
  return rows.map((m) => ({
    id: m.id,
    session: sessions.find((s) => s.id === m.sessionId)?.number ?? null,
    title: m.title,
    description: m.description,
    tone: m.tone,
    callback: m.callback,
    entities: m.entityIds.map((id) => entities.find((e) => e.id === id)?.name).filter((n): n is string => Boolean(n)),
    threads: m.threadIds.map((id) => threads.find((t) => t.id === id)).filter((t): t is { id: number; title: string } => Boolean(t)),
    status: m.status,
  }));
}

// One line per moment, for prompts.
export function momentLine(m: MomentView) {
  const where = m.session != null ? `session ${m.session}` : "earlier";
  return `M${m.id} (${where}, ${m.tone}) ${m.title}: ${m.description}${m.entities.length ? ` [${m.entities.join(", ")}]` : ""}${m.callback ? ` Callback idea: ${m.callback}` : ""}`;
}
