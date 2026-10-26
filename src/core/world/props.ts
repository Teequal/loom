import { PAIR_WEIGHTS, type PairWeight } from "../db/schema";
import type { View } from "./engine";
import { LINK_TYPES } from "./links";
import type { AnyNode, FieldMeta, NodeKey } from "./nodes";

// Reading the property model's sub-properties off the graph (docs/design-2026-10-26-property-model.md
// §4, §7.1). Every value comes back with whether it's known and where it came from, so properties
// and interplays built on top can say how much of them is known, and why.

export type SubSource = FieldMeta["source"] | "default";
export interface SubValue<T = number> {
  value: T | null; // null: nobody has said (blanks beat guesses)
  known: boolean;
  source: SubSource | null;
  session: number | null; // when it was last set
  from?: string; // for a default: what it came from ("likes")
}

const UNKNOWN: SubValue<never> = { value: null, known: false, source: null, session: null };
const meta = (n: AnyNode, path: string) => n.meta[path];
const valueOf = <T>(value: T | undefined | null, m: FieldMeta | undefined): SubValue<T> =>
  value == null ? UNKNOWN : { value, known: true, source: m?.source ?? "dm", session: m?.session ?? null };

/**
 * One sub-property of a node, by its path:
 * - characters: "disposition.boldness", "state.anger", "goals.g2.intent", "beliefs.b1.conviction", "mood";
 * - items: "power", "pull", "cost_severity", "cost_grows";
 * - factions: "aims.a1.intent", "aggression", "alert";
 * - places: "danger";
 * - threads: "urgency".
 */
export function subOf<T = number>(v: View, key: NodeKey, path: string): SubValue<T> {
  const n = v.g.nodes.get(key);
  if (!n) return UNKNOWN;
  const segs = path.split(".");
  const item = (list: { id?: string }[], id: string) => list.find((x) => x.id === id) as Record<string, unknown> | undefined;
  if (n.kind === "character") {
    if (segs[0] === "disposition" || segs[0] === "state") return valueOf(n.mind[segs[0]][segs[1]] as T, meta(n, `mind.${path}`));
    if (segs[0] === "mood") return valueOf(n.mind.mood as T, meta(n, "mind.mood"));
    if (segs[0] === "goals" || segs[0] === "beliefs") {
      const it = item(n.mind[segs[0]], segs[1]);
      return valueOf(it?.[segs[2]] as T, meta(n, `mind.${path}`) ?? meta(n, `mind.${segs[0]}`));
    }
  }
  if (n.kind === "item") {
    const field = { power: "power", pull: "pull", cost_severity: "costSeverity", cost_grows: "costGrows" }[path];
    if (field) return valueOf((n.properties as Record<string, unknown>)[field] as T, meta(n, path));
  }
  if (n.kind === "faction") {
    if (segs[0] === "aims") return valueOf(item(n.aims, segs[1])?.[segs[2]] as T, meta(n, path) ?? meta(n, "aims"));
    if (path === "aggression" || path === "alert") return valueOf(n[path] as T, meta(n, path));
  }
  if (n.kind === "place" && path === "danger") return valueOf(n.danger as T, meta(n, path));
  if (n.kind === "thread" && path === "urgency") return valueOf(n.urgency as T, meta(n, path));
  return UNKNOWN;
}

// What each relationship type implies for the weights, when nobody has set them (§4.2). Shown as
// defaults, never as recorded values.
const DEFAULTS: Record<string, Partial<Record<PairWeight, number>>> = {
  loves: { warmth: 3 },
  cherishes: { warmth: 2 },
  likes: { warmth: 1 },
  dislikes: { warmth: -1 },
  hates: { warmth: -3 },
  enemy: { warmth: -2, trust: -2 },
  ally: { warmth: 1, trust: 1 },
  family: { warmth: 2 },
  romance: { warmth: 2 },
  trusts: { trust: 2 },
  distrusts: { trust: -2 },
  fears: { fear: 2 },
  owes: { debt: 2 },
  promised: { debt: 1 },
  serves: { loyalty: 2 },
  member_of: { loyalty: 1 },
};

/**
 * How A stands toward B: each weight as recorded, or else as the relationship types (and a
 * condition aimed at B, like "frightened of Varek") imply, marked as a default.
 */
export function weightsOf(v: View, from: NodeKey, to: NodeKey): Record<PairWeight, SubValue> {
  const cached = weightCache.get(v)?.get(`${from}|${to}`);
  if (cached) return cached;
  const rec = v.g.pairs.get(`${from}|${to}`);
  const out = {} as Record<PairWeight, SubValue>;
  for (const w of PAIR_WEIGHTS) out[w] = rec?.weights[w] != null ? { value: rec.weights[w]!, known: true, source: rec.meta[w]?.source ?? "dm", session: rec.meta[w]?.session ?? null } : UNKNOWN;
  // Defaults from the types between them, in either direction for two-way types. Where several
  // types say something about one weight, the strongest says it.
  const links = v.g.linksOf(from, { dir: "both" }).filter((l) => v.g.other(l, from) === to && (`${l.from.kind}:${l.from.id}` === from || LINK_TYPES[l.type]?.symmetric));
  for (const l of links) {
    for (const [w, d] of Object.entries(DEFAULTS[l.type] ?? {}) as [PairWeight, number][]) {
      if (out[w].known && out[w].source !== "default") continue;
      if (!out[w].known || Math.abs(d) > Math.abs(out[w].value ?? 0)) out[w] = { value: d, known: true, source: "default", session: null, from: l.type };
    }
  }
  const n = v.g.nodes.get(from);
  if (n?.kind === "character" && !(out.fear.known && out.fear.source !== "default")) {
    if (n.body.conditions.some((c) => /^frightened/i.test(c.name) && (c.by === to || c.target === to))) out.fear = { value: 3, known: true, source: "default", session: null, from: "frightened" };
  }
  if (!weightCache.has(v)) weightCache.set(v, new Map());
  weightCache.get(v)!.set(`${from}|${to}`, out);
  return out;
}
const weightCache = new WeakMap<View, Map<string, Record<PairWeight, SubValue>>>();

/** A short line for a sub-value: "+2", "+1 (from likes)", "unknown". */
export function sayValue(s: SubValue<unknown>): string {
  if (!s.known) return "unknown";
  const n = typeof s.value === "number" ? (s.value > 0 ? `+${s.value}` : String(s.value)) : String(s.value);
  return s.source === "default" ? `${n} (from ${s.from})` : n;
}
