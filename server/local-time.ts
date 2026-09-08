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
