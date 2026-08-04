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

export function claimExternalEvents(db: Db, source?: string, limit = 20): ExternalEventRow[] {
  const timestamp = now();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM external_events
      WHERE user_id=? AND (
        (status IN ('pending','failed') AND available_at<=?)
        OR (status='processing' AND updated_at<?)
      )
        AND (? IS NULL OR source=?)
      ORDER BY created_at LIMIT ?
    `).all(USER_ID, timestamp, stale, source ?? null, source ?? null, limit) as ExternalEventRow[];
    const claim = db.prepare(`
      UPDATE external_events SET status='processing',attempts=attempts+1,updated_at=?
      WHERE id=? AND (status IN ('pending','failed') OR (status='processing' AND updated_at<?))
    `);
    return rows.filter(row => Boolean(claim.run(timestamp, row.id, stale).changes));
  })();
}

export function completeExternalEvent(
  db: Db,
  eventId: string,
  status: "processed" | "ignored" | "failed",
  error?: string,
): void {
  const attempts = (db.prepare("SELECT attempts FROM external_events WHERE id=?").get(eventId) as { attempts: number } | undefined)?.attempts ?? 1;
  const retryAt = status === "failed"
    ? new Date(Date.now() + Math.min(3600, 2 ** Math.min(attempts, 10)) * 1000).toISOString()
    : now();
  db.prepare(`
    UPDATE external_events SET status=?,last_error=?,available_at=?,updated_at=? WHERE id=?
  `).run(status, error?.slice(0, 1000) ?? null, retryAt, now(), eventId);
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
