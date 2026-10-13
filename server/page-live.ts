/**
 * What a hosted page reads out of SQLite when it is opened, and the one thing
 * it may write back: ticking a shared checklist.
 *
 * Every query here is fenced by the page, never by the viewer. A page filed
 * under a group's life area reads that area and nothing else; a page with no
 * area is the owner's own (everything outside the groups, as the daily digest
 * reads it) and is only ever drawn for a signed-in owner.
 */
import {
  getTodo, insertTodoComment, now, OWN_AREA_CLAUSE, queueIndexJob, syncTodoReminders, USER_ID, userTimezone,
} from "./db.ts";
import { localParts } from "./local-time.ts";
import { parseMoods } from "./moods.ts";
import { parseRecurrence } from "./recurrence.ts";
import { reflectionPeriod } from "./reflection-period.ts";
import {
  completeParentIfSettled, completionStats, startParentIfPending, syncOccurrenceCompletion,
} from "./todo-status.ts";
import { addPageEvent, PageError, type PageBlock, type PageRow, pageBlocks, pageIsLive } from "./pages.ts";
import type { Db, TodoRow } from "./types.ts";

const OPEN = new Set(["pending", "in_progress", "blocked"]);
const LIST_LIMIT = 60;

const scopeOf = (page: PageRow, alias: string): { sql: string; args: string[] } =>
  page.life_area_id ? { sql: `${alias}.life_area_id=?`, args: [page.life_area_id] } : { sql: OWN_AREA_CLAUSE(alias), args: [] };

/** A shared page with no area of its own has nothing it may read. */
export const canReadRecords = (page: PageRow): boolean => page.audience === "owner" || Boolean(page.life_area_id);

export type LiveTodo = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  due_at: string | null;
  completed_at: string | null;
};

export function liveTodos(db: Db, page: PageRow, range: "today" | "week" | "overdue" | "done_week"): LiveTodo[] {
  if (!canReadRecords(page)) return [];
  const timezone = userTimezone(db);
  const today = localParts(new Date(), timezone).date;
  const week = reflectionPeriod("week", timezone);
  const scope = scopeOf(page, "t");
  const rows = db.prepare(`
    SELECT t.id,t.title,t.status,t.priority,t.due_at,t.reminder_at,t.completed_at FROM todos t
    WHERE t.user_id=? AND ${scope.sql} AND t.assistant_says=0
    ORDER BY t.due_at IS NULL,t.due_at,t.title
  `).all(USER_ID, ...scope.args) as Array<LiveTodo & { reminder_at: string | null }>;
  const day = (value: string | null) => (value ? localParts(new Date(value), timezone).date : null);
  const picked = rows.filter(todo => {
    const due = day(todo.due_at);
    if (range === "done_week") {
      const done = day(todo.completed_at);
      return todo.status === "done" && done !== null && done >= week.startDate && done <= week.endDate;
    }
    if (!OPEN.has(todo.status)) return false;
    if (range === "today") return due === today || day(todo.reminder_at) === today;
    if (range === "overdue") return due !== null && due < today;
    return due !== null && due >= today && due <= week.endDate;
  });
  return picked.slice(0, LIST_LIMIT);
}

/** The parent a block points at, when it is inside the page's fence. */
function scopedParent(db: Db, page: PageRow, todoId: string | undefined): TodoRow | undefined {
  if (!todoId || !canReadRecords(page)) return undefined;
  const todo = getTodo(db, todoId);
  if (!todo) return undefined;
  if (page.life_area_id) return todo.life_area_id === page.life_area_id ? todo : undefined;
  const own = db.prepare(`SELECT 1 found FROM todos t WHERE t.id=? AND ${OWN_AREA_CLAUSE("t")}`).get(todoId);
  return own ? todo : undefined;
}

/** A step the page may show or change: a group's page reaches only the steps filed in the group's own area. */
const inFence = (page: PageRow, step: TodoRow): boolean => !page.life_area_id || step.life_area_id === page.life_area_id;

export type ChecklistItem = LiveTodo & { claimed_by: string | null };

export function checklistItems(db: Db, page: PageRow, block: PageBlock): { title: string; items: ChecklistItem[] } | null {
  const parent = scopedParent(db, page, block.todo_id);
  if (!parent) return null;
  const rows = db.prepare(`
    SELECT id,title,status,priority,due_at,completed_at FROM todos
    WHERE user_id=? AND parent_id=? AND status<>'cancelled' AND (? IS NULL OR life_area_id IS ?)
    ORDER BY created_at,rowid LIMIT ?
  `).all(USER_ID, parent.id, page.life_area_id, page.life_area_id, LIST_LIMIT) as LiveTodo[];
  const claim = db.prepare(`
    SELECT author_name,body FROM todo_comments WHERE todo_id=? AND body LIKE 'Claimed by %' ORDER BY created_at DESC,rowid DESC LIMIT 1
  `);
  return {
    title: block.text || parent.title,
    items: rows.map(row => {
      const last = claim.get(row.id) as { body: string } | undefined;
      return { ...row, claimed_by: last ? last.body.slice("Claimed by ".length) : null };
    }),
  };
}

export type Progress = { title: string; notes: string | null; done: number; total: number; open: LiveTodo[]; finished: LiveTodo[] };

export function progressOf(db: Db, page: PageRow, block: PageBlock): Progress | null {
  const parent = scopedParent(db, page, block.todo_id);
  if (!parent) return null;
  const rows = db.prepare(`
    SELECT id,title,status,priority,due_at,completed_at FROM todos
    WHERE user_id=? AND parent_id=? AND status<>'cancelled' AND (? IS NULL OR life_area_id IS ?)
    ORDER BY created_at,rowid LIMIT ?
  `).all(USER_ID, parent.id, page.life_area_id, page.life_area_id, LIST_LIMIT) as LiveTodo[];
  return {
    title: block.text || parent.title,
    notes: parent.notes,
    done: rows.filter(row => row.status === "done").length,
    total: rows.length,
    open: rows.filter(row => row.status !== "done"),
    finished: rows.filter(row => row.status === "done"),
  };
}

/**
 * Ticks or unticks one step of a shared checklist, the way the board would:
 * the same status rules, reminders, and index job. Only a step of the block's
 * own parent, inside the page's fence, can be reached from a public link.
 */
export function toggleChecklistItem(
  db: Db,
  page: PageRow,
  input: { blockId: string; todoId: string; actor: string },
): { title: string; done: boolean } {
  if (!pageIsLive(page)) throw new PageError("This page is no longer open");
  const block = pageBlocks(page).find(candidate => candidate.id === input.blockId && candidate.type === "live_checklist");
  const parent = block && scopedParent(db, page, block.todo_id);
  const step = parent ? getTodo(db, input.todoId) : undefined;
  if (!block || !parent || !step || step.parent_id !== parent.id || !inFence(page, step) || step.status === "cancelled") {
    throw new PageError("That item is not on this list");
  }
  const done = step.status !== "done";
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`
      UPDATE todos SET status=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND user_id=?
    `).run(done ? "done" : "pending", step.started_at, done ? step.completed_at ?? timestamp : null, timestamp, step.id, USER_ID);
    const row = getTodo(db, step.id) as TodoRow;
    syncTodoReminders(db, row);
    syncOccurrenceCompletion(db, row);
    completeParentIfSettled(db, row, page.life_area_id ?? undefined);
    startParentIfPending(db, row, page.life_area_id ?? undefined, step.status);
    queueIndexJob(db, "todo", step.id);
    addPageEvent(db, page.id, "check", input.actor, `${row.title}${done ? "" : " (undone)"}`);
  })();
  return { title: step.title, done };
}

export function claimChecklistItem(
  db: Db,
  page: PageRow,
  input: { blockId: string; todoId: string; actor: string },
): { title: string } {
  if (!pageIsLive(page)) throw new PageError("This page is no longer open");
  const block = pageBlocks(page).find(candidate => candidate.id === input.blockId && candidate.type === "live_checklist");
  const parent = block && scopedParent(db, page, block.todo_id);
  const step = parent ? getTodo(db, input.todoId) : undefined;
  if (!block || !parent || !step || step.parent_id !== parent.id || !inFence(page, step) || step.status === "cancelled") {
    throw new PageError("That item is not on this list");
  }
  db.transaction(() => {
    insertTodoComment(db, { todoId: step.id, body: `Claimed by ${input.actor}`, author: "agent", authorName: `${input.actor} (shared page)` });
    addPageEvent(db, page.id, "claim", input.actor, step.title);
  })();
  return { title: step.title };
}

export type HabitRow = { title: string; streak: number; count: number; days: boolean[] };

/** Repeating todos with their streaks and the last `span` days as done or not. */
export function habitRows(db: Db, page: PageRow, span = 28): HabitRow[] {
  if (!canReadRecords(page)) return [];
  const timezone = userTimezone(db);
  const scope = scopeOf(page, "t");
  const todos = db.prepare(`
    SELECT t.* FROM todos t WHERE t.user_id=? AND ${scope.sql} AND t.recurrence_json IS NOT NULL
      AND t.status<>'cancelled' ORDER BY t.title LIMIT 20
  `).all(USER_ID, ...scope.args) as TodoRow[];
  const today = new Date();
  const dates = Array.from({ length: span }, (_, index) => localParts(new Date(today.getTime() - (span - 1 - index) * 86_400_000), timezone).date);
  return todos.filter(todo => parseRecurrence(todo.recurrence_json)).map(todo => {
    const stats = completionStats(db, todo);
    const completed = new Set((db.prepare("SELECT occurrence_at FROM todo_completions WHERE user_id=? AND todo_id=?")
      .all(USER_ID, todo.id) as Array<{ occurrence_at: string }>)
      .map(row => localParts(new Date(row.occurrence_at), timezone).date));
    return {
      title: todo.title,
      streak: stats?.streak ?? 0,
      count: stats?.completion_count ?? 0,
      days: dates.map(date => completed.has(date)),
    };
  });
}

export type MoodDay = { date: string; score: number; entries: number };
export type MoodSeries = { days: MoodDay[]; people: Array<{ name: string; average: number; entries: number }>; average: number | null };

export function moodSeries(db: Db, page: PageRow, span: number): MoodSeries {
  if (!canReadRecords(page)) return { days: [], people: [], average: null };
  const timezone = userTimezone(db);
  const since = new Date(Date.now() - span * 86_400_000).toISOString();
  const scope = scopeOf(page, "m");
  const rows = db.prepare(`
    SELECT m.mood_score,m.moods_json,COALESCE(m.occurred_at,m.created_at) at FROM memories m
    WHERE m.user_id=? AND ${scope.sql} AND m.mood_score IS NOT NULL AND COALESCE(m.occurred_at,m.created_at)>=?
    ORDER BY at
  `).all(USER_ID, ...scope.args, since) as Array<{ mood_score: number; moods_json: string | null; at: string }>;
  const byDay = new Map<string, number[]>();
  const byPerson = new Map<string, number[]>();
  for (const row of rows) {
    const date = localParts(new Date(row.at), timezone).date;
    byDay.set(date, [...byDay.get(date) ?? [], row.mood_score]);
    for (const mood of parseMoods(row.moods_json)) byPerson.set(mood.name, [...byPerson.get(mood.name) ?? [], mood.score]);
  }
  const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10;
  const all = rows.map(row => row.mood_score);
  return {
    days: [...byDay].map(([date, scores]) => ({ date, score: mean(scores), entries: scores.length })),
    people: page.life_area_id
      ? [...byPerson].map(([name, scores]) => ({ name, average: mean(scores), entries: scores.length }))
      : [],
    average: all.length ? mean(all) : null,
  };
}

/** Who is on a rotation this week and for the next few, from the rotation's anchor date. */
export function rotationWeeks(db: Db, page: PageRow, block: PageBlock, count = 5): Array<{ start: string; name: string; current: boolean }> {
  const timezone = userTimezone(db);
  const names = block.items ?? [];
  if (!names.length) return [];
  const anchor = block.when ? localParts(new Date(block.when), timezone).date : localParts(new Date(page.created_at), timezone).date;
  const monday = (date: string): number => {
    const [year, month, day] = date.split("-").map(Number);
    const at = Date.UTC(year, month - 1, day);
    return at - ((new Date(at).getUTCDay() + 6) % 7) * 86_400_000;
  };
  const first = monday(anchor);
  const current = monday(localParts(new Date(), timezone).date);
  const index = Math.floor((current - first) / (7 * 86_400_000));
  return Array.from({ length: count }, (_, step) => {
    const week = index + step;
    return {
      start: new Date(current + step * 7 * 86_400_000).toISOString().slice(0, 10),
      name: names[((week % names.length) + names.length) % names.length],
      current: step === 0,
    };
  });
}

/** The streak of a rotation's recurring todo, when it names one inside the page's fence. */
export function rotationStreak(db: Db, page: PageRow, block: PageBlock): number | null {
  const todo = scopedParent(db, page, block.todo_id);
  return todo ? completionStats(db, todo)?.streak ?? null : null;
}
