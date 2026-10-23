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
  improv: "claude-sonnet-5-5",
  suggest: "claude-opus-5-5", // between-session prep: quality over speed
  enrich: "claude-opus-5-5", // one-off backfill of entity details from stored recaps
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
  const started = performance.now();
  try {
    const res = await provider.complete(req, model);
    const latencyMs = Math.round(performance.now() - started);
    const costUsd = costOf(res.model, res.inputTokens, res.outputTokens);
    await db.insert(schema.llmCalls).values({
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
      feature: req.feature,
      model,
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
