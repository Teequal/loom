import { mkdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema";

// Local SQLite file by default. libSQL means the same code can later point at a hosted database.
const url = process.env.LOOM_DB_URL ?? "file:data/loom.db";
if (url.startsWith("file:data/")) mkdirSync("data", { recursive: true });

const client = createClient({ url });

export const db = drizzle(client, { schema });
export { schema };

// Call once at startup: enforces foreign keys and applies any pending migrations.
export async function initDb() {
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: "drizzle" });
}
