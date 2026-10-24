import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { eq, max } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { applyProposal, proposeRecapChanges, type ProposalFile } from "@/core/recap";
import { reviewProposal, splitRisky } from "@/core/review";
import { suggest } from "@/core/suggest";
import { recentBatches, undoBatch } from "@/core/undo";

// Between sessions, for the web pages: read a recap into a tiered proposal, apply what the GM
// accepts, undo a batch, and prep suggestions. The same engine calls the CLI makes.

const proposalPath = (campaignId: number, sessionNumber: number) => `data/proposals/web-c${campaignId}-s${sessionNumber}.json`;

export async function nextSessionNumber(campaignId: number) {
  const [row] = await db.select({ n: max(schema.sessions.number) }).from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  return (row?.n ?? 0) + 1;
}

export async function proposeRecap(campaignId: number, recap: string, sessionNumber?: number) {
  const number = sessionNumber ?? (await nextSessionNumber(campaignId));
  const res = await proposeRecapChanges(campaignId, recap);
  // Risky fields become their own items; the numbers the GM accepts refer to this split file.
  const file = await splitRisky({ campaignId, sessionNumber: number, recap, proposal: res.data });
  mkdirSync("data/proposals", { recursive: true });
  writeFileSync(proposalPath(campaignId, number), JSON.stringify(file, null, 2));
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
  const file = JSON.parse(readFileSync(path, "utf8")) as ProposalFile;
  const r = await applyProposal(file, new Set(skip), undefined, new Set(confirmed));
  return {
    batch: r.batch,
    counts: { ...r.counts, details: r.entityResult.updated, relationships: r.entityResult.relations, moments: r.moments, party: !!r.entityResult.party },
    warnings: r.warnings,
    kept: r.entityResult.conflicts.flatMap((c) => c.proposals.map((p) => `${c.entity} · ${p.field}: kept yours (${JSON.stringify(p.current)}); the notes suggest ${JSON.stringify(p.proposed)}`)),
  };
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
