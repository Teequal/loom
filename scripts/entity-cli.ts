// Manual entry commands: entities, relationships, campaign fields and thread fields.
// Everything entered here is recorded as the DM's, so extraction will never overwrite it.
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { findEntity, loadEntityCard } from "@/core/entity-card";
import { historyOf, logChanges } from "@/core/history";
import {
  ENTITY_STATUSES,
  type EntityTraits,
  type FieldMeta,
  ID_LISTS,
  LIST_TRAITS,
  RELATION_TYPES,
  type RelationType,
  TRAIT_KEYS,
} from "@/core/entity-fields";
import { ENTITY_TYPES, PAIR_WEIGHTS } from "@/core/db/schema";
import { TOGGLES, toggleValue, type ToggleName, togglesText } from "@/core/rules";
import {
  type EntityPatch,
  removeRelation,
  setRelation,
  updateCampaign,
  updateEntity,
  updateThread,
  type WriteResult,
  mergeEntities,
  setPairWeights,
  setSubProperty,
} from "@/core/entities";
import { specOf } from "@/core/sub-properties";
import { readMoment } from "@/core/moment-reading";
import { viewOf } from "@/core/world/engine";
import { loadGraph } from "@/core/world/load";
import { propertiesOf, propertyLine } from "@/core/world/properties";
import { INTERPLAYS, interplayLine, interplaysFor } from "@/core/world/interplays";
import { recordInterplayChanges } from "@/core/interplay-history";

const DM = { source: "dm" as const };

// A sub-property's value from the command line: a number, yes/no, a name (for a target), or empty to clear.
async function subValue(campaignId: number, path: string, raw: string) {
  const spec = specOf(path);
  if (!spec) throw new Error(`"${path}" isn't a known property. Try e.g. disposition.boldness, state.anger, goals.g1.intent`);
  if (raw === "") return null;
  if (spec.type === "bool") return /^(?:y|yes|true|1)$/i.test(raw);
  if (spec.type === "entity") return (await findEntity(campaignId, raw)).id;
  if (spec.type === "enum") return raw;
  return Number(raw);
}

// Friendly names on the command line → column names in the database.
const LOCATION_KEYS: Record<string, "lastKnownLocationId" | "actualLocationId" | "parentId"> = {
  "last-known": "lastKnownLocationId",
  actual: "actualLocationId",
  parent: "parentId",
};
const COLUMN_KEYS = ["description", "aliases", "status", "attitude", "importance"];

export const splitList = (v: string) =>
  v
    .split(v.includes(";") ? ";" : ",")
    .map((s) => s.trim())
    .filter(Boolean);

// "key=value" arguments → [key, value] pairs; everything else is left for the caller.
export function pairs(args: string[]) {
  return args
    .filter((a) => /^[a-z0-9_.-]+=/i.test(a))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i).toLowerCase(), a.slice(i + 1)] as const;
    });
}
export const positional = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // These flags take a value; skip it too. (--secret on relate takes none.)
      const takesValue = ["--campaign", "--type"].includes(args[i]) || (args[i] === "--secret" && args[i + 1] && !args[i + 1].startsWith("--") && !args[i + 1].includes("=") && /^[a-z_,-]+$/i.test(args[i + 1]) && args[i + 1].split(",").every((k) => isFieldKey(k)));
      if (takesValue) i++;
      continue;
    }
    if (!/^[a-z0-9_.-]+=/i.test(args[i])) out.push(args[i]);
  }
  return out;
};
export const flagValue = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function isFieldKey(key: string) {
  const k = key.trim().toLowerCase();
  return Boolean(LOCATION_KEYS[k]) || COLUMN_KEYS.includes(k) || (TRAIT_KEYS as string[]).includes(k);
}

function fieldName(key: string) {
  if (LOCATION_KEYS[key]) return LOCATION_KEYS[key];
  if (COLUMN_KEYS.includes(key)) return key;
  if ((TRAIT_KEYS as string[]).includes(key)) return `traits.${key}`;
  throw new Error(
    `Unknown field "${key}". Fields: ${[...COLUMN_KEYS, ...Object.keys(LOCATION_KEYS), ...TRAIT_KEYS].join(", ")}`,
  );
}

async function buildPatch(campaignId: number, kv: (readonly [string, string])[]) {
  const patch: EntityPatch = {};
  const traits: Record<string, unknown> = {};
  for (const [key, raw] of kv) {
    const field = fieldName(key);
    const value = raw.trim();
    if (field.startsWith("traits.")) {
      const t = field.slice(7);
      traits[t] = value === "" ? (LIST_TRAITS.has(t) ? [] : "") : LIST_TRAITS.has(t) ? splitList(value) : value;
    } else if (field.endsWith("LocationId") || field === "parentId") {
      const loc = value === "" ? null : (await findEntity(campaignId, value)).id;
      (patch as Record<string, unknown>)[field] = loc;
    } else if (field === "aliases") {
      patch.aliases = splitList(value);
    } else if (field === "description") {
      patch.description = value;
    } else {
      (patch as Record<string, unknown>)[field] = value === "" ? null : value;
    }
  }
  if (Object.keys(traits).length) patch.traits = traits as EntityTraits;
  return patch;
}

function report(r: WriteResult) {
  if (r.written.length) console.log(`Saved: ${r.written.join(", ")}`);
  else if (!r.proposed.length) console.log("Nothing changed.");
}

// ✎ entered by the DM · ⚙ extracted (with session) · 🔒 GM-only
function mark(meta: FieldMeta | undefined, sessionNumber: (id: number | null | undefined) => string) {
  if (!meta) return "";
  const src = meta.source === "dm" ? " ✎" : ` ⚙${sessionNumber(meta.sessionId)}`;
  return `${src}${meta.secret ? " 🔒" : ""}`;
}

async function showEntity(campaignId: number, query: string) {
  const e0 = await findEntity(campaignId, query);
  const card = await loadEntityCard(e0.id);
  const e = card.entity;
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId));
  const sn = (id: number | null | undefined) => {
    const s = sessions.find((x) => x.id === id);
    return s ? ` s${s.number}` : "";
  };
  const m = (field: string) => mark(card.meta(field), sn);

  const head = [e.status && `${e.status}${m("status")}`, e.attitude && `${e.attitude}${m("attitude")}`, e.importance && `${e.importance}${m("importance")}`]
    .filter(Boolean)
    .join(" · ");
  console.log(`\n${e.name} (${e.type.toUpperCase()})${head ? ` · ${head}` : ""}`);
  if (e.description) console.log(`  ${e.description}${m("description")}`);
  if (e.aliases.length) console.log(`  aka ${e.aliases.join(", ")}`);

  const where = [
    card.lastKnownLocation && `  last known: ${card.lastKnownLocation}${m("lastKnownLocationId")}`,
    card.actualLocation && `  actual: ${card.actualLocation}${m("actualLocationId")}`,
    card.parentLocation && `  ${e.type === "location" ? "inside" : "part of"}: ${card.parentLocation}${m("parentId")}`,
  ].filter(Boolean);
  if (where.length) console.log(`\nWhere\n${where.join("\n")}`);

  const signed = (n: unknown) => (typeof n === "number" && n > 0 ? `+${n}` : String(n));
  const all = await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const traits = Object.entries(e.traits).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : v === "" || v == null));
  if (traits.length) {
    console.log("\nTraits");
    for (const [k, v] of traits) {
      // Goals, beliefs and aims: one line each, with the id that addresses it and its weights.
      if (k in ID_LISTS && Array.isArray(v)) {
        console.log(`  ${k}:`);
        for (const it of v as Record<string, unknown>[]) {
          const weights = Object.entries(it)
            .filter(([w]) => !["id", "text"].includes(w))
            .map(([w, x]) => `${w} ${w === "target" ? (all.find((o) => o.id === x)?.name ?? x) : w === "intent" ? signed(x) : String(x)}${m(`traits.${k}.${it.id}.${w}`)}`);
          console.log(`    ${it.id ?? "?"}  ${it.text}${weights.length ? `  [${weights.join(", ")}]` : ""}`);
        }
        continue;
      }
      if (k === "condition_sources" && Array.isArray(v)) {
        const name = (x: unknown) => all.find((o) => o.id === x)?.name ?? x;
        console.log(`  condition sources: ${(v as { condition: string; by?: number; target?: number }[]).map((c) => `${c.condition}${c.by != null ? ` by ${name(c.by)}` : ""}${c.target != null ? ` at ${name(c.target)}` : ""}`).join("; ")}${m(`traits.${k}`)}`);
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        console.log(`  ${k}: ${Object.entries(v).map(([x, n]) => `${x} ${k === "disposition" || x === "confidence" ? signed(n) : String(n)}${m(`traits.${k}.${x}`)}`).join(", ")}`);
        continue;
      }
      console.log(`  ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join("; ") : v}${m(`traits.${k}`)}`);
    }
  }
  // How they stand toward others, and others toward them (the pair weights).
  const weighs = await db.select().from(schema.pairWeights).where(eq(schema.pairWeights.campaignId, campaignId));
  const mine = weighs.filter((w) => w.fromEntityId === e.id || w.toEntityId === e.id);
  if (mine.length) {
    console.log("\nHow they stand");
    for (const w of mine) {
      const name = (id: number) => all.find((o) => o.id === id)?.name ?? `#${id}`;
      const parts = PAIR_WEIGHTS.filter((x) => w[x] != null).map((x) => `${x} ${signed(w[x])}${w.fieldMeta[x]?.source === "dm" ? " ✎" : w.fieldMeta[x] ? " ⚙" : ""}`);
      console.log(`  ${name(w.fromEntityId)} → ${name(w.toEntityId)}: ${parts.join(", ")}`);
    }
  }

  if (card.relations.length) {
    console.log("\nRelationships");
    for (const r of card.relations) {
      const s = r.strength ? ` (${r.strength > 0 ? "+" : ""}${r.strength})` : "";
      const [a, b] = r.direction === "out" ? [e.name, r.other] : [r.other, e.name];
      const line = `${a} ${r.type.replace(/_/g, " ")} ${b}`;
      console.log(`  ${line}${s}${r.note ? `: ${r.note}` : ""}${r.source === "dm" ? " ✎" : " ⚙"}${r.secret ? " 🔒" : ""}`);
    }
  }
  if (card.threads.length) {
    console.log("\nOpen threads");
    for (const t of card.threads) console.log(`  #${t.id} ${t.title}${t.status === "progressing" ? " (in progress)" : ""}`);
  }
  console.log("\n✎ entered by you · ⚙ extracted (s = session) · 🔒 GM-only");
}

const ENTITY_USAGE = `entity list [--type npc]
entity show "<name>"
entity history "<name>"            what changed, when, and on whose word
entity new "<name>" <${ENTITY_TYPES.join("|")}> [field=value …]
entity set "<name>" field=value [field=value …] [--secret field,field]
  Location fields take a location's name: last-known=, actual=, parent=
  List fields take a comma- or semicolon-separated list: ${[...LIST_TRAITS].join(", ")}
  An empty value clears a field: voice=
  Sub-properties by path: disposition.boldness=2  state.anger=1  goals.g1.intent=-2  goals.g1.target="<name>"
    (see the ids with: entity show "<name>"; dispositions: compassion honesty boldness temper pride greed curiosity discipline faith fidelity)
entity why "<name>" ["<a moment>"]   the properties worked out for them (intent, resolve, courage…), and why
entity interplay "<name>" <conflicted|devoted|…> on|off|auto [with="<other>"]   your word on an interplay, whatever the numbers say
entity goal "<name>" "<goal text>" [priority=1-3] [intent=-3…3] [commitment=0-3]   adds a goal (a faction's aim)
entity merge "<duplicate>" "<real one>" [--secret]   two records are the same character; the duplicate's names become aliases
  --secret: the players don't know; the identity is kept GM-only and the duplicate's threads aren't linked to the real one`;

export async function entityCommand(campaignId: number, args: string[]) {
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const kv = pairs(rest);
  const secret = flagValue(rest, "secret")?.split(",").map((k) => fieldName(k.trim().toLowerCase()));

  switch (sub) {
    case "list": {
      const type = flagValue(rest, "type");
      const rows = await db
        .select()
        .from(schema.entities)
        .where(
          type
            ? and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.type, type as (typeof ENTITY_TYPES)[number]))
            : eq(schema.entities.campaignId, campaignId),
        )
        .orderBy(asc(schema.entities.type), asc(schema.entities.name));
      const all = await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
      const names = new Map(all.map((r) => [r.id, r.name]));
      for (const r of rows) {
        const where = r.lastKnownLocationId ? ` @ ${names.get(r.lastKnownLocationId) ?? "?"}` : "";
        console.log(`  ${r.type.padEnd(8)} ${r.name}${r.status ? ` · ${r.status}` : ""}${where}`);
      }
      return;
    }
    case "show":
      if (!pos[0]) return console.log(ENTITY_USAGE);
      return showEntity(campaignId, pos[0]);
    case "history": {
      if (!pos[0]) return console.log(ENTITY_USAGE);
      const e = await findEntity(campaignId, pos[0]);
      const lines = await historyOf(campaignId, e);
      if (!lines.length) return console.log(`Nothing recorded about ${e.name} yet.`);
      console.log(`\n${e.name}: history`);
      for (const l of lines) console.log(`  ${l.session != null ? `s${l.session}`.padEnd(4) : "    "} ${l.text}${l.source === "dm" ? " ✎" : " ⚙"}`);
      console.log("\n✎ entered by you · ⚙ extracted · s = the session it happened in (or the latest one when entered)");
      return;
    }
    case "new": {
      const [name, type] = pos;
      if (!name || !(ENTITY_TYPES as readonly string[]).includes(type)) return console.log(ENTITY_USAGE);
      const [e] = await db
        .insert(schema.entities)
        .values({ campaignId, name, type: type as (typeof ENTITY_TYPES)[number], fieldMeta: { name: { source: "dm", at: new Date().toISOString() } } })
        .returning();
      await logChanges([{ campaignId, subject: e.name, entityId: e.id, kind: "created", source: "dm" }]);
      console.log(`Created ${e.name} (${e.type}).`);
      if (kv.length) report(await updateEntity(e.id, await buildPatch(campaignId, kv), { ...DM, secret }));
      return;
    }
    case "set": {
      if (!pos[0] || !kv.length) return console.log(ENTITY_USAGE);
      const e = await findEntity(campaignId, pos[0]);
      // Sub-properties are set one by one, each with its own provenance: "disposition.boldness=2",
      // "goals.g1.intent=-2", "state.anger=1". An empty value clears one.
      const dotted = kv.filter(([k]) => k.includes("."));
      for (const [path, raw] of dotted) {
        const value = await subValue(campaignId, path, raw);
        report(await setSubProperty(e.id, path, value, { ...DM, secret: secret?.includes(path) ? [`traits.${path}`] : undefined }));
      }
      if (dotted.length) await recordInterplayChanges(campaignId);
      if (dotted.length === kv.length) return;
      const patch = await buildPatch(campaignId, kv.filter(([k]) => !k.includes(".")));
      if (patch.status && !(ENTITY_STATUSES[e.type] as readonly string[]).includes(patch.status)) {
        throw new Error(`Status for ${e.name} (${e.type.toUpperCase()}) is one of: ${ENTITY_STATUSES[e.type].join(", ")}`);
      }
      return report(await updateEntity(e.id, patch, { ...DM, secret }));
    }
    case "why": {
      // entity why "<name>" ["<moment>"]: the properties worked out for them, with their reasons;
      // with a moment, the situational ones (courage, candour…) for that scene.
      if (!pos[0]) return console.log(ENTITY_USAGE);
      const e = await findEntity(campaignId, pos[0]);
      const g = await loadGraph(campaignId);
      const ents = [...g.nodes.values()].filter((n) => n.kind === "character" || n.kind === "faction" || n.kind === "item" || n.kind === "place").map((n) => ({ name: n.name, type: n.kind === "character" ? n.side : n.kind === "place" ? "location" : n.kind, aliases: n.aliases }));
      const v = viewOf(g, readMoment(ents as never, pos[1] ?? ""));
      const key = g.entityKey(e.id);
      const props = key ? propertiesOf(v, key) : [];
      console.log(`\n${e.name}${pos[1] ? `, in: "${pos[1]}"` : " (outside any scene)"}`);
      if (!props.length) return console.log("  Nothing to work out yet: no dispositions, states, goals or weights recorded.");
      for (const p of props) {
        console.log(`  ${propertyLine(p)}`);
        for (const t of p.terms) console.log(`      ${t.known ? `${t.value > 0 ? "+" : ""}${t.value}`.padStart(5) : "    ?"}  ${t.label}`);
      }
      const ins = key ? interplaysFor(v, key, true) : [];
      if (ins.length) {
        console.log("\n  Interplays");
        for (const i of ins) console.log(`    ${i.kind === "tension" ? "⇄" : "="} ${interplayLine(v, i)} · strength ${i.strength} · ${i.because.join("; ")}${i.moves.length ? ` · moves: ${i.moves.join(", ")}` : ""}`);
      }
      return;
    }
    case "interplay": {
      // entity interplay "<name>" <id> on|off|auto [with="<other>"]: the DM's word on an interplay.
      const [name, which, state] = pos;
      if (!name || !which || !["on", "off", "auto"].includes(state ?? "")) return console.log(ENTITY_USAGE);
      const def = INTERPLAYS.find((d) => d.id === which.replace(/-/g, " "));
      if (!def) return console.log(`Interplays: ${INTERPLAYS.map((d) => d.id.replace(/ /g, "-")).join(", ")}`);
      const e = await findEntity(campaignId, name);
      const other = Object.fromEntries(kv).with ? (await findEntity(campaignId, Object.fromEntries(kv).with)).id : undefined;
      const rest = (e.traits.interplay_overrides ?? []).filter((o) => !(o.id === def.id && o.other === other));
      const next = state === "auto" ? rest : [...rest, { id: def.id, on: state === "on", ...(other ? { other } : {}) }];
      report(await updateEntity(e.id, { traits: { interplay_overrides: next } }, DM));
      await recordInterplayChanges(campaignId);
      return console.log(state === "auto" ? `${e.name}: ${def.id} is worked out from the records again.` : `${e.name}: ${def.id} is ${state}, whatever the numbers say.`);
    }
    case "goal": {
      // entity goal "<name>" "<text>" [priority=1] [intent=-2] [commitment=3]: adds a goal (or an aim, for a faction).
      if (!pos[0] || !pos[1]) return console.log(ENTITY_USAGE);
      const e = await findEntity(campaignId, pos[0]);
      const key = e.type === "faction" ? "aims" : "goals";
      const opts = Object.fromEntries(kv);
      const before = ((e.traits as Record<string, unknown>)[key] as { text: string }[] | undefined) ?? [];
      const goal = { text: pos[1], priority: Number(opts.priority ?? 1), ...(opts.intent ? { intent: Number(opts.intent) } : {}), ...(opts.commitment ? { commitment: Number(opts.commitment) } : {}) };
      return report(await updateEntity(e.id, { traits: { [key]: [...before, goal] } as EntityTraits }, { ...DM, secret }));
    }
    case "merge": {
      if (!pos[0] || !pos[1]) return console.log(ENTITY_USAGE);
      const from = await findEntity(campaignId, pos[0]);
      const into = await findEntity(campaignId, pos[1]);
      const r = await mergeEntities(campaignId, from.id, into.id, { secret: rest.includes("--secret") });
      console.log(`Merged ${r.from.name} into ${r.into.name}: ${r.moved.threads} thread link(s), ${r.moved.relations} relationship(s), ${r.moved.moments} moment(s) moved; "${r.from.name}" is now an alias.`);
      if (rest.includes("--secret")) console.log(`  🔒 Kept GM-only: ${r.into.name}'s secrets say who they really are, and the mystery threads aren't linked to them.`);
      if (r.keptDescription) console.log(`  ${r.into.name} kept their own description. The duplicate's was: "${r.keptDescription}"`);
      console.log("  Refresh meaning search with: npm run loom -- embed");
      return;
    }
    default:
      console.log(ENTITY_USAGE);
  }
}

const RELATE_USAGE = `relate "<from>" <type> "<to>" [note="…"] [strength=-3…3] [--secret]
relate "<from>" "<to>" warmth=… trust=… fear=… respect=… debt=… loyalty=…   how one stands toward the other (one direction)
unrelate "<from>" <type> "<to>"
  Types: ${RELATION_TYPES.join(", ")}`;

function relationType(raw: string | undefined): RelationType {
  const t = (raw ?? "").toLowerCase().replace(/-/g, "_");
  if (!(RELATION_TYPES as readonly string[]).includes(t)) throw new Error(`Unknown relationship type "${raw}".\n${RELATE_USAGE}`);
  return t as RelationType;
}

export async function relateCommand(campaignId: number, args: string[], remove = false) {
  // Weights between two ("relate A B warmth=1 trust=-1"): how A stands toward B.
  const kvAll = Object.fromEntries(pairs(args));
  const named = positional(args);
  if (named.length === 2 && !remove && PAIR_WEIGHTS.some((w) => w in kvAll)) {
    const from = await findEntity(campaignId, named[0]);
    const to = await findEntity(campaignId, named[1]);
    const weights = Object.fromEntries(PAIR_WEIGHTS.filter((w) => w in kvAll).map((w) => [w, kvAll[w] === "" ? null : Number(kvAll[w])]));
    report(await setPairWeights(campaignId, from.id, to.id, weights, DM));
    await recordInterplayChanges(campaignId);
    return;
  }
  const [fromName, typeRaw, toName] = named;
  if (!fromName || !typeRaw || !toName) return console.log(RELATE_USAGE);
  const type = relationType(typeRaw);
  const from = await findEntity(campaignId, fromName);
  const to = await findEntity(campaignId, toName);

  if (remove) {
    const [rel] = await db
      .select()
      .from(schema.entityRelations)
      .where(and(eq(schema.entityRelations.fromEntityId, from.id), eq(schema.entityRelations.toEntityId, to.id), eq(schema.entityRelations.type, type)));
    if (!rel) return console.log(`No "${from.name} ${type} ${to.name}" relationship found.`);
    await removeRelation(rel.id);
    return console.log(`Removed: ${from.name} ${type.replace(/_/g, " ")} ${to.name}`);
  }

  const kv = Object.fromEntries(pairs(args));
  const strength = kv.strength === undefined ? undefined : Number(kv.strength);
  if (strength !== undefined && Number.isNaN(strength)) throw new Error("strength must be a number from -3 to 3");
  const r = await setRelation(
    campaignId,
    { fromEntityId: from.id, toEntityId: to.id, type, note: kv.note, strength, secret: args.includes("--secret") ? true : undefined },
    DM,
  );
  console.log(r.written.length ? `Saved: ${from.name} ${type.replace(/_/g, " ")} ${to.name}` : "Nothing changed.");
  for (const n of r.notes ?? []) console.log(`  ${n}`);
}

const CAMPAIGN_USAGE = `campaign show
campaign set [party=<location>] [tone=…] [date=…] [safety=topic;topic]
campaign toggle                      list the rule toggles and their options
campaign toggle <name> <option>      e.g. campaign toggle madness dmg-tables
House rules and effects: see "rule" (rule list / rule add / rule draft).`;

export async function campaignCommand(campaignId: number, args: string[]) {
  const [sub, ...rest] = args;
  const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!c) throw new Error(`No campaign with id ${campaignId}`);

  switch (sub) {
    case "show": {
      const party = c.partyLocationId ? (await db.select().from(schema.entities).where(eq(schema.entities.id, c.partyLocationId)))[0]?.name : null;
      console.log(`\n${c.name}`);
      console.log(`  party is at: ${party ?? "(not set)"}`);
      console.log(`  in-game date: ${c.inGameDate || "(not set)"}`);
      console.log(`  tone: ${c.tone || "(not set)"}`);
      console.log(`  safety lines: ${c.safetyLines.length ? c.safetyLines.join("; ") : "(none)"}`);
      const changed = togglesText(c.ruleToggles);
      console.log(`  rules: 5e${changed.length ? `, with ${changed.join(", ")}` : " as written"}`);
      const n = (await db.select().from(schema.effects).where(eq(schema.effects.campaignId, campaignId))).length;
      console.log(`  house rules and effects: ${n} (rule list)`);
      return;
    }
    case "toggle": {
      const [name, value] = positional(rest);
      if (!name) {
        for (const [k, t] of Object.entries(TOGGLES)) {
          console.log(`  ${k.padEnd(16)} ${toggleValue(c.ruleToggles, k as ToggleName).padEnd(20)} options: ${t.options.join(" / ")}`);
        }
        return;
      }
      if (!(name in TOGGLES)) throw new Error(`Unknown toggle "${name}". Toggles: ${Object.keys(TOGGLES).join(", ")}`);
      const t = TOGGLES[name as ToggleName];
      if (!value || !(t.options as readonly string[]).includes(value)) throw new Error(`${t.label}: choose one of ${t.options.join(", ")}`);
      await db.update(schema.campaigns).set({ ruleToggles: { ...c.ruleToggles, [name]: value } }).where(eq(schema.campaigns.id, campaignId));
      return console.log(`${t.label}: ${value}`);
    }
    case "set": {
      const kv = Object.fromEntries(pairs(rest));
      const unknown = Object.keys(kv).filter((k) => !["party", "tone", "date", "safety"].includes(k));
      if (unknown.length || !Object.keys(kv).length) return console.log(CAMPAIGN_USAGE);
      const party = kv.party === undefined ? undefined : kv.party === "" ? null : (await findEntity(campaignId, kv.party)).id;
      return report(
        await updateCampaign(
          campaignId,
          { partyLocationId: party, tone: kv.tone, inGameDate: kv.date, safetyLines: kv.safety === undefined ? undefined : splitList(kv.safety) },
          DM,
        ),
      );
    }
    case "mechanic":
      return console.log('Mechanics are now structured rules. Use: npm run loom -- rule draft "<the rule in your words>"');
    default:
      console.log(CAMPAIGN_USAGE);
  }
}

const THREAD_USAGE = `thread set <id> [deadline=…] [stakes=…] [secret=yes|no]`;

export async function threadCommand(args: string[]) {
  const [sub, idRaw, ...rest] = args;
  const id = Number(idRaw?.replace(/^#|^T/i, ""));
  if (sub !== "set" || !id) return console.log(THREAD_USAGE);
  const kv = Object.fromEntries(pairs(rest));
  const unknown = Object.keys(kv).filter((k) => !["deadline", "stakes", "secret"].includes(k));
  if (unknown.length || !Object.keys(kv).length) return console.log(THREAD_USAGE);
  const secret = kv.secret === undefined ? undefined : ["yes", "true", "y", "1"].includes(kv.secret.toLowerCase());
  report(await updateThread(id, { deadline: kv.deadline, stakes: kv.stakes, secret }, DM));
}
