import { z } from "zod";
import { asWho } from "@/core/access";
import { mayTouch, NEEDS_INVITE, NOT_YOURS, whoIs } from "./access";
import { dbReady } from "./db";

// One shape for the JSON API routes: validate the body, run, and turn failures into a short
// message for the page (details go to the server log).
export function jsonRoute<S extends z.ZodType, R>(schema: S, run: (body: z.infer<S>) => Promise<R>, failure = "Something went wrong.") {
  return async (request: Request) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "That request didn't make sense." }, { status: 400 });
    try {
      await dbReady();
      const who = await whoIs(request);
      if (!who) return NEEDS_INVITE();
      if (!(await mayTouch(who, parsed.data))) return NOT_YOURS();
      return Response.json(await asWho(who, () => run(parsed.data)));
    } catch (err) {
      console.error(err);
      const message = err instanceof Error && /credit has run out|AI allowance|switched off|expired|already saved|open question|no open threads|no session|any more|isn.t recorded|isn.t|can.t/i.test(err.message) ? err.message : failure;
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

export const campaignId = z.number().int().positive();

// The GM's corrections from the scene chips (see situation.ts Overrides).
const Pair = z.object({ pc: z.string().max(120), item: z.string().max(120) });
export const overrides = z
  .object({
    here: z.array(z.string().max(120)).max(30),
    away: z.array(z.string().max(120)).max(30),
    inHand: z.array(Pair).max(20),
    notInHand: z.array(Pair).max(20),
    rulesOn: z.array(z.string().max(120)).max(20),
    rulesOff: z.array(z.string().max(120)).max(20),
  })
  .partial();

/**
 * A route that streams newline-delimited JSON: `send` writes one event per line as things are
 * ready, and the route ends with whatever `run` returns as {type:"done", ...}, or {type:"error"}.
 */
export function streamRoute<S extends z.ZodType>(schema: S, run: (body: z.infer<S>, send: (event: object) => void) => Promise<object>, failure = "Something went wrong.") {
  return async (request: Request) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "That request didn't make sense." }, { status: 400 });
    await dbReady();
    const who = await whoIs(request);
    if (!who) return NEEDS_INVITE();
    if (!(await mayTouch(who, parsed.data))) return NOT_YOURS();
    const encoder = new TextEncoder();
    // If the page goes away mid-stream (a reload, a phone locking), the work still finishes and is
    // saved; there's just no one left to tell.
    let gone = false;
    const stream = new ReadableStream({
      cancel() {
        gone = true;
      },
      async start(controller) {
        const send = (event: object) => {
          if (gone) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            gone = true;
          }
        };
        try {
          send({ type: "done", ...(await asWho(who, () => run(parsed.data, send))) });
        } catch (err) {
          console.error(err);
          send({ type: "error", message: err instanceof Error && /credit has run out|AI allowance|switched off|any more|isn.t on this/i.test(err.message) ? err.message : failure });
        } finally {
          if (!gone) controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  };
}
