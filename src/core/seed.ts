import { eq } from "drizzle-orm";
import { db, schema } from "./db/client";

export const FIXTURE_NAME = "Fixture: The Potion Swap";

// A small hand-written campaign built around the canonical example from CLAUDE.md.
// The DM's real fix (give each player the other's cure) is deliberately NOT stored:
// Loom should be able to find it from these threads.
export async function seedFixture() {
  // Reuse the fixture's id so reseeding doesn't make it the "most recent" campaign.
  const [old] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.name, FIXTURE_NAME));
  await db.delete(schema.campaigns).where(eq(schema.campaigns.name, FIXTURE_NAME));

  const [campaign] = await db.insert(schema.campaigns).values({ id: old?.id, name: FIXTURE_NAME }).returning();
  const campaignId = campaign.id;

  const [s1, s2] = await db
    .insert(schema.sessions)
    .values([
      { campaignId, number: 1, recap: "The party buys unlabelled potions from Mother Ysolde before setting out for Thornbridge." },
      { campaignId, number: 2, recap: "Bram and Kira drink the potions. Bram now believes he cannot die; Kira cannot speak." },
    ])
    .returning();

  const ent = await db
    .insert(schema.entities)
    .values([
      { campaignId, name: "Bram", type: "pc", aliases: ["the immortal guy"], description: "Reckless fighter. Played by Sam." },
      { campaignId, name: "Kira", type: "pc", aliases: [], description: "Sharp-tongued rogue, used to doing the talking. Played by Alex." },
      { campaignId, name: "Mother Ysolde", type: "npc", aliases: ["the alchemist", "Ysolde"], description: "Cheerful, shifty alchemist in Thornbridge market." },
      { campaignId, name: "Thornbridge", type: "location", aliases: [], description: "River town held hostage by bandits at the bridge." },
      { campaignId, name: "The Red Hand", type: "faction", aliases: ["the bandits"], description: "Bandits controlling the bridge toll." },
    ])
    .returning();
  const e = Object.fromEntries(ent.map((x) => [x.name, x.id]));

  const thr = await db
    .insert(schema.threads)
    .values([
      {
        campaignId,
        title: "Bram believes he cannot die",
        kind: "condition",
        summary: "After drinking one of Ysolde's potions, Bram is convinced he is immortal. He isn't. He charges into every danger.",
        firstSeenSessionId: s2.id,
        lastTouchedSessionId: s2.id,
      },
      {
        campaignId,
        title: "Kira cannot speak",
        kind: "condition",
        summary: "Another of Ysolde's potions took Kira's voice. She communicates by gesture and scribbled notes.",
        firstSeenSessionId: s2.id,
        lastTouchedSessionId: s2.id,
      },
      {
        campaignId,
        title: "What was really in Ysolde's potions?",
        kind: "mystery",
        summary: "Ysolde sold the party unlabelled potions cheaply. She may know more about their effects, and their cures.",
        payoffIdeas: ["Ysolde admits the potions came in matched pairs"],
        firstSeenSessionId: s1.id,
        lastTouchedSessionId: s2.id,
      },
      {
        campaignId,
        title: "The Red Hand holds the bridge",
        kind: "hook",
        summary: "Bandits charge a ruinous toll at Thornbridge. The town council wants them gone.",
        firstSeenSessionId: s1.id,
        lastTouchedSessionId: s1.id,
      },
    ])
    .returning();
  const t = Object.fromEntries(thr.map((x) => [x.title, x.id]));

  await db.insert(schema.threadEntities).values([
    { threadId: t["Bram believes he cannot die"], entityId: e["Bram"] },
    { threadId: t["Bram believes he cannot die"], entityId: e["Mother Ysolde"] },
    { threadId: t["Kira cannot speak"], entityId: e["Kira"] },
    { threadId: t["Kira cannot speak"], entityId: e["Mother Ysolde"] },
    { threadId: t["What was really in Ysolde's potions?"], entityId: e["Mother Ysolde"] },
    { threadId: t["The Red Hand holds the bridge"], entityId: e["The Red Hand"] },
    { threadId: t["The Red Hand holds the bridge"], entityId: e["Thornbridge"] },
  ]);

  await db.insert(schema.threadLinks).values([
    { fromThreadId: t["Bram believes he cannot die"], toThreadId: t["What was really in Ysolde's potions?"], note: "caused by" },
    { fromThreadId: t["Kira cannot speak"], toThreadId: t["What was really in Ysolde's potions?"], note: "caused by" },
  ]);

  await db.insert(schema.threadEvents).values(
    thr.map((x) => ({ threadId: x.id, sessionId: x.firstSeenSessionId, change: "new" as const })),
  );

  return campaign;
}
