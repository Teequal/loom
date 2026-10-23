import { desc } from "drizzle-orm";
import { connection } from "next/server";
import { db, schema } from "@/core/db/client";
import { dbReady } from "@/server/db";

export async function GET() {
  await connection();
  await dbReady();
  const campaigns = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).orderBy(desc(schema.campaigns.id));
  return Response.json({ campaigns });
}
