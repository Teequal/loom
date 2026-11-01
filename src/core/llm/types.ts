import type { z } from "zod";

// Provider-agnostic shape of one LLM call. Every feature asks for structured JSON back,
// so callers get typed data and never parse free text.
export interface LlmRequest<T> {
  feature: string; // e.g. "recap", "improv"; used for cost tracking
  campaignId?: number; // logged with the call, for per-campaign activity and cost
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  model?: string; // overrides the feature's default model; short names like "opus" work
  fast?: boolean; // skip the model's hidden reasoning where the model allows it (lower latency)
  cacheHour?: boolean; // on Haiku, keep the cache an hour: table asks can be minutes apart
  onText?: (snapshot: string) => void; // streams the answer as it's written (the JSON so far)
}

export interface ProviderResponse<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number; // read from the prompt cache, not counted in inputTokens
  cacheWriteTokens: number; // written to the prompt cache, not counted in inputTokens
  cacheHourTokens: number; // those of them kept for an hour, which cost more
}

export interface LlmProvider {
  name: string;
  defaultModel: string;
  complete<T>(req: LlmRequest<T>, model: string): Promise<ProviderResponse<T>>;
}

export interface LlmResult<T> extends ProviderResponse<T> {
  latencyMs: number;
  costUsd: number;
}
