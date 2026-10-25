import { z } from "zod";
import { buildSituation, loadWorld, sceneChips } from "@/core/situation";
import { campaignId, jsonRoute, overrides } from "@/server/route";

// What Loom reads from the moment, for the chips under the box: who's here, who's only mentioned,
// what's in hand, which house rules it triggers. Code only, no model call, so it can follow the
// GM's typing.
export const POST = jsonRoute(z.object({ campaignId, moment: z.string().max(1000), overrides: overrides.optional() }), async ({ campaignId, moment, overrides }) => {
  const situation = buildSituation(await loadWorld(campaignId), moment, overrides);
  return { chips: sceneChips(situation, overrides) };
});
