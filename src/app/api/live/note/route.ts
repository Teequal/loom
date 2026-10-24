import { after } from "next/server";
import { z } from "zod";
import { commitChoice, extractEntry, logAsk } from "@/core/live";
import { entryView } from "@/server/live";
import { campaignId, jsonRoute } from "@/server/route";

// Something happened that the GM didn't ask Loom about: log it and extract it like a choice.
export const POST = jsonRoute(
  z.object({ campaignId, moment: z.string().trim().max(1000).default(""), text: z.string().trim().min(2, "Write what happened.").max(4000) }),
  async ({ campaignId, moment, text }) => {
    const asked = await logAsk(campaignId, moment || "(noted by the GM)", []);
    const e = await commitChoice(asked.id, { kind: "own", label: "", text });
    after(() => extractEntry(e.id));
    return { entry: entryView(e) };
  },
);
