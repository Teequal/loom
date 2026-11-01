import { eq, inArray } from "drizzle-orm";
import { db, schema } from "./db/client";

// A campaign, out of Loom: everything as data (JSON), or a readable document a GM can keep, print
// or take to another tool (Markdown). Both include GM secrets, so they're for the GM alone.

async function load(campaignId: number) {
  const of = <T extends { campaignId: unknown }>(t: T) => eq(t.campaignId as never, campaignId);
  const [[campaign], sessions, entities, relations, pairWeights, threads, keyMoments, houseRules, players, gmNotes, liveEntries] = await Promise.all([
    db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
    db.select().from(schema.sessions).where(of(schema.sessions)).orderBy(schema.sessions.number),
    db.select().from(schema.entities).where(of(schema.entities)),
    db.select().from(schema.entityRelations).where(of(schema.entityRelations)),
    db.select().from(schema.pairWeights).where(of(schema.pairWeights)),
    db.select().from(schema.threads).where(of(schema.threads)),
    db.select().from(schema.keyMoments).where(of(schema.keyMoments)),
    db.select().from(schema.effects).where(of(schema.effects)),
    db.select().from(schema.players).where(of(schema.players)),
    db.select().from(schema.gmNotes).where(of(schema.gmNotes)),
    db.select().from(schema.liveEntries).where(of(schema.liveEntries)),
  ]);
  if (!campaign) throw new Error("That campaign has gone.");
  const ids = threads.map((t) => t.id);
  const [threadEntities, threadLinks, threadEvents] = ids.length
    ? await Promise.all([
        db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, ids)),
        db.select().from(schema.threadLinks).where(inArray(schema.threadLinks.fromThreadId, ids)),
        db.select().from(schema.threadEvents).where(inArray(schema.threadEvents.threadId, ids)),
      ])
    : [[], [], []];
  const { testerId: _tester, ...campaignRow } = campaign;
  void _tester;
  return { campaign: campaignRow, sessions, entities, relations, pairWeights, threads, threadEntities, threadLinks, threadEvents, keyMoments, houseRules, players, gmNotes, liveEntries };
}

const TYPE_HEADINGS: [string, string][] = [["pc", "Player characters"], ["npc", "Characters"], ["location", "Places"], ["item", "Items"], ["faction", "Factions"], ["other", "Other"]];

export async function campaignMarkdown(campaignId: number) {
  const d = await load(campaignId);
  const nameOf = new Map(d.entities.map((e) => [e.id, e.name]));
  const out: string[] = [`# ${d.campaign.name}`, "", "*Contains GM secrets. Not for the players.*", ""];
  if (d.campaign.direction) out.push("## Where the story is heading", "", d.campaign.direction, "");
  if (d.gmNotes.length) out.push("## Secrets", "", ...d.gmNotes.map((n) => `- ${n.text}`), "");

  const threadBlock = (t: (typeof d.threads)[number]) => {
    const who = d.threadEntities.filter((x) => x.threadId === t.id).map((x) => nameOf.get(x.entityId)).filter(Boolean);
    return [`### ${t.title}${t.secret ? " (secret)" : ""}`, "", t.summary, ...(who.length ? ["", `Involves: ${who.join(", ")}`] : []), ...(t.stakes ? ["", `Stakes: ${t.stakes}`] : []), ...(t.deadline ? ["", `Deadline: ${t.deadline}`] : []), ""];
  };
  const open = d.threads.filter((t) => t.status !== "resolved");
  const closed = d.threads.filter((t) => t.status === "resolved");
  if (open.length) out.push("## Open threads", "", ...open.flatMap(threadBlock));
  if (closed.length) out.push("## Resolved threads", "", ...closed.flatMap(threadBlock));

  for (const [type, heading] of TYPE_HEADINGS) {
    const es = d.entities.filter((e) => e.type === type);
    if (!es.length) continue;
    out.push(`## ${heading}`, "");
    for (const e of es) {
      const ties = d.relations.filter((r) => r.fromEntityId === e.id && nameOf.has(r.toEntityId)).map((r) => `${r.type.replace(/_/g, " ")} ${nameOf.get(r.toEntityId)}${r.secret ? " (secret)" : ""}`);
      out.push(`### ${e.name}`, "", ...(e.description ? [e.description, ""] : []));
      if (e.status && e.status !== "alive") out.push(`Status: ${e.status}`, "");
      if (ties.length) out.push(`Ties: ${ties.join("; ")}`, "");
    }
  }
  const stars = d.keyMoments.filter((m) => m.status === "key");
  if (stars.length) out.push("## Key moments", "", ...stars.map((m) => `- **${m.title}**: ${m.description}`), "");
  if (d.houseRules.length) out.push("## House rules", "", ...d.houseRules.map((r) => `- ${r.rule}`), "");
  const written = d.sessions.filter((s) => s.recap.trim());
  if (written.length) out.push("## Sessions", "", ...written.flatMap((s) => [`### Session ${s.number}`, "", s.recap.trim(), ""]));
  return out.join("\n");
}

export async function campaignData(campaignId: number) {
  return JSON.stringify({ format: "loom-campaign", version: 1, exportedAt: new Date().toISOString(), ...(await load(campaignId)) }, null, 2);
}

export async function exportCampaign(campaignId: number, format: "markdown" | "data") {
  const [c] = await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const base = (c?.name ?? "campaign").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "campaign";
  return format === "markdown" ? { filename: `${base}.md`, type: "text/markdown", content: await campaignMarkdown(campaignId) } : { filename: `${base}.json`, type: "application/json", content: await campaignData(campaignId) };
}
