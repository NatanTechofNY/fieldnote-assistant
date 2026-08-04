import { createHash } from "node:crypto";

export type ReflectionPreset = "today" | "week" | "month" | "custom";

export interface ReflectionPeriod {
  preset: ReflectionPreset;
  key: string;
  label: string;
  start: string;
  endExclusive: string;
  startDate: string;
  endDate: string;
  timezone: string;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function timezoneOffsetMs(date: Date, timezone: string): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find(part => part.type === "timeZoneName")?.value;
  if (!value || value === "GMT" || value === "UTC") return 0;
  const match = value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "+" ? 1 : -1) * minutes * 60_000;
}

function localMidnightIso(date: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  instant = new Date(wallClock - timezoneOffsetMs(instant, timezone));
  return instant.toISOString();
}

function dateFromUtc(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return dateFromUtc(new Date(Date.UTC(year, month - 1, day + days)));
}

function localDate(timezone: string, at: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function displayRange(startDate: string, endDate: string, timezone: string): string {
  const format = (date: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: startDate.slice(0, 4) === endDate.slice(0, 4) ? undefined : "numeric",
  }).format(new Date(localMidnightIso(date, timezone)));
  return startDate === endDate ? format(startDate) : `${format(startDate)}–${format(endDate)}`;
}

export function reflectionPeriod(
  preset: ReflectionPreset,
  timezone: string,
  options: { startDate?: string; endDate?: string; at?: Date } = {},
): ReflectionPeriod {
  const today = localDate(timezone, options.at || new Date());
  let startDate = today;
  let endDate = today;
  if (preset === "week") {
    const [year, month, day] = today.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    startDate = addDays(today, -((weekday + 6) % 7));
    endDate = addDays(startDate, 6);
  } else if (preset === "month") {
    startDate = `${today.slice(0, 7)}-01`;
    const [year, month] = startDate.split("-").map(Number);
    endDate = addDays(dateFromUtc(new Date(Date.UTC(year, month, 1))), -1);
  } else if (preset === "custom") {
    if (!options.startDate || !options.endDate
      || !datePattern.test(options.startDate) || !datePattern.test(options.endDate)) {
      throw new Error("Custom reflections require valid start_date and end_date values");
    }
    startDate = options.startDate;
    endDate = options.endDate;
    if (startDate > endDate) throw new Error("start_date must be on or before end_date");
  }
  const endExclusiveDate = addDays(endDate, 1);
  const key = preset === "today"
    ? `day:${startDate}`
    : preset === "week"
      ? `week:${startDate}`
      : preset === "month"
        ? `month:${startDate.slice(0, 7)}`
        : `range:${startDate}_${endDate}`;
  return {
    preset,
    key,
    label: `${preset === "today" ? "Today" : preset === "week" ? "This week" : preset === "month" ? "This month" : "Custom"} · ${displayRange(startDate, endDate, timezone)}`,
    start: localMidnightIso(startDate, timezone),
    endExclusive: localMidnightIso(endExclusiveDate, timezone),
    startDate,
    endDate,
    timezone,
  };
}

export function reflectionScopeKey(
  period: ReflectionPeriod,
  filters: { lifeAreaIds: string[]; categoryIds: string[]; sources: string[] },
): string {
  const scope = JSON.stringify({
    period: period.key,
    lifeAreas: [...filters.lifeAreaIds].sort(),
    categories: [...filters.categoryIds].sort(),
    sources: [...filters.sources].sort(),
  });
  return `reflection:${createHash("sha256").update(scope).digest("hex").slice(0, 20)}`;
}
