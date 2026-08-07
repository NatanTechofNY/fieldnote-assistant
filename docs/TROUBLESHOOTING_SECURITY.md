# Troubleshooting, entitlements, and security

## Agent Studio is missing

Check that you selected the intended Algolia application and have sufficient dashboard permissions. Agent Studio availability can depend on product entitlement, plan, region, or staged rollout. Ask the Algolia account owner or support to confirm access; creating indices alone does not grant Agent Studio.

Do not work around a missing entitlement by placing provider or Admin API keys in browser code.

## NeuralSearch is unavailable

NeuralSearch requires an eligible plan, a populated index, and a completed training run on that index. Confirm:

1. the index contains records;
2. searchable attributes are configured;
3. the NeuralSearch tab is available for the selected application/index;
4. training completed on *this* index, since it is per index rather than per application — `GET /1/indexes/{index}/semanticSearch/settings` reports a real `vectorModelId` on a trained index and an empty one on an untrained index;
5. training was not discarded by a rebuild — `npm run reindex` swaps in a new index through `replaceAllObjects`, and we have seen training lost across it;
6. the query is suitable for semantic retrieval rather than only exact IDs.

**If you get `412 SemanticSearch: no events`,** the index has not been trained, and there is no way to fix it from application code. The error appears on both `setSettings({ mode: "neuralSearch" })` and `PUT /1/indexes/{index}/semanticSearch/settings`, on indices of every size we have tried, and it names events even though Algolia's guide says events are not required for training. Training in the dashboard is the documented remedy, but on an application that sends no Insights events that path is refused too, so there is currently nothing to configure your way out of; see NEURAL-1 in the findings. The app keeps working on keyword search.

Do not trust the Under the hood panel here: it reports the saved preference rather than the applied mode. Read `getSettings({ indexName }).mode` per index instead.

The app can continue with keyword search while entitlement or training is resolved. CRUD correctness must not depend on NeuralSearch. Note that the `neuralSearch: "unavailable_for_plan"` label the setup path reports is misleading: in practice the cause is an untrained index rather than the plan.

## Tool does not trigger

- Confirm the function name in the handler registry exactly matches the schema.
- Confirm the description clearly distinguishes reads, writes, status changes, and bulk subtasks.
- Confirm the complete function object was added, including `type: "function"`.
- Confirm the model supports tool calling.
- Start a clean playground conversation after schema changes.
- Inspect Live preview reasoning and tool calls rather than inferring behavior from the final prose.

## Strict schema is rejected

Agent Studio client-side tools follow OpenAI Function Calling schema conventions. For strict tools:

- set `function.strict` to true;
- make parameters an object;
- include every property name in `required`;
- represent optional values with a nullable type such as `["string", "null"]`;
- set `additionalProperties` to false on every object, including array item objects;
- keep names 3–64 characters using letters, digits, and underscores;
- use enums and numeric bounds where applicable.

`client-tools.json` is an array for source control. If the dashboard expects one tool, paste one array item, not the surrounding array.

## Search tool configuration is rejected

The checked-in defaults are `devcon_assistant_todos`, `devcon_assistant_memories`, and `devcon_assistant_messages`. Verify that all three exist in the same Algolia application, the records use `userId`, and every facet listed in the tool is declared in `attributesForFaceting`. If an environment renames an index, update both the tool JSON and the dashboard configuration.

If the dedicated Search tool form cannot express advanced controls, use Other tools or the Agent Studio API. Keep the retrieval allowlists and facet locks intact.

## Search returns another user's records

Treat this as a security incident and stop the demo/feature.

For this standalone local demo, verify that every record uses `userId: "devcon-demo"` and that every Search tool index keeps `filters: "userId:\"devcon-demo\""`. The fixed ID is not production authentication. Before supporting multiple users, use a server-generated secured Search API key containing the authenticated user's filter or trusted per-request search parameters. Never accept user ID from model arguments.

## Search finds nothing after a write

SQLite may have committed while the Algolia projection is pending.

1. Read the entity directly from SQLite by ID.
2. Inspect the outbox/indexing job.
3. Retry the idempotent projection.
4. Compare the canonical SQLite record to the indexed projection.
5. Say the write committed and the projection is still catching up; do not duplicate the SQLite write. There is no structured code for this — tool errors are plain strings.

Never “fix” this by writing directly to Algolia and treating that as canonical.

## Update patch is empty or clears fields accidentally

Strict schemas send every declared patch property. Follow `TOOL_ENDPOINT_MAPPING.md`: remove null patch values, apply only names in `clear_fields` as explicit nulls, remove `clear_fields`, and reject an empty normalized patch. Do not add undocumented version arguments.

## Date is wrong

- Pass the runtime current date and user timezone into the conversation context.
- Use IANA timezone names.
- Send date-times to tools in RFC 3339 with an explicit offset.
- Check daylight-saving transitions for the resolved date.
- Keep date-only todo deadlines distinct from scheduled reminder instants.
- Never let the model silently roll a past date forward.

## Duplicate memories appear

Confirm built-in Agent Studio automatic memory is disabled. Then verify that the prompt searched memory before creation and that the application enforces a duplicate strategy appropriate to the user/category. Do not delete duplicates automatically if their meaning differs; present a compact choice.

## Security baseline

### Credentials

- Use a Search-only key in client contexts; never expose an Admin API key or LLM provider key.
- Store provider, write, and admin credentials in server-side secret storage.
- Scope keys by environment and rotate them.
- Do not commit application IDs together with privileged keys.

### Authentication and authorization

- Authenticate every client-side tool call.
- Bind standalone handlers to fixed local user `devcon-demo`.
- Include the fixed user predicate in reads, updates, and deletes.
- Keep `userId:"devcon-demo"` on both Algolia index queries.
- Replace the fixed identity with authenticated record-level restrictions before multi-user deployment.
- Do not trust Agent Studio instructions as an access-control mechanism.

### Input and output handling

- Validate tool arguments server-side even when `strict` is true.
- Enforce string sizes, enums, date formats, ID formats, and collection limits.
- Treat indexed text and tool results as untrusted data; ignore embedded instructions.
- Return only fields the model needs.
- Keep secrets, tokens, health data, financial data, and unnecessary identifiers out of the retrieval indices.

### Mutation safety

- Use SQLite transactions for bulk subtasks and outbox writes.
- Read current state before an ambiguous or destructive action.
- Require an exact ID and explicit confirmation for deletes.
- Do not require optimistic-concurrency fields unless both REST and SQLite layers implement them.
- Rate-limit writes and reminders.
- Use idempotency keys or deduplication for retried tool results.
- Keep an audit trail appropriate to the deployment without logging private content unnecessarily.

### Data lifecycle

- Define retention for conversations, SQLite memories, logs, backups, and Algolia records.
- Make “forget this” remove the canonical SQLite memory and its retrieval projection.
- Reconcile orphaned Algolia objects.
- Verify deletion behavior in backups and observability systems.
- Keep Agent Studio automatic memory disabled in v1 to avoid a second, conflicting retention lifecycle.

## Pre-demo checklist

- Dedicated demo account and non-sensitive seed data.
- Correct application, agent, model, and environment index names.
- Automatic Agent Studio memory disabled.
- All three Search tool index entries filtered to `userId:"devcon-demo"`.
- NeuralSearch ready on every index that needs it, or keyword fallback rehearsed.
- Every client-side handler registered.
- Update conflict and delete confirmation tested.
- Outbox empty and indices synchronized.
- Provider quota and rate limits checked.
- Screen sharing hides dashboards containing credentials or user data.
