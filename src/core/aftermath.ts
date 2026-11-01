import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import type { Encounter } from "./encounter";
import { rate } from "./encounter-math";
import { callLlm } from "./llm";
import { planSlips } from "./plan-agency";
import { loadThreadContexts } from "./retrieval";
import { buildScene } from "./scene";

// After a fight: the XP in code, exact, and what's left on the field, tied to threads in play so
// the win feeds the story instead of leaving a pile of coins.

const SYSTEM = `A tabletop RPG fight has just ended. Give the game master what's left behind, built from what's already in the campaign:
- loot: 1 to 3 finds. Mostly plain treasure that fits who was fought; at least one should tie to an open thread (give its id in thread, otherwise 0).
- clue: one thing on the field that points at an open thread.
- consequence: one thing that follows from how it ended, for the world or an NPC.
Each is one short sentence. Never say what player characters do, think or feel: describe what's there and what the world does. Don't reveal GM secrets outright.`;

const Schema = z.object({
  loot: z.array(z.object({ what: z.string(), thread: z.number().int() })),
  clue: z.string(),
  consequence: z.string(),
});

export const xpShare = (e: Pick<Encounter, "foes" | "levels" | "edition">) => {
  const total = rate(e.foes, e.levels, e.edition).xp;
  return { total, each: Math.floor(total / Math.max(1, e.levels.length)) };
};

export async function aftermath(entryId: number) {
  const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!e?.encounter) throw new Error("That fight isn't in the log any more.");
  const fight = e.encounter as Encounter;
  const [result] = (await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.parentId, entryId))).filter((x) => x.choiceKind === "result").slice(-1);
  const threads = (await loadThreadContexts(e.campaignId)).filter((t) => t.status !== "resolved");
  const scene = await buildScene(e.campaignId, { mentioned: new Set(fight.foes.map((f) => f.name)), threadEntities: threads.flatMap((t) => t.entities), moment: e.choice });
  const prompt = `${scene.text}

OPEN THREADS
${threads.slice(0, 15).map((t) => `${t.id}: ${t.title}`).join("\n")}

THE FIGHT
${e.choice}
Enemies: ${fight.foes.map((f) => `${f.count} × ${f.name}`).join(", ")}
How it ended: ${result?.choice ?? "the party came through it"}`;
  const res = await callLlm({ feature: "aftermath", campaignId: e.campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 1000 });
  const fine = (t: string) => !!t.trim() && !planSlips(t, scene.pcs).length;
  const title = new Map(threads.map((t) => [t.id, t.title]));
  return {
    loot: res.data.loot.filter((l) => fine(l.what)).slice(0, 3).map((l) => ({ what: l.what, thread: title.has(l.thread) ? { id: l.thread, title: title.get(l.thread)! } : null })),
    clue: fine(res.data.clue) ? res.data.clue : "",
    consequence: fine(res.data.consequence) ? res.data.consequence : "",
  };
}
