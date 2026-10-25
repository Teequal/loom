import { z } from "zod";
import { buildLists, renderBeat, renderOnFail, type ScaffoldOption } from "./improv";
import { callLlm } from "./llm";
import { findMentions } from "./retrieval";
import { checkBeat, checkOnFail } from "./scaffold";
import { BUDGETS, distancesFrom } from "./graph";
import { buildScene } from "./scene";

// The flavour pass: turns one chosen scaffold into vivid read-aloud text, using the facts behind
// its tags (voices, appearance, the place, the exact mechanic). It may change the words, never
// the structure: each beat keeps its actor, every beat is checked again, and any beat that fails
// falls back to its plain scaffold line.

const FlavourSchema = z.object({
  beats: z.array(z.string()),
  hand_off: z.string(),
  on_fail: z.string(),
});

const SYSTEM = `You are Loom, polishing one improv option for a game master to read aloud at the table.

Rewrite each beat as vivid, concrete prose: 1-2 sentences per beat. Use the facts given: NPC voices and mannerisms for any dialogue, appearance, the atmosphere of the place, and the GM's mechanic wording. Keep it tight and playable; no purple prose.

Strict rules:
- Same beats, same order. Each beat keeps the same actor doing the same thing; you only improve the words.
- Write every named character, place, item and mechanic in curly braces, exactly as named, with how it should read after a bar: {Zara the Unbound|Zara}, {Figurines of a knight and a monk|the monk figurine}.
- Add no new named characters. Unnamed extras from the scaffold stay unnamed.
- Player characters never act, decide, speak, think or feel in the beats. Things may happen to or around them.
- hand_off: one sentence for the GM, same person and same roll or question.
- on_fail: one sentence, same consequence (only the character who rolled may be forced to act). "" if the scaffold has none.
- Respect GM secrets: they shape what happens, never stated outright.`;

export interface FlavourInput {
  campaignId: number;
  moment: string;
  scaffold: ScaffoldOption;
}

export async function flavour(input: FlavourInput, model?: string) {
  const { campaignId, moment, scaffold } = input;
  const base = await buildScene(campaignId, { mentioned: new Set(), threadEntities: [] });
  const mentioned = new Set(findMentions(base.entities, moment).keys());
  const lists0 = buildLists(base, moment, mentioned);

  // Cards for everyone and everything the scaffold names, so the prose draws on real facts.
  const tagged = new Set<string>(mentioned);
  const allText = [
    ...scaffold.setup.flatMap((b) => [b.actor, b.does, b.walk_on]),
    scaffold.hand_off.text,
    scaffold.on_fail.effect,
  ].join(" ");
  for (const n of lists0.tagger.tagsIn(lists0.tagger.tag(allText))) tagged.add(n);
  // Full cards for exactly what the option names; nothing else.
  const tagIds = base.entities.filter((e) => tagged.has(e.name)).map((e) => e.id);
  const distances = await distancesFrom(campaignId, tagIds, BUDGETS.flavour.depth);
  const scene = await buildScene(campaignId, { mentioned: tagged, threadEntities: [], distances, budget: BUDGETS.flavour });
  const lists = buildLists(scene, moment, mentioned);
  const t = lists.tagger;

  const plainBeats = scaffold.setup.map((b) => renderBeat(b, t));
  const effect = scene.effects.find((e) => e.effect.name === scaffold.hand_off.mechanic);
  const mechanic = effect ? { name: effect.effect.name, rule: effect.text } : undefined;
  const prompt = `${scene.text}

WHAT JUST HAPPENED AT THE TABLE
${moment}

THE OPTION TO POLISH ("${scaffold.label}")
${scaffold.setup.map((b, i) => `Beat ${i + 1} [${b.kind}; actor: ${b.kind === "walk_on" ? b.walk_on : b.actor}]: ${plainBeats[i]}`).join("\n")}
Hand-off [${scaffold.hand_off.kind} → ${scaffold.hand_off.to}]: ${t.render(t.tag(scaffold.hand_off.text))}${mechanic ? `\nMechanic: ${mechanic.name}: ${mechanic.rule}` : ""}
On a failure [${scaffold.on_fail.target}]: ${scaffold.on_fail.effect ? t.render(t.tag(scaffold.on_fail.effect)) : "(none)"}`;

  const res = await callLlm({ feature: "flavor", system: SYSTEM, prompt, schema: FlavourSchema, maxTokens: 3000, effort: "low", model });

  // Re-check every beat with its original actor and kind; keep the plain line if it fails.
  const known = new Set(t.tagsIn(t.tag(allText)).filter((n) => t.entityOf(n)));
  const fallbacks: string[] = [];
  const beats = scaffold.setup.map((b, i) => {
    const text = res.data.beats[i];
    if (!text) return plainBeats[i];
    const flavoured = { ...b, kind: b.kind === "world" ? ("world" as const) : b.kind, does: text };
    // New characters are what break a scene; naming a place or item already in it is fine.
    const newNames = t.tagsIn(t.tag(text)).filter((n) => t.entityOf(n)?.type === "npc" && !known.has(n) && n !== b.actor);
    // The flavoured sentence carries its own subject, so check it as a full sentence: as a world
    // beat, unless the actor leads it (then as that actor's beat).
    const asWorld = { ...flavoured, kind: "world" as const, actor: "world" };
    const leadsWithActor = b.kind !== "world" && t.render(t.tag(text)).trim().toLowerCase().startsWith((b.kind === "walk_on" ? "" : b.actor).toLowerCase());
    const problem =
      newNames.length > 0
        ? `adds ${newNames.join(", ")}`
        : b.kind === "world" || !leadsWithActor
          ? b.kind === "world"
            ? checkBeat(asWorld, lists.check)
            : checkBeat({ ...b, does: text }, lists.check) ?? checkBeat(asWorld, lists.check)
          : checkBeat({ ...b, does: text }, lists.check);
    if (problem) {
      fallbacks.push(`beat ${i + 1}: ${problem}`);
      return plainBeats[i];
    }
    return t.render(t.tag(text)).trim();
  });

  const onFailProblem = scaffold.on_fail.target !== "none" ? checkOnFail(scaffold.on_fail.target, res.data.on_fail, lists.check) : null;
  if (onFailProblem) fallbacks.push(`on a failure: ${onFailProblem}`);
  const onFail =
    scaffold.on_fail.target === "none"
      ? ""
      : renderOnFail(scaffold.on_fail.target, onFailProblem || !res.data.on_fail.trim() ? scaffold.on_fail.effect : res.data.on_fail, t);

  // A hand-off built from parts keeps Loom's own sentence: rewording it could decide for the player.
  const handOff = res.data.hand_off.trim() && !scaffold.hand ? t.render(t.tag(res.data.hand_off)) : t.render(t.tag(scaffold.hand_off.text));
  return { beats, handOff, onFail, mechanic: mechanic?.name ?? null, fallbacks, llm: res };
}
