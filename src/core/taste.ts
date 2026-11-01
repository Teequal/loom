import { desc, eq } from "drizzle-orm";
import { db, schema } from "./db/client";

// What Loom has learned about this GM from how they play: an active default, worked out from the
// live log in code, with no model call. Using an option counts for it and, weakly, against the
// ones passed over; a thumbs up or down counts more; a reason for a thumbs down moves the two
// dials directly (how long and how dramatic). It's recomputed from the log, so a mistaken vote can
// be changed, recent play counts most, and a reset just starts counting from now.

export const VOTE_REASONS = ["long", "dramatic", "flat", "wrong"] as const;
export type VoteReason = (typeof VOTE_REASONS)[number];
export interface Vote {
  vote: 1 | -1;
  why?: VoteReason;
  // Where a vote isn't on one of the entry's options (a Develop take): what it was.
  move?: string;
  flavour?: string;
}

export interface Taste {
  on: boolean;
  signals: number; // how much there is to go on
  flavour: Record<string, number>; // −1…+1
  move: Record<string, number>;
  rolls: number; // −1…+1: rolls over questions
  tone: number; // steps on the drama dial, −2…+2
  length: number; // −1, 0 or +1
}
export const NO_TASTE: Taste = { on: false, signals: 0, flavour: {}, move: {}, rolls: 0, tone: 0, length: 0 };

const USED = 1;
const PASSED_OVER = -0.25; // shown beside one that was used: a whisper, not a verdict
const VOTED = 1.5;
const DECAY = 0.85; // per session back
const PRIOR = 4; // how much counts as "nothing known"
const MIN_SIGNALS = 6; // below this, Loom says nothing and changes nothing

type Row = Pick<typeof schema.liveEntries.$inferSelect, "id" | "sessionNumber" | "options" | "choiceKind" | "choiceLabel" | "choice" | "votes">;
type Tally = Map<string, { sum: number; weight: number }>;
const count = (t: Tally, key: string | null | undefined, signal: number) => {
  if (!key) return;
  const c = t.get(key) ?? { sum: 0, weight: 0 };
  c.sum += signal;
  c.weight += Math.abs(signal);
  t.set(key, c);
};
const lifts = (t: Tally) => Object.fromEntries([...t].map(([k, c]) => [k, c.sum / (c.weight + PRIOR)]));
const moveOf = (o: { scaffold?: unknown }) => (o.scaffold as { moveInfo?: { kind?: string } } | undefined)?.moveInfo?.kind;
const rollsOf = (o: { needs?: string | null }) => o.needs === "roll";

export function computeTaste(rows: Row[], on = true): Taste {
  if (!on || !rows.length) return { ...NO_TASTE, on };
  const latest = Math.max(...rows.map((r) => r.sessionNumber));
  const flavour: Tally = new Map();
  const move: Tally = new Map();
  const rolls: Tally = new Map();
  let signals = 0;
  let tone = 0;
  let length = 0;
  for (const r of rows) {
    const fade = DECAY ** (latest - r.sessionNumber);
    const add = (o: { flavour?: string | null; scaffold?: unknown; needs?: string | null }, signal: number) => {
      count(flavour, o.flavour, signal * fade);
      count(move, moveOf(o), signal * fade);
      count(rolls, rollsOf(o) ? "roll" : "other", signal * fade);
      signals += Math.abs(signal) * fade;
    };
    const used = r.choiceKind === "option" ? r.options.findIndex((o) => o.label === r.choiceLabel || o.text === r.choice) : -1;
    // Their own words instead of any option passes over all of them.
    if (r.choiceKind === "own" || used >= 0) r.options.forEach((o, i) => i !== used && add(o, PASSED_OVER));
    if (used >= 0) add(r.options[used], USED);
    for (const [key, v] of Object.entries(r.votes ?? {})) {
      const shown = /^\d+$/.test(key) ? r.options[Number(key)] : undefined;
      const on = shown ?? { flavour: v.flavour, needs: null, scaffold: { moveInfo: { kind: v.move } } };
      add(on, v.vote * VOTED);
      if (v.why === "dramatic") tone -= fade;
      if (v.why === "flat") tone += fade;
      if (v.why === "long") length -= fade;
    }
  }
  if (signals < MIN_SIGNALS) return { ...NO_TASTE, on };
  const lean = lifts(rolls);
  const steps = (n: number) => Math.sign(n) * (Math.abs(n) >= 5 ? 2 : Math.abs(n) >= 2 ? 1 : 0);
  return { on, signals, flavour: lifts(flavour), move: lifts(move), rolls: (lean.roll ?? 0) - (lean.other ?? 0), tone: steps(tone), length: length <= -2 ? -1 : 0 };
}

export async function loadTaste(campaignId: number): Promise<Taste> {
  const [c] = await db.select({ learn: schema.campaigns.learn, from: schema.campaigns.learnFrom }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!c?.learn) return { ...NO_TASTE, on: false };
  const rows = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.campaignId, campaignId)).orderBy(desc(schema.liveEntries.id)).limit(300);
  return computeTaste(rows.filter((r) => r.id > c.from));
}

const leaning = (lift: Record<string, number>) => Object.entries(lift).filter(([, v]) => Math.abs(v) >= 0.2).sort((a, b) => b[1] - a[1]);

/** The prompt's line. Empty until there's something to say. */
export function tasteBlock(t: Taste) {
  const up = leaning(t.flavour).filter(([, v]) => v > 0).map(([k]) => k);
  const down = leaning(t.flavour).filter(([, v]) => v < 0).map(([k]) => k);
  const bits = [up.length && `tends to use ${up.join(", ")} options`, down.length && `rarely uses ${down.join(", ")} ones`, t.rolls >= 0.2 && "likes a roll", t.rolls <= -0.2 && "prefers a question to a roll"].filter(Boolean);
  return bits.length ? `\nTHIS GM (learned from what they use: lean this way without repeating yourself): ${bits.join("; ")}.\n` : "";
}

/** The same, for the GM to read. */
export function tasteLines(t: Taste) {
  const name = (k: string) => k.replace(/^./, (c) => c.toUpperCase());
  const lines = leaning(t.flavour).map(([k, v]) => `${name(k)} options: ${v > 0 ? "you use these, so Loom offers more" : "you pass on these, so Loom offers fewer"}`);
  if (t.rolls >= 0.2) lines.push("Rolls: you like them, so Loom ends on more of them");
  if (t.rolls <= -0.2) lines.push("Questions: you prefer them to rolls, so Loom asks more");
  if (t.tone) lines.push(`Drama: ${Math.abs(t.tone)} step${Math.abs(t.tone) > 1 ? "s" : ""} ${t.tone < 0 ? "calmer" : "bolder"} than your setting`);
  if (t.length) lines.push("Length: one size shorter");
  return lines;
}

/** Records or clears a vote. A vote on a Develop take names what it was. */
export async function setVote(entryId: number, key: string, vote: Vote | null) {
  const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!e) throw new Error("That moment has gone.");
  const votes = { ...(e.votes ?? {}) };
  if (vote) votes[key] = vote;
  else delete votes[key];
  await db.update(schema.liveEntries).set({ votes }).where(eq(schema.liveEntries.id, entryId));
}
