import { z } from "zod";
import { aftermath } from "@/core/aftermath";
import { jsonRoute } from "@/server/route";

export const POST = jsonRoute(z.object({ entryId: z.number().int().positive() }), ({ entryId }) => aftermath(entryId), "Loom couldn't work out the aftermath this time. Try again.");
