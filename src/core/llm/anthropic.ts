import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LlmProvider, LlmRequest, ProviderResponse } from "./types";

let client: Anthropic | undefined;

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  defaultModel: "claude-haiku-5-5",

  async complete<T>(req: LlmRequest<T>, model: string): Promise<ProviderResponse<T>> {
    // Keys not scoped to a workspace must name one on every request.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    client ??= new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
    const response = await client.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      // Low effort keeps live calls fast; recap extraction can ask for more.
      output_config: { effort: req.effort ?? "low", format: zodOutputFormat(req.schema) },
    });

    if (response.stop_reason === "refusal") throw new Error("Model declined the request");
    if (response.stop_reason === "max_tokens") throw new Error(`Response cut off at max_tokens (${req.maxTokens ?? 4000})`);
    if (response.parsed_output == null) throw new Error("Model response did not match the expected format");

    return {
      data: response.parsed_output as T,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  },
};
