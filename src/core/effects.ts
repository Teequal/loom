import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import { APPLIES_TO, capabilitiesOf, type AppliesTo, TRIGGERS, type Trigger } from "./rules";

// Structured house rules and effects (docs/loom-model.md §3c). Each effect hangs off a source
// and says who it applies to; this module works out who that is *right now*, from the data:
// who holds the item (or any item in the set), whether the party is at the place, and so on.

type Effect = typeof schema.effects.$inferSelect;
type Entity = typeof schema.entities.$inferSelect;

export interface EffectInput {
  name: string;
  sourceEntityId?: number | null;
  sourceThreadId?: number | null;
  trigger: Trigger;
  appliesTo: AppliesTo;
  appliesToList?: string[];
  check?: string;
  onFail?: string;
  onSuccess?: string;
  escalation?: string;
  duration?: string;
  rule?: string;
  secret?: boolean;
}

export async function addEffect(campaignId: number, input: EffectInput, source: "dm" | "extracted") {
  if (!(TRIGGERS as readonly string[]).includes(input.trigger)) throw new Error(`Trigger must be one of: ${TRIGGERS.join(", ")}`);
  if (!(APPLIES_TO as readonly string[]).includes(input.appliesTo)) throw new Error(`"Applies to" must be one of: ${APPLIES_TO.join(", ")}`);
  if ((input.appliesTo === "holder" || input.appliesTo === "user" || input.appliesTo === "everyone-except-holder") && !input.sourceEntityId) {
    throw new Error(`"${input.appliesTo}" needs a source item to hold (source=…)`);
  }
  if (input.appliesTo === "listed" && !input.appliesToList?.length) throw new Error(`"listed" needs names (listed="A; B")`);
  const [existing] = await db.select().from(schema.effects).where(and(eq(schema.effects.campaignId, campaignId), eq(schema.effects.name, input.name)));
  const values = {
    campaignId,
    name: input.name,
    sourceEntityId: input.sourceEntityId ?? null,
    sourceThreadId: input.sourceThreadId ?? null,
    trigger: input.trigger,
    appliesTo: input.appliesTo,
    appliesToList: input.appliesToList ?? [],
    check: input.check ?? "",
    onFail: input.onFail ?? "",
    onSuccess: input.onSuccess ?? "",
    escalation: input.escalation ?? "",
    duration: input.duration ?? "",
    rule: input.rule ?? "",
    secret: input.secret ?? false,
    source,
  };
  if (existing) {
    await db.update(schema.effects).set(values).where(eq(schema.effects.id, existing.id));
    return { ...existing, ...values };
  }
  const [row] = await db.insert(schema.effects).values(values).returning();
  return row;
}

export async function removeEffect(campaignId: number, name: string) {
  const rows = await db
    .delete(schema.effects)
    .where(and(eq(schema.effects.campaignId, campaignId), eq(schema.effects.name, name)))
    .returning();
  return rows.length > 0;
}

export interface EffectInPlay {
  effect: Effect;
  sourceName: string | null;
  holders: string[]; // who holds the source (or an item in it), with what
  targets: string[]; // PCs it can apply to right now
  tableWide: boolean; // may be called for the whole table at once
  text: string; // one line for prompts
}

// Who each effect reaches right now. PCs are assumed to be together at the party's location.
export function effectsInPlay(opts: {
  effects: Effect[];
  entities: Entity[];
  holds: { holderId: number; itemId: number }[];
  threads: { id: number; title: string }[];
  partyLocationId: number | null;
}): EffectInPlay[] {
  const byId = new Map(opts.entities.map((e) => [e.id, e]));
  const pcs = opts.entities.filter((e) => e.type === "pc" && capabilitiesOf(e).aware !== false && e.status !== "dead");
  const descendantsOf = (id: number) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of opts.entities) {
        if (e.parentId != null && out.has(e.parentId) && !out.has(e.id)) {
          out.add(e.id);
          grew = true;
        }
      }
    }
    return out;
  };
  const within = (place: number, container: number) => {
    let cur: number | null = place;
    for (let hops = 0; cur != null && hops < 20; hops++) {
      if (cur === container) return true;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };

  return opts.effects.map((effect) => {
    const source = effect.sourceEntityId != null ? byId.get(effect.sourceEntityId) : undefined;
    const thread = effect.sourceThreadId != null ? opts.threads.find((t) => t.id === effect.sourceThreadId) : undefined;
    const sourceName = source?.name ?? thread?.title ?? null;

    // Holders of the source or any item inside it (an effect on a set reaches every piece).
    const items = source ? descendantsOf(source.id) : new Set<number>();
    const holding = opts.holds.filter((h) => items.has(h.itemId)).map((h) => ({ holder: byId.get(h.holderId), item: byId.get(h.itemId) }));
    const holderNames = [...new Set(holding.map((h) => h.holder?.name).filter((n): n is string => Boolean(n)))];
    const holders = holding.filter((h) => h.holder && h.item).map((h) => (h.item!.id === source?.id ? h.holder!.name : `${h.holder!.name} (${h.item!.name})`));

    // A place-bound effect only reaches the party while they're there.
    const placeBound = source?.type === "location";
    const partyThere = placeBound && opts.partyLocationId != null && source ? within(opts.partyLocationId, source.id) : !placeBound;

    let targets: string[] = [];
    let tableWide = false;
    if (partyThere) {
      switch (effect.appliesTo) {
        case "holder":
        case "user":
          targets = pcs.filter((p) => holderNames.includes(p.name)).map((p) => p.name);
          break;
        case "everyone-except-holder":
          targets = pcs.filter((p) => !holderNames.includes(p.name)).map((p) => p.name);
          tableWide = true;
          break;
        case "everyone-present":
        case "party":
        case "source-target":
          targets = pcs.map((p) => p.name);
          tableWide = true;
          break;
        case "listed": {
          const listed = effect.appliesToList.map((n) => n.toLowerCase());
          targets = pcs.filter((p) => listed.includes(p.name.toLowerCase()) || p.aliases.some((a) => listed.includes(a.toLowerCase()))).map((p) => p.name);
          break;
        }
      }
    }

    const parts = [
      `${effect.name}${effect.secret ? " [GM secret]" : ""}`,
      sourceName && `from ${sourceName}`,
      effect.trigger.replace(/-/g, " "),
      `applies to: ${effect.appliesTo.replace(/-/g, " ")}${targets.length ? ` → now ${targets.join(", ")}` : " → nobody right now"}`,
      holders.length && `held by ${holders.join(", ")}`,
      effect.check && `check: ${effect.check}`,
      effect.onFail && `on fail: ${effect.onFail}`,
      effect.escalation && `escalates: ${effect.escalation}`,
      effect.rule && `rule: ${effect.rule}`,
    ].filter(Boolean);
    return { effect, sourceName, holders, targets, tableWide, text: parts.join("; ") };
  });
}

// Loads what effectsInPlay needs for a campaign.
export async function loadEffectsInPlay(campaignId: number, entities: Entity[], partyLocationId: number | null) {
  const [effects, holds, threads] = await Promise.all([
    db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId)),
    db
      .select({ holderId: schema.entityRelations.fromEntityId, itemId: schema.entityRelations.toEntityId })
      .from(schema.entityRelations)
      .where(and(eq(schema.entityRelations.campaignId, campaignId), eq(schema.entityRelations.type, "holds"))),
    db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
  ]);
  return effectsInPlay({ effects, entities, holds, threads, partyLocationId });
}
