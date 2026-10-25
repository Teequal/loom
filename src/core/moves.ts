import type { SelectedThread } from "./retrieval";
import { heat, presenceOf, type View } from "./world/engine";
import { THREAD_ROLES } from "./world/links";
import type { AnyNode, NodeKey, Thread } from "./world/nodes";

// The engine proposes the moves (docs/design-2026-10-25-world-model.md §7). From the threads in
// play and who plays which part in them, code finds what could happen next: pay a ripe thread off,
// complicate one with stakes, bring in someone with a stake who isn't here, drop a clue, collide
// two threads that share someone, trigger a rule, call back a key moment. Each move comes with
// its cast (who may act in it, who may only arrive) and the reason, in code's words. The model
// picks moves and writes them; it doesn't decide who's in the scene.

export type MoveKind = "payoff" | "complication" | "arrival" | "hint" | "collision" | "rule" | "callback" | "wildcard";

export interface CastMember {
  name: string;
  can: "act" | "arrive"; // here and able to act, or not here: arrives or sends word
}

export interface Move {
  id: string; // "M1"
  kind: MoveKind;
  threads: number[]; // the first is the move's main thread
  cast: CastMember[];
  because: string; // the engine's reason, in plain words
  score: number;
  callback?: number; // a key moment's id, for callback moves
}

const endKey = (e: { kind: string; id: number }) => `${e.kind}:${e.id}` as NodeKey;
const ARRIVING_ROLES = new Set(["seeker", "rival", "cause", "creditor", "informant", "promisee", "debtor", "ally", "witness", "guardian"]);
const HINT_ROLES = new Set(["clue", "informant", "witness", "carrier", "source"]);
const WEIGHT: Record<MoveKind, number> = { collision: 1, rule: 0.9, payoff: 0.8, arrival: 0.6, callback: 0.5, complication: 0.5, hint: 0.4, wildcard: 0 };

interface Part {
  node: AnyNode;
  role: string;
  secret: boolean;
}

export function findMoves(
  v: View,
  threads: SelectedThread[],
  opts: { callbacks: { id: number; title: string }[]; liveRules: { name: string; why: string; sourceName: string | null }[]; limit?: number },
): Move[] {
  const memo = new Map();
  const node = (k: NodeKey) => v.g.nodes.get(k);
  const partsOf = (t: SelectedThread): Part[] =>
    v.g
      .linksOf(`thread:${t.id}` as NodeKey, { type: "in_thread", dir: "in" })
      .map((l) => ({ node: node(endKey(l.from))!, role: l.role ?? "involved", secret: l.secret }))
      .filter((p) => !!p.node);
  // Who in a thread can be cast, and how: here and free to act, or able to come in.
  const castOf = (parts: Part[]): CastMember[] => {
    const out: CastMember[] = [];
    for (const p of parts) {
      if (p.node.kind !== "character" && p.node.kind !== "faction" && p.node.kind !== "item" && p.node.kind !== "other") continue;
      if (p.node.kind === "character" && p.node.side === "pc") continue;
      const pr = presenceOf(v, p.node.key as NodeKey, memo);
      if (pr.role === "here") out.push({ name: p.node.name, can: "act" });
      else if (pr.role === "reachable" && p.node.kind !== "item") out.push({ name: p.node.name, can: "arrive" });
    }
    return out;
  };
  const top = Math.max(1, ...threads.map((t) => t.score));
  const moves: Omit<Move, "id">[] = [];
  const add = (m: Omit<Move, "id">) => moves.push(m);

  for (const t of threads) {
    const tn = node(`thread:${t.id}` as NodeKey) as Thread | undefined;
    if (!tn) continue;
    const parts = partsOf(t);
    const cast = castOf(parts);
    const base = (t.score / top) * 2 + heat(v, tn).score / 5 + (t.guaranteed ? 0.5 : 0);
    const h = heat(v, tn);
    if (h.ripe || t.guaranteed) add({ kind: "payoff", threads: [t.id], cast, because: h.ripe ? `"${t.title}" is ripe to pay off` : `the moment touches "${t.title}"`, score: base + WEIGHT.payoff });
    if ((tn.stakes.level ?? 0) >= 3 || tn.deadline) {
      add({ kind: "complication", threads: [t.id], cast, because: tn.stakes.ifIgnored ? `if "${t.title}" is ignored, ${tn.stakes.ifIgnored}` : tn.deadline ? `"${t.title}" has a deadline: ${tn.deadline.text}` : `a lot rides on "${t.title}"`, score: base + WEIGHT.complication });
    }
    for (const p of parts.filter((x) => ARRIVING_ROLES.has(x.role))) {
      const c = cast.find((x) => x.name === p.node.name && x.can === "arrive");
      if (!c) continue;
      add({ kind: "arrival", threads: [t.id], cast: [c, ...cast.filter((x) => x.can === "act")], because: `${p.node.name}, the ${THREAD_ROLES[p.role] ? p.role : "one involved"} in "${t.title}", isn't here: they could arrive or send word`, score: base + WEIGHT.arrival });
      break;
    }
    const hinting = parts.filter((p) => HINT_ROLES.has(p.role) || p.secret);
    if (tn.threadKind === "mystery" || hinting.length) {
      add({ kind: "hint", threads: [t.id], cast: castOf(hinting).length ? castOf(hinting) : cast, because: `a clue toward "${t.title}"${hinting.some((p) => p.secret) ? " (a GM secret: hint, never state)" : ""}`, score: base + WEIGHT.hint });
    }
  }
  // Collisions: two threads in play that share someone or something.
  for (let i = 0; i < threads.length; i++) {
    for (let j = i + 1; j < threads.length; j++) {
      const [a, b] = [partsOf(threads[i]), partsOf(threads[j])];
      const shared = a.find((p) => p.node.kind !== "place" && b.some((q) => q.node.key === p.node.key));
      if (!shared) continue;
      const score = ((threads[i].score + threads[j].score) / (2 * top)) * 2 + WEIGHT.collision;
      add({ kind: "collision", threads: [threads[i].id, threads[j].id], cast: dedupe([...castOf(a), ...castOf(b)]), because: `${shared.node.name} is in both "${threads[i].title}" and "${threads[j].title}"`, score });
    }
  }
  // Triggered house rules, on the threads their source is in.
  for (const r of opts.liveRules) {
    const src = r.sourceName ? v.g.find(r.sourceName) : undefined;
    const onThreads = threads.filter((t) => partsOf(t).some((p) => src && p.node.key === src.key));
    const t = onThreads[0] ?? threads[0];
    if (t) add({ kind: "rule", threads: [t.id], cast: castOf(partsOf(t)), because: `${r.name} is triggered (${r.why})`, score: 1 + WEIGHT.rule });
  }
  for (const cb of opts.callbacks.slice(0, 2)) {
    const t = threads[0];
    if (t) add({ kind: "callback", threads: [t.id], cast: castOf(partsOf(t)), because: `it can call back "${cb.title}"`, score: 0.8 + WEIGHT.callback, callback: cb.id });
  }

  // Pick a varied set: each pick costs the rest a little for sharing its kind, main thread or cast.
  const limit = opts.limit ?? 5;
  const picked: Omit<Move, "id">[] = [];
  const pool = [...moves];
  while (picked.length < limit && pool.length) {
    const adjusted = pool.map((m) => {
      let s = m.score;
      for (const p of picked) {
        if (p.kind === m.kind) s -= 0.4;
        if (p.threads[0] === m.threads[0]) s -= 0.6;
        s -= 0.15 * m.cast.filter((c) => p.cast.some((x) => x.name === c.name)).length;
      }
      return { m, s };
    });
    adjusted.sort((a, b) => b.s - a.s);
    picked.push(adjusted[0].m);
    pool.splice(pool.indexOf(adjusted[0].m), 1);
  }
  // Always one open move, for the model's own idea, on the strongest thread with whoever's here.
  if (threads[0]) {
    const here = [...new Map([...threads.slice(0, 3).flatMap((t) => castOf(partsOf(t)).filter((c) => c.can === "act"))].map((c) => [c.name, c])).values()];
    picked.push({ kind: "wildcard", threads: threads.slice(0, 3).map((t) => t.id), cast: here, because: "your own idea, on the threads most in play", score: 0 });
  }
  return picked.map((m, i) => ({ ...m, id: `M${i + 1}` }));
}

function dedupe(cast: CastMember[]) {
  const out = new Map<string, CastMember>();
  for (const c of cast) if (!out.has(c.name) || c.can === "act") out.set(c.name, c);
  return [...out.values()];
}

/** The moves as the prompt shows them. */
export function movesBlock(moves: Move[], titleOf: Map<number, string>) {
  return moves
    .map((m) => {
      const cast = m.cast.length ? m.cast.map((c) => `${c.name} (${c.can === "act" ? "here" : "can arrive or send word"})`).join(", ") : "nobody named: use walk-ons";
      return `${m.id} ${m.kind}: ${m.threads.map((t) => `T${t} "${titleOf.get(t) ?? ""}"`).join(" + ")} · cast: ${cast} · because: ${m.because}`;
    })
    .join("\n");
}
