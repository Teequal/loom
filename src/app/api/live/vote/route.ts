import { z } from "zod";
import { setVote, VOTE_REASONS } from "@/core/taste";
import { jsonRoute } from "@/server/route";

// A thumbs on an option or a Develop take; null clears it.
export const POST = jsonRoute(
  z.object({
    entryId: z.number().int().positive(),
    key: z.string().max(60),
    vote: z.object({ vote: z.union([z.literal(1), z.literal(-1)]), why: z.enum(VOTE_REASONS).optional(), move: z.string().max(60).optional(), flavour: z.string().max(40).optional() }).nullable(),
  }),
  async ({ entryId, key, vote }) => {
    await setVote(entryId, key, vote);
    return { ok: true };
  },
);
