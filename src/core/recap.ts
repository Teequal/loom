import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { ENTITY_TYPES, MOMENT_TONES, THREAD_KINDS } from "./db/schema";
import {
  applyEntityChanges,
  ENTITY_RULES,
  EntityChangesShape,
  entityStateText,
  type EntityApplyResult,
  type EntityUpdate,
  type RelationChange,
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
    }),
  ),
  thread_updates: z.array(
    z.object({
      thread: z.string(),
      change: z.enum(["progressed", "resolved"]),
      note: z.string(),
      new_summary: z.string(),
    }),
  ),
  thread_links: z.array(z.object({ from: z.string(), to: z.string(), note: z.string() })),
  key_moments: z.array(MomentSchema),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// Backfill: entity details only, read from recaps already stored.
const EnrichSchema = z.object({ new_entities: z.array(NewEntitySchema), ...EntityChangesShape, key_moments: z.array(MomentSchema) });

// A proposal plus what's needed to apply it later (possibly after the DM edits the file).
// kind "enrich" proposals don't touch the session's stored recap.
export interface ProposalFile {
  kind?: "recap" | "enrich";
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
    key_moments: p.key_moments ?? [],
  };
}

const SYSTEM = `You maintain the thread list for a tabletop RPG campaign, so the game master can tie future moments back to what already happened.

A thread is anything with unspent narrative payoff: an unresolved hook or mission, a mystery, a player character condition (curse, madness, false belief, lasting injury, lost ability), an NPC promise or debt, a grudge, an item whose purpose is unknown, a consequence that hasn't landed yet. Not threads: events that are fully over with nothing lingering, combat blow-by-blow, scenery.

Given the current campaign state and a new session recap, propose changes:

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

${MOMENT_RULES}

Use only what the recap says; do not invent facts. Lists of unanswered questions in the recap are strong signals for threads.`;

const ENRICH_SYSTEM = `You maintain the records of the characters, places, items and factions in a tabletop RPG campaign, so the game master's assistant never contradicts established facts (a dead NPC acting, someone appearing where they can't be).

Read the session recaps (oldest first) and propose entity details as they stand at the end of the latest session. Later sessions override earlier ones.

new_entities
- Places, characters, items or factions that the notes name and that matter, but which are not yet entities (e.g. a district or building used as a location). type "pc" for player characters, "npc" for everyone else. aliases: other names used, otherwise []. description: one short line.

${ENTITY_RULES}

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

export async function proposeRecapChanges(campaignId: number, recap: string, model?: string) {
  const { entities, threads } = await campaignState(campaignId);

  void entities; // listed, with their fields, by entityStateText
  const threadLines = threads.map((t) => `- T${t.id} [${t.status}] (${t.kind}) ${t.title}: ${t.summary}`);

  const prompt = `${await entityStateText(campaignId)}

EXISTING OPEN THREADS
${threadLines.join("\n") || "(none yet)"}

NEW SESSION RECAP
${recap}`;

  return callLlm({
    feature: "recap",
    system: SYSTEM,
    prompt,
    schema: ProposalSchema,
    maxTokens: 16000,
    effort: "medium",
    model,
  });
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

  const res = await callLlm({ feature: "enrich", system: ENRICH_SYSTEM, prompt, schema: EnrichSchema, maxTokens: 32000, effort: "medium", model });
  const latest = withRecaps.at(-1)!.number;
  return { ...res, data: withDefaults(res.data), sessionNumber: latest };
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
  | { n: number; kind: "moment"; item: MomentSuggestion };

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
  ];
}

const norm = (s: string) => s.trim().toLowerCase();

// Writes the accepted items in one transaction. Returns warnings for anything that couldn't be applied.
export async function applyProposal(file: ProposalFile, skip: Set<number> = new Set()) {
  const { campaignId, sessionNumber, recap } = file;
  const items = numberItems(file.proposal).filter((i) => !skip.has(i.n));
  const warnings: string[] = [];
  const counts = { entities: 0, threads: 0, updates: 0, links: 0 };
  let sessionId: number | null = null;
  let threadByRef = new Map<string, number>();
  const created: { id: number; name: string }[] = [];

  await db.transaction(async (tx) => {
    // Session row: reuse if this session was already recorded, otherwise create it.
    let [session] = await tx
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.number, sessionNumber)));
    if (session) {
      if (file.kind !== "enrich") await tx.update(schema.sessions).set({ recap }).where(eq(schema.sessions.id, session.id));
    } else {
      [session] = await tx.insert(schema.sessions).values({ campaignId, number: sessionNumber, recap }).returning();
    }
    sessionId = session.id;

    const existingEntities = await tx.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    const entityByName = new Map<string, number>();
    for (const e of existingEntities) for (const name of [e.name, ...e.aliases]) entityByName.set(norm(name), e.id);

    for (const { item } of items.filter((i) => i.kind === "entity") as Extract<ProposalItem, { kind: "entity" }>[]) {
      if (entityByName.has(norm(item.name))) continue;
      const [e] = await tx.insert(schema.entities).values({ campaignId, ...item }).returning();
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
      await tx
        .update(schema.threads)
        .set({
          status: item.change === "resolved" ? "resolved" : "progressing",
          lastTouchedSessionId: session.id,
          ...(item.new_summary.trim() ? { summary: item.new_summary } : {}),
        })
        .where(eq(schema.threads.id, threadId));
      await tx.insert(schema.threadEvents).values({ threadId, sessionId: session.id, change: item.change, note: item.note });
      counts.updates++;
    }

    for (const { item } of items.filter((i) => i.kind === "link") as Extract<ProposalItem, { kind: "link" }>[]) {
      const from = resolve(item.from);
      const to = resolve(item.to);
      if (!from || !to || from === to) {
        warnings.push(`Link ${item.from} → ${item.to} skipped (thread not found or skipped)`);
        continue;
      }
      await tx.insert(schema.threadLinks).values({ fromThreadId: from, toThreadId: to, note: item.note }).onConflictDoNothing();
      counts.links++;
    }
  });

  await logChanges(
    created.map((e) => ({ campaignId, sessionId, subject: e.name, entityId: e.id, kind: "created" as const, source: "extracted" as const })),
  );

  // Entity details go through the provenance rules (never overwriting the DM), outside the
  // transaction because those writes use their own queries.
  const of = <K extends ProposalItem["kind"]>(k: K) => items.filter((i) => i.kind === k).map((i) => i.item as Extract<ProposalItem, { kind: K }>["item"]);
  const entityResult: EntityApplyResult = await applyEntityChanges(campaignId, sessionId, {
    entity_updates: of("entity_update"),
    relations: of("relation"),
    party_location: of("party")[0] ?? null,
  });
  warnings.push(...entityResult.warnings);

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
    await addMoment(campaignId, { title: m.title, description: m.description, tone: m.tone, callback: m.callback, entityIds, threadIds, sessionId: sid }, "extracted", "suggested");
    moments++;
  }

  return { counts, warnings, entityResult, moments };
}
