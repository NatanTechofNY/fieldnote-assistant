import type { AlgoliaSync } from "./algolia.ts";
import { getNotificationPreferences, type SmsProvider } from "./integrations.ts";
import { pruneExpiredSessions } from "./auth.ts";
import { getTodo, id, now, queueIndexJob, syncTodoReminders, USER_ID } from "./db.ts";
import { materializeRecurrence, parseRecurrence } from "./recurrence.ts";
import { liftProgressMark, recordOutboundChannelMessage, recordOutboundProviderMessage, runSmsAgent } from "./agent-runner.ts";
import { composeDigestTurn, composeEveningCheckinTurn } from "./daily-digest.ts";
import { composeBriefTurn, dueDigestBriefs } from "./digest-briefs.ts";
import { composeGroupEveningTurn, composeGroupMorningTurn, groupCheckinItems } from "./group-checkin.ts";
import {
  claimExternalEvents, completeExternalEvent, deferExternalEvent, nextExternalEventAvailableAt, pollGranola,
  pruneSettledExternalEvents, STALE_CLAIM_MS, unsettledExternalEventsBefore,
} from "./event-ingestion.ts";
import { localParts } from "./local-time.ts";
import { isSmsProviderConnected, sendSms, startTypingIndicator } from "./messaging.ts";
import { openSubtasks } from "./todo-status.ts";
import { isTransientFailure } from "./transient.ts";
import { groupAddress, groupIdOfAddress, OWNER_SPEAKER_NAME } from "./group-thread.ts";
import { readSendblueInbound, type StopTypingIndicator } from "./sendblue-service.ts";
import type { Db, DigestBriefRow, ExternalEventRow, ReminderRow, TodoRow } from "./types.ts";

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
type InboundMessage = {
  from?: string;
  body?: string;
  messageId?: string;
  replyTo?: string;
  threadOriginator?: string;
  /** Set when the text arrived in an iMessage group chat; only Sendblue carries these. */
  groupId?: string;
  groupName?: string;
};

const INBOUND_SOURCES: Array<{
  source: SmsProvider;
  read: (payload: Record<string, unknown>) => InboundMessage;
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
    read: payload => {
      const inbound = readSendblueInbound(payload);
      return {
        from: inbound.from,
        body: inbound.body,
        messageId: inbound.messageHandle,
        replyTo: inbound.replyTo,
        threadOriginator: inbound.threadOriginator,
        groupId: inbound.groupId,
        groupName: inbound.groupName,
      };
    },
  },
];

/**
 * The thread address and the per-message metadata for a text that arrived in a
 * group. The speaker is named from the trusted contacts list when it can be, so
 * the transcript and the agent see "Sarah" rather than a phone number; the
 * recipient is named as the owner because that is the only name the app has.
 */
function groupTurn(
  db: Db,
  groupId: string,
  from: string,
  groupName: string | undefined,
): { address: string; metadata: Record<string, unknown> } {
  const preferences = getNotificationPreferences(db);
  const contact = preferences.trustedContacts.find(entry => entry.phone === from);
  const speakerIsOwner = from === preferences.recipientPhone;
  const speakerName = contact?.name ?? (speakerIsOwner ? OWNER_SPEAKER_NAME : undefined);
  return {
    address: groupAddress(groupId),
    metadata: {
      groupId,
      ...(groupName ? { groupName } : {}),
      speaker: from,
      ...(speakerName ? { speakerName } : {}),
      // What the tools that only the owner may drive check, decided here where
      // the recipient number is known rather than by the agent from a label.
      // Always present: a missing flag left the model guessing, and it guessed
      // that a rename from the owner's wife was the owner's to make.
      speakerIsOwner,
    },
  };
}

/** The thread an inbound text belongs to: the group when it came from one, else the sender. */
function inboundAddress(message: InboundMessage): string {
  return message.groupId ? groupAddress(message.groupId) : message.from ?? "";
}

/**
 * How many times an earlier text in the same thread may fail before the texts
 * behind it stop waiting for it. Ordering is worth a few short retries; it is
 * not worth an hour of silence behind a turn that is never going to answer.
 */
const MAX_ORDERED_ATTEMPTS = 3;
/** How long a deferred text waits when the text in front of it is claimed rather than scheduled. */
const DEFER_BEHIND_CLAIM_MS = 2_000;
/** The shortest wait before a retry wake, so a drain that failed early cannot spin. */
const RETRY_WAKE_FLOOR_MS = 250;

/**
 * The earlier text in `event`'s thread that has to be answered first, if any.
 *
 * Texts in one thread are answered in the order they were sent. A turn that
 * fails is retried behind a backoff, and a text that arrived a few seconds
 * behind it used to be claimed in that gap: it read the thread with the failed
 * turn unanswered and did that turn's work again. "Yes, make those todos" hit
 * the iteration cap after ten creates; "all due Sunday" ran next, saw the list
 * untouched, and created all ten again. So a text waits while an earlier text
 * in its thread is unsettled — pending, failed, or still claimed — and is
 * released once the earlier one has been retried a few times without answering.
 */
function threadBlocker(
  db: Db,
  source: SmsProvider,
  read: (payload: Record<string, unknown>) => InboundMessage,
  event: ExternalEventRow,
  address: string,
): { availableAt: string } | null {
  for (const earlier of unsettledExternalEventsBefore(db, source, event)) {
    if (earlier.id === event.id || earlier.attempts > MAX_ORDERED_ATTEMPTS) continue;
    let earlierAddress: string;
    try {
      earlierAddress = inboundAddress(read(JSON.parse(earlier.payload_json) as Record<string, unknown>));
    } catch {
      continue;
    }
    if (earlierAddress !== address) continue;
    /*
     * The worker is one sequential loop, so an earlier text still marked
     * `processing` is a claim a crash left behind, not one in flight; it comes
     * back when the claim goes stale, and the text behind it waits for that
     * moment rather than knocking every two seconds until then.
     */
    const dueAt = earlier.status === "processing"
      ? new Date(Date.parse(earlier.updated_at) + STALE_CLAIM_MS).toISOString()
      : earlier.available_at;
    const behindClaim = new Date(Date.now() + DEFER_BEHIND_CLAIM_MS).toISOString();
    return { availableAt: dueAt > behindClaim ? dueAt : behindClaim };
  }
  return null;
}

/** What the thread hears when a text has been tried `MAX_EVENT_ATTEMPTS` times and is being let go. */
export const GAVE_UP_TEXT = "Sorry, I couldn't get through that one. Could you send it again?";

/**
 * The last word on a text the agent never managed to answer. Silence is the
 * worst outcome: the sender saw a progress tapback go up and nothing follow.
 * One plain line into the same thread says so; it is best effort, since the
 * same outage that failed the turn may refuse this too.
 */
async function giveUpOnTurn(
  db: Db, source: SmsProvider, message: InboundMessage, send: typeof sendSms,
): Promise<void> {
  const address = inboundAddress(message);
  // The progress tapback was left up for a retry that is no longer coming.
  if (source === "sendblue" && message.messageId) await liftProgressMark(db, address, message.messageId);
  let sent: Awaited<ReturnType<typeof sendSms>>;
  try {
    // Threaded under the text it is about: by now the texts behind it have
    // been answered, and "that one" would otherwise point at nothing.
    sent = await send(db, address, GAVE_UP_TEXT, {
      ...(source === "sendblue" && message.messageId ? { replyTo: message.messageId } : {}),
      ...(message.groupId ? { groupId: message.groupId } : {}),
    });
  } catch (error) {
    console.warn("Could not tell the thread the turn was given up:", error instanceof Error ? error.message : error);
    return;
  }
  recordOutboundChannelMessage(db, "sms", address, GAVE_UP_TEXT, sent.sid, sent.status, {
    kind: "gave_up",
    ...(sent.replyTo ? { replyTo: sent.replyTo } : {}),
  });
}

function inQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

/**
 * Moves each repeating todo on to its next occurrence once the local day of the
 * one it holds is over. Completing the row marks it done for the rest of that
 * day, which is what the list should show; a miss simply rolls forward at
 * midnight rather than sitting overdue for ever. The worker is the only writer
 * that does this, so the row cannot be rolled twice, and it happens whether or
 * not texting is enabled because it is scheduling, not delivery.
 *
 * Each row is rolled on its own: a rule the engine cannot walk is logged and
 * skipped rather than allowed to stop every row behind it, on every tick.
 */
export function rollRecurringTodos(db: Db, search: SearchWriter, timezone: string, at = new Date()): number {
  const today = localParts(at, timezone).date;
  const rows = db.prepare(`
    SELECT * FROM todos
    WHERE user_id=? AND recurrence_json IS NOT NULL AND status<>'cancelled'
  `).all(USER_ID) as TodoRow[];
  let rolled = 0;
  for (const row of rows) {
    try {
      const rule = parseRecurrence(row.recurrence_json);
      if (!rule) continue;
      if (row.due_at && localParts(new Date(row.due_at), timezone).date >= today) continue;
      // The next occurrence is the first on today's date or later, decided on
      // dates so a worker that was down overnight still lands on today's slot
      // (late, and so texted at once) instead of skipping to tomorrow's. A row
      // that has lost its date altogether is put back on the series from now.
      const next = materializeRecurrence(rule, timezone, row.due_at ? { date: today } : at);
      // A block is about the task, not the day, so it survives the roll; a
      // finished or started occurrence does not.
      const status = row.status === "blocked" ? "blocked" : "pending";
      db.transaction(() => {
        db.prepare(`
          UPDATE todos SET due_at=?,reminder_at=?,extra_reminders_json='[]',status=?,
            started_at=NULL,completed_at=NULL,updated_at=? WHERE id=? AND user_id=?
        `).run(next.due_at, next.reminder_at, status, now(), row.id, USER_ID);
        const updated = getTodo(db, row.id);
        if (updated) syncTodoReminders(db, updated);
        queueIndexJob(db, "todo", row.id);
      })();
      rolled += 1;
    } catch (error) {
      console.error(`Rolling repeating todo ${row.id} failed`, error);
    }
  }
  if (rolled) search.flushSoon();
  return rolled;
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
    /*
     * A reminder goes back to the group only while its todo is still filed in
     * that group's life area. The thread pointer alone is not enough: the owner
     * can move a group todo to Work or Personal, or remove the group's area, and
     * from then on the todo is theirs alone and so is its reminder.
     */
    const rows = db.prepare(`
      SELECT r.*,t.title todo_title,t.life_area_id todo_life_area_id,ct.address reply_address FROM reminders r
      JOIN todos t ON t.id=r.todo_id
      LEFT JOIN channel_threads ct
        ON ct.id=t.reply_thread_id
        AND EXISTS (SELECT 1 FROM life_areas la WHERE la.thread_id=ct.id AND la.id=t.life_area_id)
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
function reminderBody(db: Db, reminder: ReminderRow, groupBound: boolean): string {
  const headline = `Reminder: ${reminder.todo_title || "You have a task due."}`;
  // Into a group, only the steps the group can see; the owner may have filed a
  // private one under the same parent from the app.
  const open = openSubtasks(db, reminder.todo_id, groupBound ? reminder.todo_life_area_id ?? undefined : undefined);
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
    /*
     * A todo asked for in a group chat is reminded about in that chat, so
     * everyone who heard the ask hears the reminder; anything else goes to the
     * recipient's own number. The group id is read off the thread address so
     * the reminder needs no column of its own. Only iMessage has groups: with
     * Sendblue disconnected the reminder would fail on every retry, so it goes
     * to the recipient instead of nowhere.
     */
    const groupId = reminder.reply_address ? groupIdOfAddress(reminder.reply_address) : undefined;
    const groupBound = Boolean(groupId) && isSmsProviderConnected(db, "sendblue");
    const content = reminderBody(db, reminder, groupBound);
    const target = groupBound ? (reminder.reply_address as string) : recipient;
    const message = await send(db, target, content, groupBound ? { groupId } : {});
    recordOutboundChannelMessage(db, "sms", target, content, message.sid, message.status, {
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
  kind: "daily_digest" | "digest_brief" | "group_checkin",
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
 * The owner's evening question, on the digest's rails: composed on the scratch
 * thread, texted to the recipient, and recorded on their real thread so the
 * reply that follows is read with the question right above it — which is what
 * the prompt's end-of-day rules key on.
 */
async function deliverEveningCheckin(
  db: Db,
  search: SearchWriter,
  recipient: string,
  local: { date: string; time: string },
  timezone: string,
  ask: string | null,
  runAgent: typeof runSmsAgent,
  send: typeof sendSms,
): Promise<void> {
  const dispatchId = claimDispatch(db, "daily_digest", `evening_checkin:${USER_ID}:${local.date}`, now());
  if (!dispatchId) return;
  try {
    const prompt = composeEveningCheckinTurn(db, { date: local.date, timezone, ask });
    const response = await runAgent(db, search, `digest:${recipient}`, prompt, undefined, {
      internal: true,
      userMessageMetadata: { kind: "evening_checkin", date: local.date },
    });
    const sent = await send(db, recipient, response.text);
    recordOutboundChannelMessage(db, "sms", recipient, response.text, sent.sid, sent.status, {
      kind: "evening_checkin",
      date: local.date,
    });
    search.flushSoon();
    db.prepare(`
      UPDATE scheduled_dispatches SET status='sent',provider_message_id=?,updated_at=? WHERE id=?
    `).run(sent.sid, now(), dispatchId);
  } catch (error) {
    recordDispatchFailure(db, dispatchId, error, "Evening check-in failed");
  }
}

/** A group's area with a check-in set, and the chat it belongs to. */
type CheckinAreaRow = {
  id: string;
  name: string;
  address: string;
  morning_checkin_time: string | null;
  evening_checkin_time: string | null;
  checkin_copy_to_owner: 0 | 1;
  morning_checkin_prompt: string | null;
  evening_checkin_prompt: string | null;
};

function checkinAreas(db: Db): CheckinAreaRow[] {
  return db.prepare(`
    SELECT la.id,la.name,t.address,la.morning_checkin_time,la.evening_checkin_time,la.checkin_copy_to_owner,
      la.morning_checkin_prompt,la.evening_checkin_prompt
    FROM life_areas la JOIN channel_threads t ON t.id=la.thread_id
    WHERE la.user_id=? AND (la.morning_checkin_time IS NOT NULL OR la.evening_checkin_time IS NOT NULL)
    ORDER BY la.name
  `).all(USER_ID) as CheckinAreaRow[];
}

/**
 * A group's morning note or evening question, into the group itself.
 *
 * Unlike the digest this is composed on the group's own thread: the turn then
 * carries the group's scope, so whatever the agent reads while writing stays
 * the group's, and the message lands where the replies to it will. The
 * instruction row is internal and left out of later windows by
 * `threadHistory()`; the reply row stays, tagged with the kind, so "laundry's
 * done" or a line about the day is read against the question it answers. One
 * dispatch per group per kind per local day; a morning with nothing to say
 * takes its slot without sending, so the tick does not recompute all day.
 */
async function deliverGroupCheckin(
  db: Db,
  search: SearchWriter,
  kind: "morning" | "evening",
  area: CheckinAreaRow,
  recipient: string,
  local: { date: string; time: string },
  timezone: string,
  runAgent: typeof runSmsAgent,
  send: typeof sendSms,
): Promise<void> {
  const groupId = groupIdOfAddress(area.address);
  if (!groupId) return;
  const dispatchId = claimDispatch(db, "group_checkin", `group_checkin:${kind}:${area.id}:${local.date}`, now());
  if (!dispatchId) return;
  const metaKind = kind === "morning" ? "group_morning" : "group_evening";
  try {
    if (kind === "morning" && !groupCheckinItems(db, area.id, local.date, timezone).lines.length) {
      db.prepare(`
        UPDATE scheduled_dispatches SET status='sent',last_error='Nothing open to mention',updated_at=? WHERE id=?
      `).run(now(), dispatchId);
      return;
    }
    const checkinArea = {
      id: area.id, name: area.name, groupId,
      morningAsk: area.morning_checkin_prompt, eveningAsk: area.evening_checkin_prompt,
    };
    const prompt = kind === "morning"
      ? composeGroupMorningTurn(db, checkinArea, { date: local.date, timezone })
      : composeGroupEveningTurn(db, checkinArea, { date: local.date, timezone });
    const response = await runAgent(db, search, area.address, prompt, undefined, {
      internal: true,
      inbound: { provider: "sendblue", groupId },
      userMessageMetadata: { kind: metaKind, groupId, date: local.date },
      assistantMetadata: { kind: metaKind, date: local.date },
      sendSms: send,
    });
    if (!response.text) throw new Error(`The ${kind} check-in came back empty`);
    const sent = await send(db, area.address, response.text, { groupId });
    // The runner already archived the reply on the group thread; this pins the provider's id to it.
    recordOutboundProviderMessage(db, response.threadId, sent.sid, sent.status);
    search.flushSoon();
    db.prepare(`
      UPDATE scheduled_dispatches SET status='sent',provider_message_id=?,updated_at=? WHERE id=?
    `).run(sent.sid, now(), dispatchId);
    /*
     * The owner's copy, when asked for, on their own number and their own
     * thread. Best effort once the group has its message: the dispatch is
     * settled, so a copy that fails is logged rather than resending the group.
     */
    if (area.checkin_copy_to_owner) {
      try {
        const copy = await send(db, recipient, response.text);
        recordOutboundChannelMessage(db, "sms", recipient, response.text, copy.sid, copy.status, {
          kind: metaKind, date: local.date, groupId, copyOf: area.id, groupName: area.name,
        });
      } catch (error) {
        console.warn(`Could not copy the ${kind} check-in to the owner:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    recordDispatchFailure(db, dispatchId, error, `Group ${kind} check-in failed`);
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
  pruneSettledExternalEvents(db, INBOUND_SOURCES.map(entry => entry.source), cutoff);
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
      let stopTyping: StopTypingIndicator | null = null;
      // Read outside the try so a turn that is given up can still be told where to say so.
      let message: InboundMessage | undefined;
      try {
        message = read(JSON.parse(event.payload_json) as Record<string, unknown>);
        if (!message.from || !message.body) throw new Error("Inbound SMS event is missing a sender or body");
        /*
         * A group chat is one thread shared by everyone in it, so it is keyed on
         * the group rather than on whoever spoke, and the speaker travels as
         * metadata so the transcript still says who asked for what. Typing
         * indicators are a 1:1 iMessage feature and are not raised for a group.
         */
        const address = inboundAddress(message);
        const blocker = threadBlocker(db, source, read, event, address);
        if (blocker) {
          deferExternalEvent(db, event.id, blocker.availableAt);
          continue;
        }
        const group = message.groupId ? groupTurn(db, message.groupId, message.from, message.groupName) : null;
        // The bubble goes up before the turn starts and comes down once the reply
        // is out rather than in between, so the wait is covered end to end and no
        // bubble outlives the answer.
        stopTyping = group ? () => {} : showTyping(db, message.from);
        const response = await runAgent(db, search, address, message.body, message.messageId, {
          inbound: {
            provider: source,
            replyTo: message.replyTo,
            threadOriginator: message.threadOriginator,
            ...(message.groupId ? { groupId: message.groupId } : {}),
          },
          ...(group ? { userMessageMetadata: group.metadata } : {}),
          sendSms: send,
        });
        // An empty reply is a turn a tapback answered on its own; there is
        // nothing to send and no outbound row to file a provider id on.
        if (response.text) {
          // The agent threads its answer only when it asked to, via reply_in_thread.
          const sent = await send(db, address, response.text, {
            replyTo: response.replyTo,
            ...(message.groupId ? { groupId: message.groupId } : {}),
          });
          recordOutboundProviderMessage(db, response.threadId, sent.sid, sent.status, sent.replyTo);
        }
        stopTyping();
        completeExternalEvent(db, event.id, "processed");
      } catch (error) {
        stopTyping?.();
        const reason = error instanceof Error ? error.message : "Inbound SMS processing failed";
        // The row's last_error is overwritten by the attempt that succeeds, so
        // without this line a turn that took three tries leaves no trace of why.
        console.warn(`Inbound ${source} turn failed on attempt ${event.attempts}: ${reason}`);
        // An outage earns the full run of retries; a turn that failed on its own
        // terms will fail the same way, and gets one more try to rule out a fluke.
        const settled = completeExternalEvent(db, event.id, "failed", reason, { transient: isTransientFailure(error) });
        if (settled === "ignored" && message?.from) {
          // Nothing here may take the rest of the batch down with it.
          try {
            await giveUpOnTurn(db, source, message, send);
          } catch (giveUpError) {
            console.warn("Giving up on the turn failed:", giveUpError instanceof Error ? giveUpError.message : giveUpError);
          }
        }
      }
    }
  }
  const preferences = getNotificationPreferences(db);
  const local = localParts(new Date(), preferences.timezone);
  try {
    rollRecurringTodos(db, search, preferences.timezone);
  } catch (error) {
    console.error("Rolling recurring todos failed", error);
  }
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
    if (preferences.eveningCheckinTime && local.time >= preferences.eveningCheckinTime) {
      await deliverEveningCheckin(
        db, search, preferences.recipientPhone, local, preferences.timezone, preferences.eveningCheckinPrompt, runAgent, send,
      );
    }
    // A group's check-ins go into the group, which only iMessage can carry.
    if (isSmsProviderConnected(db, "sendblue")) {
      for (const area of checkinAreas(db)) {
        if (area.morning_checkin_time && local.time >= area.morning_checkin_time) {
          await deliverGroupCheckin(db, search, "morning", area, preferences.recipientPhone, local, preferences.timezone, runAgent, send);
        }
        if (area.evening_checkin_time && local.time >= area.evening_checkin_time) {
          await deliverGroupCheckin(db, search, "evening", area, preferences.recipientPhone, local, preferences.timezone, runAgent, send);
        }
      }
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
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
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
      scheduleRetryWake();
    }
  };
  // Interval ticks are still dropped while one is in flight; only an explicit
  // wake schedules the extra pass.
  const wake = () => {
    if (running) woken = true;
    else void tick();
  };
  /*
   * A failed turn's retry and a text deferred behind it are both scheduled a
   * few seconds out, which the interval alone would stretch to a minute. The
   * drain leaves a one-shot wake at the earliest of them instead.
   */
  const scheduleRetryWake = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (stopped) return;
    let next: string | null;
    try {
      next = nextExternalEventAvailableAt(db, INBOUND_SOURCES.map(entry => entry.source));
    } catch {
      return;
    }
    if (!next) return;
    const delay = Date.parse(next) - Date.now();
    // The interval already covers anything a minute or more out, and a floor
    // keeps a drain that threw before claiming from spinning on a zero delay.
    if (delay >= 60_000) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wake();
    }, Math.max(RETRY_WAKE_FLOOR_MS, delay));
    retryTimer.unref();
  };
  wakeRunningWorker = wake;
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (wakeRunningWorker === wake) wakeRunningWorker = null;
  };
}
