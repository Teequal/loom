import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "./db/client";
import type { FieldMeta } from "./entity-fields";

// Everything known about one entity, with ids resolved to names. Used for the DM's
// `entity show` view now, and for compact cards in prompts later.

export interface EntityCard {
  entity: typeof schema.entities.$inferSelect;
  lastKnownLocation: string | null;
  actualLocation: string | null;
  parentLocation: string | null;
  relations: {
    id: number;
    direction: "out" | "in";
    type: string;
    other: string;
    note: string;
    strength: number;
    secret: boolean;
    source: string;
  }[];
  threads: { id: number; title: string; status: string }[];
  meta: (field: string) => FieldMeta | undefined;
}

// Finds an entity by exact name or alias, then by unique partial match.
export async function findEntity(campaignId: number, query: string) {
  const all = await db.select().from(schema.entities).where(eq(schema.entities.campaignId, campaignId));
  const q = query.trim().toLowerCase();
  const exact = all.filter((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase() === q));
  if (exact.length === 1) return exact[0];
  const partial = all.filter((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0];
  const candidates = (exact.length ? exact : partial).map((e) => e.name);
  throw new Error(
    candidates.length ? `"${query}" matches several: ${candidates.join(", ")}` : `No entity called "${query}" in this campaign`,
  );
}

export async function loadEntityCard(entityId: number): Promise<EntityCard> {
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId));
  if (!entity) throw new Error(`No entity with id ${entityId}`);

  const locIds = [entity.lastKnownLocationId, entity.actualLocationId, entity.parentId].filter((x): x is number => x != null);
  const locs = locIds.length
    ? await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(inArray(schema.entities.id, locIds))
    : [];
  const locName = (id: number | null) => (id == null ? null : (locs.find((l) => l.id === id)?.name ?? null));

  const rels = await db
    .select()
    .from(schema.entityRelations)
    .where(or(eq(schema.entityRelations.fromEntityId, entityId), eq(schema.entityRelations.toEntityId, entityId)));
  const otherIds = [...new Set(rels.map((r) => (r.fromEntityId === entityId ? r.toEntityId : r.fromEntityId)))];
  const others = otherIds.length
    ? await db.select({ id: schema.entities.id, name: schema.entities.name }).from(schema.entities).where(inArray(schema.entities.id, otherIds))
    : [];

  const threads = await db
    .select({ id: schema.threads.id, title: schema.threads.title, status: schema.threads.status })
    .from(schema.threadEntities)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadEntities.threadId))
    .where(and(eq(schema.threadEntities.entityId, entityId), sql`${schema.threads.status} != 'resolved'`));

  return {
    entity,
    lastKnownLocation: locName(entity.lastKnownLocationId),
    actualLocation: locName(entity.actualLocationId),
    parentLocation: locName(entity.parentId),
    relations: rels.map((r) => {
      const out = r.fromEntityId === entityId;
      const otherId = out ? r.toEntityId : r.fromEntityId;
      return {
        id: r.id,
        direction: out ? ("out" as const) : ("in" as const),
        type: r.type,
        other: others.find((o) => o.id === otherId)?.name ?? `#${otherId}`,
        note: r.note,
        strength: r.strength,
        secret: r.secret,
        source: r.source,
      };
    }),
    threads,
    meta: (field) => entity.fieldMeta[field],
  };
}
