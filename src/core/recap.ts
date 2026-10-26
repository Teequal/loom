import { recordInterplayChanges } from "./interplay-history";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { ENTITY_TYPES, MOMENT_TONES, PAIR_WEIGHTS, THREAD_KINDS } from "./db/schema";
import {
  applyEntityChanges,
  applyPropertyChanges,
  ENTITY_RULES,
  PROPERTY_RULES,
  EntityChangesShape,
  entityStateText,
  type EntityApplyResult,
  type EntityUpdate,
  type RelationChange,
  SUB_KEYS,
  SubChangeSchema,
  WeightChangeSchema,
  type SubChange,
  type WeightChange,
} from "./entity-extraction";
import { logChanges } from "./history";
import { callLlm } from "./llm";
import { addMoment } from "./moments";

// Moments worth calling back later. Saved as suggestions; the DM stars the ones to keep.
const MomentSchema = z.object({
  session: z.number(), // which session it happened in
  title: z.string(),
  description: z.string(),
  tone: z.enum(MOMENT_TONES),
  callback: z.string(),
  entities: z.array(z.string()),
  threads: z.array(z.string()), // "T12" or "N3"
});
export type MomentSuggestion = z.infer<typeof MomentSchema>;

const MOMENT_RULES = `key_moments
- 0-3 moments per session worth calling back later: a big laugh, a turning point, a dramatic reveal, a character-defining choice, a costly mistake. Not routine events.
- session: the session number it happened in. title: under 8 words. description: one or two sentences of what happened. tone: ${MOMENT_TONES.join(", ")}.
- callback: one sentence on how it could come back later (an NPC remembers, a consequence lands, an echo of the moment).
- entities: exact names of who and what was involved. threads: related threads as "T<id>" (or "N<n>" for new ones).`;

const NewEntitySchema = z.object({
  evidence: z.string(),
  name: z.string(),
  type: z.enum(ENTITY_TYPES),
  aliases: z.array(z.string()),
  description: z.string(),
});

// What the model proposes after reading a recap. Existing threads are referred to as "T<id>",
// new threads as "N<n>", entities by exact name. Nothing is stored until the DM approves.
export const ProposalSchema = z.object({
  ...EntityChangesShape,
  new_entities: z.array(NewEntitySchema),
  new_threads: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      kind: z.enum(THREAD_KINDS),
      summary: z.string(),
      entities: z.array(z.string()),
      evidence: z.string(),
    }),
  ),
  thread_updates: z.array(
    z.object({
      thread: z.string(),
      change: z.enum(["progressed", "resolved"]),
      note: z.string(),
      new_summary: z.string(),
      evidence: z.string(),
    }),
  ),
  thread_links: z.array(z.object({ from: z.string(), to: z.string(), note: z.string() })),
  key_moments: z.array(MomentSchema),
});
// The property model's values come from their own call (proposeProperties), merged in here.
export type Proposal = z.infer<typeof ProposalSchema> & { sub_properties: SubChange[]; pair_weights: WeightChange[] };

// Backfill: entity details only, read from recaps already stored.
const EnrichSchema = z.object({ new_entities: z.array(NewEntitySchema), ...EntityChangesShape, key_moments: z.array(MomentSchema) });

// A proposal plus what's needed to apply it later (possibly after the DM edits the file).
// kind "enrich" proposals don't touch the session's stored recap.
export interface ProposalFile {
  kind?: "recap" | "enrich" | "live" | "infer"; // live: one moment at the table; the session's notes come at wrap-up. infer: the property-model pass over every recap (blanks only)
  campaignId: number;
  sessionNumber: number;
  recap: string;
  proposal: Proposal;
}

// Proposal files saved before entity extraction existed lack these fields.
function withDefaults(p: Partial<Proposal>): Proposal {
  return {
    new_entities: p.new_entities ?? [],
    new_threads: p.new_threads ?? [],
    thread_updates: p.thread_updates ?? [],
    thread_links: p.thread_links ?? [],
    entity_updates: p.entity_updates ?? [],
    relations: p.relations ?? [],
    party_location: p.party_location ?? "",
    party_evidence: p.party_evidence ?? "",
    key_moments: p.key_moments ?? [],
    sub_properties: p.sub_properties ?? [],
    pair_weights: p.pair_weights ?? [],
  };
}

const SYSTEM = `You maintain the thread list for a tabletop RPG campaign, so the game master can tie future moments back to what already happened.

A thread is anything with unspent narrative payoff: an unresolved hook or mission, a mystery, a player character condition (curse, madness, false belief, lasting injury, lost ability), an NPC promise or debt, a grudge, an item whose purpose is unknown, a consequence that hasn't landed yet. Not threads: events that are fully over with nothing lingering, combat blow-by-blow, scenery.

Given the current campaign state and a new session recap, propose changes:

Every new entity, new thread and thread update also carries evidence: a short exact quote (under 20 words) copied from the recap.

new_threads
- Only situations with real payoff potential. Prefer fewer, meatier threads over many thin ones.
- Title: under 10 words, phrased as the open situation, e.g. "Darius believes he is invulnerable", "Who killed the miller?".
- Summary: 1-2 concrete sentences with names.
- A player character's condition is kind "condition" and must list that PC in entities.
- entities: exact names of the characters, places, items or factions the thread is about.
- ref: "N1", "N2", ...
- Before adding a thread, check the existing threads. If it is the same situation, update the existing thread instead. Never duplicate.

thread_updates
- Existing threads (by "T<id>") that this session moved forward ("progressed") or closed for good ("resolved").
- note: one sentence on what happened. new_summary: rewritten summary if the old one is now out of date, otherwise "".

new_entities
- Every named character, place, item or faction that matters and is not already an entity. type "pc" for player characters, "npc" for everyone else.
- aliases: other names used for them in the recap (including spelling variants), otherwise [].
- description: one short line.

thread_links
- Clear connections between threads, using "T<id>" or "N<n>": same cause, one explains the other, or one could resolve the other. note: a few words.

${ENTITY_RULES}

${PROPERTY_RULES}

${MOMENT_RULES}

Use only what the recap says; do not invent facts. Lists of unanswered questions in the recap are strong signals for threads.`;

const ENRICH_SYSTEM = `You maintain the records of the characters, places, items and factions in a tabletop RPG campaign, so the game master's assistant never contradicts established facts (a dead NPC acting, someone appearing where they can't be).

Read the session recaps (oldest first) and propose entity details as they stand at the end of the latest session. Later sessions override earlier ones.

new_entities
- Places, characters, items or factions that the notes name and that matter, but which are not yet entities (e.g. a district or building used as a location). type "pc" for player characters, "npc" for everyone else. aliases: other names used, otherwise []. description: one short line.

${ENTITY_RULES}

${PROPERTY_RULES}

${MOMENT_RULES}

Use only what the recaps say; do not invent facts.`;

async function campaignState(campaignId: number) {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const threads = await db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.campaignId, campaignId), inArray(schema.threads.status, ["open", "progressing"])));
  return { entities, threads };
}

export interface RecapOptions {
  // "live": one moment at the table, extracted as it happens (smaller, in the background).
  live?: boolean;
  // Wrap-up: what the live log already put in the loom, so these notes don't add it twice.
  alreadyRecorded?: string;
}

export async function proposeRecapChanges(campaignId: number, recap: string, model?: string, opts: RecapOptions = {}) {
  const { entities, threads } = await campaignState(campaignId);

  void entities; // listed, with their fields, by entityStateText
  const threadLines = threads.map((t) => `- T${t.id} [${t.status}] (${t.kind}) ${t.title}: ${t.summary}`);

  const heading = opts.live
    ? "WHAT JUST HAPPENED AT THE TABLE (one moment of the session in progress: what the players did, and what the GM decided happened)"
    : "NEW SESSION RECAP";
  const already = opts.alreadyRecorded?.trim()
    ? `\nALREADY RECORDED THIS SESSION (logged at the table and already in the records above; don't propose it again)\n${opts.alreadyRecorded}\n`
    : "";
  const liveNote = opts.live
    ? "\nThis is a single moment, so expect few changes: often one thread progressed or one new thread, a detail or two. Don't propose key moments unless something truly memorable happened.\n"
    : "";
  const prompt = `${await entityStateText(campaignId)}

EXISTING OPEN THREADS
${threadLines.join("\n") || "(none yet)"}
${already}${liveNote}
${heading}
${recap}`;

  const [res, props] = await Promise.all([
    callLlm({
      feature: opts.live ? "live" : "recap",
      campaignId,
      system: SYSTEM,
      prompt,
      schema: ProposalSchema,
      maxTokens: opts.live ? 6000 : 16000,
      effort: opts.live ? "low" : "medium",
      model,
    }),
    // A single moment at the table leaves these to the table nudges; a failed call loses only these.
    opts.live ? null : proposeProperties(campaignId, { notes: recap }).catch(() => null),
  ]);
  const data: Proposal = { ...res.data, sub_properties: props?.data.sub_properties ?? [], pair_weights: props?.data.pair_weights ?? [] };
  return { ...res, data, costUsd: res.costUsd + (props?.costUsd ?? 0) };
}

// Reads every stored recap for the campaign and proposes entity details (no thread changes).
export async function proposeEnrichment(campaignId: number, model?: string) {
  const sessions = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .orderBy(schema.sessions.number);
  const withRecaps = sessions.filter((s) => s.recap.trim());
  if (withRecaps.length === 0) throw new Error("No stored session recaps to read.");

  const prompt = `${await entityStateText(campaignId)}

SESSION RECAPS (oldest first)
${withRecaps.map((s) => `=== Session ${s.number} ===\n${s.recap}`).join("\n\n")}`;

  const res = await callLlm({ feature: "enrich", campaignId, system: ENRICH_SYSTEM, prompt, schema: EnrichSchema, maxTokens: 32000, effort: "medium", model });
  const latest = withRecaps.at(-1)!.number;
  return { ...res, data: withDefaults(res.data), sessionNumber: latest };
}

const BASES = ["stated", "implied"] as const;
// One call for the property model's values, used two ways: the inference pass over every recap,
// and alongside each recap's own extraction (in parallel: the recap's answer format is at the
// API's size limit, and a separate small one can enforce its lists).
const propertySystem = (scope: "all" | "session") => `You help the game master's assistant understand the non-player characters of a tabletop RPG campaign: what each is like underneath, how hard they push for what they want, and how they stand toward the others. The assistant uses these to work out who might resist, waver, betray or help (a cruel NPC who is charmed may fight it; one whose goals hurt others but who is fond of the party may be torn).

${scope === "all" ? "Read the session recaps (oldest first) and the records, and propose values as they stand at the end of the latest session." : "Read the new session's notes against the records, and propose only what these notes show: new values, or values the notes show have changed (states especially: as of the end of the session)."} Propose values for non-player characters only. Players decide their own characters, so never propose values for a player character, and never how a player character feels about someone.

${PROPERTY_RULES}

Go through the non-player characters ${scope === "all" ? "one at a time" : "these notes involve"}, and for each one:
- each of their recorded goals: its intent and its commitment, if the notes show them;
- the dispositions the notes show (usually 1-4 per character who matters);
- their states at the end of the ${scope === "all" ? "latest session" : "session"}, if the notes show them;
- each relationship from them: the weights it shows (warmth, trust, fear, respect, debt, loyalty).
basis: "stated" when the notes say it outright ("Tomas swore to protect Darius"); "implied" when you judge it from what they did (several acts, or one clearly telling one).
Evidence is a short quote copied word for word from the ${scope === "all" ? "recaps" : "notes"} (never from the records, never a paraphrase). Skip anything the records already show unless the notes change it. ${scope === "all" ? "A minor character with a line or two in the notes usually gets nothing. " : "Many sessions show nothing of this kind; then return empty lists. "}Blanks are better than guesses.`;

/**
 * The property model's values from notes (docs/design-2026-10-26-property-model.md §10): goal
 * intent and commitment, dispositions, states and pair weights, for NPCs only. `notes` given: one
 * session's notes (alongside its recap extraction). Not given: every stored recap (the inference
 * pass, a file of kind "infer", applied as "inferred", blanks only).
 */
export async function proposeProperties(campaignId: number, opts: { notes?: string; model?: string } = {}) {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(schema.sessions.number);
  const withRecaps = sessions.filter((s) => s.recap.trim());
  const scope = opts.notes != null ? "session" : "all";
  if (scope === "all" && withRecaps.length === 0) throw new Error("No stored session recaps to read.");
  const prompt = `${await entityStateText(campaignId)}

${scope === "all" ? `SESSION RECAPS (oldest first)\n${withRecaps.map((s) => `=== Session ${s.number} ===\n${s.recap}`).join("\n\n")}` : `NEW SESSION NOTES\n${opts.notes}`}`;
  // Who it may name, as enforced lists: NPCs for values, any character or faction for "to",
  // and each NPC's recorded goals.
  const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const npcs = ents.filter((e) => e.type === "npc").map((e) => e.name);
  const others = ents.filter((e) => ["npc", "pc", "faction"].includes(e.type)).map((e) => e.name);
  const goals = ents.filter((e) => e.type === "npc").flatMap((e) => (e.traits.goals ?? []).map((g) => g.text));
  const sessionNumber = withRecaps.at(-1)?.number ?? 0;
  if (!npcs.length) return { data: withDefaults({}), dropped: 0, sessionNumber, model: "", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const PropertySchema = z.object({
    sub_properties: z.array(SubChangeSchema.extend({ name: z.enum(npcs as [string, ...string[]]), key: z.enum(SUB_KEYS), goal: z.enum(["", ...goals] as [string, ...string[]]), basis: z.enum(BASES) })),
    pair_weights: z.array(WeightChangeSchema.extend({ from: z.enum(npcs as [string, ...string[]]), to: z.enum(others as [string, ...string[]]), weight: z.enum(PAIR_WEIGHTS), basis: z.enum(BASES) })),
  });
  const res = await callLlm({ feature: scope === "all" ? "infer" : "properties", campaignId, system: propertySystem(scope), prompt, schema: PropertySchema, maxTokens: 16000, effort: "medium", model: opts.model });
  // Player characters are the players' own: anything about them is dropped in code too.
  const pcs = new Set(ents.filter((e) => e.type === "pc").flatMap((e) => [e.name, ...e.aliases].map(norm)));
  const data = withDefaults({
    // An intent or commitment belongs to a goal; without one there's nothing to attach it to.
    sub_properties: res.data.sub_properties.filter((c) => !pcs.has(norm(c.name)) && (c.goal.trim() || (c.key !== "intent" && c.key !== "commitment"))),
    pair_weights: res.data.pair_weights.filter((w) => !pcs.has(norm(w.from))),
  });
  const dropped = res.data.sub_properties.length + res.data.pair_weights.length - data.sub_properties.length - data.pair_weights.length;
  return { ...res, data, dropped, sessionNumber };
}

// Flat, numbered view of a proposal so the DM can accept or skip individual items.
export type ProposalItem =
  | { n: number; kind: "entity"; item: Proposal["new_entities"][number] }
  | { n: number; kind: "thread"; item: Proposal["new_threads"][number] }
  | { n: number; kind: "update"; item: Proposal["thread_updates"][number] }
  | { n: number; kind: "link"; item: Proposal["thread_links"][number] }
  | { n: number; kind: "entity_update"; item: EntityUpdate }
  | { n: number; kind: "relation"; item: RelationChange }
  | { n: number; kind: "party"; item: string }
  | { n: number; kind: "moment"; item: MomentSuggestion }
  | { n: number; kind: "sub"; item: SubChange }
  | { n: number; kind: "weight"; item: WeightChange };

export function numberItems(raw: Partial<Proposal>): ProposalItem[] {
  const p = withDefaults(raw);
  let n = 0;
  return [
    ...p.new_entities.map((item) => ({ n: ++n, kind: "entity" as const, item })),
    ...p.new_threads.map((item) => ({ n: ++n, kind: "thread" as const, item })),
    ...p.thread_updates.map((item) => ({ n: ++n, kind: "update" as const, item })),
    ...p.thread_links.map((item) => ({ n: ++n, kind: "link" as const, item })),
    ...p.entity_updates.map((item) => ({ n: ++n, kind: "entity_update" as const, item })),
    ...p.relations.map((item) => ({ n: ++n, kind: "relation" as const, item })),
    ...(p.party_location.trim() ? [{ n: ++n, kind: "party" as const, item: p.party_location }] : []),
    ...p.key_moments.map((item) => ({ n: ++n, kind: "moment" as const, item })),
    ...p.sub_properties.map((item) => ({ n: ++n, kind: "sub" as const, item })),
    ...p.pair_weights.map((item) => ({ n: ++n, kind: "weight" as const, item })),
  ];
}

const norm = (s: string) => s.trim().toLowerCase();

// Writes the accepted items in one transaction. Returns warnings for anything that couldn't be applied.
// `batch` groups everything this apply writes, so `undo --batch` can reverse it in one go.
// `confirmed`: items the GM explicitly said yes to; they're applied as the GM's own entries, so
// they can change values the GM recorded earlier.
export async function applyProposal(file: ProposalFile, skip: Set<number> = new Set(), batch = newBatch(file), confirmed: Set<number> = new Set()) {
  const { campaignId, sessionNumber, recap } = file;
  const items = numberItems(file.proposal).filter((i) => !skip.has(i.n));
  const warnings: string[] = [];
  const counts = { entities: 0, threads: 0, updates: 0, links: 0 };
  let sessionId: number | null = null;
  let threadByRef = new Map<string, number>();
  const created: { id: number; name: string }[] = [];
  const logs: Parameters<typeof logChanges>[0] = [];

  await db.transaction(async (tx) => {
    // Session row: reuse if this session was already recorded, otherwise create it.
    let [session] = await tx
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.number, sessionNumber)));
    if (session) {
      if (!file.kind || file.kind === "recap") await tx.update(schema.sessions).set({ recap }).where(eq(schema.sessions.id, session.id));
    } else {
      // A session started at the table gets its notes at wrap-up, not from the first moment.
      [session] = await tx.insert(schema.sessions).values({ campaignId, number: sessionNumber, recap: file.kind === "live" ? "" : recap }).returning();
    }
    sessionId = session.id;

    const existingEntities = await tx.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    const entityByName = new Map<string, number>();
    for (const e of existingEntities) for (const name of [e.name, ...e.aliases]) entityByName.set(norm(name), e.id);

    for (const { item } of items.filter((i) => i.kind === "entity") as Extract<ProposalItem, { kind: "entity" }>[]) {
      if (entityByName.has(norm(item.name))) continue;
      const { evidence: _evidence, ...fields } = item;
      void _evidence;
      const [e] = await tx.insert(schema.entities).values({ campaignId, ...fields }).returning();
      created.push({ id: e.id, name: e.name });
      for (const name of [e.name, ...e.aliases]) entityByName.set(norm(name), e.id);
      counts.entities++;
    }

    // Resolve "T12" / "N3" references to real thread ids.
    const existingThreads = await tx.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
    const threadIds = new Set(existingThreads.map((t) => t.id));
    threadByRef = new Map<string, number>();
    const resolve = (ref: string) => {
      const m = ref.trim().match(/^T(\d+)$/i);
      if (m && threadIds.has(Number(m[1]))) return Number(m[1]);
      return threadByRef.get(ref.trim().toUpperCase());
    };

    for (const { item } of items.filter((i) => i.kind === "thread") as Extract<ProposalItem, { kind: "thread" }>[]) {
      const [t] = await tx
        .insert(schema.threads)
        .values({
          campaignId,
          title: item.title,
          kind: item.kind,
          summary: item.summary,
          firstSeenSessionId: session.id,
          lastTouchedSessionId: session.id,
        })
        .returning();
      threadByRef.set(item.ref.trim().toUpperCase(), t.id);
      await tx.insert(schema.threadEvents).values({ threadId: t.id, sessionId: session.id, change: "new" });
      logs.push({ campaignId, sessionId: session.id, subject: t.title, threadId: t.id, kind: "thread-created", after: { threadId: t.id }, source: "extracted", batch });
      counts.threads++;

      const entityIds = new Set<number>();
      for (const name of item.entities) {
        const id = entityByName.get(norm(name));
        if (id) entityIds.add(id);
        else warnings.push(`"${item.title}": no entity named "${name}", not linked`);
      }
      if (entityIds.size) {
        await tx.insert(schema.threadEntities).values([...entityIds].map((entityId) => ({ threadId: t.id, entityId })));
      }
    }

    for (const { item } of items.filter((i) => i.kind === "update") as Extract<ProposalItem, { kind: "update" }>[]) {
      const threadId = resolve(item.thread);
      if (!threadId) {
        warnings.push(`Update to unknown thread ${item.thread} skipped`);
        continue;
      }
      const [before] = await tx.select().from(schema.threads).where(eq(schema.threads.id, threadId));
      const next = {
        status: item.change === "resolved" ? ("resolved" as const) : ("progressing" as const),
        lastTouchedSessionId: session.id,
        ...(item.new_summary.trim() ? { summary: item.new_summary } : {}),
      };
      await tx.update(schema.threads).set(next).where(eq(schema.threads.id, threadId));
      const [ev] = await tx.insert(schema.threadEvents).values({ threadId, sessionId: session.id, change: item.change, note: item.note }).returning();
      logs.push({
        campaignId,
        sessionId: session.id,
        subject: before.title,
        threadId,
        kind: "thread-updated",
        field: item.change,
        before: { status: before.status, summary: before.summary, lastTouchedSessionId: before.lastTouchedSessionId },
        after: { ...next, eventId: ev.id },
        source: "extracted",
        batch,
      });
      counts.updates++;
    }

    for (const { item } of items.filter((i) => i.kind === "link") as Extract<ProposalItem, { kind: "link" }>[]) {
      const from = resolve(item.from);
      const to = resolve(item.to);
      if (!from || !to || from === to) {
        warnings.push(`Link ${item.from} → ${item.to} skipped (thread not found or skipped)`);
        continue;
      }
      const inserted = await tx.insert(schema.threadLinks).values({ fromThreadId: from, toThreadId: to, note: item.note }).onConflictDoNothing().returning();
      if (inserted.length) logs.push({ campaignId, sessionId: session.id, subject: `${item.from} → ${item.to}`, threadId: from, kind: "link-added", after: { from, to }, source: "extracted", batch });
      counts.links++;
    }
  });

  await logChanges([
    ...created.map((e) => ({ campaignId, sessionId, subject: e.name, entityId: e.id, kind: "created" as const, source: "extracted" as const, batch })),
    ...logs,
  ]);

  // Entity details go through the provenance rules (never overwriting the DM), outside the
  // transaction because those writes use their own queries.
  const of = <K extends ProposalItem["kind"]>(k: K, dm?: boolean) =>
    items.filter((i) => i.kind === k && (dm === undefined || confirmed.has(i.n) === dm)).map((i) => i.item as Extract<ProposalItem, { kind: K }>["item"]);
  const entityResult: EntityApplyResult = await applyEntityChanges(campaignId, sessionId, {
    entity_updates: of("entity_update", false),
    relations: of("relation", false),
    party_location: of("party", false)[0] ?? null,
  }, batch);
  const confirmedResult = await applyEntityChanges(campaignId, sessionId, {
    entity_updates: of("entity_update", true),
    relations: of("relation", true),
    party_location: of("party", true)[0] ?? null,
  }, batch, "dm");
  entityResult.updated += confirmedResult.updated;
  entityResult.relations += confirmedResult.relations;
  entityResult.party ||= confirmedResult.party;
  entityResult.warnings.push(...confirmedResult.warnings);
  entityResult.conflicts.push(...confirmedResult.conflicts);
  warnings.push(...entityResult.warnings);

  // The property model's values: unconfirmed ones as extracted; a yes as the DM's own; the
  // inference pass as "inferred", and only into blanks.
  const infer = file.kind === "infer";
  for (const dm of [false, true]) {
    const r = await applyPropertyChanges(campaignId, sessionId, { subs: of("sub", dm), weights: of("weight", dm) }, batch, dm ? "dm" : infer ? "inferred" : "extracted", infer && !dm);
    entityResult.updated += r.written;
    warnings.push(...r.warnings);
  }

  // Suggested key moments: saved as ☆ suggestions for the DM to star or dismiss.
  const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const sess = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const known = new Set((await db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId))).map((t) => t.id));
  let moments = 0;
  for (const m of of("moment")) {
    const entityIds = m.entities.map((n) => ents.find((e) => [e.name, ...e.aliases].some((a) => a.toLowerCase() === n.trim().toLowerCase()))?.id).filter((id): id is number => id != null);
    const threadIds = m.threads
      .map((ref) => {
        const t = ref.trim().match(/^T(\d+)$/i);
        return t && known.has(Number(t[1])) ? Number(t[1]) : threadByRef.get(ref.trim().toUpperCase());
      })
      .filter((id): id is number => id != null);
    // A recap is one session; only a backfill spans several.
    const sid = file.kind === "enrich" ? (sess.find((x) => x.number === m.session)?.id ?? sessionId) : sessionId;
    const row = await addMoment(campaignId, { title: m.title, description: m.description, tone: m.tone, callback: m.callback, entityIds, threadIds, sessionId: sid }, "extracted", "suggested");
    await logChanges([{ campaignId, sessionId: sid, subject: m.title, kind: "moment-added", after: { momentId: row.id }, source: "extracted", batch }]);
    moments++;
  }

  // What these changes start or end between characters (conflicted, devoted…), in the same batch.
  await recordInterplayChanges(campaignId, batch).catch(() => {});
  return { counts, warnings, entityResult, moments, batch };
}

// A readable batch label: what it was, plus a short unique suffix.
export function newBatch(file: Pick<ProposalFile, "kind" | "sessionNumber">) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${file.kind === "enrich" || file.kind === "infer" ? file.kind : `recap s${file.sessionNumber}`} ${when} #${Math.random().toString(36).slice(2, 6)}`;
}
