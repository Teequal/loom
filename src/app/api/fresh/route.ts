import { z } from "zod";
import { freshIdeas } from "@/core/fresh";
import { plainWords, saveIdeas } from "@/server/prep";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(
  z.object({ campaignId }),
  async ({ campaignId }) => {
    const r = await freshIdeas(campaignId);
    const result = { ...r, ideas: r.ideas.map((i) => ({ ...i, pitch: plainWords(i.pitch) })) };
    await saveIdeas(campaignId, "fresh", result);
    return result;
  },
  "Loom couldn't come up with fresh ideas this time. Try again.",
);
