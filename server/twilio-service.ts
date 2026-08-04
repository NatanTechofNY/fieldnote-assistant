import twilio from "twilio";
import type { Db } from "./types.ts";
import { getTwilioSecret, type TwilioSecretConfig } from "./integrations.ts";

export type TwilioNumber = {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  smsUrl: string | null;
};

const clientFor = (config: TwilioSecretConfig) => twilio(config.accountSid, config.authToken);

export async function validateTwilioConfig(config: TwilioSecretConfig): Promise<TwilioNumber[]> {
  const client = clientFor(config);
  await client.api.v2010.accounts(config.accountSid).fetch();
  const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });
  return numbers.map(number => ({
    sid: number.sid,
    phoneNumber: number.phoneNumber,
    friendlyName: number.friendlyName,
    smsUrl: number.smsUrl,
  }));
}

export function getTwilioErrorMessage(error: unknown): string | null {
  if (!(error instanceof twilio.RestException)) return null;
  const code = error.code === undefined || error.code === null ? "" : ` (${error.code})`;
  return `Twilio rejected the request${code}: ${error.message}`;
}

export async function configureTwilioWebhook(config: TwilioSecretConfig): Promise<void> {
  if (!config.webhookBaseUrl) throw new Error("A public webhook base URL is required");
  const client = clientFor(config);
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: config.fromPhone, limit: 1 });
  const number = numbers[0];
  if (!number) throw new Error("The selected Twilio number was not found");
  const base = config.webhookBaseUrl.replace(/\/$/, "");
  await client.incomingPhoneNumbers(number.sid).update({
    smsMethod: "POST",
    smsUrl: `${base}/api/webhooks/twilio/sms`,
  });
}

export async function sendTwilioSms(
  db: Db,
  to: string,
  body: string,
): Promise<{ sid: string; status: string }> {
  const config = getTwilioSecret(db);
  if (!config) throw new Error("Twilio is not configured");
  const statusCallback = config.webhookBaseUrl
    ? `${config.webhookBaseUrl.replace(/\/$/, "")}/api/webhooks/twilio/status`
    : undefined;
  const message = await clientFor(config).messages.create({
    to,
    from: config.fromPhone,
    body: body.slice(0, 1500),
    ...(statusCallback ? { statusCallback } : {}),
  });
  return { sid: message.sid, status: message.status };
}

export function validateTwilioSignature(
  config: TwilioSecretConfig,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "true" && process.env.NODE_ENV !== "production") {
    return true;
  }
  return Boolean(signature && twilio.validateRequest(config.authToken, signature, url, params));
}
