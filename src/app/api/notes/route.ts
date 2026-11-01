import { z } from "zod";
import { addNote, listNotes, removeNote } from "@/core/gm-notes";
import { campaignId, jsonRoute } from "@/server/route";

// The GM's secret notes: add one, remove one, or just list them.
export const POST = jsonRoute(
  z.object({ campaignId, add: z.string().trim().min(1).max(1000).optional(), noteId: z.number().int().positive().optional() }),
  async ({ campaignId, add, noteId }) => {
    if (add) await addNote(campaignId, add);
    if (noteId) await removeNote(campaignId, noteId);
    return { notes: await listNotes(campaignId) };
  },
);
