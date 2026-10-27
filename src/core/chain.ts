import { holdPlace, MOVES_THERE, placeContext, type PlaceContext } from "./place";
import { applyPlans, beatPlansOn, planMoves, plansBlock, PLAN_TEXT, spentThisSession, type PlanBeat } from "./beat-plans";
import { z } from "zod";
import { APPROACH_SKILLS, FLAVOURS, adoptHand, handText, type Approach, checkOption, contextPrompt, fitToMove, liveRulesOf, settleLost, normaliseHandOff, prepareMoment, renderBeat, renderOption, SCAFFOLD_TEXT, scaffoldParts, TONE_TEXT, type Hand, type Prepared, type ScaffoldOption } from "./improv";
import { callLlm, type LlmResult } from "./llm";
import { db, schema } from "./db/client";
import { PILLARS } from "./db/schema";
import { deltasOf, taggedNames, untag } from "./deltas";
import { SURPRISE_CHANCE, type Surprises } from "./moves";
import { findMoves, moveKey, type Move, type Steer } from "./moves";
import { planSlips } from "./plan-agency";
import { fillSlots, pcOpensClause } from "./slots";
import type { CheckContext, ScaffoldBeat } from "./scaffold";
import type { Overrides } from "./situation";

// Develop v2 (docs/plan-2026-10-25-develop-v2.md): from a choice made at the table, a short chain
// of steps, each what the world does next and then the players' turn. Built on the same engine as
// improv: the GM's steer picks the engine's moves, each step is an improv scaffold (slots, typed
// beats, a hand-off written by code), and code writes how each step follows the last ("On a
// success:", "If they go to the shop:"). The world moves between steps: someone who arrives in one
// step is here in the next, and an item handed over stays handed over.

export const STEER_TEXT: Record<Steer, string> = {
  fight: "a fight. The steps raise the tension toward it: someone squares up, blades come out, there's a last chance to back down. Don't write the attack itself: name who attacks in foes (one of the list, or \"walk-ons\" with foes_desc a plural noun phrase of up to 6 words for someone already hostile in the chain, like \"three Red Hand bandits\"), and code writes the moment it breaks out.",
  heartfelt: "a heartfelt moment. A personal beat for a player character: their condition, a bond, someone who matters to them, a callback. Low on action.",
  epic: "an epic scene. Big and cinematic: threads colliding, high stakes, one striking image, still built only from what's established.",
  grounded: "grounded. Plain, plausible consequences of what's established: no sudden magic, nobody new arriving.",
  quiet: "a quiet moment. Downtime the table can breathe in: small talk, a small kindness, a clue noticed in passing. Nobody new arrives and nothing threatens them.",
  story: "tie to the story. Move the threads toward where the GM wants the story to go, and pay something off.",
};

const SYSTEM = `You are Loom, helping a game master develop what happens next from a choice they just made at the table: more than a quick answer, less than a session plan. Write CHAINS: short sequences of steps, each one what the world does next and then the players' turn. Tie back to threads already in the campaign; don't invent new plots.

Rules:
- Every chain builds on one of the engine's MOVES (move), a different one per chain. Its main thread is thread; also_ties_to lists the move's other threads it genuinely uses. Only the move's cast may be named as actors: those "here" in npc beats, those who "can arrive or send word" in arrival or remote beats (once someone has arrived, write their lines in later steps as kind "arrival" too); a "support" character may have one line. Characters "resting" sit this chain out. Anyone else is a walk-on.
- Get the facts right: who did what to whom must match the threads and cards exactly.
- Follow STEER for what kind of chain the GM wants, STEPS for how long, TONE for how dramatic.
- Serve where the story is going, and build on what this session has already established.
- The GM controls the world, NPCs and consequences; the players control their characters (PCs). Never decide what a PC does, says, thinks or feels. Every step stops at the players' turn and never answers it.
- Use what's established: abilities, health, gear, relationships, the GM's mechanics. GM secrets shape what happens but are never stated outright.
- Small table-level details are fine; new plots, factions or major NPCs are not. Never include anything on the safety lines.

A chain has:
- move, thread, also_ties_to, and refs (every character, place and item any of its steps names).
- opens_on (and opens_if): which outcome of THE PLAYERS' TURN NOW (at the end) the chain develops: a roll's "success" or "failure", a choice's "first" or "second", or "any" after a question, with opens_if a short verb phrase for what they'd do ("go to the shop"), or "". "start" when there's no turn.
- steps: as many as STEPS says. The first develops opens_on. Each later step follows from the players' turn before it, and says how in after:
  - after a roll: "success" or "failure";
  - after a choice: "first" or "second" (which of the two they chose);
  - after a question: "any", with if_they a short verb phrase for what they'd have to do for this step to happen ("go to the shop"), or "" if it happens whatever they do.
  The GM's choice has already been played: never retell it or ask its question again. The first step's own after is ignored. Code writes the joining words ("On a success:", "If they go to the shop:"). Each step is a scaffold: setup, hand and on_fail, as below.
- label: 2-5 words, the chain's title. headline: plain words (no braces), under 12 words, written last, summing up the whole chain; its subject is the world or an NPC, never a player character or the party. why: the move's "because" in your own words, under 15 words. flavour and pillar: what kind of chain it is. callback: a KEY MOMENT's id it echoes ("M12"), or "none".

${SCAFFOLD_TEXT.replace("Each option is a scaffold:", "Each step is a scaffold:")}`;

export interface ChainStep {
  when: string | null; // how it follows the step before ("On a success:"); null for the first
  text: string; // the step, rendered: what happens, then the players' turn (and what a failure costs)
  to: string; // who the players' turn goes to: a PC or "table"
  needs: "roll" | "fight" | null; // a roll to wait on, or the fight a fight chain builds to
  scaffold: ScaffoldOption;
}
export interface Chain {
  label: string;
  headline: string;
  why: string;
  flavour: string | null;
  move: string; // "payoff:12": the engine move it builds on, stable across calls (for another take)
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
  steps: ChainStep[];
  surprise?: string | null; // built on the surprise move: why it's explicable
}

export interface ChainInput {
  beatPlans?: boolean; // the engine plans each beat (beat-plans.ts); default from LOOM_BEAT_PLANS
  moment: string; // what happened at the table
  label?: string; // the choice developed from
  text: string;
  steer?: Steer | null;
  words?: string; // the GM's own words, instead of (or as well as) a steer
  from?: "option" | "step"; // developing from an option or a used choice, or from a step of an earlier chain
  count?: number; // how many chains (1-3)
  exclude?: string[]; // moves already shown (Chain.move), for another take
  tone?: number;
  model?: string;
  overrides?: Overrides;
  refine?: Refine; // rework a chain in place instead of writing new ones
  surprises?: Surprises; // how often a surprise move is offered (default rare)
  turn?: Hand | null; // the players' turn the choice ended on, from its scaffold (undefined: read it from the text)
  onStep?: (index: number, step: ChainStep, n: number) => void; // each step as soon as it's written and checked
  onChain?: (c: Chain, index: number) => void; // each chain once complete: its title, headline and why
  onDrop?: (index: number) => void; // a chain whose steps were shown turned out unusable
}

// How long a chain is: from an option, the next few minutes; from a step, the rest of the scene;
// words that name a stretch of time ("while they rest", "next session") get a longer chain.
const LONGER = /\b(?:while they|rest|camp|travel|journey|road|overnight|tonight|night|morning|downtime|shopping|next session|days?|week)\b/i;
export function stepsFor(input: Pick<ChainInput, "from" | "words">) {
  if (input.words && LONGER.test(input.words)) return { min: 3, max: 4, text: "STEPS: 3-4 steps covering that stretch of time, each 1-2 beats, under 40 words." };
  if (input.from === "step") return { min: 2, max: 2, text: "STEPS: 2 steps, each 1-2 beats, under 30 words." };
  return { min: 2, max: 3, text: "STEPS: 2-3 steps, each 1-2 beats, under 35 words." };
}

/** The steer Loom would suggest for this scene: a hint shown as a ring, never a pick. */
export function suggestSteer(p: Prepared, moves: Move[]): Steer {
  if (moves.some((m) => m.kind === "collision" || m.kind === "rule")) return "epic";
  if (moves.some((m) => m.kind === "payoff" && /ripe/.test(m.because))) return "story";
  if (p.quietest) return "heartfelt";
  if (p.threads.slice(0, 3).some((t) => t.kind === "grudge")) return "fight";
  return "grounded";
}

/** The suggested steer for a choice, from code alone (for the ring, before the GM picks). */
export async function suggestedSteer(campaignId: number, base: Pick<ChainInput, "moment" | "label" | "text">) {
  const p = await prepareMoment(campaignId, `${base.moment}\n→ ${base.label ? `${base.label}: ` : ""}${base.text}`);
  return suggestSteer(p, findMoves(p.scene.situation.view, p.threads, { callbacks: p.callbacks, liveRules: liveRulesOf(p.scene) }));
}

// Threads that share words with the GM's direction: where "tie to the story" leans.
function towardDirection(p: Prepared) {
  const words = new Set((p.direction.toLowerCase().match(/[a-z']{5,}/g) ?? []).filter((w) => !/^(?:there|their|which|where|about|would|could|should|these|those|after|before|party|story)$/.test(w)));
  if (!words.size) return new Set<number>();
  return new Set(p.threads.filter((t) => (`${t.title} ${t.summary}`.toLowerCase().match(/[a-z']{5,}/g) ?? []).some((w) => words.has(w))).map((t) => t.id));
}

function chainSchema(p: Prepared, moves: Move[], turn: Hand | null, foes?: string[], plans: string[] = []) {
  // Kind "npc" offers only who's here: someone away can only arrive or act from afar, and once
  // they've arrived their later lines stay kind "arrival" (rendered the same: name, then what they do).
  const lists = { moves: moves.map((m) => m.id), threads: p.threads.map((t) => `T${t.id}`), nameable: p.lists.nameable, npcActors: p.lists.npcActors, absentActors: p.lists.absentActors, outcomeActors: p.lists.outcomeActors, handOff: p.lists.handOff, pcs: p.lists.pcs, mechanics: p.lists.mechanics, moments: p.callbacks.map((m) => `M${m.id}`), plans };
  const { Beat, Hand, thread, refs, move } = scaffoldParts(lists);
  const step = (after: [string, ...string[]]) => z.object({ after: z.enum(after), if_they: z.string(), setup: z.array(Beat), hand: Hand, on_fail: z.object({ target: z.string(), effect: z.string() }) });
  // The first step can only follow an outcome of the turn the GM's choice ended on, so it can't
  // restage the choice: a roll's success or failure, one side of a choice, an answer to a question.
  const opening: [string, ...string[]] = !turn ? ["start"] : ROLLS.has(turn.kind) ? ["success", "failure"] : turn.kind === "choice" ? ["first", "second"] : ["any"];
  // (Two step shapes made the format too large for the API to compile, so the first step's outcome
  // is its own small field on the chain, and the first step's own "after" is set from it.)
  const Chain = z.object({ move, thread, also_ties_to: z.array(thread), refs, opens_on: z.enum(opening), opens_if: z.string(), steps: z.array(step(["success", "failure", "first", "second", "any"])), label: z.string(), headline: z.string(), why: z.string(), flavour: z.enum(FLAVOURS), pillar: z.enum(PILLARS), callback: z.string() });
  // A fight chain says who attacks: someone the engine counts as hostile, or an unnamed group.
  const Fight = foes ? Chain.extend({ foes: z.enum(["walk-ons", ...foes]), foes_desc: z.string() }) : Chain;
  return { Schema: z.object({ chains: z.array(Fight) }), Chain: Fight };
}
// Words of four letters or more: what a sentence is about.
const content = (t: string) => (t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !/^(?:that|this|with|from|into|their|there|they|them|then|over|your|what|when|while|have|been|were|will|just)$/.test(w));
/** Whether a sentence mostly says again what the GM's choice already said. */
export const retells = (sentence: string, choice: string) => {
  const words = content(sentence);
  const said = new Set(content(choice));
  return words.length >= 4 && words.filter((w) => said.has(w)).length / words.length >= 0.6;
};

type RawStep = { after: string; if_they: string; setup: ScaffoldBeat[]; hand: Hand; on_fail: { target: string; effect: string } };
type RawHead = { move: string; thread: string; also_ties_to: string[]; refs: { name: string; as: "object" | "possessor" }[] };

/**
 * The players' turn the GM's choice ends on, read back from Loom's own sentence (code wrote it, so
 * its shape is known): a choice's two sides, a question, or a roll. Step 1 follows from it.
 */
export function choiceHand(text: string, pcs: string[]): Hand | null {
  const who = (name: string) => (pcs.includes(name.trim()) ? name.trim() : "table");
  const choice = /Ask (.+?)(?:'s player)?: do you (.+?), or (.+?)\?/.exec(text);
  if (choice) return { kind: "choice", to: who(choice[1]), what: choice[2], or: choice[3] };
  const question = /Ask (.+?)(?:'s player)?: what do you do/.exec(text);
  if (question) return { kind: "question", to: who(question[1]) };
  const roll = /(?:^|[.!?]\s+)([A-Z][\w' -]*?) makes an? ([^.]*?)\b(check|saving throw|contest|attack roll|death saving throw|roll)\b/.exec(text);
  if (roll) {
    const skill = /\(([A-Z][\w ]+)\)/.exec(roll[2])?.[1] ?? "none";
    const ability = /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b/.exec(roll[2])?.[1] ?? "none";
    return { kind: roll[3] === "saving throw" ? "save" : roll[3] === "contest" ? "contest" : roll[3] === "attack roll" ? "attack" : "check", to: roll[1] === "Everyone" ? "table" : who(roll[1]), skill, ability };
  }
  return null;
}

const ROLLS = new Set(["check", "contest", "attack", "notice", "save", "rule", "death_save"]);
const phrase = (t = "") => t.trim().replace(/[.?!]+$/, "").replace(/^(?:to|you)\s+/i, "");

/**
 * A chain's steps, one at a time, in order. Each is checked in the world as the steps before it
 * left it: who has arrived is here, items handed over stay handed over, and a PC whose player
 * answered a question or made a choice is now acting on it (so a check is theirs to make).
 * A step that breaks a rule ends the chain there: the steps after it followed from it.
 */
export class StepRunner {
  steps: ChainStep[] = [];
  private firstHand: Hand | null;
  ended = false;
  private present: Set<string>;
  private holders: Map<string, Set<string>>;
  private named = new Set<string>(); // everyone and everything the chain (and the choice) has named so far
  private said: string[] = []; // what the choice and the steps so far say, for what a turn may ask about
  plans = new Map<string, PlanBeat[]>(); // the moves' beat plans, when they're on
  private usedPlans = new Set<string>(); // plan beats the chain has already written
  private lost = new Set<string>(); // things dropped sentences introduced: later steps can't refer to them
  private away: string | null = null; // a place an earlier step pointed to, which the party isn't at
  private moved = false; // the players chose to go somewhere: where "here" is, code no longer knows
  private places: PlaceContext | null = null;
  constructor(
    private p: Prepared,
    private head: RawHead,
    private move: Move | undefined,
    private label: string,
    private steer: Steer | null, // what the GM asked for: some steers are requirements (see take)
    private log: { label: string; reason: string }[],
    private prevHand: Hand | null, // the players' turn the GM's choice ended on
    private base = "", // the GM's choice as written
  ) {
    this.firstHand = prevHand;
    for (const n of taggedNames(p.lists.tagger.tag(base))) this.named.add(n);
    this.said.push(base);
    this.present = new Set(p.lists.check.present);
    this.holders = new Map([...p.lists.check.possession.holders].map(([k, v]) => [k, new Set(v)]));
  }

  // How this step follows the last, in code's words, from the players' turn before it.
  private when(raw: RawStep): string | null {
    const h = this.prevHand;
    if (!h || raw.after === "start") return null;
    const t = this.p.lists.tagger;
    const words = (x: string) => t.render(t.tag(phrase(x)));
    if (ROLLS.has(h.kind)) return raw.after === "failure" ? "On a failure:" : "On a success:";
    if (h.kind === "choice") return `If they ${words(raw.after === "second" ? (h.or ?? "") : (h.what ?? ""))}:`;
    return phrase(raw.if_they) ? `If they ${words(raw.if_they)}:` : "Then:";
  }

  take(raw: RawStep): ChainStep | undefined {
    if (this.ended || !raw?.setup) return;
    const n = this.steps.length;
    // After a roll, what follows depends on how it went: never "whatever happens".
    if (this.prevHand && ROLLS.has(this.prevHand.kind) && raw.after !== "failure") raw = { ...raw, after: "success" };
    const base = this.p.lists.check;
    // Who a check may go to: nobody has declared anything yet in the first step; after a question
    // or a choice, the PC (or table) who answered it.
    const answered = this.prevHand && !ROLLS.has(this.prevHand.kind) ? [this.prevHand.to] : [];
    const ctx: CheckContext = { ...base, present: this.present, checkTo: answered, outcomePcs: new Set(answered.filter((x) => x !== "table")), possession: { ...base.possession, holders: this.holders }, declaredSkills: null };
    // A move's cast member who has arrived may now act here.
    const move = this.move && { ...this.move, cast: this.move.cast.map((c) => (c.can === "arrive" && this.present.has(c.name) ? { ...c, can: "act" as const } : c)) };
    const stepOption = { ...this.head, label: this.label, setup: raw.setup, hand: raw.hand, on_fail: raw.on_fail, why: "", hand_off: { to: raw.hand.to, kind: "question" as const, mechanic: "none", text: "" } } as ScaffoldOption;
    // Each sentence remembers its place, so code can tell later which were dropped.
    const rawSetup = (raw.setup ?? []) as unknown as { does?: string; kind?: string; src?: number }[];
    rawSetup.forEach((b, i) => (b.src = i));
    const filled = fillSlots(applyPlans(adoptHand(stepOption), this.plans, this.log, this.usedPlans), this.p.lists.tagger);
    for (const d of filled.dropped) this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: ${d}` });
    if (filled.problem) return void this.end(`step ${n + 1}: ${filled.problem}`);
    const o = filled.option;
    const t0 = this.p.lists.tagger;
    normaliseHandOff(o, ctx);
    if (move) fitToMove(o, [move], ctx, this.log);
    // The choice has been played: a sentence in the first step that mostly retells it goes.
    if (n === 0 && this.base) {
      const fresh = o.setup.filter((b) => b.byCode || !retells(t0.render(t0.tag(b.does)), this.base));
      if (fresh.length < o.setup.length) this.log.push({ label: this.label, reason: `step 1: sentence dropped: retells the choice` });
      if (fresh.length) o.setup = fresh;
      else return void this.end("step 1: only retells the choice");
    }
    // Someone not here yet can't act here: their sentence goes (they arrive first, in a beat of
    // kind "arrival").
    const here = o.setup.filter((b) => {
      const away = b.kind === "npc" && !this.present.has(b.actor);
      if (away) this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: ${b.actor} isn't here yet` });
      return !away;
    });
    if (here.length) o.setup = here;
    else return void this.end(`step ${n + 1}: nobody left to act`);
    // Some steers are requirements, not just leanings: in a grounded or quiet chain nobody new
    // arrives, and a quiet one has no danger to roll against.
    if (this.steer === "grounded" || this.steer === "quiet") {
      const calm = o.setup.filter((b) => !((b.kind === "arrival" || b.kind === "remote") && b.actor !== "walk-on" && b.actor !== "world"));
      if (calm.length < o.setup.length) this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: nobody new arrives in a ${this.steer} chain` });
      if (calm.length) o.setup = calm;
      else return void this.end(`step ${n + 1}: only an arrival, in a ${this.steer} chain`);
    }
    // It happens where the party is, until the players choose to go (a join like "If they head for
    // the camp:"): a place mentioned, in this step or an earlier one, doesn't take them there.
    const join = this.when(raw);
    if (join && MOVES_THERE.test(join)) this.moved = true;
    if (!this.moved) {
      this.places ??= placeContext(this.p.scene.situation);
      this.away = holdPlace(o, this.places, (r) => this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: ${r}` }), this.away);
    }
    // What a dropped sentence set up (in this step or an earlier one) never happened.
    const keepLog = (x: { label: string; reason: string }) => this.log.push({ label: x.label, reason: `step ${n + 1}: ${x.reason}` });
    const sink: { label: string; reason: string }[] = [];
    const left = settleLost(o, rawSetup, sink, this.lost);
    sink.forEach(keepLog);
    this.lost = new Set(o.lost ?? []);
    if (!left) return void this.end(`step ${n + 1}: nothing left once what dropped sentences set up was removed`);
    if (this.steer === "quiet" && o.hand && ["attack", "save"].includes(o.hand.kind)) {
      o.hand = { kind: "question", to: o.hand.to };
      o.hand_off = { to: o.hand.to, ...handText(o.hand) };
      o.on_fail = { target: "none", effect: "" };
    }
    // A step that asks again for the roll its choice already asked for ("Everyone makes an
    // Investigation check…" twice) hands the turn to the same players as a question instead.
    const first = this.firstHand;
    // The same goes for asking the choice's own question again ("do you hand over the coin, or…").
    const norm = (x = "") => phrase(x).toLowerCase();
    const sameRoll = first && ROLLS.has(first.kind) && o.hand && ROLLS.has(o.hand.kind) && o.hand.to === first.to && (first.skill !== "none" ? o.hand.skill === first.skill : (o.hand.ability ?? "none") === first.ability);
    const sameChoice = first?.kind === "choice" && o.hand?.kind === "choice" && (norm(o.hand.what) === norm(first.what) || norm(o.hand.or) === norm(first.or));
    if (n === 0 && (sameRoll || sameChoice)) {
      o.hand = { kind: "question", to: o.hand_off.to };
      o.hand_off = { to: o.hand_off.to, ...handText(o.hand) };
      o.on_fail = { target: "none", effect: "" };
      this.log.push({ label: this.label, reason: `step 1: repeated the choice's ${sameRoll ? "roll" : "question"}; asked what they do instead` });
    }
    // A check after a choice holds to how the chosen side is done: "talk her round" is a talking
    // skill, "climb the wall" a physical one.
    const prev = this.prevHand;
    const approach = prev?.kind === "choice" ? (raw.after === "second" ? prev.or_approach : raw.after === "first" ? prev.approach : undefined) : undefined;
    const skills = approach ? (APPROACH_SKILLS[approach as Approach] ?? []) : [];
    if (o.hand && skills.length && (o.hand.kind === "check" || o.hand.kind === "contest" || o.hand.kind === "attack") && !skills.includes(o.hand.skill ?? "")) {
      if (o.hand.kind !== "attack" || !["force", "magic", "item"].includes(approach!)) {
        this.log.push({ label: this.label, reason: `step ${n + 1}: ${o.hand.kind} held to the chosen approach (${approach}: ${skills[0]})` });
        o.hand = { ...o.hand, kind: o.hand.kind === "attack" ? "check" : o.hand.kind, skill: skills[0], ability: "none" };
        o.hand_off = { to: o.hand.to, ...handText(o.hand) };
      }
    }
    // A turn can only be about what's been set up: someone or something the choice or the steps
    // have named, or words they've used. Otherwise it's a plain "what do you do?".
    const stepNames = new Set([...this.named, ...o.setup.flatMap((b) => [b.actor, ...taggedNames(t0.tag(b.does))]), ...this.present, ...this.p.lists.pcs]);
    const stepWords = new Set(content([...this.said, ...o.setup.map((b) => untag(t0.tag(b.does)))].join(" ")));
    if (o.hand?.what) {
      const strangers = taggedNames(t0.tag(o.hand.what)).filter((x) => !stepNames.has(t0.entityOf(x)?.name ?? x));
      // The two sides of a choice are what the players might do, so they're new by nature: only
      // their names are held to what's been set up.
      const words = o.hand.kind === "choice" ? [] : content(untag(t0.tag(o.hand.what)));
      if (strangers.length || (words.length >= 2 && !words.some((w) => stepWords.has(w)))) {
        this.log.push({ label: this.label, reason: `step ${n + 1}: the turn asked about something not set up (${strangers.join(", ") || untag(o.hand.what)})` });
        o.hand = o.hand.kind === "choice" ? { kind: "question", to: o.hand.to } : { ...o.hand, what: "" };
        o.hand_off = { to: o.hand.to, ...handText(o.hand) };
      }
    }
    const reason = checkOption(o, ctx);
    if (reason) return void this.end(`step ${n + 1}: ${reason}`);

    // No two steps open on the same condition ("If they deal with the guards" twice).
    let when = this.when(raw);
    if (when && when !== "Then:" && this.steps.some((x) => x.when === when)) when = "Then:";
    const step: ChainStep = { when, text: renderOption(o, t0), to: o.hand_off.to, needs: o.hand_off.kind === "roll" ? (this.steer === "fight" && o.hand?.kind === "attack" ? "fight" : "roll") : null, scaffold: o };
    this.leaves(step);
    return step;
  }

  /**
   * A fight chain ends in a fight, written by code: who attacks is from the engine's list (or an
   * unnamed group, in a few words), and everyone rolls initiative. Unless the last step already
   * started it with an attack.
   */
  fightFinale(foes: string, desc: string): ChainStep | undefined {
    if (this.ended || !this.steps.length) return;
    const last = this.steps[this.steps.length - 1];
    if (last.needs === "fight") return;
    const t = this.p.lists.tagger;
    const e = foes !== "walk-ons" ? t.entityOf(foes) : undefined;
    // The group as a noun phrase: up to 8 words, ending before any trailing preposition or article
    // ("two bandits from the toll-house" stays whole; "two bandits from the" loses "from the").
    let words = phrase(desc).split(/\s+/).filter(Boolean).slice(0, 8);
    while (words.length && /^(?:from|of|in|at|on|by|with|near|the|a|an|and|to)$/i.test(words[words.length - 1])) words = words.slice(0, -1);
    const group = words.join(" ");
    // One attacker attacks; several attack.
    const one = /^(?:a|an|one|the|this|that|single|lone)\b/i.test(group) && !/\b(?:men|bandits|guards|thugs|patrons|soldiers|zealots|cultists|people|crowd)\b/i.test(group);
    const who = e ? `{${e.name}} ${e.type === "faction" ? "attack" : "attacks"}` : group ? `${group.charAt(0).toUpperCase()}${group.slice(1)} ${one ? "attacks" : "attack"}` : "";
    if (!who) return;
    const prev = this.prevHand;
    const scaffold = { ...this.head, label: this.label, setup: [{ kind: "world", actor: "world", walk_on: "", does: `${who}.`, byCode: true }], hand: { kind: "attack", to: "table" }, hand_off: { to: "table", kind: "roll", mechanic: "none", text: "Everyone rolls initiative." }, on_fail: { target: "none", effect: "" }, why: "" } as ScaffoldOption;
    const step: ChainStep = { when: prev && ROLLS.has(prev.kind) ? "On a failure:" : "Then:", text: `${t.render(`${who}.`)} Everyone rolls initiative.`, to: "table", needs: "fight", scaffold };
    this.leaves(step);
    return step;
  }

  /** A step already written and checked (kept when a later step is swapped): the world moves on as it did. */
  keep(step: ChainStep) {
    if (!this.ended) this.leaves(step);
  }

  // The world as a step leaves it: who has arrived, who holds what, whose turn it is.
  private leaves(step: ChainStep) {
    const t = this.p.lists.tagger;
    const d = deltasOf(step.scaffold, (n) => t.entityOf(n)?.type === "item");
    for (const a of d.arrivals) this.present.add(a);
    // An item handed over ("tosses the {X} to {Y}") stays with its new holder.
    for (const h of d.handovers) this.holders.set(h.item, new Set([h.to]));
    for (const b of step.scaffold.setup) for (const x of [b.actor, ...taggedNames(b.does)]) if (x && x !== "world" && x !== "walk-on") this.named.add(t.entityOf(x)?.name ?? x);
    this.said.push(step.text);
    this.steps.push(step);
    this.prevHand = step.scaffold.hand ?? null;
  }

  private end(reason: string) {
    this.ended = true;
    this.log.push({ label: this.label, reason: this.steps.length ? `chain cut short at ${reason}` : `chain rejected: ${reason}` });
  }
}

// The complete elements of a JSON array still being written, and the one in progress.
function scanArray(text: string, key: string): { done: string[]; partial: string | null } {
  const k = text.indexOf(`"${key}"`);
  const at = k < 0 ? -1 : text.indexOf("[", k);
  if (at < 0) return { done: [], partial: null };
  const done: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" && --depth === 0) done.push(text.slice(start, i + 1));
    else if (ch === "]" && depth === 0) return { done, partial: null };
  }
  return { done, partial: depth > 0 ? text.slice(start) : null };
}

/** Ways to rework a chain in place. "swap" rewrites from one step on, keeping the steps before it. */
export interface Refine {
  chain: Chain; // the chain as it reads now (with its steps' scaffolds)
  how: string; // "shorter", "darker", "lighter", "bring in Zara", or the GM's own words
  fromStep?: number; // swap: rewrite from this step (0-based), keeping the ones before
}

const REFINE_TEXT: Record<string, string> = {
  shorter: "Make it shorter: fewer steps (at least one fewer if it has more than one), and fewer, shorter beats.",
  darker: "Make it darker: higher stakes, a grimmer turn, a real cost; still tied to the same threads.",
  lighter: "Make it lighter: warmer or funnier, lower stakes; still tied to the same threads.",
};

/** Develop's chain: steer → the engine's moves → one (or a few) chains of steps. */
export async function developChain(campaignId: number, input: ChainInput) {
  const moment = [input.moment, input.label || input.text ? `→ ${input.label ? `${input.label}: ` : ""}${input.text}` : ""].filter(Boolean).join("\n");
  const p = await prepareMoment(campaignId, moment, { overrides: input.overrides });
  const refine = input.refine;
  const count = refine ? 1 : Math.max(1, Math.min(3, input.count ?? 1));
  const steer = input.steer ?? null;
  let moves = findMoves(p.scene.situation.view, p.threads, { callbacks: p.callbacks, liveRules: liveRulesOf(p.scene), steer: steer ?? undefined, toward: steer === "story" ? towardDirection(p) : undefined, exclude: input.exclude, limit: Math.max(4, count + 2), surprise: refine ? undefined : { chance: SURPRISE_CHANCE[input.surprises ?? "rare"], seed: `${campaignId}|${input.text}|${steer ?? input.words ?? ""}|${p.scene.situation.view.g.log.length}` } });
  // A rework stays on the chain's move; "bring in X" puts X in its cast, to arrive if they aren't here.
  const bring = refine && /^bring in /i.test(refine.how) ? refine.how.replace(/^bring in /i, "").trim() : null;
  if (refine) {
    const same = findMoves(p.scene.situation.view, p.threads, { callbacks: p.callbacks, liveRules: liveRulesOf(p.scene), limit: 40 }).find((m) => moveKey(m) === refine.chain.move);
    moves = [same ?? moves[0]].filter(Boolean).map((m, i) => ({ ...m, id: `M${i + 1}` }));
    const who = bring ? p.scene.entities.find((e) => e.name.toLowerCase().startsWith(bring.toLowerCase())) : undefined;
    if (who && moves[0] && !moves[0].cast.some((c) => c.name === who.name)) {
      moves[0] = { ...moves[0], cast: [...moves[0].cast, { name: who.name, can: p.lists.check.present.has(who.name) ? "act" : "arrive", part: "lead" }] };
    }
  }
  // A swap keeps the steps before it (code puts them back); the new steps follow the players' turn
  // the last kept step ended on, so only they are asked for.
  const keep = refine?.fromStep != null ? refine.chain.steps.slice(0, refine.fromStep) : [];
  const lastKept = keep[keep.length - 1];
  // The turn the choice ended on: from its scaffold when Loom built it, else read from its sentence.
  const turn = lastKept ? (lastKept.scaffold.hand ?? null) : input.turn !== undefined ? input.turn : choiceHand(input.text, p.lists.pcs);
  // Who could start a fight: hostile or unfriendly characters and factions within reach, alive.
  const foes = steer === "fight" ? p.scene.entities.filter((e) => (e.type === "npc" || e.type === "faction") && ["hostile", "unfriendly"].includes(e.attitude ?? "") && e.status !== "dead" && p.lists.nameable.includes(e.name)).map((e) => e.name) : undefined;
  // Beat plans: the engine decides what each step's beats deliver; a chain uses each plan beat once.
  const plans = new Map<string, PlanBeat[]>();
  if (beatPlansOn(input.beatPlans)) {
    for (const [k, b] of planMoves(p.scene.situation.view, moves, { size: 4, spent: spentThisSession(p.scene.situation.view) }).plans) plans.set(k, b);
  }
  const planIds = [...plans.values()].flat().map((b) => b.id);
  const { Schema, Chain } = chainSchema(p, moves, turn, foes, planIds);
  const StepSchema = Chain.shape.steps.element;
  const sized = stepsFor(input);
  const steps = keep.length ? { ...sized, max: Math.max(1, sized.max - keep.length), text: `STEPS: ${Math.max(1, sized.max - keep.length)} new step${sized.max - keep.length > 1 ? "s" : ""} after the kept ones, each 1-2 beats, under 35 words.` } : refine && refine.how !== "shorter" ? { ...sized, text: `STEPS: ${refine.chain.steps.length} steps, as now, each 1-2 beats, under 35 words.` } : sized;
  const titleOf = p.titleOf;

  const current = refine
    ? `

THE CHAIN AS IT READS NOW
${refine.chain.steps.map((st, i) => `${i + 1}. ${st.when ? `${st.when} ` : ""}${st.text}`).join("\n")}

CHANGE IT: ${
        refine.fromStep != null
          ? `steps 1-${refine.fromStep} stay as they are (code keeps them; don't write them). Write a different step ${refine.fromStep + 1} onward, following the players' turn step ${refine.fromStep} ends on${refine.how && refine.how !== "swap" ? `: ${REFINE_TEXT[refine.how] ?? refine.how}` : "."}`
          : bring
            ? `bring in ${bring}: they arrive or act from afar, tied to their threads. Keep what works.`
            : (REFINE_TEXT[refine.how] ?? `The GM says: ${refine.how}`)
      } Stay on the same move and threads. Write new sentences, not the old ones with a word changed.`
    : "";

  const prompt = `${contextPrompt(p, moves, "chain")}${planIds.length ? `${plansBlock(p.scene.situation.view, plans)}\nPLANNED BEATS\n${PLAN_TEXT} Across a chain, spread its move's plan over the steps: each beat once, in order.\n` : ""}
${steps.text}
STEER: ${[steer ? STEER_TEXT[steer] : "", input.words ? `The GM's own words (follow them): ${input.words}` : ""].filter(Boolean).join(" ") || "your best read of where this goes next."}
${TONE_TEXT[Math.max(0, Math.min(4, input.tone ?? 1))]}
Write ${count} chain${count === 1 ? "" : "s"}${count > 1 ? ", each on a different move" : ""}.

WHAT HAPPENED AT THE TABLE
${input.moment}

THE GM'S CHOICE (already played)
${input.label ? `${input.label}: ` : ""}${input.text}

THE PLAYERS' TURN NOW${lastKept ? ` (step ${keep.length} ends on it: ${lastKept.text.slice(-200)})` : ""}
${!turn ? 'None: opens_on is "start".' : ROLLS.has(turn.kind) ? 'The roll above. opens_on is its "success" or its "failure".' : turn.kind === "choice" ? `A choice: first "${turn.what}", second "${turn.or}". opens_on is one of them.` : 'The question above. opens_on is "any", with opens_if.'}${current}`;

  const log: { label: string; reason: string }[] = [];
  const accepted: Chain[] = [];
  const calls: LlmResult<unknown>[] = [];

  // One runner per chain as it streams in: its steps are checked (and shown) one at a time, in
  // order, as each is written; the chain's title, headline and why come when it's complete.
  type Live = { run: StepRunner; used: number; move: Move | undefined; dropped: boolean };
  const live = new Map<number, Live>();
  type Head = RawHead & { opens_on: string; opens_if: string };
  const startRun = (index: number, head: Head) => {
    const move = moves.find((m) => m.id === head.move);
    const run = new StepRunner(p, head, move, `chain ${index + 1}`, steer, log, turn, input.text);
    run.plans = plans;
    for (const st of keep) run.keep(st);
    const l: Live = { run, used: 0, move, dropped: false };
    live.set(index, l);
    for (const st of keep) input.onStep?.(index, st, run.steps.indexOf(st));
    return l;
  };
  // Raw steps in order; the first takes the chain's opening outcome, and kept steps (a swap) are
  // skipped in what the model wrote.
  const feed = (index: number, l: Live, head: Head, raws: unknown[]) => {
    for (; l.used < raws.length && l.used < steps.max; l.used++) {
      const parsed = StepSchema.safeParse(raws[l.used]);
      if (!parsed.success) {
        if (!l.run.ended) log.push({ label: `chain ${index + 1}`, reason: `step ${l.used + 1}: unusable answer` });
        l.run.ended = true;
        return;
      }
      let raw = parsed.data as unknown as RawStep;
      if (l.used === 0) raw = { ...raw, after: head.opens_on, if_they: head.opens_if.trim() || raw.if_they };
      const st = l.run.take(raw);
      if (st && index < count && !l.dropped) input.onStep?.(index, st, l.run.steps.length - 1);
    }
  };

  const finish = (index: number, raw: unknown) => {
    const parsed = Chain.safeParse(raw);
    let l = live.get(index);
    if (!parsed.success) {
      log.push({ label: (raw as { label?: string })?.label ?? `chain ${index + 1}`, reason: "chain rejected: unusable answer (a value outside the allowed lists)" });
      if (l?.run.steps.length) input.onDrop?.(index);
      return;
    }
    const c = parsed.data as unknown as Head & { steps: RawStep[]; label: string; headline: string; why: string; flavour: string; callback: string };
    l ??= startRun(index, c);
    feed(index, l, c, c.steps);
    if (steer === "fight") {
      const f = c as unknown as { foes?: string; foes_desc?: string };
      const fin = l.run.fightFinale(f.foes ?? "walk-ons", f.foes_desc ?? "");
      if (fin && index < count) input.onStep?.(index, fin, l.run.steps.length - 1);
    }
    if (!l.run.steps.length || index >= count) return;
    const { run, move } = l;
    const t = p.lists.tagger;
    const idOf = (ref: string) => Number(ref.replace(/^T/, ""));
    const main = move && !move.threads.includes(idOf(c.thread)) ? move.threads[0] : idOf(c.thread);
    const ids = [...new Set([main, ...c.also_ties_to.map(idOf)])].filter((id) => titleOf.has(id));
    // A headline is about the world or an NPC; one that decides for the players falls back to the
    // first step's first beat, or the label.
    const fine = (h: string) => !!h && h.split(/\s+/).length <= 13 && !planSlips(h, p.scene.pcs).length && !/\bwalk-on\b/i.test(h) && !pcOpensClause(t.tag(h), t);
    const label = c.label.trim() || t.render(t.tag(c.headline)).split(/\s+/).slice(0, 5).join(" ") || "Next";
    const headline = [t.render(t.tag(c.headline)), run.steps[0].scaffold.setup[0] ? renderBeat(run.steps[0].scaffold.setup[0], t).replace(/[.!?]$/, "") : "", label].find(fine) ?? label;
    const cb = p.callbacks.find((m) => `M${m.id}` === c.callback?.trim());
    const chain: Chain = { label, headline, why: t.render(t.tag(c.why)), flavour: c.flavour ?? null, move: move ? moveKey(move) : (refine?.chain.move ?? c.thread), threads: ids.map((id) => ({ id, title: titleOf.get(id)! })), callback: cb ? { id: cb.id, title: cb.title } : null, steps: run.steps, surprise: move?.surprise ?? refine?.chain.surprise ?? null };
    accepted.push(chain);
    input.onChain?.(chain, index);
  };

  for (let attempt = 0; attempt < 2 && !accepted.length; attempt++) {
    const base = attempt * 10; // a retry's chains get their own indexes
    let seen = 0;
    const onText = (snapshot: string) => {
      const { done, partial } = scanArray(snapshot, "chains");
      for (; seen < done.length; seen++) {
        try {
          finish(base + seen, JSON.parse(done[seen]));
        } catch {
          // not whole yet; the final answer settles it
        }
      }
      // The chain being written: once its head is complete, its steps go through as they finish.
      if (!partial) return;
      const at = partial.indexOf('"steps"');
      if (at < 0) return;
      const index = base + seen;
      try {
        const head = JSON.parse(`${partial.slice(0, at).replace(/,\s*$/, "")}}`) as Head;
        const l = live.get(index) ?? startRun(index, head);
        feed(index, l, head, scanArray(partial, "steps").done.map((x) => JSON.parse(x)));
      } catch {
        // the head isn't whole yet
      }
    };
    try {
      const res = await callLlm({ feature: "chain", campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 6000, effort: "low", model: input.model, fast: true, onText });
      calls.push(res);
      for (const [i, c] of res.data.chains.entries()) if (i >= seen) finish(base + i, c);
    } catch (err) {
      if (err instanceof Error && /credit has run out|AI allowance|switched off/.test(err.message)) throw err;
      for (const [i, l] of live) if (i >= base && l.run.steps.length && !accepted.some((c) => c.steps === l.run.steps)) input.onDrop?.(i);
      log.push({ label: `attempt ${attempt + 1}`, reason: `unusable answer (${err instanceof Error ? err.message.slice(0, 300) : "error"}…)` });
    }
  }

  const llm = {
    model: calls[0]?.model ?? "(no answer)",
    latencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    costUsd: calls.reduce((s, c) => s + c.costUsd, 0),
    attempts: calls.length,
  };
  if (log.length) {
    await db
      .insert(schema.optionRejections)
      .values(log.map((r) => ({ campaignId, model: llm.model, moment: `[develop${refine ? ` refine ${refine.how}` : steer ? ` ${steer}` : ""}] ${input.text}`.slice(0, 1000), label: r.label, reason: r.reason, kept: accepted.length })))
      .catch(() => {});
  }
  return { chains: accepted, suggested: suggestSteer(p, moves), moves, log, llm };
}
