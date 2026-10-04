import { z } from "zod";
import { OWN_AREA_CLAUSE, USER_ID, getRecentCompletions, getReminders, getTodo, id, now, queueIndexJob, syncTodoReminders, userTimezone } from "../db.ts";
import { failure, success } from "../http.ts";
import {
  DERIVED_SCHEDULE, REPEATING_SUBTASK, STEP_SCHEDULE, planRecurrenceWrite,
} from "../recurrence.ts";
import { iso, status, todoCreate, todoPatch } from "../schemas.ts";
import { applyStatusTimes, completionJson, reminderJson, todoJson } from "../serializers.ts";
import {
  clearStepSchedules, completeParentIfSettled, completionStats, isStepOfRepeating, reopenStepsForNextOccurrence,
  startParentIfPending, syncOccurrenceCompletion,
} from "../todo-status.ts";
import { type TodoRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

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
      /** `mine`: the owner's own tasks, leaving out every group chat's area. */
      scope: z.enum(["mine"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).parse(req.query);
    const clauses = ["t.user_id=@user_id"];
    const params: Record<string, string | number> = { user_id: USER_ID, limit: query.limit };
    // Applied here rather than after the fetch so the row limit is spent on the
    // rows the caller asked for, not on a busy chat's tasks that are then dropped.
    if (query.scope === "mine") clauses.push(OWN_AREA_CLAUSE("t"));
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
  /*
   * Registered ahead of `/api/todos/:id` so "completions" is not read as an id.
   * The board joins these to the todos it already fetched, so its life-area
   * filter applies to them without a second filter here.
   */
  app.get("/api/todos/completions", (req, res) => {
    const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    const since = new Date(Date.now() - query.days * 86_400_000).toISOString();
    return success(res, getRecentCompletions(db, since).map(row => ({ ...completionJson(row), todo_id: row.todo_id })));
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
    if (repeat.recurrence_json) {
      if (body.parent_id) return failure(res, 400, REPEATING_SUBTASK);
      if (body.due_at || body.reminder_at || body.extra_reminders.length) return failure(res, 400, DERIVED_SCHEDULE);
      if (body.subtasks?.some(subtask => subtask.due_at)) return failure(res, 400, STEP_SCHEDULE);
    }
    if (isStepOfRepeating(body.parent_id, parentId => getTodo(db, parentId))
      && (body.due_at || body.reminder_at || body.extra_reminders.length)) {
      return failure(res, 400, STEP_SCHEDULE);
    }
    const schedule = repeat.derived ?? {
      due_at: body.due_at ?? null,
      reminder_at: body.reminder_at ?? null,
      extra_reminders_json: JSON.stringify(body.extra_reminders),
    };
    db.transaction(() => {
      db.prepare(`
        INSERT INTO todos(
          id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
          priority,status,started_at,completed_at,recurrence_json,assistant_says,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(todoId, USER_ID, body.title, body.notes ?? null, body.category_id ?? null,
        body.life_area_id ?? null, body.life_area_source ?? null, body.parent_id ?? null,
        schedule.due_at, schedule.reminder_at, schedule.extra_reminders_json,
        body.priority ?? null, body.status,
        times.startedAt, times.completedAt, repeat.recurrence_json,
        body.assistant_says === true && !body.parent_id ? 1 : 0, timestamp, timestamp);
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
    const repeat = planRecurrenceWrite(body.recurrence, current, userTimezone(db));
    const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id;
    if (repeat.recurrence_json) {
      if (parentId) return failure(res, 400, REPEATING_SUBTASK);
      if (body.due_at || body.reminder_at || body.extra_reminders?.length) return failure(res, 400, DERIVED_SCHEDULE);
    }
    const stepOfRepeating = isStepOfRepeating(parentId, key => getTodo(db, key));
    if (stepOfRepeating && (body.due_at || body.reminder_at || body.extra_reminders?.length)) {
      return failure(res, 400, STEP_SCHEDULE);
    }
    // A rule change opens a new occurrence. The one just finished is already in
    // the log, so a done status is not carried on to a day that has not come.
    const requested = body.status ?? current.status;
    const nextStatus = repeat.occurrenceMoved && (requested === "done" || requested === "in_progress")
      ? "pending"
      : requested;
    const times = repeat.occurrenceMoved
      ? { startedAt: null, completedAt: null }
      : applyStatusTimes(nextStatus, current, body);
    const schedule = repeat.derived ?? (stepOfRepeating ? { due_at: null, reminder_at: null, extra_reminders_json: "[]" } : {
      due_at: body.due_at === undefined ? current.due_at : body.due_at,
      reminder_at: body.reminder_at === undefined ? current.reminder_at : body.reminder_at,
      extra_reminders_json: body.extra_reminders === undefined
        ? current.extra_reminders_json
        : JSON.stringify(body.extra_reminders),
    });
    const assistantSays = parentId ? 0 : body.assistant_says === undefined ? current.assistant_says : Number(body.assistant_says);
    db.transaction(() => {
      db.prepare(`
        UPDATE todos SET title=?,notes=?,category_id=?,life_area_id=?,life_area_source=?,parent_id=?,due_at=?,reminder_at=?,
          extra_reminders_json=?,priority=?,status=?,started_at=?,completed_at=?,recurrence_json=?,assistant_says=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(body.title ?? current.title, body.notes === undefined ? current.notes : body.notes,
        body.category_id === undefined ? current.category_id : body.category_id,
        body.life_area_id === undefined ? current.life_area_id : body.life_area_id,
        body.life_area_source === undefined ? current.life_area_source : body.life_area_source,
        parentId, schedule.due_at, schedule.reminder_at, schedule.extra_reminders_json,
        body.priority === undefined ? current.priority : body.priority, nextStatus,
        times.startedAt, times.completedAt, repeat.recurrence_json, assistantSays, now(), current.id, USER_ID);
      const todo = getTodo(db, current.id);
      if (todo) {
        if (repeat.recurrence_json && !current.recurrence_json) clearStepSchedules(db, todo);
        if (repeat.occurrenceMoved) reopenStepsForNextOccurrence(db, todo);
        syncTodoReminders(db, todo);
        syncOccurrenceCompletion(db, todo);
        completeParentIfSettled(db, todo);
        startParentIfPending(db, todo);
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
        startParentIfPending(db, todo);
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
