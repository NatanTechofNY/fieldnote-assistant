import { USER_ID } from "./db.ts";
import { groupAddress } from "./group-thread.ts";
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

/** A markdown numbered item: two or more in a row are a list, one is a sentence ("3. That was close"). */
const NUMBERED_LINE = /^[ \t]*\d{1,2}[.)][ \t]+\S/;

/** Characters a pasted link can pick up from the markdown around it, and are not part of the address. */
const LINK_TAIL = /[*_>.,;:!?]+$/;

function flatten(text: string): string {
  // A link is carried through untouched: its `*` and `_` are part of the address.
  const links: string[] = [];
  const keepLink = (url: string) => `\uE000${links.push(url) - 1}\uE000`;
  // Every quantifier below is bounded: these run on the one worker that also sends reminders,
  // and an unbounded one turns a long reply of the wrong shape into seconds of CPU.
  const flattened = text
    .replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, "$1")
    .replace(/`([^`\n]{1,500})`/g, "$1")
    .replace(/!\[([^\]\n]{0,300})\]\((https?:\/\/[^)\s]{1,2000})(?:\s[^)]{0,300})?\)/g, (_match, alt: string, url: string) => (alt.trim() ? `${alt.trim()} ${keepLink(url)}` : keepLink(url)))
    .replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]{1,2000})(?:\s[^)]{0,300})?\)/g, (_match, label: string, url: string) => (label.trim() === url ? keepLink(url) : `${label.trim()} ${keepLink(url)}`))
    .replace(/<(https?:\/\/[^\s>]{1,2000})>/g, "$1")
    // Emphasis wrapped straight round an address: "*https://x.com*" is the address.
    .replace(/(?<![\w*_])([*_]{1,3})(https?:\/\/\S{1,2000}?)\1(?=[\s.,;:!?)]|$)/g, "$2")
    .replace(/https?:\/\/[^\s)]{1,2000}/g, match => {
      const tail = LINK_TAIL.exec(match)?.[0] ?? "";
      return keepLink(tail ? match.slice(0, -tail.length) : match) + tail;
    });
  const lines = flattened.split("\n");
  const bare = lines
    .map((line, index) => {
      let out = line.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "").replace(/^[ \t]{0,3}>[ \t]+(?=\S)/, "");
      if (/^[ \t]*[-*][ \t]+\S/.test(out)) out = out.replace(/^[ \t]*[-*][ \t]+/, "");
      else if (NUMBERED_LINE.test(line) && (NUMBERED_LINE.test(lines[index - 1] ?? "") || NUMBERED_LINE.test(lines[index + 1] ?? ""))) {
        out = out.replace(/^[ \t]*\d{1,2}[.)][ \t]+/, "");
      }
      return out.trimEnd();
    })
    .join("\n");
  return bare
    .replace(/(?<![\w*])\*\*(?=\S)([^\n]{0,500}?\S)\*\*(?![\w*])/g, "$1")
    // `__init__.py` is code, not bold: only a phrase with a space in it is emphasis.
    .replace(/(?<![\w/.])__(?=[^\s_][^\n_]{0,500}?\s)([^\n_]{1,500}?[^\s_])__(?![\w.(])/g, "$1")
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]{0,500}?[^\s*])\*(?![\w*])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => links[Number(index)])
    .trim();
}

/**
 * A text message has no markdown: Messages shows the asterisks and hyphens as
 * typed. The model reaches for bullets and bold anyway, so every outgoing text
 * is flattened here rather than trusted to the prompt. Line breaks stay;
 * a lone `*` ("5*"), `2**3`, `__init__.py`, a quoted `>3`, a single "3. Sentence"
 * line, and underscores inside words or links are left alone.
 *
 * Idempotent: the reply is flattened before it is archived and again as it is
 * sent, and the two must agree, so nested markup is flattened until it settles.
 */
export function plainText(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replaceAll("\uE000", "");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = flatten(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function activeSmsProvider(db: Db): SmsProvider {
  return getNotificationPreferences(db).smsProvider;
}

export type InboundSender = {
  from: string;
  /** Set when the message arrived in a group chat rather than a 1:1 conversation. */
  groupId?: string;
  /** Every number in the conversation as the provider reports it, the recipient included when present. */
  participants: string[];
  /**
   * Whether the recipient has written in this group before. Being listed as a
   * participant is not consent — anyone who knows two numbers can open an
   * iMessage group with both — so the open-to-everyone setting waits for the
   * owner to speak first.
   */
  ownerHasSpoken?: boolean;
};

/**
 * Who the assistant answers. The recipient is always heard. Anyone else is heard
 * only inside a group chat the recipient is also in — a trusted contact as soon
 * as the owner is present, anyone else only once the owner has opened groups to
 * every participant and has themselves written in this one — so nobody can run
 * the assistant in a conversation the owner cannot see or did not start using.
 * With no recipient configured a 1:1 message is still accepted, as documented,
 * but a group message is refused because the owner's presence cannot be checked.
 */
export function isInboundSenderAllowed(
  preferences: Pick<NotificationPreferences, "recipientPhone" | "trustedContacts" | "groupAllowAll">,
  sender: InboundSender,
): boolean {
  const owner = preferences.recipientPhone;
  if (!sender.groupId) return !owner || owner === sender.from;
  if (!owner || !sender.participants.includes(owner)) return false;
  if (sender.from === owner) return true;
  if (preferences.trustedContacts.some(contact => contact.phone === sender.from)) return true;
  return preferences.groupAllowAll && sender.ownerHasSpoken === true;
}

/**
 * Whether the recipient has ever written in a group thread: the signal that the
 * owner is using this group with the assistant, read off the archived messages
 * rather than off the provider's participant list.
 */
export function ownerHasSpokenInGroup(db: Db, groupId: string, owner: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 found FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND t.channel='sms' AND t.address=? AND m.role='user'
      AND json_extract(m.metadata_json,'$.speaker')=? LIMIT 1
  `).get(USER_ID, groupAddress(groupId), owner));
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
  // A body that is nothing but markup ("**") would flatten to nothing; send it as written rather than an empty text.
  return senders[provider](db, to, plainText(body) || body, options);
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
