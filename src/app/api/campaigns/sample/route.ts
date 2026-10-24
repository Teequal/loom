import { eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { FIXTURE_NAME, seedFixture } from "@/core/seed";
import { dbReady } from "@/server/db";

// The sample campaign (the potion swap), for trying Loom before you have notes of your own.
// Opens the existing one if it's there; never resets it.
export async function POST() {
  await dbReady();
  const [existing] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.name, FIXTURE_NAME));
  const c = existing ?? (await seedFixture());
  return Response.json({ campaign: { id: c.id, name: c.name } });
}
