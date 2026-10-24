import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { DIFFICULTIES, type Edition, fit, rate, thresholds } from "./encounter-math";
import type { EntityTraits } from "./entity-fields";
import { BUDGETS, distancesFrom } from "./graph";
import { sessionSoFar } from "./live";
import { callLlm } from "./llm";
import { findMentions, loadThreadContexts } from "./retrieval";
import { buildScene } from "./scene";

// Setting up a fight from a choice at the table: who the party faces (drawn from who's in play),
// compact stats, and a suggested difficulty with one line of why. The model picks the enemies and
// the step; code does the XP maths and fits the numbers to the chosen step.

export interface EncounterFoe {
  name: string;
  count: number;
  cr: string;
  ac: number;
  hp: number;
  attacks: string;
  save_dc: number | null;
  trick: string;
  srd: boolean; // a stock SRD creature (or close to one)
}
export interface Encounter {
  edition: Edition;
  levels: number[];
  recommended: number; // the step Loom suggests
  why: string;
  band: number; // the step chosen (starts at the suggestion)
  foes: EncounterFoe[];
  terrain: string;
  twist: string;
}

const Schema = z.object({
  recommended: z.number().int(),
  why: z.string(),
  foes: z.array(
    z.object({
      name: z.string(),
      count: z.number().int(),
      cr: z.string(),
      ac: z.number().int(),
      hp: z.number().int(),
      attacks: z.string(),
      save_dc: z.number().int().nullable(),
      trick: z.string(),
      srd: z.boolean(),
    }),
  ),
  terrain: z.string(),
  twist: z.string(),
});

const SYSTEM = `You set up a D&D 5e fight for a game master, from a choice they just made at the table.

- Enemies come from who is actually in play: the factions, NPCs and creatures in the scene and threads (the Red Hand's bandits, not random goblins). Use a stock SRD creature when one fits (bandit, thug, veteran, scout, cultist, wolf…) and say so with srd; otherwise give sensible custom stats at a fitting CR. cr is a 5e challenge rating as text ("1/8", "1/2", "3").
- Stats are compact: ac, hp (average), attacks in one short line ("Scimitar +3, 1d6+1"), save_dc if they force saves, and trick: one thing that makes them interesting to run (a tactic, a weakness, a tie to a thread).
- recommended: the difficulty step to suggest, as an index into DIFFICULTY STEPS. Go lower when the party is hurt (bloodied, critical), out of resources, or this is a side skirmish; higher when it pays off a major thread or the GM wants it to matter. Follow the tone. why: one short line for the GM.
- terrain: one line on where it happens and what's useful there. twist: one complication that ties to a thread (reinforcements, a hostage, the floor giving way).
- Counts will be adjusted by code to fit the step; aim roughly right.
- Never decide what player characters do.`;

export async function setupEncounter(entryId: number) {
  const [entry] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!entry) throw new Error("That moment isn't in the log any more.");
  const campaignId = entry.campaignId;
  const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const pcs = entities.filter((e) => e.type === "pc" && e.status !== "dead");
  const levelOf = (e: (typeof pcs)[number]) => Number(String((e.traits as EntityTraits).level ?? "").match(/\d+/)?.[0] ?? NaN);
  const missing = pcs.filter((p) => !(levelOf(p) >= 1));
  if (missing.length) return { needLevels: missing.map((p) => ({ id: p.id, name: p.name })) };
  const levels = pcs.map(levelOf);
  const edition: Edition = (camp?.ruleToggles as Record<string, string>)?.edition === "2024" ? "2024" : "2014";
  const steps = DIFFICULTIES[edition];

  const text = `${entry.moment}\n${entry.choice}`;
  const named = findMentions(entities, text);
  const threads = await loadThreadContexts(campaignId);
  const scene = await buildScene(campaignId, {
    mentioned: new Set(named.keys()),
    distances: await distancesFrom(campaignId, entities.filter((e) => named.has(e.name)).map((e) => e.id), BUDGETS.improv.depth),
    budget: BUDGETS.improv,
    threadEntities: threads.filter((t) => t.entities.some((n) => named.has(n))).flatMap((t) => t.entities),
  });
  const soFar = await sessionSoFar(campaignId);
  const prompt = `${scene.text}

THE PARTY: ${pcs.map((p) => `${p.name} (level ${levelOf(p)}${(p.traits as EntityTraits).health ? `, ${(p.traits as EntityTraits).health}` : ""})`).join("; ")}
DIFFICULTY STEPS (${edition} rules): ${steps.map((s, i) => `${i} ${s}`).join(", ")}
XP BUDGET FOR THIS PARTY: ${thresholds(levels, edition).map((v, i) => `${steps[i]} from ${v} XP`).join(", ")}${edition === "2014" ? ". Total enemy XP is multiplied by how many enemies there are: 1 ×1, 2 ×1.5, 3-6 ×2, 7-10 ×2.5 (one step higher for a party under 3, one lower for 6+)" : ""}.
XP BY CR: 1/8 25, 1/4 50, 1/2 100, 1 200, 2 450, 3 700, 4 1100, 5 1800, 6 2300, 7 2900, 8 3900. Pick CRs that can land in the suggested step; a single strong enemy can be too much for a small party.
${camp?.tone ? `TONE: ${camp.tone}\n` : ""}${camp?.direction.trim() ? `WHERE THE GM WANTS THE STORY TO GO: ${camp.direction.trim()}\n` : ""}${soFar ? `\nTHIS SESSION SO FAR\n${soFar}\n` : ""}
THE CHOICE THAT STARTS THE FIGHT
${text}`;

  const res = await callLlm({ feature: "encounter", campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 3000, effort: "low", fast: true });
  const recommended = Math.max(0, Math.min(steps.length - 1, res.data.recommended));
  const foes = res.data.foes.filter((f) => f.count > 0).slice(0, 5);
  const fitted = fit(foes, levels, edition, recommended);
  const encounter: Encounter = {
    edition,
    levels,
    recommended,
    why: res.data.why,
    band: recommended,
    foes: fitted.map((f) => ({ ...foes.find((x) => x.name === f.name)!, count: f.count })),
    terrain: res.data.terrain,
    twist: res.data.twist,
  };
  await saveEncounter(entryId, encounter);
  return { encounter, rating: rate(encounter.foes, levels, edition), llm: { model: res.model, seconds: res.latencyMs / 1000, costUsd: res.costUsd } };
}

export async function saveEncounter(entryId: number, encounter: Encounter) {
  // A fight that's been set up waits for its result.
  await db.update(schema.liveEntries).set({ encounter, awaiting: "fight", resultState: "pending" }).where(eq(schema.liveEntries.id, entryId));
}
