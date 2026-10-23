import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import type { EntityTraits } from "./entity-fields";
import { callLlm, type LlmResult } from "./llm";
import { findMentions, loadThreadContexts, retrieveThreads, type ThreadContext } from "./retrieval";
import { buildScene, type Scene } from "./scene";

// Options come back in parts so the code can enforce player agency: the setup may only be
// things the world or NPCs do; players get involved through a question or a roll; and a
// player character may only act against their player's will in on_fail, after a failed roll.
const OptionsSchema = z.object({
  options: z.array(
    z.object({
      thread_id: z.number(),
      also_ties_to: z.array(z.number()),
      label: z.string(),
      setup: z.array(z.object({ type: z.enum(["world", "npc", "outcome"]), actor: z.string(), action: z.string() })),
      hand_off: z.object({ to: z.string(), kind: z.enum(["question", "roll"]), text: z.string() }),
      on_fail: z.string(),
      why: z.string(),
    }),
  ),
});
export type RawOption = z.infer<typeof OptionsSchema>["options"][number];

export interface ImprovOption {
  thread_id: number;
  also_ties_to: number[];
  label: string;
  option: string; // readable text assembled from setup, hand_off and on_fail
  why: string;
}

const SYSTEM = `You are Loom, a game master's assistant used live at the table. The players just did something unexpected. Offer 3 short, playable options that tie the moment back to threads already in the campaign, instead of inventing new material.

Rules:
- Every option builds on one of the listed threads: put its number in thread_id. Prefer options that pay off, complicate or collide existing threads. Only add a number to also_ties_to if the option genuinely uses that thread too; one strong tie beats three loose ones.
- Get the facts right: who did what to whom must match the thread text exactly.
- Match the energy of the moment: comedic stays comedic, tense stays tense.
- The GM controls the world, NPCs and consequences; the players control their characters (marked PC). Never decide what a PC does, says, thinks or feels.
- Threads marked as GM secrets are unknown to players: let them show through consequences, never state them outright.
- Use only the facts listed. Small table-level details (a sound, a line of dialogue) are fine; new plots, factions or major NPCs are not.
- Respect continuity from THE SCENE and the cards: dead characters never act; an NPC who isn't here (or is captured or missing) can only appear by arriving ("Zara bursts in") or act from afar (a message, a runner, a voice through magic), and the beat must say so. Never include anything on the safety lines.
- Use what's already established: characters' abilities, health, gear and relationships, and the GM's mechanics.
- Make the options genuinely different from each other.

Each option has these parts:
- setup: 1-2 short beats of what happens right now, under 35 words in total. Each beat has a type:
  - "outcome": the immediate result of what the players already declared ("Darius hits the cobblestones hard"). A PC may be the subject here, but only for that physical result: no new decisions, words, thoughts or feelings.
  - "world": the environment, magic or events (actor "world"). Things may happen to or around a PC ("a figurine grows warm in Khayiulad's pack").
  - "npc": an NPC acts or speaks (actor is the NPC's name). Never a PC.
  action is one full sentence.
- hand_off: how the players get involved. to is a PC's name or "table". kind "question" asks the player what their character does; kind "roll" names the roll to make. text is one short sentence addressed to the GM, e.g. "Ask Salaena's player whether she reaches for him." or "Khayiulad makes a madness roll."
- on_fail: for rolls only, what happens if the roll fails, in one short sentence that adds something new. This is the only place a PC may act against their player's will, and only because the roll failed or an established condition demands it. Otherwise "".
- label: 2-5 words.
- why: one line, under 15 words, saying why this fits now. The thread's title is shown to the GM separately, so don't repeat it, and never use thread numbers.`;

interface Pc {
  name: string;
  aliases: string[];
  description: string;
}

// Verbs that mean a character chose, spoke, perceived or felt something: the player's job, not the GM's.
const AGENCY_VERBS =
  /^(?:\w+ly\s+)?(?:says?|said|shouts?|yells?|asks?|tells?|replies|answers?|whispers?|insists?|argues?|agrees?|refuses?|decides?|chooses?|tries|attempts?|reaches?|grabs?|lunges?|steps?|moves?|draws?|casts?|attacks?|swings?|runs?|turns?|looks?|notices?|sees?|realizes?|feels?|thinks?|believes?|wants?|hesitates?|smiles?|laughs?|nods?)\b/i;

// Finds text that opens with a PC as the subject ("Salaena lunges…") and returns the rest of
// the sentence. Possessives ("Khayiulad's figurine grows warm") and other characters don't match.
export function pcSubjectMatcher(pcs: Pc[]) {
  const names = pcs.flatMap((p) => [p.name, ...p.aliases, p.name.split(" ")[0]]).filter((n) => n.length >= 3);
  if (names.length === 0) return () => null;
  const escaped = [...new Set(names)].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^\\s*(?:the\\s+)?(?:${escaped.join("|")})(?!['’]s)\\b(.*)$`, "i");
  return (text: string) => text.match(re)?.[1].trim() ?? null;
}

// A PC's body moving on its own ("Khayiulad's fingers tighten…") is a forced action, allowed
// only after a failed roll (on_fail), never in the setup.
const FORCED_BODY =
  /^['’]s\s+(?:hands?|fingers?|grip|arms?|legs?|feet|body|mouth|jaw|voice|eyes)\s+(?:\w+ly\s+)?(?:tighten|clench|close|refuse|reach|move|grab|seize|lock|twitch|jerk|drag|pull|speak|cry|scream|open)/i;

// Ways an absent NPC can legitimately enter a scene: arriving, or acting from afar.
const ARRIVAL =
  /\b(?:arriv|burst|appear|enter|walk\w* in|step\w* (?:in|out of|through)|strides? in|rush\w* in|run\w* up|catch\w* up|emerge|track\w* (?:them|the party) down|find\w* (?:them|the party)|sends?\b|sent\b|deliver|runner|courier|messenger|voice (?:echo|carr)|vision of|reflection of|illusion of|projection of|(?:stagger|limp|stumbl|crawl|slip|sneak|creep)\w* in|from afar|from across|escap|freed|break\w* free|broke free|broken free)/i;

// The entity a sentence opens with as its subject ("Professor Aldric Vex mutters…"), if any.
// A possessive opening ("Vex's notes…") is an object, not someone acting.
function leadingEntity(action: string, scene: Scene) {
  const words = action.trim().replace(/^the\s+/i, "").split(/\s+/);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const phrase = words.slice(0, n).join(" ").replace(/[,.;:!?]+$/, "");
    if (/['’]s$/.test(phrase)) continue;
    const e = scene.resolve(phrase);
    if (e) return e;
  }
  return undefined;
}

// Moments where the players themselves reach someone at a distance; that NPC may then act from afar.
const REMOTE_CONTACT =
  /\b(?:sending|message|messenger|letter|scry|scrying|telepath\w*|dream\w*|commune|animal messenger|whisper\w* to|call\w* out to|contact\w*|reach(?:es|ing)? out|speak\w* with|crystal ball|mirror)\b/i;

export function validate(
  o: RawOption,
  titleOf: Map<number, string>,
  pcSubject: (s: string) => string | null,
  scene: Scene,
  remoteOk: Set<number> = new Set(), // NPCs the moment itself put in remote contact
): string | null {
  if (!titleOf.has(o.thread_id)) return "cites a thread that wasn't provided";
  for (const beat of o.setup) {
    const pcRest = pcSubject(beat.action) ?? (pcSubject(beat.actor) !== null ? "" : null);
    if (pcRest !== null) {
      // A PC may only be the subject of an outcome of what the players already declared,
      // and even then not choosing, speaking or feeling.
      if (beat.type !== "outcome") return `a player character acts in a ${beat.type} beat: "${beat.action}"`;
      if (AGENCY_VERBS.test(pcRest)) return `an outcome decides what a player character does: "${beat.action}"`;
    }
    if (beat.type !== "outcome") {
      for (const pc of scene.pcs) {
        const at = beat.action.toLowerCase().indexOf(`${pc.name.split(" ")[0].toLowerCase()}`);
        if (at >= 0 && FORCED_BODY.test(beat.action.slice(at + pc.name.split(" ")[0].length))) {
          return `forces ${pc.name}'s body to act before any roll: "${beat.action}"`;
        }
      }
    }
    // The NPC acting: the named actor of an npc beat, or the subject a world beat opens with.
    const npc = beat.type === "npc" ? scene.resolve(beat.actor) : beat.type === "world" ? leadingEntity(beat.action, scene) : undefined;
    if (npc && npc.type === "npc") {
      if (npc.status === "dead") return `${npc.name} is dead but acts: "${beat.action}"`;
      const absent = scene.presence(npc) === "elsewhere" || npc.status === "captured" || npc.status === "missing";
      if (absent && !remoteOk.has(npc.id) && !ARRIVAL.test(beat.action)) {
        return npc.status === "captured" || npc.status === "missing"
          ? `${npc.name} is ${npc.status} but acts freely: "${beat.action}"`
          : `${npc.name} isn't here (${scene.whereabouts(npc)}) but acts without arriving: "${beat.action}"`;
      }
    }
  }
  const target = scene.pcs.find((p) => p.name.toLowerCase() === o.hand_off.to.trim().toLowerCase() || p.name.split(" ")[0].toLowerCase() === o.hand_off.to.trim().toLowerCase());
  if (target && o.hand_off.kind === "question" && (target.traits as EntityTraits).health === "unconscious") {
    return `asks what ${target.name} does, but ${target.name} is unconscious`;
  }
  return null;
}

function compose(o: RawOption): ImprovOption {
  const sentence = (s: string) => {
    const t = s.trim();
    return t && !/[.!?"'”’]$/.test(t) ? `${t}.` : t;
  };
  const parts = [...o.setup.map((b) => sentence(b.action)), sentence(o.hand_off.text)];
  if (o.hand_off.kind === "roll" && o.on_fail.trim()) parts.push(`On a failure: ${sentence(o.on_fail)}`);
  return { thread_id: o.thread_id, also_ties_to: o.also_ties_to, label: o.label, option: parts.filter(Boolean).join(" "), why: o.why };
}

function threadBlock(t: ThreadContext, titleOf: Map<number, string>, typeOf: Map<string, string>) {
  const lines = [`T${t.id} [${t.kind}${t.status === "progressing" ? ", in progress" : ""}] ${t.title}`, `  ${t.summary}`];
  if (t.latestNote) lines.push(`  Latest: ${t.latestNote}`);
  if (t.entities.length) {
    const label = (n: string) => (typeOf.get(n) === "pc" ? `${n} (PC)` : typeOf.get(n) === "npc" ? `${n} (NPC)` : n);
    lines.push(`  Involves: ${t.entities.map(label).join(", ")}`);
  }
  const links = t.links.filter((l) => titleOf.has(l.threadId));
  if (links.length) lines.push(`  Linked: ${links.map((l) => `T${l.threadId} (${l.note})`).join("; ")}`);
  return lines.join("\n");
}

// mode "ranked" sends the top retrieved threads; "all" sends every open thread (baseline for comparison).
export async function improv(campaignId: number, moment: string, mode: "ranked" | "all" = "ranked", model?: string) {
  const allThreads = await loadThreadContexts(campaignId);
  const threads =
    mode === "all" ? allThreads.map((t) => ({ ...t, score: 0, reasons: [] as string[] })) : await retrieveThreads(campaignId, moment);
  if (threads.length === 0) throw new Error("This campaign has no open threads yet.");

  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const typeOf = new Map(entities.map((e) => [e.name, e.type]));
  const pcs: Pc[] = entities.filter((e) => e.type === "pc");
  const pcSubject = pcSubjectMatcher(pcs);

  // The scene (party location, who's here, roster, cards for what's in play) comes from
  // structured data; each PC also lists the story conditions on their threads.
  const storyConditions = new Map(
    pcs.map((p) => [p.name, allThreads.filter((t) => t.kind === "condition" && t.entities.includes(p.name)).map((t) => t.title)]),
  );
  const mentioned = new Set(findMentions(entities, moment).keys());
  const remoteOk = new Set(REMOTE_CONTACT.test(moment) ? entities.filter((e) => e.type === "npc" && mentioned.has(e.name)).map((e) => e.id) : []);
  const scene = await buildScene(campaignId, {
    mentioned,
    threadEntities: threads.flatMap((t) => t.entities),
    storyConditions,
  });

  const titleOf = new Map(threads.map((t) => [t.id, t.title]));
  const prompt = `${scene.text}

OPEN THREADS
${threads.map((t) => threadBlock(t, titleOf, typeOf)).join("\n\n")}

WHAT JUST HAPPENED AT THE TABLE
${moment}`;

  // Ask once; if fewer than two options survive validation, ask once more.
  const calls: LlmResult<z.infer<typeof OptionsSchema>>[] = [];
  const accepted: RawOption[] = [];
  const rejected: { label: string; reason: string }[] = [];
  for (let attempt = 0; attempt < 2 && accepted.length < 2; attempt++) {
    const res = await callLlm({ feature: "improv", system: SYSTEM, prompt, schema: OptionsSchema, maxTokens: 4000, effort: "low", model, fast: true });
    calls.push(res);
    for (const o of res.data.options) {
      const reason = validate(o, titleOf, pcSubject, scene, remoteOk);
      if (reason) rejected.push({ label: o.label, reason });
      else accepted.push(o);
    }
  }

  const options = accepted.slice(0, 3).map((o) => compose({ ...o, also_ties_to: o.also_ties_to.filter((id) => titleOf.has(id) && id !== o.thread_id) }));
  const llm = {
    model: calls.at(-1)!.model,
    latencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    costUsd: calls.reduce((s, c) => s + c.costUsd, 0),
    attempts: calls.length,
  };
  return { options, dropped: rejected.length, rejected, threads, titleOf, llm };
}
