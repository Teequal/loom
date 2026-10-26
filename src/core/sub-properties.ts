import { DISPOSITIONS, GOAL_STATUSES, type Source } from "./entity-fields";

// The sub-property registry (docs/design-2026-10-26-property-model.md §4): every small, typed value
// the engine can reason about, with its range, meaning and who may set it. A path addresses one:
// "disposition.boldness", "state.confidence", "goals.g2.intent", "power". Items of a list are
// addressed by their id ("g2"); in the registry a "*" stands for any id.

export type EntityType = "pc" | "npc" | "item" | "location" | "faction" | "other";
export type Layer = "disposition" | "state" | "goal" | "belief" | "condition" | "item" | "faction" | "place";

export interface SubSpec {
  path: string; // with "*" for a list item's id
  on: EntityType[];
  layer: Layer;
  type: "scale" | "level" | "enum" | "bool" | "entity";
  range?: [number, number];
  values?: readonly string[];
  means: string; // the poles or meaning, for people and prompts
  sources: Source[]; // who may set it
}

const CHAR: EntityType[] = ["pc", "npc"];
const ALL_SOURCES: Source[] = ["dm", "extracted", "table", "inferred"];
const RECORDED: Source[] = ["dm", "extracted", "inferred"];

const DISPOSITION_POLES: Record<(typeof DISPOSITIONS)[number], string> = {
  compassion: "cruel ↔ kind",
  honesty: "deceitful ↔ honest",
  boldness: "timid ↔ daring (temperament, not courage)",
  temper: "calm ↔ volatile",
  pride: "humble ↔ proud",
  greed: "content ↔ grasping",
  curiosity: "incurious ↔ prying",
  discipline: "impulsive ↔ controlled",
  faith: "cynical ↔ devout",
  fidelity: "fickle ↔ steadfast",
};

const goalSpecs = (list: "goals" | "aims", on: EntityType[]): SubSpec[] => [
  { path: `${list}.*.priority`, on, layer: "goal", type: "level", range: [1, 3], means: "how high it ranks (1 is top)", sources: RECORDED },
  { path: `${list}.*.intent`, on, layer: "goal", type: "scale", range: [-3, 3], means: "who it's good for: −3 harms others … +3 helps others", sources: RECORDED },
  { path: `${list}.*.commitment`, on, layer: "goal", type: "level", range: [0, 3], means: "how hard they'll push for it", sources: ALL_SOURCES },
  { path: `${list}.*.target`, on, layer: "goal", type: "entity", means: "whom or what it's about", sources: RECORDED },
  { path: `${list}.*.status`, on, layer: "goal", type: "enum", values: GOAL_STATUSES, means: "where it stands", sources: ALL_SOURCES },
  { path: `${list}.*.secret`, on, layer: "goal", type: "bool", means: "GM-only", sources: ["dm"] },
];

export const SUB_PROPERTIES: SubSpec[] = [
  // Dispositions: what someone is like underneath; slow to change.
  ...DISPOSITIONS.map((d): SubSpec => ({ path: `disposition.${d}`, on: CHAR, layer: "disposition", type: "scale", range: [-3, 3], means: DISPOSITION_POLES[d], sources: ALL_SOURCES })),
  // States: how they are right now; they move with events and settle back.
  { path: "state.confidence", on: CHAR, layer: "state", type: "scale", range: [-3, 3], means: "shaken ↔ sure of themselves", sources: ALL_SOURCES },
  { path: "state.fear", on: CHAR, layer: "state", type: "level", range: [0, 3], means: "how afraid they are, in general", sources: ALL_SOURCES },
  { path: "state.anger", on: CHAR, layer: "state", type: "level", range: [0, 3], means: "how angry they are", sources: ALL_SOURCES },
  { path: "state.hope", on: CHAR, layer: "state", type: "level", range: [0, 3], means: "how much they believe things can go well", sources: ALL_SOURCES },
  { path: "state.strain", on: CHAR, layer: "state", type: "level", range: [0, 3], means: "how worn down they are", sources: ALL_SOURCES },
  ...goalSpecs("goals", CHAR),
  { path: "beliefs.*.conviction", on: CHAR, layer: "belief", type: "level", range: [1, 3], means: "how firmly it's held", sources: RECORDED },
  { path: "beliefs.*.true", on: CHAR, layer: "belief", type: "bool", means: "whether it's actually true (GM)", sources: ["dm", "extracted"] },
  // Items
  { path: "power", on: ["item"], layer: "item", type: "level", range: [0, 3], means: "how much it can do", sources: RECORDED },
  { path: "pull", on: ["item"], layer: "item", type: "level", range: [0, 3], means: "how much it draws its holder to use it", sources: RECORDED },
  { path: "cost_severity", on: ["item"], layer: "item", type: "level", range: [0, 3], means: "how bad the price of use is", sources: RECORDED },
  { path: "cost_grows", on: ["item"], layer: "item", type: "bool", means: "whether the price rises with use", sources: RECORDED },
  // Factions
  ...goalSpecs("aims", ["faction"]),
  { path: "aggression", on: ["faction"], layer: "faction", type: "level", range: [0, 3], means: "how readily it uses force", sources: RECORDED },
  { path: "alert", on: ["faction"], layer: "faction", type: "level", range: [0, 3], means: "how wary of the party it is", sources: ALL_SOURCES },
  // Places
  { path: "danger", on: ["location"], layer: "place", type: "level", range: [0, 3], means: "how dangerous it is", sources: RECORDED },
];

/** The registry entry for a path ("goals.g2.intent" → the "goals.*.intent" entry). */
export function specOf(path: string): SubSpec | undefined {
  const segs = path.split(".");
  return SUB_PROPERTIES.find((s) => {
    const p = s.path.split(".");
    return p.length === segs.length && p.every((x, i) => x === "*" || x === segs[i]);
  });
}

/** Checks a value against its entry. Returns a short reason when it doesn't fit. */
export function checkValue(spec: SubSpec, value: unknown, entityType: EntityType): string | null {
  if (!spec.on.includes(entityType)) return `${spec.path} isn't a property of ${entityType === "location" ? "a place" : `a ${entityType}`}`;
  if (value == null) return null; // clearing
  if (spec.type === "scale" || spec.type === "level") {
    const [lo, hi] = spec.range!;
    return typeof value === "number" && Number.isInteger(value) && value >= lo && value <= hi ? null : `${spec.path} is a whole number from ${lo} to ${hi}`;
  }
  if (spec.type === "bool") return typeof value === "boolean" ? null : `${spec.path} is yes or no`;
  if (spec.type === "enum") return spec.values!.includes(String(value)) ? null : `${spec.path} is one of ${spec.values!.join(", ")}`;
  if (spec.type === "entity") return typeof value === "number" && Number.isInteger(value) ? null : `${spec.path} is a character, place, item or faction`;
  return null;
}

/** Reads a path from traits; a list item is found by its id. */
export function getPath(traits: Record<string, unknown>, path: string): unknown {
  let cur: unknown = traits;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur.find((x) => (x as { id?: string })?.id === seg) : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** A copy of traits with one path set (or cleared, for null). Returns null if a list item doesn't exist. */
export function setPath(traits: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> | null {
  const segs = path.split(".");
  const go = (node: unknown, i: number): unknown => {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (Array.isArray(node)) {
      const at = node.findIndex((x) => (x as { id?: string })?.id === seg);
      if (at < 0) throw new Error("missing");
      const copy = [...node];
      copy[at] = last ? value : go(node[at], i + 1);
      return copy;
    }
    const obj = { ...((node as Record<string, unknown>) ?? {}) };
    if (last) {
      if (value == null) delete obj[seg];
      else obj[seg] = value;
    } else {
      const next = go(obj[seg], i + 1);
      if (next && typeof next === "object" && !Array.isArray(next) && !Object.keys(next).length) delete obj[seg];
      else obj[seg] = next;
    }
    return obj;
  };
  try {
    return go(traits, 0) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Gives each item of an id'd list (goals, beliefs, aims) a stable id: kept if it has one, taken from
 * the item with the same text before, or the next free one ("g3").
 */
export function withIds<T extends { id?: string; text: string }>(next: T[], before: T[] | undefined, prefix: string): T[] {
  const taken = new Set([...(before ?? []), ...next].map((x) => x.id).filter(Boolean) as string[]);
  let n = Math.max(0, ...[...taken].map((id) => Number(id.slice(prefix.length)) || 0));
  return next.map((x) => {
    if (x.id) return x;
    const same = before?.find((b) => b.text.trim().toLowerCase() === x.text.trim().toLowerCase() && b.id);
    if (same) return { ...x, id: same.id };
    return { ...x, id: `${prefix}${++n}` };
  });
}
