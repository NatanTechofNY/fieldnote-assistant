export type FiscalQuarter = 1 | 2 | 3 | 4;

export interface FiscalQuarterRange {
  year: number;
  quarter: FiscalQuarter;
  key: string;
  label: string;
  start: string;
  endExclusive: string;
  startDate: string;
  endDate: string;
}

const quarterMonths: Record<FiscalQuarter, { start: number; endExclusive: number }> = {
  1: { start: 1, endExclusive: 4 },
  2: { start: 4, endExclusive: 7 },
  3: { start: 7, endExclusive: 10 },
  4: { start: 10, endExclusive: 1 },
};

function timezoneOffsetMs(date: Date, timezone: string): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!value || value === "GMT" || value === "UTC") return 0;
  const match = value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "+" ? 1 : -1) * minutes * 60_000;
}

function localMidnightIso(year: number, month: number, day: number, timezone: string): string {
  const wallClock = Date.UTC(year, month, day);
  let instant = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  instant = new Date(wallClock - timezoneOffsetMs(instant, timezone));
  return instant.toISOString();
}

function dateOnly(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function displayDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function fiscalQuarterRange(
  year: number,
  quarter: FiscalQuarter,
  timezone: string,
): FiscalQuarterRange {
  const months = quarterMonths[quarter];
  const endYear = quarter === 4 ? year + 1 : year;
  const start = localMidnightIso(year, months.start, 1, timezone);
  const endExclusive = localMidnightIso(endYear, months.endExclusive, 1, timezone);
  const endInstant = new Date(new Date(endExclusive).getTime() - 1);
  const endParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(endInstant);
  const part = (type: string): string => endParts.find((item) => item.type === type)?.value ?? "";
  return {
    year,
    quarter,
    key: `q${quarter}-${year}`,
    label: `Q${quarter} ${year} · ${displayDate(start, timezone)}–${displayDate(endInstant.toISOString(), timezone)}`,
    start,
    endExclusive,
    startDate: dateOnly(year, months.start, 1),
    endDate: `${part("year")}-${part("month")}-${part("day")}`,
  };
}

export function currentFiscalQuarter(timezone: string, at = new Date()): { year: number; quarter: FiscalQuarter } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(at);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (month === 1) return { year: year - 1, quarter: 4 };
  if (month <= 4) return { year, quarter: 1 };
  if (month <= 7) return { year, quarter: 2 };
  if (month <= 10) return { year, quarter: 3 };
  return { year, quarter: 4 };
}
