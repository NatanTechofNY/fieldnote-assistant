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

/*
 * The refusals both the REST routes and the agent tools give. They share a
 * prefix because the agent route maps it to a 400: the request has to change,
 * not retry.
 */
export const REPEATING_SUBTASK = "A repeating todo cannot be filed under another task";
export const REPEATING_PARENT = "A repeating todo cannot have subtasks, and a task with subtasks cannot repeat";
export const DERIVED_SCHEDULE = "A repeating todo's due_at and reminder_at come from its rule; change recurrence to move them";
export const DERIVED_REMINDER = "A repeating todo's due time and reminder come from its rule; change recurrence to move or remove them";

const DAY_MS = 86_400_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The stored rule, or null when the column is empty or does not hold a rule
 * the rest of this module can walk. A malformed rule is treated as no rule
 * rather than thrown on, so one bad row cannot stop the worker or a detail
 * view for every other todo.
 */
export function parseRecurrence(json: string | null | undefined): RecurrenceRule | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<RecurrenceRule> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.freq !== "daily" && parsed.freq !== "weekly") return null;
    if (typeof parsed.time !== "string" || !TIME.test(parsed.time)) return null;
    const interval = Number.isInteger(parsed.interval) && (parsed.interval as number) >= 1 ? parsed.interval as number : 1;
    const weekdays = Array.isArray(parsed.weekdays)
      ? [...new Set(parsed.weekdays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
      : [];
    if (parsed.freq === "weekly" && weekdays.length === 0) return null;
    const lead = parsed.lead_minutes;
    return {
      freq: parsed.freq,
      interval,
      weekdays: parsed.freq === "weekly" ? weekdays : [],
      time: parsed.time,
      lead_minutes: Number.isInteger(lead) && (lead as number) >= 0 ? lead as number : null,
      ...(typeof parsed.anchor_date === "string" ? { anchor_date: parsed.anchor_date } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a reminder of this kind on the todo is a projection of its rule.
 * The `due` and `pre` rows of a repeating todo are rewritten from the rule on
 * every roll, so moving or deleting them directly would either be undone at
 * midnight or, for a deleted due date, take the row off the series for good.
 * An escalation belongs to the one occurrence and can be edited freely.
 */
export function isDerivedReminder(
  todo: Pick<TodoRow, "recurrence_json">,
  kind: "due" | "pre" | "escalation",
): boolean {
  return kind !== "escalation" && parseRecurrence(todo.recurrence_json) !== null;
}

/** Whole days since the epoch for a `YYYY-MM-DD` string. */
function dayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateFromIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateFromIndex(dayIndex(date) + days);
}

/** Sunday = 0 through Saturday = 6, for a `YYYY-MM-DD` string. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The index of the Sunday that starts the week holding `date`. */
function weekStart(date: string): number {
  return dayIndex(date) - weekdayOf(date);
}

function intervalOf(rule: RecurrenceRule): number {
  return Math.max(1, Math.floor(rule.interval) || 1);
}

/**
 * The longest run of days the rule can go without an occurrence, plus a week
 * of slack for where the scan starts. Sized to the rule rather than fixed, so
 * every rule the schema admits — up to 365 weeks apart — is found.
 */
function searchDays(rule: RecurrenceRule): number {
  return (rule.freq === "weekly" ? 7 * intervalOf(rule) : intervalOf(rule)) + 7;
}

/**
 * The fewest days between two occurrences of the rule. "Every day" is 1;
 * Mon/Wed/Fri is 2; a single weekday every other week is 14.
 */
export function minGapDays(rule: RecurrenceRule): number {
  const interval = intervalOf(rule);
  if (rule.freq === "daily") return interval;
  const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
  if (days.length === 0) return 7 * interval;
  let gap = 7 * interval - (days[days.length - 1] - days[0]);
  for (let index = 1; index < days.length; index += 1) gap = Math.min(gap, days[index] - days[index - 1]);
  return gap;
}

/**
 * The longest lead the rule can honour. The row only holds one occurrence, and
 * it moves on to the next at the midnight after the previous one, so a reminder
 * has to fall on or after that midnight: for "every day at 9" that is at most 9
 * hours ahead, while a weekly task can be texted the day before.
 */
export function maxLeadMinutes(rule: Pick<RecurrenceRule, "freq" | "interval" | "weekdays" | "time">): number {
  const [hour, minute] = rule.time.split(":").map(Number);
  const minutesIntoDay = (hour || 0) * 60 + (minute || 0);
  return (minGapDays(rule as RecurrenceRule) - 1) * 1440 + minutesIntoDay;
}

/**
 * Whether the rule has an occurrence on a local date. Without an anchor every
 * interval reads as 1, which is also the right answer for a rule that was
 * never phased.
 */
export function occursOn(rule: RecurrenceRule, date: string): boolean {
  const interval = intervalOf(rule);
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

/**
 * The first occurrence whose local date is `date` or later. Decided on dates
 * alone, so a zone whose clocks jump at midnight cannot pull the answer back
 * on to the day before.
 */
export function firstOccurrenceOnOrAfter(rule: RecurrenceRule, date: string, timezone: string): Date {
  const limit = searchDays(rule);
  for (let offset = 0; offset <= limit; offset += 1) {
    const candidate = addDays(date, offset);
    if (occursOn(rule, candidate)) return zonedToInstant(candidate, rule.time, timezone);
  }
  throw new Error("Recurrence rule has no upcoming occurrence");
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(rule: RecurrenceRule, after: Date, timezone: string): Date {
  const start = localParts(after, timezone).date;
  const limit = searchDays(rule);
  for (let offset = 0; offset <= limit; offset += 1) {
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
  const limit = searchDays(rule);
  for (let offset = 0; offset <= limit; offset += 1) {
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

/**
 * The `due_at` and `reminder_at` a row should carry for its next occurrence:
 * the first strictly after an instant, or the first on or after a local date.
 */
export function materializeRecurrence(
  rule: RecurrenceRule,
  timezone: string,
  from: Date | { date: string } = new Date(),
): { due_at: string; reminder_at: string | null } {
  const due = from instanceof Date
    ? nextOccurrence(rule, from, timezone)
    : firstOccurrenceOnOrAfter(rule, from.date, timezone);
  const reminder = rule.lead_minutes === null || rule.lead_minutes === undefined
    ? null
    : new Date(due.getTime() - rule.lead_minutes * 60_000).toISOString();
  return { due_at: due.toISOString(), reminder_at: reminder };
}

/** Whether two rules describe the same series, anchor included. */
function sameRule(a: RecurrenceRule, b: RecurrenceRule): boolean {
  return a.freq === b.freq
    && intervalOf(a) === intervalOf(b)
    && a.time === b.time
    && (a.lead_minutes ?? null) === (b.lead_minutes ?? null)
    && (a.anchor_date ?? null) === (b.anchor_date ?? null)
    && a.weekdays.length === b.weekdays.length
    && [...a.weekdays].sort((x, y) => x - y).every((day, index) => day === [...b.weekdays].sort((x, y) => x - y)[index]);
}

/**
 * What a create or update should write for the schedule columns, given the
 * `recurrence` it carried. `undefined` means the request did not mention the
 * rule: a row that has one keeps it and keeps its derived times. `null` clears
 * the rule and leaves the current occurrence in place as a one-off. A rule
 * identical to the stored one is the same as not mentioning it — the editor
 * sends the whole form back on every save, and renaming a task must not move
 * its occurrence. A rule that actually differs computes the next occurrence
 * from now, and `occurrenceMoved` says so, so the caller can open the new
 * occurrence rather than carry a finished status on to it.
 */
export function planRecurrenceWrite(
  incoming: RecurrenceRule | Omit<RecurrenceRule, "anchor_date"> | null | undefined,
  current: Pick<TodoRow, "recurrence_json" | "due_at" | "reminder_at" | "extra_reminders_json"> | undefined,
  timezone: string,
  now = new Date(),
): {
  recurrence_json: string | null;
  derived: { due_at: string | null; reminder_at: string | null; extra_reminders_json: string } | null;
  occurrenceMoved: boolean;
} {
  const previous = parseRecurrence(current?.recurrence_json);
  const keep = () => ({
    recurrence_json: current?.recurrence_json ?? null,
    derived: current && previous ? {
      due_at: current.due_at,
      reminder_at: current.reminder_at,
      extra_reminders_json: current.extra_reminders_json,
    } : null,
    occurrenceMoved: false,
  });
  if (incoming === undefined) return keep();
  if (incoming === null) return { recurrence_json: null, derived: null, occurrenceMoved: false };
  const anchored = anchorRecurrence(incoming, previous, timezone, now);
  if (previous && current?.due_at && sameRule(anchored, previous)) return keep();
  const times = materializeRecurrence(anchored, timezone, now);
  return {
    recurrence_json: JSON.stringify(anchored),
    derived: { ...times, extra_reminders_json: "[]" },
    occurrenceMoved: Boolean(current) && times.due_at !== current?.due_at,
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
 * user has not reached yet today. Completions are matched on their local date
 * rather than their instant: moving the time from 8 to 9, or the user moving
 * timezone, does not make the days already done stop counting.
 */
export function completionStreak(
  rule: RecurrenceRule,
  completedOccurrences: Iterable<string>,
  currentDueAt: string | null,
  timezone: string,
  now = new Date(),
): number {
  const completed = new Set([...completedOccurrences].map(value => localParts(new Date(value), timezone).date));
  if (!completed.size) return 0;
  let streak = 0;
  // The row's current occurrence is the one still in play: it counts when it
  // is done, and is stepped over rather than counted as a miss when it is not.
  let cursor = currentDueAt ? new Date(currentDueAt) : now;
  if (currentDueAt && completed.has(localParts(cursor, timezone).date)) streak += 1;
  // Bounded by the log itself: the walk ends at the first occurrence with no
  // record, so it can never run past the oldest completion.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const previous = previousOccurrence(rule, cursor, timezone);
    if (!completed.has(localParts(previous, timezone).date)) break;
    streak += 1;
    cursor = previous;
  }
  return streak;
}
