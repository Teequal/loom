import { z } from "zod";
import { developChain } from "@/core/chain";
import { chainBase, chainView, keptChain, replaceChain, stepView } from "@/server/develop";
import { streamRoute } from "@/server/route";

// Reworks one kept chain in place ("shorter", "darker", "lighter", "bring in Zara", the GM's own
// words), or swaps it from one step on (fromStep, keeping the steps before). Streams like
// /api/develop/chain; the old version goes on the chain's history for Back.
export const POST = streamRoute(
  z.object({
    entryId: z.number().int().positive(),
    devId: z.number().int().positive(),
    chain: z.number().int().min(0).max(9),
    how: z.string().trim().min(2).max(300),
    fromStep: z.number().int().min(0).max(5).optional(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
    tone: z.number().int().min(0).max(4).optional(),
  }),
  async ({ entryId, devId, chain: index, how, fromStep, model, tone }, send) => {
    const base = await chainBase(entryId);
    const { dev, chain } = await keptChain(entryId, devId, index);
    const r = await developChain(base.campaignId, {
      ...base,
      steer: dev.steer,
      words: dev.words || undefined,
      model,
      tone,
      refine: { chain, how, fromStep },
      onStep: (_i, step, n) => send({ type: "step", index: index, n, step: stepView(step) }),
    });
    if (!r.chains.length) throw new Error("Loom couldn't rework that this time. The chain is as it was.");
    const kept = await replaceChain(entryId, devId, index, r.chains[0]);
    return { chain: chainView(kept), llm: { model: r.llm.model, seconds: r.llm.latencyMs / 1000, costUsd: r.llm.costUsd } };
  },
  "Loom couldn't rework that this time. The chain is as it was.",
);
