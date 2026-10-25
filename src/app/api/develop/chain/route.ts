import { z } from "zod";
import { developChain } from "@/core/chain";
import { STEERS } from "@/core/moves";
import { chainBase, chainView, keepChains, stepView } from "@/server/develop";
import { overrides, streamRoute } from "@/server/route";

// Develop v2: chains of steps from a logged choice, streamed as they're written:
// {type:"step", index, n, step} per step, {type:"chain", index, chain} when a chain is complete,
// {type:"drop", index} if a chain already shown turns out unusable, then {type:"done"}.
// With devId, the chains are another take added to that development.
export const POST = streamRoute(
  z.object({
    entryId: z.number().int().positive(),
    steer: z.enum(STEERS).nullable().optional(),
    words: z.string().trim().max(300).optional(),
    count: z.number().int().min(1).max(3).optional(),
    devId: z.number().int().positive().optional(),
    exclude: z.array(z.string().max(200)).max(12).optional(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
    tone: z.number().int().min(0).max(4).optional(),
    overrides: overrides.optional(),
  }),
  async ({ entryId, steer, words, count, devId, exclude, model, tone, overrides }, send) => {
    const base = await chainBase(entryId);
    const r = await developChain(base.campaignId, {
      ...base,
      steer: steer ?? null,
      words,
      count,
      exclude,
      model,
      tone,
      overrides,
      onStep: (index, step, n) => send({ type: "step", index, n, step: stepView(step) }),
      onChain: (chain, index) => send({ type: "chain", index, chain: chainView(chain) }),
      onDrop: (index) => send({ type: "drop", index }),
    });
    const id = r.chains.length ? await keepChains(entryId, { id: devId, steer: steer ?? null, words: words ?? "" }, r.chains) : null;
    return { devId: id, count: r.chains.length, suggested: r.suggested, llm: { model: r.llm.model, seconds: r.llm.latencyMs / 1000, costUsd: r.llm.costUsd } };
  },
  "Loom couldn't develop that this time. Try again.",
);
