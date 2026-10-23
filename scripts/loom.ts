// Loom command-line tool for the Phase 1 spike. Run with: npm run loom -- <command>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { costSummary } from "@/core/costs";
import { db, initDb, schema } from "@/core/db/client";
import { flavour } from "@/core/flavour";
import { improv } from "@/core/improv";
import { callLlm } from "@/core/llm";
import { applyProposal, numberItems, proposeEnrichment, proposeRecapChanges, type ProposalFile } from "@/core/recap";
import {
  blindReportMarkdown,
  reportMarkdown,
  runScenarios,
  ScenarioFileSchema,
  scoreBlindReview,
  summarise,
} from "@/core/scenarios";
import { seedFixture } from "@/core/seed";
import { suggest } from "@/core/suggest";
import { listThreads } from "@/core/threads";
import { campaignCommand, entityCommand, relateCommand, threadCommand } from "./entity-cli";
import { momentCommand } from "./moments-cli";
import { ruleCommand } from "./rules-cli";

const USAGE = `Usage: npm run loom -- <command>   (add --campaign <id> to any command; default: most recent)

Campaign data
  seed                       Load the hand-written potion fixture campaign (replaces it if present)
  new-campaign "<name>"      Create an empty campaign
  campaigns                  List campaigns
  threads [id]               List threads for a campaign
  thread set <id> deadline=… stakes=… secret=yes|no
  entity list [--type npc]   List characters, places, items and factions
  entity show "<name>"       Everything known about one entity
  entity new "<name>" <type> [field=value …]
  entity set "<name>" field=value … [--secret field]
                             e.g. entity set Zara status=alive actual="Duradan Clocktower" --secret actual
  relate "<from>" <type> "<to>" [note="…"] [strength=-3…3] [--secret]
  unrelate "<from>" <type> "<to>"
  campaign show | campaign set party=<location> tone=… date=… safety=…
  campaign toggle [<name> <option>]   5e variants that change the story (resting, death, madness…)
  rule list | rule draft "<in your words>" | rule add "<name>" … | rule remove "<name>"
  moment list | moment add "<title>" … | moment from-improv <n> | moment star|dismiss <id>
                             Key moments: the history callbacks draw on
  entity history "<name>"    What changed about it, when, and on whose word
                             House rules and effects: what fires when, and who it applies to

Engine
  recap <file> [--session N] [--campaign id] [--model name]
                             Read a session recap and propose thread changes for you to approve
  apply <proposal.json>      Apply a (hand-edited) proposal file saved by "recap" or "enrich"
  enrich [--campaign id] [--model name]
                             Re-read all stored recaps and propose entity details, relationships
                             and the party's location (for campaigns recorded before these existed)
  improv "<what happened>" [--campaign id] [--why] [--all] [--model name]
                             2-3 options tied to existing threads. --why shows which threads were
                             retrieved and why; --all sends every open thread instead (for comparison)
  flavor <n> [--model name]  Read-aloud version of option n from the last improv (default: opus)

  suggest [--campaign id] [--model name]
                             Between-session prep: thread collisions, an idea per player
                             character, and ways back into quiet threads
  scenarios <file.json> [--models sonnet,opus] [--only id1,id2] [--blind]
                             Run saved moments through the improv box on each model and write a
                             side-by-side report to data/runs/ (default model: sonnet).
                             --blind shuffles all models' options together with models hidden
  score <blind-report.md>    Count your ticks in a blind report per model
  ping                       Make one small LLM call to check the API key and logging
  costs                      Show LLM calls, latency and cost so far

  --model takes haiku, sonnet, opus, fable or a full model id.
  Defaults: recap, suggest, enrich, flavor = opus; improv = sonnet; everything else = haiku.`;

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
    ...(file.proposal.new_threads ?? []).map((t) => [t.ref.toUpperCase(), t.title] as const),
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
    } else if (i.kind === "link") {
      heading("LINKS");
      console.log(`${n} ${label(i.item.from)} → ${label(i.item.to)} (${i.item.note})`);
    } else if (i.kind === "entity_update") {
      heading("ENTITY DETAILS");
      const u = i.item;
      const facts = [
        u.status && `status ${u.status}`,
        u.attitude && `attitude ${u.attitude}`,
        u.importance && `importance ${u.importance}`,
        u.last_known_location && `last seen at ${u.last_known_location}`,
        u.parent_location && `inside ${u.parent_location}`,
        ...u.traits.filter((t) => t.value.trim()).map((t) => `${t.key.replace(/_/g, " ")}: ${t.value}`),
      ].filter(Boolean);
      console.log(`${n} ${u.name}: ${facts.join(" · ")}`);
    } else if (i.kind === "relation") {
      heading("RELATIONSHIPS");
      const r = i.item;
      const s = r.strength ? ` (${r.strength > 0 ? "+" : ""}${r.strength})` : "";
      console.log(`${n} ${r.from} ${r.type.replace(/_/g, " ")} ${r.to}${s}${r.note ? `: ${r.note}` : ""}`);
    } else if (i.kind === "party") {
      heading("PARTY LOCATION");
      console.log(`${n} The party is at ${i.item}`);
    } else {
      heading("KEY MOMENTS (saved as suggestions to star)");
      const m = i.item;
      console.log(`${n} ☆ s${m.session} · ${m.tone}  ${m.title}`);
      console.log(`        ${m.description}`);
      if (m.callback) console.log(`        callback: ${m.callback}`);
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
  const { counts, warnings, entityResult: er, moments } = await applyProposal(file, skip);
  console.log(
    `\nApplied: ${counts.entities} new entities, ${counts.threads} new threads, ${counts.updates} thread updates, ${counts.links} links, ` +
      `${er.updated} entities' details, ${er.relations} relationships${er.party ? ", party location" : ""}, ${moments} suggested key moments (moment list).`,
  );
  for (const w of warnings) console.log(`  ! ${w}`);
  if (er.conflicts.length) {
    console.log("\nKept your values where Loom read the notes differently:");
    for (const c of er.conflicts) {
      for (const p of c.proposals) {
        console.log(`  • ${c.entity} · ${p.field}: yours ${JSON.stringify(p.current)}, notes suggest ${JSON.stringify(p.proposed)}`);
      }
    }
    console.log("  To take Loom's version, set it yourself with entity set / relate / campaign set.");
  }
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
    case "entity":
    case "relate":
    case "unrelate":
    case "campaign":
    case "rule":
    case "moment": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      if (!campaignId) return console.log('No campaigns yet. Try: npm run loom -- new-campaign "My campaign"');
      if (command === "entity") await entityCommand(campaignId, args);
      else if (command === "campaign") await campaignCommand(campaignId, args);
      else if (command === "rule") await ruleCommand(campaignId, args);
      else if (command === "moment") await momentCommand(campaignId, args);
      else await relateCommand(campaignId, args, command === "unrelate");
      break;
    }
    case "thread":
      await threadCommand(args);
      break;
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
      if (r.safetyNote) console.log(`⚠ ${r.safetyNote}\n`);
      for (const n of r.notes) console.log(`ℹ ${n}\n`);
      r.options.forEach((o, i) => {
        const ties = [o.thread_id, ...o.also_ties_to].map((id) => r.titleOf.get(id)).join(" + ");
        console.log(`${i + 1}. ${o.label.toUpperCase()}   ⟵ ${ties}`);
        if (o.callback) console.log(`   ⟲ calls back: ${o.callback.title} (M${o.callback.id})`);
        console.log(`   ${o.option}`);
        console.log(`   why: ${o.why}\n`);
      });
      for (const x of r.rejected) console.log(`(rejected "${x.label}": ${x.reason})`);
      const l = r.llm;
      console.log(
        `${l.model} · ${(l.latencyMs / 1000).toFixed(1)} s · ${l.inputTokens} in / ${l.outputTokens} out · ${usd(l.costUsd)} · ${r.threads.length} threads sent${l.attempts > 1 ? ` · ${l.attempts} attempts` : ""}`,
      );
      // Saved so `flavor <n>` can polish one of these options.
      mkdirSync("data", { recursive: true });
      writeFileSync(
        "data/last-improv.json",
        JSON.stringify({ campaignId, moment, options: r.options.map((o) => ({ label: o.label, text: o.option, threadIds: [o.thread_id, ...o.also_ties_to], threads: [o.thread_id, ...o.also_ties_to].map((id) => r.titleOf.get(id)), scaffold: o.scaffold })) }, null, 2),
      );
      if (r.options.length) console.log(`Read-aloud version of one: npm run loom -- flavor <1-${r.options.length}> · used one? npm run loom -- moment from-improv <n>`);
      break;
    }
    case "flavor": {
      const n = Number(args[0]);
      const last = JSON.parse(readFileSync("data/last-improv.json", "utf8"));
      const picked = last.options[n - 1];
      if (!picked) return console.log(`Pick an option from the last improv: 1-${last.options.length}`);
      const f = await flavour({ campaignId: last.campaignId, moment: last.moment, scaffold: picked.scaffold }, flag(args, "model"));
      console.log(`\n${picked.label.toUpperCase()}   ⟵ ${picked.threads.join(" + ")}\n`);
      for (const b of f.beats) console.log(`   ${b}`);
      console.log(`\n   → ${f.handOff}${f.mechanic && !f.handOff.includes(f.mechanic) ? ` (${f.mechanic})` : ""}`);
      if (f.onFail) console.log(`   On a failure: ${f.onFail}`);
      for (const x of f.fallbacks) console.log(`(kept the plain line for ${x})`);
      console.log(`\n${f.llm.model} · ${(f.llm.latencyMs / 1000).toFixed(1)} s · ${usd(f.llm.costUsd)}`);
      break;
    }
    case "suggest": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      console.log("Looking for payoffs between sessions…");
      const { data, dropped, titleOf, moments, llm } = await suggest(campaignId, flag(args, "model"));
      const names = (ids: number[]) => ids.map((id) => titleOf.get(id)).join(" + ");

      console.log("\nCOLLISIONS: threads that pay each other off");
      data.collisions.forEach((c, i) => {
        console.log(`\n${i + 1}. ${c.title.toUpperCase()}\n   ⟵ ${names(c.thread_ids)}\n   ${c.idea}\n   why: ${c.why}`);
      });
      console.log("\nFOR EACH PLAYER");
      for (const p of data.per_player) console.log(`\n• ${p.pc}${p.thread_ids.length ? `  ⟵ ${names(p.thread_ids)}` : ""}\n   ${p.idea}`);
      if (data.callbacks.length) {
        console.log("\nCALLBACKS: bring a key moment back");
        for (const c of data.callbacks) {
          const m = moments.find((x) => x.id === c.moment_id)!;
          console.log(`\n⟲ ${m.title} (session ${m.session ?? "?"})${c.thread_ids.length ? `  ⟵ ${names(c.thread_ids)}` : ""}\n   ${c.idea}`);
        }
      }
      if (data.neglected.length) {
        console.log("\nQUIET THREADS");
        for (const n of data.neglected) console.log(`\n• ${titleOf.get(n.thread_id)}\n   ${n.idea}`);
      }
      if (dropped) console.log(`\n(${dropped} suggestion(s) dropped: pointed at unknown threads or characters)`);
      console.log(`\n${llm.model} · ${(llm.latencyMs / 1000).toFixed(1)} s · ${llm.inputTokens} in / ${llm.outputTokens} out · ${usd(llm.costUsd)}`);
      break;
    }
    case "scenarios": {
      if (!args[0] || args[0].startsWith("--")) return console.log(USAGE);
      const file = ScenarioFileSchema.parse(JSON.parse(readFileSync(args[0], "utf8")));
      const only = flag(args, "only")?.split(",");
      if (only) file.scenarios = file.scenarios.filter((s) => only.includes(s.id));
      const models = (flag(args, "models") ?? "sonnet").split(",");

      console.log(`Running ${file.scenarios.length} scenario(s) × ${models.length} model(s)…`);
      const results = await runScenarios(file, models, (msg) => console.log(`  ${msg}`));

      console.log("\nModel                 Expected  Avg / max latency   Cost      Dropped  Errors");
      for (const s of summarise(results)) {
        console.log(
          `${s.model.padEnd(21)} ${s.hits.padEnd(9)} ${`${(s.avgLatencyMs / 1000).toFixed(1)} s / ${(s.maxLatencyMs / 1000).toFixed(1)} s`.padEnd(19)} ${`$${s.costUsd.toFixed(4)}`.padEnd(9)} ${String(s.dropped).padEnd(8)} ${s.errors}`,
        );
      }
      const missedRetrieval = results.filter((r) => r.retrievalFound.length < r.scenario.expect.length);
      for (const r of missedRetrieval) {
        const missed = r.scenario.expect.filter((p) => !r.retrievalFound.includes(p));
        console.log(`  retrieval missed in ${r.scenario.id}: ${missed.join(", ")}`);
      }

      const when = new Date();
      mkdirSync("data/runs", { recursive: true });
      const name = args[0].split("/").pop()!.replace(/\.json$/, "");
      const stem = `data/runs/${when.toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${name}`;
      if (args.includes("--blind")) {
        const { markdown, key } = blindReportMarkdown(file, results);
        writeFileSync(`${stem}-blind.md`, markdown);
        writeFileSync(`${stem}-blind.key.json`, JSON.stringify(key, null, 2));
        // The full report reveals the models, so keep it out of sight until scoring is done.
        writeFileSync(`${stem}-revealed.md`, reportMarkdown(file, results, when));
        console.log(`\nBlind review: ${stem}-blind.md`);
        console.log(`When you've ticked it: npm run loom -- score ${stem}-blind.md`);
      } else {
        writeFileSync(`${stem}.md`, reportMarkdown(file, results, when));
        console.log(`\nFull report: ${stem}.md`);
      }
      break;
    }
    case "score": {
      if (!args[0]) return console.log(USAGE);
      const key = JSON.parse(readFileSync(args[0].replace(/\.md$/, ".key.json"), "utf8"));
      const rows = scoreBlindReview(readFileSync(args[0], "utf8"), key).sort((a, b) => b.ticked - a.ticked);
      console.log("Model                 Options you'd use   Moments with at least one");
      for (const r of rows) {
        console.log(`${r.model.padEnd(21)} ${`${r.ticked} of ${r.offered}`.padEnd(19)} ${r.moments} of ${r.total}`);
      }
      console.log(`\nThe unblinded report is next to it: ${args[0].replace(/-blind\.md$/, "-revealed.md")}`);
      break;
    }
    case "enrich": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      console.log(`Re-reading stored recaps for campaign ${campaignId}…`);
      const res = await proposeEnrichment(campaignId, flag(args, "model"));
      console.log(`(${res.model} · ${(res.latencyMs / 1000).toFixed(1)} s · ${res.inputTokens} in / ${res.outputTokens} out · ${usd(res.costUsd)})`);
      const file: ProposalFile = { kind: "enrich", campaignId, sessionNumber: res.sessionNumber, recap: "", proposal: res.data };
      mkdirSync("data/proposals", { recursive: true });
      const out = `data/proposals/c${campaignId}-enrich.json`;
      writeFileSync(out, JSON.stringify(file, null, 2));
      await reviewAndApply(file, out);
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
