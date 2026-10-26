import { and, eq, isNull } from "drizzle-orm";
import { SKILL_ACT, type Act, type ActKind } from "./acts";
import { db, schema } from "./db/client";
import type { PairWeight } from "./db/schema";
import { taggedNames } from "./deltas";
import type { SubChange, WeightChange } from "./entity-extraction";
import type { ScaffoldOption } from "./improv";
import { readMoment, type ReadEntity } from "./moment-reading";
import { specOf } from "./sub-properties";
import { viewOf, type View } from "./world/engine";
import { THREAD_ROLES } from "./world/links";
import { loadGraph, OUTCOME, type LogEvent } from "./world/load";
import type { NodeKey } from "./world/nodes";
import { subOf, weightsOf } from "./world/props";

// Table nudges (docs/design-2026-10-26-property-model.md §8.2): what happens at the table moves
// NPCs' states and how they stand toward the party, a step at a time. Each event is typed from
// what code already knows, never from the model's prose:
// - typed acts (acts.ts): what the players declared in the moment, the side of a choice they took,
//   or a roll's skill aimed at someone;
// - the used choice's move, cast and hand-off;
// - the result the GM tapped;
// - the roles characters play in the thread it moved (their stance toward its outcome).
// The nudges become ordinary proposal items (source "table"), so they go through the same review
// (a DM's value or a flip from friend to foe is a question), apply and Take back as everything else.

export interface Nudge {
  who: string; // the character or faction whose value moves
  path?: string; // a sub-property ("state.fear", "alert")
  to?: string; // a pair weight toward this character or faction
  weight?: PairWeight;
  delta: 1 | -1;
  because: string; // in plain words, for the review and the log ("won the fight against them")
}

export interface EventContext {
  v: View;
  o: ScaffoldOption;
  phase: "used" | "result" | "side"; // just used; a roll or fight result; a choice's side taken
  outcome: LogEvent["outcome"]; // the result tapped, for a roll or fight
  roller: string | null; // the PC who rolls, if the hand-off is a PC's roll
  target: string | null; // the NPC the roll or hand-off is aimed at, when code can tell
  foes: string[]; // NPCs and factions on the other side of a fight
  party: string[]; // PCs with the party
  acts: Act[]; // the acts that landed (or failed) now
}

interface EventRow {
  id: string;
  says: string; // the row in words
  find: (c: EventContext) => Nudge[];
}

const FIGHT_OUTCOMES = new Set(["won", "lost", "fled", "talked"]);
const byPcs = (c: EventContext, a: Act) => (a.by === "party" ? c.party : [a.by]);
const character = (c: EventContext, name: string) => c.v.g.find(name)?.kind === "character";
// One row for every act of these kinds, nudging toward each PC who did it.
const actRow = (id: string, says: string, kinds: ActKind[], landed: Act["landed"], make: (a: Act, pc: string, c: EventContext) => Nudge[]): EventRow => ({
  id,
  says,
  find: (c) => c.acts.filter((a) => kinds.includes(a.act) && a.landed === landed).flatMap((a) => byPcs(c, a).flatMap((pc) => make(a, pc, c))),
});

export const EVENTS: EventRow[] = [
  actRow("helped", "the party helps, protects, frees, heals or gives to X: X warms to them and trusts them more", ["help", "protect", "free", "heal", "give"], "done", (a, pc) => [
    { who: a.on, to: pc, weight: "warmth", delta: 1, because: `${a.act === "give" ? "given something" : a.act === "free" ? "freed" : a.act === "heal" ? "healed" : a.act === "protect" ? "protected" : "helped"} by ${pc}` },
    { who: a.on, to: pc, weight: "trust", delta: 1, because: `${a.act === "give" ? "given something" : a.act === "free" ? "freed" : a.act === "heal" ? "healed" : a.act === "protect" ? "protected" : "helped"} by ${pc}` },
  ]),
  actRow("spared", "the party spares X: X warms to them and respects them more", ["spare"], "done", (a, pc) => [
    { who: a.on, to: pc, weight: "warmth", delta: 1, because: `spared by ${pc}` },
    { who: a.on, to: pc, weight: "respect", delta: 1, because: `spared by ${pc}` },
  ]),
  actRow("persuaded", "the party talks X round: X warms to them", ["persuade"], "done", (a, pc) => [{ who: a.on, to: pc, weight: "warmth", delta: 1, because: `talked round by ${pc}` }]),
  actRow("deceived, caught", "a lie to X is caught: X trusts that PC less", ["deceive"], "failed", (a, pc) => [{ who: a.on, to: pc, weight: "trust", delta: -1, because: `caught ${pc} lying` }]),
  {
    id: "threatened",
    says: "the party threatens X: X is angrier; if it works, X fears them more",
    find: (c) =>
      c.acts
        .filter((a) => a.act === "threaten" && a.landed !== "pending")
        .flatMap((a) => [
          ...(character(c, a.on) ? [{ who: a.on, path: "state.anger", delta: 1 as const, because: `threatened by ${a.by === "party" ? "the party" : a.by}` }] : []),
          ...(a.landed === "done" ? byPcs(c, a).map((pc): Nudge => ({ who: a.on, to: pc, weight: "fear", delta: 1, because: `cowed by ${pc}` })) : []),
        ]),
  },
  {
    id: "robbed",
    says: "the party steals from X: X is angry; if they're caught, X trusts and likes them less",
    find: (c) =>
      c.acts
        .filter((a) => a.act === "steal" && a.landed !== "pending")
        .flatMap((a) => [
          ...(character(c, a.on) ? [{ who: a.on, path: "state.anger", delta: 1 as const, because: "robbed" }] : []),
          ...(a.landed === "failed"
            ? byPcs(c, a).flatMap((pc): Nudge[] => [
                { who: a.on, to: pc, weight: "trust", delta: -1, because: `caught ${pc} stealing` },
                { who: a.on, to: pc, weight: "warmth", delta: -1, because: `caught ${pc} stealing` },
              ])
            : []),
        ]),
  },
  {
    id: "kept a secret",
    says: "the party presses X on what they know and X holds out: X is under more strain, if X has a secret to keep",
    find: (c) =>
      c.acts
        .filter((a) => a.act === "press" && a.landed === "failed")
        .filter((a) => {
          const n = c.v.g.find(a.on);
          return n?.kind === "character" && n.knowledge.some((k) => k.secret);
        })
        .map((a): Nudge => ({ who: a.on, path: "state.strain", delta: 1, because: "kept a secret under pressure" })),
  },
  actRow("hurt", "the party attacks X outside a fight's result: X is angrier and colder to them", ["harm"], "done", (a, pc, c) =>
    c.phase === "result" && c.outcome && FIGHT_OUTCOMES.has(c.outcome) ? [] : [{ who: a.on, to: pc, weight: "warmth", delta: -1, because: `attacked by ${pc}` }, ...(character(c, a.on) ? [{ who: a.on, path: "state.anger", delta: 1 as const, because: `attacked by ${pc}` }] : [])],
  ),
  {
    id: "fought",
    says: "a fight with X (won, lost or fled): X is colder toward the party",
    find: (c) => (c.outcome && FIGHT_OUTCOMES.has(c.outcome) && c.outcome !== "talked" ? c.foes.flatMap((f) => c.party.map((p): Nudge => ({ who: f, to: p, weight: "warmth", delta: -1, because: "fought the party" }))) : []),
  },
  {
    id: "beaten",
    says: "the party wins a fight with X: X is more afraid and less sure of itself; X's faction more alert",
    find: (c) =>
      c.outcome === "won"
        ? c.foes.flatMap((f): Nudge[] => {
            const n = c.v.g.find(f);
            if (n?.kind === "faction") return [{ who: f, path: "alert", delta: 1, because: "lost a fight to the party" }];
            const out: Nudge[] = [
              { who: f, path: "state.fear", delta: 1, because: "beaten by the party" },
              { who: f, path: "state.confidence", delta: -1, because: "beaten by the party" },
            ];
            for (const fac of factionsOf(c.v, f)) out.push({ who: fac, path: "alert", delta: 1, because: `${f} was beaten by the party` });
            return out;
          })
        : [],
  },
  {
    id: "won against them",
    says: "the party loses or flees a fight with X: X is surer of itself",
    find: (c) => (c.outcome === "lost" || c.outcome === "fled" ? c.foes.filter((f) => c.v.g.find(f)?.kind === "character").map((f): Nudge => ({ who: f, path: "state.confidence", delta: 1, because: c.outcome === "lost" ? "beat the party" : "saw the party flee" })) : []),
  },
  {
    id: "loyalty tested",
    says: "a defect or choose-a-side move is used: X's loyalty to its side slips",
    find: (c) => {
      const m = c.o.moveInfo;
      if (c.phase !== "used" || !m || (m.kind !== "defect" && m.kind !== "choose a side")) return [];
      const who = m.cast[0]?.name;
      const side = who ? strongestLoyalty(c.v, who) : null;
      return who && side ? [{ who, to: side, weight: "loyalty", delta: -1, because: m.kind === "defect" ? "tempted to defect" : "made to choose a side" }] : [];
    },
  },
  {
    id: "charm strains",
    says: "the charmer's roll to hold a charm on X fails: X is angry (the GM records whether the charm breaks)",
    find: (c) => {
      const m = c.o.moveInfo;
      if (m?.source !== "resists the charm" || c.outcome !== "failure") return [];
      const who = m.cast.find((x) => x.name !== c.roller)?.name;
      return who ? [{ who, path: "state.anger", delta: 1, because: "the charm on them slipped" }] : [];
    },
  },
  {
    id: "their thread moved",
    says: "a used choice moves a thread: NPCs who want it (seekers, creditors, the promised) are more hopeful; those against it (obstacles, rivals, guardians) less",
    find: (c) => {
      if (c.phase !== "used") return [];
      const t = c.v.g.nodes.get(`thread:${Number(c.o.thread.replace(/^T/, ""))}` as NodeKey);
      if (!t) return [];
      return c.v.g
        .linksOf(t.key as NodeKey, { type: "in_thread" })
        .map((l) => ({ n: c.v.g.nodes.get(c.v.g.other(l, t.key as NodeKey)), stance: THREAD_ROLES[l.role ?? ""]?.stance }))
        .filter((x) => x.n?.kind === "character" && x.n.side === "npc" && x.stance)
        .map((x): Nudge => ({ who: x.n!.name, path: "state.hope", delta: x.stance === "for" ? 1 : -1, because: `"${t.name}" moved ${x.stance === "for" ? "their way" : "against them"}` }));
    },
  },
];

// The factions someone belongs to.
function factionsOf(v: View, name: string) {
  const n = v.g.find(name);
  if (!n) return [];
  return v.g
    .linksOf((n.key as NodeKey), { type: "member_of", dir: "out" })
    .map((l) => v.g.nodes.get(v.g.other(l, (n.key as NodeKey))))
    .filter((x) => x?.kind === "faction")
    .map((x) => x!.name);
}

// Whom someone is most loyal to: a recorded loyalty weight first, else the faction or person
// they belong to or serve.
function strongestLoyalty(v: View, name: string) {
  const n = v.g.find(name);
  if (!n) return null;
  const sides = v.g
    .linksOf((n.key as NodeKey), { dir: "out" })
    .filter((l) => l.type === "member_of" || l.type === "serves")
    .map((l) => v.g.other(l, (n.key as NodeKey)));
  for (const [k, p] of v.g.pairs) if (k.startsWith(`${(n.key as NodeKey)}|`) && (p.weights.loyalty ?? 0) > 0) sides.push(k.split("|")[1] as NodeKey);
  const best = [...new Set(sides)].map((k) => ({ k, l: weightsOf(v, (n.key as NodeKey), k).loyalty.value ?? 0 })).sort((a, b) => b.l - a.l)[0];
  return best && best.l > 0 ? (v.g.nodes.get(best.k)?.name ?? null) : null;
}

const isNpc = (v: View, name: string) => {
  const n = v.g.find(name);
  return n?.kind === "character" && n.side === "npc";
};

const TYPE: Record<string, string> = { character: "npc", faction: "faction", item: "item", place: "location", other: "other" };

/**
 * Who a choice involves, as code can tell (the roller, the target, the foes and the party), and
 * which typed acts land now:
 * - on use, what the moment declared, unless a roll by whoever did it still decides it;
 * - at a roll's result, those acts and the roll's own skill act, done or failed by the outcome;
 * - when a choice's side is taken, that side's aim.
 */
export function contextOf(v: View, o: ScaffoldOption, outcome: LogEvent["outcome"], extra: { moment?: string; side?: number | null } = {}): EventContext {
  const pcs = [...v.g.nodes.values()].filter((n) => n.kind === "character" && n.side === "pc" && (!n.status || n.status === "alive"));
  const party = pcs.map((n) => n.name);
  const h = o.hand;
  const roller = h?.to && party.includes(h.to) ? h.to : null;
  // The target: an NPC named in what the roll or choice is up against, else the one NPC the move
  // or the sentences have acting here. Ambiguous means no target (no nudge beats a wrong one).
  const about = `${h?.what ?? ""} ${h?.kind === "choice" ? (h?.or ?? "") : ""}`;
  const named = taggedNames(about).filter((n) => isNpc(v, n));
  const plain = [...v.g.nodes.values()].filter((n) => n.kind === "character" && n.side === "npc" && about.includes(n.name)).map((n) => n.name);
  const acting = [...new Set([...(o.moveInfo?.cast.filter((c) => c.can === "act").map((c) => c.name) ?? []), ...o.setup.filter((b) => b.kind === "npc").map((b) => b.actor)])].filter((n) => isNpc(v, n));
  const pick = [...new Set([...named, ...plain])];
  // With no character to point at, an unnamed member stands for their faction ("spare the bandit",
  // with the Red Hand in the scene), when exactly one faction is in play.
  const factions = [...new Set([...taggedNames(about), ...o.setup.map((b) => b.actor), ...(o.refs ?? []).map((r) => r.name), ...(o.moveInfo?.cast.map((c) => c.name) ?? [])])].filter((n) => v.g.find(n)?.kind === "faction");
  const target = pick.length === 1 ? pick[0] : pick.length === 0 && acting.length === 1 ? acting[0] : pick.length === 0 && acting.length === 0 && factions.length === 1 ? factions[0] : null;
  // A fight's other side: NPCs and factions in the choice who aren't friends of the party.
  const involved = [...new Set([...(o.moveInfo?.cast.map((c) => c.name) ?? []), ...o.setup.map((b) => b.actor), ...(o.refs ?? []).map((r) => r.name), ...named])];
  const foes = involved.filter((name) => {
    const n = v.g.find(name);
    if (!n || (n.kind !== "character" && n.kind !== "faction") || (n.kind === "character" && n.side === "pc")) return false;
    const stance = "stance" in n ? (n.stance ?? 0) : 0;
    const warm = party.some((p) => (weightsOf(v, (n.key as NodeKey), (v.g.find(p)!.key as NodeKey)).warmth.value ?? 0) > 0);
    return stance < 0 || (!warm && stance <= 0 && (n.kind === "faction" || name === target || acting.includes(name)));
  });

  const phase: EventContext["phase"] = extra.side != null ? "side" : outcome ? "result" : "used";
  const rolling = !!h && ["check", "contest", "attack"].includes(h.kind);
  const decides = (a: Act) => rolling && (a.by === roller || (a.by === "party" && h!.to === "table"));
  const landedBy = (oc: LogEvent["outcome"]): Act["landed"] => (oc === "failure" ? "failed" : oc === "success" || oc === "partial" || (oc && FIGHT_OUTCOMES.has(oc)) ? "done" : "pending");
  const entities: ReadEntity[] = [...v.g.nodes.values()].filter((n) => TYPE[n.kind]).map((n) => ({ id: n.id, name: n.name, aliases: n.aliases, type: n.kind === "character" ? (n.side === "pc" ? "pc" : "npc") : TYPE[n.kind] }));
  const declared = extra.moment ? readMoment(entities, extra.moment).acts : [];
  const acts: Act[] = [];
  const add = (a: Act) => {
    if (a.landed !== "pending" && !acts.some((x) => x.act === a.act && x.by === a.by && x.on === a.on)) acts.push(a);
  };
  if (phase === "used") for (const a of declared) if (!decides(a)) add({ ...a, landed: "done" });
  if (phase === "result") {
    for (const a of declared) if (decides(a)) add({ ...a, landed: landedBy(outcome) });
    const skillAct = h?.kind === "attack" ? "harm" : h?.skill ? SKILL_ACT[h.skill] : undefined;
    if (rolling && skillAct && roller && target) add({ act: skillAct, by: roller, on: target, landed: landedBy(outcome), from: "roll" });
  }
  if (phase === "side" && h) {
    const aim = extra.side === 0 ? h.aim : h.or_aim;
    const by = h.to === "table" ? "party" : h.to;
    if (aim && aim !== "none" && target) add({ act: aim as ActKind, by, on: target, landed: "done", from: "choice" });
  }
  return { v, o, phase, outcome, roller, target, foes, party, acts };
}

/** The nudges an event makes, one per value (several rows touching one value count once). */
export function nudgesOf(c: EventContext): Nudge[] {
  const by = new Map<string, Nudge>();
  for (const row of EVENTS) for (const n of row.find(c)) by.set(`${n.who}|${n.path ?? `${n.to}.${n.weight}`}`, by.get(`${n.who}|${n.path ?? `${n.to}.${n.weight}`}`) ?? n);
  return [...by.values()];
}

const SESSION_CAP = 2;

/**
 * A used choice's (or a result's) nudges as proposal items: each value moved one step from where
 * it is now (a recorded value, else the default its ties imply, else 0), held within ±2 of where it
 * stood at the start of this session, and within its range. A weight that would go from warm to
 * cold (or back) is marked, and the review asks first.
 */
export async function tableNudges(campaignId: number, o: ScaffoldOption, outcome: string | null, evidence: string, extra: { moment?: string; side?: number | null } = {}) {
  const g = await loadGraph(campaignId);
  const v = viewOf(g, readMoment([], ""));
  const ctx = contextOf(v, o, extra.side == null && outcome ? (OUTCOME[outcome.trim().toLowerCase()] ?? null) : null, extra);
  const nudges = nudgesOf(ctx);
  const subs: SubChange[] = [];
  const weights: WeightChange[] = [];
  const capped: string[] = [];
  if (!nudges.length) return { subs, weights, capped, nudges };

  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(schema.sessions.number).then((r) => r.slice(-1));
  const rows = session
    ? await db
        .select()
        .from(schema.stateChanges)
        .where(and(eq(schema.stateChanges.campaignId, campaignId), eq(schema.stateChanges.sessionId, session.id), eq(schema.stateChanges.source, "table"), isNull(schema.stateChanges.undoneAt)))
        .orderBy(schema.stateChanges.id)
    : [];
  // Where a value stood before the table first moved it this session: undefined when the table
  // hasn't moved it yet; null when it was blank then (it stood at 0, or at what its ties implied).
  const startOf = (entityId: number, field: string) => {
    const r = rows.find((x) => x.entityId === entityId && x.field === field);
    return r ? ((r.before as number | null) ?? null) : undefined;
  };

  for (const n of nudges) {
    const node = g.find(n.who);
    if (!node) continue;
    let current: number;
    let field: string;
    let range: [number, number] = [-3, 3];
    if (n.path) {
      current = (subOf<number>(v, (node.key as NodeKey), n.path).value as number | null) ?? 0;
      field = `traits.${n.path}`;
      range = specOf(n.path)?.range ?? range;
    } else {
      const other = g.find(n.to!);
      if (!other) continue;
      current = weightsOf(v, (node.key as NodeKey), (other.key as NodeKey))[n.weight!].value ?? 0;
      field = `pair.${other.id}.${n.weight}`;
      if (n.weight === "fear" || n.weight === "debt" || n.weight === "loyalty") range = [0, 3];
    }
    const before = startOf(node.id, field);
    let start = before === undefined ? current : before;
    if (start === null) {
      if (n.path) start = 0;
      else {
        // What the ties alone imply, without the recorded weights.
        const k = `${node.key}|${g.find(n.to!)!.key}`;
        const saved = g.pairs.get(k);
        g.pairs.delete(k);
        start = weightsOf(viewOf(g, readMoment([], "")), node.key as NodeKey, g.find(n.to!)!.key as NodeKey)[n.weight!].value ?? 0;
        if (saved) g.pairs.set(k, saved);
      }
    }
    const lo = Math.max(range[0], start - SESSION_CAP);
    const hi = Math.min(range[1], start + SESSION_CAP);
    const clamped = Math.max(lo, Math.min(hi, current + n.delta));
    // A cap never moves a value the other way (the DM may have set it outside the session's band).
    const value = Math.sign(clamped - current) === n.delta ? clamped : current;
    if (value === current) {
      capped.push(`${n.who}: ${n.path ?? `${n.weight} toward ${n.to}`} stays at ${current} (${current + n.delta > range[1] || current + n.delta < range[0] ? "at the end of its range" : "moved enough this session"})`);
      continue;
    }
    if (n.path) subs.push({ name: n.who, key: n.path.split(".").pop()!, goal: "", value, evidence, path: n.path, because: n.because });
    else weights.push({ from: n.who, to: n.to!, weight: n.weight!, value, evidence, because: n.because, crosses: (start > 0 && value < 0) || (start < 0 && value > 0) });
  }
  return { subs, weights, capped, nudges };
}

// Settling (§8.3): after each session, NPCs' moving states drift back toward calm, one step:
// confidence, hope, anger and strain every session (strain after the rest between sessions);
// fear only when it's been two sessions since it last moved. A faction's alert settles too.
// The DM's own values stay where the DM put them. Logged as one batch, so it can be undone.
const SETTLES: Record<string, { every: number }> = { "state.confidence": { every: 1 }, "state.hope": { every: 1 }, "state.anger": { every: 1 }, "state.strain": { every: 1 }, "state.fear": { every: 2 }, alert: { every: 1 } };

export async function settleStates(campaignId: number, sessionNumber: number) {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const ended = sessions.find((s) => s.number === sessionNumber);
  const numberOf = new Map(sessions.map((s) => [s.id, s.number]));
  const prefix = `settle s${sessionNumber} `;
  // Once per session: a settle already done (and not undone) for this session isn't repeated.
  const done = await db.select({ batch: schema.stateChanges.batch }).from(schema.stateChanges).where(and(eq(schema.stateChanges.campaignId, campaignId), isNull(schema.stateChanges.undoneAt)));
  if (done.some((r) => r.batch?.startsWith(prefix))) return { settled: [] as string[], batch: null };
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const batch = `${prefix}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} #${Math.random().toString(36).slice(2, 6)}`;
  const { setSubProperty } = await import("./entities");
  const { getPath } = await import("./sub-properties");
  const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const settled: string[] = [];
  for (const e of ents) {
    if (e.type !== "npc" && e.type !== "faction") continue;
    for (const [path, rule] of Object.entries(SETTLES)) {
      if ((path === "alert") !== (e.type === "faction")) continue;
      const value = getPath(e.traits as Record<string, unknown>, path);
      const meta = e.fieldMeta[`traits.${path}`];
      if (typeof value !== "number" || value === 0 || meta?.source === "dm") continue;
      const last = meta?.sessionId != null ? (numberOf.get(meta.sessionId) ?? sessionNumber) : sessionNumber - rule.every;
      if (rule.every > 1 && sessionNumber - last < rule.every) continue;
      const next = value - Math.sign(value);
      await setSubProperty(e.id, path, next, { source: "table", sessionId: ended?.id ?? null, batch });
      settled.push(`${e.name}: ${path.replace(/^state\./, "")} ${value} → ${next}`);
    }
  }
  return { settled, batch: settled.length ? batch : null };
}
