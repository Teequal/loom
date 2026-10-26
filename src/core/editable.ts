import { PAIR_WEIGHTS, type PairWeight } from "./db/schema";
import { DISPOSITIONS, STATES, type EntityTraits } from "./entity-fields";
import { specOf } from "./sub-properties";
import { interplaysFor } from "./world/interplays";
import type { View } from "./world/engine";
import type { NodeKey } from "./world/nodes";
import { subOf, weightsOf, type SubValue } from "./world/props";

// The property model's values as the DM edits them in the inspector (design §11): every
// sub-property of an entity, grouped as people think of them, each with where it came from, and how
// it stands toward others in both directions (the pair view). Read from the engine, so a default a
// tie implies shows as a default, not as a value anyone set.

export interface EditRow {
  path: string;
  label: string;
  value: number | boolean | null;
  source: string | null; // dm, extracted, table, inferred, default
  from?: string; // for a default: what implies it
  min: number;
  max: number;
  bool?: boolean;
  means: string;
}
export interface EditGroup {
  title: string;
  note?: string;
  goal?: boolean; // one goal (or aim): its text is the title
  rows: EditRow[];
}
export interface PairSide {
  weight: PairWeight;
  value: number | null;
  source: string | null;
  from?: string;
}

const row = (v: View, key: NodeKey, path: string, label: string): EditRow => {
  const spec = specOf(path);
  const s: SubValue<number | boolean> = subOf(v, key, path);
  return {
    path,
    label,
    value: s.value,
    source: s.source,
    min: spec?.range?.[0] ?? 0,
    max: spec?.range?.[1] ?? 3,
    bool: spec?.type === "bool",
    means: spec?.means ?? "",
  };
};

export const WEIGHT_RANGE: Record<PairWeight, [number, number]> = { warmth: [-3, 3], trust: [-3, 3], respect: [-3, 3], fear: [0, 3], debt: [0, 3], loyalty: [0, 3] };

/** The editable values of one entity, and its pairs with others. */
export function editableOf(v: View, key: NodeKey, type: string, traits: EntityTraits) {
  const groups: EditGroup[] = [];
  const goalRows = (list: "goals" | "aims") =>
    ((traits[list] ?? []) as { id?: string; text: string; priority?: number }[])
      .filter((g) => g.id)
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
      .map((g): EditGroup => ({ title: g.text, goal: true, rows: [row(v, key, `${list}.${g.id}.intent`, "intent"), row(v, key, `${list}.${g.id}.commitment`, "commitment")] }));
  if (type === "pc" || type === "npc") {
    groups.push(...goalRows("goals"));
    groups.push({ title: "Underneath", note: "slow to change", rows: DISPOSITIONS.map((d) => row(v, key, `disposition.${d}`, d)) });
    groups.push({ title: "Right now", note: "settles between sessions", rows: STATES.map((s) => row(v, key, `state.${s}`, s)) });
  } else if (type === "faction") {
    groups.push(...goalRows("aims"));
    groups.push({ title: "Stance", rows: [row(v, key, "aggression", "aggression"), row(v, key, "alert", "alert")] });
  } else if (type === "item") {
    groups.push({ title: "Properties", rows: [row(v, key, "power", "power"), row(v, key, "pull", "pull"), row(v, key, "cost_severity", "cost of use"), row(v, key, "cost_grows", "cost grows with use")] });
  } else if (type === "location") {
    groups.push({ title: "Properties", rows: [row(v, key, "danger", "danger")] });
  }

  // The pair view: everyone it has a tie or a recorded weight with, both directions side by side.
  const pairs: { otherId: number; mine: PairSide[]; theirs: PairSide[]; pulls: string[] }[] = [];
  if (type === "pc" || type === "npc" || type === "faction") {
    const others = new Set<NodeKey>();
    for (const l of v.g.linksOf(key)) {
      const o = v.g.other(l, key);
      const n = v.g.nodes.get(o);
      if (n && (n.kind === "character" || n.kind === "faction")) others.add(o);
    }
    for (const k of v.g.pairs.keys()) {
      const [a, b] = k.split("|") as [NodeKey, NodeKey];
      if (a === key) others.add(b);
      if (b === key) others.add(a);
    }
    const sides = (from: NodeKey, to: NodeKey): PairSide[] => {
      const w = weightsOf(v, from, to);
      return PAIR_WEIGHTS.map((weight) => ({ weight, value: w[weight].value, source: w[weight].source, from: w[weight].from }));
    };
    const pulls = interplaysFor(v, key, true);
    for (const o of others) {
      const n = v.g.nodes.get(o);
      if (!n) continue;
      pairs.push({ otherId: n.id, mine: sides(key, o), theirs: sides(o, key), pulls: pulls.filter((i) => i.other === o || (i.subject === o && i.other === key)).map((i) => i.name) });
    }
    // Most to say first.
    const said = (p: (typeof pairs)[number]) => [...p.mine, ...p.theirs].filter((s) => s.value != null).length;
    pairs.sort((a, b) => said(b) - said(a));
  }
  return { groups, pairs };
}
