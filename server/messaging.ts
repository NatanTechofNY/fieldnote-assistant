import {
  getNotificationPreferences,
  getSendblueSecret,
  getTwilioSecret,
  type SmsProvider,
} from "./integrations.ts";
import { sendSendblueSms } from "./sendblue-service.ts";
import { sendTwilioSms } from "./twilio-service.ts";
import type { Db } from "./types.ts";

/**
 * Every outbound text goes through one signature, whichever API carries it, so
 * reminders, digests, briefs, and agent replies stay unaware of the provider.
 */
export type SmsSender = (db: Db, to: string, body: string) => Promise<{ sid: string; status: string }>;

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
export async function sendSms(db: Db, to: string, body: string): Promise<{ sid: string; status: string }> {
  return senders[activeSmsProvider(db)](db, to, body);
}
