import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LlmProvider, LlmRequest, ProviderResponse } from "./types";

// The answer format, sent so the API enforces it while the model writes. The SDK's own helper
// (betaZodOutputFormat, SDK 1.1) moves `enum` and `const` into the description as a hint, so the
// lists Loom builds per request (who may act, which threads, who gets the hand-off) were never
// enforced, only checked afterwards. This keeps them as constraints.
type Json = Record<string, unknown>;
function strict(node: Json): Json {
  const s = { ...node };
  const out: Json = {};
  const take = (k: string) => {
    const v = s[k];
    delete s[k];
    return v;
  };
  delete s.$schema;
  const defs = take("$defs") as Record<string, Json> | undefined;
  if (defs) out.$defs = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, strict(v)]));
  const ref = take("$ref");
  if (ref !== undefined) return { ...out, $ref: ref };
  const variants = (take("anyOf") ?? take("oneOf")) as Json[] | undefined;
  const all = take("allOf") as Json[] | undefined;
  const type = take("type");
  if (variants) out.anyOf = variants.map(strict);
  else if (all) out.allOf = all.map(strict);
  else out.type = type;
  const en = take("enum");
  const cn = take("const");
  if (en !== undefined) out.enum = en;
  else if (cn !== undefined) out.enum = [cn];
  for (const k of ["description", "title"]) if (s[k] !== undefined) out[k] = take(k);
  if (type === "object") {
    out.properties = Object.fromEntries(Object.entries((take("properties") as Record<string, Json>) ?? {}).map(([k, v]) => [k, strict(v)]));
    delete s.additionalProperties;
    out.additionalProperties = false;
    if (s.required !== undefined) out.required = take("required");
  } else if (type === "array") {
    if (s.items !== undefined) out.items = strict(take("items") as Json);
    if (s.minItems === 0 || s.minItems === 1) out.minItems = take("minItems");
  }
  // Anything the API can't enforce (lengths, numeric ranges, patterns) stays as a hint.
  const rest = Object.entries(s);
  if (rest.length) out.description = `${out.description ? `${out.description}\n\n` : ""}{${rest.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}`;
  return out;
}

export function outputFormat<T>(schema: z.ZodType<T>) {
  return {
    type: "json_schema" as const,
    schema: strict(z.toJSONSchema(schema, { reused: "ref" }) as Json),
    parse: (content: string) => {
      const r = schema.safeParse(JSON.parse(content));
      if (!r.success) throw new Error(`Failed to parse structured output: ${r.error.message}`);
      return r.data;
    },
  };
}

let client: Anthropic | undefined;

// Models whose safety classifiers can (rarely) misfire on fantasy violence or magic. With
// server-side fallback, a refused request is retried on a suitable model inside the same call.
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// Models that accept thinking turned off (at effort high or below). Opus 5.5 always thinks;
// Sonnet 5.5 has a different off switch, so it's left thinking.
const CAN_DISABLE_THINKING = new Set(["claude-haiku-5-5"]);

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  defaultModel: "claude-haiku-5-5",

  async complete<T>(req: LlmRequest<T>, model: string): Promise<ProviderResponse<T>> {
    // Keys not scoped to a workspace must name one on every request.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    client ??= new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
    const fallback = SUPPORTS_FALLBACK.has(model);
    const params = {
      model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      messages: [{ role: "user" as const, content: req.prompt }],
      // Low effort keeps live calls fast; recap extraction can ask for more.
      output_config: { effort: req.effort ?? "low", format: outputFormat(req.schema) },
      ...(req.fast && CAN_DISABLE_THINKING.has(model) ? { thinking: { type: "disabled" as const } } : {}),
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    // Large responses must stream (the SDK refuses long non-streaming requests); same result either way.
    // A caller that wants the answer as it's written gets each new snapshot of the text.
    let response;
    if (req.onText || params.max_tokens > 16000) {
      const stream = client.beta.messages.stream(params);
      if (req.onText) stream.on("text", (_delta, snapshot) => req.onText!(snapshot));
      response = await stream.finalMessage();
    } else {
      response = await client.beta.messages.parse(params);
    }

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
