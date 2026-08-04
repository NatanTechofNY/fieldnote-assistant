import { createContext, useContext } from "react";

export const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Every date in the UI is rendered in the user's configured timezone rather
 * than the browser's, so that a reminder set from a laptop abroad still reads
 * back the way it was scheduled.
 */
export const TimezoneContext = createContext(browserTimezone);
export const useTimezone = () => useContext(TimezoneContext);

export const timezoneNames = (() => {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const supported = intl.supportedValuesOf?.("timeZone") || [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "Europe/London", "Europe/Paris", "Asia/Tokyo", "Australia/Sydney",
  ];
  return [...new Set(["UTC", browserTimezone, ...supported])];
})();

export function humanTime(value: string): string {
  const [hours = "0", minutes = "0"] = value.split(":");
  const date = new Date(2000, 0, 1, Number(hours), Number(minutes));
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * Mirrors the worker's own quiet-hours test so the UI can warn about a send time
 * that would be skipped. A window that wraps midnight is the normal case, hence
 * the second branch; an unset or zero-length window silences nothing.
 */
export function withinQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function zonedParts(value: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).map(part => [part.type, part.value]));
}

export function zonedDateKey(value: Date, timezone: string): string {
  const parts = zonedParts(value, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function friendlyDate(value: string | null | undefined, timezone: string) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "2-digit",
  }).format(date);
  if (zonedDateKey(date, timezone) === zonedDateKey(new Date(), timezone)) return `Today, ${time}`;
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
  }).format(date);
  return `${day} · ${time}`;
}

/**
 * A due date carries no all-day flag, so a task captured from "tomorrow" lands
 * on midnight. Printing "12:00 AM" reads as a deadline the user never set, so a
 * due date sitting exactly on midnight shows the day alone.
 */
export function friendlyDueDate(value: string | null | undefined, timezone: string) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  const parts = zonedParts(date, timezone);
  if (parts.hour !== "00" || parts.minute !== "00") return friendlyDate(value, timezone);
  if (zonedDateKey(date, timezone) === zonedDateKey(new Date(), timezone)) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
  }).format(date);
}

export function toZonedDateTimeLocal(value: string | null | undefined, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function timezoneOffsetMs(date: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find(part => part.type === "timeZoneName")?.value;
  if (!name || name === "GMT" || name === "UTC") return 0;
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "+" ? 1 : -1) * minutes * 60_000;
}

export function zonedDateTimeLocalToIso(value: string, timezone: string): string {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  // Applied twice because the offset itself depends on the instant, which is
  // only known approximately until the first correction lands.
  let instant = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  instant = new Date(wallClock - timezoneOffsetMs(instant, timezone));
  return instant.toISOString();
}

export function timezoneLabel(timezone: string): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, timeZoneName: "shortOffset",
  }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value || "";
  return `${timezone.replaceAll("_", " ")}${offset ? ` (${offset})` : ""}`;
}

export function historyTimestamp(value: string, timezone: string): string {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric", year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "2-digit",
  }).format(date);
  return `${day} · ${time}`;
}
