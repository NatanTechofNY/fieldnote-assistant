import { type ScheduleChip, humanTimeOfDay, isAllDay, localOfChip, timeOf } from "../../../lib/calendar";
import { statusMeta } from "../../../lib/todo-meta";

/**
 * A deadline takes the colour of the work's state, the way the board's columns
 * do. A reminder is about being told, not about progress, so it stays accent
 * coloured whatever the task is up to.
 */
export function chipTone(chip: ScheduleChip): string {
  return chip.kind === "due" ? statusMeta[chip.todo.status].color : "var(--accent)";
}

/**
 * One task can hold a deadline and a couple of reminders at once, so its chips
 * land on several days and read as duplicates of each other unless each one
 * says out loud which date it is.
 */
function chipKindLabel(chip: ScheduleChip): string {
  if (chip.kind === "due") return "Due";
  return chip.index === undefined ? "Reminder" : `Reminder ${chip.index + 2}`;
}

function chipTimeLabel(chip: ScheduleChip, timezone: string): string {
  if (!chip.at) return "unscheduled";
  // A deadline stored at midnight is a day, not a moment, and saying "12:00 AM"
  // would claim a precision the task was never given.
  if (isAllDay(chip, timezone)) return "any time";
  return humanTimeOfDay(timeOf(localOfChip(chip, timezone)));
}

export function chipMetaLabel(chip: ScheduleChip, timezone: string): string {
  if (!chip.at) return "No due date";
  return `${chipKindLabel(chip)} · ${chipTimeLabel(chip, timezone)}`;
}
