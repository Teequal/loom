import { DISPOSITIONS } from "../entity-fields";
import { SUB_PROPERTIES } from "../sub-properties";
import { momentumOf, ruleUsesOf } from "./derived";
import { bodyOf, holdersOf, presenceOf, type View } from "./engine";
import type { AnyNode, Character, Faction, Goal, NodeKey, Thread } from "./nodes";
import { subOf, weightsOf } from "./props";

// Properties: values made from sub-properties, from other properties, and from the scene
// (docs/design-2026-10-26-property-model.md §5). Each property is a row: a list of terms, each an
// input with a factor, summed, then banded. Inputs read the graph; a term whose input is unknown
// counts for nothing and is reported as unknown, so a property says how much of it is known. A
// property can use other properties; the network is checked for loops and capped at depth 4 when
// this module loads. Nothing here is stored: it's worked out for each moment and cached.

export interface Term {
  label: string; // in words: "timid (−2)", "Pip is here and in danger"
  value: number; // after the factor
  known: boolean;
  sub?: PropValue; // when the input is another property: its own explanation, folded
}
export interface PropValue {
  name: string;
  value: number | null; // null when too little is known
  band: string | null;
  known: number; // how many terms are known
  of: number;
  terms: Term[];
  because: string[]; // the strongest known terms, in words
  situational: boolean; // depends on the scene of this moment
}

type Kind = "character" | "faction" | "thread";
interface Ctx {
  v: View;
  key: NodeKey;
  node: AnyNode;
  get: (name: string) => PropValue | null; // another property of the same node
}
// An input: a number with a label, or null when unknown.
type Input = (c: Ctx) => { value: number; label: string; sub?: PropValue } | null;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const round = (n: number) => Math.round(n * 10) / 10;
const asChar = (c: Ctx) => (c.node.kind === "character" ? (c.node as Character) : null);

// A disposition or state in words, from the registry's poles: boldness −2 reads "timid (−2)".
function subInput(path: string): Input {
  const spec = SUB_PROPERTIES.find((s) => s.path === path);
  const [low, high] = (spec?.means.split(" (")[0] ?? "").split(" ↔ ");
  return (c) => {
    const s = subOf(c.v, c.key, path);
    if (!s.known || typeof s.value !== "number") return null;
    const name = path.split(".").pop()!;
    const word = high && s.value > 0 ? high : low && s.value < 0 ? low : name;
    return { value: s.value, label: `${spec?.layer === "state" ? name : word} (${signed(s.value)}${s.source === "default" ? ", default" : ""})` };
  };
}

// Another property of the same node, as an input.
const prop =
  (name: string): Input =>
  (c) => {
    const p = c.get(name);
    return p && p.value != null ? { value: p.value, label: `${name} ${p.band ?? signed(round(p.value))}`, sub: p } : null;
  };

const activeGoals = (goals: Goal[]) => goals.filter((g) => !g.status || g.status === "active" || g.status === "blocked");
const topGoal = (goals: Goal[]) => [...activeGoals(goals)].sort((a, b) => a.priority - b.priority)[0];

// ---------- Scene inputs: what this moment puts around them ----------

const here = (c: Ctx, k: NodeKey) => presenceOf(c.v, k).role === "here";
const people = (c: Ctx) => [...c.v.g.nodes.values()].filter((n): n is Character => n.kind === "character" && n.key !== c.key);
const namedNow = (c: Ctx) => new Set([...c.v.reading.broughtIn, ...c.v.reading.referred, ...c.v.reading.contacted, ...c.v.reading.acting]);

export const INPUTS: Record<string, Input> = {
  // Goals
  goalIntent: (c) => {
    const n = c.node as Character | Faction;
    const goals = activeGoals(n.kind === "faction" ? n.aims : n.kind === "character" ? n.mind.goals : []).filter((g) => g.intent != null);
    if (!goals.length) return null;
    const w = (g: Goal) => 4 - g.priority;
    const value = goals.reduce((s, g) => s + g.intent! * w(g), 0) / goals.reduce((s, g) => s + w(g), 0);
    const top = [...goals].sort((a, b) => a.priority - b.priority)[0];
    return { value: round(value), label: `"${top.text}" (${signed(top.intent!)})${goals.length > 1 ? `, and ${goals.length - 1} more` : ""}` };
  },
  topCommitment: (c) => {
    const ch = asChar(c);
    const g = ch && topGoal(ch.mind.goals);
    return g?.commitment != null ? { value: g.commitment, label: `committed to "${g.text}" (${g.commitment})` } : null;
  },
  topConviction: (c) => {
    const ch = asChar(c);
    const b = ch?.mind.beliefs.filter((x) => x.conviction != null).sort((a, b) => b.conviction! - a.conviction!)[0];
    return b ? { value: b.conviction!, label: `believes "${b.text}" (${b.conviction})` } : null;
  },
  blockedGoals: (c) => {
    const ch = asChar(c);
    const n = ch?.mind.goals.filter((g) => g.status === "blocked").length ?? 0;
    return n ? { value: n, label: `${n} goal${n > 1 ? "s" : ""} blocked` } : null;
  },
  // Body and the table
  wounds: (c) => {
    const ch = asChar(c);
    const h = ch && bodyOf(c.v, ch).health;
    if (!h) return null;
    const value = { healthy: 0, wounded: 0.5, bloodied: 1, critical: 2, unconscious: 3, dead: 3 }[h] ?? 0;
    return { value, label: h };
  },
  momentum: (c) => {
    const ch = asChar(c);
    const m = ch?.side === "pc" ? momentumOf(c.v).get(ch.name) : undefined;
    return m?.band ? { value: m.band === "on a roll" ? 1 : -1, label: `${m.band} (${m.because.join(", ")})` } : null;
  },
  captured: (c) => (c.node.kind === "character" && c.node.status === "captured" ? { value: 2, label: "captured" } : null),
  charmed: (c) => {
    const ch = asChar(c);
    const cond = ch && bodyOf(c.v, ch).conditions.find((x) => /^charmed/i.test(x.name));
    return cond ? { value: 2, label: `charmed${cond.by ? ` by ${c.v.g.nodes.get(cond.by as NodeKey)?.name ?? "someone"}` : ""}` } : null;
  },
  // How they stand with the party: warmth to each PC, weighted by trust (+3 trust counts 4×, −3 counts 1×).
  standing: (c) => {
    const ch = asChar(c);
    if (!ch || ch.side !== "npc") return null;
    const pcs = people(c).filter((p) => p.side === "pc");
    const known = pcs.map((p) => ({ p, w: weightsOf(c.v, c.key, p.key as NodeKey) })).filter((x) => x.w.warmth.known);
    if (!known.length) return ch.stance != null ? { value: ch.stance, label: `attitude to the party (${signed(ch.stance)})` } : null;
    const weight = (x: (typeof known)[number]) => 2.5 + ((x.w.trust.value ?? 0) as number) / 2;
    const value = known.reduce((s, x) => s + (x.w.warmth.value as number) * weight(x), 0) / known.reduce((s, x) => s + weight(x), 0);
    const best = [...known].sort((a, b) => Math.abs(b.w.warmth.value as number) - Math.abs(a.w.warmth.value as number))[0];
    return { value: round(value), label: `warmth to ${best.p.name} (${signed(best.w.warmth.value as number)})${known.length > 1 ? ` and ${known.length - 1} more` : ""}` };
  },
  // Who's here that they fear, or owe.
  fearNear: (c) => {
    const near = people(c).filter((p) => here(c, p.key as NodeKey) || namedNow(c).has(p.name));
    const worst = near.map((p) => ({ p, f: weightsOf(c.v, c.key, p.key as NodeKey).fear })).filter((x) => x.f.known).sort((a, b) => (b.f.value as number) - (a.f.value as number))[0];
    return worst ? { value: worst.f.value as number, label: `afraid of ${worst.p.name} (${worst.f.value})` } : null;
  },
  debtNear: (c) => {
    const near = people(c).filter((p) => here(c, p.key as NodeKey) || namedNow(c).has(p.name));
    const worst = near.map((p) => ({ p, d: weightsOf(c.v, c.key, p.key as NodeKey).debt })).filter((x) => x.d.known && (x.d.value as number) > 0).sort((a, b) => (b.d.value as number) - (a.d.value as number))[0];
    return worst ? { value: worst.d.value as number, label: `owes ${worst.p.name} (${worst.d.value})` } : null;
  },
  // What's at stake for them in this moment: a goal whose target the moment involves, someone they
  // love named in it.
  atStake: (c) => {
    const ch = asChar(c);
    if (!ch) return null;
    const named = namedNow(c);
    const involved = (k?: string) => !!k && (named.has(c.v.g.nodes.get(k as NodeKey)?.name ?? "") || here(c, k as NodeKey));
    const goal = activeGoals(ch.mind.goals).filter((g) => involved(g.target)).sort((a, b) => (b.commitment ?? 1) - (a.commitment ?? 1))[0];
    const loved = people(c).filter((p) => named.has(p.name) && ((weightsOf(c.v, c.key, p.key as NodeKey).warmth.value as number) ?? 0) >= 2);
    const value = Math.min(3, (goal ? (goal.commitment ?? 1) : 0) + (loved.length ? 1 : 0));
    if (!value) return null;
    return { value, label: [goal && `"${goal.text}" is in play`, loved.length && `${loved.map((p) => p.name).join(", ")} ${loved.length > 1 ? "are" : "is"} in this`].filter(Boolean).join("; ") };
  },
  alliesPresent: (c) => {
    const allies = people(c).filter((p) => here(c, p.key as NodeKey) && ((weightsOf(c.v, p.key as NodeKey, c.key).warmth.value as number) ?? 0) >= 2);
    return allies.length ? { value: Math.min(2, allies.length), label: `${allies.map((p) => p.name).join(", ")} beside them` } : null;
  },
  threatPresent: (c) => {
    const threats = people(c).filter((p) => {
      if (!here(c, p.key as NodeKey)) return false;
      const theirs = weightsOf(c.v, p.key as NodeKey, c.key).warmth;
      const mine = weightsOf(c.v, c.key, p.key as NodeKey).fear;
      return ((theirs.value as number) ?? 0) <= -2 || ((mine.value as number) ?? 0) >= 2;
    });
    const place = c.v.party;
    const danger = place?.danger ?? 0;
    const value = Math.min(3, threats.length + (presenceOf(c.v, c.key).role === "here" ? danger / 2 : 0));
    return value ? { value, label: [threats.length && `${threats.map((p) => p.name).join(", ")} here`, danger && presenceOf(c.v, c.key).role === "here" && `${place!.name} is dangerous`].filter(Boolean).join("; ") } : null;
  },
  observed: (c) => {
    const watchers = people(c).filter((p) => here(c, p.key as NodeKey) && ((weightsOf(c.v, c.key, p.key as NodeKey).respect.value as number) ?? 0) >= 2);
    return watchers.length ? { value: 1, label: `${watchers[0].name} is watching` } : null;
  },
  // Items they hold that pull at them: the strongest pull, plus how often its rule has been used.
  heldPull: (c) => {
    const held = [...c.v.g.nodes.values()].filter((i) => i.kind === "item" && holdersOf(c.v, i.key as NodeKey).some((h) => h.holder === c.key) && i.properties.pull != null);
    const best = held.sort((a, b) => ((b as { properties: { pull?: number } }).properties.pull ?? 0) - ((a as { properties: { pull?: number } }).properties.pull ?? 0))[0];
    if (!best || best.kind !== "item") return null;
    const uses = [...ruleUsesOf(c.v)].filter(([rule]) => rule.toLowerCase().includes(best.name.split(" ")[0].toLowerCase())).reduce((s, [, u]) => s + u.session, 0);
    return { value: best.properties.pull! + uses / 2, label: `${best.name} pulls (${best.properties.pull})${uses ? `, used ${uses}× this session` : ""}` };
  },
  // Factions
  memberLoyalty: (c) => {
    if (c.node.kind !== "faction") return null;
    const members = c.v.g.linksOf(c.key, { type: "member_of", dir: "in" }).map((l) => c.v.g.other(l, c.key));
    const ws = members.map((m) => weightsOf(c.v, m, c.key).loyalty).filter((w) => w.known);
    return ws.length ? { value: round(ws.reduce((s, w) => s + (w.value as number), 0) / ws.length), label: `${ws.length === 1 ? "its one member's" : `${ws.length} members'`} loyalty` } : null;
  },
  hollowMembers: (c) => {
    if (c.node.kind !== "faction") return null;
    const members = c.v.g.linksOf(c.key, { type: "member_of", dir: "in" }).map((l) => c.v.g.other(l, c.key));
    // Only loyalty someone recorded counts as hollow; the default for a member is a mere 1.
    const hollow = members.filter((m) => {
      const l = weightsOf(c.v, m, c.key).loyalty;
      return l.known && l.source !== "default" && (l.value as number) <= 1;
    });
    return hollow.length ? { value: hollow.length, label: `${hollow.length} with little loyalty` } : null;
  },
  partyWarmth: (c) => {
    if (c.node.kind !== "faction") return null;
    const members = c.v.g.linksOf(c.key, { type: "member_of", dir: "in" }).map((l) => c.v.g.other(l, c.key));
    const pcs = [...c.v.g.nodes.values()].filter((n) => n.kind === "character" && n.side === "pc");
    const ws = members.flatMap((m) => pcs.map((p) => weightsOf(c.v, m, p.key as NodeKey).warmth)).filter((w) => w.known);
    if (ws.length) return { value: round(ws.reduce((s, w) => s + (w.value as number), 0) / ws.length), label: "its members' warmth to the party" };
    const f = c.node as Faction;
    return f.stance != null ? { value: f.stance, label: `attitude to the party (${signed(f.stance)})` } : null;
  },
  alert: (c) => (c.node.kind === "faction" && c.node.alert != null ? { value: c.node.alert, label: `alert (${c.node.alert})` } : null),
  // Threads
  stakes: (c) => (c.node.kind === "thread" && c.node.stakes.level != null ? { value: c.node.stakes.level, label: `stakes ${c.node.stakes.level}` } : null),
  urgency: (c) => (c.node.kind === "thread" && c.node.urgency != null ? { value: c.node.urgency, label: `urgency ${c.node.urgency}` } : null),
  neglect: (c) => {
    if (c.node.kind !== "thread") return null;
    const t = c.node as Thread;
    const latest = Math.max(0, ...[...c.v.g.nodes.values()].filter((n) => n.kind === "session").map((n) => (n as { number: number }).number));
    const gap = t.lastTouched != null && latest ? latest - t.lastTouched : 0;
    return gap > 0 ? { value: gap, label: `untouched ${gap} session${gap > 1 ? "s" : ""}` } : null;
  },
};
for (const d of DISPOSITIONS) INPUTS[d] = subInput(`disposition.${d}`);
for (const s of ["confidence", "fear", "anger", "hope", "strain"]) INPUTS[`state.${s}`] = subInput(`state.${s}`);

// What an input is called when it isn't known, in the inspector and `entity why`.
const UNKNOWN_LABEL: Record<string, string> = {
  goalIntent: "who their goals are good for",
  topCommitment: "how committed they are to their top goal",
  topConviction: "how firmly they hold a belief",
  blockedGoals: "blocked goals",
  wounds: "health",
  momentum: "how the dice have gone lately",
  captured: "captured",
  charmed: "charmed",
  standing: "how they stand with the party",
  fearNear: "fear of anyone in the scene",
  debtNear: "debts to anyone in the scene",
  atStake: "what's at stake for them here",
  alliesPresent: "friends beside them",
  threatPresent: "threats in the scene",
  observed: "someone they respect watching",
  heldPull: "an item pulling at them",
  memberLoyalty: "its members' loyalty",
  hollowMembers: "members with little loyalty",
  partyWarmth: "its members' warmth to the party",
  alert: "how alert it is",
  stakes: "stakes",
  urgency: "urgency",
  neglect: "how long it's been left",
  "prop:confidence": "confidence",
  "prop:resolve": "resolve",
  "prop:pressure": "pressure",
  "prop:standing": "standing with the party",
};

// ---------- The property table ----------

export interface PropertyDef {
  name: string;
  on: Kind;
  npcOnly?: boolean;
  situational?: boolean; // reads the scene
  terms: [string, number][]; // [input or "prop:name", factor]
  needs: string[]; // inputs that must be known (any one of them), or [] for "at least one term"
  bands: [number, string][]; // [upper bound (exclusive), band], last is the rest
  examples?: string; // what it means, for the inspector
}

export const PROPERTIES: PropertyDef[] = [
  { name: "intent", on: "character", terms: [["goalIntent", 1]], needs: ["goalIntent"], bands: [[-1.5, "malign"], [-0.5, "self-serving"], [0.5, "mixed"], [Infinity, "benign"]], examples: "who their goals are good for, weighted by priority" },
  { name: "confidence", on: "character", terms: [["state.confidence", 1], ["momentum", 1], ["wounds", -0.5]], needs: ["state.confidence", "momentum"], bands: [[-1, "shaken"], [1.5, "steady"], [Infinity, "sure"]] },
  { name: "resolve", on: "character", situational: true, terms: [["topCommitment", 1], ["topConviction", 0.5], ["prop:confidence", 0.5], ["atStake", 0.5], ["state.strain", -0.5], ["wounds", -0.5]], needs: ["topCommitment"], bands: [[2, "wavering"], [4, "steady"], [Infinity, "iron"]] },
  { name: "standing", on: "character", npcOnly: true, terms: [["standing", 1]], needs: ["standing"], bands: [[-2, "hostile"], [-0.5, "cold"], [0.5, "neutral"], [2.5, "warm"], [Infinity, "devoted"]], examples: "how they stand with the party" },
  { name: "pressure", on: "character", situational: true, terms: [["fearNear", 1], ["debtNear", 1], ["blockedGoals", 1], ["captured", 1], ["wounds", 0.5]], needs: [], bands: [[2, "at ease"], [4, "pressed"], [Infinity, "cornered"]] },
  { name: "courage", on: "character", situational: true, terms: [["boldness", 1], ["prop:confidence", 1], ["atStake", 1], ["alliesPresent", 1], ["threatPresent", -1], ["state.fear", -1], ["wounds", -1]], needs: ["boldness", "prop:confidence"], bands: [[-2.5, "cowed"], [-0.5, "wary"], [1.5, "steady"], [4, "brave"], [Infinity, "reckless"]], examples: "temperament, confidence and what's at stake here, less what threatens them" },
  { name: "restraint", on: "character", situational: true, terms: [["discipline", 1], ["temper", -1], ["state.anger", -1], ["observed", 1]], needs: ["discipline", "temper"], bands: [[-1.5, "snaps"], [1, "strained"], [Infinity, "holds"]] },
  { name: "candour", on: "character", situational: true, terms: [["honesty", 1], ["prop:pressure", -0.5], ["greed", -0.5], ["prop:standing", 0.5]], needs: ["honesty"], bands: [[-2, "lies"], [0, "evades"], [1.5, "half-truths"], [Infinity, "candid"]] },
  { name: "generosity", on: "character", terms: [["compassion", 1], ["greed", -1], ["prop:standing", 1], ["state.hope", 0.5]], needs: ["compassion", "greed"], bands: [[-1, "grasping"], [1.5, "trades"], [Infinity, "gives"]], examples: "toward the party" },
  { name: "susceptibility", on: "character", situational: true, terms: [["prop:resolve", -0.5], ["state.strain", 1], ["fidelity", -0.5], ["charmed", 1]], needs: ["prop:resolve", "fidelity", "charmed"], bands: [[-2, "immovable"], [0, "resistant"], [1.5, "open"], [Infinity, "pliable"]], examples: "to persuasion, charm or fear" },
  { name: "temptation", on: "character", terms: [["heldPull", 1], ["prop:resolve", -0.5]], needs: ["heldPull"], bands: [[1, "none"], [2.5, "tugging"], [Infinity, "gripping"]], examples: "an item that pulls at its holder" },
  { name: "intent", on: "faction", terms: [["goalIntent", 1]], needs: ["goalIntent"], bands: [[-1.5, "malign"], [-0.5, "self-serving"], [0.5, "mixed"], [Infinity, "benign"]] },
  { name: "cohesion", on: "faction", terms: [["memberLoyalty", 1], ["hollowMembers", -1]], needs: ["memberLoyalty"], bands: [[0.5, "fractured"], [1.5, "holding"], [Infinity, "united"]] },
  { name: "reputation", on: "faction", terms: [["partyWarmth", 1], ["alert", -0.5]], needs: ["partyWarmth", "alert"], bands: [[-2, "wanted"], [-0.5, "distrusted"], [0.5, "unknown"], [2, "welcome"], [Infinity, "honoured"]], examples: "the party's standing with them" },
  { name: "pressure", on: "thread", terms: [["stakes", 1], ["urgency", 1], ["neglect", 0.5]], needs: ["stakes", "urgency"], bands: [[3, "quiet"], [5, "building"], [Infinity, "urgent"]] },
];

// The network: properties used by properties. No loops, and at most 4 deep, checked once here.
const usesOf = (d: PropertyDef) => d.terms.map(([t]) => t).filter((t) => t.startsWith("prop:")).map((t) => t.slice(5));
export function checkNetwork(defs: PropertyDef[] = PROPERTIES): string | null {
  for (const kind of ["character", "faction", "thread"] as Kind[]) {
    const byName = new Map(defs.filter((d) => d.on === kind).map((d) => [d.name, d]));
    const depth = (name: string, seen: string[]): number => {
      if (seen.includes(name)) throw new Error(`a loop: ${[...seen, name].join(" → ")}`);
      const d = byName.get(name);
      if (!d) throw new Error(`${seen[seen.length - 1] ?? "?"} uses ${name}, which isn't a ${kind} property`);
      return 1 + Math.max(0, ...usesOf(d).map((u) => depth(u, [...seen, name])));
    };
    try {
      for (const name of byName.keys()) if (depth(name, []) > 4) return `${name} is more than 4 deep`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}
const problem = checkNetwork();
if (problem) throw new Error(`Property network: ${problem}`);
for (const d of PROPERTIES) for (const [t] of d.terms) if (!t.startsWith("prop:") && !INPUTS[t]) throw new Error(`Property ${d.name} uses an unknown input "${t}"`);

// ---------- Working them out ----------

const cache = new WeakMap<View, Map<string, PropValue | null>>();

/** One property of a node, for this moment (null if the node can't have it). */
export function propertyOf(v: View, key: NodeKey, name: string): PropValue | null {
  if (!cache.has(v)) cache.set(v, new Map());
  const memo = cache.get(v)!;
  const id = `${key}/${name}`;
  if (memo.has(id)) return memo.get(id)!;
  const node = v.g.nodes.get(key);
  const def = node && PROPERTIES.find((d) => d.name === name && d.on === node.kind && !(d.npcOnly && node.kind === "character" && node.side !== "npc"));
  if (!node || !def) {
    memo.set(id, null);
    return null;
  }
  const ctx: Ctx = { v, key, node, get: (n) => propertyOf(v, key, n) };
  const terms: (Term & { input: string })[] = def.terms.map(([input, factor]) => {
    const r = input.startsWith("prop:") ? prop(input.slice(5))(ctx) : INPUTS[input](ctx);
    return r ? { input, label: r.label, value: round(r.value * factor), known: true, sub: r.sub } : { input, label: UNKNOWN_LABEL[input] ?? input.replace(/^prop:|^state\./, ""), value: 0, known: false };
  });
  const knownTerms = terms.filter((t) => t.known);
  const enough = def.needs.length ? def.needs.some((n) => terms.find((t) => t.input === n)?.known) : knownTerms.length > 0;
  const value = enough ? round(knownTerms.reduce((s, t) => s + t.value, 0)) : null;
  const band = value == null ? null : (def.bands.find(([upper]) => value < upper) ?? def.bands[def.bands.length - 1])[1];
  // The strongest reasons for where it landed first; anything pulling the other way after, as "though…".
  const sign = Math.sign(value ?? 0);
  const ranked = [...knownTerms].filter((t) => t.value !== 0).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const forIt = ranked.filter((t) => !sign || Math.sign(t.value) === sign).slice(0, 3);
  const against = ranked.filter((t) => sign && Math.sign(t.value) === -sign).slice(0, Math.max(1, 3 - forIt.length));
  const because = [...forIt.map((t) => t.label), ...against.map((t) => `though ${t.label}`)];
  const out: PropValue = { name, value, band, known: knownTerms.length, of: terms.length, terms: terms.map(({ input: _i, ...t }) => (void _i, t)), because, situational: !!def.situational || terms.some((t) => t.sub?.situational) };
  memo.set(id, out);
  return out;
}

/** Every property of a node that's known, for the inspector and prompts. */
export function propertiesOf(v: View, key: NodeKey): PropValue[] {
  const node = v.g.nodes.get(key);
  if (!node) return [];
  const names = [...new Set(PROPERTIES.filter((d) => d.on === node.kind).map((d) => d.name))];
  return names.map((n) => propertyOf(v, key, n)).filter((p): p is PropValue => !!p && p.value != null);
}

/** A property in one line: "courage brave: Pip is in this; Tomas beside them; despite timid (−2)". */
export const propertyLine = (p: PropValue) => `${p.name} ${p.band}${p.because.length ? `: ${p.because.join("; ")}` : ""}${p.known < p.of ? ` (${p.known} of ${p.of} known)` : ""}`;
