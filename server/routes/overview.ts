import { z } from "zod";
import { OWN_AREA_CLAUSE, USER_ID, getReminders, now } from "../db.ts";
import { success } from "../http.ts";
import { getNotificationPreferences } from "../integrations.ts";
import { localParts } from "../local-time.ts";
import { parseMoods } from "../moods.ts";
import { memoryJson, reminderJson, todoJson } from "../serializers.ts";
import { type Db, type MemoryRow, type TodoRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

export function registerOverviewRoutes({ app, db }: RouteContext): void {
  app.get("/api/overview", (_req, res) => {
    const todoRows = db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? ORDER BY t.created_at DESC
    `).all(USER_ID) as TodoRow[];
    const memories = db.prepare(`
      SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM memories m LEFT JOIN categories c ON c.id=m.category_id
      LEFT JOIN life_areas la ON la.id=m.life_area_id
      WHERE m.user_id=? ORDER BY m.created_at DESC LIMIT 6
    `).all(USER_ID) as MemoryRow[];
    const counts: Record<string, number> = {
      pending: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0,
    };
    for (const todo of todoRows) counts[todo.status] += 1;
    const timestamp = now();
    // The user's day, not UTC's: a task due tonight has to stay in "Due today"
    // until midnight where they are, whatever offset its stored value carries.
    const timezone = getNotificationPreferences(db).timezone;
    const localDate = (value: string): string | null => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : localParts(date, timezone).date;
    };
    const today = localParts(new Date(), timezone).date;
    const progressRows = db.prepare(`
      SELECT parent_id,count(*) total,sum(CASE WHEN status='done' THEN 1 ELSE 0 END) done
      FROM todos WHERE user_id=? AND parent_id IS NOT NULL GROUP BY parent_id
    `).all(USER_ID) as Array<{ parent_id: string; total: number; done: number }>;
    return success(res, {
      counts: {
        ...counts,
        active: counts.pending + counts.in_progress + counts.blocked,
        memories: (db.prepare("SELECT count(*) count FROM memories WHERE user_id=?").get(USER_ID) as { count: number }).count,
      },
      in_progress: todoRows.filter((todo) => todo.status === "in_progress").map(todoJson),
      blocked: todoRows.filter((todo) => todo.status === "blocked").map(todoJson),
      // What the day still owes. A task finished this morning was due today too,
      // but it is no longer something to do.
      due_today: todoRows.filter((todo) => todo.due_at
        && localDate(todo.due_at) === today
        && todo.status !== "done" && todo.status !== "cancelled").map(todoJson),
      recent_memories: memories.map(memoryJson),
      /*
       * Only what is still ahead: a due-date row is never delivered, so without
       * a horizon every overdue task would sit at the top of this list forever
       * and crowd out the reminders that are actually about to fire. The cap is
       * generous because these rows are read a task at a time, and one task can
       * hold a due date and several alerts.
       */
      upcoming_reminders: getReminders(db)
        .filter((reminder) => reminder.status === "pending" && reminder.scheduled_for >= timestamp)
        .slice(0, 20)
        .map(reminderJson),
      // The owner's own moods; the card can switch to the shared ones through /mood-trend.
      mood_trend: moodTrend(db, "mine"),
      subtask_progress: Object.fromEntries(
        progressRows.map((row) => [row.parent_id, { done: row.done, total: row.total }]),
      ),
    });
  });
  /**
   * The mood chart's two views. `mine` is the owner's own entries — nothing
   * filed under a group chat's area — so a household's evening does not read as
   * the owner's day. `shared` is the group entries, each carrying every
   * person's mood beside the combined one, and the group it belongs to.
   */
  app.get("/api/overview/mood-trend", (req, res) => {
    const scope = moodTrendScope.parse(req.query.scope ?? "mine");
    return success(res, moodTrend(db, scope));
  });
}

const moodTrendScope = z.enum(["mine", "shared"]);

type MoodTrendRow = {
  id: string; title: string | null; at: string; score: number; label: string | null;
  moods_json: string | null; life_area_id: string | null; life_area_name: string | null;
};

/*
 * The last fourteen entries that carry a mood, oldest first, placed on the day
 * they happened rather than the day they were typed: a reflection saved after
 * midnight is still about the day before.
 */
function moodTrend(db: Db, scope: "mine" | "shared"): Array<Record<string, unknown>> {
  const where = scope === "mine"
    ? OWN_AREA_CLAUSE("m")
    : "m.life_area_id IN (SELECT id FROM life_areas WHERE thread_id IS NOT NULL)";
  const rows = db.prepare(`
    SELECT m.id,m.title,COALESCE(m.occurred_at,m.created_at) at,m.mood_score score,m.mood_label label,
      m.moods_json,m.life_area_id,la.name life_area_name
    FROM memories m LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=? AND m.mood_score IS NOT NULL AND ${where}
    ORDER BY COALESCE(m.occurred_at,m.created_at) DESC LIMIT 14
  `).all(USER_ID) as MoodTrendRow[];
  return rows.reverse().map(row => ({
    id: row.id,
    title: row.title,
    at: row.at,
    score: row.score,
    label: row.label,
    moods: parseMoods(row.moods_json),
    life_area_id: row.life_area_id,
    life_area_name: row.life_area_name,
  }));
}
