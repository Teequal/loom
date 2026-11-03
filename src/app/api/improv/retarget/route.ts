import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { improv, type ScaffoldOption } from "@/core/improv";
import { loadThreadContexts } from "@/core/retrieval";
import { card, logged } from "@/server/improv-card";
import { jsonRoute } from "@/server/route";

// An option's choices: the GM picks who it's for or who acts, and Loom rewrites that one option on
// the same thread and move. The rewrite replaces it in the log, so a reload shows it.
export const POST = jsonRoute(
  z.object({
    entryId: z.number().int().positive(),
    index: z.number().int().min(0).max(5),
    to: z.string().trim().min(1).max(80).optional(),
    lead: z.string().trim().min(1).max(80).optional(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
    tone: z.number().int().min(0).max(4).optional(),
  }),
  async ({ entryId, index, to, lead, model, tone }) => {
    const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
    const old = e?.options[index];
    if (!e || !old) throw new Error("That option isn't in the log any more.");
    if (e.choiceKind) throw new Error("This moment's choice is already made.");
    const s = old.scaffold as ScaffoldOption | undefined;
    const threadId = Number(/\d+/.exec(s?.thread ?? "")?.[0]) || old.threadIds[0];
    const result = await improv(e.campaignId, e.moment, "ranked", model, { tone, push: { threadId, kind: s?.moveInfo?.kind, with: old.threadIds.filter((t) => t !== threadId).slice(0, 1) }, force: { to, lead } });
    const fresh = result.options.find((o) => (!to || o.scaffold.hand_off.to === to)) ?? result.options[0];
    if (!fresh) throw new Error("Loom couldn't rewrite that one. Try another choice.");
    const titleOf = new Map((await loadThreadContexts(e.campaignId)).map((t) => [t.id, t.title]));
    const options = e.options.map((o, i) => (i === index ? logged(fresh, titleOf) : o));
    await db.update(schema.liveEntries).set({ options }).where(eq(schema.liveEntries.id, entryId));
    return { option: card(fresh, titleOf) };
  },
  "Loom couldn't rewrite that option this time. Try again.",
);
