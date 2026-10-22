// Loom command-line tool for the Phase 1 spike. Run with: npm run loom -- <command>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { costSummary } from "@/core/costs";
import { db, initDb, schema } from "@/core/db/client";
import { improv } from "@/core/improv";
import { callLlm } from "@/core/llm";
import { applyProposal, numberItems, proposeRecapChanges, type ProposalFile } from "@/core/recap";
import { seedFixture } from "@/core/seed";
import { listThreads } from "@/core/threads";

const USAGE = `Usage: npm run loom -- <command>

  seed                       Load the hand-written potion fixture campaign (replaces it if present)
  new-campaign "<name>"      Create an empty campaign
  campaigns                  List campaigns
  threads [id]               List threads for a campaign (default: most recent campaign)
  recap <file> [--session N] [--campaign id] [--model name]
                             Read a session recap and propose thread changes for you to approve
  apply <proposal.json>      Apply a (hand-edited) proposal file saved by "recap"
  improv "<what happened>" [--campaign id] [--why] [--all] [--model name]
                             2-3 options tied to existing threads. --why shows which threads were
                             retrieved and why; --all sends every open thread instead (for comparison)

  --model takes haiku, sonnet, opus, fable or a full model id.
  Defaults: recap = opus, improv = sonnet, everything else = haiku.
  ping                       Make one small LLM call to check the API key and logging
  costs                      Show LLM calls, latency and cost so far`;

const usd = (n: number | null) => `$${(n ?? 0).toFixed(5)}`;

function flag(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function printProposal(file: ProposalFile) {
  // Show titles, not bare "T12" / "N3" references.
  const existing = await db
    .select({ id: schema.threads.id, title: schema.threads.title })
    .from(schema.threads)
    .where(eq(schema.threads.campaignId, file.campaignId));
  const refTitles = new Map([
    ...existing.map((t) => [`T${t.id}`, t.title] as const),
    ...file.proposal.new_threads.map((t) => [t.ref.toUpperCase(), t.title] as const),
  ]);
  const label = (ref: string) => refTitles.get(ref.trim().toUpperCase()) ?? ref;
  let section = "";
  const heading = (s: string) => {
    if (s !== section) console.log(`\n${(section = s)}`);
  };
  for (const i of numberItems(file.proposal)) {
    const n = `[${i.n}]`.padStart(5);
    if (i.kind === "entity") {
      heading("NEW ENTITIES");
      const aka = i.item.aliases.length ? ` aka ${i.item.aliases.join(", ")}` : "";
      console.log(`${n} ${i.item.name} (${i.item.type})${aka}: ${i.item.description}`);
    } else if (i.kind === "thread") {
      heading("NEW THREADS");
      console.log(`${n} ${i.item.ref} (${i.item.kind}) ${i.item.title}`);
      console.log(`        ${i.item.summary}`);
      if (i.item.entities.length) console.log(`        ↳ ${i.item.entities.join(", ")}`);
    } else if (i.kind === "update") {
      heading("THREAD UPDATES");
      console.log(`${n} ${i.item.change.toUpperCase()}: ${label(i.item.thread)}`);
      console.log(`        ${i.item.note}`);
    } else {
      heading("LINKS");
      console.log(`${n} ${label(i.item.from)} → ${label(i.item.to)} (${i.item.note})`);
    }
  }
}

async function reviewAndApply(file: ProposalFile, path: string) {
  await printProposal(file);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(
      `\nApply? [a] all · [n] none · or numbers to SKIP, e.g. "3, 7, 12"\n(To edit wording, answer n, edit ${path}, then run: npm run loom -- apply ${path})\n> `,
    )
  ).trim();
  rl.close();
  if (answer === "" || answer.toLowerCase() === "n") return console.log("Nothing applied.");

  const skip = new Set(answer.toLowerCase() === "a" ? [] : (answer.match(/\d+/g) ?? []).map(Number));
  const { counts, warnings } = await applyProposal(file, skip);
  console.log(
    `\nApplied: ${counts.entities} entities, ${counts.threads} new threads, ${counts.updates} updates, ${counts.links} links.`,
  );
  for (const w of warnings) console.log(`  ! ${w}`);
}

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
    case "new-campaign": {
      if (!args[0]) return console.log('Give it a name, e.g. npm run loom -- new-campaign "Darkness in Duradan"');
      const [c] = await db.insert(schema.campaigns).values({ name: args[0] }).returning();
      console.log(`Created campaign ${c.id}: ${c.name}`);
      break;
    }
    case "recap": {
      const path = args[0];
      if (!path || path.startsWith("--")) return console.log(USAGE);
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      if (!campaignId) return console.log('No campaigns yet. Try: npm run loom -- new-campaign "My campaign"');

      let sessionNumber = Number(flag(args, "session"));
      if (!sessionNumber) {
        const [row] = await db
          .select({ n: max(schema.sessions.number) })
          .from(schema.sessions)
          .where(eq(schema.sessions.campaignId, campaignId));
        sessionNumber = (row?.n ?? 0) + 1;
      }

      const recap = readFileSync(path, "utf8");
      console.log(`Reading session ${sessionNumber} recap for campaign ${campaignId}…`);
      const res = await proposeRecapChanges(campaignId, recap, flag(args, "model"));
      console.log(`(${res.latencyMs} ms · ${res.inputTokens} in / ${res.outputTokens} out · ${usd(res.costUsd)})`);

      const file: ProposalFile = { campaignId, sessionNumber, recap, proposal: res.data };
      mkdirSync("data/proposals", { recursive: true });
      const out = `data/proposals/c${campaignId}-s${sessionNumber}.json`;
      writeFileSync(out, JSON.stringify(file, null, 2));
      await reviewAndApply(file, out);
      break;
    }
    case "improv": {
      const moment = args[0];
      if (!moment || moment.startsWith("--")) return console.log(USAGE);
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      const r = await improv(campaignId, moment, args.includes("--all") ? "all" : "ranked", flag(args, "model"));

      if (args.includes("--why")) {
        console.log("\nThreads considered:");
        for (const t of r.threads) console.log(`  ${t.score.toFixed(1).padStart(5)}  T${t.id} ${t.title}  (${t.reasons.join("; ") || "recency"})`);
      }
      console.log("");
      r.options.forEach((o, i) => {
        const ties = [o.thread_id, ...o.also_ties_to].map((id) => r.titleOf.get(id)).join(" + ");
        console.log(`${i + 1}. ${o.label.toUpperCase()}   ⟵ ${ties}`);
        console.log(`   ${o.option}`);
        console.log(`   why: ${o.why}\n`);
      });
      if (r.dropped) console.log(`(${r.dropped} option(s) dropped: cited a thread that wasn't provided)`);
      const l = r.llm;
      console.log(
        `${l.model} · ${(l.latencyMs / 1000).toFixed(1)} s · ${l.inputTokens} in / ${l.outputTokens} out · ${usd(l.costUsd)} · ${r.threads.length} threads sent`,
      );
      break;
    }
    case "apply": {
      if (!args[0]) return console.log(USAGE);
      const file = JSON.parse(readFileSync(args[0], "utf8")) as ProposalFile;
      await reviewAndApply(file, args[0]);
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
