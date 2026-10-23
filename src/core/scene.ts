import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { CampaignMechanic, EntityTraits } from "./entity-fields";

// The scene: where the party is, who's here, the party roster and compact cards for the
// entities in play. Built from structured data so the model can't contradict continuity,
// and so code can check its answers (dead NPCs acting, NPCs who aren't here appearing).

type Entity = typeof schema.entities.$inferSelect;
type Relation = typeof schema.entityRelations.$inferSelect;
export type Presence = "here" | "elsewhere" | "unknown";

export interface Scene {
  text: string; // prompt block
  partyLocation: Entity | null;
  pcs: Entity[];
  entities: Entity[];
  mechanics: CampaignMechanic[];
  safetyLines: string[];
  /** Resolves a name as the model wrote it ("Zara", "the alchemist") to an entity. */
  resolve: (name: string) => Entity | undefined;
  presence: (e: Entity) => Presence;
  whereabouts: (e: Entity) => string; // human-readable, for rejection reasons
}

const MAX_CARDS = 10;

export async function buildScene(
  campaignId: number,
  opts: { mentioned: Set<string>; threadEntities: string[]; storyConditions?: Map<string, string[]> },
): Promise<Scene> {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const relations = await db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId));
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

  // Location hierarchy, in memory: is `place` inside `container` (or the same)?
  const within = (place: number, container: number) => {
    let cur: number | null = place;
    for (let hops = 0; cur != null && hops < 20; hops++) {
      if (cur === container) return true;
      cur = byId.get(cur)?.parentLocationId ?? null;
    }
    return false;
  };
  const chain = (id: number | null) => {
    const names: string[] = [];
    let cur = id;
    for (let hops = 0; cur != null && hops < 6; hops++) {
      const e = byId.get(cur);
      if (!e) break;
      names.push(e.name);
      cur = e.parentLocationId;
    }
    return names.join(" › ");
  };

  const party = campaign?.partyLocationId ? (byId.get(campaign.partyLocationId) ?? null) : null;
  const locationOf = (e: Entity) => e.actualLocationId ?? e.lastKnownLocationId;
  const presence = (e: Entity): Presence => {
    const loc = locationOf(e);
    if (!party || loc == null) return "unknown";
    // Here if they're somewhere inside the party's location, or the party is inside theirs
    // (an NPC known only to be "in Duradan" could be at the clocktower).
    return within(loc, party.id) || within(party.id, loc) ? "here" : "elsewhere";
  };
  const whereabouts = (e: Entity) => {
    const loc = nameOf(locationOf(e));
    return loc ? `last known at ${loc}` : "whereabouts unknown";
  };

  const pcs = entities.filter((e) => e.type === "pc");
  const relationsOf = (e: Entity) =>
    relations
      .filter((r) => r.fromEntityId === e.id || r.toEntityId === e.id)
      .map((r) => relationText(r, e.id, nameOf))
      .slice(0, 6);

  // Cards: entities named in the moment first, then those on the threads in play, then NPCs
  // who are here; major ones before minor. PCs are covered by the roster.
  const threadNames = new Set(opts.threadEntities);
  const rank = (e: Entity) =>
    (opts.mentioned.has(e.name) ? 100 : 0) +
    (threadNames.has(e.name) ? 10 : 0) +
    (e.type === "npc" && presence(e) === "here" ? 5 : 0) +
    (e.importance === "major" ? 2 : e.importance === "minor" ? 1 : 0);
  const cardEntities = entities
    .filter((e) => e.type !== "pc" && e.type !== "location" && rank(e) >= 5)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MAX_CARDS);

  const here = entities.filter((e) => e.type === "npc" && e.status !== "dead" && presence(e) === "here").map((e) => e.name);
  const dead = entities.filter((e) => e.type === "npc" && e.status === "dead").map((e) => e.name);

  const lines: string[] = [];
  lines.push("THE SCENE");
  lines.push(party ? `- The party is at: ${chain(party.id)}` : "- The party's location is not recorded.");
  if (party) lines.push(`- NPCs known to be here: ${here.length ? here.join(", ") : "none recorded"}`);
  if (dead.length) lines.push(`- Dead (can't act): ${dead.join(", ")}`);
  if (campaign?.tone) lines.push(`- Tone: ${campaign.tone}`);
  if (campaign?.safetyLines.length) lines.push(`- Safety lines (never include): ${campaign.safetyLines.join("; ")}`);
  if (campaign?.mechanics.length) {
    lines.push("- The GM's mechanics (use them where they fit):");
    for (const m of campaign.mechanics) lines.push(`  - ${m.name}: ${m.rule}`);
  }

  lines.push("", "THE PARTY (player characters, controlled by the players)");
  for (const p of pcs) {
    const story = opts.storyConditions?.get(p.name) ?? [];
    lines.push(`- ${card(p, { nameOf, presence: null, relations: relationsOf(p) })}${story.length ? ` Story conditions: ${story.join("; ")}.` : ""}`);
  }

  if (cardEntities.length) {
    lines.push("", "WHO AND WHAT IS IN PLAY");
    for (const e of cardEntities) lines.push(`- ${card(e, { nameOf, presence: party ? presence(e) : null, relations: relationsOf(e) })}`);
  }

  return {
    text: lines.join("\n"),
    partyLocation: party,
    pcs,
    entities,
    mechanics: campaign?.mechanics ?? [],
    safetyLines: campaign?.safetyLines ?? [],
    resolve,
    presence,
    whereabouts,
  };
}

function relationText(r: Relation, _selfId: number, nameOf: (id: number | null) => string | null) {
  void _selfId;
  const text = `${nameOf(r.fromEntityId)} ${r.type.replace(/_/g, " ")} ${nameOf(r.toEntityId)}`;
  return `${text}${r.note ? ` (${r.note})` : ""}${r.secret ? " [GM secret]" : ""}`;
}

// One compact line per entity. Secret fields are kept but tagged, so they shape what happens
// without being revealed.
function card(e: Entity, ctx: { nameOf: (id: number | null) => string | null; presence: Presence | null; relations: string[] }) {
  const secret = (field: string) => (e.fieldMeta[field]?.secret ? " [GM secret]" : "");
  const t = e.traits as EntityTraits;
  const label = e.type === "pc" ? "PC" : e.type === "npc" ? "NPC" : e.type;
  const head = [label, e.status, e.type !== "pc" && e.attitude && `${e.attitude} to the party`, t.alignment, t.race, t.occupation].filter(Boolean).join(", ");

  const parts: string[] = [];
  if (e.description) parts.push(e.description);
  if (e.status === "dead") parts.push("Dead: can be remembered or found, never acts.");
  else if (ctx.presence === "here") parts.push("Here now.");
  const lastKnown = ctx.nameOf(e.lastKnownLocationId);
  const actual = ctx.nameOf(e.actualLocationId);
  if (actual && actual !== lastKnown) parts.push(`Actually at ${actual}${secret("actualLocationId")}.`);
  if (lastKnown && ctx.presence !== "here") parts.push(`Last seen at ${lastKnown}.`);

  const list = (k: keyof EntityTraits, title: string) => {
    const v = t[k];
    if (Array.isArray(v) ? v.length : v) parts.push(`${title}: ${Array.isArray(v) ? v.join("; ") : v}${secret(`traits.${k}`)}.`);
  };
  list("health", "Health");
  list("conditions", "Conditions");
  list("abilities", "Abilities");
  list("languages", "Languages");
  list("gear", "Gear");
  list("goal", "Goal");
  list("wants", "Wants");
  list("fears", "Fears");
  list("voice", "Voice");
  list("personality_traits", "Personality");
  list("flaws", "Flaws");
  list("secrets", "Secrets");
  list("known_properties", "Known properties");
  list("true_properties", "True properties");
  list("cost", "Cost of use");
  list("plan", "Plan");
  if (ctx.relations.length) parts.push(`Relationships: ${ctx.relations.join("; ")}.`);
  return `${e.name} (${head}). ${parts.join(" ")}`;
}
