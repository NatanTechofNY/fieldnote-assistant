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

export function describeLead(lead: number | null | undefined): string {
  if (lead === null || lead === undefined) return "No text";
  const known = LEAD_OPTIONS.find(option => option.value === lead);
  if (known) return known.label;
  if (lead % 1440 === 0) return `${lead / 1440} days before`;
  if (lead % 60 === 0) return `${lead / 60} hours before`;
  return `${lead} minutes before`;
}
