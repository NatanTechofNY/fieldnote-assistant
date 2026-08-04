import { now } from "../db.ts";
import { enqueueExternalEvent } from "../event-ingestion.ts";
import { getNotificationPreferences, getSendblueSecret, getTwilioSecret, recordSendblueNotice, setSmsOptOut } from "../integrations.ts";
import { normalizeSendblueStatus, SENDBLUE_INBOUND_PATH, SENDBLUE_LINE_ASSIGNED_PATH, SENDBLUE_LINE_BLOCKED_PATH, SENDBLUE_STATUS_PATH, verifySendblueWebhook } from "../sendblue-service.ts";
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
  db.prepare(`
    UPDATE reminders SET status='failed',last_error=?,updated_at=? WHERE provider_message_id=?
  `).run(error, now(), providerMessageId);
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
    const body = params.Body?.trim();
    if (!from || !messageSid || !body) return res.status(400).send("Missing SMS fields");
    const preferences = getNotificationPreferences(db);
    if (preferences.recipientPhone && preferences.recipientPhone !== from) {
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
    const from = typeof payload.from_number === "string" ? payload.from_number
      : typeof payload.number === "string" ? payload.number : undefined;
    const messageHandle = typeof payload.message_handle === "string" ? payload.message_handle : undefined;
    const body = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!from || !messageHandle || !body) return res.status(400).json({ received: false });
    const preferences = getNotificationPreferences(db);
    if (preferences.recipientPhone && preferences.recipientPhone !== from) {
      return res.status(403).json({ received: false });
    }
    if (STOP_WORDS.test(body)) setSmsOptOut(db, true);
    else if (START_WORDS.test(body)) setSmsOptOut(db, false);
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
    applyDeliveryStatus(
      db,
      messageHandle,
      normalizeSendblueStatus(providerStatus),
      errorMessage || providerStatus || "Sendblue delivery failed",
    );
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
