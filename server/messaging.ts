import {
  getNotificationPreferences,
  getSendblueSecret,
  getTwilioSecret,
  type SmsProvider,
} from "./integrations.ts";
import { sendSendblueSms, startSendblueTypingIndicator, type StopTypingIndicator } from "./sendblue-service.ts";
import { sendTwilioSms } from "./twilio-service.ts";
import type { Db } from "./types.ts";

/** The iMessage expressive effects Sendblue accepts on `send_style`. */
export const SEND_STYLES = [
  "celebration", "shooting_star", "fireworks", "lasers", "love", "confetti", "balloons",
  "spotlight", "echo", "invisible", "gentle", "loud", "slam",
] as const;
export type SendStyle = typeof SEND_STYLES[number];

/**
 * What a send can ask for beyond the text itself. Only iMessage has anywhere to
 * put a reply or play an effect, so a provider that cannot ignores those rather
 * than refusing. `mediaUrl` is a public image URL delivered as an attachment,
 * which both providers carry: Sendblue as iMessage media with RCS or MMS as the
 * fallback, Twilio as MMS.
 */
export type SendOptions = { replyTo?: string; mediaUrl?: string; sendStyle?: SendStyle };

/**
 * Every outbound text goes through one signature, whichever API carries it, so
 * reminders, digests, briefs, and agent replies stay unaware of the provider.
 *
 * `replyTo` comes back set only when the message was delivered threaded, which
 * is not every time it was requested — the archive records what landed.
 */
export type SmsSender = (
  db: Db,
  to: string,
  body: string,
  options?: SendOptions,
) => Promise<{ sid: string; status: string; replyTo?: string }>;

export function activeSmsProvider(db: Db): SmsProvider {
  return getNotificationPreferences(db).smsProvider;
}

export function isSmsProviderConnected(db: Db, provider: SmsProvider): boolean {
  return Boolean(provider === "sendblue" ? getSendblueSecret(db) : getTwilioSecret(db));
}

const senders: Record<SmsProvider, SmsSender> = {
  twilio: sendTwilioSms,
  sendblue: sendSendblueSms,
};

/**
 * The provider is read per send rather than captured at startup, so flipping the
 * toggle in Settings moves the next reminder without a restart. A provider that
 * was selected but never connected fails loudly here, which the scheduler treats
 * as a delivery failure and retries.
 */
export async function sendSms(
  db: Db,
  to: string,
  body: string,
  options: SendOptions = {},
): Promise<{ sid: string; status: string; replyTo?: string }> {
  return senders[activeSmsProvider(db)](db, to, body, options);
}

const typingIndicators: Record<SmsProvider, (db: Db, to: string) => StopTypingIndicator> = {
  // Twilio carries SMS, which has no bubble to raise.
  twilio: () => () => {},
  sendblue: startSendblueTypingIndicator,
};

/**
 * Shows the sender that their message landed and an answer is being written, for
 * the whole time the agent takes. Read on the active provider like `sendSms`, so
 * the acknowledgement and the reply always travel the same way. Call the returned
 * function once the reply is out.
 */
export function startTypingIndicator(db: Db, to: string): StopTypingIndicator {
  return typingIndicators[activeSmsProvider(db)](db, to);
}
