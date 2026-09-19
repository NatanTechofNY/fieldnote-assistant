import { getReminders, OWN_AREA_CLAUSE, USER_ID } from "./db.ts";
import { localParts } from "./local-time.ts";
import type { Db } from "./types.ts";

/** Enough for a morning summary without letting one messy day bloat the turn. */
const TODO_LIMIT = 20;

/**
 * Statuses that still want attention today. `pending` covers the not-started
 * case, and something in progress or blocked is exactly what a morning summary
 * should surface, so the list is defined by what is *not* finished.
 */
const OPEN_STATUSES = new Set(["pending", "in_progress", "blocked"]);

type DigestTodoRow = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  due_at: string | null;
};

/**
 * Today's open todos and the ones left behind on an earlier day. The two lists
 * are built together so a todo that is both overdue and reminding again today
 * is reported once, under today, rather than twice with different framing.
 */
export type DigestTodoLines = { today: string[]; overdue: string[] };

/**
 * Local dates are compared rather than UTC ones: a todo due at 04:00Z is due
 * "today" in New York and "yesterday" in Tokyo, and the digest has to agree
 * with the calendar the user is reading.
 */
export function digestTodoLines(
  db: Db,
  date: string,
  timezone: string,
  options: { includeToday: boolean; includeOverdue: boolean },
): DigestTodoLines {
  const local = (value: string) => localParts(new Date(value), timezone);
  const todos = (db.prepare(`
    SELECT id,title,status,priority,due_at FROM todos WHERE user_id=? ORDER BY due_at IS NULL,due_at,title
  `).all(USER_ID) as DigestTodoRow[]).filter(todo => OPEN_STATUSES.has(todo.status));
  /*
   * `due` rows mirror `due_at` rather than representing a notification, so
   * counting them here would report a due date twice and call it a reminder.
   */
  const todayReminders = new Map<string, string[]>();
  const pastReminders = new Map<string, string[]>();
  for (const reminder of getReminders(db)) {
    if (reminder.kind === "due" || reminder.status === "cancelled") continue;
    const parts = local(reminder.scheduled_for);
    if (parts.date === date) {
      todayReminders.set(reminder.todo_id, [...todayReminders.get(reminder.todo_id) || [], parts.time]);
    } else if (parts.date < date) {
      const stamp = `${parts.date} ${parts.time}`;
      pastReminders.set(reminder.todo_id, [...pastReminders.get(reminder.todo_id) || [], stamp]);
    }
  }
  const today: string[] = [];
  const overdue: { since: string; line: string }[] = [];
  for (const todo of todos) {
    const due = todo.due_at ? local(todo.due_at) : null;
    const reminders = [...new Set(todayReminders.get(todo.id) || [])].sort();
    const label = `"${todo.title}" [${todo.status}${todo.priority ? `, ${todo.priority}` : ""}]`;
    /*
     * A reminder that already fired is the other way a todo goes stale: a
     * date-only nudge with no `due_at` never has a due date to fall behind.
     */
    const missed = [...new Set(pastReminders.get(todo.id) || [])].sort();
    const overdueDue = due && due.date < date ? due : null;
    if ((due?.date === date || reminders.length) && options.includeToday) {
      const facts = [
        due?.date === date ? `due ${due.time}` : null,
        /*
         * Something that reminds again today can still be late, and burying
         * that under a bare reminder time reads as if the deadline is ahead.
         */
        options.includeOverdue && overdueDue ? `overdue since ${overdueDue.date} ${overdueDue.time}` : null,
        reminders.length ? `reminder ${reminders.join(", ")}` : null,
      ].filter(Boolean).join("; ");
      today.push(`- ${label} ${facts}`);
      continue;
    }
    if (!options.includeOverdue || (!overdueDue && !missed.length)) continue;
    const facts = [
      overdueDue ? `due ${overdueDue.date} ${overdueDue.time}` : null,
      missed.length ? `reminder ${missed[missed.length - 1]}` : null,
    ].filter(Boolean).join("; ");
    overdue.push({
      since: [overdueDue ? `${overdueDue.date} ${overdueDue.time}` : null, missed[0]].filter(Boolean)
        .sort()[0] as string,
      line: `- ${label} ${facts}`,
    });
  }
  const budget = Math.max(TODO_LIMIT - today.length, 0);
  return {
    today: today.slice(0, TODO_LIMIT),
    overdue: overdue.sort((a, b) => a.since.localeCompare(b.since)).slice(0, budget)
      .map(entry => entry.line),
  };
}

/**
 * What the app tells the agent when neither list found anything. Silence would
 * invite it to go looking, and an unqualified "your day is clear" is wrong when
 * only one of the two lookups actually ran.
 */
function emptyNote(options: { includeToday: boolean; includeOverdue: boolean }): string {
  const clearToday = "Nothing open is due today and nothing is set to remind me today";
  if (!options.includeToday) {
    return "Nothing is still open from an earlier day, so do not suggest anything is late.";
  }
  return options.includeOverdue
    ? `${clearToday}, and nothing is still open from an earlier day, so say the day is clear on todos`
      + " rather than listing tasks or looking for more."
    : `${clearToday}, so say the day is clear on todos rather than listing tasks or looking for more.`;
}

/**
 * The turn the owner's evening check-in is composed from: the question the
 * prompt's Reflections rules assume was asked the message before. Nothing is
 * written on this turn; the answer that follows is the entry. Group chats'
 * work is left out — a group has its own evening question.
 */
export function composeEveningCheckinTurn(
  db: Db,
  context: { date: string; timezone: string },
): string {
  const localDate = (value: string) => localParts(new Date(value), context.timezone).date;
  const rows = db.prepare(`
    SELECT id,title,status,due_at,completed_at FROM todos
    WHERE user_id=? AND parent_id IS NULL AND ${OWN_AREA_CLAUSE("todos")} ORDER BY title
  `).all(USER_ID) as Array<DigestTodoRow & { completed_at: string | null }>;
  const finished = rows.filter(todo => todo.completed_at && localDate(todo.completed_at) === context.date).map(todo => todo.title);
  const going = rows.filter(todo => todo.status === "in_progress").map(todo => todo.title);
  return [
    "Ask me how today went, in one warm line, asking for a mood word and a number from 1 to 5 with it. Nothing else"
    + " on this turn — no summary, no list, no tools, and nothing saved; my answer is the entry.",
    "",
    `--- Context supplied by the app, not by me. Today is ${context.date} in ${context.timezone}.`,
    finished.length ? `Finished today: ${finished.map(title => `"${title}"`).join(", ")}.` : "Nothing was finished today.",
    going.length ? `Still in progress: ${going.map(title => `"${title}"`).join(", ")}.` : "Nothing is marked in progress.",
    "Mention at most one of these if it helps the question land; do not recite them.",
  ].join("\n");
}

/**
 * The turn the daily digest is delivered as. The request leads and anything the
 * app looked up follows as clearly-labelled context, the same shape a digest
 * brief uses, so the agent cannot mistake the todo list for part of the ask.
 */
export function composeDigestTurn(
  db: Db,
  context: { date: string; timezone: string; includeTodos: boolean; includeOverdue: boolean },
): string {
  const options = { includeToday: context.includeTodos, includeOverdue: context.includeOverdue };
  const { today, overdue } = options.includeToday || options.includeOverdue
    ? digestTodoLines(db, context.date, context.timezone, options)
    : { today: [], overdue: [] };
  const active = getReminders(db)
    .filter(reminder => reminder.status === "pending" && reminder.kind !== "due");
  const carried = overdue.length
    ? ` ${overdue.length} thing${overdue.length === 1 ? " is" : "s are"} still open from an earlier day.`
    : "";
  const lead = active.length
    ? `Prepare my concise daily SMS reminder digest for ${context.date}. I have ${active.length} pending reminder${active.length === 1 ? "" : "s"}.${carried} Use the agenda and todo tools for exact titles and dates.`
    : `Send a concise daily SMS check-in for ${context.date}. I have no pending reminders.${carried}`;
  if (!options.includeToday && !options.includeOverdue) return lead;
  const distinctions = [
    today.length ? "which are due today and which are only reminding me" : null,
    overdue.length ? "which have been carried over from an earlier day" : null,
  ].filter(Boolean).join(", and ");
  return [
    lead,
    "",
    `--- Context supplied by the app, not by me. Today is ${context.date} in ${context.timezone}.`,
    ...today.length ? ["Open todos that are due today or set to remind me today:", ...today] : [],
    ...options.includeToday && !today.length && overdue.length
      ? ["Nothing open is due today and nothing is set to remind me today, but the day is not clear:"
        + " the rows below are still outstanding."]
      : [],
    ...overdue.length
      ? ["Still open from before today, unfinished and already past their date:", ...overdue]
      : [],
    ...today.length || overdue.length
      ? [
        "These rows are exact, so use these titles and times as given rather than looking them up"
        + ` again, and make clear ${distinctions}.`,
      ]
      : [emptyNote(options)],
  ].join("\n");
}
