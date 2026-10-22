import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { callLlm } from "./llm";
import { loadThreadContexts, retrieveThreads, type ThreadContext } from "./retrieval";

const OptionsSchema = z.object({
  options: z.array(
    z.object({
      thread_id: z.number(),
      also_ties_to: z.array(z.number()),
      label: z.string(),
      option: z.string(),
      why: z.string(),
    }),
  ),
});
export type ImprovOption = z.infer<typeof OptionsSchema>["options"][number];

const SYSTEM = `You are Loom, a game master's assistant used live at the table. The players just did something unexpected. Offer 2-3 short, playable options that tie the moment back to threads already in the campaign, instead of inventing new material.

Rules:
- Every option builds on one of the listed threads: put its number in thread_id. Prefer options that pay off, complicate or collide existing threads. Only add a number to also_ties_to if the option genuinely uses that thread too; one strong tie beats three loose ones.
- Get the facts right: who did what to whom must match the thread text exactly.
- Match the energy of the moment: comedic stays comedic, tense stays tense.
- option: what the GM does or says right now. At most 2 sentences, concrete, ready to use. No stat blocks, no long narration.
- why: one line, under 15 words, saying why this fits now. The thread's title is shown to the GM separately, so don't repeat it, and never use thread numbers.
- label: 2-5 words.
- Make the options genuinely different from each other.
- Threads marked as GM secrets are unknown to players: let them show through consequences, never state them outright.
- Use only the facts listed. Small table-level details (a sound, a line of dialogue) are fine; new plots, factions or major NPCs are not.`;

function threadBlock(t: ThreadContext, titleOf: Map<number, string>) {
  const lines = [`T${t.id} [${t.kind}${t.status === "progressing" ? ", in progress" : ""}] ${t.title}`, `  ${t.summary}`];
  if (t.latestNote) lines.push(`  Latest: ${t.latestNote}`);
  if (t.entities.length) lines.push(`  Involves: ${t.entities.join(", ")}`);
  const links = t.links.filter((l) => titleOf.has(l.threadId));
  if (links.length) lines.push(`  Linked: ${links.map((l) => `T${l.threadId} (${l.note})`).join("; ")}`);
  return lines.join("\n");
}

// mode "ranked" sends the top retrieved threads; "all" sends every open thread (baseline for comparison).
export async function improv(campaignId: number, moment: string, mode: "ranked" | "all" = "ranked", model?: string) {
  const threads =
    mode === "all"
      ? (await loadThreadContexts(campaignId)).map((t) => ({ ...t, score: 0, reasons: [] as string[] }))
      : await retrieveThreads(campaignId, moment);
  if (threads.length === 0) throw new Error("This campaign has no open threads yet.");

  const pcs = await db
    .select({ name: schema.entities.name })
    .from(schema.entities)
    .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.type, "pc")));

  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const prompt = `PLAYER CHARACTERS: ${pcs.map((p) => p.name).join(", ") || "(unknown)"}

OPEN THREADS
${threads.map((t) => threadBlock(t, titleOf)).join("\n\n")}

WHAT JUST HAPPENED AT THE TABLE
${moment}`;

  const res = await callLlm({ feature: "improv", system: SYSTEM, prompt, schema: OptionsSchema, maxTokens: 4000, effort: "low", model });

  // Enforce the core promise: every option must tie back to a thread we actually gave it.
  const valid = res.data.options.filter((o) => titleOf.has(o.thread_id)).slice(0, 3);
  const dropped = res.data.options.length - res.data.options.filter((o) => titleOf.has(o.thread_id)).length;
  const options = valid.map((o) => ({ ...o, also_ties_to: o.also_ties_to.filter((id) => titleOf.has(id) && id !== o.thread_id) }));

  return { options, dropped, threads, titleOf, llm: res };
}
