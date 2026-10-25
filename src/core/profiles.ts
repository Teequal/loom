import type { schema } from "./db/client";
import type { EntityTraits } from "./entity-fields";
import type { MomentReading } from "./moment-reading";
import { capabilitiesOf } from "./rules";

// Entity profiles: everything the loom knows about each entity, by type, turned into what matters
// for this moment. The role each one can play (here, reachable, only remembered) is decided from
// its type and state, not by a rule per slip: a lost item is remembered because it's lost, a
// faction is here through its members, an item is here when someone here has it.

type Entity = typeof schema.entities.$inferSelect;
type Relation = typeof schema.entityRelations.$inferSelect;

// "here": can act, be used or be seen now. "reachable": can arrive, send word, or be sought.
// "remembered": can only be recalled or talked about (dead, lost, destroyed). PCs are the players'.
export type Role = "here" | "reachable" | "remembered" | "player";

export interface Profile {
  entity: Entity;
  role: Role;
  standing: string; // where it stands, in words: "lost, last seen at the River Morrow"
  facts: string[]; // what matters for its type, short
  threads: string[]; // open threads it's in
}

export interface ProfileInput {
  entities: Entity[];
  relations: Relation[];
  party: Entity | null;
  presence: (e: Entity) => "here" | "with-party" | "nearby" | "elsewhere" | "unknown";
  holders: Map<string, Set<string>>;
  parentOf: Map<string, string>;
  reading: MomentReading;
  away: Set<string>; // the GM said not here
  effects: { effect: { name: string; sourceEntityId: number | null }; targets: string[] }[];
  threads: { id: number; title: string; status: string }[];
  threadEntities: { threadId: number; entityId: number }[];
}

const short = (s: string | undefined, n = 110) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : (s ?? ""));
const listOf = (v: unknown, n = 3) => (Array.isArray(v) ? v.slice(0, n).join("; ") : typeof v === "string" ? v : "");

export function buildProfiles(p: ProfileInput): Map<string, Profile> {
  const byId = new Map(p.entities.map((e) => [e.id, e]));
  const byName = new Map(p.entities.map((e) => [e.name, e]));
  const nameOf = (id: number | null | undefined) => (id == null ? null : (byId.get(id)?.name ?? null));
  const within = (place: number, container: number) => {
    let cur: number | null = place;
    for (let hops = 0; cur != null && hops < 20; hops++) {
      if (cur === container) return true;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };
  const atParty = (loc: number | null) => !!p.party && loc != null && (within(loc, p.party.id) || within(p.party.id, loc));
  const placeOf = (e: Entity) => e.actualLocationId ?? e.lastKnownLocationId;
  const openThreads = new Map<number, string[]>();
  const open = new Map(p.threads.filter((t) => t.status !== "resolved").map((t) => [t.id, t.title]));
  for (const te of p.threadEntities) if (open.has(te.threadId)) openThreads.set(te.entityId, [...(openThreads.get(te.entityId) ?? []), open.get(te.threadId)!]);
  const ties = (e: Entity, types?: string[]) =>
    p.relations.filter((r) => (r.fromEntityId === e.id || r.toEntityId === e.id) && (!types || types.includes(r.type)));
  const namedInMoment = (e: Entity) => p.reading.mentions.some((m) => m.entity.name === e.name && m.role !== "refers");

  const profiles = new Map<string, Profile>();
  const set = (e: Entity, role: Role, standing: string, facts: string[]) =>
    profiles.set(e.name, { entity: e, role, standing, facts: facts.filter(Boolean), threads: (openThreads.get(e.id) ?? []).slice(0, 3) });

  // People first: an item's role follows whoever holds it.
  for (const e of p.entities.filter((x) => x.type === "pc" || x.type === "npc")) {
    const t = e.traits as EntityTraits;
    const caps = capabilitiesOf(e);
    const cant = (["act", "speak", "aware"] as const).filter((k) => !caps[k]);
    const condition = [t.health && t.health !== "healthy" ? t.health : "", ...(t.conditions ?? [])].filter(Boolean).join(", ");
    const held = [...p.holders].filter(([, who]) => who.has(e.name)).map(([item]) => item);
    if (e.type === "pc") {
      const state = [e.status && e.status !== "alive" ? e.status : "", condition].filter(Boolean).join(", ");
      set(e, "player", state ? `a player character (${state})` : "a player character", [
        cant.length ? `can't ${cant.join(", ")}` : "",
        t.abilities?.length ? `abilities: ${listOf(t.abilities)}` : "",
        held.length ? `has ${held.join(", ")}` : "",
      ]);
      continue;
    }
    const where = nameOf(placeOf(e));
    const presence = p.presence(e);
    const pcTies = ties(e)
      .filter((r) => byId.get(r.fromEntityId === e.id ? r.toEntityId : r.fromEntityId)?.type === "pc")
      .slice(0, 3)
      .map((r) => (r.fromEntityId === e.id ? `${r.type.replace(/_/g, " ")} ${nameOf(r.toEntityId)}` : `${nameOf(r.fromEntityId)} ${r.type.replace(/_/g, " ")} them`));
    const facts = [
      e.attitude ? `${e.attitude} to the party` : "",
      t.goal ? `goal: ${short(t.goal, 80)}` : "",
      pcTies.length ? `ties: ${pcTies.join("; ")}` : "",
      t.abilities?.length ? `abilities: ${listOf(t.abilities, 2)}` : "",
      condition ? `health: ${condition}` : "",
      held.length ? `has ${held.join(", ")}` : "",
    ];
    if (e.status === "dead") set(e, "remembered", `dead${where ? `, died at ${where}` : ""}`, facts);
    else if (p.away.has(e.name)) set(e, "reachable", "not here (you said so)", facts);
    else if (e.status === "captured") set(e, "reachable", `captured${where ? ` at ${where}` : ""}: acts only by escaping or getting word out`, facts);
    else if (e.status === "missing") set(e, "reachable", "missing", facts);
    else if (presence === "here") set(e, "here", "here: the moment brings them in", facts);
    else if (presence === "with-party") set(e, "here", "travelling with the party", facts);
    else if (presence === "nearby") set(e, "reachable", `somewhere around here${where ? ` (${where})` : ""}, not with the party`, facts);
    else set(e, "reachable", where ? `last seen at ${where}` : "whereabouts unknown", facts);
  }

  // Items: here when someone here has it, it's at the party's place, or the moment names it.
  for (const e of p.entities.filter((x) => x.type === "item")) {
    const t = e.traits as EntityTraits;
    // Who has it, and how: directly, by holding the whole set, or by holding a piece of it.
    const holders: { h: string; via: string }[] = [...(p.holders.get(e.name) ?? [])].map((h) => ({ h, via: "" }));
    for (let cur = p.parentOf.get(e.name), hops = 0; cur && hops < 10; cur = p.parentOf.get(cur), hops++) holders.push(...[...(p.holders.get(cur) ?? [])].map((h) => ({ h, via: ` (with ${cur})` })));
    const pieces = [...p.parentOf].filter(([, parent]) => parent === e.name).map(([child]) => child);
    for (const piece of pieces) holders.push(...[...(p.holders.get(piece) ?? [])].map((h) => ({ h, via: ` (the ${piece})` })));
    const rules = p.effects.filter((x) => x.effect.sourceEntityId === e.id).map((x) => x.effect.name);
    const where = nameOf(placeOf(e));
    const facts = [
      p.parentOf.get(e.name) ? `one of ${p.parentOf.get(e.name)}` : "",
      pieces.length ? `pieces: ${pieces.join(", ")}` : "",
      t.known_properties ? `does: ${short(t.known_properties)}` : "",
      t.cost ? `cost of use: ${short(t.cost, 80)}` : "",
      rules.length ? `rules: ${rules.join(", ")}` : "",
      e.status && e.status !== "intact" && e.status !== "lost" ? e.status : "",
    ];
    const holderRoles = holders.map((x) => ({ h: `${x.h}${x.via}`, role: profiles.get(x.h)?.role }));
    const withSomeoneHere = holderRoles.find((x) => x.role === "here" || x.role === "player");
    if (withSomeoneHere) set(e, "here", `held by ${withSomeoneHere.h}`, facts);
    else if (e.status === "lost") set(e, "remembered", `lost${where ? `, last seen at ${where}` : ""}`, facts);
    else if (holderRoles.length) set(e, "reachable", `held by ${holderRoles.map((x) => x.h).join(", ")}${holderRoles.every((x) => x.role === "remembered") ? " (dead)" : ""}`, facts);
    else if (atParty(placeOf(e))) set(e, "here", `here, at ${where}`, facts);
    else if (namedInMoment(e)) set(e, "here", "here: the moment names it", facts);
    else set(e, "reachable", where ? `at ${where}` : "whereabouts unknown", facts);
  }

  // Places: here if the party is in it (or it's inside where the party is), otherwise elsewhere.
  for (const e of p.entities.filter((x) => x.type === "location")) {
    const t = e.traits as EntityTraits;
    const facts = [t.hazards?.length ? `hazards: ${listOf(t.hazards, 2)}` : "", t.atmosphere?.length ? `feels: ${listOf(t.atmosphere, 2)}` : ""];
    if (e.status === "destroyed") set(e, "remembered", "destroyed", facts);
    else if (p.party && (within(p.party.id, e.id) || e.id === p.party.id)) set(e, "here", e.id === p.party.id ? "where the party is" : `the party is inside it`, facts);
    // A place inside where the party is (a building in the city) is nearby, not here.
    else if (p.party && within(e.id, p.party.id)) set(e, "reachable", `nearby, within ${p.party.name}`, facts);
    else set(e, "reachable", "elsewhere", facts);
  }

  // Factions: here through members who are here; otherwise they act through agents.
  for (const e of p.entities.filter((x) => x.type === "faction" || x.type === "other")) {
    const members = ties(e, ["member_of", "leads", "serves"]).map((r) => nameOf(r.fromEntityId === e.id ? r.toEntityId : r.fromEntityId)).filter((n): n is string => !!n && n !== e.name);
    const membersHere = members.filter((m) => profiles.get(m)?.role === "here");
    const facts = [members.length ? `members: ${members.slice(0, 4).join(", ")}` : ""];
    if (e.status === "disbanded" || e.status === "destroyed") set(e, "remembered", e.status, facts);
    else if (membersHere.length) set(e, "here", `through ${membersHere.join(", ")}`, facts);
    else if (namedInMoment(e) && p.reading.broughtIn.has(e.name)) set(e, "here", "here: the moment brings them in", facts);
    else set(e, "reachable", "acts through its agents (a messenger, an arrival)", facts);
  }
  void byName;
  return profiles;
}

// One line per profile, for the scene prompt.
export function profileLine(pr: Profile) {
  const e = pr.entity;
  const kind = e.type === "npc" ? "NPC" : e.type === "pc" ? "PC" : e.type;
  return `${e.name} (${kind}): ${pr.standing}${pr.facts.length ? `; ${pr.facts.join("; ")}` : ""}${pr.threads.length ? `. In: ${pr.threads.join("; ")}` : ""}`;
}
