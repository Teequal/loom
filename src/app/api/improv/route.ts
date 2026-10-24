import { z } from "zod";
import { improv, type ImprovOption } from "@/core/improv";
import { logAsk } from "@/core/live";
import { loadThreadContexts } from "@/core/retrieval";
import { dbReady } from "@/server/db";

const Body = z.object({
  campaignId: z.number().int().positive(),
  moment: z.string().trim().min(3).max(1000),
  model: z.enum(["haiku", "sonnet", "opus"]).optional(),
  tone: z.number().int().min(0).max(4).optional(),
});

// What the page gets for each option: the readable text and the threads it ties back to.
// The scaffold stays on the server.
function card(o: ImprovOption, titleOf: Map<number, string>) {
  return {
    label: o.label,
    text: o.option,
    why: o.why,
    threads: [o.thread_id, ...o.also_ties_to].filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! })),
    callback: o.callback,
  };
}

// Streams newline-delimited JSON: one {type:"option"} line per option as soon as it's written and
// checked, then {type:"done"} with notes and the call's cost, or {type:"error"}.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Type what the players just did." }, { status: 400 });
  const { campaignId, moment, model, tone } = parsed.data;
  await dbReady();
  const titleOf = new Map((await loadThreadContexts(campaignId)).map((t) => [t.id, t.title]));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await improv(campaignId, moment, "ranked", model, { tone, onOption: (o) => send({ type: "option", option: card(o, titleOf) }) });
        // Every moment asked about goes in the session log; using an option is a separate step.
        const entry = await logAsk(
          campaignId,
          moment,
          result.options.map((o) => ({ label: o.label, text: o.option, threadIds: [o.thread_id, ...o.also_ties_to] })),
        );
        send({
          type: "done",
          entryId: entry.id,
          count: result.options.length,
          // The CLI's "Update with: …" commands don't belong on the page.
          notes: result.notes.map((n) => n.replace(/\s*Update with:.*$/, "")),
          safetyNote: result.safetyNote,
          llm: { model: result.llm.model, seconds: result.llm.latencyMs / 1000, costUsd: result.llm.costUsd, attempts: result.llm.attempts },
        });
      } catch (err) {
        console.error(err);
        send({ type: "error", message: "Loom couldn't come up with options this time. Try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
