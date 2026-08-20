import type { AlgoliaSync } from "./algolia.ts";
import { getNotificationPreferences } from "./integrations.ts";
import { pruneExpiredSessions } from "./auth.ts";
import { id, now, USER_ID } from "./db.ts";
import { recordOutboundChannelMessage, recordOutboundProviderMessage, runSmsAgent } from "./agent-runner.ts";
import { composeDigestTurn } from "./daily-digest.ts";
import { composeBriefTurn, dueDigestBriefs } from "./digest-briefs.ts";
import { claimExternalEvents, completeExternalEvent, pollGranola } from "./event-ingestion.ts";
import { localParts } from "./local-time.ts";
import { sendSms, startTypingIndicator } from "./messaging.ts";
import { openSubtasks } from "./todo-status.ts";
import { isTransientFailure } from "./transient.ts";
import type { TypingIndicator } from "./sendblue-service.ts";
import type { Db, DigestBriefRow, ReminderRow } from "./types.ts";

type SearchWriter = Pick<AlgoliaSync, "flushSoon" | "flush">;

/** Retention for completed outbox jobs and delivered dispatch receipts. */
const COMPLETED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How many times a scheduled send may fail transiently before the day is
 * written off. High enough to ride out a network that comes back a few minutes
 * later, low enough that a provider outage stops costing us a request per tick.
 */
const MAX_DISPATCH_ATTEMPTS = 5;
export type WorkerDependencies = {
  sendSms?: typeof sendSms;
  runSmsAgent?: typeof runSmsAgent;
  pollGranola?: typeof pollGranola;
  startTypingIndicator?: typeof startTypingIndicator;
};

/**
 * Inbound texts are queued verbatim in the provider's own vocabulary, so each
 * source needs a reader before the agent sees a sender and a message. Both are
 * drained on every tick regardless of which provider is currently selected for
 * sending, so a reply to yesterday's reminder is still answered after a switch.
 */
const INBOUND_SOURCES: Array<{
  source: string;
  read: (payload: Record<string, unknown>) => { from?: string; body?: string; messageId?: string };
}> = [
  {
    source: "twilio",
    read: payload => ({
      from: typeof payload.From === "string" ? payload.From : undefined,
      body: typeof payload.Body === "string" ? payload.Body : undefined,
      messageId: typeof payload.MessageSid === "string" ? payload.MessageSid : undefined,
    }),
  },
  {
    source: "sendblue",
    read: payload => ({
      from: typeof payload.from_number === "string" ? payload.from_number
        : typeof payload.number === "string" ? payload.number : undefined,
      body: typeof payload.content === "string" ? payload.content : undefined,
      messageId: typeof payload.message_handle === "string" ? payload.message_handle : undefined,
    }),
  },
];

function inQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

/*
 * A due date is not a notification. Its row exists so the schedule can be
 * listed and edited in one place, but only a reminder the user actually asked
 * for reaches their phone, so `due` rows are never claimed for delivery.
 */
function claimDueReminders(db: Db, limit = 50): ReminderRow[] {
  const timestamp = now();
  const staleClaim = new Date(Date.now() - 10 * 60_000).toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT r.*,t.title todo_title FROM reminders r JOIN todos t ON t.id=r.todo_id
      WHERE r.user_id=? AND r.status IN ('pending','failed') AND r.kind<>'due'
        AND COALESCE(r.available_at,r.scheduled_for)<=?
        AND (r.claimed_at IS NULL OR r.claimed_at<?)
      ORDER BY r.scheduled_for LIMIT ?
    `).all(USER_ID, timestamp, staleClaim, limit) as ReminderRow[];
    const claim = db.prepare(`
      UPDATE reminders SET claimed_at=?,attempts=attempts+1,updated_at=?
      WHERE id=? AND (claimed_at IS NULL OR claimed_at<?)
    `);
    return rows.filter(row => Boolean(claim.run(timestamp, timestamp, row.id, staleClaim).changes));
  })();
}

/**
 * How many steps a text names before it starts counting them instead. A phone
 * screen is the wrong place to read a whole checklist, and the app is one tap
 * away for the rest.
 */
const NAMED_SUBTASKS = 3;

/*
 * A reminder on a parent used to send its title alone, which named the work
 * without saying what was left in it. Only what is still open is worth the
 * characters, and the wording stays inside GSM-7 so a checklist does not halve
 * the room a segment has.
 */
function reminderBody(db: Db, reminder: ReminderRow): string {
  const headline = `Reminder: ${reminder.todo_title || "You have a task due."}`;
  const open = openSubtasks(db, reminder.todo_id);
  if (!open.length) return headline;
  const named = open.slice(0, NAMED_SUBTASKS).map(subtask => subtask.title);
  const rest = open.length - named.length;
  return `${headline}\n${open.length} open: ${named.join("; ")}${rest ? `; +${rest} more` : ""}`;
}

async function deliverReminder(
  db: Db,
  search: SearchWriter,
  reminder: ReminderRow,
  recipient: string,
  send: typeof sendSms,
): Promise<void> {
  /*
   * The intent to send is recorded before the provider call, so a crash between
   * Twilio accepting the message and the reminder being marked sent cannot
   * deliver it a second time once the stale claim expires. A provider failure
   * releases the row again, because in that case nothing was delivered.
   */
  const timestamp = now();
  const dispatchId = id("dispatch");
  const claimed = db.prepare(`
    INSERT OR IGNORE INTO scheduled_dispatches(
      id,user_id,kind,idempotency_key,scheduled_for,status,attempts,created_at,updated_at
    ) VALUES(?,?,'reminder',?,?,'processing',1,?,?)
  `).run(
    dispatchId, USER_ID, `reminder:${reminder.id}:${reminder.scheduled_for}`,
    reminder.scheduled_for, timestamp, timestamp,
  );
  if (!claimed.changes) {
    db.prepare(`
      UPDATE reminders SET status='sent',claimed_at=NULL,
        last_error='Delivery outcome unknown; not resent',updated_at=? WHERE id=?
    `).run(now(), reminder.id);
    return;
  }
  try {
    const content = reminderBody(db, reminder);
    const message = await send(db, recipient, content);
    recordOutboundChannelMessage(db, "sms", recipient, content, message.sid, message.status, {
      kind: "reminder",
      reminderId: reminder.id,
      todoId: reminder.todo_id,
    });
    search.flushSoon();
    db.prepare(`
      UPDATE reminders SET status='sent',delivered_at=?,provider_message_id=?,
        claimed_at=NULL,last_error=NULL,updated_at=? WHERE id=?
    `).run(now(), message.sid, now(), reminder.id);
    db.prepare(`
      UPDATE scheduled_dispatches SET status='sent',provider_message_id=?,updated_at=? WHERE id=?
    `).run(message.sid, now(), dispatchId);
  } catch (error) {
    const delayMinutes = Math.min(60, 2 ** Math.min(reminder.attempts + 1, 6));
    db.prepare(`
      UPDATE reminders SET status='failed',claimed_at=NULL,available_at=?,last_error=?,updated_at=?
      WHERE id=?
    `).run(
      new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      error instanceof Error ? error.message.slice(0, 1000) : "SMS delivery failed",
      now(),
      reminder.id,
    );
    db.prepare("DELETE FROM scheduled_dispatches WHERE id=?").run(dispatchId);
  }
}

/**
 * Takes the single slot a scheduled send gets per key, or takes it back when an
 * earlier attempt failed for a reason that says nothing about the request. The
 * whole claim is one transaction so two ticks cannot both believe they own it.
 */
function claimDispatch(
  db: Db,
  kind: "daily_digest" | "digest_brief",
  key: string,
  scheduledFor: string,
): string | null {
  const timestamp = now();
  const dispatchId = id("dispatch");
  return db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO scheduled_dispatches(
        id,user_id,kind,idempotency_key,scheduled_for,status,attempts,created_at,updated_at
      ) VALUES(?,?,?,?,?,'processing',1,?,?)
    `).run(dispatchId, USER_ID, kind, key, scheduledFor, timestamp, timestamp);
    if (inserted.changes) return dispatchId;
    /*
     * Only a row left `pending` by a transient failure is re-claimable. A
     * `failed` receipt or a `sent` one stays untouched, so the retry path cannot
     * turn into a second delivery or an all-day loop.
     */
    const resumed = db.prepare(`
      UPDATE scheduled_dispatches SET status='processing',attempts=attempts+1,updated_at=?
      WHERE idempotency_key=? AND status='pending' AND attempts<? AND COALESCE(available_at,?)<=?
    `).run(timestamp, key, MAX_DISPATCH_ATTEMPTS, timestamp, timestamp);
    if (!resumed.changes) return null;
    const row = db.prepare("SELECT id FROM scheduled_dispatches WHERE idempotency_key=?")
      .get(key) as { id: string };
    return row.id;
  })();
}

/**
 * A transient failure leaves the row `pending` behind a backoff so a later tick
 * can finish the job, which is what lets a digest survive a laptop that was
 * asleep at its send time. Every other failure stays `failed`, so a brief whose
 * query is broken still does not retry every minute for the rest of the day.
 */
function recordDispatchFailure(db: Db, dispatchId: string, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message.slice(0, 1000) : fallback;
  const row = db.prepare("SELECT attempts FROM scheduled_dispatches WHERE id=?")
    .get(dispatchId) as { attempts: number } | undefined;
  const retry = isTransientFailure(error) && (row?.attempts ?? MAX_DISPATCH_ATTEMPTS) < MAX_DISPATCH_ATTEMPTS;
  const delayMinutes = Math.min(60, 2 ** (row?.attempts ?? 1));
  db.prepare(`
    UPDATE scheduled_dispatches SET status=?,available_at=?,last_error=?,updated_at=? WHERE id=?
  `).run(
    retry ? "pending" : "failed",
    retry ? new Date(Date.now() + delayMinutes * 60_000).toISOString() : null,
    message,
    now(),
    dispatchId,
  );
}

async function deliverDailyDigest(
  db: Db,
  search: SearchWriter,
  recipient: string,
  date: string,
  digest: { timezone: string; includeTodos: boolean; includeOverdue: boolean },
  runAgent: typeof runSmsAgent,
  send: typeof sendSms,
): Promise<void> {
  const key = `daily_digest:${USER_ID}:${date}`;
  const dispatchId = claimDispatch(db, "daily_digest", key, now());
  if (!dispatchId) return;
  try {
    const prompt = composeDigestTurn(db, {
      date,
      timezone: digest.timezone,
      includeTodos: digest.includeTodos,
      includeOverdue: digest.includeOverdue,
    });
    /*
     * The digest is drafted on its own thread so the app-composed prompt above
     * never enters the real SMS history, but what actually reached the phone is
     * recorded on the number it was sent to. Otherwise a reply such as "done"
     * arrives on a thread whose recent window never contained the digest.
     */
    const response = await runAgent(db, search, `digest:${recipient}`, prompt, undefined, {
      internal: true,
      userMessageMetadata: { kind: "daily_digest", date },
    });
    const sent = await send(db, recipient, response.text);
    recordOutboundChannelMessage(db, "sms", recipient, response.text, sent.sid, sent.status, {
      kind: "daily_digest",
      date,
    });
    search.flushSoon();
    db.prepare(`
      UPDATE scheduled_dispatches SET status='sent',provider_message_id=?,updated_at=? WHERE id=?
    `).run(sent.sid, now(), dispatchId);
  } catch (error) {
    recordDispatchFailure(db, dispatchId, error, "Digest failed");
  }
}

async function deliverDigestBrief(
  db: Db,
  search: SearchWriter,
  brief: DigestBriefRow,
  recipient: string,
  local: { date: string; time: string },
  timezone: string,
  runAgent: typeof runSmsAgent,
  send: typeof sendSms,
): Promise<void> {
  // One send per brief per local day, so the 60s tick can pass the send time
  // repeatedly without sending again.
  const dispatchId = claimDispatch(
    db,
    "digest_brief",
    `digest_brief:${brief.id}:${local.date}`,
    `${local.date}T${brief.send_time}`,
  );
  if (!dispatchId) return;
  try {
    const prompt = await composeBriefTurn(db, brief, { date: local.date, timezone });
    /*
     * Drafted on its own thread like the daily digest: the composed instruction
     * and its resource catalog must not land in the real SMS history, but the
     * text that reached the phone is recorded on the number it went to.
     */
    const response = await runAgent(db, search, `digest:${recipient}`, prompt, undefined, {
      internal: true,
      /*
       * History renders this turn from the metadata rather than from the prompt,
       * so the catalog of board IDs stays collapsed behind the instruction the
       * user actually wrote.
       */
      userMessageMetadata: {
        kind: "digest_brief",
        briefId: brief.id,
        briefName: brief.name,
        instruction: brief.prompt,
        date: local.date,
      },
    });
    const sent = await send(db, recipient, response.text);
    recordOutboundChannelMessage(db, "sms", recipient, response.text, sent.sid, sent.status, {
      kind: "digest_brief",
      briefId: brief.id,
      briefName: brief.name,
      date: local.date,
    });
    search.flushSoon();
    db.prepare(`
      UPDATE scheduled_dispatches SET status='sent',provider_message_id=?,updated_at=? WHERE id=?
    `).run(sent.sid, now(), dispatchId);
  } catch (error) {
    recordDispatchFailure(db, dispatchId, error, "Digest brief failed");
  }
}

/**
 * Housekeeping that has no other natural trigger. Without this, `index_jobs`
 * grows forever, expired sessions only disappear when somebody signs in, and
 * outbox work queued before a restart waits for the next unrelated write.
 */
async function runMaintenance(db: Db, search: SearchWriter): Promise<void> {
  pruneExpiredSessions(db);
  const cutoff = new Date(Date.now() - COMPLETED_JOB_TTL_MS).toISOString();
  db.prepare("DELETE FROM index_jobs WHERE status='done' AND updated_at<?").run(cutoff);
  db.prepare("DELETE FROM scheduled_dispatches WHERE status='sent' AND updated_at<?").run(cutoff);
  const pending = db.prepare(`
    SELECT count(*) count FROM index_jobs WHERE status IN ('pending','failed')
  `).get() as { count: number };
  if (pending.count) await search.flush({ limit: pending.count });
}

export async function runWorkerOnce(
  db: Db,
  search: SearchWriter,
  dependencies: WorkerDependencies = {},
): Promise<void> {
  const send = dependencies.sendSms || sendSms;
  const runAgent = dependencies.runSmsAgent || runSmsAgent;
  const pollMeetings = dependencies.pollGranola || pollGranola;
  const showTyping = dependencies.startTypingIndicator || startTypingIndicator;
  for (const { source, read } of INBOUND_SOURCES) {
    for (const event of claimExternalEvents(db, source, 20)) {
      let typing: TypingIndicator | null = null;
      try {
        const message = read(JSON.parse(event.payload_json) as Record<string, unknown>);
        if (!message.from || !message.body) throw new Error("Inbound SMS event is missing a sender or body");
        // The bubble goes up before the turn starts and stays up for as long as
        // it takes, so the wait for an answer is not silent.
        typing = showTyping(db, message.from);
        const response = await runAgent(db, search, message.from, message.body, message.messageId);
        typing.release();
        const sent = await send(db, message.from, response.text);
        recordOutboundProviderMessage(db, response.threadId, sent.sid, sent.status);
        completeExternalEvent(db, event.id, "processed");
      } catch (error) {
        typing?.cancel();
        completeExternalEvent(
          db,
          event.id,
          "failed",
          error instanceof Error ? error.message : "Inbound SMS processing failed",
        );
      }
    }
  }
  const preferences = getNotificationPreferences(db);
  const local = localParts(new Date(), preferences.timezone);
  if (
    preferences.smsEnabled
    && preferences.recipientPhone
    && !preferences.optedOutAt
    && !inQuietHours(local.time, preferences.quietHoursStart, preferences.quietHoursEnd)
  ) {
    for (const reminder of claimDueReminders(db)) {
      await deliverReminder(db, search, reminder, preferences.recipientPhone, send);
    }
    if (preferences.dailyDigestEnabled && local.time >= preferences.dailyDigestTime) {
      await deliverDailyDigest(
        db,
        search,
        preferences.recipientPhone,
        local.date,
        {
          timezone: preferences.timezone,
          includeTodos: preferences.digestIncludeTodos,
          includeOverdue: preferences.digestIncludeOverdue,
        },
        runAgent,
        send,
      );
    }
    // Briefs run on their own send times inside the same quiet-hours gate, so
    // one enforcement covers every outbound channel message.
    for (const brief of dueDigestBriefs(db, local.time)) {
      await deliverDigestBrief(
        db, search, brief, preferences.recipientPhone, local, preferences.timezone, runAgent, send,
      );
    }
  }
  try {
    await pollMeetings(db);
  } catch (error) {
    db.prepare(`
      UPDATE integration_settings SET status='error',last_error=?,updated_at=?
      WHERE user_id=? AND provider='granola'
    `).run(error instanceof Error ? error.message.slice(0, 1000) : "Granola polling failed", now(), USER_ID);
  }
  try {
    await runMaintenance(db, search);
  } catch (error) {
    console.error("Worker maintenance failed", error);
  }
}

/** Set while a worker is running, so `requestWorkerWake()` has something to call. */
let wakeRunningWorker: (() => void) | null = null;

/**
 * Ask the running worker to drain now rather than at its next tick. An inbound
 * event is otherwise invisible until the interval comes round, which leaves a
 * reply up to a full minute behind the text that asked for it. A no-op when no
 * worker is running, which covers tests and the one-shot CLI entry points.
 */
export function requestWorkerWake(): void {
  const wake = wakeRunningWorker;
  if (!wake) return;
  // Deferred so a webhook handler finishes answering before the drain starts.
  setImmediate(wake);
}

export function startWorker(
  db: Db,
  search: SearchWriter,
  dependencies: WorkerDependencies = {},
): () => void {
  let running = false;
  let woken = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // An event enqueued mid-drain arrived too late for the claim already in
      // flight, so a wake raised during a tick earns another pass rather than
      // waiting out the interval it just missed.
      do {
        woken = false;
        await runWorkerOnce(db, search, dependencies);
      } while (woken);
    } catch (error) {
      console.error("Background worker failed", error);
    } finally {
      running = false;
    }
  };
  // Interval ticks are still dropped while one is in flight; only an explicit
  // wake schedules the extra pass.
  const wake = () => {
    if (running) woken = true;
    else void tick();
  };
  wakeRunningWorker = wake;
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (wakeRunningWorker === wake) wakeRunningWorker = null;
  };
}
