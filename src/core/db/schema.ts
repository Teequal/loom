import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, blob, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  // Where the GM wants the story to go, in their words: improv, Develop and prep steer by it.
  direction: text("direction").notNull().default(""),
  // At the table: apply risky changes without asking (still logged, still undoable).
  autoApprove: integer("auto_approve", { mode: "boolean" }).notNull().default(false),
  // Superseded by the effects table (structured house rules); kept until old data is migrated.
  mechanics: text("mechanics", { mode: "json" }).$type<CampaignMechanic[]>().notNull().default([]),
  ruleToggles: text("rule_toggles", { mode: "json" }).$type<Toggles>().notNull().default({}),
  safetyLines: text("safety_lines", { mode: "json" }).$type<string[]>().notNull().default([]), // topics the table avoids
  fieldMeta: fieldMeta(),
  createdAt: createdAt(),
});

// P, the player layer (docs/loom-model.md §6): the real people at the table. DM-only: never named
// in suggestions, only used to decide which suggestions rank first.
export const PILLARS = ["combat", "social", "exploration", "mystery", "comedy", "drama"] as const;
export type Pillar = (typeof PILLARS)[number];

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  handle: text("handle").notNull(), // first name or nickname; no surnames needed
  enjoys: text("enjoys", { mode: "json" }).$type<Partial<Record<Pillar, number>>>().notNull().default({}), // 0-3 per pillar
  personalLines: text("personal_lines", { mode: "json" }).$type<string[]>().notNull().default([]),
  tableNotes: text("table_notes").notNull().default(""), // real-world sensitivities the DM wants respected
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
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
  playerId: integer("player_id").references(() => players.id, { onDelete: "set null" }), // PCs: who plays them
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

// L4 history (docs/loom-model.md §5). Every state change, recorded automatically: who held what
// when, where people were, what changed and on whose word. Invisible day to day; it answers
// "as of session 3" and lets Loom notice contradictions.
export const stateChanges = sqliteTable("state_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id), // the session it happened in, or the latest one at the time
  subject: text("subject").notNull(), // "Monk figurine", "Salaena holds Monk figurine", "campaign"
  entityId: integer("entity_id").references(() => entities.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["field", "relation-added", "relation-removed", "relation-changed", "created", "thread-created", "thread-updated", "link-added", "moment-added"] }).notNull(),
  field: text("field").notNull().default(""),
  before: text("before", { mode: "json" }).$type<unknown>(),
  after: text("after", { mode: "json" }).$type<unknown>(),
  source: text("source", { enum: ["dm", "extracted"] }).notNull(),
  batch: text("batch"), // groups the changes from one recap, enrich or command, so they can be undone together
  threadId: integer("thread_id").references(() => threads.id, { onDelete: "set null" }),
  undoneAt: text("undone_at"), // set when this change was reversed with undo
  createdAt: createdAt(),
});

// Embeddings: a derived property of threads, entities, key moments and recap scenes, kept in its own
// table because it's large, binary, never edited, tied to a model, and regenerated whenever the
// text it was made from changes (text_hash). Similarity is computed in code: a campaign has
// hundreds of vectors, not millions.
export const embeddings = sqliteTable(
  "embeddings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    ownerType: text("owner_type", { enum: ["thread", "entity", "moment", "scene"] }).notNull(),
    ownerId: integer("owner_id").notNull(), // thread, entity or moment id; for scenes, the session id
    chunk: integer("chunk").notNull().default(0), // scenes: which part of the recap
    model: text("model").notNull(),
    textHash: text("text_hash").notNull(),
    text: text("text").notNull(), // what was embedded (scenes are quoted back from this)
    vector: blob("vector", { mode: "buffer" }).notNull(), // Float32 values
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("embeddings_owner").on(t.ownerType, t.ownerId, t.chunk, t.model)],
);

export const MOMENT_TONES =["comedic", "heroic", "tragic", "eerie", "tense", "triumphant", "tender", "other"] as const;

// Key moments: the curated history callbacks draw on. The DM flags them (or accepts ones Loom
// suggests from recaps), so callbacks reference what mattered rather than trivia.
export const keyMoments = sqliteTable("key_moments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  tone: text("tone", { enum: MOMENT_TONES }).notNull().default("other"),
  callback: text("callback").notNull().default(""), // how it could come back
  entityIds: text("entity_ids", { mode: "json" }).$type<number[]>().notNull().default([]),
  threadIds: text("thread_ids", { mode: "json" }).$type<number[]>().notNull().default([]),
  status: text("status", { enum: ["key", "suggested", "dismissed"] }).notNull().default("key"),
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
  campaignId: integer("campaign_id"), // which campaign it was for, when known (activity and cost per campaign)
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

// Every improv option the checks threw away, and why, so changes to the answer format and the
// checks can be measured against how often the model breaks them (and at the table, not just in tests).
export const optionRejections = sqliteTable("option_rejections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id"),
  model: text("model").notNull(),
  moment: text("moment").notNull(),
  label: text("label").notNull(),
  reason: text("reason").notNull(),
  kept: integer("kept").notNull(), // how many options the call ended up showing
  createdAt: createdAt(),
});

// The session in progress, as it happens at the table: every moment the GM asked about, the option
// they used (or their own), and what extracting it added to the loom. Each logged choice is
// extracted straight away so later suggestions see it; risky changes wait as questions.
export const LIVE_STATUS = ["asked", "extracting", "done", "failed"] as const;
export const liveEntries = sqliteTable("live_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sessionNumber: integer("session_number").notNull(),
  parentId: integer("parent_id"), // the choice this one was developed from: the session as a branching tree
  moment: text("moment").notNull(),
  options: text("options", { mode: "json" }).$type<{ label: string; text: string; threadIds: number[] }[]>().notNull().default([]),
  // null: asked, nothing used; branch: picked from a Develop result; result: how a roll or fight turned out
  choiceKind: text("choice_kind", { enum: ["option", "own", "branch", "result"] }),
  choiceLabel: text("choice_label").notNull().default(""),
  choice: text("choice").notNull().default(""),
  status: text("status", { enum: LIVE_STATUS }).notNull().default("asked"),
  batch: text("batch"), // what extraction wrote (undoable)
  summary: text("summary", { mode: "json" }).$type<string[]>().notNull().default([]), // what it added, one line each
  questions: text("questions", { mode: "json" })
    .$type<{ n: number; group: string; summary: string; reasons: string[]; evidence: string; answer: "yes" | "no" | null }[]>()
    .notNull()
    .default([]),
  wrapped: integer("wrapped", { mode: "boolean" }).notNull().default(false), // the session it belongs to was wrapped up
  // A roll or fight waits for its result: "roll" | "fight" while pending; resultState says what happened to that wait.
  awaiting: text("awaiting", { enum: ["roll", "fight"] }),
  resultState: text("result_state", { enum: ["pending", "given", "skipped"] }),
  encounter: text("encounter", { mode: "json" }).$type<unknown>(), // the fight as set up, when there is one
  // Develop results for this choice, kept so the branches survive a reload (newest last).
  developments: text("developments", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  createdAt: createdAt(),
});
