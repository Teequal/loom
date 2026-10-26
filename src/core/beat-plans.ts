import { NOTABLE, type Move } from "./moves";
import type { View } from "./world/engine";
import { boundsFor, interplaysFor } from "./world/interplays";
import type { AnyNode, Character, NodeKey } from "./world/nodes";
import { propertyOf } from "./world/properties";

// Beat plans (docs/plan-2026-10-26-beat-plans-and-derived-state.md §2; design §7.4–7.5): the
// engine decides what each beat delivers, and the model writes one sentence per planned beat.
// A plan beat is an actor, an act and a payload: a concrete fact from the records (a thread's
// payoff idea, someone's secret, goal, fear or pull, an item's price, a faction's aim, a place's
// hazard), each with a stable key so the same reveal isn't made twice in a session.
// Behaviour bounds apply to the planned act: someone devoted never turns on their friend, the
// charmed never harm their charmer, and acting against their own goal needs a tension that allows
// it. A beat that breaks a bound isn't planned; the next payload is.

export const BEAT_ACTS = ["reveal", "hint", "offer", "give", "ask", "warn", "threaten", "take", "hesitate", "refuse", "stall", "lie", "insist", "yield", "arrive", "send word", "hazard", "remind", "respond"] as const;
export type BeatAct = (typeof BEAT_ACTS)[number];

export const ACT_SAYS: Record<BeatAct, string> = {
  reveal: "lets it be known",
  hint: "hints at it, never stating it",
  offer: "offers it, or a deal over it",
  give: "hands it over, or gives way on it",
  ask: "asks for it, or asks about it",
  warn: "warns of it",
  threaten: "threatens with it",
  take: "takes it, or moves to",
  hesitate: "hesitates over it",
  refuse: "refuses",
  stall: "stalls, puts it off",
  lie: "lies about it",
  insist: "insists on it",
  yield: "gives in",
  arrive: "arrives because of it",
  "send word": "sends word about it",
  hazard: "the place itself turns it on them",
  remind: "brings it back to mind",
  respond: "responds in their own way, true to who they are",
};

export type PayloadKind = "free" | "payoff" | "stakes" | "deadline" | "secret" | "knowledge" | "goal" | "fear" | "bond" | "belief" | "state" | "property" | "pull" | "item" | "aim" | "clock" | "hazard" | "summary";

export interface Payload {
  key: string; // stable across calls: "thread:12:payoff:0", "character:40:goal:g1"
  kind: PayloadKind;
  owner: NodeKey | null; // whose fact it is (a character or faction), else the world's
  about: string; // the fact, in one line, for the prompt
  secret: boolean; // GM-only: hinted, never stated
  act: BeatAct; // what a beat naturally does with it
  object: NodeKey | null; // whom the act is aimed at, when it's someone (a goal's target, a pull's other)
  spent: boolean; // delivered already this session
  rank: number; // lower first
}

export interface PlanBeat {
  id: string; // "M2.1"
  actor: string; // a character's name, "world" or "walk-on"
  beatKind: "npc" | "arrival" | "remote" | "world" | "walk_on";
  walkOn: string; // for a walk-on: who ("an agent of the Red Hand")
  act: BeatAct;
  object: NodeKey | null;
  payload: Payload;
}

// What a move of each kind does with a payload, where the payload's own act isn't the point.
const MOVE_ACT: Partial<Record<Move["kind"], BeatAct>> = {
  hint: "hint",
  complication: "threaten",
  callback: "remind",
  rule: "hazard",
  bargain: "offer",
  waver: "hesitate",
  strain: "refuse",
  confide: "hint",
  "lash out": "threaten",
  comply: "give",
  defect: "offer",
  "choose a side": "ask",
  infighting: "threaten",
};
// What a pull makes someone do, by the move it suggests.
const PULL_ACT: Record<string, BeatAct> = { waver: "hesitate", strain: "refuse", confide: "hint", bargain: "offer", "lash out": "threaten", "comply under pressure": "yield", defect: "offer", "choose a side": "ask", infighting: "threaten", collision: "reveal", "use it": "warn", character: "insist" };
// What a notable situational property makes someone do.
const PROP_ACT: Record<string, BeatAct> = { "candour:lies": "lie", "candour:evades": "stall", "courage:reckless": "threaten", "courage:cowed": "hesitate", "restraint:snaps": "threaten", "susceptibility:pliable": "yield", "generosity:gives": "give" };

const isChar = (n: AnyNode | undefined): n is Character => n?.kind === "character";

/** Everything a move's beats could deliver, best first; spent ones last. */
export function payloadsFor(v: View, move: Move, spent: Set<string> = new Set()): Payload[] {
  const out: Payload[] = [];
  const push = (p: Omit<Payload, "spent">) => out.push({ ...p, spent: spent.has(p.key) });
  const moveAct = MOVE_ACT[move.kind];

  move.threads.forEach((id, i) => {
    const t = v.g.nodes.get(`thread:${id}` as NodeKey);
    if (t?.kind !== "thread") return;
    const r = i === 0 ? 0 : 2;
    t.payoffs.forEach((p, j) => push({ key: `thread:${id}:payoff:${j}`, kind: "payoff", owner: null, about: `a payoff idea for "${t.name}": ${p}`, secret: false, act: moveAct ?? "reveal", object: null, rank: r + 0.1 * j }));
    if (t.stakes.ifIgnored) push({ key: `thread:${id}:stakes`, kind: "stakes", owner: null, about: `if "${t.name}" is left alone: ${t.stakes.ifIgnored}`, secret: false, act: move.kind === "complication" ? "threaten" : "warn", object: null, rank: r + 0.5 });
    if (t.deadline?.text) push({ key: `thread:${id}:deadline`, kind: "deadline", owner: null, about: `the deadline on "${t.name}": ${t.deadline.text}`, secret: false, act: "warn", object: null, rank: r + 0.6 });
    push({ key: `thread:${id}:summary`, kind: "summary", owner: null, about: `"${t.name}": ${t.summary.length > 200 ? `${t.summary.slice(0, 197).replace(/\s+\S*$/, "")}…` : t.summary}`, secret: !!t.secret, act: moveAct ?? "reveal", object: null, rank: 9 + r });
    // Items the thread turns on: their price, and what they really do.
    for (const l of v.g.linksOf(t.key as NodeKey, { type: "in_thread" })) {
      const n = v.g.nodes.get(v.g.other(l, t.key as NodeKey));
      if (n?.kind !== "item") continue;
      if (n.properties.cost) push({ key: `${n.key}:cost`, kind: "item", owner: null, about: `the price of using ${n.name}: ${n.properties.cost}`, secret: false, act: "warn", object: null, rank: r + 1.5 });
      if (n.properties.true) push({ key: `${n.key}:true`, kind: "item", owner: null, about: `what ${n.name} really does: ${n.properties.true}`, secret: true, act: "hint", object: null, rank: r + 1.6 });
    }
  });

  move.cast.forEach((c, i) => {
    const n = v.g.find(c.name);
    if (!n) return;
    const r = 1 + i * 0.5 + (c.part === "support" ? 1.5 : 0);
    const k = n.key as NodeKey;
    if (n.kind === "faction") {
      const aim = [...n.aims].sort((a, b) => a.priority - b.priority)[0];
      if (aim) push({ key: `${k}:aim:${aim.id ?? 0}`, kind: "aim", owner: k, about: `${n.name} aims to ${aim.text}`, secret: !!aim.secret, act: moveAct === "remind" ? "send word" : (moveAct ?? "threaten"), object: null, rank: r + 0.4 });
      if (n.clock) push({ key: `${k}:clock:${n.clock.filled}`, kind: "clock", owner: k, about: `${n.name}'s plan is ${n.clock.filled} of ${n.clock.of} steps along`, secret: false, act: "warn", object: null, rank: r + 0.6 });
      return;
    }
    if (!isChar(n) || n.side !== "npc") return;
    // Their pulls first: that's who they are right now.
    for (const ip of interplaysFor(v, k)) {
      const act = ip.moves.map((m) => PULL_ACT[m]).find(Boolean) ?? (ip.kind === "alignment" ? "offer" : "hesitate");
      const other = ip.subject === k ? (ip.other ?? null) : ip.subject;
      push({ key: `${k}:pull:${ip.id}`, kind: "pull", owner: k, about: `${n.name}: ${ip.handle} (${ip.name})`, secret: ip.secret, act, object: other, rank: r + (ip.subject === k ? 0 : 0.3) - 0.2 * ip.strength });
    }
    for (const [prop, bands] of Object.entries(NOTABLE)) {
      const p = propertyOf(v, k, prop);
      if (p?.band && bands[p.band]) push({ key: `${k}:prop:${prop}:${p.band}`, kind: "property", owner: k, about: `${n.name} ${bands[p.band]} (${p.because.slice(0, 2).join("; ")})`, secret: false, act: PROP_ACT[`${prop}:${p.band}`] ?? "insist", object: null, rank: r + 0.2 });
    }
    n.knowledge.forEach((kn, j) => push({ key: `${k}:knows:${j}`, kind: kn.secret ? "secret" : "knowledge", owner: k, about: `${n.name} ${kn.secret ? "keeps a secret" : "knows"}: ${kn.text}`, secret: kn.secret, act: kn.secret ? "hint" : "reveal", object: null, rank: r + 0.3 + 0.1 * j }));
    const goal = n.mind.goals.filter((g) => !g.status || g.status === "active" || g.status === "blocked").sort((a, b) => a.priority - b.priority)[0];
    if (goal) {
      const cost = (goal.intent ?? 0) < 0 ? ", at others' cost" : "";
      const push_ = (goal.commitment ?? 0) >= 2 ? ", and will push for it" : "";
      const act: BeatAct = moveAct ?? ((goal.intent ?? 0) < 0 && move.kind === "complication" ? "threaten" : "ask");
      push({ key: `${k}:goal:${goal.id ?? 0}`, kind: "goal", owner: k, about: `${n.name} wants to ${goal.text.replace(/^to\s+/i, "")}${cost}${push_}`, secret: !!goal.secret, act, object: (goal.target as NodeKey) ?? null, rank: r + 0.5 });
    }
    n.mind.fears.slice(0, 1).forEach((f) => push({ key: `${k}:fear:${f}`, kind: "fear", owner: k, about: `${n.name} fears ${f}`, secret: false, act: "hesitate", object: null, rank: r + 0.8 }));
    n.mind.bonds.slice(0, 1).forEach((b) => push({ key: `${k}:bond:${b}`, kind: "bond", owner: k, about: `${n.name}'s bond: ${b}`, secret: false, act: "ask", object: null, rank: r + 0.9 }));
    n.mind.beliefs.filter((b) => b.true === false).slice(0, 1).forEach((b) => push({ key: `${k}:belief:${b.id ?? b.text}`, kind: "belief", owner: k, about: `${n.name} believes ${b.text} (it isn't true)`, secret: true, act: "insist", object: null, rank: r + 0.7 }));
    const st = n.mind.state;
    const states: [string, boolean, BeatAct, string][] = [
      ["anger", (st.anger ?? 0) >= 2, "warn", "is angry"],
      ["fear", (st.fear ?? 0) >= 2, "hesitate", "is frightened"],
      ["strain", (st.strain ?? 0) >= 2, "stall", "is worn thin"],
      ["hope", (st.hope ?? 0) >= 2, "offer", "is hopeful"],
      ["confidence", (st.confidence ?? 0) <= -2, "hesitate", "is shaken"],
    ];
    for (const [s, on, act, says] of states) if (on) push({ key: `${k}:state:${s}`, kind: "state", owner: k, about: `${n.name} ${says} right now`, secret: false, act, object: null, rank: r + 0.6 });
  });

  // The place the party is in: its hazards and atmosphere, for the world to use.
  const place = v.party;
  if (place) {
    place.hazards.forEach((h, j) => push({ key: `${place.key}:hazard:${j}`, kind: "hazard", owner: null, about: `a hazard at ${place.name}: ${h}`, secret: false, act: "hazard", object: null, rank: move.kind === "complication" || move.kind === "rule" ? 1.2 : 4 }));
    place.atmosphere.slice(0, 1).forEach((a) => push({ key: `${place.key}:atmosphere`, kind: "hazard", owner: null, about: `the feel of ${place.name}: ${a}`, secret: false, act: "hazard", object: null, rank: 6 }));
  }
  // What the move is about comes first: its own pull or property, or its main thread's pieces;
  // the cast's other facts after.
  const threadLed = ["payoff", "complication", "hint", "collision", "arrival", "callback", "rule"].includes(move.kind);
  for (const p of out) {
    if (move.source && (p.key.endsWith(`:pull:${move.source}`) || p.key.includes(`:prop:${move.source}:`))) p.rank -= 3;
    if (threadLed && p.key === `thread:${move.threads[0]}:summary`) p.rank = 0.9;
    if (threadLed && p.kind === "pull") p.rank += 1.5;
    if (move.kind === "hint" && (p.kind === "secret" || p.kind === "knowledge")) p.rank -= 1;
    if (move.kind === "arrival" && p.kind === "goal" && castOfMove(move, v, p.owner)?.can === "arrive") p.rank -= 1;
    if (move.kind === "collision" && move.threads.slice(1).some((id) => p.key === `thread:${id}:summary`)) p.rank = 1;
  }
  return out.sort((a, b) => Number(a.spent) - Number(b.spent) || a.rank - b.rank);
}

const castOfMove = (move: Move, v: View, k: NodeKey | null) => (k ? move.cast.find((c) => v.g.find(c.name)?.key === k) : undefined);

// Acts aimed at someone: which bound they'd cross.
const HARMS: BeatAct[] = ["threaten", "take", "lie"];
const HELPS_AGAINST_GOAL: BeatAct[] = ["give", "offer", "yield"];

/**
 * Whether a planned act would be out of character, as the behaviour bounds say (§7.5). Returns the
 * reason, or null. The act's object is whom it's aimed at; with no object, harm is aimed at the party.
 */
export function boundBreak(v: View, actorKey: NodeKey, act: BeatAct, object: NodeKey | null, payload: Payload): string | null {
  const n = v.g.nodes.get(actorKey);
  if (!isChar(n)) return null;
  const b = boundsFor(v, actorKey);
  const forbidden = new Set(b.forbidden);
  const allowed = new Set(b.allowed);
  const body = v.body.get(actorKey) ?? n.body;
  const charmer = body.conditions.find((c) => /^charmed/i.test(c.name))?.by as NodeKey | undefined;
  const pcs = [...v.g.nodes.values()].filter((x) => isChar(x) && x.side === "pc").map((x) => x.key as NodeKey);
  const aimedAt = object ? [object] : HARMS.includes(act) ? pcs : [];
  if (charmer && HARMS.includes(act) && aimedAt.includes(charmer)) return `${n.name} is charmed by ${v.g.nodes.get(charmer)?.name}, and can't harm them`;
  if (charmer && (act === "refuse" || act === "stall") && (object === charmer || payload.object === charmer) && !allowed.has("refuse-charmer")) return `${n.name} is charmed, and nothing lets them refuse ${v.g.nodes.get(charmer)?.name}`;
  if (forbidden.has("turn-on") && HARMS.includes(act)) {
    const bonded = interplaysFor(v, actorKey)
      .filter((i) => i.tightens.includes("turn-on"))
      .map((i) => (i.subject === actorKey ? i.other : i.subject))
      .filter((x): x is NodeKey => !!x);
    const hit = bonded.find((x) => aimedAt.includes(x));
    if (hit) return `${n.name} is devoted to ${v.g.nodes.get(hit)?.name}, and won't turn on them`;
  }
  // Giving up their own goal: off-character for someone committed to it, unless a tension
  // (conflicted) allows it; steadfast forbids it outright.
  if (HELPS_AGAINST_GOAL.includes(act) && payload.owner === actorKey && payload.kind === "goal") {
    const goal = n.mind.goals.find((g) => payload.key.endsWith(`:goal:${g.id ?? 0}`));
    const committed = (goal?.commitment ?? 0) >= 2;
    if (forbidden.has("act-against-goal") || (committed && !allowed.has("act-against-goal"))) return `${n.name} won't give up on "${goal?.text}"${forbidden.has("act-against-goal") ? " (steadfast)" : ""}`;
  }
  return null;
}

/**
 * A move's plan: up to `size` beats, each a different payload, best first, skipping any whose act
 * a bound rules out (and saying why). The actor is the payload's owner if they're in the cast
 * (here: they act; not here: they arrive, or send word), else the move's lead who's here, else the
 * world. A move with nothing to plan (the wildcard) gets none, and keeps the free scaffold.
 */
export function planMove(v: View, move: Move, opts: { size?: number; spent?: Set<string>; taken?: Set<string> } = {}) {
  const size = opts.size ?? 3;
  const beats: PlanBeat[] = [];
  const dropped: { about: string; why: string }[] = [];
  const free = move.kind === "wildcard";
  const castOf = (k: NodeKey | null) => (k ? move.cast.find((c) => v.g.find(c.name)?.key === k) : undefined);
  const lead = move.cast.find((c) => c.can === "act" && isChar(v.g.find(c.name)));
  const usedOwners = new Map<string, number>();
  // Payloads another move already plans rank after fresh ones, so the options differ.
  const ranked = payloadsFor(v, move, opts.spent).sort((a, b) => Number(a.spent) - Number(b.spent) || Number(!!opts.taken?.has(a.key)) - Number(!!opts.taken?.has(b.key)) || a.rank - b.rank);
  for (const p of free ? [] : ranked) {
    if (beats.length >= size) break;
    if (beats.some((b) => b.payload.key === p.key)) continue;
    // A thread's summary is only filler: at most one, beside something the records add.
    if (p.kind === "summary" && beats.some((b) => b.payload.kind === "summary")) continue;
    const ownerCast = castOf(p.owner);
    const ownerNode = p.owner ? v.g.nodes.get(p.owner) : undefined;
    let actor = "world";
    let beatKind: PlanBeat["beatKind"] = "world";
    let walkOn = "";
    if (ownerCast && isChar(ownerNode)) {
      actor = ownerCast.name;
      beatKind = ownerCast.can === "act" ? "npc" : move.kind === "arrival" ? "arrival" : "remote";
    } else if (ownerNode?.kind === "faction") {
      actor = "walk-on";
      beatKind = "walk_on";
      walkOn = `someone from ${ownerNode.name}`;
    } else if (["payoff", "stakes", "summary", "deadline"].includes(p.kind) && lead && !["hazard"].includes(p.act)) {
      actor = lead.name;
      beatKind = "npc";
    }
    // One character shouldn't carry the whole plan.
    if (actor !== "world" && actor !== "walk-on" && (usedOwners.get(actor) ?? 0) >= 2) continue;
    const act: BeatAct = beatKind === "arrival" && beats.every((b) => b.actor !== actor) ? "arrive" : beatKind === "remote" ? "send word" : p.act;
    const actorKey = actor !== "world" && actor !== "walk-on" ? (v.g.find(actor)?.key as NodeKey) : null;
    const broke = actorKey ? boundBreak(v, actorKey, act, p.object, p) : null;
    if (broke) {
      dropped.push({ about: p.about, why: broke });
      continue;
    }
    usedOwners.set(actor, (usedOwners.get(actor) ?? 0) + 1);
    beats.push({ id: `${move.id}.${beats.length + 1}`, actor, beatKind, walkOn, act, object: p.object, payload: p });
  }
  // Everyone in the cast who isn't in the plan yet may still have a line of their own (the only way
  // a named character acts when plans are on): the wildcard's whole plan is these.
  for (const c of move.cast) {
    if (beats.filter((b) => b.payload.kind === "free").length >= 2) break;
    if (beats.some((b) => b.actor === c.name) || !isChar(v.g.find(c.name))) continue;
    const t = v.g.nodes.get(`thread:${move.threads[0]}` as NodeKey);
    const k = v.g.find(c.name)!.key as NodeKey;
    const p: Payload = { key: `${k}:free:${move.threads[0]}`, kind: "free", owner: k, about: `${c.name}'s own line${t ? ` on "${t.name}"` : ""}`, secret: false, act: "respond", object: null, spent: false, rank: 99 };
    beats.push({ id: `${move.id}.${beats.length + 1}`, actor: c.name, beatKind: c.can === "act" ? "npc" : "arrival", walkOn: "", act: c.can === "act" ? "respond" : "arrive", object: null, payload: p });
  }
  return { beats, dropped };
}

/** The plans in the prompt: each move's beats, numbered, with who, what they do, and what with. */
export function plansBlock(v: View, plans: Map<string, PlanBeat[]>) {
  const lines: string[] = [];
  for (const [moveId, beats] of plans) {
    if (!beats.length) continue;
    lines.push(`${moveId}:`);
    for (const b of beats) {
      const who = b.actor === "world" ? "the world" : b.actor === "walk-on" ? b.walkOn || "a walk-on" : `${b.actor}${b.beatKind === "arrival" ? " (arriving)" : b.beatKind === "remote" ? " (from afar)" : ""}`;
      const at = b.object ? ` toward ${v.g.nodes.get(b.object)?.name ?? "someone"}` : "";
      lines.push(`- ${b.id} ${who} · ${b.act}${at} (${ACT_SAYS[b.act]}) · ${b.payload.about}${b.payload.secret ? " [GM secret: hint, never state]" : ""}`);
    }
  }
  return lines.length ? `\nBEAT PLANS (the engine's plan for each move: write an option on a move as its planned beats)\n${lines.join("\n")}\n` : "";
}

/** What this session has already delivered: payloads of used options and steps. */
export function spentThisSession(v: View) {
  const now = Math.max(0, ...v.g.log.map((e) => e.session));
  return new Set(v.g.log.filter((e) => e.session === now).flatMap((e) => e.payloads));
}

/** Beat plans are on when the GM (or a test run) says so: LOOM_BEAT_PLANS=on, or the option passed. */
export const beatPlansOn = (flag?: boolean) => flag ?? process.env.LOOM_BEAT_PLANS === "on";

export type RawPlanned = { kind: "planned"; plan: string; does: string };

/**
 * Turns an option's planned beats into ordinary beats, from its move's plan: the actor, kind and
 * walk-on come from the plan, never from the model. A beat naming another move's plan, or a plan
 * beat already used, is dropped (and said why). `used` carries across a chain's steps.
 */
export function applyPlans<O extends { move?: string; label?: string; setup: unknown[] }>(o: O, plans: Map<string, PlanBeat[]>, dropped: { label: string; reason: string }[], used: Set<string> = new Set()): O {
  if (!plans.size) return o;
  const mine = plans.get(o.move ?? "") ?? [];
  const setup = o.setup.flatMap((b) => {
    const raw = b as RawPlanned;
    if (raw?.kind !== "planned") return [b];
    const pb = mine.find((x) => x.id === raw.plan);
    if (!pb || used.has(pb.id)) {
      dropped.push({ label: o.label ?? "an option", reason: `sentence dropped: ${!pb ? `plan ${raw.plan} isn't this move's` : `plan ${raw.plan} was already used`}` });
      return [];
    }
    used.add(pb.id);
    return [{ kind: pb.beatKind, actor: pb.actor, walk_on: pb.walkOn, does: raw.does, plan: pb.id, payload: pb.payload.key }];
  });
  return { ...o, setup };
}

export const PLAN_TEXT = `- "planned": the only way a named character acts. Write an option's beats from its move's BEAT PLAN: plan is a beat id from that move's plan (each once, the first ones first, as many as LENGTH allows), and does is that beat in one sentence: that actor doing that act with that payload, and nothing the plan doesn't name. For a character or a walk-on, leave out who (code puts them in front); for the world, a full sentence. A GM secret is hinted, never stated. Beside planned beats you may add a "world" or "walk_on" beat for colour, and "happens" for what a PC feels.`;

/** Plans for every move together, so they deliver different things where they can. */
export function planMoves(v: View, moves: Move[], opts: { size?: number; spent?: Set<string> } = {}) {
  const taken = new Set<string>();
  const plans = new Map<string, PlanBeat[]>();
  const dropped: { about: string; why: string }[] = [];
  for (const m of moves) {
    const pl = planMove(v, m, { ...opts, taken });
    for (const b of pl.beats) taken.add(b.payload.key);
    plans.set(m.id, pl.beats);
    dropped.push(...pl.dropped);
  }
  return { plans, dropped };
}
