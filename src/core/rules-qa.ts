import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { callLlm } from "./llm";
import { findMentions } from "./retrieval";
import { buildScene } from "./scene";

// A rules question at the table, answered with the session in mind: who's in the scene and in what
// state, the campaign's rule toggles and house rules, and what just happened. Short, cites the
// rule, and says plainly when something is outside the SRD and worth checking in the book.

const Schema = z.object({
  answer: z.string(),
  rule: z.string(),
  here: z.string(),
  srd: z.boolean(),
  check: z.string(),
});

const SYSTEM = `You answer D&D 5e rules questions for a game master in the middle of a session.

- answer: 1-3 sentences, the ruling itself, plain and direct.
- rule: the rule it comes from, named ("Conditions: Unconscious", "Opportunity Attacks", "Concentration").
- here: one or two sentences applying it to this table right now, by name, using the scene (health, conditions, positions) and the campaign's rule toggles and house rules when they change the answer. Empty if the question isn't about the current scene.
- srd: true if the rule is in the 5e System Reference Document; false for content only in other books.
- check: when you're unsure, or the answer depends on a book outside the SRD or on an edition difference (2014 vs 2024), say what to check in one line; otherwise "".
- Follow the campaign's edition toggle. House rules override the book; say so when one applies.
- Never invent rules. If the rules don't cover it, say it's a GM call and suggest a fair ruling.

Pronouns: use the ones the records give. Where they give none, use the character's name or "they"; never guess from a name.`;

export async function answerRules(campaignId: number, question: string) {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const named = findMentions(entities, question);
  const pcs = entities.filter((e) => e.type === "pc").map((e) => e.id);
  const scene = await buildScene(campaignId, {
    mentioned: new Set(named.keys()),
    distances: await distancesFrom(campaignId, [...entities.filter((e) => named.has(e.name)).map((e) => e.id), ...pcs], 1),
    budget: BUDGETS.improvFocused,
    threadEntities: [],
    moment: question, // "can Darius cast while restrained?": the conditions it states apply
  });
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const toggles = camp?.ruleToggles as Record<string, string> | undefined;
  const soFar = await sessionSoFar(campaignId, 5);
  const prompt = `${scene.text}

RULES EDITION: ${toggles?.edition ?? "2014"}${toggles && Object.keys(toggles).length ? `\nRULE TOGGLES: ${Object.entries(toggles).map(([k, v]) => `${k} ${v}`).join("; ")}` : ""}
${soFar ? `\nWHAT JUST HAPPENED AT THE TABLE\n${soFar}\n` : ""}
THE QUESTION
${question}`;
  const res = await callLlm({ feature: "rules", campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 1500, effort: "low" });
  return { ...res.data, llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd } };
}
