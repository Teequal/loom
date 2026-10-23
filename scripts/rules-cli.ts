// House rules and effects: list, add, remove, and draft from plain words.
import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/core/db/client";
import { addEffect, loadEffectsInPlay, removeEffect, type EffectInput } from "@/core/effects";
import { findEntity } from "@/core/entity-card";
import { callLlm } from "@/core/llm";
import { APPLIES_TO, TRIGGERS, type AppliesTo, type Trigger } from "@/core/rules";
import { pairs, positional, splitList } from "./entity-cli";

const RULE_USAGE = `rule list
rule add "<name>" source=<item, place, kind or #thread> trigger=<${TRIGGERS.join("|")}>
         applies=<${APPLIES_TO.join("|")}> check="…" fail="…" [success="…"] [escalation="…"]
         [duration="…"] [rule="in plain words"] [listed="A; B"] [--secret]
rule draft "<the rule in your own words>" [source=…]     Loom drafts it, you confirm
rule remove "<name>"`;

async function resolveSource(campaignId: number, raw: string | undefined) {
  if (!raw || raw === "campaign") return { sourceEntityId: null, sourceThreadId: null };
  const t = raw.match(/^(?:#|T)(\d+)$/i);
  if (t) {
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, Number(t[1])));
    if (!thread || thread.campaignId !== campaignId) throw new Error(`No thread ${raw} in this campaign`);
    return { sourceEntityId: null, sourceThreadId: thread.id };
  }
  return { sourceEntityId: (await findEntity(campaignId, raw)).id, sourceThreadId: null };
}

async function printRules(campaignId: number) {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const rows = await loadEffectsInPlay(campaignId, entities, c?.partyLocationId ?? null);
  if (!rows.length) return console.log('No house rules yet. Try: npm run loom -- rule draft "<the rule in your words>"');
  for (const r of rows) {
    const e = r.effect;
    console.log(`\n${e.name}${e.secret ? " 🔒" : ""}${e.source === "dm" ? " ✎" : " ⚙"}`);
    if (r.sourceName) console.log(`  from: ${r.sourceName}`);
    console.log(`  when: ${e.trigger.replace(/-/g, " ")} · applies to: ${e.appliesTo.replace(/-/g, " ")}${e.appliesToList.length ? ` (${e.appliesToList.join(", ")})` : ""}`);
    console.log(`  right now: ${r.targets.length ? r.targets.join(", ") : "nobody"}${r.holders.length ? ` · held by ${r.holders.join(", ")}` : ""}`);
    if (e.check) console.log(`  check: ${e.check}`);
    if (e.onFail) console.log(`  on fail: ${e.onFail}`);
    if (e.onSuccess) console.log(`  on success: ${e.onSuccess}`);
    if (e.escalation) console.log(`  escalates: ${e.escalation}`);
    if (e.duration) console.log(`  lasts: ${e.duration}`);
    if (e.rule) console.log(`  in words: ${e.rule}`);
  }
}

const DraftSchema = z.object({
  name: z.string(),
  source: z.string(),
  trigger: z.enum(TRIGGERS),
  applies_to: z.enum(APPLIES_TO),
  listed: z.array(z.string()),
  check: z.string(),
  on_fail: z.string(),
  on_success: z.string(),
  escalation: z.string(),
  duration: z.string(),
  secret: z.boolean(),
  question: z.string(), // if something essential is unclear, one short question for the DM
});

const DRAFT_SYSTEM = `You turn a game master's house rule, described in plain words, into a structured rule for a tabletop RPG assistant.

Fields:
- name: 2-4 words.
- source: the exact name of the item, place, creature kind or thread that carries the rule, from the list given; "" if it's campaign-wide. If the rule is about a set of items, use the set.
- trigger: when it fires: ${TRIGGERS.join(", ")}.
- applies_to: who it affects: holder (whoever has the item), user (whoever uses it; they must hold it), everyone-except-holder, everyone-present, party, listed (named characters), source-target (whoever the source targets).
- listed: names, only for "listed".
- check: the roll, e.g. "madness roll", "Wisdom save DC 13". "" if none.
- on_fail / on_success: what happens. Keep the GM's meaning; don't invent numbers they didn't give.
- escalation: how it grows over time, if it does. duration: how long effects last, if stated.
- secret: true if players shouldn't know about it.
- question: if something essential is unclear (who it affects, what triggers it), one short question; otherwise "".`;

export async function ruleCommand(campaignId: number, args: string[]) {
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const kv = Object.fromEntries(pairs(rest));

  switch (sub) {
    case "list":
      return printRules(campaignId);
    case "add": {
      if (!pos[0] || !kv.trigger || !kv.applies) return console.log(RULE_USAGE);
      const input: EffectInput = {
        name: pos[0],
        ...(await resolveSource(campaignId, kv.source)),
        trigger: kv.trigger as Trigger,
        appliesTo: kv.applies as AppliesTo,
        appliesToList: kv.listed ? splitList(kv.listed) : [],
        check: kv.check,
        onFail: kv.fail,
        onSuccess: kv.success,
        escalation: kv.escalation,
        duration: kv.duration,
        rule: kv.rule,
        secret: rest.includes("--secret"),
      };
      const row = await addEffect(campaignId, input, "dm");
      console.log(`Saved rule "${row.name}".`);
      return printRules(campaignId);
    }
    case "remove":
      if (!pos[0]) return console.log(RULE_USAGE);
      return console.log((await removeEffect(campaignId, pos[0])) ? `Removed "${pos[0]}".` : `No rule called "${pos[0]}".`);
    case "draft": {
      if (!pos[0]) return console.log(RULE_USAGE);
      const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
      const threads = await db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId));
      const prompt = `ITEMS, PLACES AND KINDS
${entities.filter((e) => e.type !== "pc" && e.type !== "npc").map((e) => `- ${e.name} (${e.type})`).join("\n")}

PLAYER CHARACTERS
${entities.filter((e) => e.type === "pc").map((e) => `- ${e.name}`).join("\n")}

OPEN THREADS
${threads.filter((t) => t.status !== "resolved").map((t) => `- #${t.id} ${t.title}`).join("\n")}
${kv.source ? `\nThe GM says the source is: ${kv.source}\n` : ""}
THE RULE, IN THE GM'S WORDS
${pos[0]}`;
      const res = await callLlm({ feature: "rule", system: DRAFT_SYSTEM, prompt, schema: DraftSchema, maxTokens: 2000, effort: "low" });
      const d = res.data;
      const sourceRaw = kv.source ?? (d.source.match(/^#\d+/) ? d.source.match(/^#\d+/)![0] : d.source);
      console.log(`\nDraft (${res.model}, ${(res.latencyMs / 1000).toFixed(1)} s):`);
      console.log(`  name: ${d.name}\n  from: ${sourceRaw || "the whole campaign"}\n  when: ${d.trigger} · applies to: ${d.applies_to}${d.listed.length ? ` (${d.listed.join(", ")})` : ""}`);
      for (const [k, v] of [["check", d.check], ["on fail", d.on_fail], ["on success", d.on_success], ["escalates", d.escalation], ["lasts", d.duration]] as const) if (v) console.log(`  ${k}: ${v}`);
      if (d.secret) console.log("  GM-only: yes");
      if (d.question) console.log(`\n  Loom asks: ${d.question}`);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ok = (await rl.question("\nSave this rule? [y/n] ")).trim().toLowerCase();
      rl.close();
      if (ok !== "y") return console.log(`Not saved. To adjust, use rule add with the fields above, or redraft with more detail.`);
      const row = await addEffect(
        campaignId,
        {
          name: d.name,
          ...(await resolveSource(campaignId, sourceRaw || undefined)),
          trigger: d.trigger,
          appliesTo: d.applies_to,
          appliesToList: d.listed,
          check: d.check,
          onFail: d.on_fail,
          onSuccess: d.on_success,
          escalation: d.escalation,
          duration: d.duration,
          rule: pos[0],
          secret: d.secret,
        },
        "dm", // the DM confirmed it
      );
      console.log(`Saved rule "${row.name}".`);
      return printRules(campaignId);
    }
    default:
      console.log(RULE_USAGE);
  }
}
