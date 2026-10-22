/** `2026-07-05` as `Jul 5`, read as the calendar date it is rather than an instant. */
export function shortDate(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

export const bucketLabel = (key: string, granularity: "day" | "week") =>
  granularity === "week" ? `Week of ${shortDate(key)}` : shortDate(key);

/** A share as a whole-number percentage, or a dash when there was nothing to take a share of. */
export const percent = (share: number | null) => share === null ? "—" : `${Math.round(share * 100)}%`;

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `13` as `1p`: an hour label small enough to sit above a cell. */
export function hourLabel(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${hour < 12 ? "a" : "p"}`;
}

/** Tool names are snake_case identifiers; people read them as words. */
export const toolLabel = (tool: string) => tool.replace(/_/g, " ");
