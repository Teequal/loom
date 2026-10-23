import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";
import { PILLARS, type Pillar } from "./db/schema";

// P, the player layer: who plays whom, what they enjoy, their own lines, and the spotlight (who
// has had a moment recently, who's been quiet). DM-only: it ranks suggestions, it never appears
// in them.

type Entity = typeof schema.entities.$inferSelect;
type Player = typeof schema.players.$inferSelect;

export interface Seat {
  pc: Entity;
  player: Player | null;
  lastSpotlight: number | null; // last session they had a moment of their own
  quietFor: number; // sessions since then
  recentMoments: number; // moments in the last two sessions
  exposure: number; // recency-weighted spotlight: 1 for this session, 0.5 for the one before, …
  landed: string[]; // starred moments involving them: what has worked
}

export async function tableSeats(campaignId: number): Promise<Seat[]> {
  const pcs = await db.select().from(schema.entities).where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.type, "pc")));
  const players = await db.select().from(schema.players).where(eq(schema.players.campaignId, campaignId));
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const numberOf = new Map(sessions.map((s) => [s.id, s.number]));
  const latest = Math.max(0, ...sessions.map((s) => s.number));
  const moments = await db
    .select()
    .from(schema.keyMoments)
    .where(and(eq(schema.keyMoments.campaignId, campaignId), inArray(schema.keyMoments.status, ["key", "suggested"])));

  // Personal threads: ones about at most two PCs. A thread about the whole party isn't anyone's spotlight.
  const threads = await db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
  const links = threads.length
    ? await db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, threads.map((t) => t.id)))
    : [];
  const pcIds = new Set(pcs.map((p) => p.id));
  const pcsOnThread = new Map<number, number[]>();
  for (const l of links) if (pcIds.has(l.entityId)) pcsOnThread.set(l.threadId, [...(pcsOnThread.get(l.threadId) ?? []), l.entityId]);
  const events = threads.length
    ? await db.select().from(schema.threadEvents).where(inArray(schema.threadEvents.threadId, threads.map((t) => t.id)))
    : [];

  return pcs.map((pc) => {
    const spotlightSessions: number[] = [];
    for (const m of moments) if (m.entityIds.includes(pc.id) && m.sessionId != null) spotlightSessions.push(numberOf.get(m.sessionId) ?? 0);
    for (const e of events) {
      const who = pcsOnThread.get(e.threadId) ?? [];
      if (who.includes(pc.id) && who.length <= 2 && (e.change === "new" || e.change === "progressed") && e.sessionId != null) {
        spotlightSessions.push(numberOf.get(e.sessionId) ?? 0);
      }
    }
    const last = spotlightSessions.length ? Math.max(...spotlightSessions) : null;
    return {
      pc,
      player: players.find((p) => p.id === pc.playerId) ?? null,
      lastSpotlight: last,
      quietFor: last == null ? latest : latest - last,
      exposure: [...new Set(spotlightSessions)].reduce((sum, n) => sum + 0.5 ** (latest - n), 0),
      recentMoments: moments.filter((m) => m.entityIds.includes(pc.id) && m.sessionId != null && (numberOf.get(m.sessionId) ?? 0) >= latest - 1).length,
      landed: moments.filter((m) => m.status === "key" && m.entityIds.includes(pc.id)).map((m) => m.title),
    };
  });
}

const enjoyText = (e: Partial<Record<Pillar, number>>) =>
  PILLARS.filter((k) => (e[k] ?? 1) !== 1)
    .sort((a, b) => (e[b] ?? 1) - (e[a] ?? 1))
    .map((k) => `${k} ${e[k]}`)
    .join(", ");

// Prompt block. PCs only: real names never leave the DM's view.
export function tableText(seats: Seat[]) {
  if (!seats.length) return "";
  const lines = seats.map((s) => {
    const parts = [
      s.player && enjoyText(s.player.enjoys) && `their player enjoys ${enjoyText(s.player.enjoys)} (0-3)`,
      s.lastSpotlight != null ? `last moment of their own: session ${s.lastSpotlight}${s.quietFor > 0 ? ` (quiet for ${s.quietFor})` : ""}` : "no moment of their own yet",
      s.landed.length && `has landed: ${s.landed.join("; ")}`,
      s.player?.personalLines.length && `avoid for this player: ${s.player.personalLines.join("; ")}`,
      s.player?.tableNotes && `GM note: ${s.player.tableNotes}`,
    ].filter(Boolean);
    return `- ${s.pc.name}: ${parts.join("; ")}`;
  });
  return `THE TABLE (for choosing who gets the spotlight; never mention players or these notes)\n${lines.join("\n")}`;
}

// How much an option is worth to the person it hands off to: what they enjoy, plus a nudge for
// whoever has been quiet longest.
export function spotlightScore(seats: Seat[], target: string, pillar: Pillar) {
  const enjoy = (s: Seat) => s.player?.enjoys[pillar] ?? 1;
  if (target === "table") return seats.length ? seats.reduce((sum, s) => sum + enjoy(s), 0) / seats.length : 1;
  const seat = seats.find((s) => s.pc.name === target);
  if (!seat) return 1;
  // Recent spotlight counts more than old: each past session of theirs fades by half per session
  // since. The nudge for low exposure stays under one point of what a player enjoys.
  return enjoy(seat) + 0.3 * (1 - Math.min(seat.exposure, 1)) + Math.min(seat.quietFor, 3) * 0.1;
}

export function parseEnjoys(raw: string): Partial<Record<Pillar, number>> {
  const out: Partial<Record<Pillar, number>> = {};
  for (const part of raw.split(/[,;]/)) {
    const m = part.trim().toLowerCase().match(/^([a-z]+)\s*[:=]?\s*(\d)$/);
    if (!m) continue;
    if (!(PILLARS as readonly string[]).includes(m[1])) throw new Error(`"${m[1]}" isn't one of: ${PILLARS.join(", ")}`);
    out[m[1] as Pillar] = Math.max(0, Math.min(3, Number(m[2])));
  }
  return out;
}

export async function personalLines(campaignId: number) {
  const players = await db.select().from(schema.players).where(eq(schema.players.campaignId, campaignId));
  return players.flatMap((p) => p.personalLines);
}
