import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import { z } from "zod";
import { callLlm } from "./llm";
import { numberItems, applyProposal, proposeRecapChanges } from "./recap";
import { reviewProposal, splitRisky } from "./review";

// A starting point for someone brand new: a small, playable premise invented from scratch (or
// from a theme they give), written as "session 0" notes and read into the loom the usual way, so
// the table has threads, characters and a place from the first moment.

const Schema = z.object({
  title: z.string(),
  opening: z.string(),
  notes: z.string(),
});

const SYSTEM = `You write a small, ready-to-play starting point for a brand-new game master running D&D 5e.

- title: the campaign's name, 2-5 words.
- opening: what the GM reads aloud to begin (3-5 sentences): where the party is, what's happening, and something that demands a response. Never say what the player characters do.
- notes: the premise as a GM's prep notes, plainly written, 150-250 words: the starting place (inside a town or region), 3-4 named NPCs with one line each (what they want), 3 open threads (a hook, a mystery, a promise or debt) that can collide with each other, and the party's player characters by name with a one-line hook each. Use the player characters given; if none are given, invent 3 with simple classes.
- Keep it small, concrete and a little surprising. Nothing grim beyond PG-13.

For player characters, use the pronouns the GM gave (if any); otherwise use their names or "they".`;

export async function startFromHook(campaignId: number, input: { party: string; theme: string }, onStage: (stage: "writing" | "reading" | "weaving", title?: string) => void = () => {}) {
  onStage("writing");
  const res = await callLlm({
    feature: "hook",
    campaignId,
    system: SYSTEM,
    prompt: `PLAYER CHARACTERS: ${input.party.trim() || "(none given: invent 3)"}\nTHEME OR FLAVOUR: ${input.theme.trim() || "(surprise me)"}`,
    schema: Schema,
    maxTokens: 2500,
    effort: "low",
  });
  // The premise becomes session 0, read in like any recap. A brand-new campaign has no entries of
  // the GM's own to protect, so everything proposed is applied.
  const notes = `Before the first session (the hook)\n\n${res.data.notes}\n\nOpening: ${res.data.opening}`;
  // Notes Loom wrote itself are clean, so reading them back doesn't need the strongest model.
  onStage("reading", res.data.title);
  const proposal = await proposeRecapChanges(campaignId, notes, "sonnet");
  onStage("weaving", res.data.title);
  const file = await splitRisky({ campaignId, sessionNumber: 0, recap: notes, proposal: proposal.data });
  const reviewed = await reviewProposal(file);
  const everything = new Set(numberItems(file.proposal).map((i) => i.n));
  const must = new Set(reviewed.filter((r) => r.tier === "must").map((r) => r.item.n));
  const applied = await applyProposal(file, new Set(), undefined, new Set([...everything].filter((n) => must.has(n))));
  // What the world now holds, for the GM to see before they begin.
  const ents = await db.select({ id: schema.entities.id, name: schema.entities.name, type: schema.entities.type }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const threads = await db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
  return {
    title: res.data.title,
    opening: res.data.opening,
    made: { entities: ents, threads },
    counts: applied.counts,
    llm: { seconds: (res.latencyMs + proposal.latencyMs) / 1000, costUsd: res.costUsd + proposal.costUsd },
  };
}
