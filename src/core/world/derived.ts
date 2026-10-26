import type { View } from "./engine";
import type { LogEvent } from "./load";

// Derived state (docs/plan-2026-10-26-beat-plans-and-derived-state.md): values the engine works
// out from what has happened at the table, never stored as facts. Each says why, and fades: this
// session counts fully, the one before half, older not at all. The records stay the GM's.

export interface Derived<B extends string> {
  score: number;
  band: B | null; // null: nothing worth saying
  because: string[];
}

const latestSession = (log: LogEvent[]) => Math.max(0, ...log.map((e) => e.session));
const fade = (session: number, latest: number) => (session === latest ? 1 : session === latest - 1 ? 0.5 : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What each kind of result is worth to the one who rolled.
const WORTH: Record<NonNullable<LogEvent["outcome"]>, number> = { success: 1, partial: 0.25, failure: -1, won: 1.5, lost: -2, fled: -1, talked: 0.5 };

const SAY: Record<NonNullable<LogEvent["outcome"]>, (n: number) => string> = {
  success: (n) => (n === 1 ? "made a roll" : `made ${n} rolls`),
  failure: (n) => (n === 1 ? "failed a roll" : `failed ${n} rolls`),
  partial: (n) => (n === 1 ? "partly made a roll" : `partly made ${n} rolls`),
  won: (n) => (n === 1 ? "won a fight" : `won ${n} fights`),
  lost: (n) => (n === 1 ? "lost a fight" : `lost ${n} fights`),
  fled: (n) => (n === 1 ? "fled a fight" : `fled ${n} fights`),
  talked: (n) => (n === 1 ? "talked a fight down" : `talked ${n} fights down`),
};

/**
 * PC momentum: how the dice and fights have gone for each PC lately. "rattled" after a run of
 * failures or a lost fight; "on a roll" after a run of successes. A roll for the whole table
 * counts for everyone.
 */
export function momentumOf(v: View): Map<string, Derived<"on a roll" | "rattled">> {
  const cached = momentumCache.get(v);
  if (cached) return cached;
  const log = v.g.log;
  const latest = latestSession(log);
  const pcs = [...v.g.nodes.values()].filter((n) => n.kind === "character" && n.side === "pc").map((n) => n.name);
  const out = new Map<string, Derived<"on a roll" | "rattled">>();
  for (const pc of pcs) {
    let score = 0;
    const tally = new Map<string, number>();
    for (const e of log) {
      if (e.kind !== "result" || !e.outcome || (e.roller !== pc && e.roller !== "table")) continue;
      const w = fade(e.session, latest);
      if (!w) continue;
      score += WORTH[e.outcome] * w;
      tally.set(e.outcome, (tally.get(e.outcome) ?? 0) + 1);
    }
    const because = [...tally].map(([o, n]) => SAY[o as keyof typeof SAY](n));
    out.set(pc, { score: Math.round(score * 10) / 10, band: score >= 2 ? "on a roll" : score <= -2 ? "rattled" : null, because });
  }
  momentumCache.set(v, out);
  return out;
}
const momentumCache = new WeakMap<View, Map<string, Derived<"on a roll" | "rattled">>>();

export interface RuleUse {
  session: number; // uses this session
  total: number;
  by: Map<string, number>; // this session, per roller
}

/**
 * How often each house rule's roll has been used: this session and in all. A rule's cost can grow
 * with use ("the figurine's pull gets worse each time"), so the engine can say which use this is.
 */
export function ruleUsesOf(v: View): Map<string, RuleUse> {
  const cached = rulesCache.get(v);
  if (cached) return cached;
  const log = v.g.log;
  const latest = latestSession(log);
  const out = new Map<string, RuleUse>();
  for (const e of log) {
    // A rule roll counts once it's used: the option or step with it was chosen.
    if (!e.mechanic || (e.kind !== "option" && e.kind !== "branch")) continue;
    const u = out.get(e.mechanic) ?? { session: 0, total: 0, by: new Map<string, number>() };
    u.total++;
    if (e.session === latest) {
      u.session++;
      if (e.roller) u.by.set(e.roller, (u.by.get(e.roller) ?? 0) + 1);
    }
    out.set(e.mechanic, u);
  }
  rulesCache.set(v, out);
  return out;
}
const rulesCache = new WeakMap<View, Map<string, RuleUse>>();

/**
 * The session's pace, from the last few choices used: "tense" right after a fight or a run of
 * rolls (a breather may fit), "slack" after a long stretch with neither (something should push).
 */
export function paceOf(v: View): Derived<"tense" | "slack"> {
  const cached = paceCache.get(v);
  if (cached) return cached;
  const log = v.g.log;
  const latest = latestSession(log);
  const used = log.filter((e) => e.session === latest && (e.kind === "option" || e.kind === "branch" || e.kind === "own" || e.kind === "result"));
  const recent = used.slice(-4);
  const fights = recent.filter((e) => e.fight && e.kind !== "result").length;
  // A roll is counted when it's asked for (the choice used), not again when its result comes in.
  const rolled = (e: LogEvent) => !!e.roller && e.kind !== "result";
  const rolls = recent.filter(rolled).length;
  const lastHeat = [...used].reverse().findIndex((e) => (e.fight && e.kind !== "result") || rolled(e));
  const sinceHeat = lastHeat < 0 ? used.length : lastHeat;
  let out: Derived<"tense" | "slack">;
  if (fights >= 1 || rolls >= 3) out = { score: fights * 2 + rolls, band: "tense", because: [fights ? `${plural(fights, "fight")} in the last ${recent.length} choices` : `${rolls} rolls in the last ${recent.length} choices`] };
  else if (used.length >= 5 && sinceHeat >= 5) out = { score: -sinceHeat, band: "slack", because: [`no roll or fight in the last ${sinceHeat} choices`] };
  else out = { score: 0, band: null, because: [] };
  paceCache.set(v, out);
  return out;
}
const paceCache = new WeakMap<View, Derived<"tense" | "slack">>();

/** The derived state in a few lines, for the prompt: only what's worth saying. */
export function derivedLines(v: View): string[] {
  const lines: string[] = [];
  const pace = paceOf(v);
  if (pace.band) lines.push(`Pace: ${pace.band} (${pace.because.join("; ")})${pace.band === "tense" ? ": a breather may fit" : ": something should push"}.`);
  for (const [pc, m] of momentumOf(v)) if (m.band) lines.push(`${pc}: ${m.band} (${m.because.join(", ")}).`);
  for (const [rule, u] of ruleUsesOf(v)) {
    if (!u.session) continue;
    const who = [...u.by].map(([w, n]) => `${w === "table" ? "the table" : w} ${n}`).join(", ");
    lines.push(`${rule}: used ${plural(u.session, "time")} this session${who ? ` (${who})` : ""}${u.session >= 2 ? ": its cost should be growing" : ""}.`);
  }
  return lines;
}
