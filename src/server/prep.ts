import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { applyProposal, newBatch, proposeRecapChanges, type ProposalFile } from "@/core/recap";
import { reviewProposal, splitRisky } from "@/core/review";
import { draftNotes, liveEntries, wrapLiveSession } from "@/core/live";
import { suggest } from "@/core/suggest";
import { recentBatches, undoBatch } from "@/core/undo";

// Between sessions, for the web pages: read a recap into a tiered proposal, apply what the GM
// accepts, undo a batch, and prep suggestions. The same engine calls the CLI makes.

const proposalPath = (campaignId: number, sessionNumber: number) => `data/proposals/web-c${campaignId}-s${sessionNumber}.json`;

// The session after the last one that still holds anything. A recap that was saved and then
// fully undone leaves its session row behind; that number is offered again.
export async function nextSessionNumber(campaignId: number) {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(desc(schema.sessions.number));
  for (const s of sessions) {
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

// The session played at the table, if any: what the log already put in the loom.
export async function liveSummary(campaignId: number) {
  const entries = await liveEntries(campaignId);
  if (!entries.length) return null;
  const used = entries.filter((e) => e.choiceKind);
  return {
    session: entries[0].sessionNumber,
    moments: entries.length,
    used: used.length,
    changes: used.reduce((n, e) => n + e.summary.length, 0),
    openQuestions: entries.reduce((n, e) => n + e.questions.filter((q) => !q.answer).length, 0),
    draft: await draftNotes(campaignId),
  };
}

export async function proposeRecap(campaignId: number, recap: string, sessionNumber?: number) {
  const live = await liveSummary(campaignId);
  const number = sessionNumber ?? live?.session ?? (await nextSessionNumber(campaignId));
  const wrapping = live && live.session === number && live.used > 0;
  // Wrapping up a session played with Loom: only what wasn't logged is extracted, and the stored
  // notes are the log plus these additions.
  const res = await proposeRecapChanges(campaignId, recap, undefined, wrapping ? { alreadyRecorded: live.draft } : {});
  const notes = wrapping ? `At the table (logged by Loom):\n${live.draft}\n\nAdded at wrap-up:\n${recap}` : recap;
  // Risky fields become their own items; the numbers the GM accepts refer to this split file.
  const file = await splitRisky({ campaignId, sessionNumber: number, recap: notes, proposal: res.data });
  mkdirSync("data/proposals", { recursive: true });
  writeFileSync(proposalPath(campaignId, number), JSON.stringify({ ...file, wrapsLive: !!wrapping }, null, 2));
  const reviewed = await reviewProposal(file);
  return {
    sessionNumber: number,
    items: reviewed.map((r) => ({ n: r.item.n, tier: r.tier, group: r.group, summary: r.summary, evidence: r.evidence, check: r.check, reasons: r.reasons })),
    llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd },
  };
}

export async function applyRecap(campaignId: number, sessionNumber: number, skip: number[], confirmed: number[]) {
  const path = proposalPath(campaignId, sessionNumber);
  if (!existsSync(path)) throw new Error("That proposal has expired. Read the notes again.");
  const file = JSON.parse(readFileSync(path, "utf8")) as ProposalFile & { savedAs?: string; wrapsLive?: boolean };
  // A proposal is saved once. Marked before writing, so a retry after a failure can't add the
  // same threads again; the GM undoes the batch and reads the notes again instead.
  if (file.savedAs) throw new Error(`These notes were already saved ("${file.savedAs}"). To redo them, undo that save under Recent changes, then read the notes again.`);
  const batch = newBatch(file);
  writeFileSync(path, JSON.stringify({ ...file, savedAs: batch }, null, 2));
  const r = await applyProposal(file, new Set(skip), batch, new Set(confirmed));
  if (file.wrapsLive) await wrapLiveSession(campaignId);
  return {
    batch: r.batch,
    counts: { ...r.counts, details: r.entityResult.updated, relationships: r.entityResult.relations, moments: r.moments, party: !!r.entityResult.party },
    warnings: r.warnings,
    kept: r.entityResult.conflicts.flatMap((c) => c.proposals.map((p) => `${c.entity} · ${p.field}: kept yours (${JSON.stringify(p.current)}); the notes suggest ${JSON.stringify(p.proposed)}`)),
  };
}

// Wrap up with nothing to add: the log becomes the session's notes.
export async function wrapWithoutAdding(campaignId: number) {
  const live = await liveSummary(campaignId);
  if (!live) throw new Error("There's no session in progress to wrap up.");
  const notes = `At the table (logged by Loom):\n${live.draft}`;
  const [existing] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.number, live.session)));
  if (existing) await db.update(schema.sessions).set({ recap: notes }).where(eq(schema.sessions.id, existing.id));
  else await db.insert(schema.sessions).values({ campaignId, number: live.session, recap: notes });
  await wrapLiveSession(campaignId);
  return { session: live.session };
}

export async function history(campaignId: number) {
  // Single hand edits have no batch ("#id"); they'd crowd out the recaps, so only batches count.
  const batches = await recentBatches(campaignId, 60);
  return batches
    .filter((b) => !b.batch.startsWith("#"))
    .slice(0, 12)
    .map((b) => ({ batch: b.batch, changes: b.changes.length, undone: b.undone, at: b.changes.at(-1)?.createdAt ?? null }));
}

export async function undo(campaignId: number, batch: string) {
  return undoBatch(campaignId, batch);
}

export async function prepIdeas(campaignId: number) {
  const { data, titleOf, moments, seats, llm } = await suggest(campaignId);
  const titles = (ids: number[]) => ids.filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! }));
  const quiet = (pc: string) => seats.find((x) => x.pc.name === pc)?.quietFor ?? 0;
  return {
    collisions: data.collisions.map((c) => ({ title: c.title, idea: c.idea, why: c.why, threads: titles(c.thread_ids) })),
    perPlayer: data.per_player.map((p) => ({ pc: p.pc, idea: p.idea, quiet: quiet(p.pc) >= 2, threads: titles(p.thread_ids) })),
    callbacks: data.callbacks.flatMap((c) => {
      const m = moments.find((x) => x.id === c.moment_id);
      return m ? [{ moment: m.title, session: m.session ?? null, idea: c.idea, threads: titles(c.thread_ids) }] : [];
    }),
    quietThreads: data.neglected.flatMap((n) => (titleOf.has(n.thread_id) ? [{ title: titleOf.get(n.thread_id)!, idea: n.idea }] : [])),
    llm: { model: llm.model, seconds: llm.latencyMs / 1000, costUsd: llm.costUsd },
  };
}
