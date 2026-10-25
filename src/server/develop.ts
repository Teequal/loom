import { eq } from "drizzle-orm";
import type { Chain, ChainStep } from "@/core/chain";
import { db, schema } from "@/core/db/client";
import { deltasOf } from "@/core/deltas";
import { scaffoldFor } from "@/core/live";
import type { Steer } from "@/core/moves";

// Develop v2 on the table page: what a chain is developed from, and how chains are kept on the
// entry they grew from (so they survive a reload), with a short history per chain for Back.

type Entry = typeof schema.liveEntries.$inferSelect;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A chain as it's kept: the chain, plus the versions before each rework (newest last). */
export type KeptChain = Chain & { previous?: Chain[] };
export interface ChainDevelopment {
  kind: "chain";
  id: number;
  steer: Steer | null;
  words: string;
  chains: KeptChain[];
}
export const isChainDev = (d: unknown): d is ChainDevelopment => !!d && typeof d === "object" && (d as { kind?: string }).kind === "chain";

/** What the page sees of a step or a chain: everything but the scaffold, which stays on the server. */
export const stepView = (s: ChainStep) => ({ when: s.when, text: s.text, to: s.to, needs: s.needs });
export const chainView = (c: KeptChain) => ({ label: c.label, headline: c.headline, why: c.why, flavour: c.flavour, move: c.move, threads: c.threads, callback: c.callback, steps: c.steps.map(stepView), canGoBack: !!c.previous?.length });
export const developmentView = (d: unknown) => (isChainDev(d) ? { kind: "chain" as const, id: d.id, steer: d.steer, words: d.words, chains: d.chains.map(chainView) } : d);

async function entry(entryId: number) {
  const [e] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, entryId));
  if (!e) throw new Error("That moment isn't in the log any more.");
  return e;
}

/**
 * What a chain grows from: the moment at the table and everything chosen since (the entry's
 * ancestors), then the entry's own choice. A step of an earlier chain gets a shorter chain.
 */
export async function chainBase(entryId: number) {
  const e = await entry(entryId);
  const line: Entry[] = [e];
  for (let up = e.parentId; up != null && line.length < 8; ) {
    const [p] = await db.select().from(schema.liveEntries).where(eq(schema.liveEntries.id, up));
    if (!p) break;
    line.unshift(p);
    up = p.parentId;
  }
  const root = line[0];
  // What the choice changed and the turn it ended on, from the engine's own scaffold when there is
  // one (an option or a step), so nothing has to be read back out of the sentence.
  const scaffold = await scaffoldFor(e);
  const pcs = new Set((await db.select({ name: schema.entities.name, type: schema.entities.type }).from(schema.entities).where(eq(schema.entities.campaignId, e.campaignId))).filter((x) => x.type === "pc").map((x) => x.name));
  const d = scaffold ? deltasOf(scaffold, () => true) : null;
  const before = line.slice(0, -1).map((x) => clip(`${x.choiceLabel ? `${x.choiceLabel}: ` : ""}${x.choice}`, 300)).filter((x) => x.trim());
  return {
    campaignId: e.campaignId,
    moment: [root.moment, ...before.map((b) => `→ ${b}`)].join("\n"),
    label: e.choiceLabel,
    text: e.choice || e.moment,
    from: e.choiceKind === "branch" || e.choiceKind === "result" ? ("step" as const) : ("option" as const),
    turn: scaffold ? (scaffold.hand ?? null) : undefined,
    overrides: d && (d.arrivals.length || d.handovers.length) ? { here: d.arrivals, away: [], inHand: d.handovers.filter((h) => pcs.has(h.to)).map((h) => ({ pc: h.to, item: h.item })), notInHand: [], rulesOn: [], rulesOff: [] } : undefined,
  };
}

async function save(entryId: number, developments: unknown[]) {
  await db.update(schema.liveEntries).set({ developments: developments.slice(-5) }).where(eq(schema.liveEntries.id, entryId));
}

/** New chains for an entry, or more chains added to one of its developments (another take). */
export async function keepChains(entryId: number, dev: { id?: number; steer: Steer | null; words: string }, chains: Chain[]) {
  const e = await entry(entryId);
  const existing = dev.id ? e.developments.find((d) => isChainDev(d) && d.id === dev.id) : undefined;
  if (isChainDev(existing)) {
    await save(entryId, e.developments.map((d) => (d === existing ? { ...existing, chains: [...existing.chains, ...chains] } : d)));
    return existing.id;
  }
  const id = Date.now();
  await save(entryId, [...e.developments, { kind: "chain", id, steer: dev.steer, words: dev.words, chains } satisfies ChainDevelopment]);
  return id;
}

export async function keptChain(entryId: number, devId: number, index: number) {
  const e = await entry(entryId);
  const d = e.developments.find((x) => isChainDev(x) && x.id === devId);
  const chain = isChainDev(d) ? d.chains[index] : undefined;
  if (!isChainDev(d) || !chain) throw new Error("That development isn't on this moment any more.");
  return { dev: d, chain };
}

/** A reworked chain replaces the old one, which goes on its history for Back (up to 5). */
export async function replaceChain(entryId: number, devId: number, index: number, next: Chain) {
  const e = await entry(entryId);
  const { chain } = await keptChain(entryId, devId, index);
  const { previous = [], ...old } = chain;
  const kept: KeptChain = { ...next, previous: [...previous, old].slice(-5) };
  await save(entryId, e.developments.map((d) => (isChainDev(d) && d.id === devId ? { ...d, chains: d.chains.map((c, i) => (i === index ? kept : c)) } : d)));
  return kept;
}

/** Back: the version before the last rework. */
export async function chainBack(entryId: number, devId: number, index: number) {
  const e = await entry(entryId);
  const { chain } = await keptChain(entryId, devId, index);
  const previous = chain.previous ?? [];
  if (!previous.length) return chain;
  const back: KeptChain = { ...previous[previous.length - 1], previous: previous.slice(0, -1) };
  await save(entryId, e.developments.map((d) => (isChainDev(d) && d.id === devId ? { ...d, chains: d.chains.map((c, i) => (i === index ? back : c)) } : d)));
  return back;
}
