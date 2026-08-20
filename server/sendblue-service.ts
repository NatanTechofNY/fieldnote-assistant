import { randomBytes, timingSafeEqual } from "node:crypto";
import { getSendblueSecret, type SendblueSecretConfig } from "./integrations.ts";
import type { Db } from "./types.ts";

/** Sendblue serves the same API from `.co` and `.com`; the docs lead with `.co`. */
const API_BASE_URL = process.env.SENDBLUE_API_BASE_URL || "https://api.sendblue.co";

export const SENDBLUE_INBOUND_PATH = "/api/webhooks/sendblue/inbound";
export const SENDBLUE_STATUS_PATH = "/api/webhooks/sendblue/status";
export const SENDBLUE_LINE_BLOCKED_PATH = "/api/webhooks/sendblue/line-blocked";
export const SENDBLUE_LINE_ASSIGNED_PATH = "/api/webhooks/sendblue/line-assigned";

/**
 * The account-wide topics worth a route. `outbound` is left alone because the
 * per-message `status_callback` already reports every message this app sends,
 * and the remaining topics (`typing_indicator`, `call_log`, `contact_created`)
 * describe things this app has no model for.
 */
const WEBHOOK_TOPICS = [
  { type: "receive", path: SENDBLUE_INBOUND_PATH },
  { type: "line_blocked", path: SENDBLUE_LINE_BLOCKED_PATH },
  { type: "line_assigned", path: SENDBLUE_LINE_ASSIGNED_PATH },
] as const;

/** Every route this app registers, and nothing a human added by hand. */
const OWNED_PATH_PREFIX = "/api/webhooks/sendblue/";

/**
 * Sendblue caps a message at 18,996 characters, but a text that long is a
 * failure of composition rather than a message worth delivering, so the same
 * 1,500 character ceiling as Twilio applies.
 */
const MAX_BODY_LENGTH = 1500;

export type SendblueLine = {
  phoneNumber: string;
  label: string | null;
};

/**
 * The headers Sendblue may carry a webhook secret on. It documents that a
 * configured secret is "included in the request headers" without naming the
 * header, so every plausible spelling is accepted and the query token below is
 * what makes verification reliable.
 */
const SECRET_HEADERS = [
  "sb-webhook-secret",
  "sb-signing-secret",
  "x-sendblue-secret",
  "sendblue-secret",
  "x-webhook-secret",
];

function headers(config: SendblueSecretConfig): Record<string, string> {
  return {
    "sb-api-key-id": config.apiKeyId,
    "sb-api-secret-key": config.apiSecret,
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${fallback} (${response.status})`;
  try {
    const parsed = JSON.parse(text) as { message?: string; error_message?: string; status?: string };
    const message = parsed.message || parsed.error_message;
    if (message) return `Sendblue rejected the request (${response.status}): ${message}`;
  } catch {
    // A non-JSON body is still worth surfacing, trimmed to something readable.
  }
  return `${fallback} (${response.status}): ${text.slice(0, 300)}`;
}

/** Carries the HTTP status, which is how a refusal worth retrying is recognised. */
class SendblueRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SendblueRequestError";
    this.status = status;
  }
}

async function sendblueRequest(
  config: SendblueSecretConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: init.method,
    headers: headers(config),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    throw new SendblueRequestError(await readError(response, "Sendblue request failed"), response.status);
  }
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : {};
}

export function newSendblueWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Confirms the credentials work and reports the lines they can send from, so the
 * connect route can reject a `from_number` that belongs to another account
 * before anything is stored.
 */
export async function validateSendblueConfig(config: SendblueSecretConfig): Promise<SendblueLine[]> {
  const payload = await sendblueRequest(config, "/api/lines") as {
    lines?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>>;
  };
  const lines = payload.lines || payload.data || [];
  return lines.flatMap(line => {
    const phoneNumber = line.number || line.phone_number || line.phoneNumber;
    if (typeof phoneNumber !== "string") return [];
    const label = line.label || line.name || line.friendly_name;
    return [{ phoneNumber, label: typeof label === "string" ? label : null }];
  });
}

function ownedUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value
    : typeof value === "object" && value !== null && typeof (value as { url?: unknown }).url === "string"
      ? (value as { url: string }).url
      : null;
  if (!url) return null;
  try {
    return new URL(url).pathname.startsWith(OWNED_PATH_PREFIX) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The URLs this app registered previously, per topic. A failed read is reported
 * as nothing registered rather than as an error, because losing the ability to
 * tidy up is not a reason to refuse to connect.
 */
async function ourRegisteredWebhooks(config: SendblueSecretConfig): Promise<Record<string, string[]>> {
  let payload: { webhooks?: Record<string, unknown> };
  try {
    payload = await sendblueRequest(config, "/api/account/webhooks") as { webhooks?: Record<string, unknown> };
  } catch {
    return {};
  }
  const registered: Record<string, string[]> = {};
  for (const [type, entries] of Object.entries(payload.webhooks || {})) {
    // The response mixes `globalSecret` in with the per-topic arrays.
    if (!Array.isArray(entries)) continue;
    const ours = entries.map(ownedUrl).filter((url): url is string => Boolean(url));
    if (ours.length) registered[type] = ours;
  }
  return registered;
}

/**
 * Webhooks are account-wide on Sendblue, so this replaces the destinations for
 * every line rather than just this one. Each URL carries the minted secret as a
 * query token because that is the only part of the request Sendblue is
 * documented to reproduce verbatim.
 *
 * Registration appends rather than replaces, so our previous URLs are deleted
 * first. Without that, reconnecting behind a new tunnel hostname would leave the
 * dead one registered and Sendblue would keep retrying against it forever. Only
 * URLs pointing at this app's own routes are touched.
 */
export async function configureSendblueWebhooks(config: SendblueSecretConfig): Promise<void> {
  if (!config.webhookBaseUrl) throw new Error("A public webhook base URL is required");
  if (!config.webhookSecret) throw new Error("A webhook secret is required");
  const base = config.webhookBaseUrl.replace(/\/$/, "");
  const registered = await ourRegisteredWebhooks(config);
  for (const topic of WEBHOOK_TOPICS) {
    const stale = registered[topic.type];
    if (stale?.length) {
      await sendblueRequest(config, "/api/account/webhooks", {
        method: "DELETE",
        body: { webhooks: stale, type: topic.type },
      });
    }
    const url = `${base}${topic.path}?token=${encodeURIComponent(config.webhookSecret)}`;
    await sendblueRequest(config, "/api/account/webhooks", {
      method: "POST",
      body: { webhooks: [{ url, secret: config.webhookSecret }], type: topic.type },
    });
  }
}

export type SendblueAcknowledgements = {
  typingIndicator: boolean;
  markRead: boolean;
  /** Sendblue's own explanation for anything that stayed off, safe to show. */
  notes: string[];
};

/**
 * Asks Sendblue to send the "…" bubble and the read receipt itself on every
 * inbound iMessage, which acknowledges the messages this app never answers —
 * a `STOP` keyword, or a text from a number that is not the configured
 * recipient — as well as the ones it does. An answered message gets a second,
 * longer-lived indicator from `startSendblueTypingIndicator`, because the
 * account-side one lasts 60 seconds and a slow agent turn outlasts it.
 *
 * Neither is required to deliver anything, and read receipts have to be enabled
 * by Sendblue for some accounts, so a refusal is recorded and reported rather
 * than allowed to fail the connection.
 */
export async function enableSendblueAcknowledgements(
  config: SendblueSecretConfig,
): Promise<SendblueAcknowledgements> {
  const attempt = async (path: string, body: Record<string, boolean>, label: string) => {
    try {
      await sendblueRequest(config, path, { method: "POST", body });
      return { enabled: true, note: null };
    } catch (error) {
      return { enabled: false, note: `${label}: ${error instanceof Error ? error.message : "request failed"}` };
    }
  };
  const typing = await attempt(
    "/accounts/settings/auto-typing-indicator",
    { auto_typing_indicator: true },
    "Typing indicators stayed off",
  );
  const markRead = await attempt(
    "/accounts/settings/auto-mark-read",
    { auto_mark_read: true },
    "Read receipts stayed off",
  );
  return {
    typingIndicator: typing.enabled,
    markRead: markRead.enabled,
    notes: [typing.note, markRead.note].filter((note): note is string => Boolean(note)),
  };
}

/**
 * How long the "…" bubble stays up on its own. Long enough to cover a slow agent
 * turn, and short enough that a crash mid-turn cannot leave a bubble on someone's
 * phone for the five minutes the endpoint allows.
 */
const TYPING_INDICATOR_MS = 120_000;

/**
 * What this endpoint answers with when it took the request. The reference
 * documents `SENT` and the worked example answers `QUEUED`, and either one means
 * the same thing here, so both are read as acceptance and anything else is
 * reported.
 */
const TYPING_INDICATOR_ACCEPTED = new Set(["QUEUED", "SENT"]);

/** Takes the bubble down: the reply has landed, or none is coming. */
export type StopTypingIndicator = () => void;

/**
 * Raises the "…" bubble for the length of an agent turn, and asks exactly once.
 *
 * Asking again later was tried and measured as useless: on a thread idle for
 * half an hour, a second ask eight seconds into the turn was accepted and still
 * delivered nothing, because a cold conversation route does not come back until
 * traffic crosses it and the reply is the first thing to do that. See the
 * [docs](../docs/SMS_AND_EVENTS.md#the-first-message-after-an-idle-gap-gets-no-bubble).
 *
 * Nothing here is allowed to fail the turn or be waited on, because the bubble is
 * decoration; a refusal only earns a line in the log, and the commonest one is a
 * recipient who is on SMS rather than iMessage.
 */
export function startSendblueTypingIndicator(db: Db, to: string): StopTypingIndicator {
  const config = getSendblueSecret(db);
  if (!config) return () => {};
  const post = async (state: "start" | "stop", legacy = false): Promise<void> => {
    try {
      const payload = await sendblueRequest(config, "/api/send-typing-indicator", {
        method: "POST",
        body: {
          number: to,
          from_number: config.fromPhone,
          // A line on pre-typing-v2 firmware refuses these two, so the retry
          // below drops back to the spelling every firmware accepts.
          ...(legacy ? {} : { state, ...(state === "start" ? { max_duration_ms: TYPING_INDICATOR_MS } : {}) }),
        },
      });
      /*
       * A refusal arrives as HTTP 200 with the reason in the body, the same shape
       * `sendSendblueSms` has to inspect. Reading it is the only way to tell "the
       * bubble is up" from "Sendblue would not show it", so anything that is not
       * an acceptance is reported and saying nothing means it was accepted.
       */
      const result = payload as { status?: string; error_message?: string | null };
      if (TYPING_INDICATOR_ACCEPTED.has((result.status || "").toUpperCase())) return;
      console.warn(
        `Sendblue did not accept a typing indicator (${state}):`,
        result.error_message || JSON.stringify(payload).slice(0, 200),
      );
    } catch (error) {
      /*
       * A line whose worker firmware predates typing-v2 refuses `state` and
       * `max_duration_ms` with a 503 and names the firmware. A bare `start` is
       * documented to work on every firmware, so the bubble is still worth asking
       * for once — it lasts Sendblue's default 60 seconds rather than the 120 this
       * would have chosen. There is no legacy spelling of `stop`, so that one is
       * given up on instead, and its bubble expires on its own.
       */
      const outdated = error instanceof SendblueRequestError && error.status === 503;
      if (outdated && state === "start" && !legacy) return post("start", true);
      console.warn(
        `Sendblue could not be asked for a typing indicator (${state}):`,
        error instanceof Error ? error.message : error,
      );
    }
  };
  void post("start");
  let stopped = false;
  return () => {
    // Taking the bubble down twice is a documented no-op, but there is no reason
    // to spend the call.
    if (stopped) return;
    stopped = true;
    void post("stop");
  };
}

/**
 * Sendblue reports a per-message status rather than the queue acknowledgement
 * Twilio returns, and `DECLINED`/`ERROR` arrive with HTTP 200, so the outcome is
 * inspected here and turned into a throw. Otherwise a declined message would be
 * recorded as delivered and never retried.
 */
export async function sendSendblueSms(
  db: Db,
  to: string,
  body: string,
): Promise<{ sid: string; status: string }> {
  const config = getSendblueSecret(db);
  if (!config) throw new Error("Sendblue is not configured");
  const statusCallback = config.webhookBaseUrl && config.webhookSecret
    ? `${config.webhookBaseUrl.replace(/\/$/, "")}${SENDBLUE_STATUS_PATH}`
      + `?token=${encodeURIComponent(config.webhookSecret)}`
    : undefined;
  const payload = await sendblueRequest(config, "/api/send-message", {
    method: "POST",
    body: {
      number: to,
      from_number: config.fromPhone,
      content: body.slice(0, MAX_BODY_LENGTH),
      ...(statusCallback ? { status_callback: statusCallback } : {}),
    },
  }) as {
    message_handle?: string;
    status?: string;
    error_code?: number | string | null;
    error_message?: string | null;
  };
  const status = (payload.status || "QUEUED").toUpperCase();
  const failed = status === "ERROR" || status === "DECLINED"
    || Boolean(payload.error_code && payload.error_code !== 0 && payload.error_code !== "0");
  if (failed) {
    const code = payload.error_code ? ` (${payload.error_code})` : "";
    throw new Error(`Sendblue could not send the message${code}: ${payload.error_message || status}`);
  }
  if (!payload.message_handle) throw new Error("Sendblue accepted the message without a handle");
  return { sid: payload.message_handle, status: normalizeSendblueStatus(status) };
}

/**
 * Sendblue's eight statuses collapse onto the four `channel_messages` records,
 * with everything before dispatch treated as queued. `SENT` stays distinct from
 * `DELIVERED` because it is terminal for SMS but not for iMessage.
 */
export function normalizeSendblueStatus(status: string): "queued" | "sent" | "delivered" | "failed" {
  switch (status.toUpperCase()) {
    case "DELIVERED":
      return "delivered";
    case "SENT":
      return "sent";
    case "ERROR":
    case "DECLINED":
      return "failed";
    default:
      return "queued";
  }
}

function matches(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sendblue signs nothing, so a webhook is trusted only when it carries back the
 * secret this server generated, either as the `token` query parameter baked into
 * the registered URL or as a header.
 */
export function verifySendblueWebhook(
  config: SendblueSecretConfig,
  request: { query: Record<string, unknown>; get: (name: string) => string | undefined },
): boolean {
  if (
    process.env.SENDBLUE_SKIP_SIGNATURE_VALIDATION === "true"
    && process.env.NODE_ENV !== "production"
  ) {
    return true;
  }
  if (!config.webhookSecret) return false;
  const token = request.query.token;
  if (typeof token === "string" && matches(config.webhookSecret, token)) return true;
  const bearer = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (matches(config.webhookSecret, bearer)) return true;
  return SECRET_HEADERS.some(name => matches(config.webhookSecret as string, request.get(name)));
}
