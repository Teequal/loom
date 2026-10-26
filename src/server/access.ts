import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import type { Who } from "@/core/access";

// Invite-only sharing. With LOOM_INVITES=on, a request from outside (through the Cloudflare tunnel,
// which always adds cf-connecting-ip) needs an invite cookie; requests from this Mac or the home
// network don't. Each tester sees only their own campaigns.
export const INVITE_COOKIE = "loom_invite";

export const invitesOn = () => process.env.LOOM_INVITES === "on";
export const fromOutside = (request: Request) => !!request.headers.get("cf-connecting-ip");

export function cookieOf(request: Request, name: string) {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function testerByCode(code: string) {
  const [t] = await db.select().from(schema.testers).where(and(eq(schema.testers.code, code), isNull(schema.testers.revokedAt)));
  return t ?? null;
}

/** Who a request is for, or null when it needs an invite and has none. */
export async function whoIs(request: Request): Promise<Who | null> {
  if (!invitesOn()) return { kind: "owner", testerId: null };
  const code = cookieOf(request, INVITE_COOKIE);
  const t = code ? await testerByCode(code) : null;
  if (t) return t.owner ? { kind: "owner", testerId: t.id } : { kind: "tester", testerId: t.id, name: t.name };
  return fromOutside(request) ? null : { kind: "owner", testerId: null };
}

// The owner's campaigns have no tester; a tester's carry theirs.
export const campaignOwner = (who: Who) => (who.kind === "tester" ? eq(schema.campaigns.testerId, who.testerId) : isNull(schema.campaigns.testerId));
export const ownerIdFor = (who: Who) => (who.kind === "tester" ? who.testerId : null);

// Each key a request can name, and the table that says which campaign it belongs to.
const CAMPAIGN_OF = {
  entry: schema.liveEntries,
  entity: schema.entities,
  thread: schema.threads,
  moment: schema.keyMoments,
} as const;
const KEYS: Record<string, keyof typeof CAMPAIGN_OF> = {
  entryId: "entry",
  parentId: "entry",
  entityId: "entity",
  holderId: "entity",
  itemId: "entity",
  fromEntityId: "entity",
  toEntityId: "entity",
};

/**
 * Whether everything a request names (its campaign, entries, characters, threads, moments) belongs
 * to campaigns this person may see. Anything not found counts as not theirs.
 */
export async function mayTouch(who: Who, body: unknown): Promise<boolean> {
  if (who.kind === "owner" && !invitesOn()) return true;
  const campaigns = new Set<number>();
  const rows: [keyof typeof CAMPAIGN_OF, number][] = [];
  const walk = (v: unknown, top: boolean) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === "number" && k === "campaignId") campaigns.add(x);
      else if (typeof x === "number" && KEYS[k]) rows.push([KEYS[k], x]);
      // A node named by kind and id (the inspector), or a key moment by id (starring one).
      else if (top && k === "id" && typeof x === "number") {
        const kind = o.kind;
        if (kind === "thread" || kind === "entity" || kind === "moment") rows.push([kind, x]);
        else if (kind === undefined) rows.push(["moment", x]);
      } else walk(x, false);
    }
  };
  walk(body, true);
  for (const [table, id] of rows) {
    const t = CAMPAIGN_OF[table];
    const [r] = await db.select({ campaignId: t.campaignId }).from(t).where(eq(t.id, id));
    if (!r) return false;
    campaigns.add(r.campaignId);
  }
  for (const id of campaigns) {
    const [c] = await db.select({ testerId: schema.campaigns.testerId }).from(schema.campaigns).where(eq(schema.campaigns.id, id));
    if (!c || (who.kind === "tester" ? c.testerId !== who.testerId : c.testerId != null)) return false;
  }
  return true;
}

export const NEEDS_INVITE = () => Response.json({ error: "Loom is invite-only for now. Open your invite link again." }, { status: 401 });
export const NOT_YOURS = () => Response.json({ error: "That isn't in your campaigns." }, { status: 403 });
