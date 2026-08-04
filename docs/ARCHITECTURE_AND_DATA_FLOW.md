# Architecture and data flow

This describes what the code does today. Where something is a convention the code does not enforce, it says so.

## System boundary

Two data stores with different jobs:

- **SQLite is the source of truth** for todos, subtasks, memories, reminders, channel history, integration cursors, review state, and delivery attempts. Opened with `better-sqlite3` in WAL mode ([`server/db.ts`](../server/db.ts)).
- **Algolia holds denormalized retrieval projections** of a subset of that data, for keyword, semantic, and faceted discovery ([`server/algolia.ts`](../server/algolia.ts)).

Agent Studio handles reasoning and tool selection. It is not a database and never writes one directly.

Because Algolia only ever holds derived projections, dropping an index loses nothing. A full rebuild from SQLite is one call.

## Why SQLite stays authoritative

CRUD needs invariants a retrieval index is not designed to own:

- todo and subtask writes need transactions;
- status transitions and reminder schedules need validation;
- update and delete need ID validation and, for deletes, explicit confirmation;
- deletion and retention need one unambiguous lifecycle;
- application reads have to stay correct during indexing lag or an Algolia outage.

A search hit can be stale, and it is a projection rather than the full record. So the agent may use a hit to find an ID, but the tool that changes something reads the current SQLite row first. That ordering is what makes indexing lag harmless: it can cost a search hit, never a wrong write.

## The single process

Everything runs in one Node process ([`server/index.ts`](../server/index.ts)):

| Piece | Where |
|---|---|
| JSON API and static `dist/` bundle | [`server/app.ts`](../server/app.ts) |
| Twilio and Sendblue webhooks | [`server/routes/webhooks.ts`](../server/routes/webhooks.ts) |
| Outbound message provider selection | [`server/messaging.ts`](../server/messaging.ts) |
| Agent tool endpoint | [`server/routes/agent.ts`](../server/routes/agent.ts) |
| Tool implementations | [`server/tool-executor.ts`](../server/tool-executor.ts) |
| Server-side agent loop (SMS, digests) | [`server/agent-runner.ts`](../server/agent-runner.ts) |
| Background worker, every 60s | [`server/worker.ts`](../server/worker.ts) |
| Algolia projection and reindex | [`server/algolia.ts`](../server/algolia.ts) |

There is no separate indexer, cron service, or queue broker.

## Indices

| Env override | Default name | Contents |
|---|---|---|
| `ALGOLIA_TODO_INDEX` | `devcon_assistant_todos` | todos and subtasks |
| `ALGOLIA_MEMORY_INDEX` | `devcon_assistant_memories` | memories |
| `ALGOLIA_MESSAGE_INDEX` | `devcon_assistant_messages` | web and SMS channel messages |

Settings for all three are version-controlled in [`agent-studio/indices/`](../agent-studio/indices/) and applied by `npm run setup:algolia` or `POST /api/admin/algolia/setup`.

The hosted Agent Studio search tool `personal_data_search` reads all three ([`agent-studio/tools/algolia-search.json`](../agent-studio/tools/algolia-search.json)).

## What is indexed and what is not

**Indexed:** todos, memories, and channel messages. Messages are filtered to `user` and `assistant` roles, and turns marked `metadata.internal` (digest scratch work) are excluded.

**Not indexed, fetched live on every call:** all Jira and Confluence data. The eight Atlassian tools hit the Atlassian REST API through [`server/atlassian-service.ts`](../server/atlassian-service.ts) and return the response to the agent. Nothing is copied into Algolia or SQLite, so there is no staleness window and no second copy of somebody else's data to keep in sync.

**Not indexed until you choose:** Granola meeting notes sit in a review queue and only become searchable if you save one as a memory.

## The agent, two transports, one executor

There are 27 `client_side` tools ([`agent-studio/tools/client-tools.json`](../agent-studio/tools/client-tools.json)) plus the one hosted search tool. Despite the name, every `client_side` tool executes on the server, in `executeAgentTool()`. Only the transport differs:

- **Browser.** The React widget ([`src/features/chat/AgentStudioChat.tsx`](../src/features/chat/AgentStudioChat.tsx)) talks to Agent Studio directly. When Agent Studio asks for a tool, the browser forwards it to `POST /api/agent/tools/:name`, which is session-authenticated and calls `executeAgentTool()`.
- **SMS and scheduled digests.** [`server/agent-runner.ts`](../server/agent-runner.ts) calls the Agent Studio completions API itself and calls `executeAgentTool()` in-process, no HTTP and no session. The loop caps at 8 tool iterations.

Both paths run the same validation, the same SQLite access, and queue the same index jobs. That is why a reminder can send and a text can get answered with no browser open anywhere.

Conversation storage is split for historical reasons: `channel_threads` / `channel_messages` back the agent and SMS (and are what gets indexed), while the older `conversations` / `messages` tables back the deterministic fallback chat at `POST /api/chat` used when Algolia credentials are absent.

### Conversation identity

A thread is keyed on its `address` and lives forever; the `agent_conversation_id` beside it does not. Agent Studio files each turn under that id, titles the conversation from its first message, and never retitles it, so an id that outlives its context window collects weeks of unrelated turns under one stale title. Both channels therefore retire it once the thread has been idle past the 24-hour window a turn is answered against, which keeps one Agent Studio conversation equal to one sitting:

- **SMS and scheduled sends.** `rotateStaleConversation()` in [`server/agent-runner.ts`](../server/agent-runner.ts) checks the newest message on every `getOrCreateThread()` and issues a new `alg_cnv_…` when the thread has gone cold.
- **Browser.** The widget would otherwise invent an id per mount, leaving nothing to correlate against. [`src/features/chat/conversation-id.ts`](../src/features/chat/conversation-id.ts) resolves one from `localStorage` under the same idle rule, passes it as the `Chat` `id` prop, and sends it to `POST /api/conversations/web/sync` as `agentConversationId`.

Note that the id buys observability, not memory: Agent Studio stores the transcript under it but does not replay it, which is why `threadHistory()` resends the window on every turn.

## Write path

Same for a REST call from the UI and a tool call from the agent:

1. Validate the payload with the shared Zod schemas ([`server/schemas.ts`](../server/schemas.ts)). Updates take `{ id, patch }`; deletes require `{ id, confirmed: true }`.
2. Write SQLite scoped to the fixed user. Todo writes wrap the row, its reminder rows, and its index job in one `db.transaction()`.
3. `queueIndexJob(db, entityType, entityId, operation)` inserts into the `index_jobs` outbox, or revives an existing `pending`/`failed` job for the same entity so repeated edits coalesce.
4. `search.flushSoon()` schedules a flush on a microtask.
5. `AlgoliaSync.flush()` claims due jobs, builds the projections, and writes them in batches of up to 1000.
6. The tool returns the canonical record read back out of SQLite.

Algolia is never written first. A failed SQLite write must not be reported as a successful action.

Failed index jobs retry with exponential backoff, `min(3600, 2 ** min(attempts, 10))` seconds. The worker's maintenance pass also flushes anything still pending or failed and prunes finished jobs after seven days, so a flush lost to a crash gets picked up within a minute.

## Read path

For exact current state the agent calls `get_agenda`, `list_todos`, `get_todo`, `list_reminders`, `get_memory`, or `list_life_areas`, and those read SQLite directly.

For fuzzy discovery it calls `personal_data_search`, which Algolia executes against the three indices with a fixed `userId` filter and an allowlist of retrievable attributes. Before any update or delete it re-reads the record from SQLite by ID.

Older conversation recall is a two-step: search the message index semantically, then call `get_conversation_context` with the returned `threadId` and `objectID` to read a bounded window of surrounding messages out of SQLite. Recent context does not need search — the SMS runner loads a 24-hour, 40-message window from SQLite on every turn.

When Algolia is unavailable, `GET /api/search` and `GET /api/conversations/search` fall back to a bounded SQLite `LIKE` scan, and the agent panel serves a small deterministic assistant instead of Agent Studio. Direct CRUD and agenda reads are unaffected.

## Reindexing

`npm run reindex`, or the Reindex button in Settings, which posts to `POST /api/admin/reindex`.

Both call `AlgoliaSync.reindex()`, which for each index reads every row from SQLite and makes a single `replaceAllObjects({ indexName, objects, batchSize: 1000 })` call. Algolia stages the records into a temporary index and swaps it in atomically, so there is no window where the index is half-built, and records deleted from SQLite cannot survive in the index. Any index jobs that were pending beforehand are marked done, since the rebuild supersedes them.

## Consistency model

SQLite is strongly consistent for this app's reads and writes. Algolia is eventually consistent with it.

- `objectID` always equals the SQLite entity ID, so the outbox is idempotent and replayable.
- There is **no** reconciliation job comparing the two. Drift is handled by retrying `index_jobs` and, if needed, a full `replaceAllObjects` rebuild.
- An Algolia outage degrades discovery. It does not break ID-addressed CRUD or agenda reads, and it never makes Algolia authoritative.

## Projections

Todos carry `objectID`, `userId`, `title`, `notes`, `status`, `priority`, `category_id`, `category_name`, `parent_id`, `due_at`, `reminder_at`, `extra_reminders`, `started_at`, `completed_at`, `created_at`, `updated_at`, and the resolved life area (`life_area_id`, `life_area_name`, `life_area_slug`, `life_area_source`). A subtask is a todo whose `parent_id` points at another todo.

Memories carry `objectID`, `userId`, `kind` (exactly `fact`, `note`, or `journal`), `title`, `content`, `mood_label`, `mood_score`, `category_id`, `category_name`, `tags`, `occurred_at`, `review_worthy`, `created_at`, `updated_at`, and the same life-area fields.

Messages carry `objectID`, `userId`, `threadId`, `channel`, `role`, `content`, and `created_at`. Phone numbers, provider message IDs, delivery metadata, tool inputs and results, and the raw `metadata_json` stay in SQLite only.

Secrets and highly sensitive content should not go into a memory at all, and therefore never into an index.

## Ownership enforcement

The model is never trusted to supply a user ID. Every handler binds to `USER_ID`, which is `process.env.DEMO_USER_ID || "devcon-demo"` ([`server/types.ts`](../server/types.ts)).

Every SQLite statement filters on that user alongside the entity ID. `userId` is declared `filterOnly` in the index settings, the checked-in search tool pins `userId:"devcon-demo"`, and `userId` is left out of the retrievable attributes so it never reaches the model. Making this genuinely multi-user means replacing the fixed identity with a server-derived one and moving to secured API keys with record-level filters.

Tool arguments, tool results, and indexed text are all untrusted input. Types and lengths are validated; prompt-like text inside a record is treated as data. Note that **there is no application-level write rate limiting** — the only throttle in the codebase is on failed logins (8 attempts, 15-minute lockout).

## Memory lifecycle

Memories are managed explicitly: search the memory index to discover, read canonical state from SQLite, create only durable and non-sensitive facts, update rather than duplicate, and delete through a confirmed SQLite write that also removes the projection.

Agent Studio's built-in automatic memory is deliberately left off. Running it alongside this lifecycle would mean two stores with different retention and deletion semantics, duplicated retrieval, and no reliable answer to "forget this." This is a choice made in the agent's configuration, not something the server enforces.

## Failure behavior

- **Algolia unavailable.** Use the exact SQLite tools and say that fuzzy discovery is limited. UI search falls back to a SQLite scan.
- **SQLite unavailable.** Do not touch Algolia and do not claim success.
- **Ambiguous match.** The prompt instructs the agent to return compact candidates and ask one focused question. This is prompt guidance, not a structured error code.
- **Partial parent/subtask creation.** `POST /api/todos` is transactional, so this cannot half-apply. The agent's `create_todo` runs the parent and its `subtasks` in that same transaction.

Tool errors are returned as `{ success: false, error: "<message>" }` — a plain string, not a structured code. `INDEX_SYNC_PENDING` and `AMBIGUOUS_MATCH` appear in older drafts of these docs but were never implemented; index job state is exposed only as optional display metadata on message tool traces in the History UI.
