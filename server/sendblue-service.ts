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
  if (!response.ok) throw new Error(await readError(response, "Sendblue request failed"));
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
 * How long to wait before sending the indicator a second time. Sendblue delivers
 * one over the conversation's established route mapping, and after an idle gap
 * that mapping is cold: the indicator is dropped and still reported as `SENT`,
 * which is why the account-side setting alone leaves the first message of a
 * conversation with no bubble. The inbound message that started this turn is what
 * warms the route, so a second attempt a beat later is the one that lands.
 */
const TYPING_INDICATOR_REPEAT_MS = 2_000;

export type TypingIndicator = {
  /** A reply is on its way, and the message itself takes the bubble down. */
  release: () => void;
  /** No reply is coming, so the bubble is taken down explicitly. */
  cancel: () => void;
};

const NO_TYPING_INDICATOR: TypingIndicator = { release: () => {}, cancel: () => {} };

/**
 * Raises the "…" bubble for the length of an agent turn. Nothing here is allowed
 * to fail the turn or be waited on: the indicator is decoration, and a dropped
 * one is reported as sent anyway, so there is no outcome worth acting on.
 */
export function startSendblueTypingIndicator(
  db: Db,
  to: string,
  repeatMs = TYPING_INDICATOR_REPEAT_MS,
): TypingIndicator {
  const config = getSendblueSecret(db);
  if (!config) return NO_TYPING_INDICATOR;
  const post = (state: "start" | "stop") => {
    void sendblueRequest(config, "/api/send-typing-indicator", {
      method: "POST",
      body: {
        number: to,
        from_number: config.fromPhone,
        state,
        ...(state === "start" ? { max_duration_ms: TYPING_INDICATOR_MS } : {}),
      },
    }).catch(() => {});
  };
  post("start");
  const repeat = setTimeout(() => post("start"), repeatMs);
  repeat.unref();
  return {
    // Clearing the repeat is what keeps a fast turn from raising a bubble the
    // reply has already made a lie of.
    release: () => clearTimeout(repeat),
    cancel: () => {
      clearTimeout(repeat);
      post("stop");
    },
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
