import { z } from "zod";
import { USER_ID, getReminders, getTodo, instant, now, queueIndexJob, syncTodoReminders } from "../db.ts";
import { failure, success } from "../http.ts";
import { iso, reminderCreate } from "../schemas.ts";
import { reminderJson, todoJson } from "../serializers.ts";
import { type ReminderRow, type TodoRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

export function registerReminderRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/reminders", (req, res) => {
    const query = z.object({
      from: iso.optional(),
      to: iso.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).parse(req.query);
    let reminders = getReminders(db);
    if (query.from) reminders = reminders.filter((item) => instant(item.scheduled_for) >= instant(query.from!));
    if (query.to) reminders = reminders.filter((item) => instant(item.scheduled_for) <= instant(query.to!));
    return success(res, reminders.slice(0, query.limit).map(reminderJson));
  });
  app.post("/api/reminders", (req, res) => {
    const body = reminderCreate.parse(req.body);
    if (new Date(body.reminder_at).getTime() <= Date.now()) {
      return failure(res, 400, "Reminder time must be in the future");
    }
    const current = getTodo(db, body.todo_id);
    if (!current) return failure(res, 404, "Todo not found");
    db.transaction(() => {
      const extras = JSON.parse(current.extra_reminders_json) as string[];
      if (body.slot === "primary") {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(body.reminder_at, now(), current.id, USER_ID);
      } else {
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set([...extras, body.reminder_at])]), now(), current.id, USER_ID);
      }
      const updated = getTodo(db, current.id);
      if (updated) syncTodoReminders(db, updated);
      queueIndexJob(db, "todo", current.id);
    })();
    search.flushSoon();
    const reminder = getReminders(db, current.id)
      .find((item) => instant(item.scheduled_for) === instant(body.reminder_at) && item.status === "pending");
    return reminder ? success(res, reminderJson(reminder), 201) : failure(res, 500, "Reminder was not created");
  });
  app.patch("/api/reminders/:id", (req, res) => {
    const body = z.object({ reminder_at: iso }).strict().parse(req.body);
    if (new Date(body.reminder_at).getTime() <= Date.now()) {
      return failure(res, 400, "Reminder time must be in the future");
    }
    const reminder = db.prepare(`
      SELECT r.*,t.title todo_title FROM reminders r JOIN todos t ON t.id=r.todo_id
      WHERE r.id=? AND r.user_id=?
    `).get(req.params.id, USER_ID) as ReminderRow | undefined;
    if (!reminder) return failure(res, 404, "Reminder not found");
    const todo = getTodo(db, reminder.todo_id);
    if (!todo) return failure(res, 404, "Todo not found");
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(body.reminder_at, now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(body.reminder_at, now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .map((value) => instant(value) === instant(reminder.scheduled_for) ? body.reminder_at : value);
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set(extras)]), now(), todo.id, USER_ID);
      }
      db.prepare("DELETE FROM reminders WHERE id=? AND user_id=?").run(reminder.id, USER_ID);
      const updated = getTodo(db, todo.id);
      if (updated) syncTodoReminders(db, updated);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    const updatedReminder = getReminders(db, todo.id)
      .find((item) => instant(item.scheduled_for) === instant(body.reminder_at) && item.status === "pending");
    return updatedReminder
      ? success(res, reminderJson(updatedReminder))
      : failure(res, 500, "Reminder was not updated");
  });
  app.delete("/api/reminders/:id", (req, res) => {
    const reminder = db.prepare(`
      SELECT r.*,t.title todo_title FROM reminders r JOIN todos t ON t.id=r.todo_id
      WHERE r.id=? AND r.user_id=?
    `).get(req.params.id, USER_ID) as ReminderRow | undefined;
    if (!reminder) return failure(res, 404, "Reminder not found");
    const todo = getTodo(db, reminder.todo_id);
    if (!todo) return failure(res, 404, "Todo not found");
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .filter((value) => instant(value) !== instant(reminder.scheduled_for));
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify(extras), now(), todo.id, USER_ID);
      }
      db.prepare("DELETE FROM reminders WHERE id=? AND user_id=?").run(reminder.id, USER_ID);
      const updated = getTodo(db, todo.id);
      if (updated) syncTodoReminders(db, updated);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return success(res, { id: reminder.id });
  });
  app.get("/api/agenda", (req, res) => {
    const query = z.object({
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezone: z.string().min(1).max(100),
    }).parse(req.query);
    const dateKey = (value: string): string => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: query.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(value));
      const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    const inRange = (value: string): boolean => {
      const key = dateKey(value);
      return key >= query.start_date && key <= query.end_date;
    };
    const todos = (db.prepare(`
      SELECT t.*,c.name category_name FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=? AND t.due_at IS NOT NULL ORDER BY t.due_at
    `).all(USER_ID) as TodoRow[]).filter((todo) => todo.due_at && inRange(todo.due_at));
    const reminders = getReminders(db).filter((reminder) => inRange(reminder.scheduled_for));
    return success(res, { todos: todos.map(todoJson), reminders: reminders.map(reminderJson) });
  });
  app.get("/api/reminders/due", (_req, res) => {
    const timestamp = now();
    const due = db.prepare(`
      SELECT r.*,t.title todo_title FROM reminders r JOIN todos t ON t.id=r.todo_id
      WHERE r.user_id=? AND r.status='pending' AND r.scheduled_for<=?
      ORDER BY r.scheduled_for LIMIT 100
    `).all(USER_ID, timestamp) as ReminderRow[];
    /*
     * A task whose reminder lands on its own due date holds two rows for the one
     * moment, which the schedule wants and the toast does not: dismissing the
     * first only summons its twin. One moment is one interruption.
     */
    const seen = new Set<string>();
    const distinct = due.filter((reminder) => {
      const key = `${reminder.todo_id}:${instant(reminder.scheduled_for)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return success(res, distinct.map(reminderJson));
  });
}
