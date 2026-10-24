import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { EntityUpdate } from "./entity-extraction";
import { numberItems, type ProposalFile, type ProposalItem } from "./recap";

// Tiered review: confirm by risk, and lean on undo (every change is logged).
//   auto  - low-risk details the notes state outright (filling a blank): applied, shown in a
//           digest, undoable.
//   quick - ordinary story changes: grouped by entity, accepted with one keypress.
//   must  - anything risky: over the DM's own entries, deaths and captures, a held item changing
//           hands, secrets, closing a thread, or evidence that isn't in the notes.

export type Tier = "auto" | "quick" | "must";
const SAME_PLACE = "\u0000same place";
export type EvidenceCheck = "exact" | "close" | "missing" | "not-found";

export interface Reviewed {
  item: ProposalItem;
  tier: Tier;
  group: string; // what it's about, for grouping quick confirms
  summary: string; // one line for the GM
  evidence: string;
  check: EvidenceCheck;
  reasons: string[]; // why it's in this tier (for must-confirm items)
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

// Is the quote really in the notes? Exact (ignoring punctuation and case), close (most of its
// words, in a nearby span), or not found.
export function checkEvidence(evidence: string | undefined, notes: string): EvidenceCheck {
  const ev = words(evidence ?? "");
  if (!ev.length) return "missing";
  const hay = words(notes);
  const hayText = ` ${hay.join(" ")} `;
  if (hayText.includes(` ${ev.join(" ")} `)) return "exact";
  const content = ev.filter((w) => w.length >= 4);
  if (!content.length) return "not-found";
  const present = content.filter((w) => hay.includes(w)).length / content.length;
  return present >= 0.75 ? "close" : "not-found";
}

const RISKY_STATUS = new Set(["dead", "captured", "missing", "transformed", "destroyed", "lost", "broken", "disbanded"]);
const INTERPRETIVE_TRAITS = new Set(["alignment", "secrets", "true_properties"]);
const AUTO_RELATIONS = new Set(["member_of", "located_at", "lives_at", "made", "knows_about"]);
const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

// Splits each entity update so a risky field (a death, a judgement call, a change to the DM's own
// entry) is its own item: saying no to it doesn't throw away the safe details beside it.
export async function splitRisky(file: ProposalFile): Promise<ProposalFile> {
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, file.campaignId));
  const find = (n: string) => entities.find((e) => [e.name, ...e.aliases].some((a) => a.toLowerCase() === n.trim().toLowerCase()));
  const updates: EntityUpdate[] = [];
  for (const u of file.proposal.entity_updates ?? []) {
    const e = find(u.name);
    const dm = (field: string) => e?.fieldMeta[field]?.source === "dm";
    const empty = { ...u, status: "", attitude: "" as const, importance: "" as const, last_known_location: "", parent_location: "", traits: [] as EntityUpdate["traits"] };
    const risky: EntityUpdate[] = [];
    const safe: EntityUpdate = { ...u, traits: [] };
    const move = (cond: unknown, part: Partial<EntityUpdate>, clear: () => void) => {
      if (!cond) return;
      risky.push({ ...empty, ...part });
      clear();
    };
    move(u.status && (RISKY_STATUS.has(u.status) || dm("status")), { status: u.status }, () => {
      safe.status = "";
    });
    move(u.attitude && dm("attitude"), { attitude: u.attitude }, () => {
      safe.attitude = "";
    });
    move(u.importance && dm("importance"), { importance: u.importance }, () => {
      safe.importance = "";
    });
    move(u.last_known_location && dm("lastKnownLocationId"), { last_known_location: u.last_known_location }, () => {
      safe.last_known_location = "";
    });
    move(u.parent_location && dm("parentId"), { parent_location: u.parent_location }, () => {
      safe.parent_location = "";
    });
    for (const t of u.traits) {
      if (INTERPRETIVE_TRAITS.has(t.key) || dm(`traits.${t.key}`)) risky.push({ ...empty, traits: [t] });
      else safe.traits.push(t);
    }
    const hasSafe = safe.status || safe.attitude || safe.importance || safe.last_known_location || safe.parent_location || safe.traits.length;
    if (hasSafe) updates.push(safe);
    updates.push(...risky);
  }
  return { ...file, proposal: { ...file.proposal, entity_updates: updates } };
}

export async function reviewProposal(file: ProposalFile): Promise<Reviewed[]> {
  const items = numberItems(file.proposal);
  const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, file.campaignId));
  const byName = new Map<string, (typeof entities)[number]>();
  for (const e of entities) for (const n of [e.name, ...e.aliases]) byName.set(n.trim().toLowerCase(), e);
  const find = (n: string) => byName.get(n.trim().toLowerCase());
  const holds = await db
    .select()
    .from(schema.entityRelations)
    .where(and(eq(schema.entityRelations.campaignId, file.campaignId), eq(schema.entityRelations.type, "holds")));
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, file.campaignId));
  const nameOf = (id: number | null | undefined) => entities.find((e) => e.id === id)?.name;
  // Thread references read as titles: "T12" for existing threads, "N1" for new ones.
  const threadRows = await db.select({ id: schema.threads.id, title: schema.threads.title }).from(schema.threads).where(eq(schema.threads.campaignId, file.campaignId));
  const newTitles = new Map((file.proposal.new_threads ?? []).map((t) => [t.ref.trim().toUpperCase(), t.title]));
  const title = (ref: string) => {
    const m = ref.trim().match(/^T(\d+)$/i);
    return (m ? threadRows.find((t) => t.id === Number(m[1]))?.title : newTitles.get(ref.trim().toUpperCase())) ?? ref;
  };

  // What the evidence is checked against: this recap, or every stored recap for a backfill.
  let notes = file.recap;
  if (file.kind === "enrich" || !notes.trim()) {
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, file.campaignId));
    notes = sessions.map((s) => s.recap).join("\n");
  }

  return items.map((i): Reviewed => {
    const reasons: string[] = [];
    let tier: Tier = "quick";
    let group = "Other";
    let summary = "";
    let evidence = "";
    const must = (why: string) => {
      tier = "must";
      reasons.push(why);
    };

    switch (i.kind) {
      case "entity": {
        const it = i.item;
        evidence = it.evidence ?? "";
        group = it.name;
        summary = `new ${it.type === "pc" ? "player character" : it.type}: ${it.description}`;
        tier = "auto";
        if (it.type === "pc") must("a new player character");
        break;
      }
      case "thread": {
        const it = i.item;
        evidence = it.evidence ?? "";
        group = "Threads";
        summary = `+ ${it.title} (${it.kind})`;
        break;
      }
      case "update": {
        const it = i.item;
        evidence = it.evidence ?? "";
        group = "Threads";
        summary = `${it.change === "resolved" ? "✓ resolved" : "~ progressed"}: ${title(it.thread)} — ${it.note}`;
        if (it.change === "resolved") must("closes a thread for good");
        break;
      }
      case "link": {
        group = "Threads";
        summary = `link: ${title(i.item.from)} → ${title(i.item.to)} (${i.item.note})`;
        break;
      }
      case "entity_update": {
        const u = i.item;
        evidence = u.evidence ?? "";
        const e = find(u.name);
        group = e?.name ?? u.name;
        const fields: [string, unknown, unknown][] = []; // field, current, proposed
        const cur = (field: string) => (e ? (field.startsWith("traits.") ? (e.traits as Record<string, unknown>)[field.slice(7)] : (e as Record<string, unknown>)[field]) : undefined);
        if (u.status) fields.push(["status", cur("status"), u.status]);
        if (u.attitude) fields.push(["attitude", cur("attitude"), u.attitude]);
        if (u.importance) fields.push(["importance", cur("importance"), u.importance]);
        if (u.last_known_location) fields.push(["lastKnownLocationId", nameOf(cur("lastKnownLocationId") as number), u.last_known_location]);
        if (u.parent_location) fields.push(["parentId", nameOf(cur("parentId") as number), u.parent_location]);
        for (const t of u.traits) if (t.value.trim()) fields.push([`traits.${t.key}`, cur(`traits.${t.key}`), t.value]);

        let worst: Tier = "auto";
        const parts: string[] = [];
        for (const [field, current, proposed] of fields) {
          const label = field === "lastKnownLocationId" ? "last seen at" : field === "parentId" ? "inside" : field.replace(/^traits\./, "").replace(/_/g, " ");
          const same = String(current ?? "").toLowerCase() === String(proposed).toLowerCase();
          if (same) continue;
          parts.push(blank(current) ? `${label}: ${proposed}` : `${label}: ${Array.isArray(current) ? current.join("; ") : current} → ${proposed}`);
          let t: Tier = blank(current) ? "auto" : "quick";
          if (e?.fieldMeta[field]?.source === "dm") {
            t = "must";
            reasons.push(`changes your own entry for ${label}`);
          }
          if (field === "status" && RISKY_STATUS.has(String(proposed))) {
            t = "must";
            reasons.push(`marks ${group} ${proposed}`);
          }
          if (field.startsWith("traits.") && INTERPRETIVE_TRAITS.has(field.slice(7))) {
            t = "must";
            reasons.push(`sets ${label} (a judgement call)`);
          }
          if (t === "must" || (t === "quick" && worst === "auto")) worst = t;
        }
        tier = parts.length ? worst : "auto";
        summary = parts.join(" · ") || "(nothing new)";
        break;
      }
      case "relation": {
        const r = i.item;
        evidence = r.evidence ?? "";
        group = find(r.from)?.name ?? r.from;
        summary = `${r.from} ${r.type.replace(/_/g, " ")} ${r.to}${r.note ? ` (${r.note})` : ""}`;
        tier = AUTO_RELATIONS.has(r.type) ? "auto" : "quick";
        if (r.type === "holds") {
          const item = find(r.to);
          const other = holds.find((h) => h.toEntityId === item?.id && h.fromEntityId !== find(r.from)?.id);
          if (other) must(`moves ${item?.name} away from ${nameOf(other.fromEntityId)}`);
        }
        const dmHeld = holds.find((h) => h.source === "dm" && h.toEntityId === find(r.to)?.id && h.fromEntityId !== find(r.from)?.id);
        if (r.type === "holds" && dmHeld) reasons.push("you recorded the current holder yourself");
        break;
      }
      case "party": {
        evidence = file.proposal.party_evidence ?? "";
        group = "Party";
        const current = nameOf(campaign?.partyLocationId);
        // Staying put isn't a change worth showing (it's dropped below).
        if (current && current.trim().toLowerCase() === i.item.trim().toLowerCase()) summary = SAME_PLACE;
        else summary = current ? `party moves: ${current} → ${i.item}` : `party is at ${i.item}`;
        tier = current ? "quick" : "auto";
        if (campaign?.fieldMeta.partyLocationId?.source === "dm" && current && current !== i.item) must("changes where you said the party is");
        break;
      }
      case "moment": {
        group = "Key moments";
        summary = `☆ ${i.item.title}`;
        tier = "auto"; // saved as suggestions anyway; the GM stars the ones to keep
        break;
      }
    }

    // Evidence: a quote that isn't in the notes is a guess, so it needs a yes; no quote at all
    // means it can't be added silently.
    const check = i.kind === "link" || i.kind === "moment" ? "exact" : checkEvidence(evidence, notes);
    if (check === "not-found") must("its quote isn't in your notes");
    if (check === "missing" && tier === "auto") tier = "quick";
    return { item: i, tier, group, summary, evidence, check, reasons: [...new Set(reasons)] };
  }).filter((r) => r.summary !== SAME_PLACE);
}
