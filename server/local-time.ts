/*
 * Building a DateTimeFormat costs more than using one, and a streak walk or a
 * roll over every repeating todo asks the same zone hundreds of times, so each
 * zone's formatter is built once and kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The wall clock in the user's own timezone. Scheduling compares against it,
 * and anything the agent is told about "today" has to agree with it, otherwise a
 * digest sent at 07:30 local reasons about a UTC date that has already turned
 * over.
 */
export function localParts(date: Date, timezone: string): { date: string; time: string } {
  const parts = formatterFor(timezone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

/**
 * The instant written as the user's own wall clock with its UTC offset, e.g.
 * `2026-09-08T13:20:09-04:00`. This is the shape the agent is asked to write
 * back for every date-time, so handing it the current moment in that exact
 * shape anchors both the clock and the offset it should use. A model given only
 * the UTC instant tends to convert a local time to UTC and then append the
 * local offset as well, landing four hours late.
 */
export function localIsoWithOffset(date: Date, timezone: string): string {
  const { date: day, time } = localParts(date, timezone);
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const offsetMinutes = Math.round((wallClockMillis(day, time) - Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(),
  )) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetMinutes);
  const hours = String(Math.floor(magnitude / 60)).padStart(2, "0");
  const minutes = String(magnitude % 60).padStart(2, "0");
  return `${day}T${time}:${seconds}${sign}${hours}:${minutes}`;
}

/** A local `YYYY-MM-DD` and `HH:MM` read as if they were UTC, in epoch milliseconds. */
function wallClockMillis(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

/**
 * The instant at which a wall clock in `timezone` reads `date` `time`. The
 * inverse of `localParts`: guess that the wall clock is UTC, read what the zone
 * says at that guess, and shift by the difference. Two passes settle the guess
 * across a DST change. A time that does not exist on that day (inside the
 * spring-forward gap) resolves forward, to the same distance past the hour the
 * clocks jumped to, so the result is never on the day before the one asked for
 * — which matters in zones whose clocks jump at midnight.
 */
export function zonedToInstant(date: string, time: string, timezone: string): Date {
  const target = wallClockMillis(date, time);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(guess), timezone);
    const offset = wallClockMillis(local.date, local.time) - guess;
    guess = target - offset;
  }
  const settled = localParts(new Date(guess), timezone);
  const landed = wallClockMillis(settled.date, settled.time);
  if (landed < target) guess += target - landed;
  return new Date(guess);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday a local `YYYY-MM-DD` falls on. A calendar date has one in every zone, so no zone is needed. */
export function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * A local date with its weekday in front, `Friday, 2026-10-16`. A model given
 * only the digits has to work the weekday out, and one that got it wrong wrote
 * "happy Monday" into a Friday's morning check-in.
 */
export function dayWithWeekday(date: string): string {
  return `${weekdayOf(date)}, ${date}`;
}

/** The sentence every scheduled turn's context opens its date with: `Today is Friday, 2026-10-16 in America/New_York.` */
export function todayIs(date: string, timezone: string): string {
  return `Today is ${dayWithWeekday(date)} in ${timezone}.`;
}

/** The weekday it is now in a zone. */
export function todayWeekday(timezone: string, at: Date = new Date()): string {
  return weekdayOf(localParts(at, timezone).date);
}

/**
 * Whether a title names a weekday other than `today`'s: a GIF captioned "Happy
 * Monday" has no place in a Friday's message. A title that names today as well
 * ("Friday, not Monday") is left alone, and so are "Mon", "Tues" and the like,
 * since short forms are as often something else.
 */
export function namesOtherWeekday(title: string, today: string): boolean {
  const named = (days: string[]) => new RegExp(`\\b(?:${days.join("|")})s?\\b`, "i").test(title);
  return named(WEEKDAYS.filter(day => day !== today)) && !named([today]);
}
