import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { EffectInPlay } from "./effects";
import { readMoment, type MomentReading } from "./moment-reading";
import { holdersOf, liveRules, placeChain, presenceOf, profileLine, profileOf, viewOf, type Role, type View } from "./world/engine";
import { loadGraph, type Graph } from "./world/load";

// The scene model: what is true right now, decided by code. Built once per moment from the
// records and the moment (read in moment-reading.ts), plus the GM's corrections. Every feature
// reads it; the answer formats, checks and prompts are all held to it. The model's pass comes
// second: it can describe this scene, never change who is in it or what they hold.

type Entity = typeof schema.entities.$inferSelect;
type Relation = typeof schema.entityRelations.$inferSelect;
type Effect = typeof schema.effects.$inferSelect;
type Campaign = typeof schema.campaigns.$inferSelect;

// "here": the moment (or the GM) puts them in the scene; "with-party": a companion travelling
// with the party; "nearby": recorded at the party's place, not with them; then elsewhere/unknown.
export type Presence = "here" | "with-party" | "nearby" | "elsewhere" | "unknown";

// The GM's corrections from the chips. They always win.
export interface Overrides {
  here?: string[]; // bring these into the scene
  away?: string[]; // not in the scene, whatever the moment says
  inHand?: { pc: string; item: string }[];
  notInHand?: { pc: string; item: string }[]; // Loom misread who has it
  rulesOn?: string[]; // house rules triggered after all
  rulesOff?: string[]; // house rules not triggered, whatever the moment says
}

// When the moment and the records disagree, Loom goes with the moment for that call and offers to
// update the records: a condition the moment states, or an item in someone else's hands.
export type RecordFix = {
  say: string; // what Loom did, for the page
  apply: string; // the button that records it
  fix: { kind: "condition"; entityId: number; condition: string } | { kind: "holds"; holderId: number; itemId: number };
};

export interface World {
  campaign: Campaign | null;
  entities: Entity[];
  relations: Relation[];
  effects: Effect[];
  threads: { id: number; title: string; status: string }[];
  threadEntities: { threadId: number; entityId: number }[];
  graph: Graph; // the world model (world/): typed nodes and links the engine calculates from
}

export async function loadWorld(campaignId: number): Promise<World> {
  const [[campaign], entities, relations, effects, threads, threadEntities, graph] = await Promise.all([
    db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId)),
    db.select({ id: schema.threads.id, title: schema.threads.title, status: schema.threads.status }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
    db
      .select({ threadId: schema.threadEntities.threadId, entityId: schema.threadEntities.entityId })
      .from(schema.threadEntities)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.threadEntities.threadId))
      .where(eq(schema.threads.campaignId, campaignId)),
    loadGraph(campaignId),
  ]);
  return { campaign: campaign ?? null, entities, relations, effects, threads, threadEntities, graph };
}

export interface LiveEffect extends EffectInPlay {
  live: boolean; // its trigger has happened, so its roll can be called now
  why: string;
}

// Each entity's part in this moment, from the engine (world/engine.ts): its role, where it stands,
// and one line of what matters about it (mood, goals, beliefs, holders, its parts in threads).
export interface SceneProfile {
  entity: Entity;
  role: Role;
  standing: string;
  line: string;
}

export interface Situation {
  world: World;
  moment: string;
  reading: MomentReading;
  view: View; // the world model as it stands for this moment
  entities: Entity[]; // the records, with what the moment states applied (conditions)
  pcs: Entity[];
  party: Entity | null; // where the party is for this moment
  presence: (e: Entity) => Presence;
  why: (e: Entity) => string; // why they're where they are, for the chips and the prompt
  profiles: Map<string, SceneProfile>;
  here: Set<string>; // NPCs, factions and items that may act directly (role "here")
  contacted: Set<string>; // absent NPCs the players reached; they may answer from afar
  acting: Set<string>; // PCs whose declared action this moment is
  holders: Map<string, Set<string>>; // item → who has it now (records, the moment, the GM)
  parentOf: Map<string, string>; // item → its set
  lost: Set<string>; // lost items nobody has
  effects: LiveEffect[];
  notes: string[]; // for the CLI
  fixes: RecordFix[]; // for the page
  stated: string[]; // conditions the moment states, for the prompt
}

// The scene model is the engine's answers for this moment, in the shapes the rest of Loom reads.
export function buildSituation(world: World, moment: string, overrides: Overrides = {}): Situation {
  // A copy of the rows, so what this moment states doesn't leak into other calls.
  const entities = world.entities.map((e) => ({ ...e, traits: { ...(e.traits as object) } as Entity["traits"] }));
  const byName = new Map(entities.map((e) => [e.name, e]));
  const pcs = entities.filter((e) => e.type === "pc");
  const g = world.graph;
  const reading = readMoment(entities, moment);
  const view = viewOf(g, reading, overrides);
  const keyOf = (e: Entity) => g.entityKey(e.id)!;

  // Conditions the moment states: on the rows too, so cards and capability checks see them.
  const fixes: RecordFix[] = [];
  for (const { pc, condition } of view.conditionFixes) {
    const row = byName.get(pc.name);
    if (!row) continue;
    const t = row.traits as { health?: string; conditions?: string[] };
    row.traits = (condition === "unconscious" ? { ...t, health: "unconscious" } : { ...t, conditions: [...(t.conditions ?? []), condition] }) as Entity["traits"];
    fixes.push({ say: `Loom treated ${pc.name} as ${condition} for these options, because the moment says so. Your records don't have that yet.`, apply: `Record ${pc.name} as ${condition}`, fix: { kind: "condition", entityId: pc.id, condition } });
  }
  for (const { pc, item, records } of view.holdFixes) fixes.push({ say: `Loom treated ${pc.name} as having ${item.name} for these options. ${records}`, apply: `${pc.name} has it now`, fix: { kind: "holds", holderId: pc.id, itemId: item.id } });

  const memo = new Map();
  const presenceOfRow = (e: Entity) => presenceOf(view, keyOf(e), memo);
  const party = view.party ? (entities.find((e) => e.id === view.party!.id) ?? null) : null;

  // Who has what: direct holders, with the moment's and the GM's changes (sets are read through parentOf).
  const holders = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  const lost = new Set<string>();
  for (const e of entities.filter((x) => x.type === "item")) {
    const direct = holdersOf(view, keyOf(e)).filter((h) => !h.via).map((h) => g.nodes.get(h.holder)!.name);
    if (direct.length) holders.set(e.name, new Set(direct));
    const parent = placeChain(view, keyOf(e))[1];
    if (parent && g.nodes.get(parent)?.kind === "item") parentOf.set(e.name, g.nodes.get(parent)!.name);
    if (e.status === "lost" && !direct.length) lost.add(e.name);
  }

  const effects: LiveEffect[] = liveRules(view)
    .map((r) => {
      const effect = world.effects.find((x) => x.id === r.rule.id);
      return effect ? { effect, sourceName: r.source?.name ?? null, holders: r.holders, targets: r.targets, tableWide: r.tableWide, text: r.text, live: r.live, why: r.why } : null;
    })
    .filter((x): x is LiveEffect => !!x);

  const profiles = new Map<string, SceneProfile>();
  for (const e of entities) {
    const p = profileOf(view, keyOf(e), memo);
    profiles.set(e.name, { entity: e, role: p.presence.role, standing: p.presence.standing, line: profileLine(p) });
  }
  const here = new Set([...profiles.values()].filter((p) => p.role === "here" && p.entity.type !== "location" && p.entity.status !== "captured" && p.entity.status !== "missing").map((p) => p.entity.name));
  const contacted = new Set([...reading.contacted].filter((n) => byName.get(n)?.status !== "dead"));
  const acting = new Set(reading.wholeParty ? pcs.map((p) => p.name) : [...reading.acting]);

  return {
    world,
    moment,
    reading,
    view,
    entities,
    pcs,
    party,
    presence: (e) => presenceOfRow(e).where,
    why: (e) => presenceOfRow(e).why,
    profiles,
    here,
    contacted,
    acting,
    holders,
    parentOf,
    lost,
    effects,
    notes: view.notes,
    fixes,
    stated: view.stated,
  };
}

// What the page shows under the box: only what this moment involves, each with why and whether
// it's in effect. Tapping one corrects it (an override), and the options follow.
export type Chip =
  | { kind: "here" | "mentioned" | "afar"; name: string; on: boolean; why: string }
  | { kind: "in-hand"; pc: string; item: string; on: boolean; why: string }
  | { kind: "rule"; rule: string; on: boolean; why: string }
  | { kind: "place"; name: string; on: true; why: string }
  | { kind: "lost"; name: string; on: true; why: string };

export function sceneChips(s: Situation, overrides: Overrides = {}): Chip[] {
  const chips: Chip[] = [];
  const byName = new Map(s.entities.map((e) => [e.name, e]));
  const people = new Set([...s.reading.broughtIn, ...s.reading.referred, ...s.reading.contacted, ...(overrides.here ?? []), ...(overrides.away ?? [])]);
  for (const name of people) {
    const e = byName.get(name);
    if (!e || e.type === "pc") continue;
    const p = s.presence(e);
    if (p === "here") chips.push({ kind: "here", name, on: true, why: s.why(e) });
    else if (s.contacted.has(name) && !(overrides.away ?? []).includes(name)) chips.push({ kind: "afar", name, on: false, why: s.why(e) });
    else chips.push({ kind: "mentioned", name, on: false, why: e.status === "dead" ? "dead" : s.why(e) });
  }
  const shownItems = new Set<string>();
  for (const [item, who] of s.holders) {
    for (const pc of who) {
      const fromMoment = s.reading.inHand.some((h) => h.pc === pc && h.item === item) || (overrides.inHand ?? []).some((h) => h.pc === pc && h.item === item);
      if (fromMoment) {
        chips.push({ kind: "in-hand", pc, item, on: true, why: "the moment puts it with them" });
        shownItems.add(item);
      }
    }
  }
  for (const h of overrides.notInHand ?? []) chips.push({ kind: "in-hand", pc: h.pc, item: h.item, on: false, why: "you said they don't have it" });
  for (const m of s.reading.mentions) if (s.lost.has(m.entity.name) && !shownItems.has(m.entity.name)) chips.push({ kind: "lost", name: m.entity.name, on: true, why: "lost: nobody has it" });
  const mentionedItems = new Set(s.reading.mentions.filter((m) => m.entity.type === "item").map((m) => m.entity.name));
  for (const e of s.effects) {
    const sourceNamed = e.sourceName != null && [...mentionedItems].some((i) => i === e.sourceName || isInside(i, e.sourceName!, s.parentOf) || isInside(e.sourceName!, i, s.parentOf));
    const overridden = (overrides.rulesOn ?? []).includes(e.effect.name) || (overrides.rulesOff ?? []).includes(e.effect.name);
    // A rule the moment itself triggers (using its source), or one you've corrected. Rules that
    // reach everyone all the time (exposure, always) stay in the scene without a chip each moment.
    const triggeredByMoment = e.live && (e.effect.trigger === "on-use" || e.effect.trigger === "on-touch");
    if (triggeredByMoment || sourceNamed || overridden) chips.push({ kind: "rule", rule: e.effect.name, on: e.live, why: e.why });
  }
  if (s.reading.goesTo) chips.push({ kind: "place", name: s.reading.goesTo, on: true, why: "the moment takes the party there" });
  return chips;
}

function isInside(item: string, container: string, parentOf: Map<string, string>) {
  for (let cur = parentOf.get(item), hops = 0; cur && hops < 10; cur = parentOf.get(cur), hops++) if (cur === container) return true;
  return false;
}
