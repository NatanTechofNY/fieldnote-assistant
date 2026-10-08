/*
 * A threaded reply Sendblue took and then could not place ("Invalid reply
 * target": the message part it names is gone) never reached anyone. The words
 * matter more than the thread, so the reply goes out again on its own.
 *
 * The receipt only files the request on the failed row; the worker makes the
 * send, as it does every other send, so a Sendblue outage at that moment is
 * retried behind a backoff instead of losing the reply for good. The row is
 * the queue: `unthreadedResend` on its metadata says where the resend stands.
 */

import { now, queueIndexJob } from "./db.ts";
import { groupIdOfAddress } from "./group-thread.ts";
import type { SmsSender } from "./messaging.ts";
import { isTransientFailure } from "./transient.ts";
import type { Db } from "./types.ts";

export const LOST_REPLY_TARGET = /invalid reply target/i;

/** Tries for a resend that keeps meeting an outage; about eight minutes of backoff in all. */
export const MAX_RESEND_ATTEMPTS = 5;

type ResendState = {
  state: "pending" | "sent" | "gave_up";
  attempts: number;
  after?: string;
  lastError?: string;
};

function worthRetrying(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return isTransientFailure(error) || (typeof status === "number" && (status >= 500 || status === 429));
}

/**
 * Sendblue's gateway sometimes takes a message and then drops it, saying so in
 * the receipt and asking for another try. Nothing was delivered, so the same
 * words go out again.
 */
export const GATEWAY_DROP = /dropped by gateway|did not get sent, please try again/i;

/** A dropped message is only worth sending again while it is still the news; a check-in must not arrive hours late. */
export const DROPPED_RESEND_WINDOW_MS = 30 * 60_000;

/**
 * Files a resend for a message the gateway dropped, threaded or not. It uses the
 * same queue as `queueUnthreadedResend()` and, like it, only once per row. A
 * message older than the window is left failed.
 */
export function queueDroppedResend(db: Db, providerMessageId: string): boolean {
  const state: ResendState = { state: "pending", attempts: 0, after: now() };
  return db.prepare(`
    UPDATE channel_messages SET metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.unthreadedResend',json(?)),updated_at=?
    WHERE provider_message_id=? AND role='assistant' AND status='failed'
      AND created_at>=?
      AND json_extract(metadata_json,'$.unthreadedResend') IS NULL
  `).run(
    JSON.stringify(state), now(), providerMessageId, new Date(Date.now() - DROPPED_RESEND_WINDOW_MS).toISOString(),
  ).changes > 0;
}

/**
 * Files the resend on the assistant row the receipt was about. Only a threaded
 * reply qualifies, and only once: a repeated receipt, or one for a handle the
 * resend has since replaced, changes nothing.
 */
export function queueUnthreadedResend(db: Db, providerMessageId: string): boolean {
  const state: ResendState = { state: "pending", attempts: 0, after: now() };
  return db.prepare(`
    UPDATE channel_messages SET metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.unthreadedResend',json(?)),updated_at=?
    WHERE provider_message_id=? AND role='assistant' AND status='failed'
      AND json_extract(metadata_json,'$.replyTo') IS NOT NULL
      AND json_extract(metadata_json,'$.unthreadedResend') IS NULL
  `).run(JSON.stringify(state), now(), providerMessageId).changes > 0;
}

/** Sends every resend that is due. Called from the worker, the one writer. */
export async function sendQueuedUnthreadedResends(db: Db, send: SmsSender, limit = 10): Promise<number> {
  const rows = db.prepare(`
    SELECT m.id,m.content,m.metadata_json,t.address FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE json_extract(m.metadata_json,'$.unthreadedResend.state')='pending'
      AND json_extract(m.metadata_json,'$.unthreadedResend.after')<=?
    ORDER BY m.created_at LIMIT ?
  `).all(now(), limit) as Array<{ id: string; content: string; metadata_json: string; address: string }>;
  const record = (id: string, state: ResendState) => db.prepare(`
    UPDATE channel_messages SET metadata_json=json_set(metadata_json,'$.unthreadedResend',json(?)),updated_at=? WHERE id=?
  `).run(JSON.stringify(state), now(), id);
  let sentCount = 0;
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json) as { mediaUrl?: unknown; unthreadedResend: ResendState };
    const attempts = metadata.unthreadedResend.attempts + 1;
    const mediaUrl = typeof metadata.mediaUrl === "string" ? metadata.mediaUrl : undefined;
    const groupId = groupIdOfAddress(row.address);
    try {
      const sent = await send(db, row.address, mediaUrl && row.content === "(picture)" ? "" : row.content, {
        ...(groupId ? { groupId } : {}),
        ...(mediaUrl ? { mediaUrl } : {}),
      });
      db.transaction(() => {
        db.prepare(`
          UPDATE channel_messages SET provider_message_id=?,status=?,updated_at=?,
            metadata_json=json_set(json_remove(metadata_json,'$.replyTo','$.deliveryError'),'$.unthreadedResend',json(?))
          WHERE id=?
        `).run(
          sent.sid, sent.status === "queued" ? "queued" : "sent", now(),
          JSON.stringify({ state: "sent", attempts } satisfies ResendState), row.id,
        );
        queueIndexJob(db, "channel_message", row.id);
      })();
      sentCount += 1;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      // Only an outage is worth waiting out; a send refused on its own terms
      // would be refused the same way. A provider error or rate limit counts as
      // an outage here: the reply already failed once, so a rare duplicate
      // beats losing it.
      const retry = worthRetrying(error) && attempts < MAX_RESEND_ATTEMPTS;
      record(row.id, retry
        ? { state: "pending", attempts, after: new Date(Date.now() + 2 ** attempts * 15_000).toISOString(), lastError: reason }
        : { state: "gave_up", attempts, lastError: reason });
      console.warn(`Resending an unthreadable reply ${retry ? "will be retried" : "was given up"}:`, reason);
    }
  }
  return sentCount;
}
