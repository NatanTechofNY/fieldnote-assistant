# SMS, reminders, and event integrations

## Runtime model

The web app, the webhook API, and one background worker all run in the same Node process. SQLite has to live on persistent storage and the service has to run as a single replica. SQLite owns reminders, delivery attempts, channel history, integration cursors, and review state; Algolia is only the retrieval projection, and nothing in the delivery path depends on it.

The worker ([`server/worker.ts`](../server/worker.ts)) ticks once at startup and then every 60 seconds, with a `running` flag so ticks cannot overlap. An inbound webhook also wakes it directly through `requestWorkerWake()`, so a text is answered in the seconds the agent takes rather than waiting out the interval; the timer stays as the safety net for retries, reminders, and anything queued while the process was down. A wake raised while a tick is already draining schedules one more pass, because an event enqueued mid-tick arrives too late for the claim already in flight. Each tick, in order:

1. Claim up to 20 inbound events per provider (Twilio, then Sendblue) and run the agent on each.
2. Roll repeating todos forward (see [below](#repeating-todos)). This happens whether or not texting is on, because it is scheduling rather than delivery.
3. If outbound SMS is allowed right now, send due reminders, then the daily digest, then any due digest briefs.
4. Poll Granola.
5. Run maintenance: flush pending or failed index jobs, prune finished ones.

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
| Inbound acknowledgement | None available | Typing bubble and read receipt |

### Acknowledging an inbound message

The reply to an inbound text still takes as long as the agent takes, so there is a gap with nothing to show the sender their message landed. Two things fill it, both iMessage-only and both no-ops for a recipient on SMS.

Connecting Sendblue turns on two account settings — `auto-typing-indicator` and `auto-mark-read` — which make Sendblue itself show the "…" bubble and mark the message read the moment it arrives on a 1:1 iMessage. That covers every inbound message, including the ones this app never answers: a `STOP` keyword, or a text from a number that is not the configured recipient. Neither applies to a [group chat](#group-chats), and the worker does not ask for a bubble on a group turn either. Neither setting affects delivery, and read receipts have to be enabled per account by Sendblue, so a refusal is recorded on the integration row and reported in the connect toast rather than failing the connection. Saving the Sendblue card again retries them.

For a message that does get an answer, the worker also sends an indicator explicitly through [`/api/send-typing-indicator`](https://docs.sendblue.com/api-v2/typing-indicators/) before it starts the agent turn, because the account setting is not enough on its own: it lasts 60 seconds and a slow turn outlasts it, so the explicit one asks for 120 via `max_duration_ms`.

It asks exactly once, and the bubble comes down with `state: "stop"` when the reply is actually out — which is the pattern Sendblue documents for this case, a longer indicator while the model thinks and a stop when the reply is ready. Doing it in that order covers the wait end to end and means no bubble outlives the answer by the rest of its two minutes. A turn that fails takes the bubble down the same way. Asking more than once was tried and removed; see below.

`state` and `max_duration_ms` are typing-v2 parameters, and a line whose worker firmware predates them answers `503` naming the firmware. A bare `start` with neither parameter is documented to work on every firmware, so that refusal is retried once in the older spelling rather than reported; the bubble then lasts Sendblue's 60-second default. There is no legacy spelling of `stop`, so that one is given up on and its bubble expires on its own. The endpoint answers `SENT` in the reference and `QUEUED` in the worked example, and both are read as acceptance.

### The first message after an idle gap gets no bubble

Sendblue delivers an indicator over the conversation's established route mapping, and a thread that has been quiet for a few minutes behaves as though it has none — the indicator is accepted and never appears. Worth knowing before it looks like a bug in this app.

Measured against a live account. Threads idle for 5m55s and 6m40s got a read receipt and no bubble, while a message 48 seconds after a reply got one. Asking repeatedly was then tried and does not help: on a thread idle for half an hour, a twelve-second turn asked at 0s and again at 8s, both were accepted, and no bubble appeared. So the route only comes back once traffic crosses it, and on the first turn the reply is the first thing to do that — by which point the bubble is moot. **Retrying inside the turn was removed on that evidence, and the code asks once.**

Read receipts are unaffected, because `auto-mark-read` does not depend on that mapping. That is exactly why the gap looks so odd from the phone: the message is visibly read, and then nothing happens until the answer lands.

None of it can fail a turn, and none of the calls are waited for. A refusal does not always raise an HTTP error, though: like `send-message`, this endpoint can answer `200` with `status: "ERROR"` and a reason in the body. So the body is read, and every answer that is not an acceptance — a refusal, or a shape this app does not recognise — is logged with `console.warn`. Refusals stay out of `integration_settings.last_error` and off the Settings card, because the bubble is decoration and the commonest refusal is a recipient who is on SMS rather than iMessage.

**Saying nothing therefore means Sendblue accepted the request, and nothing else.** That is the one fact worth having when a bubble does not appear: a silent log narrows it down to Sendblue dropping an indicator it said it had taken, rather than this app sending something wrong.

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
2. The sender is checked by `isInboundSenderAllowed()` in [`server/messaging.ts`](../server/messaging.ts). In a 1:1 conversation the sender must be `recipient_phone`. In an iMessage group chat (see [below](#group-chats)) the recipient must be among the payload's `participants`, and the sender must then be the recipient, a trusted contact, or — when the "answer anyone in a group chat I have written in" toggle is on — anyone at all, provided the recipient has already sent a message in that group (`ownerHasSpokenInGroup()`): anyone can add two numbers to an iMessage group without asking, so being listed as a participant is not consent. A refused sender in a group the recipient is in is acknowledged with `200` and dropped rather than answered `403`, since Sendblue redelivers anything without a 2xx; a stranger texting the line 1:1 still gets the 403. **If no recipient phone has been set yet, any 1:1 sender is accepted** — set one before pointing a real number at a public instance — and every group message is refused, because there is no recipient to look for.
3. STOP / UNSUBSCRIBE / CANCEL / END / QUIT set the opt-out flag; START / UNSTOP clear it. Neither is enqueued. Only the recipient's own keywords count: in a group, "stop" from anyone else is an ordinary message.
4. Anything else is enqueued into `external_events` keyed on the provider's message ID, which is what makes retries safe. A Sendblue payload with `is_outbound: true` is acknowledged and dropped, so an echo of our own reply is never answered as if the user had written it.
5. Enqueuing wakes the worker, which claims the event on the spot — or on the next tick if the process was busy or restarting — raises the typing bubble described [above](#acknowledging-an-inbound-message), and then [`server/agent-runner.ts`](../server/agent-runner.ts) calls the Agent Studio completions API with a 24-hour, 40-message context window read from SQLite, executes any requested tools **in-process** via `executeAgentTool()` (max 8 iterations), sends the reply, and records the outbound provider message. Between iterations the turn is sent back with the tool results filled in, and Agent Studio answers a trailing assistant message by *continuing* it — same message id, accumulated parts — so the runner replaces that message rather than appending the continuation; two copies sharing an id are refused with `422 Messages must have unique ids`, which for a while made every two-round turn fail once before its retry succeeded. One tool, `send_product_cards`, texts during the turn rather than at the end of it; the worker hands its own `sendSms` into the turn context so those messages travel the same way as the reply.

No browser is involved anywhere in that path.

## Group chats

iMessage has group chats and SMS does not, so this is Sendblue-only. The line cannot start a group on an inbound-initiated plan; the owner adds the assistant's number to a group from their own phone, and from then on every message in that group reaches the `receive` webhook with a non-empty `group_id`, a `group_display_name`, and the full `participants` list. Those three fields are what the feature is built on; nothing about a group is stored ahead of time, and the recipient's presence is re-checked on every message, so leaving the group stops the assistant answering it on the next text.

**Who is heard.** Settings has a trusted-contacts list (name and E.164 number, up to 25) and a toggle that opens a group to every participant once the owner has written in it. Trust is scoped to the group: a trusted contact texting the line directly gets the same 403 as a stranger, and nobody is heard in a group the recipient is not in. The rule is the pure function `isInboundSenderAllowed()` in [`server/messaging.ts`](../server/messaging.ts), described step by step [above](#inbound-text-to-agent-reply).

**One thread per group.** The worker keys the turn on `group:<group_id>` rather than on the speaker, so everyone in the group shares one conversation and one Agent Studio conversation id. Each inbound row carries `speaker` (the number), `speakerName` (from the trusted-contacts list, or "the owner" for the recipient), `speakerIsOwner`, `groupId`, and `groupName` (the title iMessage reported) in its metadata. `threadHistory()` prefixes every user message with `[Sarah]` when it replays the window so the model can tell whose request is whose — the name, or a redacted number like `+1…22` for a participant nobody named; the full number never leaves the server for the model — and the latest message's `turnContext` carries `speakerName`, `speakerIsOwner`, and the group's life area. `channel_threads.address` never collides with a phone number because of the prefix; the prefix, `groupIdOfAddress()`, and the metadata readers live in [`server/group-thread.ts`](../server/group-thread.ts).

**Answering into the group.** `sendSms()` takes a `groupId` option. When it is set the message goes through Sendblue's [`/api/send-group-message`](https://docs.sendblue.com/api/resources/groups/methods/send_message) with `group_id` and `from_number` instead of `/api/send-message` with `number`, whatever provider is selected for 1:1 sends, and Twilio refuses it outright. Inline replies and tapbacks work in a group the same way they do 1:1, because both address a message handle. Typing indicators are 1:1 only and are not raised for a group turn; `send_product_cards` texts into the group when the turn came from one.

**Reminders follow the ask, while it is still the group's.** A todo created by the agent during a group turn stores the thread in `todos.reply_thread_id`, and `deliverReminder()` sends its `pre` and `escalation` reminders into that group rather than to `recipient_phone`, so everyone who heard the request hears the reminder. The thread pointer alone does not decide it: `claimDueReminders()` resolves the group only while the todo is still filed in that group's life area, so a todo the owner moves to Work or Personal in the app, or one left behind when the group's area is deleted, reminds the recipient instead, and a group-bound reminder lists only the open subtasks filed in the group's area. With Sendblue disconnected a group reminder also goes to the recipient rather than failing on every retry. A todo made in the app, in a 1:1 text, or through the REST API has no thread and reminds the recipient as before. Digests and briefs always go to the recipient. The usual gates — SMS enabled, a recipient set, not opted out, outside quiet hours — apply to group reminders too.

**Each group has its own life area.** The first turn in a group creates a life area with `life_areas.thread_id` pointing at the group's thread (`ensureGroupLifeArea()` in [`server/db.ts`](../server/db.ts); a unique partial index on `thread_id` guarantees one per thread, and the worker being the only writer is what makes the lookup-then-insert safe). It is seeded with the name iMessage reported, cleaned and cut to 80 characters since any member can set it, and the turn context tells the agent the area is new (`groupLifeAreaIsNew`, true until the assistant has taken a turn since the area was created, so a first turn that failed in flight still gets the cue on retry) so it names it from context with the `name_group_chat` tool — "Cementa & me", "Family". After that first name only a message from the owner (`speakerIsOwner`) can rename it through the tool. The owner can also rename it from Settings → Classifications, where it is badged "Group chat"; renaming rewrites `life_area_name` on every indexed todo and memory of the area, `group_name` on every indexed message of the thread, and retitles the thread. Deleting the area does not close the group, but it does unfile the group's earlier records: the next message there creates a fresh area, and the todos and memories left unclassified are no longer visible from inside the group (they stay in the app for the owner) and their reminders come to the owner. The Settings confirmation says so. The group's title in the archive is `COALESCE(life_areas.name, channel_threads.display_name)`, where `display_name` holds the name iMessage sent, written only while the thread has none.

**What a group can see.** Everything a group turn creates is filed under the group's area whatever `life_area_id` the agent passed, and from inside the group nothing else of the owner's exists. `ToolTurnContext.scope` carries the area and the thread; every by-id read in [`server/tool-executor.ts`](../server/tool-executor.ts) (`get_todo`, `update_todo`, `set_todo_status`, `delete_todo`, the memory tools, `create_reminder`, `update_reminder`, `delete_reminder`) treats a record from another area as not found, `list_todos`, `get_agenda`, `list_reminders`, and `list_life_areas` return only the area's rows, `get_conversation_context` opens only the group's own thread, and `update_todo`/`update_memory` cannot move a record out of the area. `get_reflection_evidence`, `get_review_evidence`, and the Jira and Confluence tools are refused outright. The hosted search tool runs inside Agent Studio, so each group completion is sent with `algolia.searchParameters` that fence the todo and memory indices to the area's `life_area_id` and the messages index to the group's `threadId`. The fence is one-directional: the owner sees the group's records in the app and in their own 1:1 thread, and two groups never see each other.

**The first message.** `turnContext.firstMessageInGroup` is set when the group's thread holds no earlier user message — a query on the thread, not on the 24-hour context window, so a group that goes quiet for a day is not introduced to again — which is the agent's cue to do what was asked and then introduce itself once. `speakerName` and `speakerIsOwner` say who wrote the message; `groupLifeAreaId` and `groupLifeAreaName` say where its records go.

**Recall knows who spoke.** A group message's projection into the messages index carries `group_id`, `group_name`, and, on a user message, `speaker_name` — a name from the trusted-contacts list, never a number — so "what did Cementa ask for" is a search. 1:1 and web records keep their previous shape. `get_conversation_context` returns `speaker` (the name) on group user messages and `group_name` on a group thread, and the archive's search fallback in [`server/routes/conversations.ts`](../server/routes/conversations.ts) reports the same three fields.

**A second bubble.** `send_message` texts one message mid-turn — an emoji, "on it", a line that should stand alone — through the same sender the turn's reply uses, into the group when the turn came from one, and files it on the thread as an assistant message with `kind: "message"`. A turn that said everything through it and then returned no text is delivered as those bubbles alone, the same rule as a tapback with nothing after it. It works on any SMS conversation and refuses on web, where the answer is the reply itself. Every Sendblue call, this one included, is bounded by `SENDBLUE_TIMEOUT_MS` (15 s) so a stalled connection cannot hold the worker's loop.

## Reactions and threads

Two things iMessage has that SMS does not, both reachable only from a turn a real message started — never from the browser chat, a Twilio conversation, or an app-composed turn like a digest.

**A tapback.** `react_to_message` posts to Sendblue's `/api/send-reaction` with the handle of the message being answered. The value is `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`, or exactly one emoji, with a `-` prefix to take one back; the shape is checked in [`server/schemas.ts`](../server/schemas.ts) before a request goes out. Reactions are iMessage-only, so Sendblue returns `422` for an SMS or RCS target, for one of our own outbound messages, and for a line that cannot deliver them. That refusal is handed back to the agent as a failed tool result rather than failing the turn, which is what lets it answer in words instead.

A tapback can also be the whole answer. When the agent has reacted in a turn and then returns no text, `runChannelAgent()` returns an empty reply instead of the usual "did not receive a text response" fallback, files no assistant bubble, and the worker sends nothing — "thanks!" gets a heart and not a sentence after it. Taking a reaction back with a `-` prefix does not count; a turn whose only gesture was a removal still gets the fallback. The prompt's texting rules in [`agent-studio/system-prompt.txt`](../agent-studio/system-prompt.txt) are what make the agent reach for a tapback in the first place: react to anything the user shares, alongside the words when the message asks for something, alone when it does not.

**A progress tapback.** Separately from anything the agent chooses, `runChannelAgent()` puts 🔍 on the user's message the moment the first *working* tool call comes back from Agent Studio — anything other than `react_to_message`, `reply_in_thread`, and `send_product_cards` — and takes it off again before the reply is returned, or before the agent's own tapback goes out so that one stands alone. iMessage keeps one tapback per sender per message, so once the agent has reacted — in this attempt, or in an earlier one per the archive — the 🔍 is never raised again for the rest of the turn: putting it up would replace the agent's reaction, and taking it down would leave the message bare. It is the runtime's gesture rather than the model's: it costs no completion, it needs no prompt compliance, and it leaves no tool row, only the transient entry on the inbound row's `reactions` that the removal clears. A turn answered without tools never shows it. A turn that *fails* leaves it up on purpose: every failed inbound turn is retried behind a short backoff, so the work is still in progress, and the retry reads the archive to see the mark is already there rather than sending it again — one 🔍 for the whole turn however many attempts it takes, taken down by the attempt that answers. Both ends are best effort; a reaction Sendblue refuses is logged and the turn continues.

**An inline reply.** `reply_in_thread` sends nothing itself; it marks the turn, and the worker adds `reply_to` to the send so the answer appears threaded under the message it answers. Sendblue refuses an inline reply outright rather than downgrading it to a standalone message, so `sendSendblueSms()` retries once without `reply_to` — an unthreaded answer beats none.

Reading a thread is the other half. An inbound text sent as an inline reply carries `reply_to` and `thread_originator`, both stored on the inbound row, and the turn is put to the model with a quote of the parent in front of it. Without that, "that one" attaches to whatever was said last rather than to the message the user actually picked. Sendblue has no inbound webhook for a tapback the user sends, so the agent cannot see those.

Both are drawn in the conversation archive as what they are, not only as tool calls. A tapback Sendblue accepted is filed onto the message it landed on by `recordMessageReaction()` ([`server/db.ts`](../server/db.ts)) and shown on that bubble; a removal takes it back off. A threaded answer is filed on the outbound row by `recordOutboundProviderMessage()`, which stores the handle the sender reports having *reached* rather than the one the agent asked for — the agent can request a thread and Sendblue can refuse it, and a reply drawn under a parent it never reached is a claim the reader has no way to check.

## Outbound and delivery tracking

`sendSms()` ([`server/messaging.ts`](../server/messaging.ts)) picks the selected provider and calls `sendTwilioSms()` ([`server/twilio-service.ts`](../server/twilio-service.ts)) or `sendSendblueSms()` ([`server/sendblue-service.ts`](../server/sendblue-service.ts)). Both truncate the body to 1500 characters and, when a `webhookBaseUrl` is stored, attach a status callback pointing at that provider's route. A send may also carry a `replyTo` handle, which only Sendblue has anywhere to put, or a `groupId`, which forces Sendblue and its group endpoint (see [Group chats](#group-chats)). The callback updates `channel_messages.status` by `provider_message_id`, and on a hard failure marks the originating reminder failed with the provider's error message.

**Media.** A send may carry one `mediaUrl`, a public image URL the provider fetches itself: Sendblue sends it as `media_url` and delivers a native iMessage attachment, downgrading to RCS or MMS for a recipient without iMessage; Twilio sends it as `MediaUrl` over MMS. The URL has to be reachable from the provider's servers, end in the image's file extension, and stay under 10 MB, or the text lands with no picture and nothing reports why — which is what `npm run catalog:check` is for. Sendblue also accepts a `sendStyle`, one of the iMessage expressive effects such as `gentle` or `celebration`; Twilio has nowhere to put one and ignores it. The only caller today is `send_product_cards`, which texts one picture card per product and files each on the thread with `metadata_json.kind = "product_card"` and the `mediaUrl` it went out with (see [`TOOL_ENDPOINT_MAPPING.md`](TOOL_ENDPOINT_MAPPING.md#shopping)). Sendblue's rich App Cards need a V2 Mac line, a published iMessage extension, and a paid plan, so they are not used.

Twilio reports a queue acknowledgement and raises its own exception on rejection. Sendblue answers `200` even for a `DECLINED` or `ERROR` message and reports the reason in the body, so the payload is inspected and turned into a thrown error; otherwise an undelivered message would be recorded as sent and never retried. Its eight statuses collapse onto the four `channel_messages` values, with `SENT` kept distinct from `DELIVERED` because it is terminal for SMS but not for iMessage.

## What gates an outbound send

Scheduled sends only happen when all four are true: SMS is enabled, a recipient phone is set, the opt-out flag is clear, and the local time is outside quiet hours (`quiet_hours_start`/`quiet_hours_end`, defaulting to 22:00–07:00 in the UI, and correctly handling an overnight range). Digests and briefs go to the recipient phone; a reminder goes there too unless its todo was asked for in a [group chat](#group-chats), in which case it goes back to that group.

Two things worth knowing:

- **Opt-out and quiet hours gate scheduled outbound only.** An inbound text is still enqueued, still runs the agent, and still gets a reply. If you need STOP to mean total silence, that check does not exist yet.
- Reminders with `kind = 'due'` are never sent. They exist for scheduling and UI purposes; the worker only claims other kinds. A todo whose reminder lands on its own due date therefore keeps both rows — "remind me to take out the trash at 9pm" writes the same instant to `due_at` and `reminder_at`, and collapsing the pair would leave only the row the worker skips. `syncTodoReminders` dedupes per delivery bucket for that reason: a `pre` and an `escalation` sharing an instant still become one text, but a due date never stands in for the reminder itself. `GET /api/reminders/due`, which drives the in-app toast, collapses the pair at read time so one moment is one interruption.

## Repeating todos

A todo that repeats — "give the cat her medicine every day at 8" — is one row carrying a `recurrence_json` rule (`freq` daily or weekly, `interval`, `weekdays`, a local `time`, and `lead_minutes`). The row's `due_at` always holds the **current occurrence**, computed from the rule in the user's `notification_preferences.timezone`, and `reminder_at` holds `due_at` minus `lead_minutes` (or nothing when `lead_minutes` is null). Everything downstream then works unchanged: `syncTodoReminders` writes the usual `due` and `pre` rows, the worker texts the `pre` row, and the calendar, Overview, digest, and Algolia all read `due_at` as they would for any other task. A request that supplies `due_at`, `reminder_at`, or `extra_reminders` for a repeating todo is refused with a 400 rather than quietly overruled, and so are edits to its `due` and `pre` reminder rows through the reminder routes and tools — moving them would be undone at the next roll, and deleting the due date would take the row off its series for good. An `escalation` reminder belongs to the one occurrence and is editable. A repeating todo cannot have a `parent_id` or subtasks. `lead_minutes` is bounded so the reminder never falls before the midnight after the previous occurrence: "every day at 9" can be texted at most nine hours ahead, a weekly task the day before. Otherwise the reminder would already be in the past when the row rolled and go out at midnight.

Completing one is an ordinary `status = 'done'` write. Alongside it the server logs the occurrence in `todo_completions` (unique on todo and occurrence) and refreshes `last_completed_at`; moving the status back to an open one removes that log entry, so undoing a tap on the checkbox costs nothing, while `cancelled` ends the series and keeps the entry. The row stays `done` for the rest of that local day, which is what the list shows as "Done for today". Sending the same rule back — which the editor does on every save — changes nothing. A rule that actually differs opens the next occurrence: `due_at` moves, a `done` or `in_progress` status goes back to `pending`, and today's completion stays in the log. The streak is counted by local day rather than by instant, so changing the time or the timezone does not break it.

The worker's `rollRecurringTodos()` is the only thing that advances a series. On each tick it looks for repeating rows, other than `cancelled` ones, whose `due_at` falls on an earlier local date than today, and moves each to the first occurrence on or after today's local date: new `due_at` and `reminder_at`, `status` back to `pending` (a `blocked` row stays blocked — the block is about the task, not the day), `completed_at` cleared, reminder rows rebuilt, and an index job queued. The search is decided on local dates, not instants, so a zone whose clocks jump forward at midnight cannot pull the answer back on to the day before. A missed day therefore rolls forward at midnight rather than sitting overdue for ever, and a worker that was asleep overnight still lands on today's slot — late, and so texted at once — rather than skipping to tomorrow. Each row is rolled on its own: a rule the engine cannot read is logged and skipped rather than allowed to stop the rows behind it, and a repeating row that has lost its `due_at` is put back on its series from now. Setting `cancelled` stops the series; clearing the rule leaves the current occurrence in place as a one-off. A change to the user's timezone takes effect at the next roll.

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

What makes it a feature rather than a prompt is the capture rule in [`agent-studio/system-prompt.txt`](../agent-studio/system-prompt.txt). Reflection replies are the one check-in the agent never has to offer to save: when the last message on the thread was an evening reflection prompt, the reply *is* the entry and the agent does not ask permission to keep it. Asking permission over SMS costs a round trip at the exact moment somebody is putting their phone down, and the entry is editable and deletable afterwards like any other memory.

It does ask about what the reply left out, though, because a reply is a reflection and not a filled-in form. Before writing anything it sends one message asking for whatever is missing — in practice the mood, occasionally the life area — and saves on the answer. "Just save it" is a valid answer and leaves those fields null. The title is never asked for: the agent writes it from the user's own words, since a memory with no title is unreadable in the list they browse later, and `create_memory`'s tool schema makes a null title unrepresentable. The saved record is a journal memory with `review_worthy` true, `occurred_at` on that day, and the tag `end-of-day`, acknowledged in one line. Those entries are dated to the day they describe, so they show up as candidate evidence on the Reflections page for that range.

## Granola

Granola has a read-only API and no webhooks, so this polls. Each tick calls `GET https://public-api.granola.ai/v1/notes?updated_after={lastPolledAt}&page_size=30` for up to five pages, stores `lastPolledAt` as a durable cursor in `integration_settings.config_json`, and deduplicates on the Granola note ID.

New notes land in the Integrations review queue rather than becoming memories automatically. You choose **Save memory** or **Ignore** (`POST /api/integrations/events/:id/review`). Meeting notes are long, third-party, and often wrong about what you actually committed to, so a human confirming beats an agent guessing. A polling failure is recorded on the integration row as `status='error'` with `last_error` and does not stop the rest of the tick.

Granola API keys currently require an eligible Business or Enterprise plan.

## Retries and recovery

- **Inbound events** that throw are marked failed and retried with backoff of `min(3600, 2 ** min(attempts, 10))` seconds. Claims left `processing` by a crash are reclaimed after ten minutes. A retry **resumes** the turn rather than restarting it: the inbound row is reused, and `runChannelAgent()` appends the successful write results from the earlier attempt's tool rows as an assistant message before asking Agent Studio to continue, so a turn that timed out after its `update_todo` does not update again on the retry and then describe the change as pre-existing. Reads are not replayed; repeating a search is cheap.
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
