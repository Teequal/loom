import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { callLlm } from "./llm";
import { loadThreadContexts, type ThreadContext } from "./retrieval";
import { BUDGETS, distancesFrom } from "./graph";
import { listMoments, momentLine } from "./moments";
import { tableSeats, tableText } from "./players";
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
  callbacks: z.array(z.object({ moment_id: z.number(), thread_ids: z.array(z.number()), idea: z.string() })),
});
export type Suggestions = z.infer<typeof SuggestionsSchema>;

const SYSTEM = `You are Loom, helping a game master prepare between sessions. Your job is to find payoffs in threads already on the table, not to invent new plots.

Produce three things:

1. collisions (3): two or more open threads that pay each other off. A collision is where one thread's problem is another thread's solution, or where two threads' consequences meet in a single scene. Look especially at:
   - conditions on different player characters (one character's affliction may hold the key to another's),
   - items or mysteries whose purpose is unknown, set against conditions or debts,
   - NPC promises, grudges and bounties that could arrive at the same moment.
   The best collisions resolve or transform every thread involved and make the players need each other. thread_ids lists every thread used (at least two). title: 3-6 words. idea: 2-3 sentences the GM can prepare from. why: one line.
2. per_player: one idea for each player character, built on the threads attached to them, so every player gets a moment next session. pc is the character's exact name. THE TABLE says who has been quiet and what their players enjoy: give the quietest characters the strongest hooks, lean toward what their players enjoy, and never mention players.
3. neglected (up to 3): threads marked as quiet; suggest a small way to bring each back into play.
4. callbacks (2-3, only if KEY MOMENTS are listed): bring a key moment back. Someone remembers it, a consequence finally lands, or the moment echoes in a new form. moment_id is its number (M12 → 12); thread_ids the threads it ties into. Callbacks land best when they connect to where the story is now.

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
  // Context by distance from the whole party and where they are, three links out.
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const distances = await distancesFrom(campaignId, [...pcs.map((p) => p.id), ...(camp?.partyLocationId ? [camp.partyLocationId] : [])], BUDGETS.suggest.depth);
  const scene = await buildScene(campaignId, {
    mentioned: new Set(),
    distances,
    budget: BUDGETS.suggest,
    threadEntities: threads.flatMap((t) => t.entities),
    storyConditions: new Map(pcs.map((p) => [p.name, threads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)])),
  });

  // Key moments the DM flagged: what callbacks draw on (most recent first, capped).
  const moments = (await listMoments(campaignId, ["key"])).slice(-15);

  const seats = await tableSeats(campaignId);
  const table = tableText(seats);

  const prompt = `${scene.text}
${table ? `\n${table}\n` : ""}
OPEN THREADS (latest session: ${latestSession})
${threads.map((t) => threadLine(t, typeOf, latestSession)).join("\n\n")}
${moments.length ? `\nKEY MOMENTS (flagged by the GM)\n${moments.map(momentLine).join("\n")}` : ""}${camp?.direction.trim() ? `\n\nWHERE THE GM WANTS THE STORY TO GO (steer the ideas toward this)\n${camp.direction.trim()}` : ""}`;

  const res = await callLlm({ feature: "suggest", campaignId, system: SYSTEM, prompt, schema: SuggestionsSchema, maxTokens: 16000, effort: "medium", model });

  // Keep only suggestions that point at real threads; a collision needs two different ones.
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const known = (ids: number[]) => [...new Set(ids)].filter((id) => titleOf.has(id));
  const pcNames = new Set(pcs.map((p) => p.name.toLowerCase()));
  const data: Suggestions = {
    collisions: res.data.collisions.map((c) => ({ ...c, thread_ids: known(c.thread_ids) })).filter((c) => c.thread_ids.length >= 2),
    per_player: res.data.per_player
      .map((p) => ({ ...p, thread_ids: known(p.thread_ids) }))
      .filter((p) => pcNames.has(p.pc.toLowerCase()))
      // Quietest first: the spotlight goes where it's been missing.
      .sort((a, b) => (seats.find((x) => x.pc.name === b.pc)?.quietFor ?? 0) - (seats.find((x) => x.pc.name === a.pc)?.quietFor ?? 0)),
    neglected: res.data.neglected.filter((n) => titleOf.has(n.thread_id)),
    callbacks: res.data.callbacks
      .filter((c) => moments.some((m) => m.id === c.moment_id))
      .map((c) => ({ ...c, thread_ids: known(c.thread_ids) })),
  };
  const dropped =
    res.data.collisions.length + res.data.per_player.length + res.data.neglected.length + res.data.callbacks.length -
    (data.collisions.length + data.per_player.length + data.neglected.length + data.callbacks.length);

  return { data, dropped, titleOf, moments, seats, llm: res };
}
