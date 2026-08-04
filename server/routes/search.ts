import { z } from "zod";
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from "../algolia.ts";
import { USER_ID, likePattern } from "../db.ts";
import { success } from "../http.ts";
import type { RouteContext } from "./context.ts";

/** One result row, shaped the same whether Algolia or SQLite produced it. */
interface SearchHit {
  type: SearchEntityType;
  objectID: string;
  title: string | null;
  snippet: string | null;
  status?: string | null;
  priority?: string | null;
  due_at?: string | null;
  kind?: string | null;
  mood_label?: string | null;
  mood_score?: number | null;
  tags?: string[];
  category_name?: string | null;
  life_area_name?: string | null;
  threadId?: string | null;
  channel?: string | null;
  role?: string | null;
  occurred_at?: string | null;
  created_at?: string | null;
}

const SNIPPET_LENGTH = 180;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed || null;
};

const snippet = (value: unknown): string | null => {
  const collapsed = text(value);
  if (!collapsed) return null;
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH)}…` : collapsed;
};

const tagList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Both sources feed the same mapper, so a SQLite fallback result is
 * indistinguishable from an Algolia one to the UI.
 */
function toHit(type: SearchEntityType, record: Record<string, unknown>): SearchHit {
  const base = { type, objectID: String(record.objectID) };
  if (type === "todo") {
    return {
      ...base,
      title: text(record.title) ?? "Untitled task",
      snippet: snippet(record.notes),
      status: text(record.status),
      priority: text(record.priority),
      due_at: text(record.due_at),
      category_name: text(record.category_name),
      life_area_name: text(record.life_area_name),
    };
  }
  if (type === "memory") {
    return {
      ...base,
      // A memory title is optional, so fall back to its opening words.
      title: text(record.title) ?? snippet(record.content) ?? "Saved memory",
      snippet: snippet(record.content),
      kind: text(record.kind),
      mood_label: text(record.mood_label),
      mood_score: typeof record.mood_score === "number" ? record.mood_score : null,
      tags: tagList(record.tags),
      category_name: text(record.category_name),
      life_area_name: text(record.life_area_name),
      occurred_at: text(record.occurred_at),
    };
  }
  return {
    ...base,
    title: null,
    snippet: snippet(record.content),
    threadId: text(record.threadId),
    channel: record.channel === "sms" ? "sms" : "web",
    role: record.role === "assistant" ? "assistant" : "user",
    created_at: text(record.created_at),
  };
}

export function registerSearchRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/search", async (req, res) => {
    const input = z.object({
      q: z.string().trim().min(1).max(500),
      types: z.preprocess(
        value => typeof value === "string"
          ? value.split(",").map(entry => entry.trim()).filter(Boolean)
          : value,
        z.array(z.enum(["todo", "memory", "message"])).nonempty().optional(),
      ),
      limit: z.coerce.number().int().min(1).max(50).default(8),
    }).parse(req.query);
    const types: SearchEntityType[] = input.types ?? SEARCH_ENTITY_TYPES;

    if (search.searchAll) {
      try {
        const { counts, hits } = await search.searchAll(input.q, { types, limit: input.limit });
        return success(res, {
          source: "algolia" as const,
          counts,
          hits: types.flatMap(type => hits[type].map(record => toHit(type, record))),
        });
      } catch {
        // SQLite remains authoritative and provides a bounded lexical fallback.
      }
    }

    const pattern = likePattern(input.q);
    const fallback: Record<SearchEntityType, Array<Record<string, unknown>>> = {
      todo: [], memory: [], message: [],
    };
    if (types.includes("todo")) {
      fallback.todo = db.prepare(`
        SELECT t.id objectID,t.title,t.notes,t.status,t.priority,t.due_at,
          c.name category_name,la.name life_area_name
        FROM todos t LEFT JOIN categories c ON c.id=t.category_id
        LEFT JOIN life_areas la ON la.id=t.life_area_id
        WHERE t.user_id=? AND (lower(t.title) LIKE lower(?) ESCAPE '\\'
          OR lower(COALESCE(t.notes,'')) LIKE lower(?) ESCAPE '\\')
        ORDER BY t.updated_at DESC,t.rowid DESC LIMIT ?
      `).all(USER_ID, pattern, pattern, input.limit) as Array<Record<string, unknown>>;
    }
    if (types.includes("memory")) {
      fallback.memory = db.prepare(`
        SELECT m.id objectID,m.title,m.content,m.kind,m.mood_label,m.mood_score,
          m.tags_json tags,m.occurred_at,c.name category_name,la.name life_area_name
        FROM memories m LEFT JOIN categories c ON c.id=m.category_id
        LEFT JOIN life_areas la ON la.id=m.life_area_id
        WHERE m.user_id=? AND (lower(COALESCE(m.title,'')) LIKE lower(?) ESCAPE '\\'
          OR lower(m.content) LIKE lower(?) ESCAPE '\\'
          OR lower(COALESCE(m.mood_label,'')) LIKE lower(?) ESCAPE '\\'
          OR lower(m.tags_json) LIKE lower(?) ESCAPE '\\')
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?
      `).all(USER_ID, pattern, pattern, pattern, pattern, input.limit) as Array<Record<string, unknown>>;
    }
    if (types.includes("message")) {
      fallback.message = db.prepare(`
        SELECT m.id objectID,m.thread_id threadId,t.channel,m.role,m.content,m.created_at
        FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
        WHERE t.user_id=? AND m.role IN ('user','assistant')
          AND lower(m.content) LIKE lower(?) ESCAPE '\\'
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?
      `).all(USER_ID, pattern, input.limit) as Array<Record<string, unknown>>;
    }
    return success(res, {
      source: "sqlite" as const,
      // The fallback is bounded by `limit`, so these are the counts it can
      // honestly report rather than totals across the whole table.
      counts: {
        todo: fallback.todo.length,
        memory: fallback.memory.length,
        message: fallback.message.length,
      },
      hits: types.flatMap(type => fallback[type].map(record => toHit(type, record))),
    });
  });
}
