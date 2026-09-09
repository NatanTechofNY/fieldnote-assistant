# Agent tools

## How a tool call actually executes

The agent has **32 tools**: 31 declared `client_side` in [`agent-studio/tools/client-tools.json`](../agent-studio/tools/client-tools.json), plus one hosted search tool declared in [`agent-studio/tools/algolia-search.json`](../agent-studio/tools/algolia-search.json).

Despite the `client_side` type, none of them run in a browser. All 31 resolve to a single function, `executeAgentTool()` in [`server/tool-executor.ts`](../server/tool-executor.ts), which talks to SQLite (or, for Atlassian and Sendblue, straight out to that provider's API). Only the transport differs:

| Channel | Path to the executor |
|---|---|
| Browser | Agent Studio → browser handler → `POST /api/agent/tools/:name` → `executeAgentTool()` |
| SMS, digests, briefs | [`server/agent-runner.ts`](../server/agent-runner.ts) calls `executeAgentTool()` in-process — no HTTP, no session |

**Tools do not call the REST API.** The `/api/todos`, `/api/memories`, and `/api/reminders` routes are a parallel implementation for the React UI. They share the Zod schemas in [`server/schemas.ts`](../server/schemas.ts) and the same `queueIndexJob` + `flushSoon` indexing path, but a tool call never goes through them. The "equivalent route" columns below are there so you can find the UI code that does the same thing, not to describe a call chain.

The fixed local identity is `USER_ID` (`process.env.DEMO_USER_ID || "devcon-demo"`). Handlers never accept or forward a model-supplied user ID.

## Inventory

| Tool | Reads or writes | Equivalent REST route (UI only) |
|---|---|---|
| `get_todo` | read | `GET /api/todos/:id` |
| `list_todos` | read | `GET /api/todos` |
| `create_todo` | **write** | `POST /api/todos` |
| `update_todo` | **write** | `PATCH /api/todos/:id` |
| `set_todo_status` | **write** | `PATCH /api/todos/:id/status` |
| `delete_todo` | **write** | `DELETE /api/todos/:id` |
| `get_memory` | read | `GET /api/memories/:id` |
| `create_memory` | **write** | `POST /api/memories` |
| `update_memory` | **write** | `PATCH /api/memories/:id` |
| `delete_memory` | **write** | `DELETE /api/memories/:id` |
| `list_life_areas` | read | `GET /api/life-areas` |
| `get_reflection_evidence` | read | `GET /api/reflections/period` |
| `get_review_evidence` | read | `GET /api/reviews/quarter` |
| `get_conversation_context` | read | — |
| `get_agenda` | read | `GET /api/agenda` |
| `create_reminder` | **write** | `POST /api/reminders` |
| `list_reminders` | read | `GET /api/reminders` |
| `update_reminder` | **write** | `PATCH /api/reminders/:id` |
| `delete_reminder` | **write** | `DELETE /api/reminders/:id` |
| `list_jira_boards` | read | — |
| `list_jira_issues` | read | — |
| `get_jira_issue` | read | — |
| `list_jira_users` | read | — |
| `list_confluence_spaces` | read | — |
| `list_confluence_pages` | read | — |
| `get_confluence_page` | read | — |
| `list_confluence_comments` | read | — |
| `react_to_message` | **write** (iMessage) | — |
| `reply_in_thread` | turn state | — |
| `send_message` | **write** (SMS) | — |
| `name_group_chat` | **write** | `PATCH /api/life-areas/:id` |
| `search_store_products` | read (catalog) | — |
| `send_product_cards` | **write** (SMS media) | — |
| `personal_data_search` | read | hosted by Algolia |

`delete_todo`, `delete_memory`, and `delete_reminder` all require `confirmed === true` and throw otherwise.

**Group scope.** When the turn came from an iMessage group chat, `ToolTurnContext.scope` names the group's life area and thread, and every tool above honours it: the by-id reads treat a todo or memory from another area as not found, the lists and `get_agenda` return only the area's rows, `list_life_areas` returns only that area, `get_conversation_context` opens only the group's own thread, `create_*` and `update_*` file under the area whatever `life_area_id` was passed and drop any `category_id`, `get_todo` lists only the subtasks filed in the area and `set_todo_status` never closes a parent filed outside it, `name_group_chat` after the area's first name is honoured only for a message from the owner (`speakerIsOwner`), and `get_reflection_evidence`, `get_review_evidence`, and the eight Atlassian tools are refused. The REST routes have no scope; the owner sees everything from the app. See [`SMS_AND_EVENTS.md`](SMS_AND_EVENTS.md#group-chats).

There is no drift in either direction: every tool in the JSON has a `toolInput` schema, an executor branch, and a UI activity label, and there are no handlers without a tool. `list_memories` is a removed legacy tool that the sync still names so it can be deleted from the published agent config.

## The search tool

`personal_data_search` is `type: algolia_search_index`, which means Algolia executes it. It ships with every new agent, so there was no Algolia API client to write and no search endpoint to build.

It is configured against the three personal-data indices — `devcon_assistant_todos`, `devcon_assistant_memories`, `devcon_assistant_messages` — each with a pinned `userId` filter, an allowlist of retrievable attributes, a facet allowlist, and a per-index description that is what actually steers the model toward the right index. `searchControls` decides which parameters the model may set, which are defaults it can override, and which are hard constraints it cannot. The fourth index, the store catalog, is searched by the `search_store_products` client tool instead (see [Shopping](#shopping)).

Index names come from `ALGOLIA_TODO_INDEX` / `ALGOLIA_MEMORY_INDEX` / `ALGOLIA_MESSAGE_INDEX` at sync time.

## Todos

Statuses are exactly `pending`, `in_progress`, `blocked`, `done`, `cancelled`. Priority is `low`, `normal`, `high`, `urgent`, or null.

`create_todo.subtasks` exists on both the REST route and the agent tool, which create parent and children in one transaction and set each child's `parent_id`. Children inherit the parent's category and life area, and carry their own title, notes, due date, and priority.

One thing the tool records that the route cannot: when `create_todo` runs during an iMessage group-chat turn, it stores the turn's thread in `todos.reply_thread_id` so the todo's reminders are texted back to that group, and files the todo (and any subtasks) under the group's own life area regardless of the `life_area_id` passed. Both are taken from the turn context, not from the tool input, so there is nothing for a caller to set; `POST /api/todos` always leaves `reply_thread_id` null and the reminder goes to the recipient phone. See [`SMS_AND_EVENTS.md`](SMS_AND_EVENTS.md#group-chats).

Two limits differ between the tool schema and the server, and the tighter one wins in practice: the tool JSON caps `list_todos.limit` at 100 (server allows 200) and title length at 200 characters (server allows 300, content 50,000).

### Repeating todos

`create_todo` and `update_todo.patch` accept a `recurrence` object — `freq` (`daily` or `weekly`), `interval`, `weekdays` (Sunday = 0), a local `time` as `HH:MM`, and `lead_minutes` — and `POST /api/todos` and `PATCH /api/todos/:id` take the same shape. Both paths call the same `planRecurrenceWrite()` ([`server/recurrence.ts`](../server/recurrence.ts)): when a rule is set, `due_at` and `reminder_at` are derived from it for the next occurrence and `extra_reminders` is emptied; a request that omits `recurrence`, or sends back the rule already stored, leaves a repeating todo's derived times alone; a rule that differs moves the row to its next occurrence and reopens a `done` or `in_progress` status. Editing the time or weekdays keeps the series' phase (the anchor date); changing `freq` or `interval` starts a new one from the next occurrence. Both paths refuse, with the same `A repeating todo …` message (a 400 on REST and from `POST /api/agent/tools/:name`): a repeating todo with a `parent_id` or `subtasks`, a `parent_id` pointing at a repeating todo, turning a todo that has subtasks into a repeating one, and a non-null `due_at`, `reminder_at`, or `extra_reminders` alongside a rule. The `due` and `pre` reminder rows of a repeating todo are refused by `PATCH`/`DELETE /api/reminders/:id`, `POST /api/reminders` with `slot: "primary"`, and the matching `update_reminder`, `delete_reminder`, and `create_reminder` tools (`isDerivedReminder()`); `escalation` rows are editable. `lead_minutes` is bounded by `maxLeadMinutes()` so the reminder cannot fall before the midnight after the previous occurrence. In the tool dialect a null `recurrence` means unchanged, so stopping a repeat is `clear_fields: ["recurrence"]`, while the REST route reads `recurrence: null` as the same clear. `list_todos.recurring` and `GET /api/todos?recurring=` filter on whether a rule is set.

Completing an occurrence is the ordinary status write on either path, and both call `syncOccurrenceCompletion()` ([`server/todo-status.ts`](../server/todo-status.ts)) to log the occurrence in `todo_completions` and refresh `last_completed_at`. `get_todo` and `GET /api/todos/:id` return `completions`, `completion_count`, and `streak` for a repeating todo; the streak matches completions to occurrences by local day, so it survives a change of time or timezone. Rolling the row on to its next occurrence is the worker's job alone; see [`SMS_AND_EVENTS.md`](SMS_AND_EVENTS.md#repeating-todos).

## Memories

`kind` is exactly `fact`, `note`, or `journal`. `mood_score` is null or an integer 1–5.

`create_memory.title` is a required non-empty string in the tool schema, even though the column, the Zod schema, and `POST /api/memories` all accept null. The narrower tool contract is deliberate: the agent writes a title from the content instead of leaving one out, and the UI keeps the freedom to save an untitled memory.

## Life areas and reflections

- `life_area_id` is shared by todos and memories. The seeded IDs are `area_work`, `area_personal`, `area_side_project`, and **only those three are in the tool schema's enum** — the agent cannot assign a custom life area, though the UI can create them.
- Agent writes set `life_area_source=agent`; UI writes set `user`. An agent update needs `override_user_classification=true` to replace a user-selected area, and throws without it.
- `get_reflection_evidence` and `get_review_evidence` carry the same two-tier evidence as their REST routes, capped at 25 candidate rows per source with `candidate_totals` reporting the real counts. `memories`/`todos` hold only explicitly selected IDs, since selection is a user action and not an agent one, so those arrays are empty until somebody picks something in the UI. `memory_candidates`/`todo_candidates` hold everything in the range, and are the only lists that answer "what did I finish today". Both tools used to strip the candidates, which left an end-of-day check-in reporting an empty day whenever the user had never curated a reflection by hand.
- `review_worthy` is a highlight marker, not an inclusion gate. Saved `reflection-draft` journals and legacy `performance-review` memories are excluded from source evidence.
- The reflection UI routes (`PATCH /api/reflections/selections`, `POST /api/reflections/draft`, `POST /api/reflections/draft/save`) and the life-area CRUD routes have **no** agent tools. Quarterly review routes and `get_review_evidence` remain for compatibility; the old classification-mutating `PATCH /api/reviews/evidence` returns `410`.

## Conversation recall

`personal_data_search` covers the redacted message index for semantic recall across web and SMS. After a hit, `get_conversation_context({ thread_id, message_id, limit })` reads a bounded window of `user` and `assistant` messages from SQLite. Tool traces, provider IDs, phone numbers, and message metadata are never returned.

## Agenda and reminders

The reminder layer projects back onto todo fields: a `primary` reminder is the todo's `reminder_at`, an `extra` reminder is an entry in `extra_reminders`. `list_reminders` returns stable IDs that update and delete accept.

One divergence to know about: **`get_agenda` ignores its `timezone` argument.** It slices ISO dates, while `GET /api/agenda` resolves timezone-aware date keys. Near a day boundary the tool and the UI can disagree about which day something belongs to.

## Strict patch normalization

Agent Studio strict mode requires every declared property to be present on every call, which is at odds with partial updates. So `{ id, patch }` is normalized before it touches SQLite:

1. Drop patch properties whose value is null — in this dialect `null` means "not set", not "clear it".
2. For each name in `patch.clear_fields`, set that nullable column to null.
3. Drop `clear_fields`.
4. Reject an empty normalized patch.

`clear_fields` is transport metadata. It is not a database column and not an indexed attribute.

## Atlassian

The first tools that read outside SQLite. **Nothing here is indexed in Algolia** — every call is a live request, so there is no staleness window and no second copy of a shared work tool's data. All eight are read-only; no comment, transition, or page edit exists anywhere in the codebase. Auth is Basic with one `email:apiToken` credential shared by Jira and Confluence, stored encrypted in SQLite.

Because they run through the same executor as everything else, they are reachable over SMS.

- `list_jira_boards({ name_filter, project_key, include_columns, limit })` → `GET /rest/agile/1.0/board`, and with `include_columns`, `GET /rest/agile/1.0/board/:id/configuration` joined against `GET /rest/api/3/status`. Jira ANDs `name` with `projectKeyOrId`, so the server resolves the overlap first: a `name_filter` that only echoes `project_key` is dropped, and a key-shaped `name_filter` that matched nothing is retried once as a project key.
- `list_jira_issues({ board_id, assignee, project_key, status_ids, text, updated_within_days, limit })` → `GET /rest/software/1.0/board/:id/issue` with `board_id`, otherwise `GET /rest/api/3/search/jql`. `assignee` is `"me"` or an accountId.
- `get_jira_issue({ key, include_recent_changes })` → `GET /rest/api/3/issue/:key`, with `expand=changelog` when recent changes are asked for.
- `list_jira_users({ query, limit })` → `GET /rest/api/3/user/search`
- `list_confluence_spaces({ keys, limit })` → `GET /wiki/api/v2/spaces`
- `list_confluence_pages({ space_keys, text, modified_within_days, mine_only, limit })` → `GET /wiki/rest/api/search` with server-built CQL
- `get_confluence_page({ id })` → `GET /wiki/api/v2/pages/:id` with `body-format=atlas_doc_format`
- `list_confluence_comments({ space_keys, within_days, only_my_pages, limit })` → `GET /wiki/rest/api/search`, twice when `only_my_pages` is set

The client straddles two Jira prefixes on purpose. Eight `/rest/agile/1.0` issue-listing endpoints are removed after 1 Nov 2026, so issue listing is built on `/rest/software/1.0`, while board listing and configuration stay on `/rest/agile/1.0` and are not deprecated.

Four constraints are encoded in the service rather than left to the agent:

1. **JQL and CQL are built server-side.** The model supplies filters, never query text, and every interpolated value is quote- and backslash-escaped. JQL has no `board` field and rejects `username` and `userkey`, so people are always `accountId` — which is why `list_jira_users` exists.
2. **Status categories cannot answer "in review".** The `indeterminate` category can hold many statuses on a real site, so `include_columns` resolves the board's actual columns to explicit status IDs and the agent filters with `status IN (...)`. Status names are not unique across workflows, so filtering is by ID only.
3. **CQL cannot join a comment to its page**, so `only_my_pages` is a two-call fan-in: recent comments expanded with `content.container`, then a `creator = currentUser()` page search restricted to those container IDs, intersected in memory. Two requests regardless of how many pages you own.
4. **`now("-1d")` resolves in the site timezone, not UTC**, so a `within_days` window is re-filtered against the returned ISO timestamps before projection.

`GET /rest/api/3/user/search` returns `200 []` rather than `403` when Browse Users permission is missing, so an empty result is reported as unconfirmed, never as "no such person".

One assumption is still unverified against a real site: that CQL `creator = currentUser()` resolves under Basic auth. It is documented as supported and was confirmed over OAuth, and the deprecation that removed `user`, `user.fullname`, `user.accountid`, and `user.userkey` was scoped to that `user*` family, leaving `creator`, `contributor`, `mention`, and `owner` in place. Confirm it with one request before trusting `mine_only` or `only_my_pages`:

```bash
curl -su "$EMAIL:$API_TOKEN" \
  "https://your-team.atlassian.net/wiki/rest/api/search?cql=type=page%20AND%20creator=currentUser()&limit=1"
```

A `200` with a `results` array means the fan-in works as built. A `400` naming `currentUser` means Basic auth resolves no principal for CQL, and both flags have to pass the accountId from `GET /wiki/rest/api/user/current` explicitly instead.

## iMessage reactions and inline replies

Two tools act on the conversation rather than on the user's records, and so are the only ones that need to know anything about the turn they are running inside. `executeAgentTool()` takes an optional `ToolTurnContext` — the channel, the address, the provider, and the handle of the message that started the turn — which [`server/agent-runner.ts`](../server/agent-runner.ts) builds and the browser route does not have. Both tools refuse with `This turn has no iMessage to act on: …` when the context is missing, on Twilio, on the web channel, or on a turn the app composed itself.

- `react_to_message({ reaction })` → `POST https://api.sendblue.co/api/send-reaction`, targeting the inbound `message_handle`. The value is one of `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`, or exactly one emoji, with a `-` prefix to remove one sent earlier. [`server/schemas.ts`](../server/schemas.ts) checks the shape before the request goes out. Sendblue answers `422` for an SMS or RCS target, one of our own outbound messages, or a line that cannot deliver reactions; the reason reaches the model as a failed tool result so it can answer in words instead. The tool is listed in `WRITE_TOOLS`, so a retried turn sees the reaction it already sent rather than sending a second. A successful reaction also sets `reacted` on the turn context; a turn that reacted and then produced no text is delivered as the reaction alone rather than the fallback sentence (see [`SMS_AND_EVENTS.md`](SMS_AND_EVENTS.md#reactions-and-threads)).
- `reply_in_thread()` sends nothing. It records on the turn context that the answer should be delivered as an inline reply, and [`server/worker.ts`](../server/worker.ts) passes that handle to `sendSms()`, which adds `reply_to` to the send. Sendblue refuses an inline reply outright rather than downgrading it, so `sendSendblueSms()` retries once without `reply_to`: an unthreaded answer beats none.

The runner also places a 🔍 tapback of its own while the turn's working tools run, and lifts it before the reply or before `react_to_message` lands; see [`SMS_AND_EVENTS.md`](SMS_AND_EVENTS.md#reactions-and-threads). It is not a tool and the model is told not to send 🔍 itself.

Two more tools use the same turn context, on any SMS conversation rather than iMessage only:

- `send_message({ text })` texts one bubble now, ahead of the turn's reply, through the turn's `sendSms` (into the group when the turn came from one), files it on the thread as an `assistant` row with `metadata_json.kind = "message"`, and sets `sentText` on the context, so a turn that returns no text afterwards is delivered as its bubbles alone. On the web channel it refuses with `This is not a text conversation; …`. It is in `WRITE_TOOLS`, so a retried turn does not send it twice, and in `GESTURE_TOOLS`, so it does not raise the 🔍.
- `name_group_chat({ name })` renames the group's own life area through `renameLifeArea()` in [`server/db.ts`](../server/db.ts) — the same code path as `PATCH /api/life-areas/:id` — which retitles the thread and queues a rewrite of every indexed record carrying the area's name. It refuses outside a group turn.

Inbound texts carry `reply_to` and `thread_originator` when the user replied inside a thread. The worker reads both onto the turn, they are stored in the inbound row's `metadata_json`, and `threadHistory()` prefixes that turn with a quote of the parent so `"that one"` attaches to the message the user picked rather than the one above it. The stored content and its Algolia projection keep the text the user actually sent.

## Shopping

A DevCon spoiler rather than a product feature: two tools that let "I'm not feeling well, find me something for a headache" end in a short scroll of Walgreens product cards in Messages. **Nothing here buys anything.** There is no cart, checkout, stock check, or Walgreens API; every product link is a `walgreens.com` search URL, and the prompt tells the agent to say so.

The catalog is a checked-in file, [`server/catalog/walgreens-products.json`](../server/catalog/walgreens-products.json): ~30 over-the-counter items across the aisles `pain-fever`, `cold-flu`, `cough-throat`, `allergy`, `stomach`, `sick-day`, and `sleep`, each with symptoms, a price in cents, a product image, and a store link. The images are checked in under [`server/catalog/images/`](../server/catalog/images/) (Wikimedia Commons photos; each entry's `image_source` is the Commons file page for attribution) and `image_url` points at the copy on the public repo's `main` branch via `raw.githubusercontent.com`, because Sendblue fetches the picture with an anonymous library user agent and Wikimedia answers those with 403. A new or changed image only reaches Messages once it is pushed there. `loadStoreCatalog()` in [`server/db.ts`](../server/db.ts) upserts it into the `store_products` table at server start and before every CLI command, keyed by SKU and fingerprinted so an unchanged file queues nothing. Changed or new rows queue a `product` index job; rows dropped from the file are deleted with a `delete` job. The table is reference data, so `resetDatabase()` leaves it alone and `seedDatabase()` re-queues it.

- `search_store_products({ query, category, max_price, limit })` searches the `devcon_assistant_products` index when Algolia is configured (`ALGOLIA_PRODUCT_INDEX` to rename it; settings in [`agent-studio/indices/products.settings.json`](../agent-studio/indices/products.settings.json)) and hydrates the ranked IDs from `store_products`. Without a client, or when Algolia fails, it falls back to an in-process ranking over name, brand, description, category, and symptoms, so a shopping question on stage gets an answer either way. `max_price` is in dollars; the result carries `source: "algolia" | "local"`, the store name, and each product's `price`, `image_url`, and `product_url`.
- `send_product_cards({ product_ids, note })` takes one to three IDs from the search and, on an SMS turn, texts one message per product through `sendSms()` with `mediaUrl` set to the product image and a caption of `Name (size) — $price`, the store link, and a closing `Tap to view at Walgreens` line. The link is deliberately not the last thing in the text: iMessage only renders a rich preview for a URL at the start or end of a message, and walgreens.com answers preview crawlers with a bot challenge that would show up as a "Challenge Validation" bubble under every card. Sends are sequential so the cards land in the agent's order. Each accepted send is filed on the thread as an `assistant` row with `metadata_json.kind = "product_card"`, the `productCard` fields, and `mediaUrl`, before the agent's own reply is written, so the reply's provider handle patches the right row. An optional `note` goes out as a plain text before the cards. A product the catalog no longer holds, or a send Sendblue refuses, lands in `failed: [{ id, error }]` while the rest keep going. On the browser transport, where there is no Messages thread to drop a picture into, it sends nothing and returns the cards with their captions so the agent can describe them.

The worker passes its own `sendSms` into the turn context, so a test that captures the reply captures the cards too. Run `npm run catalog:check` before the demo: it confirms every image file exists locally, requests each image URL with several anonymous library user agents (`axios`, `python-requests`, `node`, `curl`) and fails on anything that is not a 200 with an `image/*` content type for all of them, and probes each product link for hard failures only, since retail sites answer bots with 403 that still resolve for a person tapping the link.

## Digest briefs

A brief is a user-authored standing instruction with its own send time, stored in `digest_briefs` and delivered by `runWorkerOnce`. There are **no agent tools** for briefs; they are UI-managed and agent-composed.

- `GET`, `POST /api/digest-briefs` and `PATCH`, `DELETE /api/digest-briefs/:id` back the settings UI, plus `POST /api/digest-briefs/:id/test`, which composes a brief and returns the drafted text without sending it.
- `resources_json` pins boards and spaces as `[{ type, id, name }]`. At send time the server injects just those, with their resolved column names, as a compact catalog in the turn. This is the `list_life_areas` rule — never guess a custom ID, list them first — applied to Atlassian.
- Delivery reuses the digest gate, so quiet hours and opt-out are enforced for free, and the idempotency key `digest_brief:${briefId}:${localDate}` collapses repeat ticks into one send per brief per local day.

## Result contract

Success is `{ "success": true, "data": { ... } }`.

Failure is `{ "success": false, "error": "<message>" }` — **a plain string, not a structured code object.** Earlier drafts of this document specified codes like `VALIDATION_ERROR`, `AMBIGUOUS_MATCH`, and `INDEX_SYNC_PENDING`; none of them were ever implemented. What the executor does instead is throw messages that `POST /api/agent/tools/:name` maps onto meaningful HTTP statuses, so a retry-hostile failure does not look like a transient one:

| Thrown message matches | Status |
|---|---|
| `/user-classified\|override confirmation\|confirmation is required/` | 409 |
| `/ not found$/` | 404 |
| `/^Unsupported tool: /` | 400 |
| `/^This turn has no iMessage /` | 400 |
| `/ is not configured$/` | 503 |
| `/^Atlassian /` | 502, with the upstream message intact |
| anything else | 500 |

The server-side agent loop wraps a throw as `{ success: false, error: message }` and hands that back to the model, so it can say what went wrong rather than retrying blindly.

After a successful SQLite write the executor queues an index job and schedules a flush. SQLite stays authoritative if the projection is behind.
