import { now, queueIndexJob } from "../db.ts";
import { enqueueExternalEvent } from "../event-ingestion.ts";
import { markOwnerLeftGroup } from "../group-members.ts";
import { groupIdOfAddress } from "../group-thread.ts";
import { mediaUrlsOf } from "../image-input.ts";
import { getNotificationPreferences, getSendblueSecret, getTwilioSecret, recordSendblueNotice, setSmsOptOut } from "../integrations.ts";
import { isInboundSenderAllowed, ownerHasSpokenInGroup, sendSms } from "../messaging.ts";
import { normalizeSendblueStatus, readSendblueInbound, SENDBLUE_INBOUND_PATH, SENDBLUE_LINE_ASSIGNED_PATH, SENDBLUE_LINE_BLOCKED_PATH, SENDBLUE_STATUS_PATH, verifySendblueWebhook } from "../sendblue-service.ts";
import { validateTwilioSignature } from "../twilio-service.ts";
import { requestWorkerWake } from "../worker.ts";
import type { Db } from "../types.ts";
import type { RouteContext } from "./context.ts";

const STOP_WORDS = /^(stop|unsubscribe|cancel|end|quit)$/i;
const START_WORDS = /^(start|unstop)$/i;

/**
 * A delivery receipt is the only place a message's fate is known, so both
 * providers converge here: the receipt updates the stored message and, when the
 * carrier refused it, marks the reminder that message was carrying as failed.
 */
function applyDeliveryStatus(
  db: Db,
  providerMessageId: string,
  status: "queued" | "sent" | "delivered" | "failed",
  error: string,
): void {
  db.prepare(`
    UPDATE channel_messages SET status=?,updated_at=? WHERE provider_message_id=?
  `).run(status, now(), providerMessageId);
  if (status !== "failed") return;
  // The provider's reason stays with the message, so a check-in or an answer that
  // never arrived can be explained afterwards rather than only marked failed. Cut
  // to a sentence or two: the row is read on every window and history load.
  db.prepare(`
    UPDATE channel_messages SET metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.deliveryError',?)
    WHERE provider_message_id=?
  `).run(error.replace(/\s+/g, " ").trim().slice(0, 500), providerMessageId);
  db.prepare(`
    UPDATE reminders SET status='failed',last_error=?,updated_at=? WHERE provider_message_id=?
  `).run(error, now(), providerMessageId);
}

/** Sendblue accepts an inline reply and only later finds the part it names gone. */
const LOST_REPLY_TARGET = /invalid reply target/i;

/**
 * A threaded reply Sendblue took and then could not place never reached anyone.
 * The words still matter more than the thread, so the message goes out once
 * more on its own and the row takes the new handle; the flag keeps a second
 * receipt for the same row from sending it twice.
 */
async function resendUnthreaded(db: Db, providerMessageId: string): Promise<void> {
  const row = db.prepare(`
    SELECT m.id,m.content,m.metadata_json,t.address FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE m.provider_message_id=? AND m.role='assistant' AND m.status='failed'
      AND json_extract(m.metadata_json,'$.replyTo') IS NOT NULL
      AND json_extract(m.metadata_json,'$.resentUnthreaded') IS NULL
  `).get(providerMessageId) as { id: string; content: string; metadata_json: string | null; address: string } | undefined;
  if (!row) return;
  db.prepare(`
    UPDATE channel_messages SET metadata_json=json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.resentUnthreaded',json('true'))
    WHERE id=?
  `).run(row.id);
  const metadata = JSON.parse(row.metadata_json || "{}") as { mediaUrl?: unknown };
  const mediaUrl = typeof metadata.mediaUrl === "string" ? metadata.mediaUrl : undefined;
  const groupId = groupIdOfAddress(row.address);
  try {
    const sent = await sendSms(db, row.address, mediaUrl && row.content === "(picture)" ? "" : row.content, {
      ...(groupId ? { groupId } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
    });
    db.prepare(`
      UPDATE channel_messages SET provider_message_id=?,status=?,updated_at=?,
        metadata_json=json_remove(metadata_json,'$.replyTo','$.deliveryError')
      WHERE id=?
    `).run(sent.sid, sent.status === "queued" ? "queued" : "sent", now(), row.id);
    queueIndexJob(db, "channel_message", row.id);
  } catch (error) {
    console.warn("Resending an unthreadable reply failed:", error instanceof Error ? error.message : error);
  }
}

export function registerWebhookRoutes({ app, db }: RouteContext): void {
  app.post("/api/webhooks/twilio/sms", (req, res) => {
    const config = getTwilioSecret(db);
    if (!config) return res.status(503).type("text/xml").send("<Response></Response>");
    const params = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
    const base = config.webhookBaseUrl?.replace(/\/$/, "");
    const signatureUrl = base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!validateTwilioSignature(config, req.get("x-twilio-signature"), signatureUrl, params)) {
      return res.status(403).send("Invalid Twilio signature");
    }
    const from = params.From;
    const messageSid = params.MessageSid;
    const body = params.Body?.trim() ?? "";
    // A picture sent on its own arrives with an empty body and is still a message.
    if (!from || !messageSid || (!body && !mediaUrlsOf(params).length)) return res.status(400).send("Missing SMS fields");
    const preferences = getNotificationPreferences(db);
    // SMS has no group chats, so Twilio only ever hears from the recipient.
    if (!isInboundSenderAllowed(preferences, { from, participants: [] })) {
      return res.status(403).send("Phone number is not allowed");
    }
    if (STOP_WORDS.test(body)) setSmsOptOut(db, true);
    else if (START_WORDS.test(body)) setSmsOptOut(db, false);
    else {
      enqueueExternalEvent(db, "twilio", messageSid, "twilio.sms.received", params);
      requestWorkerWake();
    }
    return res.type("text/xml").send("<Response></Response>");
  });
  app.post("/api/webhooks/twilio/status", (req, res) => {
    const config = getTwilioSecret(db);
    if (!config) return res.sendStatus(204);
    const params = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
    const base = config.webhookBaseUrl?.replace(/\/$/, "");
    const signatureUrl = base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!validateTwilioSignature(config, req.get("x-twilio-signature"), signatureUrl, params)) {
      return res.status(403).send("Invalid Twilio signature");
    }
    const providerStatus = params.MessageStatus;
    const status = providerStatus === "delivered" ? "delivered"
      : providerStatus === "failed" || providerStatus === "undelivered" ? "failed"
        : providerStatus === "sent" ? "sent" : "queued";
    applyDeliveryStatus(
      db,
      params.MessageSid,
      status,
      params.ErrorMessage || providerStatus || "Twilio delivery failed",
    );
    return res.sendStatus(204);
  });
  /*
   * Sendblue posts JSON and expects a 2xx; anything else makes it redeliver the
   * same message up to three times, which is why a rejected sender or a missing
   * field is still acknowledged rather than answered with an error.
   */
  app.post(SENDBLUE_INBOUND_PATH, (req, res) => {
    const config = getSendblueSecret(db);
    if (!config) return res.status(503).json({ received: false });
    if (!verifySendblueWebhook(config, req)) return res.status(403).json({ received: false });
    const payload = req.body as Record<string, unknown>;
    // The `outbound` webhook and the inbound one can share a URL, and an echo of
    // our own message must not be answered as if the user had written it.
    if (payload.is_outbound === true) return res.json({ received: true, ignored: "outbound" });
    const inbound = readSendblueInbound(payload);
    const { from, messageHandle, groupId, participants } = inbound;
    const body = inbound.body?.trim() ?? "";
    if (!from || !messageHandle) return res.status(400).json({ received: false });
    // Messages sends a pasted link's preview card as its own message with no
    // words; it is acknowledged so Sendblue does not deliver it again.
    if (!body && !mediaUrlsOf(payload).length) {
      return typeof payload.media_url === "string" && payload.media_url.trim()
        ? res.json({ received: true, ignored: "link_preview" })
        : res.status(400).json({ received: false });
    }
    const preferences = getNotificationPreferences(db);
    const owner = preferences.recipientPhone;
    const ownerPresent = Boolean(groupId && owner && participants.includes(owner));
    const ownerHasSpoken = ownerPresent && from !== owner ? ownerHasSpokenInGroup(db, groupId as string, owner as string) : undefined;
    if (!isInboundSenderAllowed(preferences, { from, groupId, participants, ownerHasSpoken })) {
      // A stranger texting the line is an anomaly and gets the refusal. Someone
      // the owner has not trusted writing in a group the owner is in is an
      // ordinary event, and a 403 would only make Sendblue deliver it three more
      // times; it is acknowledged and dropped instead.
      if (ownerPresent) return res.json({ received: true, ignored: "sender" });
      if (groupId && owner && participants.length) markOwnerLeftGroup(db, groupId, owner);
      return res.status(403).json({ received: false });
    }
    // Opting out is the recipient's call. A trusted contact in a group is heard
    // by the assistant but cannot switch the owner's texts off or on.
    const ownerSpeaking = !groupId || from === preferences.recipientPhone;
    if (ownerSpeaking && STOP_WORDS.test(body)) setSmsOptOut(db, true);
    else if (ownerSpeaking && START_WORDS.test(body)) setSmsOptOut(db, false);
    else {
      enqueueExternalEvent(db, "sendblue", messageHandle, "sendblue.message.received", payload);
      requestWorkerWake();
    }
    return res.json({ received: true });
  });
  app.post(SENDBLUE_STATUS_PATH, (req, res) => {
    const config = getSendblueSecret(db);
    if (!config) return res.sendStatus(204);
    if (!verifySendblueWebhook(config, req)) return res.status(403).json({ received: false });
    const payload = req.body as Record<string, unknown>;
    const messageHandle = typeof payload.message_handle === "string" ? payload.message_handle : undefined;
    if (!messageHandle) return res.sendStatus(204);
    const providerStatus = typeof payload.status === "string" ? payload.status : "";
    const errorMessage = typeof payload.error_message === "string" ? payload.error_message : "";
    const status = normalizeSendblueStatus(providerStatus);
    applyDeliveryStatus(db, messageHandle, status, errorMessage || providerStatus || "Sendblue delivery failed");
    if (status === "failed" && LOST_REPLY_TARGET.test(errorMessage)) void resendUnthreaded(db, messageHandle);
    return res.sendStatus(204);
  });
  /*
   * Both line events turn what would otherwise be a silent outage into a message
   * on the Settings card: a blocked line fails every send, and a reassigned one
   * leaves the stored `from_number` pointing at a line this account no longer
   * holds. Sendblue does not document either payload, so every field is read
   * defensively and the notice degrades to a bare statement of the event.
   */
  app.post(SENDBLUE_LINE_BLOCKED_PATH, (req, res) => {
    const config = getSendblueSecret(db);
    if (!config) return res.sendStatus(204);
    if (!verifySendblueWebhook(config, req)) return res.status(403).json({ received: false });
    const payload = req.body as Record<string, unknown>;
    const line = readString(payload, ["from_number", "number", "line", "sendblue_number"]);
    const reason = readString(payload, ["message", "reason", "error_message", "status"]);
    recordSendblueNotice(
      db,
      `Sendblue reported ${line ? `line ${line}` : "a line on this account"} as blocked`
      + `${reason ? `: ${reason}` : "."} Messages will fail until it is restored.`,
    );
    return res.json({ received: true });
  });
  app.post(SENDBLUE_LINE_ASSIGNED_PATH, (req, res) => {
    const config = getSendblueSecret(db);
    if (!config) return res.sendStatus(204);
    if (!verifySendblueWebhook(config, req)) return res.status(403).json({ received: false });
    const payload = req.body as Record<string, unknown>;
    const line = readString(payload, ["from_number", "number", "line", "sendblue_number"]);
    // A reassignment to the line already in use is the normal case on a shared
    // number and needs no attention.
    if (line && line === config.fromPhone) return res.json({ received: true });
    recordSendblueNotice(
      db,
      `Sendblue assigned ${line ? `line ${line}` : "a different line"} to this account,`
      + ` replacing ${config.fromPhone || "the stored number"}.`
      + " Reconnect Sendblue in Settings to send from it.",
    );
    return res.json({ received: true });
  });
}

function readString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
