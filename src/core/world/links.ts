import { z } from "zod";
import { type EngineQuestion, FieldMeta, type NodeKind, SCALE } from "./nodes";

// Links (docs/design-2026-10-25-world-model.md §4): one object per connection, read from either
// end. "Bram is the subject of 'believes he can't die'" is one link: Bram's threads and the
// thread's subjects are the same row. Each type declares its laws once, here.

const End = z.object({ kind: z.string(), id: z.number().int() });

export const Link = z.object({
  id: z.string(), // stable within a load: "rel:12", "te:3-14", "loc:7"
  campaignId: z.number().int(),
  from: End,
  to: End,
  type: z.string(), // a LINK_TYPES key
  role: z.string().optional(), // thread and moment participation: a THREAD_ROLES key
  strength: SCALE.optional(),
  certainty: z.enum(["actual", "last-seen"]).optional(), // where someone is
  since: z.number().nullable().optional(), // session numbers
  until: z.number().nullable().optional(),
  secret: z.boolean(),
  note: z.string().optional(),
  meta: FieldMeta,
});
export type Link = z.infer<typeof Link>;

type Side = NodeKind | "pc" | "npc";

export interface LinkLaw {
  group: "tie" | "where" | "possession" | "membership" | "thread" | "rule" | "moment" | "knowledge";
  from?: Side[];
  to?: Side[];
  symmetric?: boolean; // A ally B is B ally A: stored once
  cardinality?: "one-per-target" | "one-per-source"; // one holder per item; one place per character
  opposites?: string[]; // a new one replaces these
  reads: EngineQuestion[]; // which engine questions use it
  says: string; // plain words, for people and prompts
}

const CHAR: Side[] = ["character"];
const ACTOR: Side[] = ["character", "faction", "other"]; // "other" is the catch-all: a guardian spirit, a curse

export const LINK_TYPES: Record<string, LinkLaw> = {
  // Ties and feelings
  ally: { group: "tie", from: ACTOR, to: ACTOR, symmetric: true, opposites: ["enemy", "rivals"], reads: ["mood", "presence"], says: "is allied with" },
  enemy: { group: "tie", from: ACTOR, to: ACTOR, symmetric: true, opposites: ["ally", "romance"], reads: ["mood", "presence"], says: "is the enemy of" },
  rivals: { group: "tie", from: ACTOR, to: ACTOR, symmetric: true, opposites: ["ally"], reads: ["mood"], says: "is a rival of" },
  family: { group: "tie", from: CHAR, to: CHAR, symmetric: true, reads: ["mood", "presence"], says: "is family to" },
  romance: { group: "tie", from: CHAR, to: CHAR, symmetric: true, opposites: ["enemy"], reads: ["mood", "presence"], says: "is in a romance with" },
  loves: { group: "tie", opposites: ["hates", "dislikes"], reads: ["mood", "presence"], says: "loves" },
  cherishes: { group: "tie", opposites: ["hates", "dislikes"], reads: ["mood"], says: "cherishes" },
  likes: { group: "tie", opposites: ["dislikes", "hates"], reads: ["mood"], says: "likes" },
  dislikes: { group: "tie", opposites: ["likes", "loves", "cherishes"], reads: ["mood"], says: "dislikes" },
  hates: { group: "tie", opposites: ["loves", "cherishes", "likes"], reads: ["mood"], says: "hates" },
  fears: { group: "tie", reads: ["mood"], says: "fears" },
  trusts: { group: "tie", opposites: ["distrusts"], reads: ["mood", "presence"], says: "trusts" },
  distrusts: { group: "tie", opposites: ["trusts"], reads: ["mood"], says: "distrusts" },
  serves: { group: "tie", from: CHAR, reads: ["presence"], says: "serves" },
  owes: { group: "tie", from: ACTOR, to: ACTOR, reads: ["payoff"], says: "owes" },
  promised: { group: "tie", from: ACTOR, reads: ["payoff"], says: "promised" },
  hunts: { group: "tie", from: ACTOR, reads: ["presence", "payoff"], says: "hunts" },
  wants: { group: "tie", reads: ["payoff"], says: "wants" },
  // Where things are
  located_at: { group: "where", from: ["character", "item", "faction", "party"], to: ["place"], cardinality: "one-per-source", reads: ["presence"], says: "is at" },
  lives_at: { group: "where", from: CHAR, to: ["place"], cardinality: "one-per-source", reads: ["presence"], says: "lives at" },
  inside: { group: "where", reads: ["presence", "possession", "rules"], says: "is part of" }, // place in place, item in set, cell of faction
  // Possession
  holds: { group: "possession", from: CHAR, to: ["item"], cardinality: "one-per-target", reads: ["possession", "presence", "rules"], says: "holds" },
  made: { group: "possession", to: ["item", "place"], reads: ["knowledge"], says: "made" },
  controls: { group: "possession", from: ACTOR, to: ["place", "item", "faction"], reads: ["presence"], says: "controls" },
  // Membership
  member_of: { group: "membership", from: ["character", "party"], to: ["faction", "party"], reads: ["presence"], says: "is a member of" },
  leads: { group: "membership", from: CHAR, to: ["faction"], cardinality: "one-per-target", reads: ["presence"], says: "leads" },
  // Knowledge
  knows_about: { group: "knowledge", from: CHAR, reads: ["knowledge"], says: "knows about" },
  knows_secret_of: { group: "knowledge", from: CHAR, reads: ["knowledge"], says: "knows a secret of" },
  // Threads: a node's part in a thread (role), and threads to threads
  in_thread: { group: "thread", to: ["thread"], reads: ["payoff", "spotlight"], says: "is in" },
  connects: { group: "thread", from: ["thread"], to: ["thread"], reads: ["payoff"], says: "connects to" },
  // Rules and moments
  source_of: { group: "rule", to: ["rule"], reads: ["rules"], says: "is the source of" },
  applies_to: { group: "rule", from: ["rule"], reads: ["rules"], says: "applies to" },
  involved_in: { group: "moment", to: ["moment"], reads: ["payoff"], says: "was in" },
  happened_in: { group: "moment", to: ["session"], reads: ["payoff"], says: "happened in" },
};

// What part a node plays in a thread. A catalogue the engine reads, not a closed list: a role it
// doesn't know is kept and treated as "involved" until it's added here.
export interface ThreadRole {
  says: string;
  reads: EngineQuestion[];
  // What the engine can do with it when looking for moves (Stage 3).
  moves: ("payoff" | "complication" | "collision" | "arrival" | "callback" | "hint" | "spotlight")[];
  // How they stand toward the thread moving on: "for" wants it (hope rises when it moves), "against"
  // is in its way (hope falls). Most roles don't say.
  stance?: "for" | "against";
}
export const THREAD_ROLES: Record<string, ThreadRole> = {
  involved: { says: "is involved in", reads: ["payoff"], moves: [] }, // what today's links carry, until a role is known
  // Who it's about
  subject: { says: "is who it's about", reads: ["payoff", "spotlight"], moves: ["payoff", "spotlight"] },
  victim: { says: "suffers from it", reads: ["payoff", "mood"], moves: ["payoff", "complication"] },
  target: { says: "is its target", reads: ["payoff"], moves: ["complication", "arrival"] },
  beneficiary: { says: "gains from it", reads: ["payoff"], moves: ["complication"] },
  // Why it exists
  cause: { says: "caused it", reads: ["payoff", "knowledge"], moves: ["arrival", "hint", "collision"] },
  origin: { says: "is where it began", reads: ["payoff"], moves: ["callback", "hint"] },
  source: { says: "is the source of its power or knowledge", reads: ["payoff", "knowledge"], moves: ["hint"] },
  // What it turns on
  key: { says: "holds the way to resolve it", reads: ["payoff", "possession"], moves: ["collision", "payoff"] },
  cost: { says: "is what it would cost", reads: ["payoff"], moves: ["complication"] },
  prize: { says: "is what's at stake to win", reads: ["payoff", "possession"], moves: ["payoff", "complication"] },
  clue: { says: "points toward the answer", reads: ["knowledge"], moves: ["hint"] },
  // Who moves it
  seeker: { says: "is after it", reads: ["payoff", "presence"], moves: ["arrival", "complication"], stance: "for" },
  rival: { says: "competes for it", reads: ["payoff", "presence"], moves: ["arrival", "complication"], stance: "against" },
  obstacle: { says: "stands in the way", reads: ["payoff"], moves: ["complication"], stance: "against" },
  guardian: { says: "guards it", reads: ["payoff", "presence"], moves: ["complication"], stance: "against" },
  holder: { says: "holds what it's about", reads: ["possession"], moves: ["collision"] },
  carrier: { says: "carries it, knowingly or not", reads: ["possession", "knowledge"], moves: ["hint", "collision"] },
  informant: { says: "knows something about it", reads: ["knowledge"], moves: ["hint", "arrival"] },
  ally: { says: "helps it along", reads: ["payoff"], moves: ["arrival"] },
  betrayer: { says: "will turn on it", reads: ["payoff", "knowledge"], moves: ["complication", "hint"] },
  // Bonds and debts
  debtor: { says: "owes in it", reads: ["payoff"], moves: ["complication", "arrival"] },
  creditor: { says: "is owed in it", reads: ["payoff"], moves: ["arrival"], stance: "for" },
  promiser: { says: "made the promise", reads: ["payoff"], moves: ["complication"] },
  promisee: { says: "was promised", reads: ["payoff"], moves: ["arrival"], stance: "for" },
  // Where and who saw
  witness: { says: "saw it happen", reads: ["knowledge"], moves: ["hint", "arrival"] },
  place: { says: "is where it plays out", reads: ["presence"], moves: ["payoff"] },
};
