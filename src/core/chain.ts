import { z } from "zod";
import { FLAVOURS, adoptHand, handText, checkOption, completedOptions, contextPrompt, fitToMove, liveRulesOf, normaliseHandOff, prepareMoment, renderBeat, renderOption, SCAFFOLD_TEXT, scaffoldParts, TONE_TEXT, type Hand, type Prepared, type ScaffoldOption } from "./improv";
import { callLlm, type LlmResult } from "./llm";
import { db, schema } from "./db/client";
import { PILLARS } from "./db/schema";
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
  fight: "a fight. Build toward one: earlier steps raise the tension, and the last step is the moment it breaks out (pillar combat), with who is fighting and where.",
  heartfelt: "a heartfelt moment. A personal beat for a player character: their condition, a bond, someone who matters to them, a callback. Low on action.",
  epic: "an epic scene. Big and cinematic: threads colliding, high stakes, one striking image, still built only from what's established.",
  grounded: "grounded. Plain, plausible consequences of what's established: no sudden magic, nobody new arriving.",
  quiet: "a quiet moment. Downtime the table can breathe in: small talk, a small kindness, a clue noticed in passing.",
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
}

export interface ChainInput {
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
  onChain?: (c: Chain) => void; // each chain as soon as it's complete and checked
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

// Threads that share words with the GM's direction: where "tie to the story" leans.
function towardDirection(p: Prepared) {
  const words = new Set((p.direction.toLowerCase().match(/[a-z']{5,}/g) ?? []).filter((w) => !/^(?:there|their|which|where|about|would|could|should|these|those|after|before|party|story)$/.test(w)));
  if (!words.size) return new Set<number>();
  return new Set(p.threads.filter((t) => (`${t.title} ${t.summary}`.toLowerCase().match(/[a-z']{5,}/g) ?? []).some((w) => words.has(w))).map((t) => t.id));
}

function chainSchema(p: Prepared, moves: Move[], turn: Hand | null) {
  // Kind "npc" offers only who's here: someone away can only arrive or act from afar, and once
  // they've arrived their later lines stay kind "arrival" (rendered the same: name, then what they do).
  const lists = { moves: moves.map((m) => m.id), threads: p.threads.map((t) => `T${t.id}`), nameable: p.lists.nameable, npcActors: p.lists.npcActors, absentActors: p.lists.absentActors, outcomeActors: p.lists.outcomeActors, handOff: p.lists.handOff, pcs: p.lists.pcs, mechanics: p.lists.mechanics, moments: p.callbacks.map((m) => `M${m.id}`) };
  const { Beat, Hand, thread, refs, move } = scaffoldParts(lists);
  const step = (after: [string, ...string[]]) => z.object({ after: z.enum(after), if_they: z.string(), setup: z.array(Beat), hand: Hand, on_fail: z.object({ target: z.string(), effect: z.string() }) });
  // The first step can only follow an outcome of the turn the GM's choice ended on, so it can't
  // restage the choice: a roll's success or failure, one side of a choice, an answer to a question.
  const opening: [string, ...string[]] = !turn ? ["start"] : ROLLS.has(turn.kind) ? ["success", "failure"] : turn.kind === "choice" ? ["first", "second"] : ["any"];
  // (Two step shapes made the format too large for the API to compile, so the first step's outcome
  // is its own small field on the chain, and the first step's own "after" is set from it.)
  const Chain = z.object({ move, thread, also_ties_to: z.array(thread), refs, opens_on: z.enum(opening), opens_if: z.string(), steps: z.array(step(["success", "failure", "first", "second", "any"])), label: z.string(), headline: z.string(), why: z.string(), flavour: z.enum(FLAVOURS), pillar: z.enum(PILLARS), callback: z.string() });
  return { Schema: z.object({ chains: z.array(Chain) }), Chain };
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
  constructor(
    private p: Prepared,
    private head: RawHead,
    private move: Move | undefined,
    private label: string,
    private fightAt: number | null, // the step that breaks into a fight, for a fight chain
    private log: { label: string; reason: string }[],
    private prevHand: Hand | null, // the players' turn the GM's choice ended on
    private base = "", // the GM's choice as written
  ) {
    this.firstHand = prevHand;
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

  take(raw: RawStep) {
    if (this.ended || !raw?.setup) return;
    const n = this.steps.length;
    // After a roll, what follows depends on how it went: never "whatever happens".
    if (this.prevHand && ROLLS.has(this.prevHand.kind) && raw.after !== "failure") raw = { ...raw, after: "success" };
    const base = this.p.lists.check;
    // Who a check may go to: nobody has declared anything yet in the first step; after a question
    // or a choice, the PC (or table) who answered it.
    const answered = this.prevHand && !ROLLS.has(this.prevHand.kind) ? [this.prevHand.to] : [];
    const ctx: CheckContext = { ...base, present: this.present, checkTo: answered, outcomePcs: new Set(answered.filter((x) => x !== "table")), possession: { ...base.possession, holders: this.holders } };
    // A move's cast member who has arrived may now act here.
    const move = this.move && { ...this.move, cast: this.move.cast.map((c) => (c.can === "arrive" && this.present.has(c.name) ? { ...c, can: "act" as const } : c)) };
    const stepOption = { ...this.head, label: this.label, setup: raw.setup, hand: raw.hand, on_fail: raw.on_fail, why: "", hand_off: { to: raw.hand.to, kind: "question" as const, mechanic: "none", text: "" } } as ScaffoldOption;
    const filled = fillSlots(adoptHand(stepOption), this.p.lists.tagger);
    for (const d of filled.dropped) this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: ${d}` });
    if (filled.problem) return this.end(`step ${n + 1}: ${filled.problem}`);
    const o = filled.option;
    const t0 = this.p.lists.tagger;
    normaliseHandOff(o, ctx);
    if (move) fitToMove(o, [move], ctx, this.log);
    // The choice has been played: a sentence in the first step that mostly retells it goes.
    if (n === 0 && this.base) {
      const fresh = o.setup.filter((b) => b.byCode || !retells(t0.render(t0.tag(b.does)), this.base));
      if (fresh.length < o.setup.length) this.log.push({ label: this.label, reason: `step 1: sentence dropped: retells the choice` });
      if (fresh.length) o.setup = fresh;
      else return this.end("step 1: only retells the choice");
    }
    // Someone not here yet can't act here: their sentence goes (they arrive first, in a beat of
    // kind "arrival").
    const here = o.setup.filter((b) => {
      const away = b.kind === "npc" && !this.present.has(b.actor);
      if (away) this.log.push({ label: this.label, reason: `step ${n + 1}: sentence dropped: ${b.actor} isn't here yet` });
      return !away;
    });
    if (here.length) o.setup = here;
    else return this.end(`step ${n + 1}: nobody left to act`);
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
    const reason = checkOption(o, ctx);
    if (reason) return this.end(`step ${n + 1}: ${reason}`);

    // The world as this step leaves it.
    for (const b of o.setup) if (b.kind === "arrival" && b.actor !== "walk-on" && b.actor !== "world") this.present.add(b.actor);
    const t = this.p.lists.tagger;
    for (const b of o.setup) {
      // An item handed over ("tosses the {X} to {Y}") stays with its new holder.
      for (const m of t.tag(b.does).matchAll(/\{([^}|]+)(?:\|[^}]*)?\}[^{]{0,40}?\bto\s+\{([^}|]+)(?:\|[^}]*)?\}/g)) {
        if (t.entityOf(m[1])?.type === "item") this.holders.set(m[1], new Set([m[2]]));
      }
    }
    const isFight = this.fightAt != null && n + 1 >= this.fightAt;
    this.steps.push({
      when: this.when(raw),
      text: renderOption(o, t),
      to: o.hand_off.to,
      needs: isFight ? "fight" : o.hand_off.kind === "roll" ? "roll" : null,
      scaffold: o,
    });
    this.prevHand = o.hand ?? null;
  }

  private end(reason: string) {
    this.ended = true;
    this.log.push({ label: this.label, reason: this.steps.length ? `chain cut short at ${reason}` : `chain rejected: ${reason}` });
  }
}

/** Develop's chain: steer → the engine's moves → one (or a few) chains of steps. */
export async function developChain(campaignId: number, input: ChainInput) {
  const moment = [input.moment, input.label || input.text ? `→ ${input.label ? `${input.label}: ` : ""}${input.text}` : ""].filter(Boolean).join("\n");
  const p = await prepareMoment(campaignId, moment, { overrides: input.overrides });
  const count = Math.max(1, Math.min(3, input.count ?? 1));
  const steer = input.steer ?? null;
  const moves = findMoves(p.scene.situation.view, p.threads, { callbacks: p.callbacks, liveRules: liveRulesOf(p.scene), steer: steer ?? undefined, toward: steer === "story" ? towardDirection(p) : undefined, exclude: input.exclude, limit: Math.max(4, count + 2) });
  const turn = choiceHand(input.text, p.lists.pcs);
  const { Schema, Chain } = chainSchema(p, moves, turn);
  const steps = stepsFor(input);
  const titleOf = p.titleOf;

  const prompt = `${contextPrompt(p, moves, "chain")}
${steps.text}
STEER: ${[steer ? STEER_TEXT[steer] : "", input.words ? `The GM's own words (follow them): ${input.words}` : ""].filter(Boolean).join(" ") || "your best read of where this goes next."}
${TONE_TEXT[Math.max(0, Math.min(4, input.tone ?? 1))]}
Write ${count} chain${count === 1 ? "" : "s"}${count > 1 ? ", each on a different move" : ""}.

WHAT HAPPENED AT THE TABLE
${input.moment}

THE GM'S CHOICE (already played)
${input.label ? `${input.label}: ` : ""}${input.text}

THE PLAYERS' TURN NOW
${!turn ? "None: opens_on is \"start\"." : ROLLS.has(turn.kind) ? 'The roll above. opens_on is its "success" or its "failure".' : turn.kind === "choice" ? `A choice: first "${turn.what}", second "${turn.or}". opens_on is one of them.` : "The question above. opens_on is \"any\", with opens_if."}`;

  const log: { label: string; reason: string }[] = [];
  const accepted: Chain[] = [];
  const calls: LlmResult<unknown>[] = [];

  // Each chain is taken as soon as it's complete in the stream, its steps checked in order.
  const finish = (raw: unknown) => {
    const parsed = Chain.safeParse(raw);
    if (!parsed.success) return log.push({ label: (raw as { label?: string })?.label ?? "a chain", reason: "chain rejected: unusable answer (a value outside the allowed lists)" });
    const raw2 = parsed.data as unknown as RawHead & { opens_on: string; opens_if: string; steps: RawStep[] };
    const opening = raw2.steps[0] && { ...raw2.steps[0], after: raw2.opens_on, if_they: raw2.opens_if.trim() || raw2.steps[0].if_they };
    const c = { ...raw2, steps: opening ? [opening, ...raw2.steps.slice(1)] : [] } as unknown as RawHead & { steps: RawStep[]; label: string; headline: string; why: string; flavour: string; callback: string };
    const move = moves.find((m) => m.id === c.move);
    const fightAt = steer === "fight" ? Math.max(1, c.steps.length) : null;
    const run = new StepRunner(p, c, move, c.label, fightAt, log, turn, input.text);
    for (const s of c.steps.slice(0, steps.max)) run.take(s);
    if (!run.steps.length) return;
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
    const chain: Chain = { label, headline, why: t.render(t.tag(c.why)), flavour: c.flavour ?? null, move: move ? moveKey(move) : c.thread, threads: ids.map((id) => ({ id, title: titleOf.get(id)! })), callback: cb ? { id: cb.id, title: cb.title } : null, steps: run.steps };
    if (accepted.length >= count) return;
    accepted.push(chain);
    input.onChain?.(chain);
  };

  for (let attempt = 0; attempt < 2 && !accepted.length; attempt++) {
    let seen = 0;
    const onText = (snapshot: string) => {
      const done = completedOptions(snapshot, "chains");
      for (; seen < done.length; seen++) {
        try {
          finish(JSON.parse(done[seen]));
        } catch {
          // not whole yet; the final answer settles it
        }
      }
    };
    try {
      const res = await callLlm({ feature: "chain", campaignId, system: SYSTEM, prompt, schema: Schema, maxTokens: 6000, effort: "low", model: input.model, fast: true, onText });
      calls.push(res);
      for (const c of res.data.chains.slice(seen)) finish(c);
    } catch (err) {
      if (err instanceof Error && /credit has run out/.test(err.message)) throw err;
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
      .values(log.map((r) => ({ campaignId, model: llm.model, moment: `[develop${steer ? ` ${steer}` : ""}] ${input.text}`.slice(0, 1000), label: r.label, reason: r.reason, kept: accepted.length })))
      .catch(() => {});
  }
  return { chains: accepted, suggested: suggestSteer(p, moves), moves, log, llm };
}
