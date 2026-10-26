import { z } from "zod";

// The world model's nodes (docs/design-2026-10-25-world-model.md §3): every character, item,
// place, faction, thread, moment, rule and session as a typed object with nested properties.
// Plain data, validated by these schemas; the engine's functions read them. Connections are links
// (links.ts), never properties copied onto both ends.

export const NODE_KINDS = ["character", "item", "place", "faction", "other", "thread", "moment", "rule", "session", "party"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type NodeKey = `${NodeKind}:${number}`;
export const keyOf = (kind: NodeKind, id: number): NodeKey => `${kind}:${id}`;

// Which engine question a property answers (§5). The engine's functions read properties by these
// tags, so a new tagged property is used without writing a new check.
export const ENGINE_QUESTIONS = ["presence", "agency", "possession", "rules", "mood", "spotlight", "payoff", "knowledge", "identity"] as const;
export type EngineQuestion = (typeof ENGINE_QUESTIONS)[number];

// Who recorded a value, whether the players know it, and when. Kept per property path.
export const FieldMeta = z.object({
  source: z.enum(["dm", "extracted", "table", "inferred"]),
  session: z.number().int().nullable().optional(),
  confidence: z.enum(["stated", "implied"]).optional(),
  known: z.enum(["players", "gm"]).optional(), // "gm": shapes outcomes, never stated outright
});
export type FieldMeta = z.infer<typeof FieldMeta>;

const Base = z.object({
  key: z.string(), // "character:12"
  id: z.number().int(),
  campaignId: z.number().int(),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  summary: z.string(), // what a person reads
  notes: z.string(), // the DM's free notes: never read as facts
  meta: z.record(z.string(), FieldMeta), // per property path, e.g. "body.health"
});

const level = (min: number, max: number) => z.number().int().min(min).max(max);
export const SCALE = level(-3, 3); // moods, stances, tie strength

// A goal (or a faction's aim): text, rank, and the property model's weights on it.
export const Goal = z.object({
  id: z.string().optional(),
  text: z.string(),
  priority: level(1, 3),
  intent: SCALE.optional(), // −3 harms others … +3 helps others
  commitment: level(0, 3).optional(),
  target: z.string().optional(), // a node key
  status: z.enum(["active", "achieved", "abandoned", "blocked"]).optional(),
  secret: z.boolean().optional(),
});
export type Goal = z.infer<typeof Goal>;

// ---------- Characters (PCs and NPCs) ----------

export const CONDITIONS_5E = ["blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"] as const;

export const Character = Base.extend({
  kind: z.literal("character"),
  side: z.enum(["pc", "npc"]),
  status: z.enum(["alive", "dead", "missing", "captured", "transformed", "unknown"]).optional(),
  importance: z.enum(["major", "minor", "walk-on"]).optional(),
  stance: SCALE.optional(), // towards the party: -3 hostile … +3 devoted (from attitude)
  interplayOverrides: z.array(z.object({ id: z.string(), on: z.boolean(), other: z.string().optional() })).optional(), // the DM's word on an interplay
  identity: z.object({
    race: z.string().optional(),
    occupation: z.string().optional(), // class for PCs
    level: level(1, 20).optional(),
    age: z.string().optional(),
    gender: z.string().optional(),
    alignment: z.string().optional(),
    background: z.string().optional(),
    appearance: z.array(z.string()),
    voice: z.string().optional(),
    personality: z.array(z.string()),
    languages: z.array(z.string()),
  }),
  body: z.object({
    health: z.enum(["healthy", "wounded", "bloodied", "critical", "unconscious", "dead"]).optional(),
    // 5e conditions by name, plus story conditions in words ("pinned by a spear through her tail").
    conditions: z.array(z.object({ name: z.string(), is5e: z.boolean(), until: z.string().optional(), by: z.string().optional(), target: z.string().optional() })), // by, target: node keys ("charmed by Iresia")
    form: z.object({ name: z.string(), until: z.string().optional() }).optional(), // a wildshape, a disguise
  }),
  mind: z.object({
    mood: SCALE.optional(), // blanks beat guesses: unset until the DM (or a confirmed proposal) sets it
    goals: z.array(Goal),
    wants: z.array(z.string()),
    fears: z.array(z.string()),
    flaws: z.array(z.string()),
    ideals: z.array(z.string()),
    bonds: z.array(z.string()),
    beliefs: z.array(z.object({ id: z.string().optional(), text: z.string(), true: z.boolean().optional(), conviction: level(1, 3).optional() })), // "he can't die" (true: false)
    // The property model's layers (docs/design-2026-10-26-property-model.md §4.1): what they're like
    // underneath, and how they are right now. Blank where nobody has said.
    disposition: z.record(z.string(), SCALE),
    state: z.record(z.string(), SCALE),
  }),
  abilities: z.array(z.object({ name: z.string(), uses: z.object({ per: z.string(), max: z.number(), left: z.number() }).optional() })),
  gear: z.array(z.string()), // mundane gear a clever option could use; magic items are item nodes
  knowledge: z.array(z.object({ text: z.string(), secret: z.boolean() })), // secrets they hold, things they'd share
  wealth: z.string().optional(),
  senses: z.object({ passivePerception: z.number().optional(), passiveInsight: z.number().optional() }),
  hooks: z.array(z.string()), // backstory hooks
});
export type Character = z.infer<typeof Character>;

// ---------- Items ----------

export const Item = Base.extend({
  kind: z.literal("item"),
  status: z.enum(["intact", "used", "broken", "lost", "destroyed", "unknown"]).optional(),
  properties: z.object({
    known: z.string().optional(),
    true: z.string().optional(), // GM: what it really does
    cost: z.string().optional(), // the price of use
    rarity: z.string().optional(),
    power: level(0, 3).optional(),
    pull: level(0, 3).optional(), // how much it draws its holder to use it
    costSeverity: level(0, 3).optional(),
    costGrows: z.boolean().optional(),
  }),
  uses: z.object({ max: z.number().optional(), left: z.number().optional() }).optional(),
  sharedPossession: z.boolean(), // several can hold it at once
});
export type Item = z.infer<typeof Item>;

// ---------- Places ----------

export const PLACE_SCALES = ["region", "settlement", "district", "building", "room", "site"] as const;
export const Place = Base.extend({
  kind: z.literal("place"),
  status: z.enum(["intact", "destroyed", "occupied", "abandoned", "unknown"]).optional(),
  scale: z.enum(PLACE_SCALES).optional(), // so "in Duradan" isn't "in the tavern"
  placeType: z.string().optional(), // as the notes put it: tavern, ruins, woods
  hazards: z.array(z.string()),
  atmosphere: z.array(z.string()),
  danger: level(0, 3).optional(),
});
export type Place = z.infer<typeof Place>;

// ---------- Factions and other ----------

export const Faction = Base.extend({
  kind: z.literal("faction"),
  status: z.enum(["active", "disbanded", "destroyed", "unknown"]).optional(),
  stance: SCALE.optional(),
  goal: z.string().optional(),
  plan: z.string().optional(),
  clock: z.object({ filled: z.number(), of: z.number() }).optional(), // "3 of 6"
  aims: z.array(Goal),
  interplayOverrides: z.array(z.object({ id: z.string(), on: z.boolean(), other: z.string().optional() })).optional(),
  aggression: level(0, 3).optional(),
  alert: level(0, 3).optional(),
});
export type Faction = z.infer<typeof Faction>;

export const Other = Base.extend({ kind: z.literal("other"), status: z.string().optional() });
export type Other = z.infer<typeof Other>;

// ---------- Threads ----------

export const Thread = Base.extend({
  kind: z.literal("thread"),
  threadKind: z.enum(["hook", "condition", "promise", "mystery", "grudge", "item", "other"]),
  status: z.enum(["open", "building", "ripe", "resolved"]),
  stakes: z.object({ level: level(1, 5).optional(), ifIgnored: z.string().optional() }),
  deadline: z.object({ text: z.string(), session: z.number().optional() }).optional(),
  urgency: level(0, 3).optional(),
  steps: z.array(z.object({ session: z.number().nullable(), change: z.enum(["new", "progressed", "resolved", "edited"]), note: z.string() })),
  payoffs: z.array(z.string()),
  secret: z.boolean(),
  firstSeen: z.number().nullable(), // session numbers
  lastTouched: z.number().nullable(),
});
export type Thread = z.infer<typeof Thread>;

// ---------- Key moments, house rules, sessions, the party ----------

export const Moment = Base.extend({
  kind: z.literal("moment"),
  tone: z.string(),
  callback: z.string(),
  session: z.number().nullable(),
  star: z.enum(["key", "suggested", "dismissed"]),
});
export type Moment = z.infer<typeof Moment>;

export const Rule = Base.extend({
  kind: z.literal("rule"),
  trigger: z.string(),
  appliesTo: z.string(),
  check: z.string(),
  onFail: z.string(),
  onSuccess: z.string(),
  escalation: z.string(),
  duration: z.string(),
  secret: z.boolean(),
});
export type Rule = z.infer<typeof Rule>;

export const Session = Base.extend({ kind: z.literal("session"), number: z.number(), date: z.string().nullable() });
export type Session = z.infer<typeof Session>;

// The party as one node: it's somewhere (a link), and the PCs belong to it (links).
export const Party = Base.extend({ kind: z.literal("party"), inGameDate: z.string(), tone: z.string(), direction: z.string() });
export type Party = z.infer<typeof Party>;

export const AnyNode = z.discriminatedUnion("kind", [Character, Item, Place, Faction, Other, Thread, Moment, Rule, Session, Party]);
export type AnyNode = z.infer<typeof AnyNode>;

// Engine tags: which questions each property answers (§5), by kind and property path.
export const READS: Partial<Record<NodeKind, Record<string, EngineQuestion[]>>> = {
  character: {
    status: ["presence", "agency"],
    "body.health": ["agency"],
    "body.conditions": ["agency"],
    "body.form": ["agency", "identity"],
    "mind.mood": ["mood"],
    "mind.goals": ["payoff"],
    "mind.beliefs": ["payoff"],
    stance: ["mood"],
    abilities: ["agency"],
    knowledge: ["knowledge"],
    identity: ["identity"],
  },
  item: { status: ["presence", "possession"], sharedPossession: ["possession"], uses: ["agency"], "properties.cost": ["rules"] },
  place: { status: ["presence"], scale: ["presence"], hazards: ["rules"] },
  faction: { status: ["presence"], stance: ["mood"], clock: ["payoff"] },
  thread: { status: ["payoff"], stakes: ["payoff"], deadline: ["payoff"], steps: ["payoff", "spotlight"], secret: ["knowledge"] },
  moment: { star: ["payoff"] },
  rule: { trigger: ["rules"], appliesTo: ["rules"] },
};
