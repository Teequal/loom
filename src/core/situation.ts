import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import { effectsInPlay, type EffectInPlay } from "./effects";
import { readMoment, type MomentReading } from "./moment-reading";

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
  threads: { id: number; title: string }[];
}

export async function loadWorld(campaignId: number): Promise<World> {
  const [[campaign], entities, relations, effects, threads] = await Promise.all([
    db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId)),
    db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
  ]);
  return { campaign: campaign ?? null, entities, relations, effects, threads };
}

export interface LiveEffect extends EffectInPlay {
  live: boolean; // its trigger has happened, so its roll can be called now
  why: string;
}

export interface Situation {
  world: World;
  moment: string;
  reading: MomentReading;
  entities: Entity[]; // the records, with what the moment states applied (conditions)
  pcs: Entity[];
  party: Entity | null; // where the party is for this moment
  presence: (e: Entity) => Presence;
  why: (e: Entity) => string; // why they're where they are, for the chips and the prompt
  here: Set<string>; // NPCs, factions and items that may act directly
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

const COMPANION_TIES = new Set(["ally", "serves", "family", "romance", "loves", "trusts"]);

export function buildSituation(world: World, moment: string, overrides: Overrides = {}): Situation {
  // A copy, so what this moment states doesn't leak into other calls.
  const entities = world.entities.map((e) => ({ ...e, traits: { ...(e.traits as object) } as Entity["traits"] }));
  const byId = new Map(entities.map((e) => [e.id, e]));
  const byName = new Map(entities.map((e) => [e.name, e]));
  const pcs = entities.filter((e) => e.type === "pc");
  const reading = readMoment(entities, moment);
  const notes: string[] = [];
  const fixes: RecordFix[] = [];
  const stated: string[] = [];

  const within = (place: number, container: number) => {
    let cur: number | null = place;
    for (let hops = 0; cur != null && hops < 20; hops++) {
      if (cur === container) return true;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };

  // Where the party is: the records, unless the moment takes them somewhere.
  const recordedParty = world.campaign?.partyLocationId ? (byId.get(world.campaign.partyLocationId) ?? null) : null;
  const movedTo = reading.goesTo ? (byName.get(reading.goesTo) ?? null) : null;
  const party = movedTo ?? recordedParty;
  if (movedTo && movedTo.id !== recordedParty?.id) notes.push(`This moment takes the party to ${movedTo.name}; your records have them at ${recordedParty?.name ?? "no recorded place"}.`);

  // Conditions the moment states apply for this call; the GM is told the records disagree.
  for (const { pc: name, condition } of reading.conditions) {
    const pc = byName.get(name);
    if (!pc) continue;
    const t = pc.traits as { health?: string; conditions?: string[] };
    const has = condition === "unconscious" ? t.health === "unconscious" || t.conditions?.includes("unconscious") : t.conditions?.includes(condition);
    if (has) continue;
    pc.traits = (condition === "unconscious" ? { ...t, health: "unconscious" } : { ...t, conditions: [...(t.conditions ?? []), condition] }) as Entity["traits"];
    const field = condition === "unconscious" ? "health=unconscious" : `conditions="${(pc.traits as { conditions: string[] }).conditions.join(", ")}"`;
    notes.push(`This moment has ${pc.name} ${condition}; your records don't. Update with: entity set "${pc.name}" ${field}`);
    fixes.push({ say: `Loom treated ${pc.name} as ${condition} for these options, because the moment says so. Your records don't have that yet.`, apply: `Record ${pc.name} as ${condition}`, fix: { kind: "condition", entityId: pc.id, condition } });
    stated.push(`${pc.name} is ${condition} (${condition === "unconscious" ? "can't act, speak or notice anything; death saves only" : "per the 5e condition"})`);
  }

  // Presence, from the records relative to where the party is, then the moment, then the GM.
  const pcIds = new Set(pcs.map((p) => p.id));
  const companions = new Set(
    world.relations
      .filter((r) => COMPANION_TIES.has(r.type) && (pcIds.has(r.fromEntityId) || pcIds.has(r.toEntityId)))
      .flatMap((r) => [r.fromEntityId, r.toEntityId])
      .filter((id) => !pcIds.has(id)),
  );
  const away = new Set(overrides.away ?? []);
  const broughtIn = new Set([...reading.broughtIn, ...(overrides.here ?? [])].filter((n) => !away.has(n)));
  const recordsPresence = (e: Entity): Exclude<Presence, "here"> => {
    const loc = e.actualLocationId ?? e.lastKnownLocationId;
    // Companions travel with the party wherever it goes.
    if (companions.has(e.id) && recordedParty && loc != null && (within(loc, recordedParty.id) || within(recordedParty.id, loc))) return "with-party";
    if (!party || loc == null) return "unknown";
    if (!(within(loc, party.id) || within(party.id, loc))) return "elsewhere";
    return companions.has(e.id) ? "with-party" : "nearby";
  };
  const presence = (e: Entity): Presence => (away.has(e.name) ? "elsewhere" : broughtIn.has(e.name) ? "here" : recordsPresence(e));
  const why = (e: Entity) => {
    if (away.has(e.name)) return "you said they're not here";
    if ((overrides.here ?? []).includes(e.name)) return "you said they're here";
    if (reading.broughtIn.has(e.name)) return "the moment brings them in";
    if (reading.contacted.has(e.name)) return "the players reach them from afar";
    if (reading.referred.has(e.name)) return "only mentioned in the moment";
    return { "with-party": "travelling with the party", nearby: "recorded around here, not with the party", elsewhere: "recorded elsewhere", unknown: "whereabouts unknown" }[recordsPresence(e)];
  };

  // Items: who has what. A lost item has no holder; the moment (or the GM) can put one in a PC's hand.
  const parentOf = new Map<string, string>();
  for (const e of entities) if (e.type === "item" && e.parentId != null && byId.get(e.parentId)) parentOf.set(e.name, byId.get(e.parentId)!.name);
  const holders = new Map<string, Set<string>>();
  const lostIds = new Set(entities.filter((e) => e.type === "item" && e.status === "lost").map((e) => e.id));
  for (const r of world.relations) {
    if (r.type !== "holds" || lostIds.has(r.toEntityId)) continue;
    const [h, i] = [byId.get(r.fromEntityId)?.name, byId.get(r.toEntityId)?.name];
    if (h && i) holders.set(i, new Set([...(holders.get(i) ?? []), h]));
  }
  // The most specific item named: "the monk figurine" means that piece, not its whole set.
  const named = reading.inHand.filter((h) => !reading.inHand.some((o) => o !== h && o.pc === h.pc && isInside(o.item, h.item, parentOf)));
  const holdsViaSet = (who: string, item: string) => {
    for (let cur: string | undefined = item, hops = 0; cur && hops < 10; cur = parentOf.get(cur), hops++) if (holders.get(cur)?.has(who)) return true;
    return false;
  };
  const misread = (h: { pc: string; item: string }) => (overrides.notInHand ?? []).some((x) => x.pc === h.pc && x.item === h.item);
  for (const { pc: name, item: itemName } of [...named.filter((h) => !misread(h)), ...(overrides.inHand ?? [])]) {
    const pc = byName.get(name);
    const item = byName.get(itemName);
    if (!pc || !item || holdsViaSet(name, itemName)) continue;
    const recorded = [...(holders.get(itemName) ?? [])];
    holders.set(itemName, new Set([...recorded, name]));
    const records = item.status === "lost" && !recorded.length ? "Your records say it's lost." : recorded.length ? `Your records say ${recorded.join(" and ")} ${recorded.length > 1 ? "hold" : "holds"} it.` : null;
    if (!records) continue; // nobody recorded as holding it: nothing disagrees
    notes.push(`${records} This moment has ${name} with ${itemName}. Update with: relate "${name}" holds "${itemName}"`);
    fixes.push({ say: `Loom treated ${name} as having ${itemName} for these options. ${records}`, apply: `${name} has it now`, fix: { kind: "holds", holderId: pc.id, itemId: item.id } });
  }
  const lost = new Set(entities.filter((e) => lostIds.has(e.id) && !holders.get(e.name)?.size).map((e) => e.name));

  // Who may act directly: NPCs here or with the party, factions, and items that aren't lost.
  // Captured or missing NPCs only act by getting free or getting word out.
  const free = (e: Entity) => e.status !== "dead" && e.status !== "captured" && e.status !== "missing";
  const here = new Set(
    entities
      .filter((e) => free(e))
      .filter((e) => (e.type === "npc" ? ["here", "with-party"].includes(presence(e)) : e.type === "faction" || (e.type === "item" && !lost.has(e.name))))
      .map((e) => e.name),
  );
  const contacted = new Set([...reading.contacted].filter((n) => byName.get(n)?.status !== "dead"));
  const acting = new Set(reading.wholeParty ? pcs.map((p) => p.name) : [...reading.acting]);

  // House rules: who each reaches now, and whether its trigger has happened. "On use" and "on
  // touch" rules are live only when the moment uses their source (or a piece of it); the rest
  // whenever they reach someone.
  const holds = [...holders].flatMap(([item, who]) => [...who].map((h) => ({ holderId: byName.get(h)?.id ?? -1, itemId: byName.get(item)?.id ?? -1 }))).filter((h) => h.holderId > 0 && h.itemId > 0);
  const effects: LiveEffect[] = effectsInPlay({ effects: world.effects, entities, holds, threads: world.threads, partyLocationId: party?.id ?? null }).map((e) => {
    if (!e.targets.length) return { ...e, live: false, why: "it reaches nobody right now" };
    if ((overrides.rulesOff ?? []).includes(e.effect.name)) return { ...e, live: false, why: "you said it isn't triggered" };
    if ((overrides.rulesOn ?? []).includes(e.effect.name)) return { ...e, live: true, why: "you said it's triggered" };
    if (e.effect.trigger === "on-use" || e.effect.trigger === "on-touch") {
      const source = e.sourceName;
      const usedNow = [...reading.used].find((u) => source && (u === source || isInside(u, source, parentOf) || isInside(source, u, parentOf)));
      return usedNow ? { ...e, live: true, why: `the moment uses ${usedNow}` } : { ...e, live: false, why: `nobody uses ${source ?? "its source"} in this moment` };
    }
    return { ...e, live: true, why: `it reaches ${e.targets.join(", ")}` };
  });

  return { world, moment, reading, entities, pcs, party, presence, why, here, contacted, acting, holders, parentOf, lost, effects, notes, fixes, stated };
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
