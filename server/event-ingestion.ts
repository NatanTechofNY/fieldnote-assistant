import { getGranolaSecret } from "./integrations.ts";
import { id, now, USER_ID } from "./db.ts";
import type { Db, ExternalEventRow } from "./types.ts";

export interface EventAdapter {
  source: string;
  poll: (db: Db) => Promise<{ fetched: number; queued: number }>;
}

export function enqueueExternalEvent(
  db: Db,
  source: string,
  externalId: string,
  eventType: string,
  payload: unknown,
): { id: string; duplicate: boolean } {
  const eventId = id("event");
  const timestamp = now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO external_events(
      id,user_id,source,external_id,event_type,payload_json,status,attempts,
      available_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)
  `).run(
    eventId, USER_ID, source, externalId, eventType, JSON.stringify(payload),
    timestamp, timestamp, timestamp,
  );
  if (result.changes) return { id: eventId, duplicate: false };
  const existing = db.prepare(`
    SELECT id FROM external_events WHERE user_id=? AND source=? AND external_id=?
  `).get(USER_ID, source, externalId) as { id: string };
  return { id: existing.id, duplicate: true };
}

export function listExternalEvents(db: Db, limit = 50): ExternalEventRow[] {
  return db.prepare(`
    SELECT * FROM external_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?
  `).all(USER_ID, limit) as ExternalEventRow[];
}

/** How long a claim may sit `processing` before it is taken for a crash and offered again. */
export const STALE_CLAIM_MS = 10 * 60_000;

export function claimExternalEvents(db: Db, source?: string, limit = 20): ExternalEventRow[] {
  const timestamp = now();
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  return db.transaction(() => {
    // Two texts can be enqueued in the same millisecond; insertion order settles it.
    const rows = db.prepare(`
      SELECT *,rowid FROM external_events
      WHERE user_id=? AND (
        (status IN ('pending','failed') AND available_at<=?)
        OR (status='processing' AND updated_at<?)
      )
        AND (? IS NULL OR source=?)
      ORDER BY created_at,rowid LIMIT ?
    `).all(USER_ID, timestamp, stale, source ?? null, source ?? null, limit) as ExternalEventRow[];
    const claim = db.prepare(`
      UPDATE external_events SET status='processing',attempts=attempts+1,updated_at=?
      WHERE id=? AND (status IN ('pending','failed') OR (status='processing' AND updated_at<?))
    `);
    return rows.filter(row => Boolean(claim.run(timestamp, row.id, stale).changes));
  })();
}

/**
 * Every event from `source` filed before `event` that has not been settled:
 * waiting, failed and awaiting its retry, or claimed. The caller decides which
 * of them stand in front of the event it is about to run. "Before" is the
 * order `claimExternalEvents()` uses: the clock, then insertion order.
 */
export function unsettledExternalEventsBefore(
  db: Db,
  source: string,
  event: Pick<ExternalEventRow, "created_at" | "rowid">,
): ExternalEventRow[] {
  return db.prepare(`
    SELECT *,rowid FROM external_events
    WHERE user_id=? AND source=? AND status IN ('pending','failed','processing')
      AND (created_at<? OR (created_at=? AND (? IS NULL OR rowid<?)))
    ORDER BY created_at,rowid
  `).all(
    USER_ID, source, event.created_at, event.created_at, event.rowid ?? null, event.rowid ?? null,
  ) as ExternalEventRow[];
}

/**
 * When the next event from any of `sources` becomes claimable, or null when none
 * is waiting on the clock. This is what lets a retry or a deferred text run at
 * its scheduled second rather than at the next interval tick.
 */
export function nextExternalEventAvailableAt(db: Db, sources: string[]): string | null {
  if (!sources.length) return null;
  const row = db.prepare(`
    SELECT min(available_at) next FROM external_events
    WHERE user_id=? AND status IN ('pending','failed') AND source IN (${sources.map(() => "?").join(",")})
  `).get(USER_ID, ...sources) as { next: string | null };
  return row.next;
}

/**
 * Hands a claimed event back to the queue untouched, to be claimed again no
 * earlier than `availableAt`. The claim counted as an attempt, and nothing was
 * attempted, so the count is given back too.
 */
export function deferExternalEvent(db: Db, eventId: string, availableAt: string): void {
  db.prepare(`
    UPDATE external_events SET status='pending',attempts=max(attempts-1,0),available_at=?,updated_at=? WHERE id=?
  `).run(availableAt, now(), eventId);
}

/**
 * How many times an event may be attempted before it is given up, by the kind
 * of failure. A dropped connection or a provider asking us to come back later
 * says nothing about the text, so it gets eight tries behind a doubling
 * backoff — about four minutes of waiting between them, long enough to ride
 * out a blip. Any other failure is the turn itself: a request the agent will
 * refuse the same way every time, or a turn that ran out of rounds or minutes
 * and will again. One more try covers a fluke; a third would cost everyone
 * behind it another four minutes for the same answer. Either way the text does
 * not come back every hour for good, hold its thread's ordering, or sit in
 * every blocker query as a `failed` row.
 */
export const MAX_EVENT_ATTEMPTS = 8;
export const MAX_EVENT_ATTEMPTS_FINAL = 2;

/**
 * Settles an event. A `failed` event is scheduled for another attempt behind
 * an exponential backoff until it has used its attempts — `MAX_EVENT_ATTEMPTS`
 * for a transient failure, `MAX_EVENT_ATTEMPTS_FINAL` otherwise — when it is
 * filed as `ignored`, the same terminal status a Granola note the owner chose
 * not to keep gets, with the
 * last error kept so the give-up can be read later. Returns the status written.
 */
export function completeExternalEvent(
  db: Db,
  eventId: string,
  status: "processed" | "ignored" | "failed",
  error?: string,
  options: { transient?: boolean } = {},
): "processed" | "ignored" | "failed" {
  const attempts = (db.prepare("SELECT attempts FROM external_events WHERE id=?").get(eventId) as { attempts: number } | undefined)?.attempts ?? 1;
  const allowed = options.transient === false ? MAX_EVENT_ATTEMPTS_FINAL : MAX_EVENT_ATTEMPTS;
  const gaveUp = status === "failed" && attempts >= allowed;
  const written = gaveUp ? "ignored" : status;
  const retryAt = written === "failed"
    ? new Date(Date.now() + Math.min(3600, 2 ** Math.min(attempts, 10)) * 1000).toISOString()
    : now();
  const note = gaveUp ? `Gave up after ${attempts} attempts: ${error ?? "unknown error"}` : error;
  db.prepare(`
    UPDATE external_events SET status=?,last_error=?,available_at=?,updated_at=? WHERE id=?
  `).run(written, note?.slice(0, 1000) ?? null, retryAt, now(), eventId);
  return written;
}

/**
 * Drops settled events from `sources` once they are older than `cutoff`; the
 * unsettled ones stay whatever their age.
 *
 * Only the inbound text sources are offered. A settled row is also the
 * `(source, external_id)` record that makes `enqueueExternalEvent()` ignore a
 * second copy, and for a text that only matters for the minutes a provider
 * keeps redelivering. A Granola note is different: the owner's decision to
 * ignore it or turn it into a memory lives in that row, and the note can come
 * back from the poll whenever it is edited, so its row has to outlive a week.
 */
export function pruneSettledExternalEvents(db: Db, sources: string[], cutoff: string): number {
  if (!sources.length) return 0;
  return db.prepare(`
    DELETE FROM external_events
    WHERE user_id=? AND status IN ('processed','ignored') AND updated_at<?
      AND source IN (${sources.map(() => "?").join(",")})
  `).run(USER_ID, cutoff, ...sources).changes;
}

type GranolaListResponse = {
  notes?: Array<Record<string, unknown> & { id?: string }>;
  data?: Array<Record<string, unknown> & { id?: string }>;
  hasMore?: boolean;
  cursor?: string | null;
};

export async function pollGranola(db: Db): Promise<{ fetched: number; queued: number }> {
  const secret = getGranolaSecret(db);
  if (!secret) return { fetched: 0, queued: 0 };
  const pollStartedAt = now();
  const row = db.prepare(`
    SELECT config_json FROM integration_settings WHERE user_id=? AND provider='granola'
  `).get(USER_ID) as { config_json: string };
  const config = JSON.parse(row.config_json || "{}") as { lastPolledAt?: string };
  let cursor: string | null = null;
  let fetched = 0;
  let queued = 0;
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({ page_size: "30" });
    if (config.lastPolledAt) query.set("updated_after", config.lastPolledAt);
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`https://public-api.granola.ai/v1/notes?${query}`, {
      headers: { authorization: `Bearer ${secret.apiKey}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Granola API failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const payload = await response.json() as GranolaListResponse;
    const notes = payload.notes || payload.data || [];
    fetched += notes.length;
    for (const note of notes) {
      if (!note.id) continue;
      const result = enqueueExternalEvent(db, "granola", note.id, "granola.note.updated", note);
      if (!result.duplicate) queued += 1;
    }
    cursor = payload.cursor || null;
    if (!payload.hasMore || !cursor) break;
  }
  db.prepare(`
    UPDATE integration_settings SET config_json=?,last_error=NULL,status='connected',updated_at=?
    WHERE user_id=? AND provider='granola'
  `).run(JSON.stringify({ lastPolledAt: pollStartedAt }), now(), USER_ID);
  return { fetched, queued };
}

export const granolaAdapter: EventAdapter = {
  source: "granola",
  poll: pollGranola,
};
