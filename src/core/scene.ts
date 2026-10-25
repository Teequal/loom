import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { EffectInPlay } from "./effects";
import type { EntityTraits } from "./entity-fields";
import type { Budget } from "./graph";
import { capabilitiesOf, RELATION_LAWS, togglesText } from "./rules";
import { buildSituation, loadWorld, type Overrides, type Presence, type Situation } from "./situation";

// The scene: where the party is, who's here, the party roster and compact cards for the
// entities in play. Built from structured data so the model can't contradict continuity,
// and so code can check its answers (dead NPCs acting, NPCs who aren't here appearing).

type Entity = typeof schema.entities.$inferSelect;
type Relation = typeof schema.entityRelations.$inferSelect;
export type { Presence };

export interface Scene {
  text: string; // prompt block
  partyLocation: Entity | null;
  pcs: Entity[];
  entities: Entity[];
  holds: { holder: string; item: string }[];
  effects: EffectInPlay[];
  safetyLines: string[];
  realNames: string[]; // the real people at the table: never written into anything the model says
  /** Resolves a name as the model wrote it ("Zara", "the alchemist") to an entity. */
  resolve: (name: string) => Entity | undefined;
  presence: (e: Entity) => Presence;
  whereabouts: (e: Entity) => string; // human-readable, for rejection reasons
  situation: Situation; // the scene model everything here is read from
}

const MAX_CARDS = 10;
// "Played by Sam." in a character's description names a real person: kept out of every prompt.
export const PLAYED_BY = /\s*\(?\b(?:[Pp]layed|[Rr]un) by ([A-Z][\w'’-]+(?: [A-Z][\w'’-]+)?)\.?\)?/g;

export async function buildScene(
  campaignId: number,
  opts: {
    mentioned: Set<string>;
    threadEntities: string[];
    storyConditions?: Map<string, string[]>;
    // Context by distance: how many links each entity is from the moment, and how much to show.
    distances?: Map<number, number>;
    budget?: Budget;
    // The scene model: built here from the moment (and the GM's corrections) unless given.
    moment?: string;
    overrides?: Overrides;
    situation?: Situation;
  },
): Promise<Scene> {
  const situation = opts.situation ?? buildSituation(await loadWorld(campaignId), opts.moment ?? "", opts.overrides);
  const campaign = situation.world.campaign;
  const entities = situation.entities;
  const relations = situation.world.relations;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameOf = (id: number | null) => (id == null ? null : (byId.get(id)?.name ?? null));

  // Name lookup: full names and aliases, plus a first word when it belongs to only one entity.
  const lookup = new Map<string, Entity>();
  const firstWords = new Map<string, Entity[]>();
  for (const e of entities) {
    for (const n of [e.name, ...e.aliases]) lookup.set(n.toLowerCase(), e);
    const first = e.name.split(/[\s,]+/)[0].toLowerCase();
    if (first.length >= 3) firstWords.set(first, [...(firstWords.get(first) ?? []), e]);
  }
  for (const [w, es] of firstWords) if (es.length === 1 && !lookup.has(w)) lookup.set(w, es[0]);
  const resolve = (name: string) => {
    const n = name.trim().toLowerCase().replace(/^the\s+/, "");
    return lookup.get(n) ?? lookup.get(`the ${n}`) ?? lookup.get(n.split(/[\s,]+/)[0]);
  };

  const chain = (id: number | null) => {
    const names: string[] = [];
    let cur = id;
    for (let hops = 0; cur != null && hops < 6; hops++) {
      const e = byId.get(cur);
      if (!e) break;
      names.push(e.name);
      cur = e.parentId;
    }
    return names.join(" › ");
  };

  const party = situation.party;
  const locationOf = (e: Entity) => e.actualLocationId ?? e.lastKnownLocationId;
  const presence = situation.presence;
  const whereabouts = (e: Entity) => {
    const loc = nameOf(locationOf(e));
    return loc ? `last known at ${loc}` : "whereabouts unknown";
  };

  const pcs = entities.filter((e) => e.type === "pc");
  // Two-way relationships (ally, enemy…) are stored both ways; show each once.
  const relationsOf = (e: Entity) => {
    const seen = new Set<string>();
    return relations
      .filter((r) => r.fromEntityId === e.id || r.toEntityId === e.id)
      .filter((r) => {
        const key = RELATION_LAWS[r.type]?.symmetric ? `${r.type}:${[r.fromEntityId, r.toEntityId].sort().join("-")}` : `${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => relationText(r, e.id, nameOf))
      .slice(0, 6);
  };

  // Cards: entities named in the moment first, then those on the threads in play, then NPCs
  // who are here; major ones before minor. PCs are covered by the roster.
  const threadNames = new Set(opts.threadEntities);
  const rank = (e: Entity) =>
    (opts.mentioned.has(e.name) ? 100 : 0) +
    (threadNames.has(e.name) ? 10 : 0) +
    (e.type === "npc" ? { here: 6, "with-party": 5, nearby: 2, elsewhere: 0, unknown: 0 }[presence(e)] : 0) +
    (e.importance === "major" ? 2 : e.importance === "minor" ? 1 : 0);
  // With distances, detail follows closeness: full cards nearest the moment, briefs one step
  // out, names two steps out, nothing beyond. Without, the older ranking applies.
  const dist = opts.distances;
  const budget = opts.budget;
  const levels = new Map<number, "full" | "brief">();
  const nearby: Entity[] = [];
  let cardEntities: Entity[];
  if (dist && budget) {
    const candidates = entities
      .filter((e) => e.type !== "pc" && e.type !== "location" && dist.has(e.id))
      .sort((a, b) => dist.get(a.id)! - dist.get(b.id)! || rank(b) - rank(a));
    let full = 0;
    let brief = 0;
    for (const e of candidates) {
      const d = dist.get(e.id)!;
      if (d === 0 && full < budget.full) {
        levels.set(e.id, "full");
        full++;
      } else if (d <= 1 && brief < budget.brief) {
        levels.set(e.id, "brief");
        brief++;
      } else if (nearby.length < budget.names) nearby.push(e);
    }
    cardEntities = candidates.filter((e) => levels.has(e.id));
  } else {
    cardEntities = entities
      .filter((e) => e.type !== "pc" && e.type !== "location" && rank(e) >= 5)
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, MAX_CARDS);
    for (const e of cardEntities) levels.set(e.id, "full");
  }

  const npcsWhere = (p: Presence) => entities.filter((e) => e.type === "npc" && e.status !== "dead" && presence(e) === p).map((e) => e.name);
  const withParty = npcsWhere("with-party");
  const broughtIn = npcsWhere("here");
  const around = npcsWhere("nearby");
  const onlyNamed = [...situation.reading.referred].filter((n) => entities.find((e) => e.name === n)?.status !== "dead");
  const dead = entities.filter((e) => e.type === "npc" && e.status === "dead").map((e) => e.name);

  const lines: string[] = [];
  lines.push("THE SCENE");
  lines.push(party ? `- The party is at: ${chain(party.id)}` : "- The party's location is not recorded.");
  if (party) {
    lines.push(`- With the party: ${withParty.length ? withParty.join(", ") : "no NPCs"}`);
    if (broughtIn.length) lines.push(`- Here now, because of this moment: ${broughtIn.join(", ")}`);
    if (around.length) lines.push(`- Recorded somewhere around here, not with the party (they can turn up): ${around.join(", ")}`);
  }
  if (onlyNamed.length) lines.push(`- Only mentioned, not here (they can only arrive or send word): ${onlyNamed.join(", ")}`);
  if (situation.contacted.size) lines.push(`- Reached from afar by the players (may answer remotely): ${[...situation.contacted].join(", ")}`);
  if (situation.lost.size) lines.push(`- Lost (nobody has them): ${[...situation.lost].join(", ")}`);
  if (dead.length) lines.push(`- Dead (can't act): ${dead.join(", ")}`);
  if (campaign?.tone) lines.push(`- Tone: ${campaign.tone}`);
  if (campaign?.safetyLines.length) lines.push(`- Safety lines (never include): ${campaign.safetyLines.join("; ")}`);

  // The rules layer: toggles that differ from standard 5e, and every effect with who it reaches now.
  const effects: EffectInPlay[] = situation.effects;
  const toggles = togglesText(campaign?.ruleToggles ?? {});
  // With distances, only rules that reach someone now or whose source is close by.
  const shown = dist ? effects.filter((e) => e.targets.length > 0 || (e.effect.sourceEntityId != null && dist.has(e.effect.sourceEntityId))) : effects;
  if (toggles.length || shown.length) {
    lines.push("", "RULES IN PLAY (5e unless noted)");
    for (const t of toggles) lines.push(`- ${t}`);
    for (const e of shown) lines.push(`- ${e.text}${situation.effects.find((x) => x.effect.id === e.effect.id)?.live === false && e.targets.length ? ` (not triggered in this moment: ${situation.effects.find((x) => x.effect.id === e.effect.id)!.why}; don't call its roll)` : ""}`);
  }

  lines.push("", "THE PARTY (player characters, controlled by the players)");
  for (const p of pcs) {
    const story = opts.storyConditions?.get(p.name) ?? [];
    // PCs in the moment get everything; the rest of the party a brief line.
    const level = !dist || dist.get(p.id) === 0 || opts.mentioned.has(p.name) ? "full" : "brief";
    lines.push(`- ${card(p, { nameOf, presence: null, relations: relationsOf(p), level })}${story.length ? ` Story conditions: ${story.join("; ")}.` : ""}`);
  }

  if (cardEntities.length) {
    lines.push("", "WHO AND WHAT IS IN PLAY");
    for (const e of cardEntities) lines.push(`- ${card(e, { nameOf, presence: party ? presence(e) : null, relations: relationsOf(e), level: levels.get(e.id) ?? "full" })}`);
  }
  if (nearby.length) {
    lines.push("", `ALSO NEARBY (name only): ${nearby.map((e) => `${e.name} (${e.type}${e.status === "dead" ? ", dead" : ""})`).join("; ")}`);
  }

  return {
    text: lines.join("\n"),
    partyLocation: party,
    pcs,
    entities,
    // A lost item has no holder, whatever an older record says (the Knight figurine thrown in the
    // Morrow but still "held" by Khayiulad).
    holds: [...situation.holders].flatMap(([item, who]) => [...who].map((holder) => ({ holder, item }))),
    effects,
    safetyLines: campaign?.safetyLines ?? [],
    realNames: [
      ...(await db.select({ handle: schema.players.handle }).from(schema.players).where(eq(schema.players.campaignId, campaignId))).map((p) => p.handle),
      ...entities.flatMap((e) => [...e.description.matchAll(PLAYED_BY)].map((m) => m[1])),
    ].filter((n) => n && n.length >= 2),
    resolve,
    presence,
    whereabouts,
    situation,
  };
}

function relationText(r: Relation, _selfId: number, nameOf: (id: number | null) => string | null) {
  void _selfId;
  const text = `${nameOf(r.fromEntityId)} ${r.type.replace(/_/g, " ")} ${nameOf(r.toEntityId)}`;
  return `${text}${r.note ? ` (${r.note})` : ""}${r.secret ? " [GM secret]" : ""}`;
}

// One compact line per entity. Secret fields are kept but tagged, so they shape what happens
// without being revealed.
function card(e: Entity, ctx: { nameOf: (id: number | null) => string | null; presence: Presence | null; relations: string[]; level?: "full" | "brief" }) {
  const brief = ctx.level === "brief";
  const secret = (field: string) => (e.fieldMeta[field]?.secret ? " [GM secret]" : "");
  const t = e.traits as EntityTraits;
  const label = e.type === "pc" ? "PC" : e.type === "npc" ? "NPC" : e.type;
  const head = [label, e.status, e.type !== "pc" && e.attitude && `${e.attitude} to the party`, t.alignment, t.race, t.occupation].filter(Boolean).join(", ");

  const parts: string[] = [];
  if (e.description) parts.push(e.description.replace(PLAYED_BY, "").trim());
  if (e.status === "dead") parts.push("Dead: can be remembered or found, never acts.");
  else if (ctx.presence === "here") parts.push("Here now.");
  else if (ctx.presence === "with-party") parts.push("With the party.");
  else if (ctx.presence === "nearby") parts.push("Somewhere around here, not with the party.");
  const lastKnown = ctx.nameOf(e.lastKnownLocationId);
  const actual = ctx.nameOf(e.actualLocationId);
  if (actual && actual !== lastKnown) parts.push(`Actually at ${actual}${secret("actualLocationId")}.`);
  if (lastKnown && ctx.presence !== "with-party") parts.push(`Last seen at ${lastKnown}.`);

  const list = (k: keyof EntityTraits, title: string) => {
    const v = t[k];
    if (Array.isArray(v) ? v.length : v) parts.push(`${title}: ${Array.isArray(v) ? v.join("; ") : v}${secret(`traits.${k}`)}.`);
  };
  list("health", "Health");
  list("conditions", "Conditions");
  // What the 5e conditions mean right now, spelled out so they're not ignored.
  const caps = capabilitiesOf(e);
  const cant = (["act", "move", "speak", "aware"] as const).filter((k) => !caps[k]).map((k) => (k === "aware" ? "perceive" : k));
  if (e.status !== "dead" && (cant.length || caps.laws.length)) {
    parts.push(`Right now: ${[cant.length && `can't ${cant.join(", ")}`, ...caps.laws].filter(Boolean).join("; ")}.`);
  }
  list("abilities", "Abilities");
  // A brief card keeps what continuity needs (state, abilities, goal, key ties) and drops colour.
  if (!brief) {
    list("languages", "Languages");
    list("gear", "Gear");
  }
  list("goal", "Goal");
  if (!brief) {
    list("wants", "Wants");
    list("fears", "Fears");
    list("voice", "Voice");
    list("personality_traits", "Personality");
    list("flaws", "Flaws");
    list("secrets", "Secrets");
  }
  list("known_properties", "Known properties");
  if (!brief) {
    list("true_properties", "True properties");
    list("cost", "Cost of use");
    list("plan", "Plan");
  }
  const rels = brief ? ctx.relations.slice(0, 2) : ctx.relations;
  if (rels.length) parts.push(`Relationships: ${rels.join("; ")}.`);
  return `${e.name} (${head}). ${parts.join(" ")}`;
}
