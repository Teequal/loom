import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { LlmProvider, LlmRequest, ProviderResponse } from "./types";

let client: Anthropic | undefined;

// Models whose safety classifiers can (rarely) misfire on fantasy violence or magic. With
// server-side fallback, a refused request is retried on a suitable model inside the same call.
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  defaultModel: "claude-haiku-5-5",

  async complete<T>(req: LlmRequest<T>, model: string): Promise<ProviderResponse<T>> {
    // Keys not scoped to a workspace must name one on every request.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    client ??= new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
    const fallback = SUPPORTS_FALLBACK.has(model);
    const response = await client.beta.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      // Low effort keeps live calls fast; recap extraction can ask for more.
      output_config: { effort: req.effort ?? "low", format: betaZodOutputFormat(req.schema) },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (response.stop_reason === "refusal") throw new Error("Model declined the request");
    if (response.stop_reason === "max_tokens") throw new Error(`Response cut off at max_tokens (${req.maxTokens ?? 4000})`);
    if (response.parsed_output == null) throw new Error("Model response did not match the expected format");

    return {
      data: response.parsed_output as T,
      model: response.model, // the model that actually answered (differs if a fallback ran)
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  },
};
