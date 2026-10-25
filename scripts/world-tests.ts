// World model, stage 1: today's tables read into typed nodes and links.
// Run: npm run test:world -- [campaignId …] [--report]
// Always checks the sample campaign (reseeded); other campaign ids are read only.
import { eq, inArray } from "drizzle-orm";
import { db, initDb, schema } from "../src/core/db/client";
import { seedFixture } from "../src/core/seed";
import { LINK_TYPES } from "../src/core/world/links";
import { loadGraph } from "../src/core/world/load";
import type { AnyNode, NodeKey } from "../src/core/world/nodes";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `  → ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}` : ""}`);
};

// How much of each kind's typed properties a campaign has filled in.
function coverage(nodes: AnyNode[]) {
  const filled = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.values(v).some(filled) : v !== undefined && v !== null && v !== "");
  const byKind = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  const skip = new Set(["key", "id", "campaignId", "name", "kind", "meta", "aliases", "notes"]);
  for (const n of nodes) {
    counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    const m = byKind.get(n.kind) ?? new Map<string, number>();
    const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(obj)) {
        if (skip.has(k) && !prefix) continue;
        const path = prefix ? `${prefix}.${k}` : k;
        if (depth < 1 && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, path, depth + 1);
        else m.set(path, (m.get(path) ?? 0) + (filled(v) ? 1 : 0));
      }
    };
    walk(n as unknown as Record<string, unknown>, "", 0);
    byKind.set(n.kind, m);
  }
  for (const [kind, m] of byKind) {
    const total = counts.get(kind)!;
    console.log(`\n  ${kind} (${total})`);
    for (const [path, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}/${total}  ${path}`);
  }
}

async function run(campaignId: number, label: string, report: boolean) {
  console.log(`\n${label}`);
  const g = await loadGraph(campaignId);
  const nodes = [...g.nodes.values()];
  check("every record fits its schema and every link its laws", g.problems.length === 0, g.problems.slice(0, 5));

  const [entities, relations, threads] = await Promise.all([
    db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId)),
    db.select().from(schema.entityRelations).where(eq(schema.entityRelations.campaignId, campaignId)),
    db.select().from(schema.threads).where(eq(schema.threads.campaignId, campaignId)),
  ]);
  const threadLinks = threads.length ? await db.select().from(schema.threadEntities).where(inArray(schema.threadEntities.threadId, threads.map((t) => t.id))) : [];
  check("every entity and thread is a node", entities.every((e) => g.entityKey(e.id) && g.nodes.has(g.entityKey(e.id)!)) && threads.every((t) => g.nodes.has(`thread:${t.id}`)));

  // Each relationship once: two-way ones stored twice today become one link.
  const twoWayPairs = new Set(relations.filter((r) => LINK_TYPES[r.type]?.symmetric).map((r) => `${r.type}:${[r.fromEntityId, r.toEntityId].sort((a, b) => a - b).join("-")}`));
  const oneWay = relations.filter((r) => !LINK_TYPES[r.type]?.symmetric).length;
  const relLinks = g.links.filter((l) => l.id.startsWith("rel:")).length;
  check(`each relationship is one link (${relations.length} rows → ${relLinks} links)`, relLinks === oneWay + twoWayPairs.size, { oneWay, twoWay: twoWayPairs.size, relLinks });
  const keys = g.links.map((l) => `${l.type}:${l.from.kind}:${l.from.id}>${l.to.kind}:${l.to.id}:${l.certainty ?? ""}`);
  check("no link is duplicated", new Set(keys).size === keys.length);
  check(`each thread link is one link with a role (${threadLinks.length})`, g.links.filter((l) => l.type === "in_thread").length === threadLinks.length && g.links.filter((l) => l.type === "in_thread").every((l) => !!l.role));

  // Read from either end: a thread's members and a member's threads are the same links.
  const someThread = threads.find((t) => threadLinks.some((x) => x.threadId === t.id));
  if (someThread) {
    const tk = `thread:${someThread.id}` as NodeKey;
    const members = g.linksOf(tk, { type: "in_thread" });
    const back = members.every((l) => g.linksOf(g.other(l, tk), { type: "in_thread" }).includes(l));
    check(`a thread's links are its members' links ("${someThread.title}")`, back && members.length > 0);
  }
  const twoWay = g.links.find((l) => LINK_TYPES[l.type]?.symmetric);
  if (twoWay) {
    const [a, b] = [`${twoWay.from.kind}:${twoWay.from.id}`, `${twoWay.to.kind}:${twoWay.to.id}`] as NodeKey[];
    check(`a two-way link is found from both ends (${twoWay.type})`, g.linksOf(a, { type: twoWay.type, dir: "out" }).includes(twoWay) && g.linksOf(b, { type: twoWay.type, dir: "out" }).includes(twoWay));
  }
  const pcs = nodes.filter((n) => n.kind === "character" && n.side === "pc");
  check("every PC belongs to the party", pcs.every((p) => g.linksOf(p.key as NodeKey, { type: "member_of" }).some((l) => l.to.kind === "party")));
  // Every field the records say who wrote carries that tag on the node.
  const tagged = entities.filter((e) => Object.keys(e.fieldMeta ?? {}).length);
  check(`tags follow their values (${tagged.length} records with tags)`, tagged.every((e) => Object.keys(g.nodes.get(g.entityKey(e.id)!)!.meta).length === Object.keys(e.fieldMeta).length));
  if (report) coverage(nodes);
  return g;
}

(async () => {
  await initDb();
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  const c = await seedFixture();
  const g = await run(c.id, "Sample campaign (reseeded)", report);
  // Specific facts from the sample: who holds what, and Bram's thread from his side.
  const bram = g.find("Bram");
  check("Bram is a PC character node", bram?.kind === "character" && bram.side === "pc");
  if (bram) check("Bram's threads are found from Bram", g.linksOf(bram.key as NodeKey, { type: "in_thread" }).length > 0);

  for (const id of ids) {
    const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
    const gg = await run(id, `${camp?.name ?? `Campaign ${id}`} (read only)`, report);
    const knight = gg.find("Knight figurine");
    if (knight?.kind === "item") {
      check("the Knight figurine is lost, last seen at the River Morrow", knight.status === "lost" && gg.linksOf(knight.key as NodeKey, { type: "located_at", dir: "out" }).some((l) => gg.nodes.get(gg.other(l, knight.key as NodeKey))?.name === "River Morrow"));
    }
  }
  console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
  process.exit(failed ? 1 : 0);
})();
