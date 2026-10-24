import { z } from "zod";
import { answerRules } from "@/core/rules-qa";
import { campaignId, jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ campaignId, question: z.string().trim().min(3, "Ask a rules question.").max(1000) }), ({ campaignId, question }) => answerRules(campaignId, question), "Loom couldn't answer that this time. Try again.");
