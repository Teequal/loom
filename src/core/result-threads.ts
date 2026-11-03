import type { ScaffoldOption } from "./improv";
import type { Proposal } from "./recap";
import { OUTCOME } from "./world/load";

// How a roll or fight turned out moves the thread it was about, from structure, not prose: the
// move the option was built on and the outcome the GM recorded. A payoff that lands asks whether
// the thread is resolved (closing a thread always needs the GM's yes); one that goes against the
// players makes the thread more urgent. Everything goes through the usual review and undo.

const PAYS_OFF = new Set(["payoff", "collision", "callback", "use it", "bargain", "confide", "choose a side"]);
const GOOD = new Set(["success", "won", "talked"]);
const BAD = new Set(["failure", "lost", "fled"]);

export interface ResultThreadChanges {
  updates: Proposal["thread_updates"];
  urgency: { threadId: number; by: number; note: string } | null;
}

export function resultThreadChanges(settles: ScaffoldOption, label: string, evidence: string): ResultThreadChanges {
  const threadId = Number(/\d+/.exec(settles.thread ?? "")?.[0]);
  const outcome = OUTCOME[label.trim().toLowerCase()] ?? null;
  const none = { updates: [], urgency: null };
  if (!threadId || !outcome) return none;
  const kind = settles.moveInfo?.kind ?? "";
  const update = (change: "progressed" | "resolved", note: string) => [{ thread: `T${threadId}`, change, note, new_summary: "", evidence }];
  if (GOOD.has(outcome)) return { updates: update(PAYS_OFF.has(kind) ? "resolved" : "progressed", PAYS_OFF.has(kind) ? "it paid off at the table" : "it went their way"), urgency: null };
  if (outcome === "partial") return { updates: update("progressed", "it partly went their way"), urgency: null };
  if (BAD.has(outcome)) return { updates: [], urgency: { threadId, by: outcome === "lost" ? 2 : 1, note: outcome === "lost" ? "lost a fight over it" : outcome === "fled" ? "fled from it" : "a roll went against them" } };
  return none;
}
