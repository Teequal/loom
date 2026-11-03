import { findMoves, type MoveKind } from "./moves";
import { readMoment } from "./moment-reading";
import { loadThreadContexts, type SelectedThread } from "./retrieval";
import { viewOf } from "./world/engine";
import { loadGraph } from "./world/load";

// What could happen next on one thread, from the engine alone (no model): the moves the records
// allow for it, each with its cast and the reason. Tapping one asks Loom for options on that move.

const SAY: Partial<Record<MoveKind, string>> = {
  payoff: "Pay it off", complication: "Complicate it", arrival: "Bring someone in", hint: "Drop a clue", collision: "Collide it with another thread",
  callback: "Call back a key moment", rule: "Its house rule comes into play", echo: "Someone unseen is behind it", tie: "A link nobody's made",
  waver: "Someone wavers", strain: "Someone strains against it", bargain: "Someone bargains", "lash out": "Someone lashes out", confide: "Someone confides",
  comply: "Someone gives in", defect: "Someone changes sides", "choose a side": "Someone has to choose a side", "use it": "Someone uses it", infighting: "Infighting", character: "A character moment",
};

export async function threadMoves(campaignId: number, threadId: number) {
  const all = await loadThreadContexts(campaignId);
  const t = all.find((x) => x.id === threadId);
  if (!t) throw new Error("That thread isn't in the loom any more.");
  // The thread, and the open threads that share someone with it (so collisions can be found).
  const others = all.filter((x) => x.id !== t.id && x.status !== "resolved" && x.entities.some((n) => t.entities.includes(n)));
  const selected: SelectedThread[] = [t, ...others].map((x) => ({ ...x, score: x.id === t.id ? 2 : 1, reasons: [], detail: "line", guaranteed: x.id === t.id }));
  const v = viewOf(await loadGraph(campaignId), readMoment([], ""));
  const moves = findMoves(v, selected, { callbacks: [], liveRules: [], limit: 40 }).filter((m) => m.threads.includes(t.id) && m.kind !== "wildcard");
  const seen = new Set<string>();
  return {
    moves: moves
      .filter((m) => { const k = `${m.kind}:${m.threads.join("+")}`; return !seen.has(k) && !!seen.add(k); })
      .slice(0, 6)
      .map((m) => ({ kind: m.kind, label: m.kind === "collision" ? `Collide it with “${all.find((x) => x.id === m.threads.find((y) => y !== t.id))?.title ?? "another thread"}”` : (SAY[m.kind] ?? m.kind), because: m.because.replace(/^the moment touches (".*")$/, "$1 can pay off now").replace(/\s*\([^()]*\)$/, ""), with: m.threads.filter((x) => x !== t.id), cast: m.cast.filter((c) => c.part === "lead").map((c) => ({ name: c.name, here: c.can === "act", near: c.can === "arrive" })) })),
  };
}
