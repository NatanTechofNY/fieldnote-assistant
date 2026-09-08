import type { Recurrence } from "../types";
import { humanTime } from "./timezone";

export const WEEKDAYS = [
  { value: 0, short: "Sun", long: "Sunday" },
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
] as const;

/** The reminder offsets the editor offers; anything else is still shown by `describeLead`. */
export const LEAD_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "No text" },
  { value: 0, label: "At the time" },
  { value: 5, label: "5 minutes before" },
  { value: 10, label: "10 minutes before" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 1440, label: "1 day before" },
];

/** The fewest days between two occurrences: 1 for daily, 2 for Mon/Wed/Fri, 14 for one day every other week. */
function minGapDays(rule: Pick<Recurrence, "freq" | "interval" | "weekdays">): number {
  const interval = Math.max(1, rule.interval || 1);
  if (rule.freq === "daily") return interval;
  const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
  if (days.length === 0) return 7 * interval;
  let gap = 7 * interval - (days[days.length - 1] - days[0]);
  for (let index = 1; index < days.length; index += 1) gap = Math.min(gap, days[index] - days[index - 1]);
  return gap;
}

/**
 * The longest lead the rule can honour, mirroring the server's rule: the task
 * moves on to its next occurrence at the midnight after the previous one, so a
 * text further ahead than that would already be late when it was scheduled.
 */
export function maxLeadMinutes(rule: Pick<Recurrence, "freq" | "interval" | "weekdays" | "time">): number {
  const [hour, minute] = rule.time.split(":").map(Number);
  return (minGapDays(rule) - 1) * 1440 + (hour || 0) * 60 + (minute || 0);
}

/** "Every day at 8:00 AM", "Every 2 days at 8:00 AM", "Mon, Wed, Fri at 9:00 PM". */
export function describeRecurrence(rule: Recurrence): string {
  const at = `at ${humanTime(rule.time)}`;
  const interval = Math.max(1, rule.interval || 1);
  if (rule.freq === "daily") {
    return interval === 1 ? `Every day ${at}` : `Every ${interval} days ${at}`;
  }
  const days = [...rule.weekdays].sort((a, b) => a - b);
  const names = days.length === 7
    ? "Every day"
    : days.length === 5 && days.join() === "1,2,3,4,5"
      ? "Weekdays"
      : days.map(day => WEEKDAYS[day]?.short ?? "").filter(Boolean).join(", ");
  const cadence = interval === 1 ? "" : interval === 2 ? " every other week" : ` every ${interval} weeks`;
  return `${names}${cadence} ${at}`;
}

/** "No text", "At the time", "15 minutes before", "2 days before". */
export function describeLead(lead: number | null | undefined): string {
  if (lead === null || lead === undefined) return "No text";
  const known = LEAD_OPTIONS.find(option => option.value === lead);
  if (known) return known.label;
  if (lead % 1440 === 0) return `${lead / 1440} days before`;
  if (lead % 60 === 0) return `${lead / 60} hours before`;
  return `${lead} minutes before`;
}
