/**
 * The calendar file a page offers: a countdown's moment, or the best slot of a
 * closed pick-a-time poll. Slot labels are words ("Thu Oct 15", "7pm"), so the
 * poll's date is read back out of them on a best-effort basis and a label that
 * cannot be read simply yields no event.
 */
import { localParts, zonedToInstant } from "./local-time.ts";
import { userTimezone } from "./db.ts";
import { pageBlocks, pageIsLive, pollResults, type PageRow } from "./pages.ts";
import type { Db } from "./types.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Thu Oct 15" plus "7pm" / "7:30 pm" / "19:00" as an instant in `timezone`, in the next 12 months. */
export function labelInstant(day: string, slot: string | null, timezone: string, from: Date = new Date()): Date | null {
  const date = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(day);
  const month = date ? MONTHS.indexOf(date[1].toLowerCase()) : -1;
  if (!date || month < 0) return null;
  let hour = 9;
  let minute = 0;
  if (slot) {
    const time = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i.exec(slot);
    if (!time) return null;
    hour = Number(time[1]);
    minute = Number(time[2] ?? 0);
    const meridiem = time[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  const year = Number(localParts(from, timezone).date.slice(0, 4));
  for (const candidate of [year, year + 1]) {
    const pad = (value: number) => String(value).padStart(2, "0");
    const instant = zonedToInstant(`${candidate}-${pad(month + 1)}-${pad(Number(date[2]))}`, `${pad(hour)}:${pad(minute)}`, timezone);
    if (instant.getTime() >= from.getTime() - 7 * 86_400_000) return instant;
  }
  return null;
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escapeText = (value: string): string => value.replace(/[\\;,]/g, match => `\\${match}`).replace(/\r?\n/g, "\\n");

export function pageCalendar(db: Db, page: PageRow): string | null {
  if (!pageIsLive(page)) return null;
  const timezone = userTimezone(db);
  const events: Array<{ start: Date; summary: string }> = [];
  const results = pollResults(db, page);
  for (const block of pageBlocks(page)) {
    if (block.type === "countdown" && block.when) events.push({ start: new Date(block.when), summary: block.text || page.title });
    if (block.type === "availability") {
      // Only once the poll is closed: until then there is no "when" to put in a calendar.
      const result = results.find(entry => entry.block_id === block.id);
      const leader = result?.closed ? result.leaders[0] : undefined;
      if (!leader) continue;
      const [day, slot] = leader.split(" · ");
      const start = labelInstant(day, slot ?? null, timezone);
      if (start) events.push({ start, summary: page.title });
    }
  }
  if (!events.length) return null;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fieldnote//Pages//EN", "CALSCALE:GREGORIAN"];
  for (const [index, event] of events.entries()) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${page.id}-${index}@fieldnote`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(event.start)}`,
      `DTEND:${stamp(new Date(event.start.getTime() + 60 * 60_000))}`,
      `SUMMARY:${escapeText(event.summary)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
