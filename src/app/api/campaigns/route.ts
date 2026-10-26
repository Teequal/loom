import { desc } from "drizzle-orm";
import { z } from "zod";
import { connection } from "next/server";
import { currentWho } from "@/core/access";
import { db, schema } from "@/core/db/client";
import { campaignOwner, NEEDS_INVITE, ownerIdFor, whoIs } from "@/server/access";
import { dbReady } from "@/server/db";
import { jsonRoute } from "@/server/route";

// Only the campaigns this person may see: the owner's, or an invited tester's own.
export async function GET(request: Request) {
  await connection();
  await dbReady();
  const who = await whoIs(request);
  if (!who) return NEEDS_INVITE();
  const campaigns = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(campaignOwner(who)).orderBy(desc(schema.campaigns.id));
  return Response.json({ campaigns, tester: who.kind === "tester" ? who.name : null });
}

// A new, empty campaign: the first session's notes fill it in.
export const POST = jsonRoute(z.object({ name: z.string().trim().min(1, "Give the campaign a name.").max(120) }), async ({ name }) => {
  const who = currentWho();
  const [c] = await db
    .insert(schema.campaigns)
    .values({ name, testerId: who ? ownerIdFor(who) : null })
    .returning();
  return { campaign: { id: c.id, name: c.name } };
});
