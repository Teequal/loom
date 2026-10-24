import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { THREAD_KINDS } from "./db/schema";
import { logChanges } from "./history";
import { callLlm } from "./llm";
import { loadThreadContexts } from "./retrieval";
import { buildScene } from "./scene";

// New material, on request. Loom's job is usually to tie back to what's there; this is the one
// place it invents: themes, threads, characters and connections that fit the campaign and its
// direction, each one tied to something already in play, and each one a thread you can add.

const Schema = z.object({
  ideas: z.array(
    z.object({
      kind: z.enum(["theme", "thread", "character", "connection"]),
      title: z.string(),
      pitch: z.string(),
      ties_to: z.array(z.number()),
      thread: z.object({ title: z.string(), kind: z.enum(THREAD_KINDS), summary: z.string(), entities: z.array(z.string()) }),
    }),
  ),
});

const SYSTEM = `You help a game master freshen a campaign with new material that still belongs in it.

Offer 5 ideas, a mix of kinds:
- theme: a new undercurrent the story could explore (betrayal, the cost of power…), shown through concrete hooks.
- thread: a new hook, mystery, promise or grudge.
- character: a new NPC with a want that collides with an existing thread.
- connection: a hidden link between two things already in play that nobody has noticed.

For each: title (3-6 words), pitch (2-3 sentences the GM can use), ties_to (ids of existing threads it touches; at least one), and thread: how it would be recorded (title, kind, summary, entities by exact name, existing or new).
New material must fit the world, tone and direction, and must not contradict established facts. Never decide what player characters do.`;

export async function freshIdeas(campaignId: number) {
  const threads = await loadThreadContexts(campaignId);
  const scene = await buildScene(campaignId, { mentioned: new Set(), threadEntities: threads.flatMap((t) => t.entities) });
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const prompt = `${scene.text}

OPEN THREADS
${threads.map((t) => `T${t.id} [${t.kind}] ${t.title}: ${t.summary}`).join("\n")}
${camp?.direction.trim() ? `\nWHERE THE GM WANTS THE STORY TO GO\n${camp.direction.trim()}\n` : ""}${camp?.tone ? `\nTONE: ${camp.tone}\n` : ""}`;
  const res = await callLlm({ feature: "fresh", campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 5000, effort: "medium" });
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  return {
    ideas: res.data.ideas.map((i) => ({ ...i, ties: i.ties_to.filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! })) })),
    llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd },
  };
}

// Adds a thread by hand (from an idea), as the GM's own: linked to the named characters that
// exist, logged so it can be undone.
export async function addThread(campaignId: number, input: { title: string; kind: (typeof THREAD_KINDS)[number]; summary: string; entities: string[]; linkTo?: number[] }) {
  const [latest] = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)).orderBy(desc(schema.sessions.number)).limit(1);
  const [t] = await db
    .insert(schema.threads)
    .values({ campaignId, title: input.title, kind: input.kind, summary: input.summary, firstSeenSessionId: latest?.id ?? null, lastTouchedSessionId: latest?.id ?? null })
    .returning();
  await db.insert(schema.threadEvents).values({ threadId: t.id, sessionId: latest?.id ?? null, change: "new", note: "added from a fresh idea" });
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const ids = [...new Set(input.entities.map((n) => entities.find((e) => [e.name, ...e.aliases].some((x) => x.toLowerCase() === n.trim().toLowerCase()))?.id).filter((x): x is number => x != null))];
  if (ids.length) await db.insert(schema.threadEntities).values(ids.map((entityId) => ({ threadId: t.id, entityId })));
  for (const other of input.linkTo ?? []) {
    const [exists] = await db.select().from(schema.threads).where(and(eq(schema.threads.id, other), eq(schema.threads.campaignId, campaignId)));
    if (exists) await db.insert(schema.threadLinks).values({ fromThreadId: t.id, toThreadId: other, note: "from a fresh idea" }).onConflictDoNothing();
  }
  await logChanges([{ campaignId, subject: t.title, threadId: t.id, kind: "thread-created", after: { threadId: t.id }, source: "dm", batch: `fresh ${t.id}` }]);
  return t;
}
