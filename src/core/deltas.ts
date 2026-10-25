import type { ScaffoldOption } from "./improv";

// What a scaffolded choice changes in the world, read from its structure rather than its prose:
// who arrives, which items change hands, which threads it moves. The engine built these when it
// built the option or step, so a used choice can be applied to the loom directly (no extraction),
// and Develop can start from the world as the choice left it.

export interface Deltas {
  arrivals: string[]; // named characters who arrive (kind "arrival")
  handovers: { item: string; to: string }[]; // "tosses the {X} to {Y}"
  thread: number | null; // the main thread it moves
  alsoThreads: number[];
}

const TAGGED = /\{([^}|]+)(?:\|[^}]*)?\}/g;
const HANDOVER = /\{([^}|]+)(?:\|[^}]*)?\}[^{]{0,40}?\bto\s+\{([^}|]+)(?:\|[^}]*)?\}/g;

/** The deltas of a scaffold. `isItem` says whether a name is an item (from the tagger or records). */
export function deltasOf(o: Pick<ScaffoldOption, "setup" | "thread" | "also_ties_to">, isItem: (name: string) => boolean): Deltas {
  const arrivals = [...new Set(o.setup.filter((b) => b.kind === "arrival" && b.actor !== "walk-on" && b.actor !== "world").map((b) => b.actor))];
  const handovers: Deltas["handovers"] = [];
  for (const b of o.setup) for (const m of b.does.matchAll(HANDOVER)) if (isItem(m[1].trim())) handovers.push({ item: m[1].trim(), to: m[2].trim() });
  const id = (ref: string) => Number(String(ref).replace(/^T/, "")) || null;
  const thread = id(o.thread);
  return { arrivals, handovers, thread, alsoThreads: (o.also_ties_to ?? []).map(id).filter((x): x is number => x != null && x !== thread) };
}

/** Names written in braces in a tagged sentence. */
export const taggedNames = (s: string) => [...s.matchAll(TAGGED)].map((m) => m[1].trim());

/** A tagged sentence as plain words ("{Mother Ysolde|Ysolde} smiles" → "Ysolde smiles"). */
export const untag = (s: string) => s.replace(/\{([^}|]+)(?:\|([^}]*))?\}/g, (_, n: string, r?: string) => (r ?? n).trim());
