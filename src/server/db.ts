import { initDb } from "@/core/db/client";

// Migrations run once per server process, before the first request touches the database.
let ready: Promise<void> | null = null;
export const dbReady = () => (ready ??= initDb());
