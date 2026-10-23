import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { callLlm } from "./llm";
import { loadThreadContexts, type ThreadContext } from "./retrieval";
import { buildScene } from "./scene";

// Between-session prep: collisions (open threads that pay each other off), something for each
// player character, and payoffs for threads that have gone quiet. Not latency-sensitive, so
// it sees every open thread and runs on the strongest model by default.

const SuggestionsSchema = z.object({
  collisions: z.array(
    z.object({ thread_ids: z.array(z.number()), title: z.string(), idea: z.string(), why: z.string() }),
  ),
  per_player: z.array(z.object({ pc: z.string(), thread_ids: z.array(z.number()), idea: z.string() })),
  neglected: z.array(z.object({ thread_id: z.number(), idea: z.string() })),
});
export type Suggestions = z.infer<typeof SuggestionsSchema>;

const SYSTEM = `You are Loom, helping a game master prepare between sessions. Your job is to find payoffs in threads already on the table, not to invent new plots.

Produce three things:

1. collisions (3): two or more open threads that pay each other off. A collision is where one thread's problem is another thread's solution, or where two threads' consequences meet in a single scene. Look especially at:
   - conditions on different player characters (one character's affliction may hold the key to another's),
   - items or mysteries whose purpose is unknown, set against conditions or debts,
   - NPC promises, grudges and bounties that could arrive at the same moment.
   The best collisions resolve or transform every thread involved and make the players need each other. thread_ids lists every thread used (at least two). title: 3-6 words. idea: 2-3 sentences the GM can prepare from. why: one line.
2. per_player: one idea for each player character, built on the threads attached to them, so every player gets a moment next session. pc is the character's exact name.
3. neglected (up to 3): threads marked as quiet; suggest a small way to bring each back into play.

Rules:
- Use only the facts listed. You may propose hidden connections (that is the point), but never contradict what the threads say.
- Threads marked as GM secrets are unknown to players: use them to shape what happens, not as things characters learn for free.
- Set up situations; never decide what player characters choose, say or feel.
- Respect continuity from THE SCENE and the cards: dead characters stay dead (they can be remembered, found or avenged), and an NPC elsewhere has to travel, send word or be sought out. Use characters' abilities and the GM's mechanics where they fit. Never include anything on the safety lines.
- Refer to threads by name in the text, never by number.`;

function threadLine(t: ThreadContext, typeOf: Map<string, string>, latestSession: number) {
  const who = t.entities.map((n) => (typeOf.get(n) === "pc" ? `${n} (PC)` : typeOf.get(n) === "npc" ? `${n} (NPC)` : n));
  const quiet = t.lastTouchedSession !== null && latestSession - t.lastTouchedSession >= 2;
  const lines = [
    `T${t.id} [${t.kind}${t.status === "progressing" ? ", in progress" : ""}${quiet ? `, QUIET since session ${t.lastTouchedSession}` : ""}] ${t.title}`,
    `  ${t.summary}`,
  ];
  if (t.latestNote) lines.push(`  Latest: ${t.latestNote}`);
  if (who.length) lines.push(`  Involves: ${who.join(", ")}`);
  if (t.links.length) lines.push(`  Linked: ${t.links.map((l) => `T${l.threadId} (${l.note})`).join("; ")}`);
  return lines.join("\n");
}

export async function suggest(campaignId: number, model?: string) {
  const threads = await loadThreadContexts(campaignId);
  if (threads.length === 0) throw new Error("This campaign has no open threads yet.");
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const typeOf = new Map(entities.map((e) => [e.name, e.type]));
  const pcs = entities.filter((e) => e.type === "pc");
  const latestSession = Math.max(0, ...threads.map((t) => t.lastTouchedSession ?? 0));

  // Same scene block as the improv box: where the party is, who's alive and where, the party
  // with their abilities and story conditions, and cards for the major figures in the threads.
  const scene = await buildScene(campaignId, {
    mentioned: new Set(),
    threadEntities: threads.flatMap((t) => t.entities),
    storyConditions: new Map(pcs.map((p) => [p.name, threads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)])),
  });

  const prompt = `${scene.text}

OPEN THREADS (latest session: ${latestSession})
${threads.map((t) => threadLine(t, typeOf, latestSession)).join("\n\n")}`;

  const res = await callLlm({ feature: "suggest", system: SYSTEM, prompt, schema: SuggestionsSchema, maxTokens: 16000, effort: "medium", model });

  // Keep only suggestions that point at real threads; a collision needs two different ones.
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const known = (ids: number[]) => [...new Set(ids)].filter((id) => titleOf.has(id));
  const pcNames = new Set(pcs.map((p) => p.name.toLowerCase()));
  const data: Suggestions = {
    collisions: res.data.collisions.map((c) => ({ ...c, thread_ids: known(c.thread_ids) })).filter((c) => c.thread_ids.length >= 2),
    per_player: res.data.per_player
      .map((p) => ({ ...p, thread_ids: known(p.thread_ids) }))
      .filter((p) => pcNames.has(p.pc.toLowerCase())),
    neglected: res.data.neglected.filter((n) => titleOf.has(n.thread_id)),
  };
  const dropped =
    res.data.collisions.length + res.data.per_player.length + res.data.neglected.length -
    (data.collisions.length + data.per_player.length + data.neglected.length);

  return { data, dropped, titleOf, llm: res };
}
