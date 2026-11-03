import { z } from "zod";
import { threadMoves } from "@/core/thread-moves";
import { campaignId, jsonRoute } from "@/server/route";

// A thread's "What could happen next": the engine's moves for it, worked out without a model.
export const POST = jsonRoute(z.object({ campaignId, threadId: z.number().int().positive() }), ({ campaignId, threadId }) => threadMoves(campaignId, threadId));
