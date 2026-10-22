// Loom command-line tool for the Phase 1 spike. Run with: npm run loom -- <command>
import { desc } from "drizzle-orm";
import { z } from "zod";
import { costSummary } from "@/core/costs";
import { db, initDb, schema } from "@/core/db/client";
import { callLlm } from "@/core/llm";
import { seedFixture } from "@/core/seed";
import { listThreads } from "@/core/threads";

const USAGE = `Usage: npm run loom -- <command>

  seed              Load the hand-written potion fixture campaign (replaces it if present)
  campaigns         List campaigns
  threads [id]      List threads for a campaign (default: most recent campaign)
  ping              Make one small LLM call to check the API key and logging
  costs             Show LLM calls, latency and cost so far`;

const usd = (n: number | null) => `$${(n ?? 0).toFixed(5)}`;

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
    case "ping": {
      const id = await latestCampaignId();
      const titles = id ? (await listThreads(id)).map((t) => `- ${t.title}`).join("\n") : "- (no threads)";
      const res = await callLlm({
        feature: "ping",
        system: "You help a tabletop RPG game master. Be brief.",
        prompt: `Open threads in this campaign:\n${titles}\n\nSum up the campaign's current situation in one sentence.`,
        schema: z.object({ summary: z.string() }),
        maxTokens: 1000,
      });
      console.log(res.data.summary);
      console.log(`\n${res.model} · ${res.latencyMs} ms · ${res.inputTokens} in / ${res.outputTokens} out · ${usd(res.costUsd)}`);
      break;
    }
    case "costs": {
      const { byFeature, recent } = await costSummary();
      if (byFeature.length === 0) return console.log("No LLM calls yet. Try: npm run loom -- ping");
      console.log("By feature:");
      for (const f of byFeature) {
        console.log(
          `  ${f.feature.padEnd(10)} ${String(f.calls).padStart(4)} calls (${f.failed} failed) · avg ${f.avgLatencyMs ?? "-"} ms · ${f.inputTokens} in / ${f.outputTokens} out · ${usd(f.costUsd)}`,
        );
      }
      const total = byFeature.reduce((sum, f) => sum + (f.costUsd ?? 0), 0);
      console.log(`  ${"TOTAL".padEnd(10)} ${usd(total)}\n\nRecent calls:`);
      for (const r of recent) {
        const status = r.ok ? `${r.latencyMs} ms · ${usd(r.costUsd)}` : `FAILED: ${r.error}`;
        console.log(`  #${r.id} ${r.createdAt} ${r.feature} (${r.model}) ${status}`);
      }
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  if (!process.env.ANTHROPIC_API_KEY) console.error("Hint: copy .env.example to .env and add your ANTHROPIC_API_KEY.");
  if (process.env.LOOM_DEBUG) console.error(err);
  process.exit(1);
});
