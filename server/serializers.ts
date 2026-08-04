import { id, now, USER_ID } from "./db.ts";
import type { Db, MemoryRow, MessageRow, ReminderRow, TodoRow, TodoStatus } from "./types.ts";

export function todoJson(row: TodoRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    category_id: row.category_id,
    category_name: row.category_name ?? null,
    life_area_id: row.life_area_id,
    life_area_name: row.life_area_name ?? null,
    life_area_slug: row.life_area_slug ?? null,
    life_area_source: row.life_area_source,
    parent_id: row.parent_id,
    due_at: row.due_at,
    reminder_at: row.reminder_at,
    extra_reminders: JSON.parse(row.extra_reminders_json) as string[],
    priority: row.priority,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function memoryJson(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    kind: row.kind,
    mood_label: row.mood_label,
    mood_score: row.mood_score,
    category_id: row.category_id,
    category_name: row.category_name ?? null,
    life_area_id: row.life_area_id,
    life_area_name: row.life_area_name ?? null,
    life_area_slug: row.life_area_slug ?? null,
    life_area_source: row.life_area_source,
    occurred_at: row.occurred_at,
    review_worthy: Boolean(row.review_worthy),
    tags: JSON.parse(row.tags_json) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function reminderJson(row: ReminderRow): Record<string, unknown> {
  return {
    id: row.id,
    todo_id: row.todo_id,
    todo_title: row.todo_title,
    scheduled_for: row.scheduled_for,
    kind: row.kind,
    status: row.status,
  };
}

export function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

export function indexingForTool(
  db: Db,
  name: string,
  input: unknown,
  output: unknown,
): Record<string, unknown> | undefined {
  if (!/^(create|update|delete)_(todo|memory)$/.test(name)) return undefined;
  const entityType = name.endsWith("_memory") ? "memory" : "todo";
  const operation = name.startsWith("delete_") ? "delete" : "upsert";
  const inputRecord = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const outputRecord = output && typeof output === "object" ? output as Record<string, unknown> : {};
  const data = outputRecord.data && typeof outputRecord.data === "object"
    ? outputRecord.data as Record<string, unknown>
    : outputRecord;
  const entityId = typeof data.id === "string" ? data.id
    : typeof inputRecord.id === "string" ? inputRecord.id
      : undefined;
  if (!entityId) return undefined;
  const job = db.prepare(`
    SELECT status,last_error,updated_at FROM index_jobs
    WHERE entity_type=? AND entity_id=? AND operation=?
    ORDER BY created_at DESC LIMIT 1
  `).get(entityType, entityId, operation) as {
    status: string;
    last_error: string | null;
    updated_at: string;
  } | undefined;
  return {
    destination: "Algolia",
    entityType,
    operation,
    status: job?.status || "not_queued",
    lastError: job?.last_error || null,
    updatedAt: job?.updated_at || null,
  };
}

export function enrichChannelMetadata(db: Db, role: unknown, content: unknown, raw: unknown): Record<string, unknown> {
  const metadata = raw && typeof raw === "object" ? structuredClone(raw as Record<string, unknown>) : {};
  if (role === "tool" && typeof content === "string") {
    const indexing = indexingForTool(db, content, metadata.input, metadata.output);
    if (indexing) metadata.indexing = indexing;
  }
  if (Array.isArray(metadata.parts)) {
    metadata.parts = (metadata.parts as Array<Record<string, unknown>>).map(part => {
      if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return part;
      const indexing = indexingForTool(db, part.type.slice(5), part.input, part.output);
      return indexing ? { ...part, indexing } : part;
    });
  }
  return metadata;
}

export function messageJson(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    tool_name: row.tool_name,
    tool_args: parseJson(row.tool_args_json),
    tool_result: parseJson(row.tool_result_json),
    created_at: row.created_at,
  };
}

export function currentConversation(db: Db): string {
  const existing = db.prepare(`
    SELECT id FROM conversations WHERE user_id=? AND is_current=1
  `).get(USER_ID) as { id: string } | undefined;
  if (existing) return existing.id;
  const conversationId = id("conversation");
  const timestamp = now();
  db.prepare(`
    INSERT INTO conversations(id,user_id,title,is_current,created_at,updated_at)
    VALUES(?,?,?,1,?,?)
  `).run(conversationId, USER_ID, "Assistant", timestamp, timestamp);
  return conversationId;
}

export function applyStatusTimes(
  nextStatus: TodoStatus,
  current: TodoRow | undefined,
  input: { started_at?: string | null; completed_at?: string | null },
): { startedAt: string | null; completedAt: string | null } {
  const timestamp = now();
  const startedAt = input.started_at !== undefined
    ? input.started_at
    : nextStatus === "in_progress"
      ? (current?.started_at ?? timestamp)
      : (current?.started_at ?? null);
  const completedAt = input.completed_at !== undefined
    ? input.completed_at
    : nextStatus === "done"
      ? (current?.completed_at ?? timestamp)
      : null;
  return { startedAt, completedAt };
}
