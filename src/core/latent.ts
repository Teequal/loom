import type { Hit } from "./embeddings";
import { activityOf, canArriveNow, presenceOf, type View } from "./world/engine";
import { offeredLately } from "./world/derived";
import type { AnyNode, NodeKey, Thread } from "./world/nodes";
import type { SelectedThread } from "./retrieval";
import type { Move } from "./moves";

// Latent links: connections the records allow but nobody has made. Not new material: an existing
// character or loose end gets tied to what's in play. Two kinds:
// - echo: a detail of someone not here matches the moment (music is played; Faelen is a minstrel).
// - tie: a loose end and someone in the threads have never touched (the party killed Gary; nobody
//   knows why the hunter hunts). The link is the GM's to keep; until then it's only a hint.

// Measured on the enriched copy (9 moments): one clear match stands well above the rest.
export const ECHO_SIMILARITY = 0.55;
const ECHO_Z = 2.5;
const MOTIVE_ROLES = new Set(["seeker", "rival", "obstacle", "creditor", "guardian"]);

type Latent = Omit<Move, "id" | "resting">;
const nodeOfEntity = (v: View, id: number) => [...v.g.nodes.values()].find((n) => n.id === id && n.kind !== "thread" && n.kind !== "moment" && n.kind !== "session" && n.kind !== "rule");
const isOpen = (t: AnyNode | undefined): t is Thread => t?.kind === "thread" && t.status !== "resolved";

/** Entity ids a moment's meaning reaches through one detail, for the scene to include them. */
export const echoIds = (facets: Hit[]) => [...new Set(facets.filter((h) => h.sim >= ECHO_SIMILARITY && h.z >= ECHO_Z).map((h) => h.ownerId))].slice(0, 3);

/** The moment's subject matter: who's acting says nothing about what it's about. */
export function withoutParty(moment: string, pcs: string[]) {
  const names = pcs.filter((n) => n.length > 2).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(?:the party|${[...names, "party"].join("|")})(?:'s)?\\b`, "gi");
  return moment.replace(re, " ").replace(/\s+/g, " ").trim() || moment;
}

function threadsOf(v: View, n: AnyNode) {
  return v.g.linksOf(n.key as NodeKey, { type: "in_thread", dir: "out" }).map((l) => ({ role: l.role ?? "involved", thread: v.g.nodes.get(`thread:${l.to.id}` as NodeKey) }));
}

function connected(v: View, a: AnyNode, b: AnyNode) {
  const links = v.g.linksOf(a.key as NodeKey, { dir: "both" });
  if (links.some((l) => l.from.id === b.id || l.to.id === b.id)) return true;
  const mine = new Set(threadsOf(v, a).map((t) => t.thread?.key));
  return threadsOf(v, b).some((t) => mine.has(t.thread?.key));
}

function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

export function latentMoves(v: View, threads: SelectedThread[], facets: Hit[], seed: string): Latent[] {
  const memo = new Map();
  const recent = offeredLately(v).sources;
  const named = new Set([...v.reading.broughtIn, ...v.reading.referred, ...v.reading.contacted, ...v.reading.acting]);
  const out: Latent[] = [];

  // Echoes: the strongest detail of each person or thing the moment isn't already about.
  const seen = new Set<number>();
  for (const h of facets) {
    if (h.sim < ECHO_SIMILARITY || h.z < ECHO_Z || seen.has(h.ownerId)) continue;
    seen.add(h.ownerId);
    const n = nodeOfEntity(v, h.ownerId);
    if (!n || n.kind === "place" || (n.kind === "character" && (n.side === "pc" || n.status === "dead"))) continue;
    const source = `echo:${n.id}`;
    if (named.has(n.name) || recent.has(source) || presenceOf(v, n.key as NodeKey, memo).role === "here") continue;
    const own = threadsOf(v, n).find((t) => isOpen(t.thread) && threads.some((x) => x.id === t.thread!.id))?.thread as Thread | undefined;
    const t = own?.id ?? threads[0]?.id;
    if (t == null) continue;
    out.push({
      kind: "echo", threads: [t], score: 2 + h.sim,
      cast: n.kind === "item" ? [] : [{ name: n.name, can: canArriveNow(presenceOf(v, n.key as NodeKey, memo)) || (!v.party && presenceOf(v, n.key as NodeKey, memo).where === "unknown") ? "arrive" : "away", part: "lead" }],
      because: `this could be ${n.name}'s doing, unseen: the records say "${h.text}", and nothing has tied that to this moment yet. Show only the trace; the players may catch it`,
      offers: ["a Wisdom (Perception) or Wisdom (Insight) notice roll to catch the link"],
      source,
      latent: `${n.name} may be behind this: ${h.text}`,
    });
  }
  if (out.length) return out.slice(0, 1);

  // Ties: a loose end, and someone in the threads with a part but no recorded reason.
  if (seeded(`${seed}|tie`) >= 0.5) return [];
  const nodes = [...v.g.nodes.values()];
  const loose = nodes.filter((n) => n.kind === "character" && n.side === "npc" && n.status === "dead");
  // The campaign's busiest figures (the main villain) already have their reasons; a loose end ties
  // better to someone smaller.
  const activity = activityOf(v);
  const pairs: Latent[] = [];
  for (const t of threads) {
    for (const l of v.g.linksOf(`thread:${t.id}` as NodeKey, { type: "in_thread", dir: "in" })) {
      if (!MOTIVE_ROLES.has(l.role ?? "")) continue;
      const who = v.g.nodes.get(`${l.from.kind}:${l.from.id}` as NodeKey);
      if (!who || (who.kind !== "character" && who.kind !== "faction") || (who.kind === "character" && (who.side === "pc" || who.status === "dead"))) continue;
      if (activity.get(who.name)?.band === "very active") continue;
      const presence = presenceOf(v, who.key as NodeKey, memo).role;
      if (presence !== "here" && presence !== "reachable") continue;
      for (const g of loose) {
        const source = `tie:${g.id}:${who.id}`;
        if (connected(v, g, who) || recent.has(source)) continue;
        pairs.push({
          kind: "tie", threads: [t.id], score: 2,
          cast: [{ name: who.name, can: presence === "here" ? "act" : canArriveNow(presenceOf(v, who.key as NodeKey, memo)) || (!v.party && presenceOf(v, who.key as NodeKey, memo).where === "unknown") ? "arrive" : "away", part: "lead" }],
          because: `never connected: ${g.name} (${g.summary}) and ${who.name}, the ${l.role} in "${t.title}". Perhaps that's why: a friend, a debt, an old grudge. Let one small detail suggest it; never state it, and ${g.name} stays gone`,
          source,
          latent: `${who.name} may be tied to ${g.name}: a friend, a debt or a grudge from then`,
        });
      }
    }
  }
  return pairs.length ? [pairs[Math.floor(seeded(`${seed}|pick`) * pairs.length)]] : [];
}
