import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db/client";
import { settleStates, tableNudges } from "./nudges";
import { deltasOf, untag } from "./deltas";
import type { ScaffoldOption } from "./improv";
import { applyProposal, numberItems, proposeRecapChanges, type Proposal, type ProposalFile } from "./recap";
import { reviewProposal, splitRisky } from "./review";
import { undoBatch } from "./undo";

// The session in progress, as it happens at the table. Every moment asked about is logged; when
// the GM uses an option (or writes their own), that choice is extracted straight away, so the
// next suggestion already knows what changed. Low-risk changes go in automatically; risky ones
// wait as questions. Wrap-up turns the log into the session's notes.

type Entry = typeof schema.liveEntries.$inferSelect;
export const NOTED = "(noted by the GM)"; // the moment of a note logged without asking Loom

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

/**
 * A new session at the table starts with the last one's moving states settling (nudges.ts). Call it
 * before the first ask or note; it does nothing once the session has begun, or twice.
 */
export async function beginSession(campaignId: number) {
  const [open] = await db.select({ id: schema.liveEntries.id }).from(schema.liveEntries).where(and(eq(schema.liveEntries.campaignId, campaignId), eq(schema.liveEntries.wrapped, false))).limit(1);
  if (open) return null;
  const n = await liveSessionNumber(campaignId);
  return n > 1 ? settleStates(campaignId, n - 1).catch((err) => (console.error(err), null)) : null;
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

// The session's notes as drafted from the log: what the players did and what happened, with
// anything developed from a choice indented under it (the session as a tree).
export async function draftNotes(campaignId: number) {
  const entries = (await liveEntries(campaignId)).filter((e) => e.choiceKind);
  const ids = new Set(entries.map((e) => e.id));
  const children = new Map<number, Entry[]>();
  for (const e of entries) if (e.parentId != null && ids.has(e.parentId)) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e]);
  const lines: string[] = [];
  const walk = (e: Entry, depth: number) => {
    const pad = "  ".repeat(depth);
    const skipped = e.resultState === "skipped" ? ` (result not recorded)` : "";
    lines.push(
      e.choiceKind === "result"
        ? `${pad}- Result: ${e.choice}`
        : e.choiceKind === "branch"
          ? `${pad}- Then: ${e.choice}${skipped}`
          : e.moment === NOTED
            ? `${pad}- ${e.choice}${skipped}`
            : `${pad}- ${e.moment}\n${pad}  What happened: ${e.choice}${skipped}`,
    );
    for (const c of children.get(e.id) ?? []) walk(c, depth + 1);
  };
  for (const e of entries) if (e.parentId == null || !ids.has(e.parentId)) walk(e, 0);
  return lines.join("\n");
}

// A development the GM picked to continue from: logged as a child of the choice it grew from,
// then extracted like any other choice.
export async function logBranch(parentId: number, choice: { label: string; text: string }) {
  const [parent] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, parentId));
  if (!parent) throw new Error("That moment isn't in the log any more.");
  const [e] = await db
    .insert(schema.liveEntries)
    .values({
      campaignId: parent.campaignId,
      sessionNumber: parent.sessionNumber,
      parentId,
      moment: `Continuing from “${parent.choiceLabel || clip(parent.choice || parent.moment, 60)}”`,
      choiceKind: "branch",
      choiceLabel: choice.label,
      choice: choice.text,
      status: "extracting",
      awaiting: needsResult(choice.text),
      resultState: needsResult(choice.text) ? "pending" : null,
    })
    .returning();
  return e;
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

// Choices that can't be finished without an outcome: a fight, or a roll someone has to make.
const FIGHT = /\b(?:fight|fights|fighting|combat|ambush(?:es|ed)?|duel|brawl|battle|initiative|skirmish|attacks?|attacked|draws? (?:their |his |her )?(?:blades?|swords?|steel|weapons?)|charges? (?:at|into))\b/i;
const ROLL = /\b(?:rolls?|roll for|check|saving throw|save against|DC ?\d+)\b/i;
export function needsResult(text: string, hint?: "roll" | "fight" | null): "roll" | "fight" | null {
  // A fight is a fight even when the option ends on an attack roll.
  if (hint === "fight" || FIGHT.test(text)) return "fight";
  return hint ?? (ROLL.test(text) ? "roll" : null);
}

export async function commitChoice(entryId: number, choice: { kind: "option" | "own"; label: string; text: string; awaiting?: "roll" | "fight" | null }) {
  const awaiting = needsResult(choice.text, choice.awaiting);
  const [e] = await db
    .update(schema.liveEntries)
    .set({ choiceKind: choice.kind, choiceLabel: choice.label, choice: choice.text, status: "extracting", awaiting, resultState: awaiting ? "pending" : null })
    .where(eq(schema.liveEntries.id, entryId))
    .returning();
  return e;
}

// How a roll or fight turned out: it joins the tree under the choice it settles, and is extracted
// like any other choice, so deaths, captures and losses reach the loom.
export async function recordResult(entryId: number, outcome: string, detail: string) {
  const [parent] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!parent) throw new Error("That moment isn't in the log any more.");
  await db.update(schema.liveEntries).set({ resultState: "given" }).where(eq(schema.liveEntries.id, entryId));
  const [e] = await db
    .insert(schema.liveEntries)
    .values({
      campaignId: parent.campaignId,
      sessionNumber: parent.sessionNumber,
      parentId: entryId,
      moment: `How “${parent.choiceLabel || clip(parent.choice || parent.moment, 50)}” turned out`,
      choiceKind: "result",
      choiceLabel: outcome,
      choice: `${outcome}${detail.trim() ? `. ${detail.trim()}` : "."}`,
      status: "extracting",
    })
    .returning();
  return e;
}

// The GM chose not to record a result: allowed, and remembered, so wrap-up can mention it.
export async function skipResult(entryId: number) {
  await db.update(schema.liveEntries).set({ resultState: "skipped" }).where(eq(schema.liveEntries.id, entryId));
}

// Extracts one choice into the loom. Called after the response, in the background.
export function extractEntry(entryId: number) {
  return db
    .select()
    .from(schema.liveEntries)
    .where(eq(schema.liveEntries.id, entryId))
    .then(([e]) => (e ? queued(e.campaignId, () => runExtraction(e)) : undefined));
}

/**
 * The engine's scaffold behind a logged choice: an improv option's (kept on the entry's options),
 * or a Develop step's (kept on the chain it came from, on one of the entry's ancestors). Null for
 * the GM's own text, notes and results.
 */
export async function scaffoldFor(e: Entry): Promise<ScaffoldOption | null> {
  if (e.choiceKind === "option") return (e.options.find((o) => o.text === e.choice)?.scaffold as ScaffoldOption | undefined) ?? null;
  if (e.choiceKind !== "branch") return null;
  for (let up = e.parentId, hops = 0; up != null && hops < 10; hops++) {
    const [a] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, up));
    if (!a) break;
    for (const d of a.developments as { kind?: string; chains?: { steps: { when: string | null; text: string; scaffold: ScaffoldOption }[] }[] }[]) {
      if (d?.kind !== "chain") continue;
      for (const c of d.chains ?? []) for (const st of c.steps) if (`${st.when ? `${st.when} ` : ""}${st.text}` === e.choice) return st.scaffold;
    }
    up = a.parentId;
  }
  return null;
}

/**
 * A scaffolded choice's changes as a proposal, built from its structure (deltas.ts), not read from
 * its prose: the thread it moves, who arrives where the party is, which items change hands. It goes
 * through the same review as an extraction, so risky changes still come up as questions.
 */
export async function directProposal(e: Entry, o: ScaffoldOption, text: string): Promise<Proposal> {
  const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, e.campaignId));
  const [camp] = await db.select({ party: schema.campaigns.partyLocationId }).from(schema.campaigns).where(eq(schema.campaigns.id, e.campaignId));
  const party = ents.find((x) => x.id === camp?.party)?.name ?? "";
  const d = deltasOf(o, (n) => ents.some((x) => x.type === "item" && x.name === n));
  // The quote for each change is the beat that makes it, as it reads in the log.
  const quote = (name: string) => clip(untag(o.setup.find((b) => b.actor === name || b.does.includes(`{${name}`))?.does ?? e.choice), 110);
  return {
    entity_updates: party ? d.arrivals.map((name) => ({ name, status: "", attitude: "", importance: "", last_known_location: party, parent_location: "", traits: [], evidence: quote(name) })) : [],
    relations: d.handovers.map((h) => ({ from: h.to, type: "holds", to: h.item, note: "", strength: 0, evidence: quote(h.item) })),
    party_location: "",
    party_evidence: "",
    new_entities: [],
    new_threads: [],
    thread_updates: d.thread ? [{ thread: `T${d.thread}`, change: "progressed", note: clip(text.replace(/^The players: [^\n]*\nWhat happened: /, ""), 160), new_summary: "", evidence: clip(e.choice, 110) }] : [],
    thread_links: [],
    key_moments: [],
    sub_properties: [],
    pair_weights: [],
  };
}

async function runExtraction(e: Entry) {
  try {
    // Undo what an earlier pick for this moment added, so changing your mind doesn't double up.
    if (e.batch) await undoBatch(e.campaignId, e.batch, { force: true });
    const text = `The players: ${e.moment}\nWhat happened: ${e.choice}`;
    // A choice Loom built applies its own changes; only the GM's own words need reading.
    const scaffold = await scaffoldFor(e);
    const proposal = scaffold ? await directProposal(e, scaffold, text) : (await proposeRecapChanges(e.campaignId, text, undefined, { live: true })).data;
    // Table nudges (nudges.ts): a used choice from its own structure; a result from the choice it
    // settles, with the outcome the GM tapped.
    const parent = e.choiceKind === "result" && e.parentId ? (await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, e.parentId)))[0] : null;
    const settles = parent ? await scaffoldFor(parent) : null;
    const nudgeFrom = scaffold ?? settles;
    if (nudgeFrom) {
      const n = await tableNudges(e.campaignId, nudgeFrom, settles ? e.choiceLabel : null, clip(e.choice, 110));
      proposal.sub_properties = [...proposal.sub_properties, ...n.subs];
      proposal.pair_weights = [...proposal.pair_weights, ...n.weights];
    }
    const file: ProposalFile = await splitRisky({ kind: "live", campaignId: e.campaignId, sessionNumber: e.sessionNumber, recap: text, proposal });
    mkdirSync("data/proposals", { recursive: true });
    writeFileSync(proposalPath(e), JSON.stringify(file, null, 2));
    const reviewed = await reviewProposal(file);
    // With auto-approve on, risky changes go in too, as the GM's own entries (still undoable).
    const [camp] = await db.select({ auto: schema.campaigns.autoApprove }).from(schema.campaigns).where(eq(schema.campaigns.id, e.campaignId));
    const auto = !!camp?.auto;
    const must = auto ? [] : reviewed.filter((r) => r.tier === "must");
    const batch = `live s${e.sessionNumber} ${stamp()} #e${e.id}`;
    const applied = reviewed.filter((r) => auto || r.tier !== "must");
    const confirmed = new Set(auto ? reviewed.filter((r) => r.tier === "must").map((r) => r.item.n) : []);
    if (applied.length) await applyProposal(file, new Set(must.map((r) => r.item.n)), batch, confirmed);
    await db
      .update(schema.liveEntries)
      .set({
        status: "done",
        batch,
        // "Threads" items already say which thread; details need to say whose.
        summary: applied.map((r) => `${r.group === "Threads" ? "" : `${r.group}: `}${r.summary}${confirmed.has(r.item.n) ? " (auto-approved)" : ""}`),
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
    .set({ choiceKind: null, choiceLabel: "", choice: "", status: "asked", batch: null, summary: [], questions: [], awaiting: null, resultState: null, encounter: null })
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
