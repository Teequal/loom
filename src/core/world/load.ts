import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { EntityTraits, FieldMetaMap } from "../entity-fields";
import { LINK_TYPES, Link, THREAD_ROLES } from "./links";
import { AnyNode, CONDITIONS_5E, type FieldMeta, keyOf, type NodeKey, type NodeKind } from "./nodes";

// Stage 1 of the world model: today's tables, read into typed nodes and links (no storage change).
// One graph per campaign, indexed so any node's links are found from either end.

export interface Graph {
  campaignId: number;
  nodes: Map<NodeKey, AnyNode>;
  links: Link[];
  /** A node's links: outgoing, incoming or both, optionally of one type or role. */
  linksOf: (key: NodeKey, opts?: { type?: string; role?: string; dir?: "out" | "in" | "both" }) => Link[];
  /** The node at the other end of a link. */
  other: (link: Link, key: NodeKey) => NodeKey;
  /** A name or alias (any case) to its node. */
  find: (name: string) => AnyNode | undefined;
  /** Today's entity ids to node keys (entity ids and thread ids overlap). */
  entityKey: (id: number) => NodeKey | undefined;
  /** What didn't fit the schemas or the link laws, for the report. */
  problems: { at: string; issue: string }[];
}

type Entity = typeof schema.entities.$inferSelect;
const KIND: Record<string, NodeKind> = { pc: "character", npc: "character", item: "item", location: "place", faction: "faction", other: "other" };
const STANCE: Record<string, number> = { hostile: -2, unfriendly: -1, indifferent: 0, friendly: 1, helpful: 2 };
const endKey = (e: { kind: string; id: number }) => `${e.kind}:${e.id}` as NodeKey;

// Where each old field now lives in the typed node, so its tags (who recorded it, GM-only) follow it.
const PATH: Record<string, string> = {
  status: "status", attitude: "stance", importance: "importance", description: "summary",
  "traits.health": "body.health", "traits.conditions": "body.conditions",
  "traits.goal": "mind.goals", "traits.wants": "mind.wants", "traits.fears": "mind.fears", "traits.flaws": "mind.flaws", "traits.ideals": "mind.ideals", "traits.bonds": "mind.bonds",
  "traits.abilities": "abilities", "traits.gear": "gear", "traits.secrets": "knowledge", "traits.knowledge": "knowledge",
  "traits.race": "identity.race", "traits.occupation": "identity.occupation", "traits.level": "identity.level", "traits.age": "identity.age", "traits.gender": "identity.gender",
  "traits.alignment": "identity.alignment", "traits.background": "identity.background", "traits.appearance": "identity.appearance", "traits.voice": "identity.voice",
  "traits.personality_traits": "identity.personality", "traits.languages": "identity.languages",
  "traits.known_properties": "properties.known", "traits.true_properties": "properties.true", "traits.cost": "properties.cost", "traits.rarity": "properties.rarity",
  "traits.location_type": "placeType", "traits.hazards": "hazards", "traits.atmosphere": "atmosphere",
  "traits.faction_goal": "goal", "traits.plan": "plan", "traits.clock": "clock",
};

// How big a place is, from how the notes describe it. Blank when nothing says.
function scaleOf(placeType: string | undefined, name: string): "region" | "settlement" | "district" | "building" | "room" | "site" | undefined {
  const t = `${placeType ?? ""} ${name}`.toLowerCase();
  if (/\b(room|cell|cellar|chamber|vault|attic|study)\b/.test(t)) return "room";
  if (/\b(tavern|inn|shop|house|home|apartment|laboratory|lab|headquarters|hq|temple|church|tower|clocktower|outpost|keep|manor|guildhall|library|barracks|helm|rose)\b/.test(t)) return "building";
  if (/\b(district|quarter|ward|old town|market|square|docks|street)\b/.test(t)) return "district";
  if (/\b(city|town|village|settlement|hamlet|capital)\b/.test(t)) return "settlement";
  if (/\b(region|kingdom|realm|forest|woods|mountains|desert|sea|river|valley|lands|eldoria)\b/.test(t)) return "region";
  if (/\b(ruins|cave|camp|site|nexus|pocket|grove|shrine|bridge)\b/.test(t)) return "site";
  return undefined;
}

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).filter(Boolean) : typeof v === "string" && v ? [v] : []);
const num = (v: unknown) => {
  const n = Number(String(v ?? "").match(/\d+/)?.[0]);
  return Number.isFinite(n) ? n : undefined;
};

export async function loadGraph(campaignId: number): Promise<Graph> {
  const [[campaign], entities, relations, threads, sessions, moments, effects] = await Promise.all([
    db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
    db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId)),
    db.select().from(schema.keyMoments).where(eq(schema.keyMoments.campaignId, campaignId)),
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId)),
  ]);
  const threadIds = threads.map((t) => t.id);
  const [threadEntities, threadLinks, threadEvents] = threadIds.length
    ? await Promise.all([
        db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, threadIds)),
        db.select().from(schema.threadLinks).where(inArray(schema.threadLinks.fromThreadId, threadIds)),
        db.select().from(schema.threadEvents).where(inArray(schema.threadEvents.threadId, threadIds)),
      ])
    : [[], [], []];

  const sessionNo = new Map(sessions.map((s) => [s.id, s.number]));
  const sNo = (id: number | null | undefined) => (id == null ? null : (sessionNo.get(id) ?? null));
  const problems: Graph["problems"] = [];
  const nodes = new Map<NodeKey, AnyNode>();
  const links: Link[] = [];
  const entityKind = new Map(entities.map((e) => [e.id, KIND[e.type] ?? "other"]));
  const entityKey = (id: number) => (entityKind.has(id) ? keyOf(entityKind.get(id)!, id) : undefined);

  const add = (raw: unknown, at: string) => {
    const r = AnyNode.safeParse(raw);
    if (r.success) nodes.set(r.data.key as NodeKey, r.data);
    else problems.push({ at, issue: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  };
  const metaOf = (fm: FieldMetaMap) => {
    const out: Record<string, FieldMeta> = {};
    for (const [field, m] of Object.entries(fm ?? {})) {
      const path = PATH[field] ?? field.replace(/^traits\./, "");
      out[path] = { source: m.source, session: sNo(m.sessionId), ...(m.secret ? { known: "gm" as const } : {}) };
    }
    return out;
  };
  const base = (e: { id: number; name: string }, kind: NodeKind, extra: { aliases?: string[]; summary?: string; meta?: Record<string, FieldMeta> }) => ({
    key: keyOf(kind, e.id),
    id: e.id,
    campaignId,
    name: e.name,
    aliases: extra.aliases ?? [],
    summary: extra.summary ?? "",
    notes: "",
    meta: extra.meta ?? {},
  });

  // ---------- Nodes from entities ----------
  for (const e of entities) {
    const t = (e.traits ?? {}) as EntityTraits;
    const kind = entityKind.get(e.id)!;
    const b = base(e, kind, { aliases: e.aliases, summary: e.description, meta: metaOf(e.fieldMeta) });
    if (kind === "character") {
      add(
        {
          ...b,
          kind,
          side: e.type,
          status: e.status ?? undefined,
          importance: e.importance ?? undefined,
          stance: e.attitude != null ? STANCE[e.attitude] : undefined,
          identity: {
            race: t.race, occupation: t.occupation, level: (() => { const l = num(t.level); return l && l >= 1 && l <= 20 ? l : undefined; })(), age: t.age, gender: t.gender,
            alignment: t.alignment, background: t.background, appearance: list(t.appearance), voice: t.voice, personality: list(t.personality_traits), languages: list(t.languages),
          },
          body: {
            health: e.status === "dead" ? "dead" : t.health,
            conditions: list(t.conditions).map((c) => ({ name: c, is5e: (CONDITIONS_5E as readonly string[]).includes(c.toLowerCase().split(/[\s(]/)[0]) })),
          },
          mind: { goals: list(t.goal).map((g) => ({ text: g, priority: 1 })), wants: list(t.wants), fears: list(t.fears), flaws: list(t.flaws), ideals: list(t.ideals), bonds: list(t.bonds), beliefs: [] },
          abilities: list(t.abilities).map((a) => ({ name: a })),
          gear: list(t.gear),
          knowledge: [...list(t.secrets).map((s) => ({ text: s, secret: true })), ...list(t.knowledge).map((s) => ({ text: s, secret: false }))],
          wealth: t.wealth,
          senses: { passivePerception: num(t.passive_perception), passiveInsight: num(t.passive_insight) },
          hooks: list(t.backstory_hooks),
        },
        b.key,
      );
    } else if (kind === "item") {
      add({ ...b, kind, status: e.status ?? undefined, properties: { known: t.known_properties, true: t.true_properties, cost: t.cost, rarity: t.rarity }, sharedPossession: t.possession === "shared" }, b.key);
    } else if (kind === "place") {
      add({ ...b, kind, status: e.status ?? undefined, placeType: t.location_type, scale: scaleOf(t.location_type, e.name), hazards: list(t.hazards), atmosphere: list(t.atmosphere) }, b.key);
    } else if (kind === "faction") {
      const clock = String(t.clock ?? "").match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
      add({ ...b, kind, status: e.status ?? undefined, stance: e.attitude != null ? STANCE[e.attitude] : undefined, goal: t.faction_goal, plan: t.plan, clock: clock ? { filled: Number(clock[1]), of: Number(clock[2]) } : undefined }, b.key);
    } else {
      add({ ...b, kind: "other", status: e.status ?? undefined }, b.key);
    }
  }

  // ---------- Threads, moments, rules, sessions, the party ----------
  for (const t of threads) {
    add(
      {
        ...base({ id: t.id, name: t.title }, "thread", { summary: t.summary }),
        kind: "thread",
        threadKind: t.kind,
        status: t.status === "progressing" ? "building" : t.status,
        stakes: { ifIgnored: t.stakes || undefined },
        deadline: t.deadline ? { text: t.deadline } : undefined,
        steps: threadEvents.filter((ev) => ev.threadId === t.id).map((ev) => ({ session: sNo(ev.sessionId), change: ev.change, note: ev.note })),
        payoffs: t.payoffIdeas,
        secret: t.secret,
        firstSeen: sNo(t.firstSeenSessionId),
        lastTouched: sNo(t.lastTouchedSessionId),
      },
      `thread:${t.id}`,
    );
  }
  for (const m of moments) {
    add({ ...base({ id: m.id, name: m.title }, "moment", { summary: m.description }), kind: "moment", tone: m.tone, callback: m.callback, session: sNo(m.sessionId), star: m.status }, `moment:${m.id}`);
  }
  for (const r of effects) {
    add(
      { ...base(r, "rule", { summary: r.rule }), kind: "rule", trigger: r.trigger, appliesTo: r.appliesTo, check: r.check, onFail: r.onFail, onSuccess: r.onSuccess, escalation: r.escalation, duration: r.duration, secret: r.secret },
      `rule:${r.id}`,
    );
  }
  for (const s of sessions) add({ ...base({ id: s.id, name: `Session ${s.number}` }, "session", { summary: "" }), kind: "session", number: s.number, date: s.date }, `session:${s.id}`);
  add({ ...base({ id: 0, name: "The party" }, "party", { meta: metaOf(campaign?.fieldMeta ?? {}) }), kind: "party", inGameDate: campaign?.inGameDate ?? "", tone: campaign?.tone ?? "", direction: campaign?.direction ?? "" }, "party:0");

  // ---------- Links ----------
  const push = (raw: Omit<Link, "campaignId">, at: string) => {
    const r = Link.safeParse({ ...raw, campaignId });
    if (r.success) links.push(r.data);
    else problems.push({ at, issue: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  };
  const end = (id: number) => {
    const k = entityKey(id);
    return k ? { kind: k.split(":")[0], id } : null;
  };
  const metaFrom = (source: "dm" | "extracted", session?: number | null, secret?: boolean): FieldMeta => ({ source, session: session ?? null, ...(secret ? { known: "gm" as const } : {}) });

  // Relationships: two-way ones are stored both ways today; here they're one link.
  const seenTwoWay = new Set<string>();
  for (const r of relations) {
    const [from, to] = [end(r.fromEntityId), end(r.toEntityId)];
    if (!from || !to) continue;
    if (LINK_TYPES[r.type]?.symmetric) {
      const k = `${r.type}:${[r.fromEntityId, r.toEntityId].sort((a, b) => a - b).join("-")}`;
      if (seenTwoWay.has(k)) continue;
      seenTwoWay.add(k);
    }
    push({ id: `rel:${r.id}`, from, to, type: r.type, strength: r.strength || undefined, since: sNo(r.sinceSessionId), secret: r.secret, note: r.note || undefined, meta: metaFrom(r.source) }, `rel:${r.id}`);
  }
  // Hierarchy (a place in a place, an item in a set) and where someone was last seen or really is.
  const relatedAt = new Set(relations.filter((r) => r.type === "located_at").map((r) => `${r.fromEntityId}-${r.toEntityId}`));
  for (const e of entities as Entity[]) {
    const from = end(e.id)!;
    if (e.parentId != null && end(e.parentId)) push({ id: `in:${e.id}`, from, to: end(e.parentId)!, type: "inside", secret: false, meta: metaFrom(e.fieldMeta?.parentId?.source ?? "extracted") }, `in:${e.id}`);
    for (const [field, certainty] of [["lastKnownLocationId", "last-seen"], ["actualLocationId", "actual"]] as const) {
      const placeId = e[field];
      if (placeId == null || !end(placeId) || relatedAt.has(`${e.id}-${placeId}`)) continue;
      const fm = e.fieldMeta?.[field];
      push({ id: `loc:${e.id}:${certainty}`, from, to: end(placeId)!, type: "located_at", certainty, secret: !!fm?.secret, meta: metaFrom(fm?.source ?? "extracted", sNo(fm?.sessionId), fm?.secret) }, `loc:${e.id}`);
    }
  }
  // Who and what each thread is about: one link per pair, read from either end. Today's links
  // carry no role, so they start as "involved".
  for (const te of threadEntities) {
    const from = end(te.entityId);
    if (from) push({ id: `te:${te.threadId}-${te.entityId}`, from, to: { kind: "thread", id: te.threadId }, type: "in_thread", role: "involved", secret: false, meta: metaFrom("extracted") }, `te:${te.threadId}-${te.entityId}`);
  }
  for (const tl of threadLinks) push({ id: `tt:${tl.fromThreadId}-${tl.toThreadId}`, from: { kind: "thread", id: tl.fromThreadId }, to: { kind: "thread", id: tl.toThreadId }, type: "connects", secret: false, note: tl.note || undefined, meta: metaFrom("extracted") }, `tt:${tl.fromThreadId}`);
  // Moments: who and what they involved, and when.
  for (const m of moments) {
    const to = { kind: "moment", id: m.id };
    for (const id of m.entityIds) if (end(id)) push({ id: `mi:${m.id}-${id}`, from: end(id)!, to, type: "involved_in", secret: false, meta: metaFrom(m.source) }, `mi:${m.id}`);
    for (const id of m.threadIds) if (threadIds.includes(id)) push({ id: `mt:${m.id}-${id}`, from: { kind: "thread", id }, to, type: "involved_in", secret: false, meta: metaFrom(m.source) }, `mt:${m.id}`);
    if (m.sessionId != null) push({ id: `ms:${m.id}`, from: to, to: { kind: "session", id: m.sessionId }, type: "happened_in", secret: false, meta: metaFrom(m.source) }, `ms:${m.id}`);
  }
  // House rules: where they come from, and who a listed rule names.
  for (const r of effects) {
    const to = { kind: "rule", id: r.id };
    if (r.sourceEntityId != null && end(r.sourceEntityId)) push({ id: `rs:${r.id}`, from: end(r.sourceEntityId)!, to, type: "source_of", secret: r.secret, meta: metaFrom(r.source) }, `rs:${r.id}`);
    if (r.sourceThreadId != null) push({ id: `rt:${r.id}`, from: { kind: "thread", id: r.sourceThreadId }, to, type: "source_of", secret: r.secret, meta: metaFrom(r.source) }, `rt:${r.id}`);
    for (const n of r.appliesToList) {
      const e = entities.find((x) => [x.name, ...x.aliases].some((a) => a.toLowerCase() === n.toLowerCase()));
      if (e) push({ id: `ra:${r.id}-${e.id}`, from: to, to: end(e.id)!, type: "applies_to", secret: r.secret, meta: metaFrom(r.source) }, `ra:${r.id}`);
    }
  }
  // The party: where it is, and who's in it.
  const partyEnd = { kind: "party", id: 0 };
  if (campaign?.partyLocationId != null && end(campaign.partyLocationId)) {
    push({ id: "party:at", from: partyEnd, to: end(campaign.partyLocationId)!, type: "located_at", certainty: "actual", secret: false, meta: metaFrom(campaign.fieldMeta?.partyLocationId?.source ?? "dm") }, "party:at");
  }
  for (const e of entities.filter((x) => x.type === "pc")) push({ id: `pm:${e.id}`, from: end(e.id)!, to: partyEnd, type: "member_of", secret: false, meta: metaFrom("dm") }, `pm:${e.id}`);

  // Link laws: what each type may connect (reported, not dropped, so nothing disappears).
  for (const l of links) {
    const law = LINK_TYPES[l.type];
    if (!law) {
      problems.push({ at: l.id, issue: `unknown link type "${l.type}"` });
      continue;
    }
    const side = (x: { kind: string; id: number }) => {
      const n = nodes.get(endKey(x));
      return n?.kind === "character" ? [n.kind, n.side] : [x.kind];
    };
    if (law.from && !side(l.from).some((s) => law.from!.includes(s as never))) problems.push({ at: l.id, issue: `"${l.type}" can't start from a ${side(l.from).join("/")}` });
    if (law.to && !side(l.to).some((s) => law.to!.includes(s as never))) problems.push({ at: l.id, issue: `"${l.type}" can't point at a ${side(l.to).join("/")}` });
    if (l.role && !THREAD_ROLES[l.role]) problems.push({ at: l.id, issue: `thread role "${l.role}" isn't in the catalogue (treated as "involved")` });
    if (!nodes.has(endKey(l.from)) || !nodes.has(endKey(l.to))) problems.push({ at: l.id, issue: "an end of this link isn't a node" });
  }

  // ---------- The index ----------
  const out = new Map<NodeKey, Link[]>();
  const inn = new Map<NodeKey, Link[]>();
  for (const l of links) {
    out.set(endKey(l.from), [...(out.get(endKey(l.from)) ?? []), l]);
    inn.set(endKey(l.to), [...(inn.get(endKey(l.to)) ?? []), l]);
  }
  const names = new Map<string, NodeKey>();
  for (const n of nodes.values()) for (const a of [n.name, ...n.aliases]) if (!names.has(a.toLowerCase())) names.set(a.toLowerCase(), n.key as NodeKey);

  return {
    campaignId,
    nodes,
    links,
    linksOf: (key, opts = {}) => {
      const dir = opts.dir ?? "both";
      const found = [...(dir !== "in" ? (out.get(key) ?? []) : []), ...(dir !== "out" ? (inn.get(key) ?? []) : [])];
      // A two-way link is the same from either end.
      const twoWay = dir !== "both" ? (dir === "out" ? (inn.get(key) ?? []) : (out.get(key) ?? [])).filter((l) => LINK_TYPES[l.type]?.symmetric) : [];
      return [...found, ...twoWay].filter((l) => (!opts.type || l.type === opts.type) && (!opts.role || l.role === opts.role));
    },
    other: (link, key) => (endKey(link.from) === key ? endKey(link.to) : endKey(link.from)),
    find: (name) => {
      const k = names.get(name.trim().toLowerCase());
      return k ? nodes.get(k) : undefined;
    },
    entityKey,
    problems,
  };
}
