import { USER_ID, getTodo, now, queueIndexJob, syncTodoReminders } from "./db.ts";
import { getTaskPreferences } from "./integrations.ts";
import type { Db, TodoRow } from "./types.ts";

/**
 * Closing the last step of a task often means the task itself is finished, but
 * not always: a parent can carry work of its own that no subtask describes. The
 * preference decides, and the rule lives here rather than in a route so the
 * board, the REST API, and the agent's tools cannot drift apart on it.
 *
 * Returns the parent it closed, so a caller can say what else moved.
 */
export function completeParentIfSettled(db: Db, child: TodoRow): TodoRow | null {
  if (!child.parent_id || child.status !== "done") return null;
  if (!getTaskPreferences(db).autoCompleteParent) return null;
  const parent = getTodo(db, child.parent_id);
  if (!parent || parent.status === "done" || parent.status === "cancelled") return null;
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
  queueIndexJob(db, "todo", parent.id);
  return closed;
}

/**
 * The steps still standing between a task and being finished. A parent closed
 * while these are open leaves them alive but unreachable, so both the REST layer
 * and the UI ask about them first.
 */
export function openSubtasks(db: Db, todoId: string): TodoRow[] {
  return db.prepare(`
    SELECT * FROM todos
    WHERE user_id=? AND parent_id=? AND status NOT IN ('done','cancelled')
    ORDER BY created_at
  `).all(USER_ID, todoId) as TodoRow[];
}
