import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { FIXTURE_NAME, SAMPLE_NAME, seedFixture } from "@/core/seed";
import { NEEDS_INVITE, whoIs } from "@/server/access";
import { dbReady } from "@/server/db";

// The sample campaign (the potion swap), for trying Loom before you have notes of your own.
// Opens the existing one if it's there; never resets it. An invited tester gets their own copy.
export async function POST(request: Request) {
  await dbReady();
  const who = await whoIs(request);
  if (!who) return NEEDS_INVITE();
  const tester = who.kind === "tester" ? who.testerId : null;
  const [existing] = await db
    .select()
    .from(schema.campaigns)
    .where(tester == null ? and(eq(schema.campaigns.name, FIXTURE_NAME), isNull(schema.campaigns.testerId)) : and(eq(schema.campaigns.name, SAMPLE_NAME), eq(schema.campaigns.testerId, tester)));
  const c = existing ?? (await seedFixture(tester));
  return Response.json({ campaign: { id: c.id, name: c.name } });
}
