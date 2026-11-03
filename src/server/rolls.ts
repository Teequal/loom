import { eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import type { EntityTraits } from "@/core/entity-fields";
import { untag } from "@/core/deltas";
import { scaffoldFor } from "@/core/live";

type Entry = typeof schema.liveEntries.$inferSelect;

// A roll waiting at the table, worked out from the option that set it up: who rolls, what, whether
// it's the GM's secret, and what a failure costs. The page turns this into the roll panel.
export interface RollPlan {
  what: string; // "Wisdom (Insight) check", "Figurine madness roll"
  secret: boolean; // the GM rolls it, out of the players' sight
  rollers: { name: string; bonus: number | null; bonusFrom: string | null }[];
  rule: { name: string; check: string; onFail: string; onSuccess: string } | null;
  onFail: string;
}

const MAKES = /(?:^|[.!?:]\s+)(Everyone|[A-Z][\w' -]*?) makes? (?:an? )?([^.]*?(?:check|saving throw|save|roll|contest|attack roll))\b/;
// Perception and Insight are often rolled without telling the players there's anything to notice.
const QUIET = /\b(?:Perception|Insight)\b/;

export async function rollPlans(campaignId: number, entries: Entry[]): Promise<Map<number, RollPlan>> {
  const waiting = entries.filter((e) => e.awaiting === "roll" && e.resultState === "pending");
  const out = new Map<number, RollPlan>();
  if (!waiting.length) return out;
  const [entities, rules] = await Promise.all([
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId)),
  ]);
  const pcs = entities.filter((e) => e.type === "pc" && e.status !== "dead");
  const passive = (name: string, skill: string | null) => {
    const t = pcs.find((p) => p.name === name)?.traits as EntityTraits | undefined;
    const v = skill === "Perception" ? t?.passive_perception : skill === "Insight" ? t?.passive_insight : undefined;
    return /^\d+$/.test(v ?? "") ? Number(v) - 10 : null;
  };
  for (const e of waiting) {
    const s = await scaffoldFor(e);
    const text = untag(s?.hand_off.text ?? e.choice);
    const m = MAKES.exec(text) ?? MAKES.exec(untag(e.choice));
    const mechanic = (s?.hand?.mechanic && s.hand.mechanic !== "none" ? s.hand.mechanic : null) ?? (s?.hand_off.mechanic && s.hand_off.mechanic !== "none" ? s.hand_off.mechanic : null) ?? s?.owedRule ?? null;
    const rule = mechanic ? rules.find((r) => r.name === mechanic) : rules.find((r) => text.includes(`${r.name} roll`));
    const to = s?.hand?.to ?? s?.hand_off.to ?? m?.[1] ?? "table";
    const names = to === "table" || to === "Everyone" ? pcs.map((p) => p.name) : [to];
    const skill = /\(([A-Z][a-z]+(?: [A-Za-z]+)*)\)/.exec(m?.[2] ?? "")?.[1] ?? null;
    out.set(e.id, {
      what: rule ? `${rule.name} roll` : (m?.[2] ?? "roll").replace(/^./, (c) => c.toUpperCase()),
      secret: !!rule?.secret || (s?.hand?.kind === "notice" && QUIET.test(m?.[2] ?? "")),
      rollers: names.map((name) => {
        const bonus = passive(name, skill);
        return { name, bonus, bonusFrom: bonus == null ? null : `passive ${skill}` };
      }),
      rule: rule ? { name: rule.name, check: rule.check, onFail: rule.onFail, onSuccess: rule.onSuccess } : null,
      onFail: untag(s?.on_fail.effect ?? ""),
    });
  }
  return out;
}
