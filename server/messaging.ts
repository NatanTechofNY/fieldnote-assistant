import {
  getNotificationPreferences,
  getSendblueSecret,
  getTwilioSecret,
  type NotificationPreferences,
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
export type SendOptions = {
  replyTo?: string;
  mediaUrl?: string;
  sendStyle?: SendStyle;
  /**
   * The iMessage group chat the message belongs in. When set, `to` is the
   * group's thread address rather than a phone number, and the message is
   * carried by Sendblue whatever provider is selected, because only iMessage
   * has group threads.
   */
  groupId?: string;
};

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

export type InboundSender = {
  from: string;
  /** Set when the message arrived in a group chat rather than a 1:1 conversation. */
  groupId?: string;
  /** Every number in the conversation as the provider reports it, the recipient included when present. */
  participants: string[];
};

/**
 * Who the assistant answers. The recipient is always heard. Anyone else is heard
 * only inside a group chat the recipient is also in — either because they are a
 * trusted contact or because the owner opened groups to every participant — so
 * nobody can run the assistant in a conversation the owner cannot see. With no
 * recipient configured a 1:1 message is still accepted, as documented, but a
 * group message is refused because the owner's presence cannot be checked.
 */
export function isInboundSenderAllowed(
  preferences: Pick<NotificationPreferences, "recipientPhone" | "trustedContacts" | "groupAllowAll">,
  sender: InboundSender,
): boolean {
  const owner = preferences.recipientPhone;
  if (!sender.groupId) return !owner || owner === sender.from;
  if (!owner || !sender.participants.includes(owner)) return false;
  if (sender.from === owner) return true;
  return preferences.groupAllowAll || preferences.trustedContacts.some(contact => contact.phone === sender.from);
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
  const provider = options.groupId ? "sendblue" : activeSmsProvider(db);
  return senders[provider](db, to, body, options);
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
