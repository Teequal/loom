import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  ATTITUDES,
  type CampaignMechanic,
  type EntityTraits,
  type FieldMetaMap,
  IMPORTANCE,
  RELATION_TYPES,
} from "../entity-fields";
import { APPLIES_TO, type Toggles, TRIGGERS } from "../rules";

export const THREAD_KINDS = ["hook", "condition", "promise", "mystery", "grudge", "item", "other"] as const;
export const THREAD_STATUSES = ["open", "progressing", "resolved"] as const;
export const ENTITY_TYPES = ["pc", "npc", "location", "item", "faction", "other"] as const;
export const THREAD_CHANGES = ["new", "progressed", "resolved", "edited"] as const;

const createdAt = () => text("created_at").notNull().default(sql`(datetime('now'))`);

// Every value records where it came from (see FieldMeta); manual entries win over extraction.
const fieldMeta = () => text("field_meta", { mode: "json" }).$type<FieldMetaMap>().notNull().default({});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // Where the party is now. NPC locations can only be checked against this.
  partyLocationId: integer("party_location_id").references((): AnySQLiteColumn => entities.id, { onDelete: "set null" }),
  inGameDate: text("in_game_date").notNull().default(""),
  tone: text("tone").notNull().default(""), // comedic / heroic / grim / horror …
  // Superseded by the effects table (structured house rules); kept until old data is migrated.
  mechanics: text("mechanics", { mode: "json" }).$type<CampaignMechanic[]>().notNull().default([]),
  ruleToggles: text("rule_toggles", { mode: "json" }).$type<Toggles>().notNull().default({}),
  safetyLines: text("safety_lines", { mode: "json" }).$type<string[]>().notNull().default([]), // topics the table avoids
  fieldMeta: fieldMeta(),
  createdAt: createdAt(),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  date: text("date"),
  recap: text("recap").notNull().default(""),
  createdAt: createdAt(),
});

export const entities = sqliteTable("entities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ENTITY_TYPES }).notNull(),
  // Other names the DM or players use, e.g. "the potion guy". Used for matching mentions.
  aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
  description: text("description").notNull().default(""),
  // Tier 1 (continuity, checked by code). Allowed status values depend on type: ENTITY_STATUSES.
  status: text("status"),
  attitude: text("attitude", { enum: ATTITUDES }), // toward the party
  importance: text("importance", { enum: IMPORTANCE }),
  lastKnownLocationId: integer("last_known_location_id").references((): AnySQLiteColumn => entities.id, { onDelete: "set null" }),
  actualLocationId: integer("actual_location_id").references((): AnySQLiteColumn => entities.id, { onDelete: "set null" }),
  // Superseded by parentId (one hierarchy for every type); kept until a later cleanup drops it.
  parentLocationId: integer("parent_location_id").references((): AnySQLiteColumn => entities.id, { onDelete: "set null" }),
  // Hierarchy for every type: a place inside a place, an item in a set, a member of a creature
  // kind, a cell of a faction. Children inherit effects from their parents.
  parentId: integer("parent_id").references((): AnySQLiteColumn => entities.id, { onDelete: "set null" }),
  // Tier 2/3 (story fuel and flavour), validated by TraitsSchema.
  traits: text("traits", { mode: "json" }).$type<EntityTraits>().notNull().default({}),
  fieldMeta: fieldMeta(),
  createdAt: createdAt(),
});

// Relationships between entities: a fixed type the code can reason about, plus a note for nuance.
export const entityRelations = sqliteTable(
  "entity_relations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    fromEntityId: integer("from_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: integer("to_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    type: text("type", { enum: RELATION_TYPES }).notNull(),
    note: text("note").notNull().default(""),
    strength: integer("strength").notNull().default(0), // -3 … +3
    secret: integer("secret", { mode: "boolean" }).notNull().default(false),
    sinceSessionId: integer("since_session_id").references(() => sessions.id),
    source: text("source", { enum: ["dm", "extracted"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("entity_relations_unique").on(t.fromEntityId, t.toEntityId, t.type)],
);

// Structured house rules and effects (docs/loom-model.md §3c). An effect belongs to a source
// (an item, a place, a creature kind, a thread) or to the whole campaign, and says when it fires
// and who it applies to, so code can tell who may be asked for its roll.
export const effects = sqliteTable("effects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourceEntityId: integer("source_entity_id").references(() => entities.id, { onDelete: "cascade" }),
  sourceThreadId: integer("source_thread_id").references(() => threads.id, { onDelete: "cascade" }),
  trigger: text("trigger", { enum: TRIGGERS }).notNull(),
  appliesTo: text("applies_to", { enum: APPLIES_TO }).notNull(),
  appliesToList: text("applies_to_list", { mode: "json" }).$type<string[]>().notNull().default([]), // names, for "listed"
  check: text("check").notNull().default(""), // the roll: "madness roll", "Wisdom save DC 13"
  onFail: text("on_fail").notNull().default(""),
  onSuccess: text("on_success").notNull().default(""),
  escalation: text("escalation").notNull().default(""), // "harder to part with after each use"
  duration: text("duration").notNull().default(""),
  rule: text("rule").notNull().default(""), // the rule in plain words, as the DM would say it
  secret: integer("secret", { mode: "boolean" }).notNull().default(false),
  source: text("source", { enum: ["dm", "extracted"] }).notNull(),
  createdAt: createdAt(),
});

// The core unit: anything with unspent narrative payoff.
// Player states are threads of kind "condition" linked to a PC entity.
export const threads = sqliteTable("threads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  kind: text("kind", { enum: THREAD_KINDS }).notNull(),
  status: text("status", { enum: THREAD_STATUSES }).notNull().default("open"),
  summary: text("summary").notNull().default(""),
  payoffIdeas: text("payoff_ideas", { mode: "json" }).$type<string[]>().notNull().default([]),
  firstSeenSessionId: integer("first_seen_session_id").references(() => sessions.id),
  lastTouchedSessionId: integer("last_touched_session_id").references(() => sessions.id),
  deadline: text("deadline").notNull().default(""), // "before the Moons align"
  stakes: text("stakes").notNull().default(""), // what happens if it's ignored
  secret: integer("secret", { mode: "boolean" }).notNull().default(false), // GM-only thread
  fieldMeta: fieldMeta(),
  createdAt: createdAt(),
});

export const threadEntities = sqliteTable(
  "thread_entities",
  {
    threadId: integer("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    entityId: integer("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.entityId] })],
);

export const threadLinks = sqliteTable(
  "thread_links",
  {
    fromThreadId: integer("from_thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    toThreadId: integer("to_thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.fromThreadId, t.toThreadId] })],
);

// A thread's history: what happened to it, and in which session.
export const threadEvents = sqliteTable("thread_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: integer("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id),
  change: text("change", { enum: THREAD_CHANGES }).notNull(),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

// Every LLM call, for latency and cost tracking.
export const llmCalls = sqliteTable("llm_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: createdAt(),
});
