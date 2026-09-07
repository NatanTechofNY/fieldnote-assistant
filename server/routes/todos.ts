import { z } from "zod";
import { USER_ID, getReminders, getTodo, id, now, queueIndexJob, syncTodoReminders, userTimezone } from "../db.ts";
import { failure, success } from "../http.ts";
import { planRecurrenceWrite } from "../recurrence.ts";
import { iso, status, todoCreate, todoPatch } from "../schemas.ts";
import { applyStatusTimes, completionJson, reminderJson, todoJson } from "../serializers.ts";
import { completeParentIfSettled, completionStats, syncOccurrenceCompletion } from "../todo-status.ts";
import { type TodoRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

const REPEATING_SUBTASK = "A repeating todo cannot be filed under another task";

export function registerTodoRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/todos", (req, res) => {
    const query = z.object({
      includeDone: z.enum(["true", "false"]).default("true"),
      status: status.optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      category_id: z.string().max(100).optional(),
      life_area_id: z.string().max(100).optional(),
      parent_id: z.string().max(100).optional(),
      due_from: iso.optional(),
      due_to: iso.optional(),
      recurring: z.enum(["true", "false"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).parse(req.query);
    const clauses = ["t.user_id=@user_id"];
    const params: Record<string, string | number> = { user_id: USER_ID, limit: query.limit };
    /*
     * A finished parent still holding open steps stays in the list. Only
     * top-level rows are drawn, so dropping it would take its unfinished
     * children off the board with it while they are still owed.
     */
    if (query.includeDone === "false") {
      clauses.push(`(t.status NOT IN ('done','cancelled') OR EXISTS (
        SELECT 1 FROM todos c
        WHERE c.user_id=t.user_id AND c.parent_id=t.id AND c.status NOT IN ('done','cancelled')
      ))`);
    }
    for (const key of ["status", "priority", "category_id", "life_area_id", "parent_id"] as const) {
      if (query[key]) {
        clauses.push(`t.${key}=@${key}`);
        params[key] = query[key] as string;
      }
    }
    if (query.due_from) { clauses.push("t.due_at>=@due_from"); params.due_from = query.due_from; }
    if (query.due_to) { clauses.push("t.due_at<=@due_to"); params.due_to = query.due_to; }
    if (query.recurring) clauses.push(`t.recurrence_json IS ${query.recurring === "true" ? "NOT NULL" : "NULL"}`);
    const rows = db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,t.due_at,t.created_at DESC LIMIT @limit
    `).all(params) as TodoRow[];
    return success(res, rows.map(todoJson));
  });
  app.get("/api/todos/:id", (req, res) => {
    const todo = getTodo(db, req.params.id);
    if (!todo) return failure(res, 404, "Todo not found");
    const subtasks = db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? AND t.parent_id=? ORDER BY t.created_at
    `).all(USER_ID, todo.id) as TodoRow[];
    const stats = completionStats(db, todo);
    return success(res, {
      todo: todoJson(todo),
      subtasks: subtasks.map(todoJson),
      reminders: getReminders(db, todo.id).map(reminderJson),
      ...(stats ? {
        completions: stats.completions.map(completionJson),
        completion_count: stats.completion_count,
        streak: stats.streak,
      } : {}),
    });
  });
  app.post("/api/todos", (req, res) => {
    const body = todoCreate.parse(req.body);
    const todoId = id("todo");
    const timestamp = now();
    const times = applyStatusTimes(body.status, undefined, body);
    const repeat = planRecurrenceWrite(body.recurrence, undefined, userTimezone(db));
    if (repeat.recurrence_json && body.parent_id) return failure(res, 400, REPEATING_SUBTASK);
    const schedule = repeat.derived ?? {
      due_at: body.due_at ?? null,
      reminder_at: body.reminder_at ?? null,
      extra_reminders_json: JSON.stringify(body.extra_reminders),
    };
    db.transaction(() => {
      db.prepare(`
        INSERT INTO todos(
          id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
          priority,status,started_at,completed_at,recurrence_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(todoId, USER_ID, body.title, body.notes ?? null, body.category_id ?? null,
        body.life_area_id ?? null, body.life_area_source ?? null, body.parent_id ?? null,
        schedule.due_at, schedule.reminder_at, schedule.extra_reminders_json,
        body.priority ?? null, body.status,
        times.startedAt, times.completedAt, repeat.recurrence_json, timestamp, timestamp);
      const todo = getTodo(db, todoId);
      if (todo) {
        syncTodoReminders(db, todo);
        syncOccurrenceCompletion(db, todo);
      }
      queueIndexJob(db, "todo", todoId);
      for (const subtask of body.subtasks ?? []) {
        const subtaskId = id("todo");
        db.prepare(`
          INSERT INTO todos(
            id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
            priority,status,started_at,completed_at,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,NULL,'[]',?,'pending',NULL,NULL,?,?)
        `).run(subtaskId, USER_ID, subtask.title, subtask.notes ?? null, body.category_id ?? null,
          body.life_area_id ?? null, body.life_area_source ?? null, todoId,
          subtask.due_at ?? null, subtask.priority ?? null, timestamp, timestamp);
        const child = getTodo(db, subtaskId);
        if (child) syncTodoReminders(db, child);
        queueIndexJob(db, "todo", subtaskId);
      }
    })();
    search.flushSoon();
    return success(res, todoJson(getTodo(db, todoId) as TodoRow), 201);
  });
  app.patch("/api/todos/:id", (req, res) => {
    const body = todoPatch.parse(req.body);
    const current = getTodo(db, req.params.id);
    if (!current) return failure(res, 404, "Todo not found");
    if (body.parent_id === current.id) return failure(res, 400, "A todo cannot parent itself");
    const nextStatus = body.status ?? current.status;
    const times = applyStatusTimes(nextStatus, current, body);
    const repeat = planRecurrenceWrite(body.recurrence, current, userTimezone(db));
    const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id;
    if (repeat.recurrence_json && parentId) return failure(res, 400, REPEATING_SUBTASK);
    const schedule = repeat.derived ?? {
      due_at: body.due_at === undefined ? current.due_at : body.due_at,
      reminder_at: body.reminder_at === undefined ? current.reminder_at : body.reminder_at,
      extra_reminders_json: body.extra_reminders === undefined
        ? current.extra_reminders_json
        : JSON.stringify(body.extra_reminders),
    };
    db.transaction(() => {
      db.prepare(`
        UPDATE todos SET title=?,notes=?,category_id=?,life_area_id=?,life_area_source=?,parent_id=?,due_at=?,reminder_at=?,
          extra_reminders_json=?,priority=?,status=?,started_at=?,completed_at=?,recurrence_json=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(body.title ?? current.title, body.notes === undefined ? current.notes : body.notes,
        body.category_id === undefined ? current.category_id : body.category_id,
        body.life_area_id === undefined ? current.life_area_id : body.life_area_id,
        body.life_area_source === undefined ? current.life_area_source : body.life_area_source,
        parentId, schedule.due_at, schedule.reminder_at, schedule.extra_reminders_json,
        body.priority === undefined ? current.priority : body.priority, nextStatus,
        times.startedAt, times.completedAt, repeat.recurrence_json, now(), current.id, USER_ID);
      const todo = getTodo(db, current.id);
      if (todo) {
        syncTodoReminders(db, todo);
        syncOccurrenceCompletion(db, todo);
        completeParentIfSettled(db, todo);
      }
      queueIndexJob(db, "todo", current.id);
    })();
    search.flushSoon();
    return success(res, todoJson(getTodo(db, current.id) as TodoRow));
  });
  app.patch("/api/todos/:id/status", (req, res) => {
    const body = z.object({ status }).strict().parse(req.body);
    const current = getTodo(db, req.params.id);
    if (!current) return failure(res, 404, "Todo not found");
    const times = applyStatusTimes(body.status, current, {});
    db.transaction(() => {
      db.prepare(`
        UPDATE todos SET status=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND user_id=?
      `).run(body.status, times.startedAt, times.completedAt, now(), current.id, USER_ID);
      const todo = getTodo(db, current.id);
      if (todo) {
        syncTodoReminders(db, todo);
        syncOccurrenceCompletion(db, todo);
        completeParentIfSettled(db, todo);
      }
      queueIndexJob(db, "todo", current.id);
    })();
    search.flushSoon();
    return success(res, todoJson(getTodo(db, current.id) as TodoRow));
  });
  app.delete("/api/todos/:id", (req, res) => {
    if (!getTodo(db, req.params.id)) return failure(res, 404, "Todo not found");
    db.transaction(() => {
      db.prepare("DELETE FROM todos WHERE id=? AND user_id=?").run(req.params.id, USER_ID);
      queueIndexJob(db, "todo", req.params.id, "delete");
    })();
    search.flushSoon();
    return success(res, { id: req.params.id });
  });
}
