import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { callLlm } from "./llm";
import { findMentions, loadThreadContexts } from "./retrieval";
import { planSlips, withoutSlips } from "./plan-agency";
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
  new_thread: z.object({ title: z.string(), summary: z.string() }).nullable(),
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
- The GM controls the world and NPCs; the players control their characters. Set up situations; never decide what player characters choose, say, feel or do. Never write the party or a PC doing something as fact ("The party drags Darius into the cellar"). Write what the world offers, and what follows if they choose it: "If the party hides in Tomas's cellar, the crowd turns back to the festival…", "The cellar is open to them".
- Dead characters stay dead; someone elsewhere has to travel or send word.
- Refer to threads by name in the text, never by number.
- new_thread: only at REACH "the arc", and only if it earns its place: one genuinely new thread this could open (title, one-line summary). Otherwise null.`;

type DevelopInput = { moment: string; label: string; text: string; threadIds: number[]; reach: number; tone?: number };
export type Pick = { part: "open" | "setup" | "lead"; headline: string };

// Everything a plan is written from: the scene, the threads, the direction, the session so far,
// and the choice being developed.
async function developContext(campaignId: number, input: DevelopInput) {
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
  return { prompt, pcs, threads, reach };
}

const IdeasSchema = z.object({
  ideas: z.array(z.object({ part: z.enum(["open", "setup", "lead"]), headline: z.string(), flavour: z.string() })),
});

// Develop, step one: a handful of headlines to choose from (cheap and quick). The GM picks up to
// three, and only those get written out in full.
export async function developIdeas(campaignId: number, input: DevelopInput) {
  const { prompt, pcs } = await developContext(campaignId, input);
  const res = await callLlm({
    feature: "develop-ideas",
    campaignId,
    system: `${SYSTEM}

For now, don't write the plan. Offer 9 headlines in three sections, so the GM can mix and match one from each: 3 openings (part "open": how the next scene could begin), 3 setups (part "setup": what to prepare or what's in play), and 3 directions (part "lead": where it could go). The three in each section should differ in feel, so any combination works. Each headline is under 12 words, concrete and distinct. flavour is one word for its feel (tense, funny, eerie, tragic, mysterious, warm, brutal…). Write openings and directions as what the world does or offers, never as what the party does.`,
    prompt,
    schema: IdeasSchema,
    maxTokens: 1500,
    effort: "low",
  });
  const party = pcs.map((p) => ({ name: p.name, aliases: p.aliases }));
  return {
    ideas: res.data.ideas.filter((i) => i.headline.trim() && !planSlips(i.headline, party).length).slice(0, 9),
    llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd },
  };
}

// Reworks one piece of a plan the way the GM asks ("darker", "shorter", "more for Iresia"),
// keeping its facts and its ties.
export async function reworkPiece(campaignId: number, input: { text: string; how: string; context: string }) {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const pcs = entities.filter((e) => e.type === "pc").map((p) => ({ name: p.name, aliases: p.aliases }));
  const res = await callLlm({
    feature: "rework",
    campaignId,
    system: `You rework one piece of a game master's prep, exactly as they ask, and nothing else. Keep the same facts, names and threads; change only what they asked (tone, length, focus). Never decide what player characters do: write what the world offers, or "if the party…". Return only the reworked text.`,
    prompt: `WHAT IT'S PART OF\n${input.context}\n\nTHE PIECE\n${input.text}\n\nHOW TO REWORK IT\n${input.how}`,
    schema: z.object({ text: z.string() }),
    maxTokens: 800,
    effort: "low",
  });
  return { text: withoutSlips(res.data.text, pcs) || input.text, llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd } };
}

export async function develop(campaignId: number, input: DevelopInput & { picks?: Pick[] }, model?: string) {
  const ctx = await developContext(campaignId, input);
  const { pcs, threads, reach } = ctx;
  // Step two: only what the GM picked, written out in full.
  const picks = input.picks ?? [];
  const prompt = picks.length
    ? `${ctx.prompt}

BUILD ONLY FROM THE GM'S PICKS, in this order, and nothing else:
${picks.map((p) => `- ${p.part === "open" ? "Opening" : p.part === "setup" ? "Setup" : "Direction"}: ${p.headline}`).join("\n")}
An "Opening" pick becomes the intro (otherwise intro is ""). Each "Setup" pick becomes one setup, each "Direction" pick one direction, titled after it.`
    : ctx.prompt;

  let res = await callLlm({ feature: "develop", campaignId, system: SYSTEM, prompt, schema: DevelopSchema, maxTokens: 6000, effort: "low", model });
  // Prose can't be scaffolded, so it's read: a line where the party or a PC acts goes back once
  // to be rewritten as a condition, and anything still deciding for the players is dropped.
  const party = pcs.map((p) => ({ name: p.name, aliases: p.aliases }));
  const slipsIn = (d: z.infer<typeof DevelopSchema>) => [d.intro, ...d.setups.map((x) => x.text), ...d.directions.map((x) => x.text)].flatMap((t) => planSlips(t, party));
  const first = slipsIn(res.data);
  if (first.length) {
    const fix = `${prompt}

REWRITE NEEDED: these lines decide what the player characters do. Rewrite them as what the world offers, or as a condition ("If the party…"), and keep everything else:
${first.map((l) => `- ${l}`).join("\n")}`;
    try {
      const again = await callLlm({ feature: "develop", campaignId, system: SYSTEM, prompt: fix, schema: DevelopSchema, maxTokens: 6000, effort: "low", model });
      if (slipsIn(again.data).length < first.length) res = { ...again, latencyMs: res.latencyMs + again.latencyMs, costUsd: res.costUsd + again.costUsd };
    } catch {
      // keep the first answer; its slips are dropped below
    }
  }
  const clean = (t: string) => withoutSlips(t, party);
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const titles = (ids: number[]) => [...new Set(ids)].filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! }));
  return {
    reach: REACH[reach],
    intro: clean(res.data.intro),
    setups: res.data.setups.map((s) => ({ title: s.title, text: clean(s.text), threads: titles(s.thread_ids) })).filter((s) => s.text),
    directions: res.data.directions.map((d) => ({ title: d.title, text: clean(d.text), threads: titles(d.thread_ids) })).filter((d) => d.text),
    newThread: reach === 3 ? res.data.new_thread : null,
    llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd },
  };
}
