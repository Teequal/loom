// Key moments: list, add, star or dismiss suggestions, and flag an improv option you used.
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { MOMENT_TONES } from "@/core/db/schema";
import { findEntity } from "@/core/entity-card";
import { addMoment, listMoments, setMomentStatus, type MomentView, type Tone } from "@/core/moments";
import { findMentions } from "@/core/retrieval";
import { pairs, positional, splitList } from "./entity-cli";

const MOMENT_USAGE = `moment list [--all]                 key moments (--all includes suggested and dismissed)
moment add "<title>" [desc="…"] [tone=${MOMENT_TONES.join("|")}] [entities="A; B"] [threads="27; 11"] [callback="…"] [session=N]
moment from-improv <n> [tone=…] [callback="…"]   flag option n of the last improv as a key moment
moment star <id>                    accept a suggested moment
moment dismiss <id>                 drop one`;

function print(m: MomentView) {
  const mark = m.status === "key" ? "★" : m.status === "suggested" ? "☆" : "✗";
  console.log(`\n${mark} M${m.id}${m.session != null ? ` · session ${m.session}` : ""} · ${m.tone}  ${m.title}`);
  if (m.description) console.log(`    ${m.description}`);
  if (m.entities.length) console.log(`    ↳ ${m.entities.join(", ")}`);
  if (m.threads.length) console.log(`    threads: ${m.threads.map((t) => `#${t.id} ${t.title}`).join("; ")}`);
  if (m.callback) console.log(`    callback: ${m.callback}`);
}

async function sessionId(campaignId: number, n: string | undefined) {
  if (!n) return null;
  const [s] = (await db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId))).filter((x) => x.number === Number(n));
  if (!s) throw new Error(`No session ${n} in this campaign`);
  return s.id;
}

export async function momentCommand(campaignId: number, args: string[]) {
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const kv = Object.fromEntries(pairs(rest));
  const tone = kv.tone as Tone | undefined;
  if (tone && !(MOMENT_TONES as readonly string[]).includes(tone)) throw new Error(`tone is one of: ${MOMENT_TONES.join(", ")}`);

  switch (sub) {
    case "list": {
      const rows = await listMoments(campaignId, rest.includes("--all") ? ["key", "suggested", "dismissed"] : ["key", "suggested"]);
      if (!rows.length) return console.log('No key moments yet. Flag one with: npm run loom -- moment from-improv <n>, or moment add "<title>"');
      rows.forEach(print);
      console.log("\n★ key · ☆ suggested (moment star <id> to keep) · ✗ dismissed");
      return;
    }
    case "add": {
      if (!pos[0]) return console.log(MOMENT_USAGE);
      const entityIds = kv.entities ? await Promise.all(splitList(kv.entities).map(async (n) => (await findEntity(campaignId, n)).id)) : [];
      const threadIds = kv.threads ? splitList(kv.threads).map((t) => Number(t.replace(/^#|^T/i, ""))) : [];
      const m = await addMoment(campaignId, { title: pos[0], description: kv.desc, tone, callback: kv.callback, entityIds, threadIds, sessionId: await sessionId(campaignId, kv.session) }, "dm", "key");
      return console.log(`★ Saved M${m.id}: ${m.title}`);
    }
    case "from-improv": {
      const n = Number(pos[0]);
      if (!existsSync("data/last-improv.json")) return console.log("Run an improv first.");
      const last = JSON.parse(readFileSync("data/last-improv.json", "utf8"));
      const picked = last.options?.[n - 1];
      if (!picked || last.campaignId !== campaignId) return console.log(`Pick an option from the last improv in this campaign: 1-${last.options?.length ?? 0}`);
      const entities = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
      const named = findMentions(entities, `${last.moment} ${picked.text ?? ""}`);
      const entityIds = entities.filter((e) => named.has(e.name)).map((e) => e.id);
      const title = picked.label.charAt(0).toUpperCase() + picked.label.slice(1).toLowerCase();
      const m = await addMoment(
        campaignId,
        { title, description: `${last.moment}. ${picked.text ?? ""}`.trim(), tone, callback: kv.callback, entityIds, threadIds: picked.threadIds ?? [] },
        "dm",
        "key",
      );
      console.log(`★ Saved M${m.id} as a key moment.`);
      return print((await listMoments(campaignId, ["key"])).find((x) => x.id === m.id)!);
    }
    case "star":
    case "dismiss": {
      const id = Number(pos[0]?.replace(/^M/i, ""));
      const m = id ? await setMomentStatus(campaignId, id, sub === "star" ? "key" : "dismissed") : undefined;
      return console.log(m ? `${sub === "star" ? "★ Kept" : "✗ Dismissed"} M${m.id}: ${m.title}` : `No moment ${pos[0]} in this campaign.`);
    }
    default:
      console.log(MOMENT_USAGE);
  }
}
