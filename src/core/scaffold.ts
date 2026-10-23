import type { EntityTraits } from "./entity-fields";
import { capabilitiesOf } from "./rules";
import type { Scene } from "./scene";

// Tags and checks shared by the improv scaffold and the flavour pass.
//
// The model writes every named character, place, item or mechanic as a tag: {Zara the Unbound}.
// Because every reference is a tag, code knows exactly who appears where, without guessing at
// grammar. Untagged names are tagged automatically before checking, so a missed tag can't hide
// a slip.

type Entity = Scene["entities"][number];

export type BeatKind = "world" | "npc" | "walk_on" | "arrival" | "remote" | "outcome";

export interface ScaffoldBeat {
  kind: BeatKind;
  actor: string; // "world", "walk-on", or an entity name from the allowed list
  walk_on: string; // description of an unnamed extra ("a nervous merchant"), else ""
  does: string;
}

const TAG = /\{([^{}]+)\}/g;

// Words that can follow a character's tag without that character choosing to do something:
// possessives, conjunctions, prepositions, articles, states of being, and things that happen
// to someone involuntarily (shimmering, freezing, trembling).
const PASSIVE_NEXT = new Set(
  (
    "'s ’s and or but nor with to from in on at by for of as into onto toward towards over under before after behind beside near while who whom whose which that is was are were remains remain lies lay has had a an the his her their its " +
    "shimmers flickers glows blurs fades freezes stiffens pales trembles shivers shudders sways falters staggers slumps collapses sleeps wavers doubles vanishes reappears blinks winces flinches gasps twitches glazes"
  ).split(" "),
);

const PRONOUN_START = /^\s*(?:he|she|they|it|him|her|them)\b/i;

// "{Name}'s <limb> <deliberate motion>": hands grabbing, legs carrying. Eyes glazing or a body
// shimmering under a spell are effects, not actions, so they pass.
const FORCED_BODY =
  /\{([^{}|]+)(?:\|[^{}]*)?\}['’]s\s+(?:\w+\s+)?(?:hands?|fingers?|grip|arms?|legs?|feet|foot|body|mouth|jaw|knees?)\s+(?:\w+ly\s+)?(?:grab|seize|tighten|clench|close|open|reach|move|carry|carries|drag|pull|push|lift|raise|point|strike|swing|draw|lock|refuse|walk|step|run|speak|say|shout|turn)\w*/gi;

export function makeTagger(scene: Scene) {
  // Every way an entity can be named → its canonical name. Longest first, so "Professor
  // Aldric Vex" wins over "Vex".
  // Untagged names are only recognised as written with a capital ("Resistance", not the word
  // "resistance"); explicit {tags} resolve regardless of case.
  const forms: [string, Entity][] = [];
  const firstWords = new Map<string, Entity[]>();
  const proper = (s: string) => /^[A-Z]/.test(s);
  for (const e of scene.entities) {
    for (const n of [e.name, ...e.aliases]) if (n.length >= 3 && proper(n)) forms.push([n, e]);
    // First-name shortcuts ("Zara", "Vex") only for characters; places and items need their full
    // name or an alias, so "Resistance roll" or "Vex's presence" aren't mistaken for places.
    const first = e.name.split(/[\s,]+/)[0];
    if ((e.type === "npc" || e.type === "pc") && first.length >= 3 && proper(first) && !/['’]s$/.test(first)) {
      firstWords.set(first, [...(firstWords.get(first) ?? []), e]);
    }
  }
  for (const [w, es] of firstWords) if (es.length === 1 && !forms.some(([f]) => f === w)) forms.push([w, es[0]]);
  const allNames = new Map<string, Entity>();
  for (const e of scene.entities) for (const n of [e.name, ...e.aliases]) allNames.set(n.toLowerCase(), e);
  // PCs are often called by class or race: "the cleric", "the dragonborn". Only when exactly one
  // PC fits.
  const titles = new Map<string, Entity[]>();
  for (const p of scene.pcs) {
    const t = p.traits as EntityTraits;
    for (const word of [t.occupation, t.race].filter((x): x is string => Boolean(x))) {
      const key = `the ${word.toLowerCase()}`;
      titles.set(key, [...(titles.get(key) ?? []), p]);
    }
  }
  for (const [title, es] of titles) if (es.length === 1) forms.push([title, es[0]]);
  forms.sort((a, b) => b[0].length - a[0].length);
  const mechanics = new Map(scene.effects.map((m) => [m.effect.name.toLowerCase(), m.effect.name]));

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleForms = forms.filter(([f]) => f.startsWith("the "));
  const nameForms = forms.filter(([f]) => !f.startsWith("the "));
  const nameRe = nameForms.length ? new RegExp(`(?<![\\w{])(${nameForms.map(([f]) => escape(f)).join("|")})(?![\\w}])`, "g") : null;
  const titleRe = titleForms.length ? new RegExp(`(?<![\\w{])(${titleForms.map(([f]) => escape(f)).join("|")})(?![\\w}])`, "gi") : null;
  const lookup = new Map([...allNames, ...forms.map(([f, e]) => [f.toLowerCase(), e] as const)]);

  // Canonicalise existing tags and tag any untagged entity names.
  const tag = (text: string) => {
    const parts = text.split(/(\{[^{}]+\})/);
    return parts
      .map((p) => {
        if (/^\{[^{}]+\}$/.test(p)) {
          // {Name} or {Name|how it reads}: the name is what's checked, the text is what's shown.
          const [rawName, shown] = p.slice(1, -1).split("|").map((s) => s.trim());
          const e = lookup.get(rawName.toLowerCase()) ?? scene.resolve(rawName);
          const name = e ? e.name : (mechanics.get(rawName.toLowerCase()) ?? rawName);
          return shown ? `{${name}|${shown}}` : `{${name}}`;
        }
        // Keep the wording as written ("Zara") and record the full name for checking.
        const wrap = (m: string) => {
          const name = lookup.get(m.toLowerCase())?.name ?? m;
          return name === m ? `{${name}}` : `{${name}|${m}}`;
        };
        const named = nameRe ? p.replace(nameRe, wrap) : p;
        return titleRe ? named.replace(titleRe, wrap) : named;
      })
      .join("");
  };

  const entityOf = (name: string) => {
    const n = name.split("|")[0].trim();
    return scene.entities.find((e) => e.name === n);
  };

  // Every place a tagged character is followed by something they do: "{Salaena} shouts".
  const actingTags = (tagged: string) => {
    const out: { entity: Entity; next: string }[] = [];
    for (const m of tagged.matchAll(new RegExp(`\\{([^{}|]+)(?:\\|[^{}]*)?\\}(['’]s)?\\s*([\\w'’-]*)`, "g"))) {
      const e = entityOf(m[1]);
      if (!e || m[2]) continue; // possessive: an object, not an actor
      const next = (m[3] ?? "").toLowerCase();
      if (next && !PASSIVE_NEXT.has(next)) out.push({ entity: e, next });
    }
    return out;
  };

  const render = (tagged: string) =>
    tagged
      .replace(TAG, (_, inner: string) => {
        const [name, shown] = inner.split("|").map((s) => s.trim());
        return shown || name;
      })
      .replace(/\b(the|a|an)\s+(?:the|a|an)\s+/gi, "$1 "); // "The {X|the monk figurine}" → "The monk figurine"
  const tagsIn = (tagged: string) => [...tagged.matchAll(TAG)].map((m) => m[1].split("|")[0].trim());
  return { tag, render, actingTags, tagsIn, entityOf };
}

export type Tagger = ReturnType<typeof makeTagger>;

export interface CheckContext {
  scene: Scene;
  tagger: Tagger;
  present: Set<string>; // NPCs, factions and items that may act directly
  remoteOk: Set<string>; // absent NPCs the moment itself put in contact
  outcomePcs: Set<string>; // PCs whose declared action this moment is about
  possession: Possession;
}

// ---------- Possession (L3: one holder per item, inherited through sets) ----------

export interface Possession {
  holders: Map<string, Set<string>>; // item → who may handle it now (records + the moment)
  parentOf: Map<string, string>; // item → its set
}

// Who holds an item, counting the set it belongs to and the pieces inside it: holding a piece
// lets you handle "the figurines"; holding the whole set lets you use any piece.
export function holdersOf(item: string, p: Possession, extra?: Map<string, Set<string>>) {
  const out = new Set<string>();
  const add = (name: string) => {
    for (const h of p.holders.get(name) ?? []) out.add(h);
    for (const h of extra?.get(name) ?? []) out.add(h);
  };
  add(item);
  for (let cur = p.parentOf.get(item), hops = 0; cur && hops < 10; cur = p.parentOf.get(cur), hops++) add(cur);
  for (const [child] of p.parentOf) {
    let cur: string | undefined = child;
    for (let hops = 0; cur && hops < 10; cur = p.parentOf.get(cur), hops++) if (p.parentOf.get(cur) === item || cur === item) add(child);
  }
  return out;
}

const ITEM_TAG = String.raw`(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+)?\{([^{}|]+)(?:\|[^{}]*)?\}`;
const CHAR_TAG = String.raw`\{([^{}|]+)(?:\|[^{}]*)?\}`;
const GIVE = new RegExp(String.raw`\b(?:gives?|hands?|passes|pass|tosses|toss|throws?|slides?|returns?|offers?)\s+(?:back\s+)?${ITEM_TAG}\s+(?:back\s+)?to\s+${CHAR_TAG}`, "gi");
const TAKE = new RegExp(String.raw`\b(?:steals?|snatch(?:es)?|grabs?|takes?|seizes?|pockets?|swipes?|lifts?|picks?\s+up|catch(?:es)?)\s+${ITEM_TAG}`, "gi");
const USE = new RegExp(String.raw`\b(?:uses?|activates?|wields?|brandish(?:es)?|drinks?|invokes?|channels?|attunes?\s+to)\s+${ITEM_TAG}`, "gi");
const IN_HAND = new RegExp(String.raw`${ITEM_TAG}[^.]{0,60}?\b(?:in|from|against|on|inside|within)\s+${CHAR_TAG}['’]s\s+(?:\w+\s+)?(?:hands?|palm|pack|pocket|grip|coat|bag|belt|pouch|satchel|fingers|lap|robes?|cloak)`, "gi");
const POSSESSIVE = new RegExp(String.raw`${CHAR_TAG}['’]s\s+(?:\w+\s+)?\{([^{}|]+)(?:\|[^{}]*)?\}`, "gi");

// Checks one option's beats in order for items used or held by someone who doesn't have them.
// Hand-overs inside the option count from then on; returns who gained what, for rule checks.
export function checkPossession(beats: ScaffoldBeat[], c: CheckContext): { problem: string | null; gained: Map<string, Set<string>> } {
  const gained = new Map<string, Set<string>>();
  const isItem = (n: string) => c.tagger.entityOf(n)?.type === "item";
  const give = (item: string, to: string) => gained.set(item, new Set([...(gained.get(item) ?? []), to]));
  const holds = (who: string, item: string) => {
    const h = holdersOf(item, c.possession, gained);
    return h.size === 0 || h.has(who); // nobody recorded as holding it: can't judge
  };
  const recorded = (item: string) => [...holdersOf(item, c.possession, gained)].join(", ") || "nobody";

  for (const b of beats) {
    const text = c.tagger.tag(b.does);
    const actor = b.kind === "npc" || b.kind === "arrival" || b.kind === "outcome" ? (c.tagger.entityOf(b.actor)?.name ?? b.actor) : null;

    for (const m of text.matchAll(GIVE)) {
      const [item, to] = [m[1].trim(), m[2].trim()];
      if (!isItem(item)) continue;
      if (actor && !holds(actor, item)) return { problem: `${actor} hands over ${item}, which ${recorded(item)} holds`, gained };
      give(item, c.tagger.entityOf(to)?.name ?? to);
    }
    for (const m of text.matchAll(TAKE)) {
      const item = m[1].trim();
      if (isItem(item) && actor) give(item, actor);
    }
    for (const m of text.matchAll(USE)) {
      const item = m[1].trim();
      if (isItem(item) && actor && !holds(actor, item)) return { problem: `${actor} uses ${item}, but ${recorded(item)} holds it`, gained };
    }
    for (const m of text.matchAll(IN_HAND)) {
      const [item, who] = [m[1].trim(), c.tagger.entityOf(m[2].trim())?.name ?? m[2].trim()];
      if (isItem(item) && !holds(who, item)) return { problem: `${item} is in ${who}'s hands, but ${recorded(item).replace(/, (?=[^,]*$)/, " and ")} ${recorded(item).includes(",") ? "hold" : "holds"} it`, gained };
    }
    for (const m of text.matchAll(POSSESSIVE)) {
      const [who, item] = [c.tagger.entityOf(m[1].trim())?.name ?? m[1].trim(), m[2].trim()];
      if (isItem(item) && c.tagger.entityOf(who) && !holds(who, item)) return { problem: `"${who}'s ${item}", but ${recorded(item)} holds it`, gained };
    }
  }
  return { problem: null, gained };
}

const isPc = (e: Entity) => e.type === "pc";
// Only characters can be somewhere they shouldn't be; places and items don't "act" in that sense.
const unavailable = (e: Entity, c: CheckContext) =>
  e.type !== "npc" ? null : e.status === "dead" ? "dead" : !c.present.has(e.name) && !c.remoteOk.has(e.name) ? "absent" : null;

// Checks one beat. The actor slot is already restricted by the schema; this checks the
// combinations and the free text for characters acting where they can't.
export function checkBeat(b: ScaffoldBeat, c: CheckContext): string | null {
  const actor = b.actor === "world" || b.actor === "walk-on" ? undefined : c.tagger.entityOf(b.actor) ?? c.scene.resolve(b.actor);
  const does = c.tagger.tag(b.does);

  switch (b.kind) {
    case "world":
      if (b.actor !== "world") return `a world beat names an actor (${b.actor})`;
      if (PRONOUN_START.test(c.tagger.render(does))) return `a world beat opens with an unclear "he/she/they": "${c.tagger.render(does)}"`;
      break;
    case "walk_on":
      if (!b.walk_on.trim()) return "a walk-on beat has no description of the extra";
      if (c.tagger.tagsIn(c.tagger.tag(b.walk_on)).some((n) => { const t = c.tagger.entityOf(n)?.type; return t === "npc" || t === "pc"; })) return `a walk-on is really a known character: "${b.walk_on}"`;
      break;
    case "npc":
      if (!actor || isPc(actor)) return `a player character (${b.actor}) is used as an acting NPC`;
      if (actor.status === "dead") return `${actor.name} is dead but acts`;
      if (!c.present.has(actor.name)) return `${actor.name} isn't here; they can only arrive or reach out from afar`;
      {
        const r = capabilityProblem(actor, c.tagger.render(does));
        if (r) return r;
      }
      break;
    case "arrival":
    case "remote":
      if (b.actor === "walk-on") {
        if (!b.walk_on.trim()) return "an arriving extra has no description";
        break; // an unnamed runner or messenger arriving is fine
      }
      if (!actor || isPc(actor)) return `a player character (${b.actor}) is used as an arriving NPC`;
      if (actor.status === "dead") return `${actor.name} is dead but arrives`;
      {
        const r = b.kind === "arrival" ? capabilityProblem(actor, c.tagger.render(does)) : null;
        if (r) return r;
      }
      break;
    case "outcome":
      if (!actor || !isPc(actor)) return `an outcome beat must be about a player character's declared action (${b.actor})`;
      if (!c.outcomePcs.has(actor.name)) return `${actor.name} didn't do anything in this moment, so there's no outcome for them`;
      if (/^(?:\w+ly\s+)?(?:decides?|chooses?|says?|shouts?|asks?|tells?|insists?|agrees?|refuses?|volunteers?|tries|attempts?|feels?|thinks?|realizes?|wants?|notices?|sees?)\b/i.test(c.tagger.render(does).replace(new RegExp(`^${actor.name}\\s*`, "i"), ""))) {
        return `an outcome decides what ${actor.name} does: "${c.tagger.render(does)}"`;
      }
      break;
  }

  // A PC's body acting on its own ("{Darius}'s legs carry him…") is a forced action: only an
  // outcome of their own declared action, or a failed roll, can do that.
  if (b.kind !== "outcome") {
    for (const m of does.matchAll(FORCED_BODY)) {
      const e = c.tagger.entityOf(m[1]);
      if (e && isPc(e)) return `forces ${e.name}'s body to act before any roll: "${c.tagger.render(does)}"`;
    }
  }

  // Anyone else acting inside the sentence.
  for (const { entity, next } of c.tagger.actingTags(does)) {
    if (actor && entity.name === actor.name) continue; // the beat's own actor
    if (isPc(entity)) return `${entity.name} acts mid-sentence ("${entity.name} ${next}…")`;
    if (!capabilitiesOf(entity).act && entity.status !== "dead") return `${entity.name} can't act right now (${capabilitiesOf(entity).causes?.join(", ") || "incapacitated"}) but does ("${entity.name} ${next}…")`;
    const why = unavailable(entity, c);
    if (why === "dead") return `${entity.name} is dead but acts ("${entity.name} ${next}…")`;
    if (why === "absent" && b.kind !== "arrival" && b.kind !== "remote") return `${entity.name} isn't here but acts ("${entity.name} ${next}…")`;
  }
  // A world beat that opens with a character is that character acting.
  if (b.kind === "world") {
    const first = c.tagger.render(does).trim();
    const lead = c.tagger.tagsIn(does)[0];
    const e = lead ? c.tagger.entityOf(lead) : undefined;
    if (e && first.startsWith(e.name) && !/^['’]s/.test(first.slice(e.name.length))) {
      if (isPc(e)) return `${e.name} acts in a world beat`;
      const why = unavailable(e, c);
      if (why) return `${e.name} is ${why === "dead" ? "dead" : "not here"} but acts in a world beat`;
    }
  }
  return null;
}

// The consequence of a failed roll: the target PC may be forced to act; nobody else may break
// continuity.
export function checkOnFail(target: string, effect: string, c: CheckContext): string | null {
  if (!effect.trim()) return null;
  const tagged = c.tagger.tag(effect);
  for (const { entity, next } of c.tagger.actingTags(tagged)) {
    if (isPc(entity)) {
      if (entity.name !== target) return `on a failure, ${entity.name} (not the one who rolled) acts ("${entity.name} ${next}…")`;
      continue;
    }
    const why = unavailable(entity, c);
    if (why === "dead") return `on a failure, ${entity.name} is dead but acts`;
    if (why === "absent") return `on a failure, ${entity.name} isn't here but acts`;
  }
  return null;
}

const SPEECH = /\b(?:says?|said|whispers?|shouts?|asks?|tells?|mutters?|calls?|answers?|replies|warns?|murmurs?|laughs?|sings?|speaks?)\b/i;

// What a character can't do right now (5e conditions, health, status) against what the beat
// has them do.
export function capabilityProblem(e: Entity, text: string): string | null {
  const caps = capabilitiesOf(e);
  const why = caps.causes?.join(", ") || "incapacitated";
  if (!caps.act) return `${e.name} can't act right now (${why})`;
  if (!caps.speak && SPEECH.test(text)) return `${e.name} can't speak right now (${why})`;
  return null;
}

export { capabilitiesOf };
