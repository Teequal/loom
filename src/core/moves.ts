import type { SelectedThread } from "./retrieval";
import { momentumOf, paceOf, ruleUsesOf } from "./world/derived";
import { activityOf, heat, presenceOf, type View } from "./world/engine";
import { interplaysOf, type Interplay } from "./world/interplays";
import { propertyOf } from "./world/properties";
import { THREAD_ROLES } from "./world/links";
import type { AnyNode, NodeKey, Thread } from "./world/nodes";

// The engine proposes the moves (docs/design-2026-10-25-world-model.md §7). From the threads in
// play and who plays which part in them, code finds what could happen next: pay a ripe thread off,
// complicate one with stakes, bring in someone with a stake who isn't here, drop a clue, collide
// two threads that share someone, trigger a rule, call back a key moment. Each move comes with
// its cast (who may act in it, who may only arrive) and the reason, in code's words. The model
// picks moves and writes them; it doesn't decide who's in the scene.

export type MoveKind =
  | "payoff" | "complication" | "arrival" | "hint" | "collision" | "rule" | "callback" | "wildcard"
  // From the property model: what an interplay or a notable property makes likely (§7.3).
  | "waver" | "strain" | "bargain" | "lash out" | "confide" | "comply" | "defect" | "choose a side" | "use it" | "infighting" | "character";

export interface CastMember {
  name: string;
  can: "act" | "arrive"; // here and able to act, or not here: arrives or sends word
  part: "lead" | "support"; // in the move's threads, or here and quiet enough to lend a line
  busy?: boolean; // very active lately: kept brief, and leads fewer moves
}

export interface Move {
  id: string; // "M1"
  kind: MoveKind;
  threads: number[]; // the first is the move's main thread
  cast: CastMember[];
  resting: string[]; // here with the party, but not in this move (too active lately to lend a line)
  because: string; // the engine's reason, in plain words
  score: number;
  callback?: number; // a key moment's id, for callback moves
  source?: string; // the interplay or property it comes from ("conflicted", "candour")
  offers?: string[]; // hand-offs it can offer the players ("Iresia makes a Charisma check to hold the charm")
  surprise?: string; // set when this is the session's surprise: why it's explicable
}

const endKey = (e: { kind: string; id: number }) => `${e.kind}:${e.id}` as NodeKey;
const ARRIVING_ROLES = new Set(["seeker", "rival", "cause", "creditor", "informant", "promisee", "debtor", "ally", "witness", "guardian"]);
const HINT_ROLES = new Set(["clue", "informant", "witness", "carrier", "source"]);
const WEIGHT: Record<MoveKind, number> = {
  collision: 1, rule: 0.9, payoff: 0.8, arrival: 0.6, callback: 0.5, complication: 0.5, hint: 0.4, wildcard: 0,
  strain: 0.9, waver: 0.8, "choose a side": 0.8, defect: 0.7, confide: 0.7, comply: 0.7, bargain: 0.6, "lash out": 0.6, "use it": 0.6, infighting: 0.5, character: 0.5,
};
// An interplay's move names, as move kinds.
const INTERPLAY_KIND: Record<string, MoveKind> = { "comply under pressure": "comply" };

// How often a surprise move is offered (§7.8): the GM's setting, as a chance per ask.
export const SURPRISES = ["off", "rare", "sometimes", "often"] as const;
export type Surprises = (typeof SURPRISES)[number];
export const SURPRISE_CHANCE: Record<Surprises, number> = { off: 0, rare: 1 / 8, sometimes: 1 / 4, often: 1 / 2 };

// How the GM wants to take a Develop: each leans the move kinds (−1 or less leaves a kind out).
export const STEERS = ["fight", "heartfelt", "epic", "grounded", "quiet", "story"] as const;
export type Steer = (typeof STEERS)[number];
const STEER_WEIGHT: Record<Steer, Partial<Record<MoveKind, number>>> = {
  fight: { complication: 0.6, arrival: 0.5, collision: 0.3, hint: -0.4, callback: -0.3, "lash out": 0.6, defect: 0.3, confide: -0.4 },
  heartfelt: { callback: 0.8, payoff: 0.4, hint: -0.2, arrival: -0.3, rule: -0.4, confide: 0.6, waver: 0.5, character: 0.5, "lash out": -0.5 },
  epic: { collision: 0.8, payoff: 0.5, rule: 0.4, arrival: 0.3, hint: -0.4, "choose a side": 0.5, strain: 0.4 },
  grounded: { hint: 0.4, complication: 0.2, collision: -0.3, rule: -0.2, arrival: -1, "lash out": -0.3, comply: 0.3 },
  quiet: { hint: 0.5, callback: 0.5, complication: -0.4, rule: -0.4, collision: -0.5, arrival: -1, confide: 0.4, "lash out": -1, strain: -0.3 },
  story: { payoff: 0.6, collision: 0.4, arrival: 0.2, "choose a side": 0.5, waver: 0.2 },
};

interface Part {
  node: AnyNode;
  role: string;
  secret: boolean;
}

export function findMoves(
  v: View,
  threads: SelectedThread[],
  opts: {
    callbacks: { id: number; title: string }[];
    liveRules: { name: string; why: string; sourceName: string | null }[];
    limit?: number;
    steer?: Steer;
    surprise?: { chance: number; seed: string }; // an occasional surprise move (§7.8)
    toward?: Set<number>; // threads closest to where the GM wants the story to go
    exclude?: string[]; // moves already used ("kind:thread"), for another take
  },
): Move[] {
  const memo = new Map();
  const node = (k: NodeKey) => v.g.nodes.get(k);
  const partsOf = (t: SelectedThread): Part[] =>
    v.g
      .linksOf(`thread:${t.id}` as NodeKey, { type: "in_thread", dir: "in" })
      .map((l) => ({ node: node(endKey(l.from))!, role: l.role ?? "involved", secret: l.secret }))
      .filter((p) => !!p.node);
  // Who in a thread can be cast, and how: here and free to act, or able to come in.
  const activity = activityOf(v);
  const busy = (name: string) => activity.get(name)?.band === "very active";
  const castOf = (parts: Part[]): CastMember[] => {
    const out: CastMember[] = [];
    for (const p of parts) {
      if (p.node.kind !== "character" && p.node.kind !== "faction" && p.node.kind !== "item" && p.node.kind !== "other") continue;
      if (p.node.kind === "character" && p.node.side === "pc") continue;
      const pr = presenceOf(v, p.node.key as NodeKey, memo);
      if (pr.role === "here") out.push({ name: p.node.name, can: "act", part: "lead", busy: busy(p.node.name) || undefined });
      else if (pr.role === "reachable" && p.node.kind !== "item") out.push({ name: p.node.name, can: "arrive", part: "lead", busy: busy(p.node.name) || undefined });
    }
    return out;
  };
  // NPCs here with the party: they can lend a supporting line to any move, unless they've been
  // on stage a lot lately, in which case they rest for moves that aren't theirs.
  const presentNpcs = [...v.g.nodes.values()].filter((n) => n.kind === "character" && n.side === "npc" && presenceOf(v, n.key as NodeKey, memo).role === "here").map((n) => n.name);
  const top = Math.max(1, ...threads.map((t) => t.score));
  const moves: Omit<Move, "id">[] = [];
  const add = (m: Omit<Move, "id" | "resting">) => moves.push({ ...m, resting: [] });

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
    // Which use this is: a rule's cost can grow with use.
    const uses = ruleUsesOf(v).get(r.name)?.session ?? 0;
    if (t) add({ kind: "rule", threads: [t.id], cast: castOf(partsOf(t)), because: `${r.name} is triggered (${r.why})${uses ? `; this would be use ${uses + 1} this session, so its cost should grow` : ""}`, score: 1 + WEIGHT.rule + Math.min(uses, 3) * 0.1 });
  }
  for (const cb of opts.callbacks.slice(0, 2)) {
    const t = threads[0];
    if (t) add({ kind: "callback", threads: [t.id], cast: castOf(partsOf(t)), because: `it can call back "${cb.title}"`, score: 0.8 + WEIGHT.callback, callback: cb.id });
  }

  // The property model's moves (§7.3): what an interplay makes likely (Vex'ahlia strains against the
  // charm; Arlen complies out of fear), and what someone's notable situational properties make
  // likely here (Arlen would lie to them now). Only for those in play: here, or named in the moment.
  const named = new Set([...v.reading.broughtIn, ...v.reading.referred, ...v.reading.contacted, ...v.reading.acting]);
  const inPlay = (k?: NodeKey) => !!k && (presenceOf(v, k, memo).role === "here" || named.has(node(k)?.name ?? ""));
  // Someone the moment names is what the moment is about: their pulls count most.
  const focus = (k?: NodeKey) => (k && named.has(node(k)?.name ?? "") ? 1 : k && inPlay(k) ? 0.5 : 0);
  const threadFor = (keys: (NodeKey | undefined)[]) => threads.find((t) => partsOf(t).some((p) => keys.includes(p.node.key as NodeKey))) ?? threads[0];
  const minor: Omit<Move, "id" | "resting">[] = []; // explicable, but not the obvious read: surprise candidates
  const propertyMoves = process.env.LOOM_PROPERTY_MOVES !== "off"; // for A/B runs
  for (const i of propertyMoves ? interplaysOf(v) : []) {
    if (!inPlay(i.subject) && !inPlay(i.other)) {
      // Someone with a pull who isn't here, but could come: not an obvious move, but an
      // explicable surprise (they arrive, and the records say why).
      const subj = node(i.subject);
      const t = threadFor([i.subject, i.other]);
      const cast = subj ? castOf([{ node: subj, role: "involved", secret: false }]) : [];
      if (t && cast.some((c) => c.can === "arrive")) minor.push({ kind: "arrival", threads: [t.id], cast, because: `${subj!.name} arrives, and it shows: ${i.handle}`, score: 0.8 + i.strength * 0.3, source: i.id });
      continue;
    }
    const t = threadFor([i.subject, i.other]);
    if (!t) continue;
    const people = [node(i.subject), i.other ? node(i.other) : undefined].filter((n): n is AnyNode => !!n).map((n) => ({ node: n, role: "involved", secret: false }));
    const cast = castOf(people).length ? castOf(people) : castOf(partsOf(t));
    const subject = node(i.subject)!.name;
    for (const m of i.moves) {
      const kind = (INTERPLAY_KIND[m] ?? m) as MoveKind;
      if (!(kind in WEIGHT)) continue;
      const move = { kind, threads: [t.id], cast, because: `${subject}: ${i.handle}${i.secret ? " (rests on a GM secret: let it show, never state it)" : ""}`, score: 1 + i.strength * 0.4 + Math.max(focus(i.subject), focus(i.other) * 0.6) + WEIGHT[kind], source: i.id, offers: offersFor(v, i) };
      add(move);
      if (i.strength === 1) minor.push(move); // a weak pull: also a surprise candidate
    }
  }
  // Notable situational properties of NPCs in play, as moves of their own (at most two).
  const NOTABLE: Record<string, Record<string, string>> = {
    candour: { lies: "would lie to them now", evades: "would dodge the question" },
    courage: { reckless: "is brave to the point of recklessness here", cowed: "is too frightened to stand up here" },
    restraint: { snaps: "is close to snapping" },
    susceptibility: { pliable: "could be talked into almost anything right now" },
    generosity: { gives: "would give freely" },
  };
  const propMoves: Omit<Move, "id" | "resting">[] = [];
  for (const n of propertyMoves ? v.g.nodes.values() : []) {
    if (n.kind !== "character" || n.side !== "npc" || !inPlay(n.key as NodeKey)) continue;
    for (const [prop, bands] of Object.entries(NOTABLE)) {
      const p = propertyOf(v, n.key as NodeKey, prop);
      const say = p?.band ? bands[p.band] : undefined;
      const t = say && threadFor([n.key as NodeKey]);
      if (!say || !t) continue;
      propMoves.push({ kind: "character", threads: [t.id], cast: castOf([{ node: n, role: "involved", secret: false }]), because: `${n.name} ${say} (${p!.name} ${p!.band}: ${p!.because.slice(0, 2).join("; ")})`, score: 1.2 + focus(n.key as NodeKey) + WEIGHT.character, source: prop });
    }
  }
  for (const m of propMoves.sort((a, b) => b.score - a.score).slice(0, 2)) add(m);
  minor.push(...propMoves.slice(2));
  // A lesser goal of someone in play: explicable, rarely the obvious read.
  for (const n of v.g.nodes.values()) {
    if (n.kind !== "character" || n.side !== "npc" || !inPlay(n.key as NodeKey)) continue;
    const lesser = n.mind.goals.filter((g) => g.priority >= 2 && (!g.status || g.status === "active"))[0];
    const t = lesser && threadFor([n.key as NodeKey]);
    if (lesser && t) minor.push({ kind: "character", threads: [t.id], cast: castOf([{ node: n, role: "involved", secret: false }]), because: `a lesser goal surfaces: ${n.name} also wants to ${lesser.text}`, score: 1, source: "lesser goal" });
  }

  // A busy lead costs a move a little, so quieter characters get more of the stage.
  for (const m of moves) m.score -= 0.3 * m.cast.filter((c) => c.busy).length;
  // The GM's steer leans the kinds; a heartfelt take favours a character's own condition, and
  // "tie to the story" the threads closest to the GM's direction.
  if (opts.steer) {
    const w = STEER_WEIGHT[opts.steer];
    for (const m of moves) {
      m.score += w[m.kind] ?? 0;
      const main = node(`thread:${m.threads[0]}` as NodeKey) as Thread | undefined;
      if (opts.steer === "heartfelt" && main?.threadKind === "condition") m.score += 0.6;
      if (opts.steer === "story" && m.threads.some((t) => opts.toward?.has(t))) m.score += 0.8;
    }
    for (let i = moves.length - 1; i >= 0; i--) if ((w[moves[i].kind] ?? 0) <= -1) moves.splice(i, 1);
  }
  // Derived state leans the moves too: after a fight or a run of rolls, a breather; after a long
  // quiet, a push. A rattled PC in a move's threads draws a moment of their own; one on a roll, a
  // complication that raises the stakes.
  const pace = paceOf(v).band;
  const momentum = momentumOf(v);
  const PACE: Record<string, Partial<Record<MoveKind, number>>> = {
    tense: { hint: 0.3, callback: 0.3, complication: -0.2, arrival: -0.2, collision: -0.1 },
    slack: { complication: 0.3, arrival: 0.3, hint: -0.1 },
  };
  for (const m of moves) {
    if (pace) m.score += PACE[pace][m.kind] ?? 0;
    const pcs = m.threads.flatMap((t) => v.g.linksOf(`thread:${t}` as NodeKey, { type: "in_thread", dir: "in" }).map((l) => node(endKey(l.from)))).filter((n): n is AnyNode => n?.kind === "character" && n.side === "pc");
    const bands = new Set(pcs.map((p) => momentum.get(p.name)?.band));
    if (bands.has("rattled") && (m.kind === "callback" || m.kind === "payoff")) m.score += 0.3;
    if (bands.has("on a roll") && m.kind === "complication") m.score += 0.3;
  }
  if (opts.exclude?.length) for (let i = moves.length - 1; i >= 0; i--) if (opts.exclude.includes(moveKey(moves[i]))) moves.splice(i, 1);
  // Pick a varied set: each pick costs the rest a little for sharing its kind, main thread or cast.
  const limit = opts.limit ?? 5;
  const picked: Omit<Move, "id">[] = [];
  const pool = [...moves];
  while (picked.length < limit && pool.length) {
    const adjusted = pool.map((m) => {
      let s = m.score;
      for (const p of picked) {
        if (p.kind === m.kind) s -= 0.4;
        // A move from someone's pull is about them, not the thread: it shares a thread more easily.
        if (p.threads[0] === m.threads[0]) s -= m.source ? 0.2 : 0.6;
        s -= 0.15 * m.cast.filter((c) => p.cast.some((x) => x.name === c.name)).length;
      }
      return { m, s };
    });
    adjusted.sort((a, b) => b.s - a.s);
    picked.push(adjusted[0].m);
    pool.splice(pool.indexOf(adjusted[0].m), 1);
  }
  // The occasional surprise (§7.8): seeded by the moment, so asking again gives the same result. One
  // picked move gives way to the best explicable-but-unexpected one: a weak interplay, a notable
  // property, a lesser goal. Never anything that breaks a law: they're all built from the records.
  if (opts.surprise && opts.surprise.chance > 0 && seeded(opts.surprise.seed) < opts.surprise.chance) {
    const pool = minor.filter((m) => !picked.some((p) => p.because === m.because)).sort((a, b) => b.score - a.score);
    // Which one is chance too (among the best few), so the same pull doesn't surprise every time.
    const pick = pool[Math.floor(seeded(`${opts.surprise.seed}|pick`) * Math.min(3, pool.length))];
    if (pick && picked.length) picked[picked.length - 1] = { ...pick, resting: [], surprise: pick.because };
  }
  // Always one open move, for the model's own idea, on the strongest thread with whoever's here.
  if (threads[0]) {
    const here = [...new Map([...threads.slice(0, 3).flatMap((t) => castOf(partsOf(t)).filter((c) => c.can === "act"))].map((c) => [c.name, c])).values()];
    picked.push({ kind: "wildcard", threads: threads.slice(0, 3).map((t) => t.id), cast: here, because: "your own idea, on the threads most in play", score: 0, resting: [] });
  }
  return picked.map((m, i) => {
    const inCast = new Set(m.cast.map((c) => c.name));
    const others = presentNpcs.filter((n) => !inCast.has(n));
    const support: CastMember[] = others.filter((n) => !busy(n)).map((name) => ({ name, can: "act", part: "support" }));
    return { ...m, id: `M${i + 1}`, cast: [...m.cast, ...support], resting: others.filter(busy) };
  });
}

/** A move's identity across calls (ids like "M2" are per call). */
export const moveKey = (m: Pick<Move, "kind" | "threads">) => `${m.kind}:${m.threads.join("+")}`;

// A number in [0, 1) from a string, the same every time (for seeded surprises).
function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

// The hand-offs an interplay can offer the players (§7.6), with names filled in.
function offersFor(v: View, i: Interplay): string[] {
  const other = i.other ? v.g.nodes.get(i.other) : undefined;
  const subject = v.g.nodes.get(i.subject)?.name ?? "they";
  const pcOther = other?.kind === "character" && other.side === "pc" ? other.name : null;
  switch (i.id) {
    case "resists the charm":
      return pcOther ? [`${pcOther} makes a Charisma check to hold the charm; on a failure, it breaks`] : [];
    case "conflicted":
      return [`a Wisdom (Insight) notice roll to read ${subject}'s hesitation`];
    case "fear over greed":
      return [`a question: who do you remind ${subject} to fear?`];
    case "steadfast":
      return [`persuading ${subject} against their goal is a contest, not a question`];
    case "the pull":
      return [`a sensation: the item calls to its holder (never the use itself, for a PC)`];
    default:
      return [];
  }
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
      const leads = m.cast.filter((c) => c.part === "lead");
      const support = m.cast.filter((c) => c.part === "support");
      const cast = leads.length ? leads.map((c) => `${c.name} (${c.can === "act" ? "here" : "can arrive or send word"}${c.busy ? "; very active lately, keep brief" : ""})`).join(", ") : "nobody named: use walk-ons";
      return [
        `${m.id} ${m.kind}: ${m.threads.map((t) => `T${t} "${titleOf.get(t) ?? ""}"`).join(" + ")} · cast: ${cast}`,
        support.length && `support (here, one line at most): ${support.map((c) => c.name).join(", ")}`,
        m.resting.length && `resting (here, but not in this move): ${m.resting.join(", ")}`,
        `because: ${m.because}`,
        m.offers?.length && `could offer: ${m.offers.join("; ")}`,
        m.surprise && "SURPRISE: the GM asked for one now and then; build exactly one option on this move, and keep it explicable",
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .join("\n");
}
