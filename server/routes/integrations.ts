import { z } from "zod";
import { validateAtlassianConfig } from "../atlassian-service.ts";
import { USER_ID } from "../db.ts";
import { completeExternalEvent, listExternalEvents, pollGranola } from "../event-ingestion.ts";
import { failure, success } from "../http.ts";
import { disconnectAtlassian, disconnectGranola, disconnectSendblue, disconnectTwilio, getAtlassianConfig, getGranolaConfig, getNotificationPreferences, getSendbluePublicConfig, getSendblueSecret, getTaskPreferences, getTwilioPublicConfig, getTwilioSecret, saveAtlassianConfig, saveGranolaConfig, saveNotificationPreferences, saveSendblueConfig, saveTaskPreferences, saveTwilioConfig, setSmsProvider } from "../integrations.ts";
import { isSmsProviderConnected } from "../messaging.ts";
import { atlassianConfigInput, notificationInput, sendblueConfigInput, smsProviderInput, taskPreferencesInput, twilioConfigInput } from "../schemas.ts";
import { configureSendblueWebhooks, enableSendblueAcknowledgements, newSendblueWebhookSecret, SENDBLUE_INBOUND_PATH, SENDBLUE_STATUS_PATH, sendSendblueSms, validateSendblueConfig } from "../sendblue-service.ts";
import { executeAgentTool } from "../tool-executor.ts";
import { configureTwilioWebhook, sendTwilioSms, validateTwilioConfig } from "../twilio-service.ts";
import { type ExternalEventRow } from "../types.ts";
import type { RouteContext } from "./context.ts";

const TEST_MESSAGE = "Fieldnote SMS is connected. Your reminders are ready.";

export function registerIntegrationRoutes({ app, db, search }: RouteContext): void {
  app.get("/api/integrations", (_req, res) => success(res, {
    secretStorageReady: Boolean(process.env.SETTINGS_ENCRYPTION_KEY),
    twilio: getTwilioPublicConfig(db),
    sendblue: getSendbluePublicConfig(db),
    granola: getGranolaConfig(db),
    atlassian: getAtlassianConfig(db),
    notifications: getNotificationPreferences(db),
    tasks: getTaskPreferences(db),
    webhookPaths: {
      sms: "/api/webhooks/twilio/sms",
      status: "/api/webhooks/twilio/status",
      sendblueInbound: SENDBLUE_INBOUND_PATH,
      sendblueStatus: SENDBLUE_STATUS_PATH,
    },
  }));
  app.post("/api/integrations/twilio/connect", async (req, res) => {
    const body = twilioConfigInput.parse(req.body);
    if (!process.env.SETTINGS_ENCRYPTION_KEY) {
      return failure(res, 503, "Add SETTINGS_ENCRYPTION_KEY to .env and restart the server before connecting Twilio");
    }
    const authToken = body.authToken ?? getTwilioSecret(db)?.authToken;
    if (!authToken) return failure(res, 400, "An auth token is required to connect Twilio");
    const config = {
      accountSid: body.accountSid,
      authToken,
      fromPhone: body.fromPhone,
      webhookBaseUrl: body.webhookBaseUrl,
    };
    const numbers = await validateTwilioConfig(config);
    if (!numbers.some(number => number.phoneNumber === body.fromPhone)) {
      return failure(res, 400, "The selected phone number does not belong to this Twilio account");
    }
    if (body.configureWebhook) await configureTwilioWebhook(config);
    saveTwilioConfig(db, config);
    return success(res, { config: getTwilioPublicConfig(db), numbers });
  });
  app.delete("/api/integrations/twilio", (_req, res) => {
    disconnectTwilio(db);
    return success(res, { disconnected: true });
  });
  /*
   * A test always goes through the provider whose card was clicked rather than
   * the one currently selected for delivery, so a provider can be proven working
   * before the toggle is moved onto it.
   */
  app.post("/api/integrations/twilio/test", async (_req, res) => {
    const preferences = getNotificationPreferences(db);
    if (!preferences.recipientPhone) return failure(res, 400, "Configure a recipient phone number first");
    return success(res, await sendTwilioSms(db, preferences.recipientPhone, TEST_MESSAGE));
  });
  app.post("/api/integrations/sendblue/connect", async (req, res) => {
    const body = sendblueConfigInput.parse(req.body);
    if (!process.env.SETTINGS_ENCRYPTION_KEY) {
      return failure(res, 503, "Add SETTINGS_ENCRYPTION_KEY to .env and restart the server before connecting Sendblue");
    }
    const stored = getSendblueSecret(db);
    const apiSecret = body.apiSecret ?? stored?.apiSecret;
    if (!apiSecret) return failure(res, 400, "An API secret is required to connect Sendblue");
    const config = {
      apiKeyId: body.apiKeyId,
      apiSecret,
      fromPhone: body.fromPhone,
      webhookBaseUrl: body.webhookBaseUrl,
      // Reusing the existing secret keeps webhooks already registered with
      // Sendblue verifiable when the connection is edited rather than replaced.
      webhookSecret: stored?.webhookSecret ?? newSendblueWebhookSecret(),
    };
    /*
     * Sendblue reports its own rejections in prose worth showing the user, and
     * the shared error handler would collapse them into a generic 500.
     */
    try {
      const lines = await validateSendblueConfig(config);
      if (lines.length && !lines.some(line => line.phoneNumber === body.fromPhone)) {
        return failure(res, 400, "The selected phone number is not a line on this Sendblue account");
      }
      if (body.configureWebhooks) await configureSendblueWebhooks(config);
      const acknowledgements = await enableSendblueAcknowledgements(config);
      saveSendblueConfig(db, config, {
        webhooksRegistered: body.configureWebhooks,
        autoTypingIndicator: acknowledgements.typingIndicator,
        autoMarkRead: acknowledgements.markRead,
      });
      return success(res, {
        config: getSendbluePublicConfig(db),
        lines,
        notes: acknowledgements.notes,
      });
    } catch (error) {
      return failure(res, 400, error instanceof Error ? error.message : "Sendblue rejected the credentials");
    }
  });
  app.delete("/api/integrations/sendblue", (_req, res) => {
    disconnectSendblue(db);
    return success(res, { disconnected: true });
  });
  app.post("/api/integrations/sendblue/test", async (_req, res) => {
    const preferences = getNotificationPreferences(db);
    if (!preferences.recipientPhone) return failure(res, 400, "Configure a recipient phone number first");
    try {
      return success(res, await sendSendblueSms(db, preferences.recipientPhone, TEST_MESSAGE));
    } catch (error) {
      return failure(res, 400, error instanceof Error ? error.message : "Sendblue could not send the test message");
    }
  });
  /*
   * Selecting a provider that is not connected would leave every reminder
   * failing at send time with nothing in the UI to explain it, so the switch is
   * refused until credentials exist.
   */
  app.put("/api/integrations/sms-provider", (req, res) => {
    const body = smsProviderInput.parse(req.body);
    if (!isSmsProviderConnected(db, body.provider)) {
      return failure(res, 400, `Connect ${body.provider === "sendblue" ? "Sendblue" : "Twilio"} before sending through it`);
    }
    return success(res, setSmsProvider(db, body.provider));
  });
  app.put("/api/integrations/notifications", (req, res) => {
    const body = notificationInput.parse(req.body);
    try {
      new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
    } catch {
      return failure(res, 400, "Timezone must be a valid IANA timezone");
    }
    return success(res, saveNotificationPreferences(db, body));
  });
  app.put("/api/integrations/tasks", (req, res) =>
    success(res, saveTaskPreferences(db, taskPreferencesInput.parse(req.body))));
  app.post("/api/integrations/granola/connect", async (req, res) => {
    const body = z.object({ apiKey: z.string().min(10).max(500) }).strict().parse(req.body);
    const response = await fetch("https://public-api.granola.ai/v1/notes?page_size=1", {
      headers: { authorization: `Bearer ${body.apiKey}`, accept: "application/json" },
    });
    if (!response.ok) return failure(res, 400, `Granola rejected the API key (${response.status})`);
    saveGranolaConfig(db, body);
    return success(res, { config: getGranolaConfig(db), poll: await pollGranola(db) });
  });
  app.post("/api/integrations/granola/poll", async (_req, res) => success(res, await pollGranola(db)));
  app.delete("/api/integrations/granola", (_req, res) => {
    disconnectGranola(db);
    return success(res, { disconnected: true });
  });
  app.post("/api/integrations/atlassian/connect", async (req, res) => {
    const body = atlassianConfigInput.parse(req.body);
    if (!process.env.SETTINGS_ENCRYPTION_KEY) {
      return failure(res, 503, "Add SETTINGS_ENCRYPTION_KEY to .env and restart the server before connecting Atlassian");
    }
    // Jira and Confluence are licensed separately, so one working product is
    // enough to connect and the flags record which tools will actually answer.
    // The rejection message names the likely cause, so it is reported verbatim
    // rather than collapsed into a generic 500 by the shared error handler.
    try {
      const meta = await validateAtlassianConfig(body);
      saveAtlassianConfig(db, body, meta);
    } catch (error) {
      return failure(res, 400, error instanceof Error ? error.message : "Atlassian rejected the credentials");
    }
    return success(res, { config: getAtlassianConfig(db) });
  });
  app.delete("/api/integrations/atlassian", (_req, res) => {
    disconnectAtlassian(db);
    return success(res, { disconnected: true });
  });
  app.get("/api/integrations/events", (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    return success(res, listExternalEvents(db, limit).map(event => ({
      id: event.id,
      source: event.source,
      externalId: event.external_id,
      eventType: event.event_type,
      payload: JSON.parse(event.payload_json),
      status: event.status,
      attempts: event.attempts,
      lastError: event.last_error,
      createdAt: event.created_at,
    })));
  });
  app.post("/api/integrations/events/:id/review", async (req, res) => {
    const body = z.object({ action: z.enum(["create_memory", "ignore"]) }).strict().parse(req.body);
    const event = db.prepare(`
      SELECT * FROM external_events WHERE id=? AND user_id=?
    `).get(req.params.id, USER_ID) as ExternalEventRow | undefined;
    if (!event) return failure(res, 404, "Event not found");
    if (body.action === "ignore") {
      completeExternalEvent(db, event.id, "ignored");
      return success(res, { ignored: true });
    }
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const title = (typeof payload.title === "string" ? payload.title : "Imported meeting").slice(0, 300);
    const contentValue = payload.summary ?? payload.overview ?? payload.notes ?? payload;
    const content = typeof contentValue === "string" ? contentValue : JSON.stringify(contentValue);
    const memory = await executeAgentTool(db, search, "create_memory", {
      kind: "note",
      title,
      content,
      tags: ["granola", "meeting"],
      mood_label: null,
      mood_score: null,
      category_id: null,
    });
    completeExternalEvent(db, event.id, "processed");
    return success(res, { memory });
  });
}
