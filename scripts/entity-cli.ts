// Manual entry commands: entities, relationships, campaign fields and thread fields.
// Everything entered here is recorded as the DM's, so extraction will never overwrite it.
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { findEntity, loadEntityCard } from "@/core/entity-card";
import {
  ENTITY_STATUSES,
  type EntityTraits,
  type FieldMeta,
  LIST_TRAITS,
  RELATION_TYPES,
  type RelationType,
  TRAIT_KEYS,
} from "@/core/entity-fields";
import { ENTITY_TYPES } from "@/core/db/schema";
import {
  type EntityPatch,
  removeRelation,
  setRelation,
  updateCampaign,
  updateEntity,
  updateThread,
  type WriteResult,
} from "@/core/entities";

const DM = { source: "dm" as const };

// Friendly names on the command line → column names in the database.
const LOCATION_KEYS: Record<string, "lastKnownLocationId" | "actualLocationId" | "parentLocationId"> = {
  "last-known": "lastKnownLocationId",
  actual: "actualLocationId",
  parent: "parentLocationId",
};
const COLUMN_KEYS = ["description", "aliases", "status", "attitude", "importance"];

const splitList = (v: string) =>
  v
    .split(v.includes(";") ? ";" : ",")
    .map((s) => s.trim())
    .filter(Boolean);

// "key=value" arguments → [key, value] pairs; everything else is left for the caller.
function pairs(args: string[]) {
  return args
    .filter((a) => /^[a-z_-]+=/i.test(a))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i).toLowerCase(), a.slice(i + 1)] as const;
    });
}
const positional = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // These flags take a value; skip it too. (--secret on relate takes none.)
      const takesValue = ["--campaign", "--type"].includes(args[i]) || (args[i] === "--secret" && args[i + 1] && !args[i + 1].startsWith("--") && !args[i + 1].includes("=") && /^[a-z_,-]+$/i.test(args[i + 1]) && args[i + 1].split(",").every((k) => isFieldKey(k)));
      if (takesValue) i++;
      continue;
    }
    if (!/^[a-z_-]+=/i.test(args[i])) out.push(args[i]);
  }
  return out;
};
const flagValue = (args: string[], name: string) => {
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
    } else if (field.endsWith("LocationId")) {
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
    card.parentLocation && `  inside: ${card.parentLocation}${m("parentLocationId")}`,
  ].filter(Boolean);
  if (where.length) console.log(`\nWhere\n${where.join("\n")}`);

  const traits = Object.entries(e.traits).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : v === "" || v == null));
  if (traits.length) {
    console.log("\nTraits");
    for (const [k, v] of traits) console.log(`  ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join("; ") : v}${m(`traits.${k}`)}`);
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
entity new "<name>" <${ENTITY_TYPES.join("|")}> [field=value …]
entity set "<name>" field=value [field=value …] [--secret field,field]
  Location fields take a location's name: last-known=, actual=, parent=
  List fields take a comma- or semicolon-separated list: ${[...LIST_TRAITS].join(", ")}
  An empty value clears a field: voice=`;

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
    case "new": {
      const [name, type] = pos;
      if (!name || !(ENTITY_TYPES as readonly string[]).includes(type)) return console.log(ENTITY_USAGE);
      const [e] = await db
        .insert(schema.entities)
        .values({ campaignId, name, type: type as (typeof ENTITY_TYPES)[number], fieldMeta: { name: { source: "dm", at: new Date().toISOString() } } })
        .returning();
      console.log(`Created ${e.name} (${e.type}).`);
      if (kv.length) report(await updateEntity(e.id, await buildPatch(campaignId, kv), { ...DM, secret }));
      return;
    }
    case "set": {
      if (!pos[0] || !kv.length) return console.log(ENTITY_USAGE);
      const e = await findEntity(campaignId, pos[0]);
      const patch = await buildPatch(campaignId, kv);
      if (patch.status && !(ENTITY_STATUSES[e.type] as readonly string[]).includes(patch.status)) {
        throw new Error(`Status for ${e.name} (${e.type.toUpperCase()}) is one of: ${ENTITY_STATUSES[e.type].join(", ")}`);
      }
      return report(await updateEntity(e.id, patch, { ...DM, secret }));
    }
    default:
      console.log(ENTITY_USAGE);
  }
}

const RELATE_USAGE = `relate "<from>" <type> "<to>" [note="…"] [strength=-3…3] [--secret]
unrelate "<from>" <type> "<to>"
  Types: ${RELATION_TYPES.join(", ")}`;

function relationType(raw: string | undefined): RelationType {
  const t = (raw ?? "").toLowerCase().replace(/-/g, "_");
  if (!(RELATION_TYPES as readonly string[]).includes(t)) throw new Error(`Unknown relationship type "${raw}".\n${RELATE_USAGE}`);
  return t as RelationType;
}

export async function relateCommand(campaignId: number, args: string[], remove = false) {
  const [fromName, typeRaw, toName] = positional(args);
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
}

const CAMPAIGN_USAGE = `campaign show
campaign set [party=<location>] [tone=…] [date=…] [safety=topic;topic]
campaign mechanic add "<name>" "<rule>"
campaign mechanic remove "<name>"`;

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
      console.log(`  mechanics:${c.mechanics.length ? "" : " (none)"}`);
      for (const mech of c.mechanics) console.log(`    • ${mech.name}: ${mech.rule}`);
      return;
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
    case "mechanic": {
      const [action, name, rule] = positional(rest);
      if (action === "add" && name && rule) {
        const mechanics = [...c.mechanics.filter((m) => m.name.toLowerCase() !== name.toLowerCase()), { name, rule }];
        return report(await updateCampaign(campaignId, { mechanics }, DM));
      }
      if (action === "remove" && name) {
        const mechanics = c.mechanics.filter((m) => m.name.toLowerCase() !== name.toLowerCase());
        if (mechanics.length === c.mechanics.length) return console.log(`No mechanic called "${name}".`);
        return report(await updateCampaign(campaignId, { mechanics }, DM));
      }
      return console.log(CAMPAIGN_USAGE);
    }
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
