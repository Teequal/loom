import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { ENTITY_TYPES, THREAD_KINDS } from "./db/schema";
import { callLlm } from "./llm";

// What the model proposes after reading a recap. Existing threads are referred to as "T<id>",
// new threads as "N<n>", entities by exact name. Nothing is stored until the DM approves.
export const ProposalSchema = z.object({
  new_entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(ENTITY_TYPES),
      aliases: z.array(z.string()),
      description: z.string(),
    }),
  ),
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
});
export type Proposal = z.infer<typeof ProposalSchema>;

// A proposal plus what's needed to apply it later (possibly after the DM edits the file).
export interface ProposalFile {
  campaignId: number;
  sessionNumber: number;
  recap: string;
  proposal: Proposal;
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

Use only what the recap says; do not invent facts. Lists of unanswered questions in the recap are strong signals for threads.`;

async function campaignState(campaignId: number) {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const threads = await db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.campaignId, campaignId), inArray(schema.threads.status, ["open", "progressing"])));
  return { entities, threads };
}

export async function proposeRecapChanges(campaignId: number, recap: string) {
  const { entities, threads } = await campaignState(campaignId);

  const entityLines = entities.map(
    (e) => `- ${e.name} (${e.type})${e.aliases.length ? ` aka ${e.aliases.join(", ")}` : ""}: ${e.description}`,
  );
  const threadLines = threads.map((t) => `- T${t.id} [${t.status}] (${t.kind}) ${t.title}: ${t.summary}`);

  const prompt = `EXISTING ENTITIES
${entityLines.join("\n") || "(none yet)"}

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
  });
}

// Flat, numbered view of a proposal so the DM can accept or skip individual items.
export type ProposalItem =
  | { n: number; kind: "entity"; item: Proposal["new_entities"][number] }
  | { n: number; kind: "thread"; item: Proposal["new_threads"][number] }
  | { n: number; kind: "update"; item: Proposal["thread_updates"][number] }
  | { n: number; kind: "link"; item: Proposal["thread_links"][number] };

export function numberItems(p: Proposal): ProposalItem[] {
  let n = 0;
  return [
    ...p.new_entities.map((item) => ({ n: ++n, kind: "entity" as const, item })),
    ...p.new_threads.map((item) => ({ n: ++n, kind: "thread" as const, item })),
    ...p.thread_updates.map((item) => ({ n: ++n, kind: "update" as const, item })),
    ...p.thread_links.map((item) => ({ n: ++n, kind: "link" as const, item })),
  ];
}

const norm = (s: string) => s.trim().toLowerCase();

// Writes the accepted items in one transaction. Returns warnings for anything that couldn't be applied.
export async function applyProposal(file: ProposalFile, skip: Set<number> = new Set()) {
  const { campaignId, sessionNumber, recap } = file;
  const items = numberItems(file.proposal).filter((i) => !skip.has(i.n));
  const warnings: string[] = [];
  const counts = { entities: 0, threads: 0, updates: 0, links: 0 };

  await db.transaction(async (tx) => {
    // Session row: reuse if this session was already recorded, otherwise create it.
    let [session] = await tx
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.number, sessionNumber)));
    if (session) {
      await tx.update(schema.sessions).set({ recap }).where(eq(schema.sessions.id, session.id));
    } else {
      [session] = await tx.insert(schema.sessions).values({ campaignId, number: sessionNumber, recap }).returning();
    }

    const existingEntities = await tx.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    const entityByName = new Map<string, number>();
    for (const e of existingEntities) for (const name of [e.name, ...e.aliases]) entityByName.set(norm(name), e.id);

    for (const { item } of items.filter((i) => i.kind === "entity") as Extract<ProposalItem, { kind: "entity" }>[]) {
      if (entityByName.has(norm(item.name))) continue;
      const [e] = await tx.insert(schema.entities).values({ campaignId, ...item }).returning();
      for (const name of [e.name, ...e.aliases]) entityByName.set(norm(name), e.id);
      counts.entities++;
    }

    // Resolve "T12" / "N3" references to real thread ids.
    const existingThreads = await tx.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
    const threadIds = new Set(existingThreads.map((t) => t.id));
    const threadByRef = new Map<string, number>();
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

  return { counts, warnings };
}
