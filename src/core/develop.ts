import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { callLlm } from "./llm";
import { findMentions, loadThreadContexts } from "./retrieval";
import { buildScene } from "./scene";

// Develop: the GM picked an option and wants to plan ahead from it. A scene intro to read aloud,
// setups to prepare, and where it could lead, projected as far as the GM asks: the next few
// minutes, this scene, next session, or the arc. Not live, so it runs on the strongest model.

export const REACH = ["Next few minutes", "This scene", "Next session", "The arc"] as const;
const REACH_TEXT = [
  "REACH: the next few minutes. The intro opens the moment; setups are what could complicate it right away; directions are immediate consequences.",
  "REACH: this scene. The intro opens the scene; setups are 2-3 beats or complications to run in it; directions are how the scene could end.",
  "REACH: the next session. The intro opens the next session's first scene that follows from this; setups are scenes or encounters to prepare; directions are session-sized developments.",
  "REACH: the arc. The intro is a short framing of where this leads; setups are the larger pieces to put in place over several sessions; directions are long-term plot developments, each paying off threads.",
];

const DevelopSchema = z.object({
  intro: z.string(),
  setups: z.array(z.object({ title: z.string(), text: z.string(), thread_ids: z.array(z.number()) })),
  directions: z.array(z.object({ title: z.string(), text: z.string(), thread_ids: z.array(z.number()) })),
});

const SYSTEM = `You are Loom, helping a game master plan ahead from a choice they just made at the table. Build only on what is already in the campaign: the threads, characters and what happened this session. Your job is payoffs and connections, not new plots.

Write:
- intro: 2-4 sentences the GM can read aloud to the players. Describe the world and the NPCs; end on something the players can react to. Never say what the player characters do, think or feel.
- setups (2-3): things to prepare. title 2-5 words; text 1-3 sentences; thread_ids the threads each one uses.
- directions (2-3): where this could lead. Each pays off or moves at least one open thread. title 2-5 words; text 1-3 sentences; thread_ids the threads it uses.

Rules:
- Follow REACH for how far ahead to plan, and TONE for how dramatic to be.
- Steer toward where the GM wants the story to go, when they've said.
- Use only the facts listed. You may propose hidden connections, but never contradict what the threads say. GM secrets shape what happens but are never stated outright.
- The GM controls the world and NPCs; the players control their characters. Set up situations; never decide what player characters choose, say or feel.
- Dead characters stay dead; someone elsewhere has to travel or send word.
- Refer to threads by name in the text, never by number.`;

export async function develop(
  campaignId: number,
  input: { moment: string; label: string; text: string; threadIds: number[]; reach: number; tone?: number },
  model?: string,
) {
  const threads = await loadThreadContexts(campaignId);
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const pcs = entities.filter((e) => e.type === "pc");
  const named = findMentions(entities, `${input.moment} ${input.text}`);
  const seeds = [...entities.filter((e) => named.has(e.name)).map((e) => e.id), ...pcs.map((p) => p.id), ...(camp?.partyLocationId ? [camp.partyLocationId] : [])];
  const scene = await buildScene(campaignId, {
    mentioned: new Set(named.keys()),
    distances: await distancesFrom(campaignId, seeds, BUDGETS.suggest.depth),
    budget: BUDGETS.suggest,
    threadEntities: threads.filter((t) => input.threadIds.includes(t.id)).flatMap((t) => t.entities),
    storyConditions: new Map(pcs.map((p) => [p.name, threads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)])),
  });

  const tied = threads.filter((t) => input.threadIds.includes(t.id));
  const others = threads.filter((t) => !input.threadIds.includes(t.id));
  const soFar = await sessionSoFar(campaignId);
  const reach = Math.max(0, Math.min(3, input.reach));
  const tone = ["grounded and plausible", "restrained", "balanced", "dramatic", "big and theatrical"][Math.max(0, Math.min(4, input.tone ?? 1))];

  const prompt = `${scene.text}

THE THREADS THIS CHOICE TIES TO
${tied.map((t) => `T${t.id} [${t.kind}] ${t.title}: ${t.summary}${t.latestNote ? `\n  Latest: ${t.latestNote}` : ""}${t.entities.length ? `\n  Involves: ${t.entities.join(", ")}` : ""}`).join("\n") || "(none)"}

OTHER OPEN THREADS
${others.map((t) => `T${t.id} [${t.kind}] ${t.title}: ${t.summary}`).join("\n")}
${camp?.direction.trim() ? `\nWHERE THE GM WANTS THE STORY TO GO\n${camp.direction.trim()}\n` : ""}${soFar ? `\nTHIS SESSION SO FAR\n${soFar}\n` : ""}
WHAT THE PLAYERS DID
${input.moment}

WHAT THE GM CHOSE TO HAPPEN (${input.label})
${input.text}

${REACH_TEXT[reach]}
TONE: ${tone}.`;

  const res = await callLlm({ feature: "develop", campaignId, system: SYSTEM, prompt, schema: DevelopSchema, maxTokens: 6000, effort: "low", model });
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const titles = (ids: number[]) => [...new Set(ids)].filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! }));
  return {
    reach: REACH[reach],
    intro: res.data.intro,
    setups: res.data.setups.map((s) => ({ title: s.title, text: s.text, threads: titles(s.thread_ids) })),
    directions: res.data.directions.map((d) => ({ title: d.title, text: d.text, threads: titles(d.thread_ids) })),
    llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd },
  };
}
