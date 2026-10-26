import { checkAllowance } from "../access";
import { db, schema } from "../db/client";
import { anthropicProvider } from "./anthropic";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

export type { LlmRequest, LlmResult } from "./types";

// USD per million tokens. Check against the provider's pricing page when adding models.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

// Short names accepted anywhere a model is chosen (e.g. --model opus).
const ALIASES: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

// Which model each feature uses by default. Recaps run once per session, so they get the
// strongest model; improv runs live, so it balances quality against speed and cost.
const FEATURE_MODELS: Record<string, string> = {
  recap: "claude-opus-5-5",
  improv: "claude-haiku-5-5", // blind run 3: ties Opus at ~1/40th the cost; Sonnet and Opus are the higher tiers
  live: "claude-sonnet-5-5", // extracting each choice at the table: auto-applied, so better than Haiku; runs in the background
  encounter: "claude-sonnet-5-5", // fight setup: stat blocks need a careful model, but it's at the table
  rules: "claude-sonnet-5-5", // rules questions: accuracy matters, the answer is short
  fresh: "claude-opus-5-5", // new material between sessions: invention needs the strongest model
  chain: "claude-sonnet-5-5", // Develop v2's chains: Sonnet 8/8 usable vs Haiku 3/24 (blind run 2); Opus when the table is on Best
  hook: "claude-opus-5-5", // a starter campaign from a random hook, for someone brand new
  suggest: "claude-opus-5-5", // between-session prep: quality over speed
  enrich: "claude-opus-5-5", // one-off backfill of entity details from stored recaps
  infer: "claude-sonnet-5-5", // the property model's pass over all recaps: what NPCs are like, how they stand (blanks only)
  properties: "claude-sonnet-5-5", // the same, for one session's notes, alongside its recap extraction
  flavor: "claude-opus-5-5", // read-aloud polish of the one option the GM picked
  rule: "claude-sonnet-5-5", // drafting a structured house rule from plain words
};

const provider: LlmProvider = anthropicProvider;

export function resolveModel(name: string) {
  return ALIASES[name.toLowerCase()] ?? name;
}

// Precedence: explicit request > LOOM_MODEL_<FEATURE> > LOOM_MODEL > feature default > provider default.
function modelFor(req: LlmRequest<unknown>) {
  const choice =
    req.model ??
    process.env[`LOOM_MODEL_${req.feature.toUpperCase()}`] ??
    process.env.LOOM_MODEL ??
    FEATURE_MODELS[req.feature] ??
    provider.defaultModel;
  return resolveModel(choice);
}

function costOf(modelId: string, inputTokens: number, outputTokens: number) {
  const price = PRICES[modelId];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// The one entry point every feature uses. Times the call and logs it, success or failure.
export async function callLlm<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const model = modelFor(req);
  // An invited tester's calls stop at their allowance (access.ts); the owner's never do.
  const testerId = await checkAllowance(req.campaignId);
  const started = performance.now();
  try {
    const res = await provider.complete(req, model);
    const latencyMs = Math.round(performance.now() - started);
    const costUsd = costOf(res.model, res.inputTokens, res.outputTokens);
    await db.insert(schema.llmCalls).values({
      campaignId: req.campaignId ?? null,
      testerId,
      feature: req.feature,
      model: res.model,
      latencyMs,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUsd,
      ok: true,
    });
    return { ...res, latencyMs, costUsd };
  } catch (err) {
    await db.insert(schema.llmCalls).values({
      campaignId: req.campaignId ?? null,
      testerId,
      feature: req.feature,
      model,
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    // Out of API credit is the GM's to fix, not a glitch: say so plainly everywhere.
    if (err instanceof Error && /credit balance is too low/i.test(err.message)) {
      throw new Error("Loom's AI credit has run out. Top up at console.anthropic.com (Plans & Billing), then try again.");
    }
    throw err;
  }
}
