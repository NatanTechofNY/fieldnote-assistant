import { OWN_AREA_CLAUSE, USER_ID } from "./db.ts";
import { localParts } from "./local-time.ts";
import type { Db } from "./types.ts";

/** Enough to bring the last two days into the room without the turn reading like a diary. */
const MEMORY_LIMIT = 6;
/** How much of an entry the agent sees; the point is to recognise it, not to reread it. */
const SNIPPET_LENGTH = 140;

type RecentMemoryRow = {
  title: string | null;
  content: string;
  kind: "fact" | "note" | "journal";
  mood_label: string | null;
  mood_score: number | null;
  occurred_at: string | null;
  created_at: string;
};

/** The local calendar day before `date` (`YYYY-MM-DD`). */
function dayBefore(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : flat;
}

/**
 * What was saved in a scope today or yesterday — notes, facts, and journal
 * entries — as lines for a check-in's context block. A check-in that knows
 * yesterday's entry said "tired" can ask how tonight compares, and one that
 * knows a note was filed this morning can tie it to the task it bears on; a
 * turn without them can only talk about todos. Scoped the way the check-in is:
 * to a group's area for a group, to the owner's own areas for the owner, so a
 * group is never read the owner's private journal.
 *
 * The day is the entry's own (`occurred_at`) when it has one, otherwise when
 * it was saved, in the schedule timezone. Most recent first, capped.
 */
export function recentMemoryLines(
  db: Db,
  scope: { areaId: string } | { own: true },
  date: string,
  timezone: string,
): string[] {
  const yesterday = dayBefore(date);
  const where = "areaId" in scope ? "life_area_id=?" : OWN_AREA_CLAUSE("memories");
  const params = "areaId" in scope ? [USER_ID, scope.areaId] : [USER_ID];
  // Two local days span at most 50 hours of UTC; the date check below is exact.
  const floor = new Date(`${yesterday}T00:00:00Z`);
  floor.setUTCHours(floor.getUTCHours() - 26);
  const rows = db.prepare(`
    SELECT title,content,kind,mood_label,mood_score,occurred_at,created_at FROM memories
    WHERE user_id=? AND ${where} AND COALESCE(occurred_at,created_at)>=?
    ORDER BY COALESCE(occurred_at,created_at) DESC
  `).all(...params, floor.toISOString()) as RecentMemoryRow[];
  const lines: string[] = [];
  for (const row of rows) {
    const day = localParts(new Date(row.occurred_at ?? row.created_at), timezone).date;
    if (day !== date && day !== yesterday) continue;
    const when = day === date ? "today" : "yesterday";
    const label = row.kind === "journal" ? "journal entry" : row.kind;
    const mood = row.mood_label || row.mood_score
      ? ` (mood: ${[row.mood_label, row.mood_score ? `${row.mood_score}/5` : null].filter(Boolean).join(" ")})`
      : "";
    const body = snippet(row.content);
    const head = row.title && snippet(row.title) !== body ? `"${snippet(row.title)}" — ` : "";
    lines.push(`- ${when}, ${label}: ${head}${body}${mood}`);
    if (lines.length === MEMORY_LIMIT) break;
  }
  return lines;
}

/**
 * The context lines a check-in carries about recent memories: the list, or
 * one line saying there is none, and the rule for using them. The rule is the
 * same for every check-in: a memory is there to be recognised and, at most,
 * woven in once — never recited.
 */
export function recentMemoryContext(
  db: Db,
  scope: { areaId: string } | { own: true },
  date: string,
  timezone: string,
): string[] {
  const lines = recentMemoryLines(db, scope, date, timezone);
  const where = "areaId" in scope ? "in this group" : "in my own areas";
  return [
    lines.length
      ? `Saved ${where} today or yesterday (notes and journal entries), newest first:`
      : `Nothing was saved ${where} today or yesterday.`,
    ...lines,
    ...lines.length
      ? ["Bring one in only if it fits — yesterday's mood to ask how tonight compares, a note that bears on a task — and never recite them."]
      : [],
  ];
}
