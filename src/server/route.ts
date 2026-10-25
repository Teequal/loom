import { z } from "zod";
import { dbReady } from "./db";

// One shape for the JSON API routes: validate the body, run, and turn failures into a short
// message for the page (details go to the server log).
export function jsonRoute<S extends z.ZodType, R>(schema: S, run: (body: z.infer<S>) => Promise<R>, failure = "Something went wrong.") {
  return async (request: Request) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "That request didn't make sense." }, { status: 400 });
    try {
      await dbReady();
      return Response.json(await run(parsed.data));
    } catch (err) {
      console.error(err);
      const message = err instanceof Error && /credit has run out|expired|already saved|open question|no open threads|no session|any more|isn.t recorded|isn.t|can.t/i.test(err.message) ? err.message : failure;
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
