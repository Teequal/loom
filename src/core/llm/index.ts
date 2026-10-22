import { db, schema } from "../db/client";
import { anthropicProvider } from "./anthropic";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

export type { LlmRequest, LlmResult } from "./types";

// USD per million tokens. Check against the provider's pricing page when adding models.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
};

const provider: LlmProvider = anthropicProvider;
const model = process.env.LOOM_MODEL ?? provider.defaultModel;

function costOf(modelId: string, inputTokens: number, outputTokens: number) {
  const price = PRICES[modelId];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// The one entry point every feature uses. Times the call and logs it, success or failure.
export async function callLlm<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const started = performance.now();
  try {
    const res = await provider.complete(req, model);
    const latencyMs = Math.round(performance.now() - started);
    const costUsd = costOf(model, res.inputTokens, res.outputTokens);
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
