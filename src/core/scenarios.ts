import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { improv, type ImprovOption, type ImprovOptions } from "./improv";
import { resolveModel } from "./llm";

// A scenario file: saved table moments for one campaign, each with the threads a good answer
// should touch ("expect" holds case-insensitive pieces of thread titles).
export const ScenarioFileSchema = z.object({
  campaign: z.string(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      moment: z.string(),
      expect: z.array(z.string()).default([]),
      notes: z.string().optional(),
    }),
  ),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;
type Scenario = ScenarioFile["scenarios"][number];

export interface ModelRun {
  model: string;
  options: (ImprovOption & { titles: string[] })[];
  hitExpected: boolean | null; // null when the scenario has no expectations
  dropped: number;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  retrieved: string[];
  retrievalFound: string[]; // which "expect" pieces made it into the threads sent to the model
  runs: ModelRun[];
}

const matches = (title: string, piece: string) => title.toLowerCase().includes(piece.toLowerCase());

export async function runScenarios(file: ScenarioFile, models: string[], onProgress?: (msg: string) => void, opts: ImprovOptions = {}) {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.name, file.campaign));
  if (!campaign) throw new Error(`No campaign named "${file.campaign}"`);

  const results: ScenarioResult[] = [];
  for (const scenario of file.scenarios) {
    const result: ScenarioResult = { scenario, retrieved: [], retrievalFound: [], runs: [] };
    for (const name of models) {
      const model = resolveModel(name);
      onProgress?.(`${scenario.id} · ${model}`);
      try {
        const r = await improv(campaign.id, scenario.moment, "ranked", model, opts);
        result.retrieved = r.threads.map((t) => t.title);
        result.retrievalFound = scenario.expect.filter((p) => result.retrieved.some((t) => matches(t, p)));
        const options = r.options.map((o) => ({
          ...o,
          titles: [o.thread_id, ...o.also_ties_to].map((id) => r.titleOf.get(id) ?? `T${id}`),
        }));
        result.runs.push({
          model: r.llm.model,
          options,
          hitExpected: scenario.expect.length
            ? options.some((o) => o.titles.some((t) => scenario.expect.some((p) => matches(t, p))))
            : null,
          dropped: r.dropped,
          latencyMs: r.llm.latencyMs,
          costUsd: r.llm.costUsd,
        });
      } catch (err) {
        result.runs.push({
          model,
          options: [],
          hitExpected: false,
          dropped: 0,
          latencyMs: 0,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    results.push(result);
  }
  return results;
}

export function summarise(results: ScenarioResult[]) {
  const byModel = new Map<string, ModelRun[]>();
  for (const r of results) for (const run of r.runs) byModel.set(run.model, [...(byModel.get(run.model) ?? []), run]);

  return [...byModel.entries()].map(([model, runs]) => {
    const ok = runs.filter((r) => !r.error);
    const scored = ok.filter((r) => r.hitExpected !== null);
    const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
    return {
      model,
      runs: runs.length,
      errors: runs.length - ok.length,
      hitRate: scored.length ? scored.filter((r) => r.hitExpected).length / scored.length : null,
      hits: `${scored.filter((r) => r.hitExpected).length}/${scored.length}`,
      dropped: ok.reduce((s, r) => s + r.dropped, 0),
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      maxLatencyMs: latencies.at(-1) ?? 0,
      costUsd: ok.reduce((s, r) => s + r.costUsd, 0),
    };
  });
}

// Blind review: each moment's options from every model, shuffled and lettered, with no model
// names, timings or verdicts. The letter → model key is returned separately for scoring.
export type BlindKey = Record<string, Record<string, string>>; // scenario id → letter → model

export function blindReportMarkdown(file: ScenarioFile, results: ScenarioResult[]) {
  const key: BlindKey = {};
  const lines = [
    `# Blind review: ${file.campaign}`,
    "",
    "Options from several models, shuffled. Tick **every** option you'd genuinely use at the table, not just the best one. Any mark inside the brackets counts.",
    "",
  ];
  results.forEach((r, i) => {
    const pool = r.runs.flatMap((run) => run.options.map((o) => ({ model: run.model, o })));
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    key[r.scenario.id] = {};
    lines.push(`## ${i + 1}. ${r.scenario.id}`, "", `> ${r.scenario.moment}`, "");
    pool.forEach(({ model, o }, j) => {
      const letter = String.fromCharCode(65 + j);
      key[r.scenario.id][letter] = model;
      lines.push(`- [ ] ${letter}. **${o.label}** ⟵ ${o.titles.join(" + ")}`, `  ${o.option}`, `  *why: ${o.why}*`, "");
    });
  });
  return { markdown: lines.join("\n"), key };
}

// Reads ticks from a blind review and counts them per model using the key.
export function scoreBlindReview(markdown: string, key: BlindKey) {
  const scores = new Map<string, { ticked: number; offered: number; moments: Set<string> }>();
  for (const letters of Object.values(key))
    for (const model of Object.values(letters))
      if (!scores.has(model)) scores.set(model, { ticked: 0, offered: 0, moments: new Set() });

  let scenario = "";
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^## \d+\. (\S+)/);
    if (heading) scenario = heading[1];
    const option = line.match(/^- \[([^\]]*)\]+ ([A-Z])\./);
    if (!option || !key[scenario]?.[option[2]]) continue;
    const s = scores.get(key[scenario][option[2]])!;
    s.offered++;
    if (option[1].trim()) {
      s.ticked++;
      s.moments.add(scenario);
    }
  }
  const total = Object.keys(key).length;
  return [...scores.entries()].map(([model, s]) => ({ model, ticked: s.ticked, offered: s.offered, moments: s.moments.size, total }));
}

// A Markdown report to read side by side, with a box to tick for each option you'd actually use.
export function reportMarkdown(file: ScenarioFile, results: ScenarioResult[], when: Date) {
  const lines: string[] = [];
  lines.push(`# Scenario run: ${file.campaign}`, "", `${when.toLocaleString()}`, "");
  lines.push("| Model | Expected thread used | Avg / max latency | Cost | Dropped options | Errors |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of summarise(results)) {
    lines.push(
      `| ${s.model} | ${s.hits} | ${(s.avgLatencyMs / 1000).toFixed(1)} s / ${(s.maxLatencyMs / 1000).toFixed(1)} s | $${s.costUsd.toFixed(4)} | ${s.dropped} | ${s.errors} |`,
    );
  }
  lines.push("", "Tick the options you'd genuinely use at the table.", "");

  for (const r of results) {
    const { scenario } = r;
    lines.push(`## ${scenario.id}`, "", `> ${scenario.moment}`, "");
    if (scenario.notes) lines.push(`*${scenario.notes}*`, "");
    if (scenario.expect.length) {
      const missed = scenario.expect.filter((p) => !r.retrievalFound.includes(p));
      lines.push(
        `Expected threads: ${scenario.expect.join(", ")} · retrieval found ${r.retrievalFound.length}/${scenario.expect.length}${missed.length ? ` (missed: ${missed.join(", ")})` : ""}`,
        "",
      );
    }
    for (const run of r.runs) {
      const verdict = run.error ? "ERROR" : run.hitExpected === null ? "" : run.hitExpected ? "✓ used an expected thread" : "✗ no expected thread";
      lines.push(`### ${run.model}  ${verdict}`, "");
      if (run.error) lines.push(`Error: ${run.error}`, "");
      for (const o of run.options) {
        lines.push(`- [ ] **${o.label}** ⟵ ${o.titles.join(" + ")}`, `  ${o.option}`, `  *why: ${o.why}*`);
      }
      if (!run.error) lines.push("", `${(run.latencyMs / 1000).toFixed(1)} s · $${run.costUsd.toFixed(4)}`, "");
    }
  }
  return lines.join("\n");
}
