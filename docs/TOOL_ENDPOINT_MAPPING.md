# Agent tools

## How a tool call actually executes

The agent has **28 tools**: 27 declared `client_side` in [`agent-studio/tools/client-tools.json`](../agent-studio/tools/client-tools.json), plus one hosted search tool declared in [`agent-studio/tools/algolia-search.json`](../agent-studio/tools/algolia-search.json).

Despite the `client_side` type, none of them run in a browser. All 27 resolve to a single function, `executeAgentTool()` in [`server/tool-executor.ts`](../server/tool-executor.ts), which talks to SQLite (or, for Atlassian, straight out to the Atlassian API). Only the transport differs:

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
| `personal_data_search` | read | hosted by Algolia |

`delete_todo`, `delete_memory`, and `delete_reminder` all require `confirmed === true` and throw otherwise.

There is no drift in either direction: every tool in the JSON has a `toolInput` schema, an executor branch, and a UI activity label, and there are no handlers without a tool. `list_memories` is a removed legacy tool that the sync still names so it can be deleted from the published agent config.

## The search tool

`personal_data_search` is `type: algolia_search_index`, which means Algolia executes it. It ships with every new agent, so there was no Algolia API client to write and no search endpoint to build.

It is configured against all three indices — `devcon_assistant_todos`, `devcon_assistant_memories`, `devcon_assistant_messages` — each with a pinned `userId` filter, an allowlist of retrievable attributes, a facet allowlist, and a per-index description that is what actually steers the model toward the right index. `searchControls` decides which parameters the model may set, which are defaults it can override, and which are hard constraints it cannot.

Index names come from `ALGOLIA_TODO_INDEX` / `ALGOLIA_MEMORY_INDEX` / `ALGOLIA_MESSAGE_INDEX` at sync time.

## Todos

Statuses are exactly `pending`, `in_progress`, `blocked`, `done`, `cancelled`. Priority is `low`, `normal`, `high`, `urgent`, or null.

`create_todo.subtasks` exists on both the REST route and the agent tool, which create parent and children in one transaction and set each child's `parent_id`. Children inherit the parent's category and life area, and carry their own title, notes, due date, and priority.

Two limits differ between the tool schema and the server, and the tighter one wins in practice: the tool JSON caps `list_todos.limit` at 100 (server allows 200) and title length at 200 characters (server allows 300, content 50,000).

## Memories

`kind` is exactly `fact`, `note`, or `journal`. `mood_score` is null or an integer 1–5.

`create_memory.title` is a required non-empty string in the tool schema, even though the column, the Zod schema, and `POST /api/memories` all accept null. The narrower tool contract is deliberate: the agent writes a title from the content instead of leaving one out, and the UI keeps the freedom to save an untitled memory.

## Life areas and reflections

- `life_area_id` is shared by todos and memories. The seeded IDs are `area_work`, `area_personal`, `area_side_project`, and **only those three are in the tool schema's enum** — the agent cannot assign a custom life area, though the UI can create them.
- Agent writes set `life_area_source=agent`; UI writes set `user`. An agent update needs `override_user_classification=true` to replace a user-selected area, and throws without it.
- `get_reflection_evidence` deliberately returns **less** than `GET /api/reflections/period`: it strips `memory_candidates` and `todo_candidates`, and its `memories`/`todos` arrays contain only explicitly selected IDs. Selection is a user action, not an agent one.
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
| `/ is not configured$/` | 503 |
| `/^Atlassian /` | 502, with the upstream message intact |
| anything else | 500 |

The server-side agent loop wraps a throw as `{ success: false, error: message }` and hands that back to the model, so it can say what went wrong rather than retrying blindly.

After a successful SQLite write the executor queues an index job and schedules a flush. SQLite stays authoritative if the projection is behind.
