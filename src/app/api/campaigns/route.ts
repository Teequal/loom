import { desc } from "drizzle-orm";
import { z } from "zod";
import { connection } from "next/server";
import { db, schema } from "@/core/db/client";
import { dbReady } from "@/server/db";
import { jsonRoute } from "@/server/route";

export async function GET() {
  await connection();
  await dbReady();
  const campaigns = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).orderBy(desc(schema.campaigns.id));
  return Response.json({ campaigns });
}

// A new, empty campaign: the first session's notes fill it in.
export const POST = jsonRoute(z.object({ name: z.string().trim().min(1, "Give the campaign a name.").max(120) }), async ({ name }) => {
  const [c] = await db.insert(schema.campaigns).values({ name }).returning();
  return { campaign: { id: c.id, name: c.name } };
});
