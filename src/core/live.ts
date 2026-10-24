import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db/client";
import { applyProposal, numberItems, proposeRecapChanges, type ProposalFile } from "./recap";
import { reviewProposal, splitRisky } from "./review";
import { undoBatch } from "./undo";

// The session in progress, as it happens at the table. Every moment asked about is logged; when
// the GM uses an option (or writes their own), that choice is extracted straight away, so the
// next suggestion already knows what changed. Low-risk changes go in automatically; risky ones
// wait as questions. Wrap-up turns the log into the session's notes.

type Entry = typeof schema.liveEntries.$inferSelect;

// The session being played: the one with unwrapped entries, or the next one.
export async function liveSessionNumber(campaignId: number) {
  const [open] = await db
    .select({ n: schema.liveEntries.sessionNumber })
    .from(schema.liveEntries)
    .where(and(eq(schema.liveEntries.campaignId, campaignId), eq(schema.liveEntries.wrapped, false)))
    .limit(1);
  if (open) return open.n;
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(desc(schema.sessions.number));
  for (const s of sessions) {
    // A session whose saves were all undone doesn't count.
    const [live] = await db
      .select({ id: schema.stateChanges.id })
      .from(schema.stateChanges)
      .where(and(eq(schema.stateChanges.sessionId, s.id), isNull(schema.stateChanges.undoneAt)))
      .limit(1);
    const [event] = await db.select({ id: schema.threadEvents.id }).from(schema.threadEvents).where(eq(schema.threadEvents.sessionId, s.id)).limit(1);
    if (live || event) return s.number + 1;
  }
  return 1;
}

export async function logAsk(campaignId: number, moment: string, options: Entry["options"]) {
  const [e] = await db.insert(schema.liveEntries).values({ campaignId, sessionNumber: await liveSessionNumber(campaignId), moment, options }).returning();
  return e;
}

export async function liveEntries(campaignId: number) {
  return db
    .select()
    .from(schema.liveEntries)
    .where(and(eq(schema.liveEntries.campaignId, campaignId), eq(schema.liveEntries.wrapped, false)))
    .orderBy(asc(schema.liveEntries.id));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// What has happened this session, for the next suggestion's prompt: the choices made, newest last.
export async function sessionSoFar(campaignId: number, limit = 8) {
  const used = (await liveEntries(campaignId)).filter((e) => e.choiceKind);
  if (!used.length) return "";
  return used
    .slice(-limit)
    .map((e) => `- ${clip(e.moment, 160)} → ${clip(e.choice, 260)}`)
    .join("\n");
}

// The session's notes as drafted from the log: what the players did and what happened.
export async function draftNotes(campaignId: number) {
  const entries = (await liveEntries(campaignId)).filter((e) => e.choiceKind);
  return entries.map((e) => `- ${e.moment}\n  What happened: ${e.choice}`).join("\n");
}

const proposalPath = (e: Entry) => `data/proposals/live-c${e.campaignId}-e${e.id}.json`;
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Extractions for one campaign run one at a time, so two quick choices can't both add the same
// new thread.
const queues = new Map<number, Promise<unknown>>();
function queued<T>(campaignId: number, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(campaignId) ?? Promise.resolve()).catch(() => {}).then(job);
  queues.set(campaignId, next);
  return next;
}

export async function commitChoice(entryId: number, choice: { kind: "option" | "own"; label: string; text: string }) {
  const [e] = await db
    .update(schema.liveEntries)
    .set({ choiceKind: choice.kind, choiceLabel: choice.label, choice: choice.text, status: "extracting" })
    .where(eq(schema.liveEntries.id, entryId))
    .returning();
  return e;
}

// Extracts one choice into the loom. Called after the response, in the background.
export function extractEntry(entryId: number) {
  return db
    .select()
    .from(schema.liveEntries)
    .where(eq(schema.liveEntries.id, entryId))
    .then(([e]) => (e ? queued(e.campaignId, () => runExtraction(e)) : undefined));
}

async function runExtraction(e: Entry) {
  try {
    // Undo what an earlier pick for this moment added, so changing your mind doesn't double up.
    if (e.batch) await undoBatch(e.campaignId, e.batch, { force: true });
    const text = `The players: ${e.moment}\nWhat happened: ${e.choice}`;
    const res = await proposeRecapChanges(e.campaignId, text, undefined, { live: true });
    const file: ProposalFile = await splitRisky({ kind: "live", campaignId: e.campaignId, sessionNumber: e.sessionNumber, recap: text, proposal: res.data });
    mkdirSync("data/proposals", { recursive: true });
    writeFileSync(proposalPath(e), JSON.stringify(file, null, 2));
    const reviewed = await reviewProposal(file);
    const must = reviewed.filter((r) => r.tier === "must");
    const batch = `live s${e.sessionNumber} ${stamp()} #e${e.id}`;
    const applied = reviewed.filter((r) => r.tier !== "must");
    if (applied.length) await applyProposal(file, new Set(must.map((r) => r.item.n)), batch);
    await db
      .update(schema.liveEntries)
      .set({
        status: "done",
        batch,
        // "Threads" items already say which thread; details need to say whose.
        summary: applied.map((r) => (r.group === "Threads" ? r.summary : `${r.group}: ${r.summary}`)),
        questions: must.map((r) => ({ n: r.item.n, group: r.group, summary: r.summary, reasons: r.reasons, evidence: r.evidence, answer: null })),
      })
      .where(eq(schema.liveEntries.id, e.id));
  } catch (err) {
    console.error(err);
    await db.update(schema.liveEntries).set({ status: "failed" }).where(eq(schema.liveEntries.id, e.id));
  }
}

// A yes applies that one risky change as the GM's own entry, in the same batch as the rest.
export async function answerQuestion(entryId: number, n: number, yes: boolean) {
  const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!e) throw new Error("That moment isn't in the log any more.");
  const q = e.questions.find((x) => x.n === n);
  if (!q || q.answer) return e;
  if (yes) {
    const file = JSON.parse(readFileSync(proposalPath(e), "utf8")) as ProposalFile;
    const others = numberItems(file.proposal).map((i) => i.n).filter((x) => x !== n);
    await queued(e.campaignId, () => applyProposal(file, new Set(others), e.batch ?? undefined, new Set([n])));
  }
  const questions = e.questions.map((x) => (x.n === n ? { ...x, answer: yes ? ("yes" as const) : ("no" as const) } : x));
  const summary = yes ? [...e.summary, q.group === "Threads" ? q.summary : `${q.group}: ${q.summary}`] : e.summary;
  const [next] = await db.update(schema.liveEntries).set({ questions, summary }).where(eq(schema.liveEntries.id, entryId)).returning();
  return next;
}

// Takes a choice back: undoes what it added and returns the moment to "asked".
export async function clearChoice(entryId: number) {
  const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!e) throw new Error("That moment isn't in the log any more.");
  const r = e.batch ? await queued(e.campaignId, () => undoBatch(e.campaignId, e.batch!, { force: true })) : null;
  const [next] = await db
    .update(schema.liveEntries)
    .set({ choiceKind: null, choiceLabel: "", choice: "", status: "asked", batch: null, summary: [], questions: [] })
    .where(eq(schema.liveEntries.id, entryId))
    .returning();
  return { entry: next, undone: r?.undone ?? 0 };
}

// Closes the session in progress: the log is kept for the record, and the next moment starts a
// new session.
export async function wrapLiveSession(campaignId: number) {
  await db
    .update(schema.liveEntries)
    .set({ wrapped: true })
    .where(and(eq(schema.liveEntries.campaignId, campaignId), eq(schema.liveEntries.wrapped, false)));
}
