// Loom command-line tool for the Phase 1 spike. Run with: npm run loom -- <command>
import { desc } from "drizzle-orm";
import { db, initDb, schema } from "@/core/db/client";
import { seedFixture } from "@/core/seed";
import { listThreads } from "@/core/threads";

const USAGE = `Usage: npm run loom -- <command>

  seed              Load the hand-written potion fixture campaign (replaces it if present)
  campaigns         List campaigns
  threads [id]      List threads for a campaign (default: most recent campaign)`;

async function latestCampaignId() {
  const [c] = await db.select().from(schema.campaigns).orderBy(desc(schema.campaigns.id)).limit(1);
  return c?.id;
}

async function main() {
  await initDb();
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "seed": {
      const c = await seedFixture();
      console.log(`Seeded campaign ${c.id}: ${c.name}`);
      break;
    }
    case "campaigns": {
      for (const c of await db.select().from(schema.campaigns)) console.log(`${c.id}  ${c.name}`);
      break;
    }
    case "threads": {
      const id = args[0] ? Number(args[0]) : await latestCampaignId();
      if (!id) return console.log("No campaigns yet. Try: npm run loom -- seed");
      const threads = await listThreads(id);
      if (threads.length === 0) return console.log("No threads in this campaign yet.");
      for (const t of threads) {
        console.log(`#${t.id} [${t.status}] (${t.kind}) ${t.title}`);
        if (t.entities.length) console.log(`     ↳ ${t.entities.join(", ")}`);
      }
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
