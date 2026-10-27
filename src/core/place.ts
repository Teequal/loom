import type { ScaffoldBeat } from "./scaffold";
import type { Situation } from "./situation";

// ---------- Where it happens ----------
// An option happens where the party is. A sentence may point somewhere else ("Tomas knows a
// smuggler camp in the next hollow", "contacts trade there"), but that doesn't take the party
// there: going is the players' choice. So once a sentence points elsewhere, a later one may not
// bring in someone or something from there acting on the party ("A wary smuggler offers a
// crate…"), unless they arrive. Code decides this from the sentences; the model never has to.

export interface PlaceContext {
  here: Set<string>; // the party's place and the places it's inside, lower case (names and aliases)
  elsewhere: string[]; // other known places' names and aliases
}

export function placeContext(s: Situation): PlaceContext {
  const places = s.entities.filter((e) => e.type === "location");
  const byId = new Map(places.map((p) => [p.id, p]));
  const here = new Set<string>();
  for (let p = s.party ?? undefined, guard = 0; p && guard < 10; p = p.parentId ? byId.get(p.parentId) : undefined, guard++) {
    for (const n of [p.name, ...(p.aliases ?? [])]) here.add(n.toLowerCase());
  }
  // With the party's place unknown, a known place name says nothing about distance.
  const elsewhere = here.size ? places.filter((p) => !here.has(p.name.toLowerCase())).flatMap((p) => [p.name, ...(p.aliases ?? [])]).filter((n) => n.length >= 4 && !here.has(n.toLowerCase())) : [];
  return { here, elsewhere };
}

const PLACE_NOUN = "camp|hollow|tavern|inn|cellar|shrine|chapel|temple|tower|stall|shop|market|cave|caves|den|hideout|warehouse|docks?|wharf|pier|manor|fort|keep|mill|farm|village|town|ruins?|crypt|lair|grove|estate|palace|guildhall|barracks|prison|jail|square|quarter|district|woods|forest|valley|ridge|cottage|hut|house|workshop|forge|library|archive|vault|outpost|harbou?r|port|hall|headquarters|hq|church|abbey|monastery|encampment|hideaway";
const PLACE = new RegExp(`\\b(${PLACE_NOUN})\\b`, "i");
// A place brought in new ("a smuggler camp", "an old shrine"): talked of, so not where they stand.
const NEW_PLACE = new RegExp(`\\b(?:a|an|another)\\s+(?:[\\w'’-]+\\s+){0,2}?(${PLACE_NOUN})\\b`, "i");
// Words that put a place at a distance from where the party stands.
const DISTANT = /\b(?:in|at|on|to|toward|towards|from|near)\s+(?:the|a)\s+(?:next|nearby|neighbou?ring|far|other|distant|old)\b|\bacross (?:the )?(?:town|city|river|valley|bay|square|harbou?r|water)\b|\bbeyond\b|\bon the (?:far|other) side\b|\bback (?:in|at)\b|\bmiles?\b|\bover the (?:hill|ridge|rise)\b|\bdown(?:river| the road| the coast| the valley)\b|\bupriver\b|\belsewhere\b|\bmeanwhile\b|\bfar (?:off|away)\b/i;
// Words that talk about a place rather than stand in it.
const TALK_OF = /\b(?:knows?|knew|tells?|told|speaks?|spoke|mentions?|mentioned|points?|pointed|says?|said|whispers?|rumou?rs?|word|map|directions?|leads?|lies|lay|hidden|somewhere)\b/i;
// "there" as a place, closing a clause ("trade there."), not "there is", "there on the counter",
// "over there" or "right there".
const THERE = /\bthere\b(?=\s*(?:[.,;!?]|$|too\b|now\b|tonight\b|already\b|instead\b|first\b|often\b|every\b))/i;
const NEAR_THERE = /\b(?:over|right|just|up|down|out|in) there\b/i;

const plain = (t: string) => t.replace(/\{([^{}|]+)(?:\|([^{}]*))?\}/g, (_, n: string, r?: string) => (r ?? n).trim());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a sentence points that isn't here: the place words it names, or null. */
export function pointsElsewhere(text: string, ctx: PlaceContext): string | null {
  const t = plain(text);
  const known = ctx.elsewhere.find((n) => new RegExp(`\\b${esc(n)}\\b`, "i").test(t));
  if (known) return known;
  const noun = t.match(PLACE)?.[1];
  const fresh = t.match(NEW_PLACE)?.[1];
  if (fresh && !ctx.here.has(fresh.toLowerCase()) && (DISTANT.test(t) || TALK_OF.test(t))) return fresh.toLowerCase();
  if (noun && !ctx.here.has(noun.toLowerCase()) && DISTANT.test(t)) return noun.toLowerCase();
  if (THERE.test(t) && !NEAR_THERE.test(t)) return noun?.toLowerCase() ?? "there";
  return null;
}

// Someone new opening a sentence: "A wary smuggler…", "Two guards…".
const NEW_PERSON = /^(?:a|an|some|two|three|several|another)\s+(?:[\w'’-]+\s+){0,2}?(?:smugglers?|guards?|m[ae]n|wom[ae]n|figures?|boys?|girls?|child(?:ren)?|merchants?|traders?|strangers?|sailors?|fisher(?:man|men|woman)?|soldiers?|priests?|monks?|thie(?:f|ves)|bandits?|couriers?|runners?|messengers?|travell?ers?|farmers?|hunters?|scouts?|clerks?|keepers?|vendors?|peddlers?|beggars?|urchins?|innkeepers?|barkeeps?|patrons?|nobles?|knights?|cultists?|acolytes?|captains?|sergeants?|watchm[ae]n|lookouts?|dockhands?|labourers?|laborers?|elders?|villagers?|townsfolk|crowd|gang|band|pair|group)\b/i;
// Someone who comes to the party is fine: they arrive.
const COMES = /\b(?:arrives?|arriving|comes?|coming|came|hurries|hurrying|runs? (?:up|over|in|toward|towards)|approaches|emerges?|appears?|steps (?:out|in|up)|rides? (?:in|up)|bursts? (?:in|through)|catches up|finds them|reaches them|climbs? (?:up|down|out)|wades? (?:out|over))\b/i;
// Being at the place pointed to: "inside the camp", "at the stall".
const IN_PLACE = (noun: string) => new RegExp(`\\b(?:in|inside|at|within|into|through) (?:the|that) (?:[\\w'’-]+ ){0,2}?${esc(noun)}s?\\b`, "i");

/**
 * Drops the sentences of an option that would move the party without the players choosing to:
 * after a sentence points elsewhere, someone new appearing to act on them (who doesn't arrive),
 * or the scene going on inside the place pointed to. `carried` is a place pointed to in an earlier
 * step of a chain. Returns where the option points, if anywhere, for the next step.
 */
export function holdPlace(o: { setup: ScaffoldBeat[] }, ctx: PlaceContext, dropped: (reason: string) => void, carried: string | null = null): string | null {
  let away = carried;
  o.setup = o.setup.filter((b) => {
    if (b.byCode) return true;
    const text = b.kind === "walk_on" ? `${b.walk_on} ${b.does}` : b.does;
    if (away && b.kind !== "arrival" && b.kind !== "remote") {
      const t = plain(text).trim();
      const someoneNew = (b.kind === "walk_on" || (b.kind === "world" && NEW_PERSON.test(t))) && !COMES.test(t);
      const insideIt = away !== "there" && IN_PLACE(away).test(t) && !pointsElsewhere(t, ctx);
      if (someoneNew || insideIt) {
        dropped(`the party isn't at ${away === "there" ? "the place just mentioned" : /^[A-Z]/.test(away) ? away : `the ${away}`}: ${someoneNew ? "someone from there can't act on them unless they arrive" : "the scene can't go on inside it"}`);
        return false;
      }
    }
    away = pointsElsewhere(text, ctx) ?? away;
    return true;
  });
  return away;
}

/** Whether a Develop step's join moves the party ("If they head for the camp:"). */
export const MOVES_THERE = /\b(?:go|goes|going|head|heads|heading|follow|follows|travel|set out|make for|makes for|ride|sail|sneak (?:in|into|to|toward)|enter|enters|cross|return|go after|track|chase)\b/i;
