import { z } from "zod";
import { USER_ID, getMemory, id, likePattern, now, queueIndexJob } from "../db.ts";
import { failure, success } from "../http.ts";
import { iso, memoryCreate, memoryPatch } from "../schemas.ts";
import { memoryJson } from "../serializers.ts";
import { type MemoryRow } from "../types.ts";
import type { Db } from "../types.ts";
import type { RouteContext } from "./context.ts";

/**
 * Loads ranked Algolia hits back out of SQLite in the order Algolia returned
 * them. Occurrence bounds are not facetable on the index, so they are applied
 * here; a hit whose row is already gone is dropped rather than returned empty.
 */
function hydrateRanked(
  db: Db,
  objectIds: string[],
  occurrence: {
    occurredFromClause: string;
    occurredToClause: string;
    occurred_from?: string;
    occurred_to?: string;
  },
): MemoryRow[] {
  const placeholders = objectIds.map((_, index) => `@id${index}`).join(",");
  const rows = db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=@user_id AND m.id IN (${placeholders})
      ${occurrence.occurredFromClause} ${occurrence.occurredToClause}
  `).all({
    user_id: USER_ID,
    ...Object.fromEntries(objectIds.map((objectId, index) => [`id${index}`, objectId])),
    ...(occurrence.occurred_from ? { occurred_from: occurrence.occurred_from } : {}),
    ...(occurrence.occurred_to ? { occurred_to: occurrence.occurred_to } : {}),
  }) as MemoryRow[];
  const byId = new Map(rows.map(row => [row.id, row]));
  return objectIds
    .map(objectId => byId.get(objectId))
    .filter((row): row is MemoryRow => row !== undefined);
}

export function registerMemoryRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/memories", async (req, res) => {
    const query = z.object({
      kind: z.enum(["fact", "note", "journal"]).optional(),
      query: z.string().max(300).optional(),
      category_id: z.string().max(100).optional(),
      life_area_id: z.string().max(100).optional(),
      review_worthy: z.enum(["true", "false"]).optional(),
      occurred_from: iso.optional(),
      occurred_to: iso.optional(),
      mood_label: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).parse(req.query);
    const kindClause = query.kind ? "AND m.kind=@kind" : "";
    const categoryClause = query.category_id ? "AND m.category_id=@category_id" : "";
    const lifeAreaClause = query.life_area_id ? "AND m.life_area_id=@life_area_id" : "";
    const reviewClause = query.review_worthy ? "AND m.review_worthy=@review_worthy" : "";
    const occurredFromClause = query.occurred_from ? "AND COALESCE(m.occurred_at,m.created_at)>=@occurred_from" : "";
    const occurredToClause = query.occurred_to ? "AND COALESCE(m.occurred_at,m.created_at)<@occurred_to" : "";
    const moodClause = query.mood_label ? "AND m.mood_label=@mood_label" : "";
    const searchClause = query.query
      ? "AND (m.title LIKE @query ESCAPE '\\' OR m.content LIKE @query ESCAPE '\\'"
        + " OR m.mood_label LIKE @query ESCAPE '\\' OR m.tags_json LIKE @query ESCAPE '\\')"
      : "";
    const filters = {
      user_id: USER_ID,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.category_id ? { category_id: query.category_id } : {}),
      ...(query.life_area_id ? { life_area_id: query.life_area_id } : {}),
      ...(query.review_worthy ? { review_worthy: query.review_worthy === "true" ? 1 : 0 } : {}),
      ...(query.occurred_from ? { occurred_from: query.occurred_from } : {}),
      ...(query.occurred_to ? { occurred_to: query.occurred_to } : {}),
      ...(query.mood_label ? { mood_label: query.mood_label } : {}),
      limit: query.limit,
    };

    // Algolia ranks, SQLite still supplies the rows: the response stays
    // authoritative and keeps one serializer, and the facet filters below are
    // all attributesForFaceting on the memory index.
    if (query.query && search.searchMemories) {
      try {
        const ranked = await search.searchMemories(query.query, {
          limit: query.limit,
          kind: query.kind,
          category_id: query.category_id,
          life_area_id: query.life_area_id,
          mood_label: query.mood_label,
          review_worthy: query.review_worthy === undefined ? undefined : query.review_worthy === "true",
        });
        const hydrated = ranked.length ? hydrateRanked(db, ranked, {
          occurredFromClause,
          occurredToClause,
          occurred_from: query.occurred_from,
          occurred_to: query.occurred_to,
        }) : [];
        return success(res, { source: "algolia" as const, memories: hydrated.map(memoryJson) });
      } catch {
        // SQLite remains authoritative and provides a bounded lexical fallback.
      }
    }

    const rows = db.prepare(`
      SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM memories m LEFT JOIN categories c ON c.id=m.category_id
      LEFT JOIN life_areas la ON la.id=m.life_area_id
      WHERE m.user_id=@user_id ${kindClause} ${categoryClause} ${lifeAreaClause} ${reviewClause}
        ${occurredFromClause} ${occurredToClause} ${moodClause} ${searchClause}
      ORDER BY m.created_at DESC LIMIT @limit
    `).all({
      ...filters,
      ...(query.query ? { query: likePattern(query.query) } : {}),
    }) as MemoryRow[];
    return success(res, { source: "sqlite" as const, memories: rows.map(memoryJson) });
  });
  app.get("/api/memories/:id", (req, res) => {
    const memory = getMemory(db, req.params.id);
    return memory ? success(res, memoryJson(memory)) : failure(res, 404, "Memory not found");
  });
  app.post("/api/memories", (req, res) => {
    const body = memoryCreate.parse(req.body);
    const memoryId = id("memory");
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO memories(
          id,user_id,title,content,kind,mood_label,mood_score,category_id,life_area_id,life_area_source,
          occurred_at,review_worthy,tags_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(memoryId, USER_ID, body.title ?? null, body.content, body.kind, body.mood_label ?? null,
        body.mood_score ?? null, body.category_id ?? null, body.life_area_id ?? null,
        body.life_area_source ?? null, body.occurred_at ?? null, body.review_worthy ? 1 : 0,
        JSON.stringify(body.tags), timestamp, timestamp);
      queueIndexJob(db, "memory", memoryId);
    })();
    search.flushSoon();
    return success(res, memoryJson(getMemory(db, memoryId) as MemoryRow), 201);
  });
  app.patch("/api/memories/:id", (req, res) => {
    const body = memoryPatch.parse(req.body);
    const current = getMemory(db, req.params.id);
    if (!current) return failure(res, 404, "Memory not found");
    db.transaction(() => {
      db.prepare(`
        UPDATE memories SET title=?,content=?,kind=?,mood_label=?,mood_score=?,category_id=?,
          life_area_id=?,life_area_source=?,occurred_at=?,review_worthy=?,tags_json=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(body.title === undefined ? current.title : body.title, body.content ?? current.content,
        body.kind ?? current.kind, body.mood_label === undefined ? current.mood_label : body.mood_label,
        body.mood_score === undefined ? current.mood_score : body.mood_score,
        body.category_id === undefined ? current.category_id : body.category_id,
        body.life_area_id === undefined ? current.life_area_id : body.life_area_id,
        body.life_area_source === undefined ? current.life_area_source : body.life_area_source,
        body.occurred_at === undefined ? current.occurred_at : body.occurred_at,
        body.review_worthy === undefined ? current.review_worthy : body.review_worthy ? 1 : 0,
        body.tags === undefined ? current.tags_json : JSON.stringify(body.tags), now(), current.id, USER_ID);
      queueIndexJob(db, "memory", current.id);
    })();
    search.flushSoon();
    return success(res, memoryJson(getMemory(db, current.id) as MemoryRow));
  });
  app.delete("/api/memories/:id", (req, res) => {
    if (!getMemory(db, req.params.id)) return failure(res, 404, "Memory not found");
    db.transaction(() => {
      db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(req.params.id, USER_ID);
      queueIndexJob(db, "memory", req.params.id, "delete");
    })();
    search.flushSoon();
    return success(res, { id: req.params.id });
  });
}
