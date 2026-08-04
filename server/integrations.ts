import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db, IntegrationSettingRow, NotificationPreferencesRow } from "./types.ts";
import { now, USER_ID } from "./db.ts";

export type TwilioPublicConfig = {
  configured: boolean;
  status: IntegrationSettingRow["status"];
  accountSid?: string;
  fromPhone?: string;
  webhookBaseUrl?: string;
  lastError?: string;
};

export type TwilioSecretConfig = {
  accountSid: string;
  authToken: string;
  fromPhone: string;
  webhookBaseUrl?: string;
};

/** Which API actually carries outbound texts and receives inbound ones. */
export type SmsProvider = "twilio" | "sendblue";

export type SendbluePublicConfig = {
  configured: boolean;
  status: IntegrationSettingRow["status"];
  apiKeyId?: string;
  fromPhone?: string;
  webhookBaseUrl?: string;
  webhooksRegistered?: boolean;
  /** Sendblue acknowledges inbound iMessages itself once these are on. */
  autoTypingIndicator?: boolean;
  autoMarkRead?: boolean;
  lastError?: string;
};

export type SendblueConnectionMeta = {
  webhooksRegistered: boolean;
  autoTypingIndicator: boolean;
  autoMarkRead: boolean;
};

/**
 * Sendblue does not sign its webhooks, so `webhookSecret` is a value we mint and
 * hand back to it at registration time. It arrives on every inbound call, which
 * is what makes the public webhook routes safe to expose.
 */
export type SendblueSecretConfig = {
  apiKeyId: string;
  apiSecret: string;
  fromPhone: string;
  webhookBaseUrl?: string;
  webhookSecret?: string;
};

export type GranolaSecretConfig = { apiKey: string };

/**
 * One credential covers both products: Jira lives at `/rest/api/3` and
 * Confluence at `/wiki` on the same host behind the same Basic header. Product
 * access is licensed separately though, so the two `available` flags are
 * resolved at connect time rather than assumed.
 */
export type AtlassianSecretConfig = { siteUrl: string; email: string; apiToken: string };

export type AtlassianMeta = {
  accountId: string | null;
  displayName: string | null;
  jiraAvailable: boolean;
  confluenceAvailable: boolean;
};

export type AtlassianPublicConfig = AtlassianMeta & {
  configured: boolean;
  status: IntegrationSettingRow["status"];
  siteUrl: string | null;
  email: string | null;
  lastError?: string;
};

export type NotificationPreferences = {
  smsEnabled: boolean;
  smsProvider: SmsProvider;
  recipientPhone: string | null;
  timezone: string;
  dailyDigestEnabled: boolean;
  dailyDigestTime: string;
  /** Whether the daily digest also covers today's open todos, not just reminders. */
  digestIncludeTodos: boolean;
  /** Whether the daily digest also carries open todos left behind on earlier days. */
  digestIncludeOverdue: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  optedOutAt: string | null;
};

function encryptionKey(): Buffer {
  const value = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!value) throw new Error("SETTINGS_ENCRYPTION_KEY is required to store integration secrets");
  return createHash("sha256").update(value).digest();
}

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}

export function decryptSecret<T>(value: string): T {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Stored integration secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")) as T;
}

export function getTwilioSecret(db: Db): TwilioSecretConfig | null {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='twilio'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  if (!row?.encrypted_secret || row.status === "disconnected") return null;
  return decryptSecret<TwilioSecretConfig>(row.encrypted_secret);
}

export function getTwilioPublicConfig(db: Db): TwilioPublicConfig {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='twilio'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  if (!row) return { configured: false, status: "disconnected" };
  const config = JSON.parse(row.config_json) as Partial<TwilioSecretConfig>;
  return {
    configured: Boolean(row.encrypted_secret && row.status === "connected"),
    status: row.status,
    accountSid: config.accountSid,
    fromPhone: config.fromPhone,
    webhookBaseUrl: config.webhookBaseUrl,
    lastError: row.last_error ?? undefined,
  };
}

export function saveTwilioConfig(db: Db, config: TwilioSecretConfig): void {
  const timestamp = now();
  const publicConfig = {
    accountSid: config.accountSid,
    fromPhone: config.fromPhone,
    webhookBaseUrl: config.webhookBaseUrl,
  };
  db.prepare(`
    INSERT INTO integration_settings(
      user_id,provider,config_json,encrypted_secret,status,last_error,created_at,updated_at
    ) VALUES(?,'twilio',?,?,'connected',NULL,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET
      config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,
      status='connected',last_error=NULL,updated_at=excluded.updated_at
  `).run(USER_ID, JSON.stringify(publicConfig), encryptSecret(config), timestamp, timestamp);
}

export function disconnectTwilio(db: Db): void {
  db.prepare(`
    UPDATE integration_settings SET encrypted_secret=NULL,status='disconnected',
      last_error=NULL,updated_at=? WHERE user_id=? AND provider='twilio'
  `).run(now(), USER_ID);
}

export function getSendblueSecret(db: Db): SendblueSecretConfig | null {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='sendblue'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  if (!row?.encrypted_secret || row.status === "disconnected") return null;
  return decryptSecret<SendblueSecretConfig>(row.encrypted_secret);
}

export function getSendbluePublicConfig(db: Db): SendbluePublicConfig {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='sendblue'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  if (!row) return { configured: false, status: "disconnected" };
  const config = JSON.parse(row.config_json) as Partial<SendbluePublicConfig>;
  return {
    configured: Boolean(row.encrypted_secret && row.status === "connected"),
    status: row.status,
    apiKeyId: config.apiKeyId,
    fromPhone: config.fromPhone,
    webhookBaseUrl: config.webhookBaseUrl,
    webhooksRegistered: Boolean(config.webhooksRegistered),
    autoTypingIndicator: Boolean(config.autoTypingIndicator),
    autoMarkRead: Boolean(config.autoMarkRead),
    lastError: row.last_error ?? undefined,
  };
}

export function saveSendblueConfig(
  db: Db,
  config: SendblueSecretConfig,
  meta: SendblueConnectionMeta,
): void {
  const timestamp = now();
  const publicConfig = {
    apiKeyId: config.apiKeyId,
    fromPhone: config.fromPhone,
    webhookBaseUrl: config.webhookBaseUrl,
    ...meta,
  };
  db.prepare(`
    INSERT INTO integration_settings(
      user_id,provider,config_json,encrypted_secret,status,last_error,created_at,updated_at
    ) VALUES(?,'sendblue',?,?,'connected',NULL,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET
      config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,
      status='connected',last_error=NULL,updated_at=excluded.updated_at
  `).run(USER_ID, JSON.stringify(publicConfig), encryptSecret(config), timestamp, timestamp);
}

/**
 * Records something Sendblue reported about the line itself. It lands in
 * `last_error` so the Settings card can show it, and deliberately leaves
 * `status` alone: the credentials still work, and a blocked or reassigned line
 * is a problem to surface rather than a reason to treat the account as
 * disconnected. Reconnecting clears it.
 */
export function recordSendblueNotice(db: Db, notice: string): void {
  db.prepare(`
    UPDATE integration_settings SET last_error=?,updated_at=? WHERE user_id=? AND provider='sendblue'
  `).run(notice.slice(0, 1000), now(), USER_ID);
}

export function disconnectSendblue(db: Db): void {
  db.prepare(`
    UPDATE integration_settings SET encrypted_secret=NULL,status='disconnected',
      last_error=NULL,updated_at=? WHERE user_id=? AND provider='sendblue'
  `).run(now(), USER_ID);
}

export function saveGranolaConfig(db: Db, config: GranolaSecretConfig): void {
  const timestamp = now();
  db.prepare(`
    INSERT INTO integration_settings(
      user_id,provider,config_json,encrypted_secret,status,last_error,created_at,updated_at
    ) VALUES(?,'granola','{}',?,'connected',NULL,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,
      status='connected',last_error=NULL,updated_at=excluded.updated_at
  `).run(USER_ID, encryptSecret(config), timestamp, timestamp);
}

export function getGranolaConfig(db: Db): { configured: boolean; status: string; lastError?: string } {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='granola'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  return {
    configured: Boolean(row?.encrypted_secret && row.status === "connected"),
    status: row?.status || "disconnected",
    lastError: row?.last_error ?? undefined,
  };
}

export function getGranolaSecret(db: Db): GranolaSecretConfig | null {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='granola'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  return row?.encrypted_secret ? decryptSecret<GranolaSecretConfig>(row.encrypted_secret) : null;
}

export function disconnectGranola(db: Db): void {
  db.prepare(`
    UPDATE integration_settings SET encrypted_secret=NULL,status='disconnected',
      last_error=NULL,updated_at=? WHERE user_id=? AND provider='granola'
  `).run(now(), USER_ID);
}

export function saveAtlassianConfig(
  db: Db,
  config: AtlassianSecretConfig,
  meta: AtlassianMeta,
): void {
  const timestamp = now();
  const publicConfig = { siteUrl: config.siteUrl, email: config.email, ...meta };
  db.prepare(`
    INSERT INTO integration_settings(
      user_id,provider,config_json,encrypted_secret,status,last_error,created_at,updated_at
    ) VALUES(?,'atlassian',?,?,'connected',NULL,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET
      config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,
      status='connected',last_error=NULL,updated_at=excluded.updated_at
  `).run(USER_ID, JSON.stringify(publicConfig), encryptSecret(config), timestamp, timestamp);
}

export function getAtlassianConfig(db: Db): AtlassianPublicConfig {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='atlassian'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  const config = JSON.parse(row?.config_json || "{}") as Partial<AtlassianPublicConfig>;
  return {
    configured: Boolean(row?.encrypted_secret && row.status === "connected"),
    status: row?.status || "disconnected",
    siteUrl: config.siteUrl ?? null,
    email: config.email ?? null,
    accountId: config.accountId ?? null,
    displayName: config.displayName ?? null,
    jiraAvailable: Boolean(config.jiraAvailable),
    confluenceAvailable: Boolean(config.confluenceAvailable),
    lastError: row?.last_error ?? undefined,
  };
}

export function getAtlassianSecret(db: Db): AtlassianSecretConfig | null {
  const row = db.prepare(`
    SELECT * FROM integration_settings WHERE user_id=? AND provider='atlassian'
  `).get(USER_ID) as IntegrationSettingRow | undefined;
  if (!row?.encrypted_secret || row.status === "disconnected") return null;
  return decryptSecret<AtlassianSecretConfig>(row.encrypted_secret);
}

export function disconnectAtlassian(db: Db): void {
  db.prepare(`
    UPDATE integration_settings SET encrypted_secret=NULL,status='disconnected',
      last_error=NULL,updated_at=? WHERE user_id=? AND provider='atlassian'
  `).run(now(), USER_ID);
}

export type SearchPreferences = { neuralSearchEnabled: boolean };

export function getSearchPreferences(db: Db): SearchPreferences {
  const row = db.prepare(`
    SELECT neural_search_enabled FROM search_preferences WHERE user_id=?
  `).get(USER_ID) as { neural_search_enabled: number } | undefined;
  return { neuralSearchEnabled: Boolean(row?.neural_search_enabled) };
}

export function saveSearchPreferences(db: Db, preferences: SearchPreferences): SearchPreferences {
  const timestamp = now();
  db.prepare(`
    INSERT INTO search_preferences(user_id,neural_search_enabled,created_at,updated_at)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      neural_search_enabled=excluded.neural_search_enabled,updated_at=excluded.updated_at
  `).run(USER_ID, Number(preferences.neuralSearchEnabled), timestamp, timestamp);
  return getSearchPreferences(db);
}

export type TaskPreferences = { autoCompleteParent: boolean };

export function getTaskPreferences(db: Db): TaskPreferences {
  const row = db.prepare(`
    SELECT auto_complete_parent FROM task_preferences WHERE user_id=?
  `).get(USER_ID) as { auto_complete_parent: number } | undefined;
  return { autoCompleteParent: Boolean(row?.auto_complete_parent) };
}

export function saveTaskPreferences(db: Db, preferences: TaskPreferences): TaskPreferences {
  const timestamp = now();
  db.prepare(`
    INSERT INTO task_preferences(user_id,auto_complete_parent,created_at,updated_at)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      auto_complete_parent=excluded.auto_complete_parent,updated_at=excluded.updated_at
  `).run(USER_ID, Number(preferences.autoCompleteParent), timestamp, timestamp);
  return getTaskPreferences(db);
}

export function getNotificationPreferences(db: Db): NotificationPreferences {
  const row = db.prepare(`
    SELECT * FROM notification_preferences WHERE user_id=?
  `).get(USER_ID) as NotificationPreferencesRow;
  return {
    smsEnabled: Boolean(row.sms_enabled),
    smsProvider: row.sms_provider,
    recipientPhone: row.recipient_phone,
    timezone: row.timezone,
    dailyDigestEnabled: Boolean(row.daily_digest_enabled),
    dailyDigestTime: row.daily_digest_time,
    digestIncludeTodos: Boolean(row.digest_include_todos),
    digestIncludeOverdue: Boolean(row.digest_include_overdue),
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    optedOutAt: row.opted_out_at,
  };
}

/**
 * A full replacement of the editable schedule. The two digest coverage flags are
 * the fields a caller may leave out, and leaving one out turns it off rather
 * than preserving it, matching the `notificationInput` defaults so the REST
 * contract and this function cannot disagree about what an absent flag means.
 * `smsProvider` is deliberately not editable here: it is a connection choice
 * with its own endpoint, so saving a schedule can never silently move delivery
 * onto a provider that was never connected.
 */
export type NotificationPreferencesInput =
  Omit<
    NotificationPreferences,
    "optedOutAt" | "digestIncludeTodos" | "digestIncludeOverdue" | "smsProvider"
  >
  & Partial<Pick<NotificationPreferences, "digestIncludeTodos" | "digestIncludeOverdue">>;

export function saveNotificationPreferences(
  db: Db,
  preferences: NotificationPreferencesInput,
): NotificationPreferences {
  db.prepare(`
    UPDATE notification_preferences SET sms_enabled=?,recipient_phone=?,timezone=?,
      daily_digest_enabled=?,daily_digest_time=?,digest_include_todos=?,digest_include_overdue=?,
      quiet_hours_start=?,quiet_hours_end=?,
      opted_out_at=CASE WHEN ?=1 THEN NULL ELSE opted_out_at END,updated_at=?
    WHERE user_id=?
  `).run(
    Number(preferences.smsEnabled),
    preferences.recipientPhone,
    preferences.timezone,
    Number(preferences.dailyDigestEnabled),
    preferences.dailyDigestTime,
    Number(preferences.digestIncludeTodos ?? false),
    Number(preferences.digestIncludeOverdue ?? false),
    preferences.quietHoursStart,
    preferences.quietHoursEnd,
    Number(preferences.smsEnabled),
    now(),
    USER_ID,
  );
  return getNotificationPreferences(db);
}

export function setSmsProvider(db: Db, provider: SmsProvider): NotificationPreferences {
  db.prepare(`
    UPDATE notification_preferences SET sms_provider=?,updated_at=? WHERE user_id=?
  `).run(provider, now(), USER_ID);
  return getNotificationPreferences(db);
}

export function setSmsOptOut(db: Db, optedOut: boolean): void {
  db.prepare(`
    UPDATE notification_preferences SET sms_enabled=?,opted_out_at=?,updated_at=? WHERE user_id=?
  `).run(optedOut ? 0 : 1, optedOut ? now() : null, now(), USER_ID);
}
