// The player layer: the real people at the table. DM-only.
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/core/db/client";
import { PILLARS } from "@/core/db/schema";
import { findEntity } from "@/core/entity-card";
import { parseEnjoys, tableSeats } from "@/core/players";
import { pairs, positional, splitList } from "./entity-cli";

const PLAYER_USAGE = `player list                          who plays whom, what they enjoy, and the spotlight
player add "<handle>" plays="<PC>" [enjoys="mystery 3, comedy 2"] [lines="topic; topic"] [notes="…"]
player set "<handle>" [plays=…] [enjoys=…] [lines=…] [notes=…]
player remove "<handle>"
  enjoys: ${PILLARS.join(", ")}, each 0-3 (1 = neutral). Players never appear in suggestions.`;

async function findPlayer(campaignId: number, handle: string) {
  const rows = await db.select().from(schema.players).where(eq(schema.players.campaignId, campaignId));
  const p = rows.find((r) => r.handle.toLowerCase() === handle.trim().toLowerCase());
  if (!p) throw new Error(`No player called "${handle}". Players: ${rows.map((r) => r.handle).join(", ") || "none yet"}`);
  return p;
}

async function apply(campaignId: number, playerId: number, kv: Record<string, string>) {
  const patch: Partial<typeof schema.players.$inferInsert> = {};
  if (kv.enjoys !== undefined) patch.enjoys = parseEnjoys(kv.enjoys);
  if (kv.lines !== undefined) patch.personalLines = splitList(kv.lines);
  if (kv.notes !== undefined) patch.tableNotes = kv.notes;
  if (Object.keys(patch).length) await db.update(schema.players).set(patch).where(eq(schema.players.id, playerId));
  if (kv.plays !== undefined) {
    for (const name of splitList(kv.plays)) {
      const pc = await findEntity(campaignId, name);
      if (pc.type !== "pc") throw new Error(`${pc.name} isn't a player character`);
      await db.update(schema.entities).set({ playerId }).where(eq(schema.entities.id, pc.id));
    }
  }
}

export async function playerCommand(campaignId: number, args: string[]) {
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const kv = Object.fromEntries(pairs(rest));

  switch (sub) {
    case "list": {
      const seats = await tableSeats(campaignId);
      console.log("\nThe table (DM-only)");
      for (const s of seats) {
        const enjoys = s.player ? PILLARS.filter((k) => (s.player!.enjoys[k] ?? 1) !== 1).map((k) => `${k} ${s.player!.enjoys[k]}`).join(", ") : "";
        console.log(`\n  ${s.pc.name}${s.player ? ` · played by ${s.player.handle}` : " · (no player set)"}`);
        if (enjoys) console.log(`    enjoys: ${enjoys}`);
        console.log(`    spotlight: ${s.lastSpotlight != null ? `last had a moment in session ${s.lastSpotlight}` : "no moment of their own yet"}${s.quietFor > 0 ? ` · quiet for ${s.quietFor} session${s.quietFor > 1 ? "s" : ""}` : ""}`);
        if (s.landed.length) console.log(`    has landed: ${s.landed.join("; ")}`);
        if (s.player?.personalLines.length) console.log(`    personal lines: ${s.player.personalLines.join("; ")}`);
        if (s.player?.tableNotes) console.log(`    note: ${s.player.tableNotes}`);
      }
      return;
    }
    case "add": {
      if (!pos[0]) return console.log(PLAYER_USAGE);
      const existing = await db.select().from(schema.players).where(and(eq(schema.players.campaignId, campaignId), eq(schema.players.handle, pos[0])));
      if (existing.length) throw new Error(`${pos[0]} is already a player here; use player set`);
      const [p] = await db.insert(schema.players).values({ campaignId, handle: pos[0] }).returning();
      await apply(campaignId, p.id, kv);
      return console.log(`Added ${p.handle}.`);
    }
    case "set": {
      if (!pos[0]) return console.log(PLAYER_USAGE);
      const p = await findPlayer(campaignId, pos[0]);
      await apply(campaignId, p.id, kv);
      return console.log(`Updated ${p.handle}.`);
    }
    case "remove": {
      if (!pos[0]) return console.log(PLAYER_USAGE);
      const p = await findPlayer(campaignId, pos[0]);
      await db.update(schema.entities).set({ playerId: null }).where(eq(schema.entities.playerId, p.id));
      await db.delete(schema.players).where(eq(schema.players.id, p.id));
      return console.log(`Removed ${p.handle}; their characters are kept.`);
    }
    default:
      console.log(PLAYER_USAGE);
  }
}
