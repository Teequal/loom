import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { count, eq, inArray } from "drizzle-orm";
import { spentBy } from "@/core/access";
import { db, schema } from "@/core/db/client";

// Invites for testers: each gets a link with their own code, their own campaigns, and a cap on
// what their model calls may cost (US$). The public address comes from the share script.
const usd = (n: number) => `$${n.toFixed(2)}`;
const publicUrl = () => process.env.LOOM_PUBLIC_URL ?? (existsSync("data/public-url.txt") ? readFileSync("data/public-url.txt", "utf8").trim() : "<the shared address>");
const linkFor = (code: string) => `${publicUrl()}/join/${code}`;

async function byName(name: string) {
  const [t] = await db.select().from(schema.testers).where(eq(schema.testers.name, name));
  if (!t) throw new Error(`No invite for "${name}". See: npm run loom -- invite list`);
  return t;
}

export async function inviteCommand(args: string[]) {
  const [sub, name, value] = args;
  const flag = (f: string) => {
    const i = args.indexOf(`--${f}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  switch (sub) {
    case "add": {
      if (!name) throw new Error('Usage: invite add "<name>" [--cap 2] [--owner]');
      const code = randomBytes(9).toString("base64url");
      const owner = args.includes("--owner");
      const capUsd = Number(flag("cap") ?? 2);
      await db.insert(schema.testers).values({ name, code, owner, capUsd });
      console.log(`${name}${owner ? " (you: sees your campaigns, no cap)" : `: their own campaigns, cap ${usd(capUsd)}`}\n${linkFor(code)}`);
      return;
    }
    case "list": {
      const rows = await db.select().from(schema.testers).orderBy(schema.testers.id);
      if (!rows.length) return console.log('No invites yet. Add one: npm run loom -- invite add "<name>"');
      for (const t of rows) {
        const [{ n }] = await db.select({ n: count() }).from(schema.campaigns).where(eq(schema.campaigns.testerId, t.id));
        const spent = await spentBy(t.id);
        const state = t.revokedAt ? "switched off" : t.owner ? "owner" : `${usd(spent)} of ${usd(t.capUsd)}`;
        console.log(`  ${t.name.padEnd(16)} ${state.padEnd(16)} ${String(n).padStart(2)} campaigns  ${linkFor(t.code)}`);
      }
      return;
    }
    case "cap": {
      const t = await byName(name);
      const capUsd = Number(value);
      if (!(capUsd >= 0)) throw new Error('Usage: invite cap "<name>" <dollars>');
      await db.update(schema.testers).set({ capUsd }).where(eq(schema.testers.id, t.id));
      return console.log(`${t.name}: cap ${usd(capUsd)} (spent ${usd(await spentBy(t.id))})`);
    }
    case "revoke":
    case "restore": {
      const t = await byName(name);
      await db.update(schema.testers).set({ revokedAt: sub === "revoke" ? new Date().toISOString() : null }).where(eq(schema.testers.id, t.id));
      return console.log(`${t.name}: ${sub === "revoke" ? "switched off (their link stops working; their campaigns are kept)" : "back on"}`);
    }
    case "remove": {
      // The tester and everything in their campaigns. Their calls stay in the cost log, unlinked.
      const t = await byName(name);
      const camps = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.testerId, t.id));
      for (const { id } of camps) await deleteCampaign(id);
      await db.update(schema.llmCalls).set({ testerId: null }).where(eq(schema.llmCalls.testerId, t.id));
      await db.delete(schema.testers).where(eq(schema.testers.id, t.id));
      return console.log(`${t.name}: removed, with ${camps.length} campaign${camps.length === 1 ? "" : "s"}`);
    }
    default:
      console.log(`invite add "<name>" [--cap 2] [--owner]   a link for a tester (or --owner for you, from outside)
invite list                              everyone invited, what they've spent, their links
invite cap "<name>" <dollars>            change someone's cap
invite revoke "<name>" | restore         switch a link off, or back on
invite remove "<name>"                   delete them and their campaigns (can't be undone)`);
  }
}

// Everything in one campaign, then the campaign. Proposal files for it go too.
async function deleteCampaign(campaignId: number) {
  const threadIds = (await db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.campaignId, campaignId))).map((t) => t.id);
  if (threadIds.length) {
    await db.delete(schema.threadEntities).where(inArray(schema.threadEntities.threadId, threadIds));
    await db.delete(schema.threadEvents).where(inArray(schema.threadEvents.threadId, threadIds));
    await db.delete(schema.threadLinks).where(inArray(schema.threadLinks.fromThreadId, threadIds));
    await db.delete(schema.threadLinks).where(inArray(schema.threadLinks.toThreadId, threadIds));
  }
  await db.update(schema.llmCalls).set({ campaignId: null }).where(eq(schema.llmCalls.campaignId, campaignId));
  for (const t of [schema.optionRejections, schema.pairWeights, schema.embeddings, schema.liveEntries, schema.stateChanges, schema.keyMoments, schema.effects, schema.entityRelations, schema.players, schema.threads, schema.entities, schema.sessions])
    await db.delete(t).where(eq(t.campaignId, campaignId));
  await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (existsSync("data/proposals")) for (const f of readdirSync("data/proposals")) if (new RegExp(`-c${campaignId}-`).test(f)) rmSync(`data/proposals/${f}`);
}
