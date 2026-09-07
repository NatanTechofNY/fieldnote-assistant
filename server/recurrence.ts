import { localParts, zonedToInstant } from "./local-time.ts";
import type { TodoRow } from "./types.ts";

/**
 * How a repeating todo repeats. The rule is written in the user's wall clock:
 * `time` is a local `HH:MM`, and which days count is decided on local dates,
 * so "every day at 8" keeps meaning 8 o'clock across a DST change. The row's
 * `due_at` and `reminder_at` are projections of this rule for one occurrence,
 * and are recomputed from it rather than edited directly.
 */
export interface RecurrenceRule {
  freq: "daily" | "weekly";
  /** Every N days for `daily`, every N weeks for `weekly`. */
  interval: number;
  /** Days of the week that count for `weekly`, Sunday = 0. Empty for `daily`. */
  weekdays: number[];
  /** Local wall-clock time, `HH:MM`. */
  time: string;
  /** Minutes before `time` to text; 0 texts at the time, null never texts. */
  lead_minutes: number | null;
  /**
   * The local date the series counts from. Set by the server when the rule is
   * written, so "every 2 days" and "every other week" have a fixed phase.
   */
  anchor_date?: string;
}

const DAY_MS = 86_400_000;
/** Far enough to find a match for any rule this module accepts. */
const SEARCH_DAYS = 400;

export function parseRecurrence(json: string | null | undefined): RecurrenceRule | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as RecurrenceRule;
    return parsed && typeof parsed === "object" && parsed.freq ? parsed : null;
  } catch {
    return null;
  }
}

/** Whole days since the epoch for a `YYYY-MM-DD` string. */
function dayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateFromIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateFromIndex(dayIndex(date) + days);
}

/** Sunday = 0 through Saturday = 6, for a `YYYY-MM-DD` string. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The index of the Sunday that starts the week holding `date`. */
function weekStart(date: string): number {
  return dayIndex(date) - weekdayOf(date);
}

/**
 * Whether the rule has an occurrence on a local date. Without an anchor every
 * interval reads as 1, which is also the right answer for a rule that was
 * never phased.
 */
export function occursOn(rule: RecurrenceRule, date: string): boolean {
  const interval = Math.max(1, Math.floor(rule.interval) || 1);
  if (rule.freq === "daily") {
    if (interval === 1 || !rule.anchor_date) return true;
    const distance = dayIndex(date) - dayIndex(rule.anchor_date);
    return ((distance % interval) + interval) % interval === 0;
  }
  if (!rule.weekdays.includes(weekdayOf(date))) return false;
  if (interval === 1 || !rule.anchor_date) return true;
  const weeks = Math.floor((weekStart(date) - weekStart(rule.anchor_date)) / 7);
  return ((weeks % interval) + interval) % interval === 0;
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(rule: RecurrenceRule, after: Date, timezone: string): Date {
  const start = localParts(after, timezone).date;
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = addDays(start, offset);
    if (!occursOn(rule, date)) continue;
    const instant = zonedToInstant(date, rule.time, timezone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error("Recurrence rule has no upcoming occurrence");
}

/** The last occurrence strictly before `before`. */
export function previousOccurrence(rule: RecurrenceRule, before: Date, timezone: string): Date {
  const start = localParts(before, timezone).date;
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = addDays(start, -offset);
    if (!occursOn(rule, date)) continue;
    const instant = zonedToInstant(date, rule.time, timezone);
    if (instant.getTime() < before.getTime()) return instant;
  }
  throw new Error("Recurrence rule has no earlier occurrence");
}

/**
 * The rule as it should be stored. A new series is phased from its first
 * occurrence, so "every 2 days at 8" created at 9 in the morning counts from
 * tomorrow rather than skipping to the day after. A rule that only changed
 * its time or days keeps the phase it already had; changing the cadence
 * itself starts a new one.
 */
export function anchorRecurrence(
  rule: RecurrenceRule,
  previous: RecurrenceRule | null,
  timezone: string,
  from = new Date(),
): RecurrenceRule {
  const { anchor_date: _dropped, ...incoming } = rule;
  if (previous?.anchor_date && previous.freq === rule.freq && previous.interval === rule.interval) {
    return { ...incoming, anchor_date: previous.anchor_date };
  }
  const today = localParts(from, timezone).date;
  const anchorDate = zonedToInstant(today, rule.time, timezone).getTime() > from.getTime()
    ? today
    : addDays(today, 1);
  return { ...incoming, anchor_date: anchorDate };
}

/** The `due_at` and `reminder_at` a row should carry for its next occurrence. */
export function materializeRecurrence(
  rule: RecurrenceRule,
  timezone: string,
  from = new Date(),
): { due_at: string; reminder_at: string | null } {
  const due = nextOccurrence(rule, from, timezone);
  const reminder = rule.lead_minutes === null || rule.lead_minutes === undefined
    ? null
    : new Date(due.getTime() - rule.lead_minutes * 60_000).toISOString();
  return { due_at: due.toISOString(), reminder_at: reminder };
}

/**
 * What a create or update should write for the schedule columns, given the
 * `recurrence` it carried. `undefined` means the request did not mention the
 * rule: a row that has one keeps it and keeps its derived times, whatever the
 * request said about `due_at`, because the calendar drag and the agent both
 * patch that field without meaning to break the series. `null` clears the rule
 * and leaves the current occurrence in place as a one-off. A rule computes the
 * next occurrence from now.
 */
export function planRecurrenceWrite(
  incoming: RecurrenceRule | Omit<RecurrenceRule, "anchor_date"> | null | undefined,
  current: Pick<TodoRow, "recurrence_json" | "due_at" | "reminder_at" | "extra_reminders_json"> | undefined,
  timezone: string,
  now = new Date(),
): {
  recurrence_json: string | null;
  derived: { due_at: string | null; reminder_at: string | null; extra_reminders_json: string } | null;
} {
  const previous = parseRecurrence(current?.recurrence_json);
  if (incoming === undefined) {
    if (!previous || !current) return { recurrence_json: current?.recurrence_json ?? null, derived: null };
    // The schedule columns are held as they are, extras included: an extra
    // reminder added for this occurrence through the reminder tools belongs
    // to it until the worker rolls the row on, not until the next unrelated edit.
    return {
      recurrence_json: current.recurrence_json,
      derived: {
        due_at: current.due_at,
        reminder_at: current.reminder_at,
        extra_reminders_json: current.extra_reminders_json,
      },
    };
  }
  if (incoming === null) return { recurrence_json: null, derived: null };
  const anchored = anchorRecurrence(incoming, previous, timezone, now);
  const times = materializeRecurrence(anchored, timezone, now);
  return {
    recurrence_json: JSON.stringify(anchored),
    derived: { ...times, extra_reminders_json: "[]" },
  };
}

/** The rule as it is shown to clients: the anchor is bookkeeping, not input. */
export function recurrenceJson(rule: RecurrenceRule): Omit<RecurrenceRule, "anchor_date"> {
  return {
    freq: rule.freq,
    interval: rule.interval,
    weekdays: rule.weekdays,
    time: rule.time,
    lead_minutes: rule.lead_minutes ?? null,
  };
}

/**
 * How many occurrences in a row, counting back from the latest one that is
 * over, were completed. The current occurrence counts when it is done and is
 * skipped while it is still open, so a streak is never broken by the task the
 * user has not reached yet today.
 */
export function completionStreak(
  rule: RecurrenceRule,
  completedOccurrences: Iterable<string>,
  currentDueAt: string | null,
  timezone: string,
  now = new Date(),
): number {
  const completed = new Set([...completedOccurrences].map(value => new Date(value).getTime()));
  if (!completed.size) return 0;
  let streak = 0;
  // The row's current occurrence is the one still in play: it counts when it
  // is done, and is stepped over rather than counted as a miss when it is not.
  let cursor = currentDueAt ? new Date(currentDueAt) : now;
  if (currentDueAt && completed.has(cursor.getTime())) streak += 1;
  // Bounded by the log itself: the walk ends at the first occurrence with no
  // record, so it can never run past the oldest completion.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const previous = previousOccurrence(rule, cursor, timezone);
    if (!completed.has(previous.getTime())) break;
    streak += 1;
    cursor = previous;
  }
  return streak;
}
