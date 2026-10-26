import { AsyncLocalStorage } from "node:async_hooks";
import { eq, sum } from "drizzle-orm";
import { db, schema } from "./db/client";

// Who a request is for, when Loom is shared with invited testers. The server sets it per request
// (src/server/access.ts) and it follows the work through, including background extraction, so
// every model call knows whose allowance it spends.
export type Who = { kind: "owner"; testerId: number | null } | { kind: "tester"; testerId: number; name: string };

const store = new AsyncLocalStorage<Who>();
export const asWho = <T>(who: Who, run: () => T) => store.run(who, run);
export const currentWho = () => store.getStore();

/** What a tester's model calls have cost so far. */
export async function spentBy(testerId: number) {
  const [row] = await db.select({ total: sum(schema.llmCalls.costUsd) }).from(schema.llmCalls).where(eq(schema.llmCalls.testerId, testerId));
  return Number(row?.total ?? 0);
}

/**
 * Before a model call: whose it is (the request's tester, else the campaign's), and whether they
 * still have allowance. Returns the tester's id to record on the call; the owner has no cap.
 */
export async function checkAllowance(campaignId?: number | null): Promise<number | null> {
  const who = currentWho();
  let testerId = who?.testerId ?? null;
  if (testerId == null && campaignId) {
    const [c] = await db.select({ testerId: schema.campaigns.testerId }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    testerId = c?.testerId ?? null;
  }
  if (testerId == null) return null;
  const [t] = await db.select().from(schema.testers).where(eq(schema.testers.id, testerId));
  if (!t || t.owner) return t?.id ?? null;
  if (t.revokedAt) throw new Error("This invite has been switched off. Thanks for trying Loom!");
  if ((await spentBy(t.id)) >= t.capUsd) throw new Error("You've used this test's AI allowance. Thanks for trying Loom! Ask whoever invited you if you'd like more.");
  return t.id;
}
