import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const THREAD_KINDS = ["hook", "condition", "promise", "mystery", "grudge", "item", "other"] as const;
export const THREAD_STATUSES = ["open", "progressing", "resolved"] as const;
export const ENTITY_TYPES = ["pc", "npc", "location", "item", "faction", "other"] as const;
export const THREAD_CHANGES = ["new", "progressed", "resolved", "edited"] as const;

const createdAt = () => text("created_at").notNull().default(sql`(datetime('now'))`);

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
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
