import {
  USER_ID, getTodo, getTodoCompletions, id, instant, now, queueIndexJob, syncTodoReminders, userTimezone,
} from "./db.ts";
import { getTaskPreferences } from "./integrations.ts";
import { completionStreak, parseRecurrence } from "./recurrence.ts";
import type { Db, TodoCompletionRow, TodoRow } from "./types.ts";

/**
 * Keeps the completion log in step with a repeating todo's status. Marking the
 * row done records the occurrence it currently holds, so the worker can roll
 * the row forward later without losing the fact that today's dose was given;
 * moving it back to open takes that record away again, which is what undoing
 * a tap on the checkbox should mean. Cancelling is neither: it ends the series,
 * and a dose that was given before it ended still was. Called after every
 * status write, and a no-op for a todo that does not repeat.
 */
export function syncOccurrenceCompletion(db: Db, todo: TodoRow): void {
  if (!todo.recurrence_json || !todo.due_at) return;
  const occurrence = instant(todo.due_at);
  if (todo.status === "done") {
    // Stored in one spelling so the MAX below orders by time, not by text.
    const completedAt = instant(todo.completed_at ?? now());
    db.prepare(`
      INSERT OR IGNORE INTO todo_completions(id,user_id,todo_id,occurrence_at,completed_at,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(id("completion"), USER_ID, todo.id, occurrence, completedAt, now());
  } else if (todo.status !== "cancelled") {
    db.prepare("DELETE FROM todo_completions WHERE user_id=? AND todo_id=? AND occurrence_at=?")
      .run(USER_ID, todo.id, occurrence);
  }
  db.prepare(`
    UPDATE todos SET last_completed_at=(
      SELECT MAX(completed_at) FROM todo_completions WHERE user_id=todos.user_id AND todo_id=todos.id
    ) WHERE id=? AND user_id=?
  `).run(todo.id, USER_ID);
}

/** The completion history a detail view or the agent reads for a repeating todo. */
export function completionStats(
  db: Db,
  todo: TodoRow,
): { completion_count: number; streak: number; completions: TodoCompletionRow[] } | null {
  const rule = parseRecurrence(todo.recurrence_json);
  if (!rule) return null;
  const completions = getTodoCompletions(db, todo.id);
  const count = db.prepare(
    "SELECT count(*) total FROM todo_completions WHERE user_id=? AND todo_id=?",
  ).get(USER_ID, todo.id) as { total: number };
  const all = db.prepare(
    "SELECT occurrence_at FROM todo_completions WHERE user_id=? AND todo_id=?",
  ).all(USER_ID, todo.id) as Array<{ occurrence_at: string }>;
  let streak = 0;
  try {
    streak = completionStreak(rule, all.map(row => row.occurrence_at), todo.due_at, userTimezone(db));
  } catch (error) {
    // The count and the log are still worth showing when the walk back cannot
    // be made; a detail view should not fail over a number in its corner.
    console.error(`Streak for repeating todo ${todo.id} could not be computed`, error);
  }
  return { completion_count: count.total, streak, completions };
}

/**
 * Closing the last step of a task often means the task itself is finished, but
 * not always: a parent can carry work of its own that no subtask describes. The
 * preference decides, and the rule lives here rather than in a route so the
 * board, the REST API, and the agent's tools cannot drift apart on it.
 *
 * Returns the parent it closed, so a caller can say what else moved.
 *
 * `lifeAreaId` is the fence a group turn runs inside: a parent filed in another
 * area belongs to the owner alone, and closing the group's last step must not
 * reach across and close it.
 */
export function completeParentIfSettled(db: Db, child: TodoRow, lifeAreaId?: string): TodoRow | null {
  if (!child.parent_id || child.status !== "done") return null;
  if (!getTaskPreferences(db).autoCompleteParent) return null;
  const parent = getTodo(db, child.parent_id);
  if (!parent || parent.status === "done" || parent.status === "cancelled") return null;
  if (lifeAreaId && parent.life_area_id !== lifeAreaId) return null;
  const remaining = db.prepare(`
    SELECT count(*) open FROM todos
    WHERE user_id=? AND parent_id=? AND status NOT IN ('done','cancelled')
  `).get(USER_ID, parent.id) as { open: number };
  if (remaining.open) return null;
  const timestamp = now();
  db.prepare(`
    UPDATE todos SET status='done',completed_at=COALESCE(completed_at,?),updated_at=?
    WHERE id=? AND user_id=?
  `).run(timestamp, timestamp, parent.id, USER_ID);
  const closed = getTodo(db, parent.id) as TodoRow;
  syncTodoReminders(db, closed);
  syncOccurrenceCompletion(db, closed);
  queueIndexJob(db, "todo", parent.id);
  return closed;
}

/**
 * A task whose first step is underway is underway too, so starting a step starts
 * a parent that has not been started. So does finishing a step while others are
 * still open: one of three ticked is a task in progress, not one nobody has
 * touched. The last step is left to `completeParentIfSettled()`. Nothing else
 * about the parent moves: a blocked or finished parent keeps its status.
 * `lifeAreaId` fences a group turn as in `completeParentIfSettled()`.
 */
export function startParentIfPending(db: Db, child: TodoRow, lifeAreaId?: string): TodoRow | null {
  if (!child.parent_id || (child.status !== "in_progress" && child.status !== "done")) return null;
  const parent = getTodo(db, child.parent_id);
  if (!parent || parent.status !== "pending") return null;
  if (lifeAreaId && parent.life_area_id !== lifeAreaId) return null;
  if (child.status === "done") {
    const remaining = db.prepare(`
      SELECT count(*) open FROM todos
      WHERE user_id=? AND parent_id=? AND status NOT IN ('done','cancelled')
    `).get(USER_ID, parent.id) as { open: number };
    if (!remaining.open) return null;
  }
  const timestamp = now();
  db.prepare(`
    UPDATE todos SET status='in_progress',started_at=COALESCE(started_at,?),updated_at=?
    WHERE id=? AND user_id=?
  `).run(timestamp, timestamp, parent.id, USER_ID);
  const started = getTodo(db, parent.id) as TodoRow;
  syncTodoReminders(db, started);
  queueIndexJob(db, "todo", parent.id);
  return started;
}

/*
 * The series only reaches the steps filed in the repeating todo's own life
 * area. A step the owner filed elsewhere under a group's todo is theirs alone,
 * and a group making its todo repeat must not move it.
 */

/**
 * Takes the schedule off the steps of a todo that has just started repeating.
 * A step comes round with its parent, so a fixed date of its own would be
 * overdue from the second occurrence on and keep texting about it.
 */
export function clearStepSchedules(db: Db, parent: Pick<TodoRow, "id" | "life_area_id">): void {
  const steps = db.prepare(`
    UPDATE todos SET due_at=NULL,reminder_at=NULL,extra_reminders_json='[]',updated_at=?
    WHERE user_id=? AND parent_id=? AND life_area_id IS ?
      AND (due_at IS NOT NULL OR reminder_at IS NOT NULL OR extra_reminders_json<>'[]')
    RETURNING id
  `).all(now(), USER_ID, parent.id, parent.life_area_id) as Array<{ id: string }>;
  for (const step of steps) {
    const updated = getTodo(db, step.id);
    if (updated) syncTodoReminders(db, updated);
    queueIndexJob(db, "todo", step.id);
  }
}

/**
 * Opens a repeating todo's checklist again for its next occurrence. A step
 * that was finished or started belongs to the occurrence that is over; a
 * blocked step stays blocked, as the parent does, and a cancelled one has been
 * taken off the checklist.
 */
export function reopenStepsForNextOccurrence(db: Db, parent: Pick<TodoRow, "id" | "life_area_id">): number {
  const steps = db.prepare(`
    UPDATE todos SET status='pending',started_at=NULL,completed_at=NULL,updated_at=?
    WHERE user_id=? AND parent_id=? AND life_area_id IS ? AND status IN ('done','in_progress')
    RETURNING id
  `).all(now(), USER_ID, parent.id, parent.life_area_id) as Array<{ id: string }>;
  for (const step of steps) queueIndexJob(db, "todo", step.id);
  return steps.length;
}

/**
 * Whether the todo is a step of a repeating one, and so has no schedule of its
 * own. `readParent` is how the caller may see the parent: a group turn passes
 * its scoped read, so a parent outside the group reads as not repeating
 * rather than answering a question about the owner's private task.
 */
export function isStepOfRepeating(
  parentId: string | null | undefined,
  readParent: (id: string) => Pick<TodoRow, "recurrence_json"> | null | undefined,
): boolean {
  return Boolean(parentId && readParent(parentId)?.recurrence_json);
}

/**
 * The steps still standing between a task and being finished. A parent closed
 * while these are open leaves them alive but unreachable, so both the REST layer
 * and the UI ask about them first.
 */
export function openSubtasks(db: Db, todoId: string, lifeAreaId?: string): TodoRow[] {
  // With an area given, only the steps filed in it: a reminder texted into a
  // group must not list a subtask the owner keeps to themselves.
  return db.prepare(`
    SELECT * FROM todos
    WHERE user_id=? AND parent_id=? AND status NOT IN ('done','cancelled')
      ${lifeAreaId ? "AND life_area_id=?" : ""}
    ORDER BY created_at
  `).all(...(lifeAreaId ? [USER_ID, todoId, lifeAreaId] : [USER_ID, todoId])) as TodoRow[];
}
