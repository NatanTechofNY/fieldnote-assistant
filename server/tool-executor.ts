import type { AlgoliaSync } from "./algolia.ts";
import {
  getConfluencePage, getJiraIssue, listConfluenceComments, listConfluencePages,
  listConfluenceSpaces, listJiraBoards, listJiraIssues, listJiraUsers,
} from "./atlassian-service.ts";
import {
  getMemory, getReminders, getTodo, id, instant, now, queueIndexJob, syncTodoReminders, USER_ID,
} from "./db.ts";
import { fiscalQuarterRange, type FiscalQuarter } from "./fiscal-quarter.ts";
import { reflectionPeriod, reflectionScopeKey, type ReflectionPeriod, type ReflectionPreset } from "./reflection-period.ts";
import { toolInput, type ToolName } from "./schemas.ts";
import { completeParentIfSettled } from "./todo-status.ts";
import type { Db, MemoryRow, TodoRow, TodoStatus } from "./types.ts";

type SearchWriter = Pick<AlgoliaSync, "flushSoon">;
type Input = Record<string, unknown>;

const todoJson = (row: TodoRow) => ({
  id: row.id, title: row.title, notes: row.notes, category_id: row.category_id,
  category_name: row.category_name ?? null, life_area_id: row.life_area_id,
  life_area_name: row.life_area_name ?? null, life_area_slug: row.life_area_slug ?? null,
  life_area_source: row.life_area_source, parent_id: row.parent_id, due_at: row.due_at,
  reminder_at: row.reminder_at, extra_reminders: JSON.parse(row.extra_reminders_json),
  priority: row.priority, status: row.status, started_at: row.started_at,
  completed_at: row.completed_at, created_at: row.created_at, updated_at: row.updated_at,
});

const memoryJson = (row: MemoryRow) => ({
  id: row.id, title: row.title, content: row.content, kind: row.kind,
  mood_label: row.mood_label, mood_score: row.mood_score, category_id: row.category_id,
  category_name: row.category_name ?? null, life_area_id: row.life_area_id,
  life_area_name: row.life_area_name ?? null, life_area_slug: row.life_area_slug ?? null,
  life_area_source: row.life_area_source, occurred_at: row.occurred_at,
  review_worthy: Boolean(row.review_worthy), tags: JSON.parse(row.tags_json),
  created_at: row.created_at, updated_at: row.updated_at,
});

export function getReviewEvidence(
  db: Db,
  year: number,
  quarter: FiscalQuarter,
  timezone: string,
) {
  const range = fiscalQuarterRange(year, quarter, timezone);
  const memoryCandidates = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=?
      AND COALESCE(m.occurred_at,m.created_at)>=? AND COALESCE(m.occurred_at,m.created_at)<?
    ORDER BY COALESCE(m.occurred_at,m.created_at) DESC
  `).all(USER_ID, range.start, range.endExclusive) as MemoryRow[])
    .filter((memory) => !(JSON.parse(memory.tags_json) as string[]).includes("performance-review"));
  const todoCandidates = db.prepare(`
    SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM todos t LEFT JOIN categories c ON c.id=t.category_id
    LEFT JOIN life_areas la ON la.id=t.life_area_id
    WHERE t.user_id=? AND t.status='done'
      AND t.completed_at>=? AND t.completed_at<?
    ORDER BY t.completed_at DESC
  `).all(USER_ID, range.start, range.endExclusive) as TodoRow[];
  const memories = memoryCandidates.filter(memory => memory.life_area_id === "area_work");
  const todos = todoCandidates.filter(todo => todo.life_area_id === "area_work");
  const drafts = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=? AND m.life_area_id='area_work' ORDER BY m.updated_at DESC
  `).all(USER_ID) as MemoryRow[]).filter((memory) => {
    const tags = JSON.parse(memory.tags_json) as string[];
    return tags.includes("performance-review") && tags.includes(range.key);
  });
  return {
    range,
    memories: memories.map(memoryJson),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.map(memoryJson),
    todo_candidates: todoCandidates.map(todoJson),
    draft: drafts[0] ? memoryJson(drafts[0]) : null,
  };
}

export function getReflectionEvidence(
  db: Db,
  period: ReflectionPeriod,
  filters: {
    lifeAreaIds?: string[];
    categoryIds?: string[];
    sources?: Array<"memories" | "todos">;
  } = {},
) {
  const lifeAreaIds = [...new Set(filters.lifeAreaIds || [])];
  const categoryIds = [...new Set(filters.categoryIds || [])];
  const sources = [...new Set(filters.sources?.length ? filters.sources : ["memories", "todos"])] as Array<"memories" | "todos">;
  const memoryCandidates = sources.includes("memories")
    ? (db.prepare(`
      SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM memories m LEFT JOIN categories c ON c.id=m.category_id
      LEFT JOIN life_areas la ON la.id=m.life_area_id
      WHERE m.user_id=? AND COALESCE(m.occurred_at,m.created_at)>=? AND COALESCE(m.occurred_at,m.created_at)<?
      ORDER BY COALESCE(m.occurred_at,m.created_at) DESC
    `).all(USER_ID, period.start, period.endExclusive) as MemoryRow[]).filter(memory => {
      const tags = JSON.parse(memory.tags_json) as string[];
      return !tags.includes("performance-review") && !tags.includes("reflection-draft");
    })
    : [];
  const todoCandidates = sources.includes("todos")
    ? db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? AND t.status='done' AND t.completed_at>=? AND t.completed_at<?
      ORDER BY t.completed_at DESC
    `).all(USER_ID, period.start, period.endExclusive) as TodoRow[]
    : [];
  const scopeKey = reflectionScopeKey(period, { lifeAreaIds, categoryIds, sources });
  const selections = db.prepare(`
    SELECT entity_type,entity_id FROM reflection_selections
    WHERE user_id=? AND scope_key=?
  `).all(USER_ID, scopeKey) as Array<{ entity_type: "memory" | "todo"; entity_id: string }>;
  const selected = new Set(selections.map(item => `${item.entity_type}:${item.entity_id}`));
  const inScope = (row: MemoryRow | TodoRow) =>
    (!lifeAreaIds.length || Boolean(row.life_area_id && lifeAreaIds.includes(row.life_area_id)))
    && (!categoryIds.length || Boolean(row.category_id && categoryIds.includes(row.category_id)));
  const memories = memoryCandidates.filter(memory => inScope(memory) && selected.has(`memory:${memory.id}`));
  const todos = todoCandidates.filter(todo => inScope(todo) && selected.has(`todo:${todo.id}`));
  const draft = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=? ORDER BY m.updated_at DESC
  `).all(USER_ID) as MemoryRow[]).find(memory => {
    const tags = JSON.parse(memory.tags_json) as string[];
    return tags.includes("reflection-draft") && tags.includes(scopeKey);
  });
  return {
    range: period,
    scope_key: scopeKey,
    scope: {
      life_area_ids: lifeAreaIds,
      category_ids: categoryIds,
      sources,
    },
    memories: memories.map(memoryJson),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.filter(inScope).map(memoryJson),
    todo_candidates: todoCandidates.filter(inScope).map(todoJson),
    selected: selections.map(item => ({ type: item.entity_type, id: item.entity_id })),
    draft: draft ? memoryJson(draft) : null,
  };
}

/**
 * How many candidate rows the agent payload carries per source. A day or a week
 * fits well inside this; a month of journaling would otherwise crowd out the
 * turn, so `candidate_totals` reports the true count and a truncated list can
 * still be described honestly.
 */
const AGENT_CANDIDATE_LIMIT = 25;

/**
 * Evidence as the agent sees it. `memories` and `todos` stay the curated set a
 * saved draft may quote, but the candidate lists have to survive into the
 * payload: they are the difference between "nothing was selected" and "nothing
 * happened", and an end-of-day check-in that cannot tell those apart reports an
 * empty day to someone who just closed something out.
 */
function agentEvidence<T extends {
  memory_candidates: unknown[];
  todo_candidates: unknown[];
}>(evidence: T) {
  const { memory_candidates: memories, todo_candidates: todos, ...rest } = evidence;
  return {
    ...rest,
    memory_candidates: memories.slice(0, AGENT_CANDIDATE_LIMIT),
    todo_candidates: todos.slice(0, AGENT_CANDIDATE_LIMIT),
    candidate_totals: { memories: memories.length, todos: todos.length },
  };
}

export async function executeAgentTool(
  db: Db,
  search: SearchWriter,
  name: string,
  input: Input,
): Promise<unknown> {
  // Tool arguments come from a model, so they get the same Zod validation as
  // the REST API instead of ad-hoc presence checks. A ZodError here surfaces
  // as a 400 through the shared error handler.
  const schema = toolInput[name as ToolName];
  if (schema) input = schema.parse(input) as Input;

  if (name === "get_todo") {
    const todo = getTodo(db, input.id as string);
    if (!todo) throw new Error("Todo not found");
    return {
      todo: todoJson(todo),
      subtasks: (db.prepare(`
        SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
        FROM todos t LEFT JOIN categories c ON c.id=t.category_id
        LEFT JOIN life_areas la ON la.id=t.life_area_id
        WHERE t.user_id=? AND t.parent_id=? ORDER BY t.created_at
      `).all(USER_ID, todo.id) as TodoRow[]).map(todoJson),
      reminders: getReminders(db, todo.id),
    };
  }
  if (name === "list_life_areas") {
    return db.prepare(`
      SELECT id,slug,name,color FROM life_areas WHERE user_id=? ORDER BY
        CASE slug WHEN 'work' THEN 0 WHEN 'personal' THEN 1 WHEN 'side-project' THEN 2 ELSE 3 END,name
    `).all(USER_ID);
  }
  if (name === "get_conversation_context") {
    const threadId = input.thread_id as string;
    const thread = db.prepare(
      "SELECT id,channel FROM channel_threads WHERE id=? AND user_id=?",
    ).get(threadId, USER_ID) as { id: string; channel: "web" | "sms" } | undefined;
    if (!thread) throw new Error("Conversation not found");
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 40);
    const rows = db.prepare(`
      SELECT id,role,content,created_at FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant')
      ORDER BY created_at,rowid
    `).all(threadId) as Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      created_at: string;
    }>;
    const messageId = typeof input.message_id === "string" ? input.message_id : null;
    const anchorIndex = messageId ? rows.findIndex(row => row.id === messageId) : rows.length - 1;
    if (messageId && anchorIndex < 0) throw new Error("Conversation message not found");
    const center = Math.max(anchorIndex, 0);
    const start = Math.min(
      Math.max(0, center - Math.floor((limit - 1) / 2)),
      Math.max(0, rows.length - limit),
    );
    const messages = rows.slice(start, Math.min(rows.length, start + limit));
    return { thread_id: thread.id, channel: thread.channel, messages };
  }
  if (name === "list_todos") {
    let rows = db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? ORDER BY t.created_at DESC
    `).all(USER_ID) as TodoRow[];
    for (const key of ["status", "priority", "category_id", "life_area_id", "parent_id"] as const) {
      if (input[key] != null) rows = rows.filter(row => row[key] === input[key]);
    }
    if (input.due_from) rows = rows.filter(row => Boolean(row.due_at && row.due_at >= String(input.due_from)));
    if (input.due_to) rows = rows.filter(row => Boolean(row.due_at && row.due_at <= String(input.due_to)));
    return rows.slice(0, Number(input.limit) || 50).map(todoJson);
  }
  if (name === "create_todo") {
    const timestamp = now();
    const todoId = id("todo");
    db.transaction(() => {
      db.prepare(`
        INSERT INTO todos(
          id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
          priority,status,started_at,completed_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        todoId, USER_ID, input.title as string, input.notes ?? null,
        input.category_id ?? null, input.life_area_id ?? null,
        input.life_area_id ? "agent" : null, input.parent_id ?? null, input.due_at ?? null,
        input.reminder_at ?? null, JSON.stringify(input.extra_reminders ?? []),
        input.priority ?? null, "pending", null, null, timestamp, timestamp,
      );
      const created = getTodo(db, todoId);
      if (created) syncTodoReminders(db, created);
      for (const raw of Array.isArray(input.subtasks) ? input.subtasks : []) {
        const subtask = raw as Input;
        const childId = id("todo");
        db.prepare(`
          INSERT INTO todos(
            id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
            priority,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,NULL,'[]',?,'pending',?,?)
        `).run(
          childId, USER_ID, subtask.title as string, subtask.notes ?? null,
          input.category_id ?? null, input.life_area_id ?? null,
          input.life_area_id ? "agent" : null, todoId, subtask.due_at ?? null,
          subtask.priority ?? null, timestamp, timestamp,
        );
        queueIndexJob(db, "todo", childId);
      }
      queueIndexJob(db, "todo", todoId);
    })();
    search.flushSoon();
    return todoJson(getTodo(db, todoId) as TodoRow);
  }
  if (name === "update_todo") {
    const todoId = input.id as string;
    const current = getTodo(db, todoId);
    if (!current) throw new Error("Todo not found");
    const patch = (input.patch || {}) as Input;
    const clear = new Set(Array.isArray(patch.clear_fields) ? patch.clear_fields.map(String) : []);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "extra_reminders" ? [] : null) : patch[key] ?? currentValue;
    if (current.life_area_source === "user"
      && patch.life_area_id !== undefined
      && patch.life_area_id !== current.life_area_id
      && input.override_user_classification !== true) {
      throw new Error("Life area is user-classified; explicit override confirmation is required");
    }
    const lifeAreaId = value("life_area_id", current.life_area_id);
    const lifeAreaSource = lifeAreaId === current.life_area_id
      ? current.life_area_source
      : lifeAreaId ? "agent" : null;
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE todos SET title=?,notes=?,category_id=?,life_area_id=?,life_area_source=?,parent_id=?,due_at=?,reminder_at=?,
          extra_reminders_json=?,priority=?,updated_at=? WHERE id=? AND user_id=?
      `).run(
        value("title", current.title), value("notes", current.notes),
        value("category_id", current.category_id), lifeAreaId, lifeAreaSource,
        value("parent_id", current.parent_id),
        value("due_at", current.due_at), value("reminder_at", current.reminder_at),
        JSON.stringify(value("extra_reminders", JSON.parse(current.extra_reminders_json))),
        value("priority", current.priority), now(), current.id, USER_ID,
      );
      const row = getTodo(db, todoId) as TodoRow;
      syncTodoReminders(db, row);
      queueIndexJob(db, "todo", todoId);
      return row;
    })();
    search.flushSoon();
    return todoJson(updated);
  }
  if (name === "set_todo_status") {
    const todoId = input.id as string;
    const status = input.status as TodoStatus;
    const current = getTodo(db, todoId);
    if (!current) throw new Error("Todo not found");
    const timestamp = now();
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE todos SET status=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND user_id=?
      `).run(
        status,
        status === "in_progress" ? current.started_at ?? timestamp : current.started_at,
        status === "done" ? current.completed_at ?? timestamp : null,
        timestamp, todoId, USER_ID,
      );
      const row = getTodo(db, todoId) as TodoRow;
      syncTodoReminders(db, row);
      completeParentIfSettled(db, row);
      queueIndexJob(db, "todo", todoId);
      return row;
    })();
    search.flushSoon();
    return todoJson(updated);
  }
  if (name === "delete_todo") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const todoId = input.id as string;
    if (!getTodo(db, todoId)) throw new Error("Todo not found");
    db.transaction(() => {
      db.prepare("DELETE FROM todos WHERE id=? AND user_id=?").run(todoId, USER_ID);
      queueIndexJob(db, "todo", todoId, "delete");
    })();
    search.flushSoon();
    return { id: todoId };
  }
  if (name === "get_memory") {
    const memory = getMemory(db, input.id as string);
    if (!memory) throw new Error("Memory not found");
    return memoryJson(memory);
  }
  if (name === "create_memory") {
    const timestamp = now();
    const memoryId = id("memory");
    db.prepare(`
      INSERT INTO memories(
        id,user_id,title,content,kind,mood_label,mood_score,category_id,life_area_id,life_area_source,
        occurred_at,review_worthy,tags_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      memoryId, USER_ID, input.title ?? null, input.content as string, input.kind || "note",
      input.mood_label ?? null, input.mood_score ?? null, input.category_id ?? null,
      input.life_area_id ?? null, input.life_area_id ? "agent" : null,
      input.occurred_at ?? null, input.review_worthy === true ? 1 : 0,
      JSON.stringify(input.tags ?? []), timestamp, timestamp,
    );
    queueIndexJob(db, "memory", memoryId);
    search.flushSoon();
    return memoryJson(getMemory(db, memoryId) as MemoryRow);
  }
  if (name === "update_memory") {
    const memoryId = input.id as string;
    const current = getMemory(db, memoryId);
    if (!current) throw new Error("Memory not found");
    const patch = (input.patch || {}) as Input;
    const clear = new Set(Array.isArray(patch.clear_fields) ? patch.clear_fields.map(String) : []);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "tags" ? [] : null) : patch[key] ?? currentValue;
    if (current.life_area_source === "user"
      && patch.life_area_id !== undefined
      && patch.life_area_id !== current.life_area_id
      && input.override_user_classification !== true) {
      throw new Error("Life area is user-classified; explicit override confirmation is required");
    }
    const lifeAreaId = value("life_area_id", current.life_area_id);
    const lifeAreaSource = lifeAreaId === current.life_area_id
      ? current.life_area_source
      : lifeAreaId ? "agent" : null;
    db.transaction(() => {
      db.prepare(`
        UPDATE memories SET kind=?,title=?,content=?,mood_label=?,mood_score=?,category_id=?,
          life_area_id=?,life_area_source=?,occurred_at=?,review_worthy=?,tags_json=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(
        value("kind", current.kind), value("title", current.title), value("content", current.content),
        value("mood_label", current.mood_label), value("mood_score", current.mood_score),
        value("category_id", current.category_id), lifeAreaId, lifeAreaSource,
        value("occurred_at", current.occurred_at),
        value("review_worthy", Boolean(current.review_worthy)) ? 1 : 0,
        JSON.stringify(value("tags", JSON.parse(current.tags_json))), now(), memoryId, USER_ID,
      );
      queueIndexJob(db, "memory", memoryId);
    })();
    search.flushSoon();
    return memoryJson(getMemory(db, memoryId) as MemoryRow);
  }
  if (name === "delete_memory") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const memoryId = input.id as string;
    if (!getMemory(db, memoryId)) throw new Error("Memory not found");
    db.transaction(() => {
      db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(memoryId, USER_ID);
      queueIndexJob(db, "memory", memoryId, "delete");
    })();
    search.flushSoon();
    return { id: memoryId };
  }
  if (name === "get_agenda") {
    const start = input.start_date as string;
    const end = input.end_date as string;
    const todos = (db.prepare(`
      SELECT t.*,c.name category_name FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=? AND t.due_at IS NOT NULL ORDER BY t.due_at
    `).all(USER_ID) as TodoRow[]).filter(todo => {
      const date = todo.due_at?.slice(0, 10) || "";
      return date >= start && date <= end;
    });
    const reminders = getReminders(db).filter(reminder => {
      const date = reminder.scheduled_for.slice(0, 10);
      return date >= start && date <= end;
    });
    return { todos: todos.map(todoJson), reminders };
  }
  if (name === "get_review_evidence") {
    const year = input.year as number;
    const quarter = input.quarter as FiscalQuarter;
    const timezone = input.timezone as string;
    return agentEvidence(getReviewEvidence(db, year, quarter, timezone));
  }
  if (name === "get_reflection_evidence") {
    const preset = input.preset as ReflectionPreset;
    const timezone = input.timezone as string;
    const strings = (key: string) => Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : [];
    const period = reflectionPeriod(preset, timezone, {
      startDate: typeof input.start_date === "string" ? input.start_date : undefined,
      endDate: typeof input.end_date === "string" ? input.end_date : undefined,
    });
    return agentEvidence(getReflectionEvidence(db, period, {
      lifeAreaIds: strings("life_area_ids"),
      categoryIds: strings("category_ids"),
      sources: strings("sources") as Array<"memories" | "todos">,
    }));
  }
  if (name === "create_reminder") {
    const todo = getTodo(db, input.todo_id as string);
    if (!todo) throw new Error("Todo not found");
    const reminderAt = input.reminder_at as string;
    const extras = JSON.parse(todo.extra_reminders_json) as string[];
    db.transaction(() => {
      if (input.slot === "extra") {
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set([...extras, reminderAt])]), now(), todo.id, USER_ID);
      } else {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return getReminders(db, todo.id).find(reminder => instant(reminder.scheduled_for) === instant(reminderAt));
  }
  if (name === "list_reminders") {
    const from = instant(input.from as string);
    const to = instant(input.to as string);
    return getReminders(db)
      .filter(reminder => instant(reminder.scheduled_for) >= from && instant(reminder.scheduled_for) <= to)
      .slice(0, Number(input.limit) || 50);
  }
  if (name === "update_reminder") {
    const reminderId = input.id as string;
    const reminderAt = input.reminder_at as string;
    const reminder = getReminders(db).find(row => row.id === reminderId);
    if (!reminder) throw new Error("Reminder not found");
    const todo = getTodo(db, reminder.todo_id);
    if (!todo) throw new Error("Todo not found");
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .map(value => instant(value) === instant(reminder.scheduled_for) ? reminderAt : value);
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set(extras)]), now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return getReminders(db, todo.id).find(row => instant(row.scheduled_for) === instant(reminderAt));
  }
  if (name === "delete_reminder") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const reminderId = input.id as string;
    const reminder = getReminders(db).find(row => row.id === reminderId);
    if (!reminder) throw new Error("Reminder not found");
    const todo = getTodo(db, reminder.todo_id);
    if (!todo) throw new Error("Todo not found");
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .filter(value => instant(value) !== instant(reminder.scheduled_for));
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify(extras), now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return { id: reminderId };
  }
  /*
   * Atlassian tools read a remote system rather than SQLite, so they own no
   * projection and queue no index job. Each throws "Atlassian is not configured"
   * when no credential is stored, which the agent is told to report rather than
   * work around.
   */
  if (name === "list_jira_boards") {
    return listJiraBoards(db, {
      name_filter: input.name_filter as string | null,
      project_key: input.project_key as string | null,
      include_columns: input.include_columns as boolean | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "list_jira_issues") {
    return listJiraIssues(db, {
      board_id: input.board_id as number | null,
      assignee: input.assignee as string | null,
      project_key: input.project_key as string | null,
      status_ids: input.status_ids as string[] | null,
      text: input.text as string | null,
      updated_within_days: input.updated_within_days as number | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "get_jira_issue") {
    return getJiraIssue(db, {
      key: input.key as string,
      include_recent_changes: input.include_recent_changes as boolean | null,
    });
  }
  if (name === "list_jira_users") {
    return listJiraUsers(db, { query: input.query as string, limit: input.limit as number | null });
  }
  if (name === "list_confluence_spaces") {
    return listConfluenceSpaces(db, {
      keys: input.keys as string[] | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "list_confluence_pages") {
    return listConfluencePages(db, {
      space_keys: input.space_keys as string[] | null,
      text: input.text as string | null,
      modified_within_days: input.modified_within_days as number | null,
      mine_only: input.mine_only as boolean | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "get_confluence_page") {
    return getConfluencePage(db, { id: input.id as string });
  }
  if (name === "list_confluence_comments") {
    return listConfluenceComments(db, {
      space_keys: input.space_keys as string[] | null,
      within_days: input.within_days as number | null,
      only_my_pages: input.only_my_pages as boolean | null,
      limit: input.limit as number | null,
    });
  }
  throw new Error(`Unsupported tool: ${name}`);
}
