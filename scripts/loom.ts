// Loom command-line tool for the Phase 1 spike. Run with: npm run loom -- <command>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { desc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { costSummary } from "@/core/costs";
import { db, initDb, schema } from "@/core/db/client";
import { flavour } from "@/core/flavour";
import { developChain } from "@/core/chain";
import { improv } from "@/core/improv";
import { STEERS, type Steer } from "@/core/moves";
import { callLlm } from "@/core/llm";
import { applyProposal, proposeEnrichment, proposeProperties, proposeRecapChanges, type ProposalFile } from "@/core/recap";
import { reviewProposal, splitRisky } from "@/core/review";
import { latestBatch, recentBatches, undoBatch, undoOne } from "@/core/undo";
import { embeddingProvider, ensureEmbeddings, searchByMeaning } from "@/core/embeddings";
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
import { inviteCommand } from "./invite-cli";
import { momentCommand } from "./moments-cli";
import { playerCommand } from "./players-cli";
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
  changes [--last N]         Recent changes, grouped by batch (a recap, an enrich, a command)
  embed [search "<text>"] [--model local|voyage]
                             Refresh embeddings (meaning search); optionally see what a phrase is closest to
  undo                       Undo the latest batch · undo --batch "<label>" · undo <change id> [--force]
  player list | player add "<handle>" plays="<PC>" enjoys="mystery 3, comedy 2" lines="…"
                             The real people at the table (DM-only): steers who gets the spotlight
                             House rules and effects: what fires when, and who it applies to

Engine
  recap <file> [--session N] [--campaign id] [--model name]
                             Read a session recap and propose thread changes for you to approve
  infer --campaign id [--model name] [--save-only]
                             Read every recap for what the NPCs are like and how they stand;
                             review, then fill blanks only (source "inferred")
  apply <proposal.json>      Apply a (hand-edited) proposal file saved by "recap" or "enrich"
  enrich [--campaign id] [--model name]
                             Re-read all stored recaps and propose entity details, relationships
                             and the party's location (for campaigns recorded before these existed)
  improv "<what happened>" [--campaign id] [--why] [--focused] [--threads N] [--all] [--model name]
                             2-3 options tied to existing threads. --why shows which threads were
                             retrieved and why; --focused uses a tighter scene and fewer threads;
                             --threads N sends exactly N (plus threads tied to what you named);
                             --all sends every open thread (for comparison)
  develop <entry id> | "<moment>" "<choice>" [--steer fight|heartfelt|epic|grounded|quiet|story] [--words "…"]
          [--count 1-3] [--from step] [--model name] [--campaign id]   Develop v2: a chain of steps from a choice
  flavor <n> [--model name]  Read-aloud version of option n from the last improv (default: opus)

  suggest [--campaign id] [--model name]
                             Between-session prep: thread collisions, an idea per player
                             character, and ways back into quiet threads
  scenarios <file.json> [--models sonnet,opus] [--only id1,id2] [--blind] [--focused] [--embed off|local|voyage]
                             Run saved moments through the improv box on each model and write a
                             side-by-side report to data/runs/ (default model: sonnet).
                             --blind shuffles all models' options together with models hidden
  score <blind-report.md>    Count your ticks in a blind report per model
  ping                       Make one small LLM call to check the API key and logging
  costs                      Show LLM calls, latency and cost so far
  invite add|list|cap|revoke Invite testers when Loom is shared (see docs/sharing.md)

  --model takes haiku, sonnet, opus, fable or a full model id.
  Defaults: recap, suggest, enrich, flavor = opus; improv = sonnet; everything else = haiku.`;

const usd = (n: number | null) => `$${(n ?? 0).toFixed(5)}`;

function flag(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// Asks a question, falling back to a default when input has ended (piped answers, scripts).
// Piped input (scripts, tests) is read up front, one answer per line.
async function asker() {
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const lines = text.split("\n");
    return {
      ask: async (q: string, fallback: string) => {
        const a = lines.length ? lines.shift()! : fallback;
        console.log(`${q}${a}`);
        return a;
      },
      close: () => {},
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (q: string, fallback: string) => rl.question(q).catch(() => fallback), close: () => rl.close() };
}

const EVIDENCE_MARK: Record<string, string> = { exact: "✓ in your notes", close: "≈ close to your notes", missing: "(no quote)", "not-found": "⚠ not in your notes" };

// Tiered review: low-risk details are added (and undoable), ordinary changes are confirmed in
// groups with one keypress, risky ones one at a time.
async function reviewAndApply(original: ProposalFile, path: string) {
  const file = await splitRisky(original); // risky fields become their own items
  const reviewed = await reviewProposal(file);
  const auto = reviewed.filter((r) => r.tier === "auto");
  const quick = reviewed.filter((r) => r.tier === "quick");
  const must = reviewed.filter((r) => r.tier === "must");
  console.log(`\n${reviewed.length} proposed changes: ${auto.length} added automatically · ${quick.length} to confirm in groups · ${must.length} need a yes`);

  const groupBy = (rows: typeof reviewed) => {
    const out = new Map<string, typeof reviewed>();
    for (const r of rows) out.set(r.group, [...(out.get(r.group) ?? []), r]);
    return [...out.entries()];
  };

  if (auto.length) {
    console.log("\nADDED AUTOMATICALLY (low-risk details straight from your notes; undo anytime)");
    for (const [g, rows] of groupBy(auto)) console.log(`  • ${g}: ${rows.map((r) => r.summary).join(" · ")}`);
  }

  const groups = groupBy(quick);
  if (groups.length) {
    console.log("\nCONFIRM IN GROUPS");
    groups.forEach(([g, rows], i) => {
      console.log(`  [${i + 1}] ${g}`);
      for (const r of rows) console.log(`        ${r.summary}${r.evidence ? `   “${r.evidence}”` : ""}`);
    });
  }
  if (must.length) {
    console.log("\nNEED A YES (one at a time)");
    must.forEach((r, i) => {
      console.log(`  (${String.fromCharCode(97 + i)}) ${r.group}: ${r.summary}`);
      console.log(`        why: ${r.reasons.join("; ")}`);
      console.log(`        evidence: ${r.evidence ? `“${r.evidence}” ` : ""}${EVIDENCE_MARK[r.check]}`);
    });
  }

  const io = await asker();
  const skip = new Set<number>();
  const confirmed = new Set<number>(); // risky items the GM said yes to
  if (groups.length) {
    const a = (await io.ask(`\nGroups: Enter = accept all · n = none · or numbers to skip (e.g. "2, 4")\n> `, "")).trim().toLowerCase();
    if (a === "n") for (const r of quick) skip.add(r.item.n);
    else for (const num of a.match(/\d+/g) ?? []) for (const r of groups[Number(num) - 1]?.[1] ?? []) skip.add(r.item.n);
  }
  for (const [i, r] of must.entries()) {
    const a = (await io.ask(`(${String.fromCharCode(97 + i)}) ${r.group}: ${r.summary}: apply? [y/N] `, "n")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") skip.add(r.item.n);
    else confirmed.add(r.item.n);
  }
  io.close();
  console.log(`\n(To change wording instead, edit ${path} and run: npm run loom -- apply ${path})`);

  if (skip.size === reviewed.length) return console.log("Nothing applied.");
  const { counts, warnings, entityResult: er, moments, batch } = await applyProposal(file, skip, undefined, confirmed);
  console.log(
    `\nApplied: ${counts.entities} new entities, ${counts.threads} new threads, ${counts.updates} thread updates, ${counts.links} links, ` +
      `${er.updated} entities' details, ${er.relations} relationships${er.party ? ", party location" : ""}, ${moments} suggested key moments.`,
  );
  for (const w of warnings) console.log(`  ! ${w}`);
  if (er.conflicts.length) {
    console.log("\nKept your values where Loom read the notes differently:");
    for (const c of er.conflicts) for (const p of c.proposals) console.log(`  • ${c.entity} · ${p.field}: yours ${JSON.stringify(p.current)}, notes suggest ${JSON.stringify(p.proposed)}`);
  }
  console.log(`\nUndo all of this: npm run loom -- undo        (batch "${batch}")`);
}

async function latestCampaignId() {
  // Your own most recent campaign, never an invited tester's.
  const [c] = await db.select().from(schema.campaigns).where(isNull(schema.campaigns.testerId)).orderBy(desc(schema.campaigns.id)).limit(1);
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
    case "moment":
    case "player": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      if (!campaignId) return console.log('No campaigns yet. Try: npm run loom -- new-campaign "My campaign"');
      if (command === "entity") await entityCommand(campaignId, args);
      else if (command === "campaign") await campaignCommand(campaignId, args);
      else if (command === "rule") await ruleCommand(campaignId, args);
      else if (command === "moment") await momentCommand(campaignId, args);
      else if (command === "player") await playerCommand(campaignId, args);
      else await relateCommand(campaignId, args, command === "unrelate");
      break;
    }
    case "embed": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      const provider = embeddingProvider(flag(args, "model") ?? flag(args, "embed"));
      if (!provider) return console.log("Embeddings are off (LOOM_EMBEDDINGS=off).");
      const t0 = performance.now();
      const r = await ensureEmbeddings(campaignId, provider);
      console.log(`${provider.model}: ${r.total} items · ${r.embedded} embedded now · ${r.removed} removed · ${Math.round(performance.now() - t0)} ms`);
      if (args[0] === "search" && args[1]) {
        const m = await searchByMeaning(campaignId, provider, args[1]);
        const ents = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
        const thr = await db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
        const label = (h: (typeof m.threads)[number]) =>
          h.ownerType === "thread" ? thr.find((t) => t.id === h.ownerId)?.title : h.ownerType === "entity" ? ents.find((e) => e.id === h.ownerId)?.name : h.text.slice(0, 70) + "…";
        for (const [kind, hits] of [["threads", m.threads], ["entities", m.entities], ["moments", m.moments], ["scenes", m.scenes]] as const) {
          console.log(`\n${kind}`);
          for (const h of hits.slice(0, 4)) console.log(`  ${h.sim.toFixed(3)} (z ${h.z.toFixed(1)}) ${label(h) ?? h.text.slice(0, 60)}`);
        }
      }
      return;
    }
    case "changes": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      const batches = await recentBatches(campaignId, Number(flag(args, "last") ?? 8));
      if (!batches.length) return console.log("No changes recorded yet.");
      for (const b of batches) {
        console.log(`\n${b.undone ? "↶ undone · " : ""}${b.batch}  (${b.changes.length} change${b.changes.length > 1 ? "s" : ""})`);
        for (const c of b.changes.slice(0, 6).reverse()) console.log(`   #${c.id} ${c.kind.padEnd(16)} ${c.subject}${c.field ? ` · ${c.field}` : ""}${c.undoneAt ? " (undone)" : ""}`);
        if (b.changes.length > 6) console.log(`   … and ${b.changes.length - 6} more`);
      }
      return;
    }
    case "undo": {
      const campaignId = Number(flag(args, "campaign") ?? (await latestCampaignId()));
      const force = args.includes("--force");
      const id = args[0] && /^\d+$/.test(args[0]) ? Number(args[0]) : null;
      let label: string | undefined = flag(args, "batch");
      if (!id && !label) label = (await latestBatch(campaignId))?.batch;
      if (!id && !label) return console.log("Nothing to undo.");
      const r = id ? await undoOne(campaignId, id, { force }) : await undoBatch(campaignId, label!, { force });
      if (r.blocked.length) {
        console.log("Not undone: later changes build on this.");
        for (const b of r.blocked) console.log(`  • ${b}`);
        return console.log("Undo the later ones first, or add --force to undo anyway.");
      }
      console.log(`↶ Undid ${r.undone} of ${r.total} change${r.total === 1 ? "" : "s"}${id ? ` (#${id})` : ` from "${label}"`}.`);
      for (const n of r.notes) console.log(`  ! ${n}`);
      return;
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
      const r = await improv(campaignId, moment, args.includes("--all") ? "all" : "ranked", flag(args, "model"), {
        focused: args.includes("--focused"),
        threads: flag(args, "threads") ? Number(flag(args, "threads")) : undefined,
        embeddings: flag(args, "embed"),
      });

      if (args.includes("--why")) {
        console.log("\nThreads considered:");
        for (const t of r.threads) console.log(`  ${t.score.toFixed(1).padStart(5)} ${t.detail === "full" ? "full" : "line"}${t.guaranteed ? " ★" : "  "} T${t.id} ${t.title}  (${t.reasons.join("; ") || "recency"})`);
        console.log("  full = sent in detail · line = title and summary · ★ = tied to something the moment names");
        if (r.meaning.note) console.log(`  ${r.meaning.note}`);
        else if (r.meaning.model) console.log(`\nClose in meaning (${r.meaning.model}):${r.meaning.lines.length ? "" : " nothing unusually close"}\n${r.meaning.lines.map((l) => `  ${l}`).join("\n")}`);
      }
      console.log("");
      if (r.safetyNote) console.log(`⚠ ${r.safetyNote}\n`);
      for (const n of r.notes) console.log(`ℹ ${n}\n`);
      r.options.forEach((o, i) => {
        const ties = [o.thread_id, ...o.also_ties_to].map((id) => r.titleOf.get(id)).join(" + ");
        console.log(`${i + 1}. ${o.label.toUpperCase()}   ⟵ ${ties}`);
        if (o.callback) console.log(`   ⟲ calls back: ${o.callback.title} (M${o.callback.id})`);
        const quiet = r.quiet.get(o.scaffold.hand_off.to) ?? 0;
        if (quiet >= 2) console.log(`   ◎ spotlight for ${o.scaffold.hand_off.to} (quiet for ${quiet} sessions)`);
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
    case "develop": {
      // From a logged entry (its moment and the choice used), or a moment and a choice typed here.
      let base: { campaignId: number; moment: string; label: string; text: string };
      if (/^\d+$/.test(args[0] ?? "")) {
        const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, Number(args[0])));
        if (!e) return console.log(`No entry ${args[0]}.`);
        base = { campaignId: e.campaignId, moment: e.moment, label: e.choiceLabel, text: e.choice || e.moment };
      } else {
        if (!args[0] || !args[1] || args[1].startsWith("--")) return console.log(USAGE);
        base = { campaignId: Number(flag(args, "campaign") ?? (await latestCampaignId())), moment: args[0], label: "", text: args[1] };
      }
      const steer = flag(args, "steer") as Steer | undefined;
      if (steer && !STEERS.includes(steer)) return console.log(`--steer is one of: ${STEERS.join(", ")}`);
      const started = Date.now();
      const r = await developChain(base.campaignId, {
        ...base,
        steer,
        words: flag(args, "words"),
        count: flag(args, "count") ? Number(flag(args, "count")) : 1,
        from: flag(args, "from") === "step" ? "step" : "option",
        model: flag(args, "model"),
        onStep: (i, _st, n) => console.log(`  (chain ${i + 1} step ${n + 1} at ${((Date.now() - started) / 1000).toFixed(1)} s)`),
        onChain: (c) => console.log(`  (chain "${c.label}" complete at ${((Date.now() - started) / 1000).toFixed(1)} s)`),
      });
      console.log(`\nSuggested steer: ${r.suggested}${steer ? ` · asked: ${steer}` : ""}`);
      for (const [i, c] of r.chains.entries()) {
        console.log(`\n${i + 1}. ${c.label.toUpperCase()}  [${c.flavour ?? "-"}] · ${c.move}`);
        console.log(`   ${c.headline}`);
        for (const [n, st] of c.steps.entries()) console.log(`   ${n + 1}  ${st.when ? `${st.when} ` : ""}${st.text}${st.needs ? `  [${st.needs}]` : ""}`);
        console.log(`   Ties: ${c.threads.map((t) => t.title).join(" · ")}${c.callback ? ` · ⟲ ${c.callback.title}` : ""}`);
        console.log(`   Why: ${c.why}`);
      }
      if (!r.chains.length) console.log("\nNo chain got past the checks.");
      if (r.log.length) console.log(`\nDropped:\n${r.log.map((l) => `  - ${l.label}: ${l.reason}`).join("\n")}`);
      console.log(`\n${r.llm.model} · ${(r.llm.latencyMs / 1000).toFixed(1)} s · $${r.llm.costUsd.toFixed(4)}${r.llm.attempts > 1 ? ` · ${r.llm.attempts} attempts` : ""}`);
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
      const { data, dropped, titleOf, moments, seats, llm } = await suggest(campaignId, flag(args, "model"));
      const names = (ids: number[]) => ids.map((id) => titleOf.get(id)).join(" + ");

      console.log("\nCOLLISIONS: threads that pay each other off");
      data.collisions.forEach((c, i) => {
        console.log(`\n${i + 1}. ${c.title.toUpperCase()}\n   ⟵ ${names(c.thread_ids)}\n   ${c.idea}\n   why: ${c.why}`);
      });
      console.log("\nFOR EACH PLAYER");
      for (const p of data.per_player) {
        const quiet = seats.find((x) => x.pc.name === p.pc)?.quietFor ?? 0;
        console.log(`\n• ${p.pc}${quiet >= 2 ? ` ◎ quiet for ${quiet} sessions` : ""}${p.thread_ids.length ? `  ⟵ ${names(p.thread_ids)}` : ""}\n   ${p.idea}`);
      }
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
      const results = await runScenarios(file, models, (msg) => console.log(`  ${msg}`), { focused: args.includes("--focused"), embeddings: flag(args, "embed") });

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
    case "infer": {
      // Explicit campaign only: this proposes values for every NPC at once.
      const campaignId = Number(flag(args, "campaign"));
      if (!campaignId) return console.log("infer needs --campaign <id>");
      console.log(`Reading every recap for campaign ${campaignId}: what the NPCs are like, and how they stand…`);
      const res = await proposeProperties(campaignId, { model: flag(args, "model") });
      console.log(`(${res.model} · ${(res.latencyMs / 1000).toFixed(1)} s · ${res.inputTokens} in / ${res.outputTokens} out · ${usd(res.costUsd)})${res.dropped ? ` · ${res.dropped} about player characters dropped` : ""}`);
      const file: ProposalFile = { kind: "infer", campaignId, sessionNumber: res.sessionNumber, recap: "", proposal: res.data };
      mkdirSync("data/proposals", { recursive: true });
      const out = `data/proposals/c${campaignId}-infer.json`;
      writeFileSync(out, JSON.stringify(file, null, 2));
      if (args.includes("--save-only")) return console.log(`Saved ${out} (review it with: apply ${out})`);
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
    case "invite": {
      await inviteCommand(args);
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
