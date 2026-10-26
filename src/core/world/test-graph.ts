import type { PairWeight } from "../db/schema";
import { readMoment } from "../moment-reading";
import { viewOf } from "./engine";
import { INTERPLAYS, interplaysOf, type PersonSpec } from "./interplays";
import { LINK_TYPES, type Link } from "./links";
import type { Graph } from "./load";
import type { AnyNode, NodeKey } from "./nodes";

// A small world built in memory from a few lines of spec, for the interplay table's examples
// (and any engine test that shouldn't need the database): characters, factions, items and threads,
// their ties, goals, dispositions, states, conditions and pair weights.

export function graphOf(spec: Record<string, PersonSpec>): Graph {
  const names = Object.keys(spec);
  const keyOf = (n: string): NodeKey => {
    const s = spec[n];
    const i = names.indexOf(n) + 1;
    return (s?.faction ? `faction:${i}` : s?.item ? `item:${i}` : `character:${i}`) as NodeKey;
  };
  const threadTitles = [...new Set(names.flatMap((n) => spec[n].threads ?? []))];
  const threadKey = (t: string) => `thread:${threadTitles.indexOf(t) + 1}` as NodeKey;
  const base = (key: NodeKey, name: string) => ({ key, id: Number(key.split(":")[1]), campaignId: 0, name, aliases: [], summary: "", notes: "", meta: {} });
  const goal = (g: NonNullable<PersonSpec["goals"]>[number], i: number) => ({ id: `g${i + 1}`, text: g.text ?? `goal ${i + 1}`, priority: g.priority ?? i + 1, intent: g.intent, commitment: g.commitment, target: g.target ? keyOf(g.target) : undefined });
  const nodes = new Map<NodeKey, AnyNode>();
  for (const n of names) {
    const s = spec[n];
    const key = keyOf(n);
    if (s.faction) nodes.set(key, { ...base(key, n), kind: "faction", aims: (s.aims ?? []).map(goal), clock: s.clock ? { filled: s.clock[0], of: s.clock[1] } : undefined, alert: s.alert } as AnyNode);
    else if (s.item) nodes.set(key, { ...base(key, n), kind: "item", properties: { pull: s.pull }, sharedPossession: false } as AnyNode);
    else
      nodes.set(key, {
        ...base(key, n),
        kind: "character",
        side: s.pc ? "pc" : "npc",
        status: s.status ?? "alive",
        identity: { appearance: [], personality: [], languages: [] },
        body: { health: s.health, conditions: (s.conditions ?? []).map((c) => ({ name: c.name, is5e: true, by: c.by ? keyOf(c.by) : undefined })) },
        mind: { goals: (s.goals ?? []).map(goal), wants: [], fears: [], flaws: [], ideals: [], bonds: [], beliefs: [], disposition: s.disposition ?? {}, state: s.state ?? {} },
        abilities: [],
        gear: [],
        knowledge: (s.secrets ?? []).map((text) => ({ text, secret: true })),
        senses: {},
        hooks: [],
      } as unknown as AnyNode);
  }
  for (const t of threadTitles) nodes.set(threadKey(t), { ...base(threadKey(t), t), kind: "thread", threadKind: "hook", status: "open", stakes: {}, steps: [], payoffs: [], secret: false, firstSeen: null, lastTouched: null } as AnyNode);

  const end = (k: NodeKey) => ({ kind: k.split(":")[0], id: Number(k.split(":")[1]) });
  const links: Link[] = [];
  for (const n of names) {
    for (const [type, to] of spec[n].ties ?? []) links.push({ id: `t${links.length}`, campaignId: 0, from: end(keyOf(n)), to: end(keyOf(to)), type, secret: false, meta: { source: "dm" } });
    for (const t of spec[n].threads ?? []) links.push({ id: `t${links.length}`, campaignId: 0, from: end(keyOf(n)), to: end(threadKey(t)), type: "in_thread", role: "involved", secret: false, meta: { source: "dm" } });
  }
  const kstr = (e: { kind: string; id: number }) => `${e.kind}:${e.id}` as NodeKey;
  const pairs: Graph["pairs"] = new Map();
  for (const n of names) for (const [to, w] of Object.entries(spec[n].toward ?? {})) pairs.set(`${keyOf(n)}|${keyOf(to)}`, { weights: w as Partial<Record<PairWeight, number>>, meta: {} });

  const g: Graph = {
    campaignId: 0,
    nodes,
    links,
    linksOf: (key: NodeKey, opts: { type?: string; role?: string; dir?: "out" | "in" | "both" } = {}) => {
      const dir = opts.dir ?? "both";
      return links.filter((l) => {
        const out = kstr(l.from) === key;
        const inn = kstr(l.to) === key;
        const twoWay = LINK_TYPES[l.type]?.symmetric;
        const ok = (dir !== "in" && out) || (dir !== "out" && inn) || (twoWay && (out || inn));
        return ok && (!opts.type || l.type === opts.type) && (!opts.role || l.role === opts.role);
      });
    },
    other: (l: Link, key: NodeKey) => (kstr(l.from) === key ? kstr(l.to) : kstr(l.from)),
    find: (name: string) => [...nodes.values()].find((x) => x.name.toLowerCase() === name.trim().toLowerCase()),
    entityKey: () => undefined,
    problems: [],
    record: [],
    log: [],
    pairs,
  } as unknown as Graph;
  return g;
}

/** Runs every interplay row's examples. Returns one line per example that didn't come out as said. */
export function checkInterplayExamples() {
  const results: { id: string; says: string; ok: boolean; got: string }[] = [];
  for (const def of INTERPLAYS) {
    for (const ex of def.examples) {
      const g = graphOf(ex.world);
      const v = viewOf(g, readMoment([], ""));
      const found = interplaysOf(v).filter((i) => i.id === def.id && g.nodes.get(i.subject)?.name === ex.subject && (!ex.other || g.nodes.get(i.other!)?.name === ex.other));
      results.push({ id: def.id, says: ex.says, ok: found.length > 0 === ex.fires, got: found.length ? found.map((f) => f.handle).join(" | ") : "nothing" });
    }
  }
  return results;
}
