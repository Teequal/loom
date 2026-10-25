import type { MomentReading } from "../moment-reading";
import { capabilitiesOf, type Capabilities } from "../rules";
import type { Graph } from "./load";
import { LINK_TYPES, THREAD_ROLES, type Link } from "./links";
import type { AnyNode, Character, Item, NodeKey, Place, Rule, Thread } from "./nodes";

// The engine's questions (docs/design-2026-10-25-world-model.md §6), answered from the world model
// by calculation: who's here, who has what, who can act, which rules fire, how ripe a thread is.
// A View is the graph as it stands for one moment: the records, plus what the moment changes
// (provisionally, for this call) and the GM's corrections.

export interface Corrections {
  here?: string[];
  away?: string[];
  inHand?: { pc: string; item: string }[];
  notInHand?: { pc: string; item: string }[];
  rulesOn?: string[];
  rulesOff?: string[];
}

export type Role = "here" | "reachable" | "remembered" | "player";
// Finer than the role, for cards and chips: where the records put them relative to the party.
export type Where = "here" | "with-party" | "nearby" | "elsewhere" | "unknown";

export interface View {
  g: Graph;
  reading: MomentReading;
  corrections: Corrections;
  party: Place | null; // where the party is for this moment
  recordedParty: Place | null;
  body: Map<NodeKey, Character["body"]>; // with what the moment states (conditions)
  provisional: { holder: NodeKey; item: NodeKey }[]; // the moment (or the GM) puts an item with a PC
  notes: string[];
  stated: string[];
  conditionFixes: { pc: Character; condition: string }[];
  holdFixes: { pc: Character; item: Item; records: string }[];
}

const keyOfNode = (n: AnyNode) => n.key as NodeKey;
const endKey = (e: { kind: string; id: number }) => `${e.kind}:${e.id}` as NodeKey;

export function viewOf(g: Graph, reading: MomentReading, corrections: Corrections = {}): View {
  const node = (name: string) => g.find(name);
  const partyAt = g.linksOf("party:0", { type: "located_at", dir: "out" })[0];
  const recordedParty = partyAt ? ((g.nodes.get(endKey(partyAt.to)) as Place) ?? null) : null;
  const moved = reading.goesTo ? (node(reading.goesTo) as Place | undefined) : undefined;
  const v: View = {
    g,
    reading,
    corrections,
    party: moved?.kind === "place" ? moved : recordedParty,
    recordedParty,
    body: new Map(),
    provisional: [],
    notes: [],
    stated: [],
    conditionFixes: [],
    holdFixes: [],
  };
  if (moved?.kind === "place" && moved.key !== recordedParty?.key) v.notes.push(`This moment takes the party to ${moved.name}; your records have them at ${recordedParty?.name ?? "no recorded place"}.`);

  // Conditions the moment states, for this call.
  for (const { pc: name, condition } of reading.conditions) {
    const pc = node(name);
    if (pc?.kind !== "character") continue;
    const body = { ...pc.body, conditions: [...pc.body.conditions] };
    const has = condition === "unconscious" ? body.health === "unconscious" || body.conditions.some((c) => c.name === "unconscious") : body.conditions.some((c) => c.name.toLowerCase() === condition);
    if (has) continue;
    if (condition === "unconscious") body.health = "unconscious";
    else body.conditions.push({ name: condition, is5e: true });
    v.body.set(keyOfNode(pc), body);
    v.conditionFixes.push({ pc, condition });
    v.notes.push(`This moment has ${pc.name} ${condition}; your records don't.`);
    v.stated.push(`${pc.name} is ${condition} (${condition === "unconscious" ? "can't act, speak or notice anything; death saves only" : "per the 5e condition"})`);
  }

  // Items the moment (or the GM) puts with a PC: the most specific item named, unless corrected.
  const misread = (pc: string, item: string) => (corrections.notInHand ?? []).some((x) => x.pc === pc && x.item === item);
  const named = reading.inHand.filter((h) => !reading.inHand.some((o) => o !== h && o.pc === h.pc && isInside(v, node(o.item), node(h.item))));
  for (const { pc: pcName, item: itemName } of [...named.filter((h) => !misread(h.pc, h.item)), ...(corrections.inHand ?? [])]) {
    const pc = node(pcName);
    const item = node(itemName);
    if (pc?.kind !== "character" || item?.kind !== "item") continue;
    if (holdersOf(v, keyOfNode(item)).some((h) => h.holder === keyOfNode(pc))) continue;
    const recorded = recordedHolders(v, keyOfNode(item)).map((k) => g.nodes.get(k)!.name);
    v.provisional.push({ holder: keyOfNode(pc), item: keyOfNode(item) });
    const records = item.status === "lost" && !recorded.length ? "Your records say it's lost." : recorded.length ? `Your records say ${recorded.join(" and ")} ${recorded.length > 1 ? "hold" : "holds"} it.` : null;
    if (records) {
      v.holdFixes.push({ pc, item, records });
      v.notes.push(`${records} This moment has ${pc.name} with ${item.name}.`);
    }
  }
  return v;
}

// ---------- Places ----------

/** The place and everything it's inside, nearest first. */
export function placeChain(v: View, key: NodeKey | null | undefined): NodeKey[] {
  const out: NodeKey[] = [];
  for (let cur = key ?? null, hops = 0; cur && hops < 20; hops++) {
    out.push(cur);
    const up = v.g.linksOf(cur, { type: "inside", dir: "out" })[0];
    cur = up ? endKey(up.to) : null;
  }
  return out;
}
const within = (v: View, inner: NodeKey | null | undefined, outer: NodeKey | null | undefined) => !!inner && !!outer && placeChain(v, inner).includes(outer);
const near = (v: View, a: NodeKey | null | undefined, b: NodeKey | null | undefined) => within(v, a, b) || within(v, b, a);

/** Where something is: an actual place over a last-seen one. */
export function whereIs(v: View, key: NodeKey): Place | null {
  const ls = v.g.linksOf(key, { type: "located_at", dir: "out" });
  const pick = ls.find((l) => l.certainty !== "last-seen") ?? ls[0];
  return pick ? ((v.g.nodes.get(endKey(pick.to)) as Place) ?? null) : null;
}

// ---------- Possession ----------

function isInside(v: View, item: AnyNode | undefined, container: AnyNode | undefined) {
  return !!item && !!container && placeChain(v, keyOfNode(item)).slice(1).includes(keyOfNode(container));
}
/** Pieces of a set (items inside it), at any depth. */
function piecesOf(v: View, key: NodeKey): NodeKey[] {
  const out: NodeKey[] = [];
  const walk = (k: NodeKey, depth: number) => {
    if (depth > 6) return;
    for (const l of v.g.linksOf(k, { type: "inside", dir: "in" })) {
      const child = endKey(l.from);
      if (v.g.nodes.get(child)?.kind === "item") {
        out.push(child);
        walk(child, depth + 1);
      }
    }
  };
  walk(key, 0);
  return out;
}
/** Who the records say holds it directly (a lost item has nobody). */
function recordedHolders(v: View, item: NodeKey): NodeKey[] {
  const n = v.g.nodes.get(item);
  if (n?.kind !== "item" || n.status === "lost" || n.status === "destroyed") return [];
  return v.g.linksOf(item, { type: "holds", dir: "in" }).map((l) => endKey(l.from));
}
/** Who has it now: directly, through its set, or by holding one of its pieces; the moment counts. */
export function holdersOf(v: View, item: NodeKey): { holder: NodeKey; via?: NodeKey }[] {
  const direct = (k: NodeKey) => [...recordedHolders(v, k), ...v.provisional.filter((p) => p.item === k).map((p) => p.holder)];
  const out: { holder: NodeKey; via?: NodeKey }[] = direct(item).map((holder) => ({ holder }));
  for (const set of placeChain(v, item).slice(1)) for (const holder of direct(set)) out.push({ holder, via: set });
  for (const piece of piecesOf(v, item)) for (const holder of direct(piece)) out.push({ holder, via: piece });
  return out;
}

// ---------- Characters ----------

export function bodyOf(v: View, c: Character) {
  return v.body.get(keyOfNode(c)) ?? c.body;
}
export function capabilities(v: View, c: Character): Capabilities {
  const body = bodyOf(v, c);
  return capabilitiesOf({ status: c.status, traits: { health: body.health === "dead" ? undefined : body.health, conditions: body.conditions.map((x) => x.name) } });
}
const COMPANION = new Set(["ally", "serves", "family", "romance", "loves", "trusts"]);
function isCompanion(v: View, c: Character) {
  return v.g.linksOf(keyOfNode(c), {}).some((l) => {
    if (!COMPANION.has(l.type)) return false;
    const other = v.g.nodes.get(v.g.other(l, keyOfNode(c)));
    return other?.kind === "character" && other.side === "pc";
  });
}

// ---------- Presence ----------

export interface Presence {
  role: Role;
  where: Where;
  standing: string; // in words: "lost, last seen at the River Morrow"
  why: string; // for chips and messages
}

export function presenceOf(v: View, key: NodeKey, memo = new Map<NodeKey, Presence>()): Presence {
  const hit = memo.get(key);
  if (hit) return hit;
  const n = v.g.nodes.get(key);
  const set = (p: Presence) => (memo.set(key, p), p);
  if (!n) return set({ role: "reachable", where: "unknown", standing: "unknown", why: "not in the records" });
  const away = (v.corrections.away ?? []).includes(n.name);
  const said = (v.corrections.here ?? []).includes(n.name);
  const reading = v.reading;
  const place = whereIs(v, key);
  const placeName = place?.name;

  if (n.kind === "character") {
    if (n.side === "pc") {
      const body = bodyOf(v, n);
      const state = [n.status && n.status !== "alive" ? n.status : "", body.health && body.health !== "healthy" ? body.health : "", ...body.conditions.map((c) => c.name)].filter(Boolean).join(", ");
      // Still the players' to run, but a captive or missing PC isn't with the party.
      const apart = n.status === "captured" || n.status === "missing";
      return set({ role: "player", where: apart ? "elsewhere" : "with-party", standing: state ? `a player character (${state})` : "a player character", why: apart ? `${n.status}, away from the party` : "a player character" });
    }
    if (n.status === "dead") return set({ role: "remembered", where: "elsewhere", standing: `dead${placeName ? `, died at ${placeName}` : ""}`, why: "dead" });
    if (away) return set({ role: "reachable", where: "elsewhere", standing: "not here (you said so)", why: "you said they're not here" });
    if (n.status === "captured") return set({ role: "reachable", where: "elsewhere", standing: `captured${placeName ? ` at ${placeName}` : ""}: acts only by escaping or getting word out`, why: "captured" });
    if (n.status === "missing") return set({ role: "reachable", where: "unknown", standing: "missing", why: "missing" });
    if (said || reading.broughtIn.has(n.name)) return set({ role: "here", where: "here", standing: "here: the moment brings them in", why: said ? "you said they're here" : "the moment brings them in" });
    if (reading.contacted.has(n.name)) return set({ role: "reachable", where: "elsewhere", standing: placeName ? `at ${placeName}; the players reach them from afar` : "reached from afar", why: "the players reach them from afar" });
    if (isCompanion(v, n) && place && near(v, keyOfNode(place), v.recordedParty && keyOfNode(v.recordedParty))) return set({ role: "here", where: "with-party", standing: "travelling with the party", why: "travelling with the party" });
    if (place && v.party && near(v, keyOfNode(place), keyOfNode(v.party))) return set({ role: "reachable", where: "nearby", standing: `somewhere around here (${place.name}), not with the party`, why: reading.referred.has(n.name) ? "only mentioned in the moment" : "recorded around here, not with the party" });
    return set({ role: "reachable", where: place ? "elsewhere" : "unknown", standing: place ? `last seen at ${place.name}` : "whereabouts unknown", why: reading.referred.has(n.name) ? "only mentioned in the moment" : place ? "recorded elsewhere" : "whereabouts unknown" });
  }

  if (n.kind === "item") {
    if (n.status === "destroyed") return set({ role: "remembered", where: "elsewhere", standing: "destroyed", why: "destroyed" });
    const hs = holdersOf(v, key);
    const withHolder = hs.map((h) => ({ ...h, p: presenceOf(v, h.holder, memo) }));
    const label = (h: { holder: NodeKey; via?: NodeKey }) => `${v.g.nodes.get(h.holder)?.name}${h.via ? ` (${v.g.nodes.get(h.via)?.kind === "item" && placeChain(v, key).includes(h.via) ? `with ${v.g.nodes.get(h.via)?.name}` : `the ${v.g.nodes.get(h.via)?.name}`})` : ""}`;
    const here = withHolder.find((h) => h.p.role === "here" || (h.p.role === "player" && h.p.where === "with-party"));
    if (here) return set({ role: "here", where: "here", standing: `held by ${label(here)}`, why: `held by ${v.g.nodes.get(here.holder)?.name}` });
    if (n.status === "lost") return set({ role: "remembered", where: "elsewhere", standing: `lost${placeName ? `, last seen at ${placeName}` : ""}`, why: "lost: nobody has it" });
    if (withHolder.length) return set({ role: "reachable", where: "elsewhere", standing: `held by ${withHolder.map(label).join(", ")}`, why: "someone not here has it" });
    // At the party's own place, or somewhere inside it when the party is in a building or room
    // (not merely in the same city).
    const small = v.party?.scale === "building" || v.party?.scale === "room" || v.party?.scale === "site";
    if (place && v.party && (place.key === v.party.key || (small && within(v, keyOfNode(place), keyOfNode(v.party)))))
      return set({ role: "here", where: "here", standing: `here, at ${place.name}`, why: "at the party's place" });
    if (reading.mentions.some((m) => m.entity.name === n.name && m.role !== "refers")) return set({ role: "here", where: "here", standing: "here: the moment names it", why: "the moment names it" });
    return set({ role: "reachable", where: place ? "elsewhere" : "unknown", standing: place ? `at ${place.name}` : "whereabouts unknown", why: place ? `at ${place.name}` : "whereabouts unknown" });
  }

  if (n.kind === "place") {
    if (n.status === "destroyed") return set({ role: "remembered", where: "elsewhere", standing: "destroyed", why: "destroyed" });
    const p = v.party && keyOfNode(v.party);
    if (p && (p === key || within(v, p, key))) return set({ role: "here", where: "here", standing: p === key ? "where the party is" : "the party is inside it", why: "the party is here" });
    if (p && within(v, key, p)) return set({ role: "reachable", where: "nearby", standing: `nearby, within ${v.party!.name}`, why: "nearby" });
    return set({ role: "reachable", where: "elsewhere", standing: "elsewhere", why: "elsewhere" });
  }

  if (n.kind === "faction" || n.kind === "other") {
    if (n.status === "disbanded" || n.status === "destroyed") return set({ role: "remembered", where: "elsewhere", standing: n.status, why: n.status });
    const members = v.g
      .linksOf(key, { dir: "in" })
      .filter((l) => l.type === "member_of" || l.type === "leads")
      .map((l) => endKey(l.from));
    const membersHere = members.filter((m) => presenceOf(v, m, memo).role === "here");
    if (membersHere.length) return set({ role: "here", where: "here", standing: `through ${membersHere.map((m) => v.g.nodes.get(m)?.name).join(", ")}`, why: "its members are here" });
    if (said || reading.broughtIn.has(n.name)) return set({ role: "here", where: "here", standing: "here: the moment brings them in", why: "the moment brings them in" });
    return set({ role: "reachable", where: "elsewhere", standing: "acts through its agents (a messenger, an arrival)", why: "acts through its agents" });
  }
  return set({ role: "reachable", where: "unknown", standing: "", why: "" });
}

// ---------- House rules ----------

export interface LiveRule {
  rule: Rule;
  source: AnyNode | null;
  targets: string[]; // PCs it reaches now
  holders: string[];
  tableWide: boolean;
  live: boolean; // its trigger has happened
  why: string;
  text: string; // one line for prompts
}

export function liveRules(v: View): LiveRule[] {
  const pcs = [...v.g.nodes.values()].filter((n): n is Character => n.kind === "character" && n.side === "pc" && n.status !== "dead" && capabilities(v, n).aware);
  const used = new Set([...v.reading.used].map((n) => v.g.find(n)).filter((n): n is AnyNode => !!n).map(keyOfNode));
  return [...v.g.nodes.values()]
    .filter((n): n is Rule => n.kind === "rule")
    .map((rule) => {
      const sl = v.g.linksOf(keyOfNode(rule), { type: "source_of", dir: "in" })[0];
      const source = sl ? (v.g.nodes.get(endKey(sl.from)) ?? null) : null;
      const sourceKey = source ? keyOfNode(source) : null;
      // Holders of the source or anything in it (a rule on a set reaches every piece).
      const subtree = sourceKey ? [sourceKey, ...piecesOf(v, sourceKey)] : [];
      const holding = subtree.flatMap((k) => [...recordedHolders(v, k), ...v.provisional.filter((p) => p.item === k).map((p) => p.holder)].map((h) => ({ h, item: k })));
      const holderNames = [...new Set(holding.map((x) => v.g.nodes.get(x.h)?.name).filter((x): x is string => !!x))];
      const holders = holding.map((x) => (x.item === sourceKey ? v.g.nodes.get(x.h)!.name : `${v.g.nodes.get(x.h)!.name} (${v.g.nodes.get(x.item)!.name})`));
      const placeBound = source?.kind === "place";
      const partyThere = placeBound ? !!v.party && within(v, keyOfNode(v.party), sourceKey) : true;
      let targets: string[] = [];
      let tableWide = false;
      if (partyThere) {
        if (rule.appliesTo === "holder" || rule.appliesTo === "user") targets = pcs.filter((p) => holderNames.includes(p.name)).map((p) => p.name);
        else if (rule.appliesTo === "everyone-except-holder") [targets, tableWide] = [pcs.filter((p) => !holderNames.includes(p.name)).map((p) => p.name), true];
        else if (["everyone-present", "party", "source-target"].includes(rule.appliesTo)) [targets, tableWide] = [pcs.map((p) => p.name), true];
        else if (rule.appliesTo === "listed") targets = v.g.linksOf(keyOfNode(rule), { type: "applies_to", dir: "out" }).map((l) => v.g.nodes.get(endKey(l.to))).filter((n): n is Character => n?.kind === "character" && n.side === "pc").map((p) => p.name);
      }
      const usedNow = subtree.find((k) => used.has(k)) ?? [...used].find((u) => sourceKey && within(v, sourceKey, u));
      const base = { rule, source, targets, holders, tableWide };
      const text = [
        `${rule.name}${rule.secret ? " [GM secret]" : ""}`,
        source && `from ${source.name}`,
        rule.trigger.replace(/-/g, " "),
        `applies to: ${rule.appliesTo.replace(/-/g, " ")}${targets.length ? ` → now ${targets.join(", ")}` : " → nobody right now"}`,
        holders.length && `held by ${holders.join(", ")}`,
        rule.check && `check: ${rule.check}`,
        rule.onFail && `on fail: ${rule.onFail}`,
        rule.escalation && `escalates: ${rule.escalation}`,
        rule.summary && !(rule.check && rule.onFail) && `rule: ${rule.summary}`,
      ]
        .filter(Boolean)
        .join("; ");
      if (!targets.length) return { ...base, live: false, why: "it reaches nobody right now", text };
      if ((v.corrections.rulesOff ?? []).includes(rule.name)) return { ...base, live: false, why: "you said it isn't triggered", text };
      if ((v.corrections.rulesOn ?? []).includes(rule.name)) return { ...base, live: true, why: "you said it's triggered", text };
      if (rule.trigger === "on-use" || rule.trigger === "on-touch")
        return usedNow ? { ...base, live: true, why: `the moment uses ${v.g.nodes.get(usedNow)?.name}`, text } : { ...base, live: false, why: `nobody uses ${source?.name ?? "its source"} in this moment`, text };
      return { ...base, live: true, why: `it reaches ${targets.join(", ")}`, text };
    });
}

// ---------- Threads ----------

/** A node's part in each thread: the same links read from the node's end. */
export function threadsOf(v: View, key: NodeKey): { thread: Thread; role: string; secret: boolean; link: Link }[] {
  return v.g
    .linksOf(key, { type: "in_thread", dir: "out" })
    .map((link) => ({ link, thread: v.g.nodes.get(endKey(link.to)) as Thread, role: link.role ?? "involved", secret: link.secret }))
    .filter((x) => x.thread?.kind === "thread" && x.thread.status !== "resolved");
}

/** How hot a thread is: stakes, recency, how often it's moved, a deadline. Ripe threads are ready to pay off. */
export function heat(v: View, t: Thread): { score: number; ripe: boolean } {
  const latest = Math.max(0, ...[...v.g.nodes.values()].filter((n) => n.kind === "session").map((n) => (n as { number: number }).number));
  const gap = t.lastTouched != null ? Math.max(0, latest - t.lastTouched) : 3;
  const level = t.stakes.level ?? 2;
  const moved = t.steps.filter((s) => s.change === "progressed").length;
  const score = level * (0.5 + 1 / (1 + gap)) + Math.min(moved, 3) * 0.3 + (t.deadline ? 1 : 0);
  return { score: Math.round(score * 10) / 10, ripe: t.status === "ripe" || score >= 4.5 };
}

// ---------- Profiles: what matters about each node, for this moment ----------

const MOOD = ["despairing", "grim", "uneasy", "steady", "upbeat", "confident", "elated"];
const short = (s: string | undefined, n = 100) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : (s ?? ""));

export interface Profile {
  node: AnyNode;
  presence: Presence;
  facts: string[];
  threads: string[]; // "victim of Darius caged by guards"
}

export function profileOf(v: View, key: NodeKey, memo?: Map<NodeKey, Presence>): Profile {
  const n = v.g.nodes.get(key)!;
  const presence = presenceOf(v, key, memo);
  const facts: string[] = [];
  if (n.kind === "character") {
    const body = bodyOf(v, n);
    const caps = capabilities(v, n);
    const cant = (["act", "speak", "aware"] as const).filter((k) => !caps[k]);
    if (n.mind.mood != null) facts.push(`mood: ${MOOD[n.mind.mood + 3]}`);
    if (n.side === "npc" && n.stance != null) facts.push(`${["hostile", "hostile", "unfriendly", "indifferent", "friendly", "helpful", "devoted"][n.stance + 3]} to the party`);
    if (body.health && body.health !== "healthy" && n.side === "npc") facts.push(`health: ${body.health}`);
    if (body.conditions.length && n.side === "npc") facts.push(`conditions: ${body.conditions.map((c) => c.name).join(", ")}`);
    if (cant.length) facts.push(`can't ${cant.join(", ")}`);
    const goals = [...n.mind.goals].sort((a, b) => a.priority - b.priority).slice(0, 2);
    if (goals.length) facts.push(`wants: ${goals.map((g) => short(g.text, 70)).join("; ")}`);
    for (const b of n.mind.beliefs.slice(0, 2)) facts.push(`believes ${b.text}${b.true === false ? " (it isn't true)" : ""}`);
    if (n.abilities.length) facts.push(`abilities: ${n.abilities.slice(0, 2).map((a) => short(a.name, 60)).join("; ")}`);
    const ties = v.g
      .linksOf(key, {})
      .filter((l) => LINK_TYPES[l.type]?.group === "tie")
      .map((l) => ({ l, o: v.g.nodes.get(v.g.other(l, key)) }))
      .filter((x) => x.o?.kind === "character" && x.o.side === "pc" && n.side === "npc")
      .slice(0, 3)
      .map((x) => (endKey(x.l.from) === key || LINK_TYPES[x.l.type]?.symmetric ? `${x.l.type.replace(/_/g, " ")} ${x.o!.name}` : `${x.o!.name} ${x.l.type.replace(/_/g, " ")} them`));
    if (ties.length) facts.push(`ties: ${ties.join("; ")}`);
    const has = [...v.g.nodes.values()].filter((i): i is Item => i.kind === "item" && holdersOf(v, keyOfNode(i)).some((h) => h.holder === key && !h.via)).map((i) => i.name);
    if (has.length) facts.push(`has ${has.join(", ")}`);
  } else if (n.kind === "item") {
    const set = placeChain(v, key)[1];
    if (set && v.g.nodes.get(set)?.kind === "item") facts.push(`one of ${v.g.nodes.get(set)!.name}`);
    const pieces = piecesOf(v, key).map((k) => v.g.nodes.get(k)!.name);
    if (pieces.length) facts.push(`pieces: ${pieces.join(", ")}`);
    if (n.properties.known) facts.push(`does: ${short(n.properties.known)}`);
    if (n.properties.cost) facts.push(`cost of use: ${short(n.properties.cost, 80)}`);
    if (n.status && !["intact", "lost", "unknown"].includes(n.status)) facts.push(n.status);
    if (n.sharedPossession) facts.push("shared by several");
  } else if (n.kind === "place") {
    if (n.hazards.length) facts.push(`hazards: ${n.hazards.slice(0, 2).join("; ")}`);
    if (n.atmosphere.length) facts.push(`feels: ${n.atmosphere.slice(0, 2).join("; ")}`);
  } else if (n.kind === "faction" || n.kind === "other") {
    const members = v.g.linksOf(key, { dir: "in" }).filter((l) => l.type === "member_of" || l.type === "leads").map((l) => v.g.nodes.get(endKey(l.from))?.name).filter(Boolean);
    if (members.length) facts.push(`members: ${members.slice(0, 4).join(", ")}`);
  }
  // Its parts in open threads, most at stake first; GM-only parts are marked, never stated.
  const threads = threadsOf(v, key)
    .sort((a, b) => (b.thread.stakes.level ?? 2) - (a.thread.stakes.level ?? 2))
    .slice(0, 3)
    .map((x) => `${x.role === "involved" ? "in" : `${x.role} in`} "${x.thread.name}"${x.secret ? " [GM secret]" : ""}${heat(v, x.thread).ripe ? " (ripe)" : ""}`);
  return { node: n, presence, facts, threads };
}

export function profileLine(p: Profile) {
  const n = p.node;
  const kind = n.kind === "character" ? (n.side === "npc" ? "NPC" : "PC") : n.kind;
  return `${n.name} (${kind}): ${p.presence.standing}${p.facts.length ? `; ${p.facts.join("; ")}` : ""}${p.threads.length ? `. ${p.threads.join("; ")}` : ""}`;
}

export function roleWords(role: string) {
  return THREAD_ROLES[role]?.says ?? "is involved in";
}
