/*
 * The one shared journal entry a group keeps per evening. The answers to the
 * evening question arrive over hours, and the agent used to find "the day's
 * entry" by search: the next evening it found the one before and appended to
 * it, so a Tuesday mood replaced a Monday one and Sunday's answers turned up
 * on Monday. The server knows which evening it asked, so it says which entry
 * that is, and the executor keeps each evening's answers in that evening's.
 */

import { USER_ID } from "./db.ts";
import { localIsoWithOffset, localParts, zonedToInstant } from "./local-time.ts";
import type { Db } from "./types.ts";

/** How long after the evening question the answers to it are still coming in. */
export const EVENING_ANSWER_WINDOW_MS = 6 * 60 * 60_000;

/** The tag every evening entry carries, whoever wrote it. */
export const END_OF_DAY_TAG = "end-of-day";

/** The day of the group's evening question still being answered, or undefined outside that window. */
export function eveningBeingAnswered(db: Db, threadId: string): string | undefined {
  const row = db.prepare(`
    SELECT json_extract(metadata_json,'$.date') date FROM channel_messages
    WHERE thread_id=? AND role='assistant' AND status<>'failed'
      AND json_extract(metadata_json,'$.kind')='group_evening' AND created_at>=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1
  `).get(threadId, new Date(Date.now() - EVENING_ANSWER_WINDOW_MS).toISOString()) as { date: string | null } | undefined;
  return typeof row?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : undefined;
}

export function isEveningEntry(row: { kind: string; tags_json: string | null }): boolean {
  if (row.kind !== "journal") return false;
  try {
    const tags = JSON.parse(row.tags_json || "[]") as unknown;
    return Array.isArray(tags) && tags.includes(END_OF_DAY_TAG);
  } catch {
    return false;
  }
}

/** The local day an entry is about, in the schedule's timezone. */
export function entryDay(occurredAt: string | null, timezone: string): string | undefined {
  if (!occurredAt) return undefined;
  const instant = new Date(occurredAt);
  return Number.isNaN(instant.getTime()) ? undefined : localParts(instant, timezone).date;
}

/** The group's evening entry for `date`, if one was started. */
export function eveningEntryFor(db: Db, lifeAreaId: string, date: string, timezone: string): { id: string } | undefined {
  const rows = db.prepare(`
    SELECT id,kind,tags_json,occurred_at FROM memories
    WHERE user_id=? AND kind='journal' AND life_area_id=? AND occurred_at IS NOT NULL
    ORDER BY created_at DESC LIMIT 30
  `).all(USER_ID, lifeAreaId) as Array<{ id: string; kind: string; tags_json: string | null; occurred_at: string }>;
  return rows.find(row => isEveningEntry(row) && entryDay(row.occurred_at, timezone) === date);
}

/** Midnight of `date` in the schedule's timezone, with its offset: what an evening entry's occurred_at is. */
export function eveningOccurredAt(date: string, timezone: string): string {
  return localIsoWithOffset(zonedToInstant(date, "00:00", timezone), timezone);
}
