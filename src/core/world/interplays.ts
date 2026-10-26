import { PAIR_WEIGHTS } from "../db/schema";
import type { View } from "./engine";
import type { AnyNode, Character, Faction, Goal, NodeKey } from "./nodes";
import { propertyOf, type PropValue } from "./properties";
import { weightsOf } from "./props";

// Interplays (docs/design-2026-10-26-property-model.md §6): named relationships between properties,
// on one character, between two, or across a thread, faction or item. A tension pulls two ways
// (conflicted, resists the charm); an alignment reinforces (devoted, steadfast). Each row says when
// it holds, how strong it is (1–3: how far past its thresholds), its handle for prompts and the
// inspector, and what it gives the engine (move kinds, behaviour bounds, hand-off offers). Rows
// carry examples that run as tests (npm run test:engine). Interplays are worked out, never
// stored; the DM can switch one on or off for a character (traits.interplay_overrides), and their
// starts and ends go to the change log (recordInterplayChanges).

export type InterplayKind = "tension" | "alignment";
export interface Interplay {
  id: string; // the row: "conflicted"
  name: string; // "conflicted"
  kind: InterplayKind;
  subject: NodeKey;
  other?: NodeKey; // the other end, for pairs and across-links
  strength: 1 | 2 | 3;
  handle: string; // "torn: means to finish the ritual, but has come to like Iresia"
  because: string[];
  moves: string[]; // move kinds it's a source of (waver, strain, defect…)
  loosens: string[]; // behaviour bounds it may loosen (see BOUNDS)
  tightens: string[];
  offers: string[]; // hand-offs it can offer ("hold the charm", "read the hesitation")
  secret: boolean; // it rests on something GM-only: shapes suggestions, never stated
  by: "engine" | "dm"; // worked out, or switched on by the DM
}

// Behaviour bounds an interplay can set or loosen, for planned acts (beat plans): what someone may
// be written doing. "act-against-goal": helping against their own goal; "turn-on": betraying or
// attacking the one they're bound to; "harm-charmer": harming whoever charmed them (the charm law:
// nothing loosens it).
export const BOUNDS = {
  "act-against-goal": "may act against their own goal",
  "turn-on": "turns on the one they're bound to",
  "refuse-charmer": "refuses or stalls an order from whoever charmed them",
  "harm-charmer": "harms whoever charmed them",
} as const;
// Which tension may loosen which alignment's bound (§6.3). Nothing loosens harm-charmer or turn-on.
export const LOOSENABLE: Record<string, string[]> = { conflicted: ["act-against-goal"], "resists the charm": ["refuse-charmer"], "hollow loyalty": [], cornered: [] };

// ---------- Helpers ----------

const chars = (v: View) => [...v.g.nodes.values()].filter((n): n is Character => n.kind === "character");
const pcs = (v: View) => chars(v).filter((c) => c.side === "pc");
const nameOf = (v: View, k?: string) => (k ? (v.g.nodes.get(k as NodeKey)?.name ?? "someone") : "someone");
const top = (goals: Goal[]) => [...goals].filter((g) => !g.status || g.status === "active" || g.status === "blocked").sort((a, b) => a.priority - b.priority)[0];
const band = (p: PropValue | null) => (p && p.value != null ? p.band : null);
const w = (v: View, a: NodeKey, b: NodeKey) => weightsOf(v, a, b);
const num = (x: { known: boolean; value: number | null }) => (x.known ? (x.value as number) : null);
const clamp3 = (n: number) => Math.max(1, Math.min(3, Math.round(n))) as 1 | 2 | 3;
const secretGoal = (n: Character) => !!top(n.mind.goals)?.secret;
const linksTo = (v: View, from: NodeKey, type: string) => v.g.linksOf(from, { type, dir: "out" }).map((l) => v.g.other(l, from));

interface Found {
  subject: NodeKey;
  other?: NodeKey;
  strength: number;
  handle: string;
  because: string[];
  secret?: boolean;
}
export interface InterplayDef {
  id: string;
  kind: InterplayKind;
  scope: "one" | "pair" | "across";
  moves: string[];
  loosens?: string[];
  tightens?: string[];
  offers?: string[];
  find: (v: View) => Found[];
  examples: InterplayExample[];
}

// An example, in the small world language of test-graph.ts: who's who, and whether it fires for the subject.
export interface InterplayExample {
  says: string;
  world: Record<string, PersonSpec>;
  subject: string;
  other?: string;
  fires: boolean;
}
export interface PersonSpec {
  pc?: boolean;
  faction?: boolean;
  item?: boolean;
  goals?: { intent?: number; commitment?: number; target?: string; priority?: number; text?: string }[];
  aims?: { intent?: number; commitment?: number; target?: string }[];
  disposition?: Record<string, number>;
  state?: Record<string, number>;
  toward?: Record<string, Partial<Record<(typeof PAIR_WEIGHTS)[number], number>>>;
  conditions?: { name: string; by?: string }[];
  ties?: [type: string, to: string][]; // relationship types: serves, member_of, enemy, holds…
  secrets?: string[];
  health?: string;
  status?: string;
  pull?: number; // items
  cohesion?: never;
  clock?: [number, number]; // factions
  alert?: number;
  threads?: string[]; // threads they're in (by title)
}

// ---------- The first set (§6.1) ----------

export const INTERPLAYS: InterplayDef[] = [
  {
    id: "conflicted",
    kind: "tension",
    scope: "one",
    moves: ["waver"],
    loosens: ["act-against-goal"],
    offers: ["read the hesitation (Insight)"],
    find: (v) =>
      chars(v)
        .filter((c) => c.side === "npc")
        .flatMap((c) => {
          const intent = propertyOf(v, c.key as NodeKey, "intent");
          if (!intent || intent.value == null || intent.value > -1) return [];
          const warm = pcs(v)
            .map((p) => ({ p, warmth: num(w(v, c.key as NodeKey, p.key as NodeKey).warmth) }))
            .filter((x) => (x.warmth ?? -9) >= 2)
            .sort((a, b) => (b.warmth ?? 0) - (a.warmth ?? 0))[0];
          const standing = propertyOf(v, c.key as NodeKey, "standing");
          if (!warm && (standing?.value ?? -9) < 1) return [];
          const g = top(c.mind.goals);
          const who = warm?.p.name ?? "the party";
          return [{ subject: c.key as NodeKey, other: warm?.p.key as NodeKey | undefined, strength: 1 + (intent.value <= -2 ? 1 : 0) + ((warm?.warmth ?? 0) >= 3 ? 1 : 0), handle: `torn: means to ${g?.text ?? "do harm"}, but has come to like ${who}`, because: [`intent ${intent.band}`, warm ? `warmth to ${who} +${warm.warmth}` : `standing ${standing?.band}`], secret: secretGoal(c) }];
        }),
    examples: [
      { says: "harmful goal, warm to a PC", world: { Vex: { goals: [{ intent: -2, commitment: 3 }], toward: { Iresia: { warmth: 2 } } }, Iresia: { pc: true } }, subject: "Vex", fires: true },
      { says: "harmful goal, cold to everyone", world: { Vex: { goals: [{ intent: -2 }], toward: { Iresia: { warmth: -1 } } }, Iresia: { pc: true } }, subject: "Vex", fires: false },
      { says: "kind goal, warm (aligned, not torn)", world: { Tomas: { goals: [{ intent: 2 }], toward: { Darius: { warmth: 3 } } }, Darius: { pc: true } }, subject: "Tomas", fires: false },
    ],
  },
  {
    id: "resists the charm",
    kind: "tension",
    scope: "one",
    moves: ["strain"],
    loosens: ["refuse-charmer"],
    offers: ["hold the charm (the charmer's Charisma check)"],
    find: (v) =>
      chars(v).flatMap((c) => {
        const charm = (v.body.get(c.key as NodeKey) ?? c.body).conditions.find((x) => /^charmed/i.test(x.name));
        if (!charm) return [];
        const resolve = propertyOf(v, c.key as NodeKey, "resolve");
        const g = top(c.mind.goals);
        const against = g && (g.intent ?? 0) <= -2 && (g.commitment ?? 0) >= 2;
        if (band(resolve) !== "iron" && !against) return [];
        const by = nameOf(v, charm.by);
        return [{ subject: c.key as NodeKey, other: charm.by as NodeKey | undefined, strength: (band(resolve) === "iron" ? 2 : 1) + (against ? 1 : 0), handle: `charmed by ${by}, but straining: the charm runs against ${g ? `"${g.text}"` : "everything they want"}`, because: [`charmed by ${by}`, ...(band(resolve) === "iron" ? ["resolve iron"] : []), ...(against ? [`committed to "${g!.text}" (${g!.commitment})`] : [])], secret: secretGoal(c) }];
      }),
    examples: [
      { says: "charmed, committed to a harmful goal", world: { Vex: { goals: [{ intent: -2, commitment: 3 }], conditions: [{ name: "charmed", by: "Iresia" }] }, Iresia: { pc: true } }, subject: "Vex", fires: true },
      { says: "charmed, with a mild goal", world: { Pip: { goals: [{ intent: 1, commitment: 1 }], conditions: [{ name: "charmed", by: "Iresia" }] }, Iresia: { pc: true } }, subject: "Pip", fires: false },
    ],
  },
  {
    id: "cornered",
    kind: "tension",
    scope: "one",
    moves: ["bargain", "lash out"],
    find: (v) =>
      chars(v)
        .filter((c) => c.side === "npc")
        .flatMap((c) => {
          const intent = band(propertyOf(v, c.key as NodeKey, "intent"));
          const pressure = propertyOf(v, c.key as NodeKey, "pressure");
          if (!(intent === "malign" || intent === "self-serving") || band(pressure) !== "cornered") return [];
          return [{ subject: c.key as NodeKey, strength: clamp3((pressure!.value ?? 4) - 3), handle: "cornered: desperate enough to bargain, or to lash out", because: [`intent ${intent}`, ...pressure!.because] }];
        }),
    examples: [
      { says: "captured and badly hurt, with a harmful goal", world: { Vex: { goals: [{ intent: -2 }], status: "captured", health: "critical" } }, subject: "Vex", fires: true },
      { says: "captured, but kindly", world: { Eldric: { goals: [{ intent: 2 }], status: "captured", health: "critical" } }, subject: "Eldric", fires: false },
    ],
  },
  {
    id: "secret strain",
    kind: "tension",
    scope: "one",
    moves: ["confide"],
    find: (v) =>
      chars(v)
        .filter((c) => c.side === "npc" && c.knowledge.some((k) => k.secret))
        .flatMap((c) => {
          const close = pcs(v)
            .map((p) => ({ p, trust: num(w(v, c.key as NodeKey, p.key as NodeKey).trust) }))
            .filter((x) => (x.trust ?? -9) >= 2)
            .sort((a, b) => (b.trust ?? 0) - (a.trust ?? 0))[0];
          if (!close) return [];
          return [{ subject: c.key as NodeKey, other: close.p.key as NodeKey, strength: clamp3((close.trust ?? 2) - 1), handle: `aching to tell ${close.p.name} what they know`, because: [`holds a secret`, `trusts ${close.p.name} (+${close.trust})`], secret: true }];
        }),
    examples: [
      { says: "holds a secret, trusts a PC", world: { Ysolde: { secrets: ["the batch was mislabelled"], toward: { Kira: { trust: 2 } } }, Kira: { pc: true } }, subject: "Ysolde", fires: true },
      { says: "holds a secret, trusts nobody", world: { Ysolde: { secrets: ["the batch was mislabelled"], toward: { Kira: { trust: 0 } } }, Kira: { pc: true } }, subject: "Ysolde", fires: false },
    ],
  },
  {
    id: "fear over greed",
    kind: "tension",
    scope: "one",
    moves: ["comply under pressure"],
    offers: ["who do you remind them to fear?"],
    find: (v) =>
      chars(v)
        .filter((c) => c.side === "npc")
        .flatMap((c) => {
          const greed = c.mind.disposition.greed ?? null;
          const g = top(c.mind.goals);
          const grasping = (greed ?? 0) >= 2 || ((g?.intent ?? 0) <= -1 && (g?.intent ?? 0) >= -2 && (g?.commitment ?? 0) >= 2);
          if (!grasping) return [];
          const feared = chars(v)
            .filter((o) => o.key !== c.key)
            .map((o) => ({ o, fear: num(w(v, c.key as NodeKey, o.key as NodeKey).fear) }))
            .filter((x) => (x.fear ?? 0) >= 2)
            .sort((a, b) => (b.fear ?? 0) - (a.fear ?? 0))[0];
          if (!feared) return [];
          return [{ subject: c.key as NodeKey, other: feared.o.key as NodeKey, strength: clamp3((feared.fear ?? 2) - 1 + ((greed ?? 0) >= 3 ? 1 : 0)), handle: `would sell you out, if they weren't so scared of ${feared.o.name}`, because: [(greed ?? 0) >= 2 ? `grasping (+${greed})` : `self-serving: "${g?.text}"`, `afraid of ${feared.o.name} (${feared.fear})`] }];
        }),
    examples: [
      { says: "greedy and afraid of Varek", world: { Arlen: { disposition: { greed: 2 }, toward: { Varek: { fear: 2 } } }, Varek: {} }, subject: "Arlen", fires: true },
      { says: "greedy, afraid of nobody", world: { Arlen: { disposition: { greed: 2 } }, Varek: {} }, subject: "Arlen", fires: false },
    ],
  },
  {
    id: "steadfast",
    kind: "alignment",
    scope: "one",
    moves: [],
    tightens: ["act-against-goal"],
    offers: ["persuading them against their goal is a contest"],
    find: (v) =>
      chars(v)
        .filter((c) => c.side === "npc")
        .flatMap((c) => {
          const intent = band(propertyOf(v, c.key as NodeKey, "intent"));
          const resolve = propertyOf(v, c.key as NodeKey, "resolve");
          if (intent !== "benign" || band(resolve) !== "iron") return [];
          return [{ subject: c.key as NodeKey, strength: clamp3((resolve!.value ?? 4) - 3), handle: "won't be moved from what's right", because: ["intent benign", "resolve iron"] }];
        }),
    examples: [
      { says: "kind goal, iron resolve", world: { Zara: { goals: [{ intent: 2, commitment: 3 }], state: { confidence: 2 }, disposition: { boldness: 2 } } }, subject: "Zara", fires: true },
      { says: "kind goal, lukewarm", world: { Zara: { goals: [{ intent: 2, commitment: 1 }] } }, subject: "Zara", fires: false },
    ],
  },
  {
    id: "devoted",
    kind: "alignment",
    scope: "pair",
    moves: [],
    tightens: ["turn-on"],
    find: (v) =>
      chars(v).flatMap((c) =>
        pcs(v)
          .filter((p) => p.key !== c.key)
          .flatMap((p) => {
            const x = w(v, c.key as NodeKey, p.key as NodeKey);
            const warmth = num(x.warmth);
            const trust = num(x.trust);
            if ((warmth ?? -9) < 2 || (trust ?? -9) < 2) return [];
            return [{ subject: c.key as NodeKey, other: p.key as NodeKey, strength: clamp3((warmth ?? 2) + (trust ?? 2) - 3), handle: `would take a blade for ${p.name}`, because: [`warmth +${warmth}`, `trust +${trust}`] }];
          }),
      ),
    examples: [
      { says: "warm and trusting toward a PC", world: { Tomas: { toward: { Darius: { warmth: 3, trust: 2 } } }, Darius: { pc: true } }, subject: "Tomas", other: "Darius", fires: true },
      { says: "warm but wary", world: { Tomas: { toward: { Darius: { warmth: 3, trust: 0 } } }, Darius: { pc: true } }, subject: "Tomas", other: "Darius", fires: false },
    ],
  },
  {
    id: "hollow loyalty",
    kind: "tension",
    scope: "pair",
    moves: ["defect"],
    find: (v) =>
      chars(v).flatMap((c) =>
        [...linksTo(v, c.key as NodeKey, "serves"), ...linksTo(v, c.key as NodeKey, "member_of")].flatMap((lord) => {
          const x = w(v, c.key as NodeKey, lord);
          const loyalty = num(x.loyalty);
          const warmth = num(x.warmth);
          if (loyalty == null || loyalty > 1 || warmth == null || warmth > 0) return [];
          return [{ subject: c.key as NodeKey, other: lord, strength: clamp3(2 - loyalty - warmth), handle: `serves ${nameOf(v, lord)}, but has no love for them`, because: [`loyalty ${loyalty}`, `warmth ${warmth}`] }];
        }),
      ),
    examples: [
      { says: "a member with little loyalty and no warmth", world: { Guard: { ties: [["member_of", "Red Hand"]], toward: { "Red Hand": { loyalty: 1, warmth: -1 } } }, "Red Hand": { faction: true } }, subject: "Guard", fires: true },
      { says: "a plain member (defaults only)", world: { Guard: { ties: [["member_of", "Red Hand"]] }, "Red Hand": { faction: true } }, subject: "Guard", fires: false },
    ],
  },
  {
    id: "torn loyalties",
    kind: "tension",
    scope: "pair",
    moves: ["choose a side"],
    find: (v) =>
      chars(v).flatMap((c) => {
        const lords = [...linksTo(v, c.key as NodeKey, "serves"), ...linksTo(v, c.key as NodeKey, "member_of")].filter((l) => (num(w(v, c.key as NodeKey, l).loyalty) ?? 0) >= 2);
        return lords.flatMap((lord) => {
          const lordNode = v.g.nodes.get(lord);
          const enemies = new Set([...linksTo(v, lord, "enemy"), ...v.g.linksOf(lord, { type: "enemy", dir: "in" }).map((l) => v.g.other(l, lord))]);
          const aims = (lordNode?.kind === "faction" ? (lordNode as Faction).aims : lordNode?.kind === "character" ? (lordNode as Character).mind.goals : []).filter((g) => (g.intent ?? 0) < 0 && g.target);
          for (const a of aims) enemies.add(a.target as NodeKey);
          return chars(v)
            .filter((b) => b.key !== c.key && enemies.has(b.key as NodeKey) && (num(w(v, c.key as NodeKey, b.key as NodeKey).warmth) ?? -9) >= 2)
            .map((b) => ({ subject: c.key as NodeKey, other: b.key as NodeKey, strength: 2, handle: `owes everything to ${nameOf(v, lord)}, but won't see ${b.name} harmed`, because: [`loyal to ${nameOf(v, lord)}`, `warm to ${b.name}`, `${nameOf(v, lord)} is against ${b.name}`] }));
        });
      }),
    examples: [
      { says: "loyal to a lord who means a friend harm", world: { Tomas: { ties: [["serves", "Azarath"]], toward: { Azarath: { loyalty: 3 }, Pip: { warmth: 2 } } }, Azarath: { goals: [{ intent: -2, target: "Pip" }] }, Pip: {} }, subject: "Tomas", fires: true },
      { says: "loyal, and the friend isn't threatened", world: { Tomas: { ties: [["serves", "Azarath"]], toward: { Azarath: { loyalty: 3 }, Pip: { warmth: 2 } } }, Azarath: { goals: [{ intent: -2 }] }, Pip: {} }, subject: "Tomas", fires: false },
    ],
  },
  {
    id: "unrequited",
    kind: "tension",
    scope: "pair",
    moves: ["character"],
    find: (v) =>
      chars(v).flatMap((a) =>
        chars(v)
          .filter((b) => b.key !== a.key)
          .flatMap((b) => {
            const ab = num(w(v, a.key as NodeKey, b.key as NodeKey).warmth);
            const ba = num(w(v, b.key as NodeKey, a.key as NodeKey).warmth);
            if (ab == null || ba == null || ab - ba < 3 || ab < 2) return [];
            return [{ subject: a.key as NodeKey, other: b.key as NodeKey, strength: clamp3(ab - ba - 2), handle: `adores ${b.name}; ${b.name} barely returns it`, because: [`warmth +${ab}`, `${b.name}'s warmth ${ba}`] }];
          }),
      ),
    examples: [
      { says: "warm one way, cold the other", world: { Pip: { toward: { Bram: { warmth: 3 } } }, Bram: { pc: true, toward: { Pip: { warmth: 0 } } } }, subject: "Pip", other: "Bram", fires: true },
      { says: "warm both ways", world: { Pip: { toward: { Bram: { warmth: 3 } } }, Bram: { pc: true, toward: { Pip: { warmth: 2 } } } }, subject: "Pip", other: "Bram", fires: false },
    ],
  },
  {
    id: "mutual distrust",
    kind: "tension",
    scope: "pair",
    moves: ["collision"],
    find: (v) =>
      chars(v).flatMap((a) =>
        chars(v)
          .filter((b) => (a.key as string) < (b.key as string))
          .flatMap((b) => {
            const ab = num(w(v, a.key as NodeKey, b.key as NodeKey).trust);
            const ba = num(w(v, b.key as NodeKey, a.key as NodeKey).trust);
            if ((ab ?? 9) > -2 || (ba ?? 9) > -2) return [];
            const threadsOf = (k: NodeKey) => new Set(v.g.linksOf(k, { type: "in_thread", dir: "out" }).map((l) => v.g.other(l, k)));
            const shared = [...threadsOf(a.key as NodeKey)].filter((t) => threadsOf(b.key as NodeKey).has(t));
            if (!shared.length) return [];
            return [{ subject: a.key as NodeKey, other: b.key as NodeKey, strength: 2, handle: `${a.name} and ${b.name} need each other, and trust each other not at all`, because: [`trust ${ab} and ${ba}`, `both in "${nameOf(v, shared[0])}"`] }];
          }),
      ),
    examples: [
      { says: "distrust both ways, in the same thread", world: { Kira: { pc: true, toward: { Ysolde: { trust: -2 } }, threads: ["The cure"] }, Ysolde: { toward: { Kira: { trust: -2 } }, threads: ["The cure"] } }, subject: "Kira", other: "Ysolde", fires: true },
      { says: "distrust both ways, nothing shared", world: { Kira: { pc: true, toward: { Ysolde: { trust: -2 } } }, Ysolde: { toward: { Kira: { trust: -2 } } } }, subject: "Kira", other: "Ysolde", fires: false },
    ],
  },
  {
    id: "rivals in purpose",
    kind: "tension",
    scope: "across",
    moves: ["collision"],
    find: (v) => {
      const holders = [...v.g.nodes.values()].filter((n): n is Character | Faction => n.kind === "character" || n.kind === "faction");
      const goalsOf = (n: Character | Faction) => (n.kind === "faction" ? n.aims : n.mind.goals).filter((g) => g.target && g.intent != null && Math.abs(g.intent) >= 1 && (!g.status || g.status === "active"));
      const out: Found[] = [];
      for (const a of holders)
        for (const b of holders) {
          if ((a.key as string) >= (b.key as string)) continue;
          for (const ga of goalsOf(a))
            for (const gb of goalsOf(b))
              if (ga.target === gb.target && Math.sign(ga.intent!) !== Math.sign(gb.intent!)) out.push({ subject: a.key as NodeKey, other: b.key as NodeKey, strength: clamp3((Math.abs(ga.intent!) + Math.abs(gb.intent!)) / 2), handle: `${a.name} and ${b.name} both want ${nameOf(v, ga.target)}, for opposite ends`, because: [`"${ga.text}" (${ga.intent! > 0 ? "+" : ""}${ga.intent})`, `"${gb.text}" (${gb.intent! > 0 ? "+" : ""}${gb.intent})`] });
        }
      return out;
    },
    examples: [
      { says: "one would use the Lodestone to harm, one to heal", world: { Azarath: { goals: [{ intent: -3, target: "Lodestone" }] }, Zara: { goals: [{ intent: 2, target: "Lodestone" }] }, Lodestone: { item: true } }, subject: "Azarath", other: "Zara", fires: true },
      { says: "both want it for the same end", world: { Azarath: { goals: [{ intent: -3, target: "Lodestone" }] }, Varek: { goals: [{ intent: -2, target: "Lodestone" }] }, Lodestone: { item: true } }, subject: "Azarath", other: "Varek", fires: false },
    ],
  },
  {
    id: "faction fracture",
    kind: "tension",
    scope: "one",
    moves: ["infighting"],
    find: (v) =>
      [...v.g.nodes.values()]
        .filter((n): n is Faction => n.kind === "faction")
        .flatMap((f) => {
          const cohesion = propertyOf(v, f.key as NodeKey, "cohesion");
          const pressing = (f.clock && f.clock.filled / f.clock.of >= 0.5) || (f.alert ?? 0) >= 2;
          if (band(cohesion) !== "fractured" || !pressing) return [];
          return [{ subject: f.key as NodeKey, strength: 2, handle: `${f.name} is splitting as the pressure mounts`, because: [...cohesion!.because, f.clock ? `clock ${f.clock.filled} of ${f.clock.of}` : `alert ${f.alert}`] }];
        }),
    examples: [
      { says: "hollow members, alert faction", world: { "Red Hand": { faction: true, alert: 2 }, A: { ties: [["member_of", "Red Hand"]], toward: { "Red Hand": { loyalty: 0, warmth: -1 } } }, B: { ties: [["member_of", "Red Hand"]], toward: { "Red Hand": { loyalty: 0 } } } }, subject: "Red Hand", fires: true },
      { says: "loyal members", world: { "Red Hand": { faction: true, alert: 2 }, A: { ties: [["member_of", "Red Hand"]], toward: { "Red Hand": { loyalty: 3 } } } }, subject: "Red Hand", fires: false },
    ],
  },
  {
    id: "the pull",
    kind: "tension",
    scope: "across",
    moves: ["use it"],
    offers: ["a temptation: the item calls (a sensation, never the use itself, for a PC)"],
    find: (v) =>
      chars(v).flatMap((c) => {
        const t = propertyOf(v, c.key as NodeKey, "temptation");
        if (band(t) !== "gripping") return [];
        const item = t!.terms[0]?.label.split(" pulls")[0] ?? "an item";
        return [{ subject: c.key as NodeKey, strength: clamp3((t!.value ?? 3) - 1.5), handle: `${item} wants to be used again`, because: t!.because }];
      }),
    examples: [
      { says: "holds a strong pull, wavering resolve", world: { Khayiulad: { pc: true, ties: [["holds", "Knight figurine"]], goals: [{ commitment: 0 }] }, "Knight figurine": { item: true, pull: 3 } }, subject: "Khayiulad", fires: true },
      { says: "holds a weak pull", world: { Khayiulad: { pc: true, ties: [["holds", "Knight figurine"]] }, "Knight figurine": { item: true, pull: 1 } }, subject: "Khayiulad", fires: false },
    ],
  },
];

// ---------- Working them out ----------

const cache = new WeakMap<View, Interplay[]>();
const overridesOf = (n: AnyNode | undefined) => ((n as unknown as { interplayOverrides?: { id: string; on: boolean; other?: string }[] })?.interplayOverrides ?? []);

/** Every interplay that holds in this view, strongest first, with the DM's overrides applied. */
export function interplaysOf(v: View): Interplay[] {
  const hit = cache.get(v);
  if (hit) return hit;
  const out: Interplay[] = [];
  for (const def of INTERPLAYS) {
    for (const f of def.find(v)) {
      const subject = v.g.nodes.get(f.subject);
      const off = overridesOf(subject).find((o) => o.id === def.id && !o.on && (!o.other || o.other === f.other));
      if (off) continue;
      out.push({ id: def.id, name: def.id, kind: def.kind, subject: f.subject, other: f.other, strength: clamp3(f.strength), handle: f.handle, because: f.because, moves: def.moves, loosens: def.loosens ?? [], tightens: def.tightens ?? [], offers: def.offers ?? [], secret: !!f.secret, by: "engine" });
    }
  }
  // Switched on by the DM, whatever the numbers say.
  for (const n of v.g.nodes.values()) {
    for (const o of overridesOf(n).filter((x) => x.on)) {
      if (out.some((x) => x.id === o.id && x.subject === n.key && (!o.other || x.other === o.other))) continue;
      const def = INTERPLAYS.find((d) => d.id === o.id);
      if (!def) continue;
      out.push({ id: def.id, name: def.id, kind: def.kind, subject: n.key as NodeKey, other: o.other as NodeKey | undefined, strength: 2, handle: `${def.id}${o.other ? ` (with ${nameOf(v, o.other)})` : ""}`, because: ["the DM says so"], moves: def.moves, loosens: def.loosens ?? [], tightens: def.tightens ?? [], offers: def.offers ?? [], secret: false, by: "dm" });
    }
  }
  out.sort((a, b) => b.strength - a.strength);
  cache.set(v, out);
  return out;
}

/** The interplays of one node, as subject (or as the other end, when `either`). */
export const interplaysFor = (v: View, key: NodeKey, either = false) => interplaysOf(v).filter((i) => i.subject === key || (either && i.other === key));

/**
 * What someone may be written doing (§6.3, §7.5): the bounds their alignments tighten, less those a
 * tension on the same character may loosen. Nothing loosens harming the charmer or turning on the
 * one they're devoted to.
 */
export function boundsFor(v: View, key: NodeKey) {
  const mine = interplaysFor(v, key);
  const forbidden = new Set(mine.filter((i) => i.kind === "alignment").flatMap((i) => i.tightens));
  const charmed = (v.body.get(key) ?? (v.g.nodes.get(key) as Character | undefined)?.body)?.conditions?.some((c) => /^charmed/i.test(c.name));
  if (charmed) forbidden.add("harm-charmer");
  const allowed = new Set<string>();
  for (const t of mine.filter((i) => i.kind === "tension")) {
    for (const b of t.loosens) {
      if ((LOOSENABLE[t.id] ?? []).includes(b)) {
        forbidden.delete(b);
        allowed.add(b);
      }
    }
  }
  forbidden.delete("refuse-charmer");
  return { forbidden: [...forbidden], allowed: [...allowed] };
}

/** One interplay in a line: "Vex'ahlia: charmed by Iresia, but straining… (resists the charm)". */
export const interplayLine = (v: View, i: Interplay) => `${nameOf(v, i.subject)}: ${i.handle} (${i.name}${i.by === "dm" ? ", by the GM" : ""})${i.secret ? " [GM secret]" : ""}`;
