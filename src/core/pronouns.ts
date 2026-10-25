import type { EntityTraits } from "./entity-fields";

// A character's pronouns: from the gender the GM (or extraction) recorded, or, failing that, from
// the words their own description uses. Unknown stays unknown: nothing is guessed from a name.

export type Pronouns = { he: string; him: string; his: string; own: string } | null;
const HE = { he: "he", him: "him", his: "his", own: "his own" };
const SHE = { he: "she", him: "her", his: "her", own: "her own" };
const THEY = { he: "they", him: "them", his: "their", own: "their own" };

const MASC = /\b(?:he|him|his|himself|man|boy|father|brother|son|husband|king|lord|prince|sir|monk|priest)\b/gi;
const FEM = /\b(?:she|her|hers|herself|woman|girl|mother|sister|daughter|wife|queen|lady|princess|madam|priestess|sorceress|witch|nun)\b/gi;

const TITLE_M = /^(?:Father|Brother|Sir|Lord|King|Prince|Master|Mister|Mr\.?)\s/;
const TITLE_F = /^(?:Mother|Sister|Lady|Dame|Queen|Princess|Mistress|Madam|Mrs\.?|Ms\.?|Miss)\s/;

export function pronounsOf(e: { name?: string; traits?: unknown; description?: string | null; type?: string }): Pronouns {
  if (e.type && e.type !== "pc" && e.type !== "npc") return null;
  const g = ((e.traits as EntityTraits | undefined)?.gender ?? "").toLowerCase().trim();
  if (g) {
    if (/^(?:m|male|man|boy|he|he\/him)\b/.test(g)) return HE;
    if (/^(?:f|female|woman|girl|she|she\/her)\b/.test(g)) return SHE;
    if (/^(?:they|nb|non-?binary|they\/them)\b/.test(g)) return THEY;
  }
  // A title in the name says it ("Mother Ysolde", "Sir Bram"); a name alone never does.
  if (TITLE_M.test(e.name ?? "")) return HE;
  if (TITLE_F.test(e.name ?? "")) return SHE;
  // The description's own words, when they clearly lean one way.
  const d = e.description ?? "";
  const m = d.match(MASC)?.length ?? 0;
  const f = d.match(FEM)?.length ?? 0;
  if (m > f && m >= 1) return HE;
  if (f > m && f >= 1) return SHE;
  return null;
}

/** Whether a pronoun word ("she", "his") could stand for someone with these pronouns (unknown: anyone). */
export function couldBe(word: string, p: Pronouns): boolean {
  if (!p) return true;
  const w = word.toLowerCase();
  if (/^(?:he|him|his|himself)$/.test(w)) return p === HE;
  if (/^(?:she|her|hers|herself)$/.test(w)) return p === SHE;
  return true; // "they" can stand for anyone
}
