import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Archive, Check, Circle, Clock3, Database, History, ListChecks, LoaderCircle, MessageSquare, Newspaper, Pause, Phone, RefreshCw, Send, Sparkles, SquareKanban, SunMoon, TriangleAlert, Zap } from "lucide-react";
import { api } from "../../api";
import type {
  ExternalEvent, IntegrationState, SmsProvider,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { ErrorState, Field, Loading, ThemeToggle, Toast } from "../../components/ui";
import { type ThemePreference, useTheme } from "../../lib/theme";
import { AtlassianSettings, DigestBriefsSettings } from "./AtlassianSettings";
import { LifeAreasSettings } from "./LifeAreasSettings";
import { SettingsSection } from "./SettingsSection";
import { UnderHoodSettings } from "./UnderHoodSettings";
import { humanTime, timezoneLabel, timezoneNames } from "../../lib/timezone";

const themeStatus: Record<ThemePreference, string> = {
  system: "Following system",
  light: "Light",
  dark: "Dark",
};

const providerLabel: Record<SmsProvider, string> = { twilio: "Twilio", sendblue: "Sendblue" };

export function IntegrationsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} />;
  return <IntegrationsContent initialData={data}/>;
}

function IntegrationsContent({ initialData }: { initialData: IntegrationState }) {
  const queryClient = useQueryClient();
  const { data = initialData } = useQuery({
    queryKey: ["integrations"],
    queryFn: api.integrations,
    initialData,
  });
  const { data: events = [] } = useQuery({ queryKey: ["integration-events"], queryFn: api.integrationEvents });
  const { data: briefs = [] } = useQuery({ queryKey: ["digest-briefs"], queryFn: api.digestBriefs });
  const [accountSid, setAccountSid] = useState(data.twilio.accountSid || "");
  const [authToken, setAuthToken] = useState("");
  const [fromPhone, setFromPhone] = useState(data.twilio.fromPhone || "");
  const [webhookBaseUrl, setWebhookBaseUrl] = useState(data.twilio.webhookBaseUrl || "");
  const [providerTab, setProviderTab] = useState<SmsProvider>(data.notifications.smsProvider);
  const [sendblueKeyId, setSendblueKeyId] = useState(data.sendblue.apiKeyId || "");
  const [sendblueSecret, setSendblueSecret] = useState("");
  const [sendbluePhone, setSendbluePhone] = useState(data.sendblue.fromPhone || "");
  const [sendblueWebhookBaseUrl, setSendblueWebhookBaseUrl] = useState(data.sendblue.webhookBaseUrl || "");
  const [recipientPhone, setRecipientPhone] = useState(data.notifications.recipientPhone || "");
  const [timezone, setTimezone] = useState(data.notifications.timezone);
  const [digestEnabled, setDigestEnabled] = useState(data.notifications.dailyDigestEnabled);
  const [digestTime, setDigestTime] = useState(data.notifications.dailyDigestTime);
  const [digestTodos, setDigestTodos] = useState(data.notifications.digestIncludeTodos);
  const [digestOverdue, setDigestOverdue] = useState(data.notifications.digestIncludeOverdue);
  const [smsEnabled, setSmsEnabled] = useState(data.notifications.smsEnabled);
  const [quietStart, setQuietStart] = useState(data.notifications.quietHoursStart || "22:00");
  const [quietEnd, setQuietEnd] = useState(data.notifications.quietHoursEnd || "07:00");
  const [granolaKey, setGranolaKey] = useState("");
  const [toast, setToast] = useState("");
  const { preference } = useTheme();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    void queryClient.invalidateQueries({ queryKey: ["integration-events"] });
  };
  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 4000);
  };
  const twilioConnect = useMutation({
    mutationFn: () => api.connectTwilio({
      accountSid, fromPhone,
      authToken: authToken || undefined,
      webhookBaseUrl: webhookBaseUrl || undefined,
      configureWebhook: Boolean(webhookBaseUrl),
    }),
    onSuccess: () => {
      setAuthToken("");
      refresh();
      notify(webhookBaseUrl ? "Twilio saved and webhook configured" : "Twilio saved");
    },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const sendblueConnect = useMutation({
    mutationFn: () => api.connectSendblue({
      apiKeyId: sendblueKeyId,
      apiSecret: sendblueSecret || undefined,
      fromPhone: sendbluePhone,
      webhookBaseUrl: sendblueWebhookBaseUrl || undefined,
      configureWebhooks: Boolean(sendblueWebhookBaseUrl),
    }),
    onSuccess: (result) => {
      setSendblueSecret("");
      refresh();
      notify(result.notes[0]
        || (sendblueWebhookBaseUrl ? "Sendblue saved and webhooks registered" : "Sendblue saved"));
    },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const providerSwitch = useMutation({
    mutationFn: (provider: SmsProvider) => api.setSmsProvider(provider),
    onSuccess: (updated) => { refresh(); notify(`Messages now send through ${providerLabel[updated.smsProvider]}`); },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const preferences = useMutation({
    mutationFn: () => api.updateNotifications({
      smsEnabled,
      recipientPhone: recipientPhone || null,
      timezone,
      dailyDigestEnabled: digestEnabled,
      dailyDigestTime: digestTime,
      digestIncludeTodos: digestTodos,
      digestIncludeOverdue: digestOverdue,
      quietHoursStart: quietStart || null,
      quietHoursEnd: quietEnd || null,
    }),
    onSuccess: () => { refresh(); notify("Messaging schedule saved"); },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const taskPreferences = useMutation({
    mutationFn: (autoCompleteParent: boolean) => api.updateTaskPreferences({ autoCompleteParent }),
    onSuccess: (updated) => {
      refresh();
      notify(updated.autoCompleteParent
        ? "A task will close itself once its last subtask is done"
        : "Finishing the last subtask leaves the parent open");
    },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const granolaConnect = useMutation({
    mutationFn: () => api.connectGranola(granolaKey),
    onSuccess: () => { setGranolaKey(""); refresh(); notify("Granola connected and initial poll complete"); },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const eventReview = useMutation({
    mutationFn: ({ event, action }: { event: ExternalEvent; action: "create_memory" | "ignore" }) =>
      api.reviewEvent(event.id, action),
    onSuccess: () => { refresh(); notify("Event reviewed"); },
  });
  const pendingEvents = events.filter(event => event.source === "granola" && ["pending", "failed"].includes(event.status));
  const briefCount = briefs.filter(brief => brief.enabled).length;
  const activeProvider = data.notifications.smsProvider;
  const connections: Record<SmsProvider, { configured: boolean; fromPhone?: string }> = {
    twilio: { configured: data.twilio.configured, fromPhone: data.twilio.fromPhone },
    sendblue: { configured: data.sendblue.configured, fromPhone: data.sendblue.fromPhone },
  };
  const activeConnection = connections[activeProvider];
  /*
   * Choosing a provider that has no credentials yet only reveals its form: the
   * server refuses the switch, so delivery keeps running on whatever is already
   * connected until this one works.
   */
  const selectProvider = (provider: SmsProvider) => {
    setProviderTab(provider);
    if (provider !== activeProvider && connections[provider].configured) providerSwitch.mutate(provider);
  };
  return <div className="page">
    <PageHead
      eyebrow="Preferences & connections"
      title="Settings."
      description="Choose how Fieldnote reaches you, connect external services, and control when your daily briefing arrives."
    />
    {!data.secretStorageReady && <div className="integration-warning">
      <TriangleAlert size={16}/><span>Add <code>SETTINGS_ENCRYPTION_KEY</code> to the server environment before connecting providers.</span>
    </div>}
    <section className="settings-stack">
      <SettingsSection
        sectionId="appearance"
        title="Appearance"
        description="Match your system, or pin the interface to light or dark."
        status={themeStatus[preference]}
        icon={SunMoon}
      >
        <div className="card-title"><h3>Theme</h3><SunMoon size={18}/></div>
        <p className="integration-copy">Applies to this browser only. System follows your operating system setting as it changes.</p>
        <ThemeToggle/>
      </SettingsSection>
      <SettingsSection
        sectionId="classifications"
        title="Classifications"
        description="Manage life areas used by todos, memories, search, and the Agent."
        status="Work · Personal · custom"
        icon={Circle}
      >
        <LifeAreasSettings notify={notify}/>
      </SettingsSection>
      <SettingsSection
        sectionId="tasks"
        title="Tasks"
        description="How the board behaves when work is broken into subtasks."
        status={data.tasks.autoCompleteParent ? "Parent closes itself" : "Parent stays open"}
        icon={ListChecks}
      >
        <div className="card-title"><h3>Finishing a task</h3><ListChecks size={18}/></div>
        <p className="integration-copy">
          Applies wherever a subtask is completed: the board, the list, the editor, and the Agent.
          Finishing a parent that still has open subtasks always asks first, whichever way this is set.
        </p>
        <label className="toggle-row compact">
          <input
            type="checkbox"
            checked={data.tasks.autoCompleteParent}
            disabled={taskPreferences.isPending}
            onChange={event => taskPreferences.mutate(event.target.checked)}
          />
          <span>Mark the parent done when its last subtask is completed</span>
          {taskPreferences.isPending && <LoaderCircle className="spin" size={13}/>}
        </label>
      </SettingsSection>
      <SettingsSection
        sectionId="sms-connection"
        title="Message provider"
        description="Send through Twilio SMS or Sendblue iMessage, and switch between them whenever you like."
        status={activeConnection.configured
          ? `${providerLabel[activeProvider]} · ${activeConnection.fromPhone}`
          : `${providerLabel[activeProvider]} · not connected`}
        icon={Phone}
      >
        <div className="card-title"><h3>Sending provider</h3><MessageSquare size={18}/></div>
        <p className="integration-copy">Reminders, briefings, and Agent replies all go out through the provider selected here. Both providers can stay connected, and inbound messages are answered on whichever one they arrive on.</p>
        <div className="provider-toggle" role="tablist" aria-label="Message provider">
          {(["twilio", "sendblue"] as const).map(provider => <button
            key={provider}
            type="button"
            role="tab"
            aria-selected={providerTab === provider}
            className={`provider-option ${providerTab === provider ? "viewing" : ""} ${activeProvider === provider ? "active" : ""}`}
            disabled={providerSwitch.isPending}
            onClick={() => selectProvider(provider)}
          >
            <span className="provider-option-icon">{provider === "twilio" ? <Phone size={15}/> : <MessageSquare size={15}/>}</span>
            <span>
              <strong>{providerLabel[provider]}</strong>
              <small>{provider === "twilio" ? "SMS and MMS over carriers" : "iMessage with RCS and SMS fallback"}</small>
            </span>
            <span className={`provider-option-state ${activeProvider === provider ? "on" : ""}`}>
              {activeProvider === provider ? "Sending now" : connections[provider].configured ? "Connected" : "Not connected"}
            </span>
          </button>)}
        </div>
        {providerTab === "twilio" ? <div className="provider-panel">
          <div className="card-title"><h3>Twilio SMS</h3><Phone size={18}/></div>
          <p className="integration-copy">Inbound texts become Agent Studio conversations. Outbound texts deliver reminders and daily summaries.</p>
          <div className="integration-status"><span className={`dot ${data.twilio.configured ? "ok" : ""}`}/>{data.twilio.configured ? `Connected · ${data.twilio.fromPhone}` : "Not connected"}</div>
          <Field label="Account SID"><input className="input" value={accountSid} onChange={e => setAccountSid(e.target.value)} placeholder="AC…" /></Field>
          <Field label={data.twilio.configured ? "New auth token (only to rotate)" : "Auth token"}><input className="input" type="password" value={authToken} onChange={e => setAuthToken(e.target.value)} placeholder="Stored encrypted" /></Field>
          <div className="form-grid">
            <Field label="Twilio number"><input className="input" value={fromPhone} onChange={e => setFromPhone(e.target.value)} placeholder="+17185551234" /></Field>
            <Field label="Public HTTPS URL">
              <input className="input" value={webhookBaseUrl} onChange={e => setWebhookBaseUrl(e.target.value)} placeholder="https://your-tunnel.ngrok-free.app" />
              <small className="field-hint">Localhost cannot receive Twilio webhooks. Use ngrok, Cloudflare Tunnel, or your deployed URL.</small>
            </Field>
          </div>
          {twilioConnect.error && <div className="inline-error"><TriangleAlert size={14}/><span>{twilioConnect.error.message}</span></div>}
          <div className="actions">
            <button
              className="button primary"
              disabled={twilioConnect.isPending || !data.secretStorageReady || (!authToken && !data.twilio.configured)}
              onClick={() => twilioConnect.mutate()}
            >
              {twilioConnect.isPending ? <LoaderCircle className="spin" size={14}/> : <Zap size={14}/>}
              {data.twilio.configured ? "Save changes" : webhookBaseUrl ? "Connect & configure" : "Connect Twilio"}
            </button>
            {data.twilio.configured && <button className="button ghost" onClick={() => api.testTwilio().then(() => notify("Test SMS sent")).catch(e => notify(e.message))}>Send test</button>}
            {data.twilio.configured && activeProvider !== "twilio" && <button className="button ghost" disabled={providerSwitch.isPending} onClick={() => providerSwitch.mutate("twilio")}>Send through Twilio</button>}
            {data.twilio.configured && <button className="button danger" onClick={() => confirm("Disconnect Twilio?") && api.disconnectTwilio().then(refresh)}>Disconnect</button>}
          </div>
        </div> : <div className="provider-panel">
          <div className="card-title"><h3>Sendblue iMessage</h3><MessageSquare size={18}/></div>
          <p className="integration-copy">Messages send as iMessage and fall back to RCS, then SMS, on their own. Run <code>sendblue show-keys</code> and <code>sendblue lines</code> in your terminal to read the values below.</p>
          <div className="integration-status"><span className={`dot ${data.sendblue.configured ? "ok" : ""}`}/>{data.sendblue.configured ? `Connected · ${data.sendblue.fromPhone}` : "Not connected"}</div>
          {data.sendblue.lastError && <div className="inline-error"><TriangleAlert size={14}/><span>{data.sendblue.lastError}</span></div>}
          <Field label="API key ID"><input className="input" value={sendblueKeyId} onChange={e => setSendblueKeyId(e.target.value)} placeholder="From sendblue show-keys" /></Field>
          <Field label={data.sendblue.configured ? "New API secret (only to rotate)" : "API secret"}><input className="input" type="password" value={sendblueSecret} onChange={e => setSendblueSecret(e.target.value)} placeholder="Stored encrypted" /></Field>
          <div className="form-grid">
            <Field label="Sendblue number"><input className="input" value={sendbluePhone} onChange={e => setSendbluePhone(e.target.value)} placeholder="+15551234567" /></Field>
            <Field label="Public HTTPS URL">
              <input className="input" value={sendblueWebhookBaseUrl} onChange={e => setSendblueWebhookBaseUrl(e.target.value)} placeholder="https://your-tunnel.ngrok-free.app" />
              <small className="field-hint">Registers <code>{data.webhookPaths.sendblueInbound}</code> plus the blocked-line and reassigned-line webhooks, each with a generated secret. Sendblue webhooks are account-wide, so this replaces those URLs for every line.</small>
            </Field>
          </div>
          {data.sendblue.configured && <p className="integration-copy">
            {data.sendblue.autoTypingIndicator && data.sendblue.autoMarkRead
              ? "Sendblue shows a typing bubble and marks your message read the moment it arrives, so you get an acknowledgement before the reply is composed."
              : data.sendblue.autoTypingIndicator
                ? "Typing bubbles are on. Read receipts are off — Sendblue enables those per account, so email support@sendblue.com to ask for them, then save again."
                : "Typing bubbles and read receipts are off, so nothing acknowledges an inbound message until the reply lands. Save again to retry."}
          </p>}
          <p className="integration-copy">On the free shared line, a contact has to text your Sendblue number once before you can message them. Add them with <code>sendblue add-contact +1…</code> first.</p>
          {sendblueConnect.error && <div className="inline-error"><TriangleAlert size={14}/><span>{sendblueConnect.error.message}</span></div>}
          <div className="actions">
            <button
              className="button primary"
              disabled={sendblueConnect.isPending || !data.secretStorageReady || !sendblueKeyId || (!sendblueSecret && !data.sendblue.configured)}
              onClick={() => sendblueConnect.mutate()}
            >
              {sendblueConnect.isPending ? <LoaderCircle className="spin" size={14}/> : <Zap size={14}/>}
              {data.sendblue.configured ? "Save changes" : sendblueWebhookBaseUrl ? "Connect & register webhook" : "Connect Sendblue"}
            </button>
            {data.sendblue.configured && <button className="button ghost" onClick={() => api.testSendblue().then(() => notify("Test message sent")).catch(e => notify(e.message))}>Send test</button>}
            {data.sendblue.configured && activeProvider !== "sendblue" && <button className="button ghost" disabled={providerSwitch.isPending} onClick={() => providerSwitch.mutate("sendblue")}>Send through Sendblue</button>}
            {data.sendblue.configured && <button className="button danger" onClick={() => confirm("Disconnect Sendblue?") && api.disconnectSendblue().then(refresh)}>Disconnect</button>}
          </div>
        </div>}
      </SettingsSection>
      <SettingsSection
        sectionId="delivery-schedule"
        title="Delivery schedule"
        description="Set reminder texts, the daily Agent briefing, timezone, and quiet hours."
        status={smsEnabled ? "Delivery on" : "Paused"}
        icon={Clock3}
      >
        <div className="delivery-card settings-delivery">
        <div className="delivery-heading">
          <div><div className="eyebrow">Your day, delivered</div><h3>SMS schedule</h3></div>
          <span className={`delivery-live ${smsEnabled ? "active" : ""}`}><i/>{smsEnabled ? "Delivery on" : "Paused"}</span>
        </div>
        <p className="delivery-summary">
          {digestEnabled
            ? <>Every morning at <strong>{humanTime(digestTime)}</strong>, your Agent will text a concise briefing of due tasks and reminders{digestTodos ? <>, including every open todo due or reminding you that day</> : null}{digestOverdue ? <>, plus anything still open from an earlier day</> : null}.</>
            : <>Turn on the daily briefing to receive one concise morning summary of due tasks and reminders.</>}
        </p>

        <div className="delivery-options">
          <label className={`delivery-option ${smsEnabled ? "selected" : ""}`}>
            <span className="delivery-option-icon"><Send size={15}/></span>
            <span><strong>Reminder texts</strong><small>Send individual reminders when they become due.</small></span>
            <input type="checkbox" checked={smsEnabled} onChange={e => setSmsEnabled(e.target.checked)}/>
          </label>
          <label className={`delivery-option ${digestEnabled ? "selected" : ""}`}>
            <span className="delivery-option-icon"><Sparkles size={15}/></span>
            <span><strong>Daily Agent briefing</strong><small>One AI-written overview, delivered once each day.</small></span>
            <input type="checkbox" checked={digestEnabled} onChange={e => setDigestEnabled(e.target.checked)}/>
          </label>
          <label className={`delivery-option delivery-suboption ${digestEnabled && digestTodos ? "selected" : ""} ${digestEnabled ? "" : "disabled"}`}>
            <span className="delivery-option-icon"><ListChecks size={15}/></span>
            <span>
              <strong>Include today&rsquo;s todos</strong>
              <small>Cover open todos due today or set to remind you today, not only the reminders themselves.</small>
            </span>
            <input
              type="checkbox"
              checked={digestTodos}
              disabled={!digestEnabled}
              onChange={e => setDigestTodos(e.target.checked)}
            />
          </label>
          <label className={`delivery-option delivery-suboption ${digestEnabled && digestOverdue ? "selected" : ""} ${digestEnabled ? "" : "disabled"}`}>
            <span className="delivery-option-icon"><History size={15}/></span>
            <span>
              <strong>Include overdue todos</strong>
              <small>Carry over anything still open past its due date or a reminder that already passed.</small>
            </span>
            <input
              type="checkbox"
              checked={digestOverdue}
              disabled={!digestEnabled}
              onChange={e => setDigestOverdue(e.target.checked)}
            />
          </label>
        </div>

        <div className="form-grid delivery-destination">
          <Field label="Send messages to"><input className="input" value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)} placeholder="+17185551234" /></Field>
          <Field label="Schedule timezone">
            <select className="select" value={timezone} onChange={e => setTimezone(e.target.value)}>
              {timezoneNames.map(name => <option key={name} value={name}>{timezoneLabel(name)}</option>)}
            </select>
            <small className="field-hint">The dashboard, Agent, reminders, and daily briefing all use this timezone.</small>
          </Field>
        </div>

        <div className="schedule-panel">
          <div className="schedule-panel-head">
            <div><strong>Daily timing</strong><span>The worker checks this schedule once per minute.</span></div>
            <Clock3 size={17}/>
          </div>
          <div className="form-grid three schedule-controls">
            <Field label="Briefing arrives"><input className="input" type="time" value={digestTime} onChange={e => setDigestTime(e.target.value)} disabled={!digestEnabled} /></Field>
            <Field label="Quiet hours begin"><input className="input" type="time" value={quietStart} onChange={e => setQuietStart(e.target.value)} /></Field>
            <Field label="Messages resume"><input className="input" type="time" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} /></Field>
          </div>
          <div className="quiet-note">
            <Pause size={13}/>
            <span>No scheduled texts from <strong>{humanTime(quietStart)}</strong> to <strong>{humanTime(quietEnd)}</strong>. Anything due overnight waits until quiet hours end.</span>
          </div>
        </div>

        <div className="delivery-footer">
          <span><Database size={12}/>Saved locally and applied while the server is running</span>
          <button className="button primary" disabled={preferences.isPending} onClick={() => preferences.mutate()}>
            {preferences.isPending ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}Save SMS schedule
          </button>
        </div>
        </div>
      </SettingsSection>
      <SettingsSection
        sectionId="meeting-notes"
        title="Meeting notes"
        description="Bring Granola notes into a review queue before saving them as memories."
        status={data.granola.configured ? "Connected" : "Not connected"}
        icon={Sparkles}
      >
        <div className="settings-split">
          <div>
            <div className="card-title"><h3>Granola</h3><Sparkles size={18}/></div>
            <p className="integration-copy">Granola has no webhooks yet, so Fieldnote polls its read-only API and places new notes in a review queue.</p>
            <div className="integration-status"><span className={`dot ${data.granola.configured ? "ok" : ""}`}/>{data.granola.configured ? "Connected" : "Not connected"}</div>
            <Field label="Granola API key"><input className="input" type="password" value={granolaKey} onChange={e => setGranolaKey(e.target.value)} placeholder="Stored encrypted" /></Field>
            <div className="actions">
              <button className="button primary" disabled={granolaConnect.isPending || !granolaKey} onClick={() => granolaConnect.mutate()}>Connect Granola</button>
              {data.granola.configured && <button className="button ghost" onClick={() => api.pollGranola().then(result => { refresh(); notify(`${result.queued} new meeting events`); })}><RefreshCw size={14}/>Poll now</button>}
              {data.granola.configured && <button className="button danger" onClick={() => confirm("Disconnect Granola?") && api.disconnectGranola().then(refresh)}>Disconnect</button>}
            </div>
          </div>
          <div className="settings-review">
            <div className="card-title"><h3>Review queue</h3><Archive size={18}/></div>
            {!pendingEvents.length ? <div className="empty-state compact">No meeting events need review.</div> : <div className="list">
              {pendingEvents.slice(0, 8).map(event => <div className="list-row" key={event.id}>
                <span className="badge">GR</span>
                <div className="list-main"><strong>{String(event.payload.title || "Granola meeting")}</strong><small>{format(new Date(event.createdAt), "MMM d · h:mm a")}</small></div>
                <button className="button ghost" onClick={() => eventReview.mutate({ event, action: "ignore" })}>Ignore</button>
                <button className="button primary" onClick={() => eventReview.mutate({ event, action: "create_memory" })}>Save memory</button>
              </div>)}
            </div>}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection
        sectionId="atlassian"
        title="Jira & Confluence"
        description="Read boards, issues, spaces, pages, and comments from your Atlassian site."
        status={data.atlassian.configured
          ? `Connected · ${[data.atlassian.jiraAvailable && "Jira", data.atlassian.confluenceAvailable && "Confluence"].filter(Boolean).join(" · ")}`
          : "Not connected"}
        icon={SquareKanban}
      >
        <div className="card-title"><h3>Atlassian</h3><SquareKanban size={18}/></div>
        <AtlassianSettings
          config={data.atlassian}
          secretStorageReady={data.secretStorageReady}
          notify={notify}
          refresh={refresh}
        />
      </SettingsSection>
      <SettingsSection
        sectionId="digest-briefs"
        title="Digest briefs"
        description="Write an instruction once and have your Agent text you the answer every day."
        status={briefCount ? `${briefCount} active` : "None yet"}
        icon={Newspaper}
      >
        <div className="card-title"><h3>Your briefs</h3><Newspaper size={18}/></div>
        <DigestBriefsSettings
          atlassianConfigured={data.atlassian.configured}
          quietHours={{
            start: data.notifications.quietHoursStart,
            end: data.notifications.quietHoursEnd,
          }}
          notify={notify}
        />
      </SettingsSection>
      <UnderHoodSettings notify={notify}/>
    </section>
    {toast && <Toast>{toast}</Toast>}
  </div>;
}
