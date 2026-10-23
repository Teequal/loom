import type { z } from "zod";

// Provider-agnostic shape of one LLM call. Every feature asks for structured JSON back,
// so callers get typed data and never parse free text.
export interface LlmRequest<T> {
  feature: string; // e.g. "recap", "improv"; used for cost tracking
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  model?: string; // overrides the feature's default model; short names like "opus" work
  fast?: boolean; // skip the model's hidden reasoning where the model allows it (lower latency)
  onText?: (snapshot: string) => void; // streams the answer as it's written (the JSON so far)
}

export interface ProviderResponse<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
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
