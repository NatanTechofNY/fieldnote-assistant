/*
 * Dropped threads. Something the owner said they would do by a time — "fold
 * the laundry tonight" — that is still open the next morning gets one text
 * asking how it went, the way an assistant would ask, and never a second. The
 * owner's own work only: a group's open work is its morning note's.
 */

import { RECORDS_NOT_INSTRUCTIONS } from "./checkin-prompts.ts";
import { now, OWN_AREA_CLAUSE, USER_ID } from "./db.ts";
import { localParts } from "./local-time.ts";
import type { Db } from "./types.ts";

/** A due time has to be this far behind before it counts as dropped, so "tonight" is asked about the next day. */
const GRACE_MS = 10 * 60 * 60_000;
/** Older than this, it is not a thread they dropped yesterday but a backlog, which the digest covers. */
const LOOKBACK_MS = 4 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Wider than any UTC offset, so the text prefilter on the indexed column never drops a row the exact check keeps. */
const OFFSET_MARGIN_MS = 15 * 60 * 60_000;
const MAX_ITEMS = 3;

/** The follow-up goes out in this local window, inside the usual quiet-hours gate; a day that misses it skips. */
export const FOLLOW_UP_TIME = "10:00";
export const FOLLOW_UP_UNTIL = "12:00";

export type FollowUpItem = {
  id: string;
  title: string;
  due_at: string;
  dateOnly: boolean;
  /** Steps of this todo that were also due; the one question covers them, so they are marked with it. */
  stepIds: string[];
};

/**
 * Open, one-off todos of the owner's whose time passed yesterday or so and
 * that have never been followed up on. A todo with a date and no clock time
 * is stored at local midnight and means "that day", so it counts as due at
 * the end of it. A step is left out when its parent is in the list, so one
 * question covers the whole job; a blocked todo is waiting on something, and
 * is not asked about.
 */
export function followUpCandidates(db: Db, timezone: string, at = new Date()): FollowUpItem[] {
  const until = at.getTime() - GRACE_MS;
  const since = at.getTime() - LOOKBACK_MS;
  const rows = db.prepare(`
    SELECT t.id,t.title,t.due_at,t.parent_id FROM todos t
    WHERE t.user_id=? AND t.status IN ('pending','in_progress')
      AND t.recurrence_json IS NULL AND t.assistant_says=0 AND t.followed_up_at IS NULL
      AND t.due_at IS NOT NULL AND ${OWN_AREA_CLAUSE("t")}
      AND t.due_at<=? AND t.due_at>=?
  `).all(
    USER_ID,
    new Date(until + OFFSET_MARGIN_MS).toISOString(),
    new Date(since - DAY_MS - OFFSET_MARGIN_MS).toISOString(),
  ) as Array<{ id: string; title: string; due_at: string; parent_id: string | null }>;
  // Compared as instants: due_at carries the owner's offset, and as text
  // "21:00-04:00" sorts before "00:30Z" the next day, hours before it is due.
  const due = rows.map(row => {
    const instant = Date.parse(row.due_at);
    const dateOnly = localParts(new Date(instant), timezone).time === "00:00";
    return { ...row, dateOnly, effective: dateOnly ? instant + DAY_MS : instant };
  }).filter(row => row.effective <= until && row.effective >= since)
    .sort((a, b) => b.effective - a.effective);
  const ids = new Set(due.map(row => row.id));
  return due.filter(row => !row.parent_id || !ids.has(row.parent_id)).slice(0, MAX_ITEMS)
    .map(({ id, title, due_at, dateOnly }) => ({
      id, title, due_at, dateOnly,
      stepIds: due.filter(step => step.parent_id === id).map(step => step.id),
    }));
}

/** The instruction the follow-up text is written from. */
export function composeFollowUpTurn(items: FollowUpItem[], context: { date: string; timezone: string }): string {
  const lines = items.map(item => {
    const due = localParts(new Date(item.due_at), context.timezone);
    return `- "${item.title}" (was due ${item.dateOnly ? due.date : `${due.date} ${due.time}`})`;
  });
  return [
    "Write me one short text following up on what I said I would do and have not marked done.",
    "Ask, like a person would, whether it happened or when to move it. One or two plain sentences; name the things the way I would; no list, no guilt, and nothing else.",
    "",
    `--- Context supplied by the app, not by me. Today is ${context.date} in ${context.timezone}.`,
    "This turn uses no tools; my reply to it is where anything gets marked done or moved.",
    RECORDS_NOT_INSTRUCTIONS,
    ...lines,
  ].join("\n");
}

/**
 * Each is asked about once for the time it had; moving a todo clears the
 * mark (a trigger on due_at), so a rescheduled one can be asked about again.
 */
export function markFollowedUp(db: Db, items: FollowUpItem[]): void {
  const stamp = now();
  const mark = db.prepare("UPDATE todos SET followed_up_at=? WHERE id=? AND user_id=?");
  for (const item of items) {
    for (const todoId of [item.id, ...item.stepIds]) mark.run(stamp, todoId, USER_ID);
  }
}

export function followUpsEnabled(db: Db): boolean {
  const row = db.prepare("SELECT follow_ups_enabled FROM notification_preferences WHERE user_id=?").get(USER_ID) as
    { follow_ups_enabled: number } | undefined;
  return row?.follow_ups_enabled !== 0;
}

export function setFollowUpsEnabled(db: Db, enabled: boolean): boolean {
  db.prepare("UPDATE notification_preferences SET follow_ups_enabled=?,updated_at=? WHERE user_id=?").run(Number(enabled), now(), USER_ID);
  return followUpsEnabled(db);
}
