/**
 * The wall clock in the user's own timezone. Scheduling compares against it,
 * and anything the agent is told about "today" has to agree with it, otherwise a
 * digest sent at 07:30 local reasons about a UTC date that has already turned
 * over.
 */
export function localParts(date: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
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
 * across a DST change; a time that does not exist on that day (inside the
 * spring-forward gap) lands on the hour the zone actually has.
 */
export function zonedToInstant(date: string, time: string, timezone: string): Date {
  const target = wallClockMillis(date, time);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(guess), timezone);
    const offset = wallClockMillis(local.date, local.time) - guess;
    guess = target - offset;
  }
  return new Date(guess);
}
