import { recentMemoryContext } from "./checkin-context.ts";
import { DEFAULT_GROUP_EVENING_ASK, DEFAULT_GROUP_MORNING_ASK, renderAsk } from "./checkin-prompts.ts";
import { USER_ID } from "./db.ts";
import { getNotificationPreferences } from "./integrations.ts";
import { OWNER_SPEAKER_NAME } from "./group-thread.ts";
import { localParts } from "./local-time.ts";
import type { Db } from "./types.ts";

/** Enough to name a busy weekend without the note turning into a list. */
const ITEM_LIMIT = 10;

/** Statuses that still want attention; the list is defined by what is not finished. */
const OPEN_STATUSES = new Set(["pending", "in_progress", "blocked"]);

type CheckinTodoRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  completed_at: string | null;
};

/**
 * A group's area, as the check-ins need it: where its records are, where the
 * note goes, and the owner's wording for each ask when there is one.
 */
export type CheckinArea = {
  id: string;
  name: string;
  groupId: string;
  morningAsk?: string | null;
  eveningAsk?: string | null;
};

/** The local calendar day after `date` (`YYYY-MM-DD`). */
function dayAfter(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/** `Sun 9:00 PM`, the way a person would say when something is due. */
function friendlyDue(due: { date: string; time: string }): string {
  const weekday = new Date(`${due.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const [hour, minute] = due.time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const clock = `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
  return `${weekday} ${clock}`;
}

/**
 * What a group's morning note is about: work still going, and work due soon.
 *
 * A task in progress is named whatever its date, because someone has started it
 * and the room may want to know it is still open — the laundry that is due
 * Sunday but has been "in progress" since Thursday. A task not yet started is
 * named only when it is due by tomorrow or already late; a long untouched
 * backlog is not a morning's news. Steps are left to their tasks. Ordered as
 * urgency reads: overdue, today, tomorrow, then the rest by date.
 */
export function groupCheckinItems(
  db: Db,
  areaId: string,
  date: string,
  timezone: string,
): { lines: string[]; more: number } {
  const tomorrow = dayAfter(date);
  const rows = (db.prepare(`
    SELECT id,title,status,due_at,completed_at FROM todos
    WHERE user_id=? AND life_area_id=? AND parent_id IS NULL
    ORDER BY due_at IS NULL,due_at,title
  `).all(USER_ID, areaId) as CheckinTodoRow[]).filter(todo => OPEN_STATUSES.has(todo.status));
  const items: Array<{ rank: number; when: string; line: string }> = [];
  for (const todo of rows) {
    const due = todo.due_at ? localParts(new Date(todo.due_at), timezone) : null;
    const dueSoon = due !== null && due.date <= tomorrow;
    if (todo.status !== "in_progress" && !dueSoon) continue;
    const bucket = !due ? "no date" : due.date < date ? "overdue" : due.date === date ? "due today" : due.date === tomorrow ? "due tomorrow" : "due later";
    const rank = ["overdue", "due today", "due tomorrow", "due later", "no date"].indexOf(bucket);
    const facts = [
      todo.status === "in_progress" ? "in progress" : todo.status === "blocked" ? "blocked" : "not started",
      due ? `${bucket}, ${friendlyDue(due)} (${due.date} ${due.time})` : bucket,
    ].join("; ");
    items.push({ rank, when: due ? `${due.date} ${due.time}` : "9999", line: `- "${todo.title}" — ${facts}` });
  }
  items.sort((a, b) => a.rank - b.rank || a.when.localeCompare(b.when));
  return { lines: items.slice(0, ITEM_LIMIT).map(item => item.line), more: Math.max(items.length - ITEM_LIMIT, 0) };
}

/** Everyone the app can name in a group: the trusted contacts, and the recipient as the owner. */
function participantNames(db: Db): string[] {
  const preferences = getNotificationPreferences(db);
  return [...preferences.trustedContacts.map(contact => contact.name), OWNER_SPEAKER_NAME];
}

/**
 * The turn a group's morning note is composed from. The request leads — the
 * owner's wording or the default — and what the app looked up follows as
 * clearly labelled context, the digest's shape, so the agent cannot mistake
 * the list for part of the ask. The no-tools rule sits in the context so a
 * rewording cannot drop it. Empty lists never get here: the worker sends
 * nothing on a morning with nothing to say.
 */
export function composeGroupMorningTurn(
  db: Db,
  area: CheckinArea,
  context: { date: string; timezone: string },
): string {
  const { lines, more } = groupCheckinItems(db, area.id, context.date, context.timezone);
  return [
    renderAsk(area.morningAsk, DEFAULT_GROUP_MORNING_ASK, area.name),
    "",
    `--- Context supplied by the app, not by anyone in the chat. Today is ${context.date} in ${context.timezone}.`,
    "This turn uses no tools; the rows below are exact, so use these titles and times as given.",
    "Open in this group, in progress or due by tomorrow:",
    ...lines,
    ...more ? [`(+${more} more not shown)`] : [],
    ...recentMemoryContext(db, { areaId: area.id }, context.date, context.timezone),
  ].join("\n");
}

/**
 * The turn a group's evening question is composed from. Nothing is written on
 * this turn: the question is the whole of it, and the answers that follow are
 * what the agent records, one shared entry for the day.
 */
export function composeGroupEveningTurn(
  db: Db,
  area: CheckinArea,
  context: { date: string; timezone: string },
): string {
  const localDate = (value: string) => localParts(new Date(value), context.timezone).date;
  const rows = db.prepare(`
    SELECT id,title,status,due_at,completed_at FROM todos
    WHERE user_id=? AND life_area_id=? AND parent_id IS NULL ORDER BY title
  `).all(USER_ID, area.id) as CheckinTodoRow[];
  const finishedToday = rows.filter(todo => todo.completed_at && localDate(todo.completed_at) === context.date);
  // A repeating task done today is logged as an occurrence rather than a completed row.
  const occurrences = (db.prepare(`
    SELECT t.title,c.completed_at FROM todo_completions c JOIN todos t ON t.id=c.todo_id
    WHERE c.user_id=? AND t.life_area_id=? ORDER BY t.title
  `).all(USER_ID, area.id) as Array<{ title: string; completed_at: string }>)
    .filter(row => localDate(row.completed_at) === context.date);
  const finished = [...new Set([...finishedToday, ...occurrences].map(row => row.title))];
  const going = rows.filter(todo => todo.status === "in_progress").map(todo => todo.title);
  return [
    renderAsk(area.eveningAsk, DEFAULT_GROUP_EVENING_ASK, area.name),
    "",
    `--- Context supplied by the app, not by anyone in the chat. Today is ${context.date} in ${context.timezone}.`,
    "This turn uses no tools and saves nothing; the answers that follow are what gets recorded.",
    `People here the app can name: ${participantNames(db).join(", ")}.`,
    finished.length ? `Finished in this group today: ${finished.map(title => `"${title}"`).join(", ")}.` : "Nothing in this group was finished today.",
    going.length ? `Still in progress: ${going.map(title => `"${title}"`).join(", ")}.` : "Nothing is marked in progress.",
    "Mention at most one of these if it helps the question land; do not recite them.",
    ...recentMemoryContext(db, { areaId: area.id }, context.date, context.timezone),
  ].join("\n");
}
