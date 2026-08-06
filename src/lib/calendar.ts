import type { Todo } from "../types";
import { toZonedDateTimeLocal, zonedDateKey } from "./timezone";

export type ChipKind = "due" | "reminder" | "extra";

/**
 * One thing the calendar draws. A todo carries up to three kinds of time — the
 * deadline, the reminder that actually notifies, and any extras — and each is
 * placed and moved on its own, so each gets its own chip rather than the card
 * the board draws.
 */
export interface ScheduleChip {
  key: string;
  todo: Todo;
  kind: ChipKind;
  /** Empty for a task with no date yet, which sits in the rail until dropped. */
  at: string;
  /** Position in `extra_reminders`, so a moved extra rewrites its own slot. */
  index?: number;
}

export const SLOT_MINUTES = 30;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
/** Where an undated task lands when it is dropped on a day rather than a time. */
export const DEFAULT_TIME = "09:00";

export function chipsFor(todo: Todo): ScheduleChip[] {
  const chips: ScheduleChip[] = [];
  if (todo.due_at) chips.push({ key: `${todo.id}:due`, todo, kind: "due", at: todo.due_at });
  if (todo.reminder_at) chips.push({ key: `${todo.id}:reminder`, todo, kind: "reminder", at: todo.reminder_at });
  for (const [index, at] of (todo.extra_reminders || []).entries()) {
    chips.push({ key: `${todo.id}:extra:${index}`, todo, kind: "extra", at, index });
  }
  return chips;
}

export function unscheduledChip(todo: Todo): ScheduleChip {
  return { key: `${todo.id}:due`, todo, kind: "due", at: "" };
}

const kindRank: Record<ChipKind, number> = { due: 0, reminder: 1, extra: 2 };

export function sortChips(chips: ScheduleChip[]): ScheduleChip[] {
  return [...chips].sort((a, b) =>
    new Date(a.at).getTime() - new Date(b.at).getTime()
    || kindRank[a.kind] - kindRank[b.kind]
    || a.todo.title.localeCompare(b.todo.title));
}

/*
 * Civil-date arithmetic. A day key is `YYYY-MM-DD` and is stepped through as a
 * UTC midnight instant, which never converts between zones and so never gains
 * or loses an hour to a DST boundary. Only the two ends of the trip — reading a
 * stored instant into a day, and writing a chosen day back out — go through the
 * timezone helpers.
 */
const DAY_MS = 86_400_000;

export function dateKeyToUtc(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function utcToDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return utcToDateKey(new Date(dateKeyToUtc(key).getTime() + days * DAY_MS));
}

export function addMonths(key: string, months: number): string {
  const date = dateKeyToUtc(key);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  // Clamped, so paging from the 31st does not skip a short month entirely.
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return utcToDateKey(first);
}

export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function startOfWeek(key: string): string {
  return addDays(key, -dateKeyToUtc(key).getUTCDay());
}

export function weekDays(key: string): string[] {
  const start = startOfWeek(key);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** Six rows of seven, so the grid never changes height between months. */
export function monthGrid(key: string): string[] {
  const start = startOfWeek(startOfMonth(key));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function isSameMonth(key: string, cursor: string): boolean {
  return key.slice(0, 7) === cursor.slice(0, 7);
}

export function todayKey(timezone: string): string {
  return zonedDateKey(new Date(), timezone);
}

const label = (key: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(dateKeyToUtc(key));

export const monthLabel = (key: string) => label(key, { month: "long", year: "numeric" });
export const dayNumber = (key: string) => label(key, { day: "numeric" });
export const weekdayShort = (key: string) => label(key, { weekday: "short" });
export const fullDayLabel = (key: string) => label(key, { weekday: "long", month: "long", day: "numeric" });

export function weekLabel(key: string): string {
  const [first, , , , , , last] = weekDays(key);
  const head = label(first, { month: "short", day: "numeric" });
  const tail = isSameMonth(first, last)
    ? label(last, { day: "numeric" })
    : label(last, { month: "short", day: "numeric" });
  return `${head} – ${tail}, ${label(last, { year: "numeric" })}`;
}

/*
 * A wall-clock string, `YYYY-MM-DDTHH:mm`, is the same shape a `datetime-local`
 * input holds, so a slot the user drops on converts to an instant through the
 * `zonedDateTimeLocalToIso` the task editor already uses.
 */
export const dayOf = (local: string) => local.slice(0, 10);
export const timeOf = (local: string) => local.slice(11, 16);
export const localOf = (dayKey: string, time: string) => `${dayKey}T${time}`;

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function timeFromMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hours = String(Math.floor(wrapped / 60)).padStart(2, "0");
  return `${hours}:${String(wrapped % 60).padStart(2, "0")}`;
}

export function slotTimes(): string[] {
  return Array.from({ length: SLOTS_PER_DAY }, (_, index) => timeFromMinutes(index * SLOT_MINUTES));
}

export function humanTimeOfDay(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, hours, minutes));
}

/** Hour gutter labels read better without the always-zero minutes. */
export function hourLabel(time: string): string {
  const hours = Number(time.slice(0, 2));
  return new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(new Date(2000, 0, 1, hours));
}

/** The wall-clock string a chip's instant lands on in the configured zone. */
export function localOfChip(chip: ScheduleChip, timezone: string): string {
  return toZonedDateTimeLocal(chip.at, timezone);
}

export function snapToSlot(time: string): string {
  return timeFromMinutes(Math.floor(minutesOf(time) / SLOT_MINUTES) * SLOT_MINUTES);
}

/**
 * A due date with no time on it reads as all-day, the same convention
 * `friendlyDueDate` uses when it prints the day alone.
 */
export function isAllDay(chip: ScheduleChip, timezone: string): boolean {
  return chip.kind === "due" && Boolean(chip.at) && timeOf(localOfChip(chip, timezone)) === "00:00";
}

export const dayDropId = (dayKey: string) => `day:${dayKey}`;
export const slotDropId = (dayKey: string, time: string) => `slot:${localOf(dayKey, time)}`;
export const UNSCHEDULE_DROP_ID = "unschedule";

/**
 * Where a drop lands, as a wall-clock string. Dropping on a day keeps the time
 * the chip already had — moving a task across the month should not silently
 * retime it — while dropping on a slot sets both halves.
 */
export function dropTargetToLocal(dropId: string, currentTime: string): string | null {
  if (dropId.startsWith("day:")) return localOf(dropId.slice(4), currentTime || DEFAULT_TIME);
  if (dropId.startsWith("slot:")) return dropId.slice(5);
  return null;
}
