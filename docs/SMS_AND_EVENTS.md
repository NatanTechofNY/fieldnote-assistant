# SMS, reminders, and event integrations

## Runtime model

The web app, the webhook API, and one background worker all run in the same Node process. SQLite has to live on persistent storage and the service has to run as a single replica. SQLite owns reminders, delivery attempts, channel history, integration cursors, and review state; Algolia is only the retrieval projection, and nothing in the delivery path depends on it.

The worker ([`server/worker.ts`](../server/worker.ts)) ticks once at startup and then every 60 seconds, with a `running` flag so ticks cannot overlap. An inbound webhook also wakes it directly through `requestWorkerWake()`, so a text is answered in the seconds the agent takes rather than waiting out the interval; the timer stays as the safety net for retries, reminders, and anything queued while the process was down. A wake raised while a tick is already draining schedules one more pass, because an event enqueued mid-tick arrives too late for the claim already in flight. Each tick, in order:

1. Claim up to 20 inbound events per provider (Twilio, then Sendblue) and run the agent on each.
2. If outbound SMS is allowed right now, send due reminders, then the daily digest, then any due digest briefs.
3. Poll Granola.
4. Run maintenance: flush pending or failed index jobs, prune finished ones.

## Environment

```bash
DATABASE_PATH=/data/assistant.db
SETTINGS_ENCRYPTION_KEY=<long-random-value>
APP_ADMIN_PASSWORD=<hosted-app-password>
ALGOLIA_APPLICATION_ID=...
ALGOLIA_ADMIN_API_KEY=...      # index writes, including outbound message projections
ALGOLIA_SEARCH_API_KEY=...     # reads
ALGOLIA_AGENT_ID=...
ALGOLIA_AGENT_API_KEY=...      # falls back to ALGOLIA_SEARCH_API_KEY if unset
```

`SETTINGS_ENCRYPTION_KEY` encrypts the Twilio, Sendblue, Granola, and Atlassian credentials with AES-256-GCM before they go into SQLite. Back it up separately from the database — losing it makes every saved credential unreadable, and rotating it means reconnecting each integration.

`APP_ADMIN_PASSWORD` protects every app and API route except `/api/health` and `/api/webhooks/*`. Normal browser use signs in at `/login` and gets an `HttpOnly` session cookie; HTTP Basic Auth with username `admin` also works and is there for scripts and curl. Put a real access-control layer in front of the service for anything beyond a personal demo.

## Choosing a provider

Texts can go out through **Twilio** (carrier SMS and MMS) or **Sendblue** (iMessage, falling back to RCS then SMS on its own). Both can be connected at the same time; `notification_preferences.sms_provider` names the one that actually sends, and Settings → Message provider switches it. `sendSms()` ([`server/messaging.ts`](../server/messaging.ts)) reads that column on every send, so a switch takes effect on the next reminder without a restart. Selecting a provider with no stored credentials is refused, because the alternative is every scheduled send failing with nothing in the UI to explain it.

Inbound messages are answered on whichever provider they arrived on, regardless of the toggle. That is what keeps a reply to yesterday's reminder working the day after a switch.

Everything downstream of the send is provider-agnostic: quiet hours, opt-out, idempotency keys, `channel_messages`, reminder retries, and the digest and brief schedules are all shared, and `provider_message_id` holds a Twilio `MessageSid` or a Sendblue `message_handle` depending on who carried it.

| | Twilio | Sendblue |
|---|---|---|
| Credentials | Account SID + auth token | API key ID + API secret (`sendblue show-keys`) |
| Sending number | An `incomingPhoneNumber` on the account | A line on the account (`sendblue lines`) |
| Inbound webhook | Per number, set at connect time | Account-wide, registered at connect time |
| Webhook authenticity | `X-Twilio-Signature` HMAC | A secret this app mints and Sendblue echoes back |
| Delivery receipts | `statusCallback` per message | `status_callback` per message |
| Inbound acknowledgement | None available | Typing bubble and read receipt, sent by Sendblue |

### Acknowledging an inbound message

The reply to an inbound text still takes as long as the agent takes, so there is a gap with nothing to show the sender their message landed. Connecting Sendblue turns on two account settings — `auto-typing-indicator` and `auto-mark-read` — which make Sendblue itself show the "…" bubble and mark the message read the moment it arrives on a 1:1 iMessage.

This is done account-side rather than from the inbound route on purpose: an indicator fired by this process would carry a 60-second default lifetime, and before the webhook woke the worker it would often expire before the tick that answers it. Neither setting affects delivery, and read receipts have to be enabled per account by Sendblue, so a refusal is recorded on the integration row and reported in the connect toast rather than failing the connection. Both are iMessage-only and are no-ops for a recipient on SMS. Saving the Sendblue card again retries them.

## Hosted deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full guide. The essentials: one replica, a persistent volume, `DATABASE_PATH` pointed at it. Once it is up, open `/settings`, connect a provider, enter the public URL, and choose **Connect & configure** (Twilio) or **Connect & register webhook** (Sendblue). For Twilio that writes the number's inbound `smsUrl`; for Sendblue it registers the account's `receive`, `line_blocked`, and `line_assigned` webhooks. Delivery status callbacks are attached per outbound message in both cases rather than to the number.

## Local webhook testing

Run the app with `npm run dev`, then expose **port 4174** — the API, not the Vite dev server:

```bash
cloudflared tunnel --url http://localhost:4174
# or
ngrok http 4174
```

Both mint a throwaway hostname that changes on every restart. Put the generated HTTPS origin into the provider's configuration UI.

If you also want to load the *UI* through that hostname, add it to `VITE_ALLOWED_HOSTS`, which only affects the Vite dev server on 4173 and has nothing to do with webhook delivery:

```bash
VITE_ALLOWED_HOSTS=abc123.ngrok-free.app npm run dev
```

The webhook routes are:

| Route | Provider | Body |
|---|---|---|
| `POST /api/webhooks/twilio/sms` | Twilio inbound | `application/x-www-form-urlencoded`, empty TwiML reply |
| `POST /api/webhooks/twilio/status` | Twilio delivery callbacks | `application/x-www-form-urlencoded` |
| `POST /api/webhooks/sendblue/inbound` | Sendblue inbound (`receive`) | JSON |
| `POST /api/webhooks/sendblue/status` | Sendblue delivery callbacks | JSON |
| `POST /api/webhooks/sendblue/line-blocked` | Sendblue `line_blocked` | JSON |
| `POST /api/webhooks/sendblue/line-assigned` | Sendblue `line_assigned` | JSON |

Sendblue offers three other account topics that this app deliberately ignores. `outbound` is redundant with the per-message `status_callback`, which already reports everything sent from here. `typing_indicator` reports that a contact is typing, and there is no live conversation view to show it in. `call_log` and `contact_created` describe things this app has no model for.

The two line topics exist because both failures are otherwise silent. A blocked line fails every send, and a reassigned line — a real event on the free shared number — leaves the stored `from_number` pointing at a line the account no longer holds. Either one writes `integration_settings.last_error`, which the Settings card shows, and leaves `status` alone: the credentials still work, so the connection stays usable while the trouble is visible. Neither payload is documented, so every field is read defensively and the notice degrades to a bare statement of the event. Reconnecting clears it. A `line_assigned` event naming the line already in use is acknowledged and ignored, and no webhook is allowed to rewrite the stored sending number.

Registration appends rather than replaces, so connecting first deletes the URLs this app registered previously — matched by their `/api/webhooks/sendblue/` path, so anything added by hand in the dashboard is left alone. Without that, reconnecting behind a new tunnel hostname would leave the dead URL registered and Sendblue would keep retrying against it.

Twilio signature validation reconstructs the exact public URL from the stored `webhookBaseUrl`, falling back to the request's own protocol and host, so **reconfigure the integration every time the tunnel hostname changes** or every request will 403. For anything longer-lived than a debugging session use a named Cloudflare Tunnel on a domain you own; see [`DEPLOYMENT.md`](DEPLOYMENT.md#cloudflare-tunnel). `TWILIO_SKIP_SIGNATURE_VALIDATION=true` exists for tests and local debugging and is ignored when `NODE_ENV=production`.

Sendblue does not sign anything. Connecting it mints a random secret, stores it with the encrypted credentials, and registers each URL with that secret both as a `?token=` query parameter and as the webhook's own `secret`. A request is trusted when it carries the value back in either place, compared in constant time. Reconnect after the tunnel hostname changes so the registered URL still points at the tunnel. `SENDBLUE_SKIP_SIGNATURE_VALIDATION=true` is the equivalent local escape hatch, and `SENDBLUE_API_BASE_URL` overrides the API origin.

## Inbound: text to agent reply

The webhook does almost nothing itself, which is deliberate — the provider gets a fast 200 and the slow work happens on the worker where it can be retried. Sendblue in particular redelivers up to three times when it does not get one.

1. The provider's inbound route validates the request: a Twilio signature, or the Sendblue webhook secret.
2. If `recipient_phone` is configured, the sender must match it. **If no recipient phone has been set yet, any sender is accepted** — set one before pointing a real number at a public instance.
3. STOP / UNSUBSCRIBE / CANCEL / END / QUIT set the opt-out flag; START / UNSTOP clear it. Neither is enqueued.
4. Anything else is enqueued into `external_events` keyed on the provider's message ID, which is what makes retries safe. A Sendblue payload with `is_outbound: true` is acknowledged and dropped, so an echo of our own reply is never answered as if the user had written it.
5. Enqueuing wakes the worker, which claims the event on the spot — or on the next tick if the process was busy or restarting — and [`server/agent-runner.ts`](../server/agent-runner.ts) calls the Agent Studio completions API with a 24-hour, 40-message context window read from SQLite, executes any requested tools **in-process** via `executeAgentTool()` (max 8 iterations), sends the reply, and records the outbound provider message.

No browser is involved anywhere in that path.

## Outbound and delivery tracking

`sendSms()` ([`server/messaging.ts`](../server/messaging.ts)) picks the selected provider and calls `sendTwilioSms()` ([`server/twilio-service.ts`](../server/twilio-service.ts)) or `sendSendblueSms()` ([`server/sendblue-service.ts`](../server/sendblue-service.ts)). Both truncate the body to 1500 characters and, when a `webhookBaseUrl` is stored, attach a status callback pointing at that provider's route. The callback updates `channel_messages.status` by `provider_message_id`, and on a hard failure marks the originating reminder failed with the provider's error message.

Twilio reports a queue acknowledgement and raises its own exception on rejection. Sendblue answers `200` even for a `DECLINED` or `ERROR` message and reports the reason in the body, so the payload is inspected and turned into a thrown error; otherwise an undelivered message would be recorded as sent and never retried. Its eight statuses collapse onto the four `channel_messages` values, with `SENT` kept distinct from `DELIVERED` because it is terminal for SMS but not for iMessage.

## What gates an outbound send

Scheduled sends only happen when all four are true: SMS is enabled, a recipient phone is set, the opt-out flag is clear, and the local time is outside quiet hours (`quiet_hours_start`/`quiet_hours_end`, defaulting to 22:00–07:00 in the UI, and correctly handling an overnight range).

Two things worth knowing:

- **Opt-out and quiet hours gate scheduled outbound only.** An inbound text is still enqueued, still runs the agent, and still gets a reply. If you need STOP to mean total silence, that check does not exist yet.
- Reminders with `kind = 'due'` are never sent. They exist for scheduling and UI purposes; the worker only claims other kinds.

## Idempotency

| What | Key | Table |
|---|---|---|
| Inbound SMS | Twilio `MessageSid` | `external_events` (unique on user + source + external id) |
| Inbound iMessage | Sendblue `message_handle` | `external_events` |
| Reminder send | `reminder:{reminderId}:{scheduled_for}` | `scheduled_dispatches` |
| Daily digest | `daily_digest:{userId}:{localDate}` | `scheduled_dispatches` |
| Digest brief | `digest_brief:{briefId}:{localDate}` | `scheduled_dispatches` |
| Granola note | Granola note ID | `external_events` |

## Daily digest

One message per local day at `daily_digest_time`, composed by [`server/daily-digest.ts`](../server/daily-digest.ts). It has two shapes: a reminder digest when pending reminders exist, and a check-in when none do.

Turning on `digest_include_todos` ("Include today's todos" in Settings) appends the app's own lookup of open todos — anything not `done` or `cancelled` — that either fall due today or have a reminder landing today, each with its local due time and reminder times. The rows are injected rather than left to a tool call, so the digest still names them when the agent skips the lookup, and so a reminder that already fired this morning does not silently drop its task from the summary. `kind = 'due'` rows are not counted as reminders here, since a due date is not a notification and would otherwise be reported twice.

Turning on `digest_include_overdue` ("Include overdue todos" in Settings) adds a second section for open todos that never got finished on an earlier day: either their local due date has passed, or a reminder for them has already come and gone. Those rows carry the calendar date as well as the time, because they are not from today. The two sections are built in one pass, so a todo that is overdue *and* reminding again today is reported once under today rather than twice, and they share a single 20-row budget so a long backlog cannot crowd out the day itself. Each flag works on its own, and when the overdue list is non-empty the app tells the agent not to call the day clear — the reason a missed task used to vanish from the digest is that a fired reminder is `sent`, not `pending`, and so counted as neither.

## Digest briefs

A digest brief is a standing instruction of your own — "what changed on my board today" — that the agent composes and texts you at a per-brief `send_time`. It runs through the same agent runner and the same quiet-hours gate as everything else, and it can pull live Jira and Confluence data while composing. Briefs are managed from Settings and can be previewed before they ever send. Their internal scratch turns are marked `metadata.internal` so they stay out of the message index.

Settings offers three starter templates that prefill the form rather than creating anything, so the wording and the send time can be adjusted first. Because a brief scheduled inside quiet hours is skipped silently, the form warns when the chosen `send_time` falls in that window.

### End-of-day reflection

The **End-of-day reflection** template is a brief that asks a question instead of reporting an answer: at 21:00 it names a thing or two you closed out and asks how the day went. Nothing new runs on the server for it — it is an ordinary brief, and your reply arrives as ordinary inbound SMS on the next tick.

What makes it a feature rather than a prompt is the capture rule in [`agent-studio/system-prompt.txt`](../agent-studio/system-prompt.txt). Reflection replies are the one check-in the agent does not offer to save and then wait for confirmation on: when the last message on the thread was an evening reflection prompt, the reply is written straight to a journal memory with `review_worthy` true, `occurred_at` on that day, and the tag `end-of-day`, then acknowledged in one line. Asking permission over SMS costs a round trip at the exact moment somebody is putting their phone down, and the entry is editable and deletable afterwards like any other memory. Those entries are journals dated to the day they describe, so they show up as candidate evidence on the Reflections page for that range.

## Granola

Granola has a read-only API and no webhooks, so this polls. Each tick calls `GET https://public-api.granola.ai/v1/notes?updated_after={lastPolledAt}&page_size=30` for up to five pages, stores `lastPolledAt` as a durable cursor in `integration_settings.config_json`, and deduplicates on the Granola note ID.

New notes land in the Integrations review queue rather than becoming memories automatically. You choose **Save memory** or **Ignore** (`POST /api/integrations/events/:id/review`). Meeting notes are long, third-party, and often wrong about what you actually committed to, so a human confirming beats an agent guessing. A polling failure is recorded on the integration row as `status='error'` with `last_error` and does not stop the rest of the tick.

Granola API keys currently require an eligible Business or Enterprise plan.

## Retries and recovery

- **Inbound events** that throw are marked failed and retried with backoff of `min(3600, 2 ** min(attempts, 10))` seconds. Claims left `processing` by a crash are reclaimed after ten minutes.
- **Reminders** retry via `available_at` with backoff of `min(60, 2 ** min(attempts + 1, 6))` minutes. Inspect `reminders.last_error` when one stays failed. Stale `claimed_at` values are also reclaimed after ten minutes.
- **Daily digests and digest briefs retry only when the failure was transient.** A dropped connection, an aborted request, or a `429`/`5xx` from a provider leaves the `scheduled_dispatches` row `pending` behind an `available_at` backoff of `min(60, 2 ** attempts)` minutes, so a later tick finishes the job. This is what lets a digest survive a laptop that was asleep at its send time. The retry re-claims the same row, so the day still yields at most one message.
- **Any other failure ends the day for that send.** A broken Jira query or a rejected turn marks the row `failed`, and the idempotency key prevents a second attempt until the next date. Transient failures also stop after `MAX_DISPATCH_ATTEMPTS` (5) so a provider outage does not cost a request per tick. Inspect `scheduled_dispatches.last_error` and `attempts` to tell the two cases apart.
- Agent Studio completions abort after 45s. Without that deadline a request issued just before the machine sleeps stays in flight until it wakes, failing long after the send it belonged to was due.
- Reconnect Twilio, Sendblue, Granola, or Atlassian from the UI to rotate a provider secret.
- Restore the SQLite volume and the same `SETTINGS_ENCRYPTION_KEY` together, or the restored credentials are useless.
- Rebuild Algolia with `npm run reindex` at any time. Delivery and integration state does not live in Algolia.

There is no rate limiting on writes, the agent, or the REST API. The only throttle is on failed logins: 8 attempts, then a 15-minute lockout. Atlassian's own rate limits surface as tool errors.

## Before using a real number

Twilio trial accounts can only message verified recipients and prepend trial branding. Complete any applicable sender registration (A2P 10DLC in the US) and get the recipient's consent before pointing a production number at this.

Sendblue needs no A2P registration, but its free tier is a shared line limited to 10 verified contacts, and a contact has to text your Sendblue number once before you can message them — add them with `sendblue add-contact +1…` first. A send to an unverified contact comes back `DECLINED`, which this app records as a failed delivery with Sendblue's own reason. Rate limits are one message per second per line, so a batch of reminders queues rather than bursting.
