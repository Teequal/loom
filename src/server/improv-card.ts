import type { ImprovOption } from "@/core/improv";

// What the page gets for each option: the readable text and the threads it ties back to.
// The scaffold stays on the server.
export function card(o: ImprovOption, titleOf: Map<number, string>) {
  return {
    headline: o.headline,
    flavour: o.flavour,
    label: o.label,
    text: o.option,
    why: o.why,
    threads: [o.thread_id, ...o.also_ties_to].filter((id) => titleOf.has(id)).map((id) => ({ id, title: titleOf.get(id)! })),
    callback: o.callback,
    // A roll or a fight waits for its result once used.
    needs: (o.scaffold.pillar === "combat" ? "fight" : o.scaffold.hand_off.kind === "roll" ? "roll" : null) as "roll" | "fight" | null,
    pillar: o.scaffold.pillar ?? null,
    surprise: o.surprise ?? null,
    latent: o.latent ?? null,
    choices: o.choices ?? {},
  };
}

/** The card as it's kept in the log, so it can be shown again after a reload. */
export function logged(o: ImprovOption, titleOf: Map<number, string>) {
  const { threads: _t, ...shown } = card(o, titleOf);
  void _t;
  return { ...shown, threadIds: [o.thread_id, ...o.also_ties_to], scaffold: o.scaffold };
}
