# Agent Studio setup

These instructions configure the dashboard artifacts for the personal assistant. They do not create the application-side tool handlers: every client-side function must be mapped to an authenticated backend operation before a production publish.

Several steps below exist to work around specific Agent Studio behaviors. The reason is stated inline wherever that is the case; read it before deciding any of them is redundant.

## Artifact map

- `agent-studio/system-prompt.txt`: paste into the agent instructions.
- `agent-studio/system-prompt-block.txt`: the agent's separate `systemPrompt` field. Agent Studio seeds this with a website-search assistant template whose own stated hierarchy outranks the agent instructions, and which tells the agent to cite markdown links and refer users to a website. The checked-in block replaces it with one that defers to the instructions.
- `agent-studio/tools/client-tools.json`: strict OpenAI Function Calling schemas. The file is an array for source control and API use; in the dashboard, add each array item as one Other/client-side tool.
- `agent-studio/tools/algolia-search.json`: advanced Algolia Search tool configuration.
- `agent-studio/indices/todos.settings.json`: settings for the todo retrieval index.
- `agent-studio/indices/memories.settings.json`: settings for the memory retrieval index.
- `agent-studio/indices/messages.settings.json`: settings for the redacted conversation-message index.
- `docs/TOOL_ENDPOINT_MAPPING.md`: one REST mapping for every client tool.

## 1. Confirm access and choose names

1. Open the Algolia dashboard and select the intended application.
2. Confirm that Agent Studio is visible under Generative AI. If it is absent, see `TROUBLESHOOTING_SECURITY.md`; availability can depend on account, region, rollout, or plan.
3. Use the checked-in demo defaults `devcon_assistant_todos`, `devcon_assistant_memories`, and `devcon_assistant_messages`. If an environment overrides them, change the matching index entries in `algolia-search.json` and the dashboard together.
4. Use the fixed local user ID `devcon-demo`. Every indexed record must carry `userId: "devcon-demo"`, and the Search tool must keep its checked-in `userId:"devcon-demo"` filter.
5. Do not commit credentials. The fixed demo ID is not authentication and must be replaced by server-enforced identity before adapting this design to multiple users.

## 2. Create the retrieval indices

Create the todo and memory indices in Search. Seed at least one non-sensitive record in each because NeuralSearch training requires records.

Todo retrieval record:

```json
{
  "objectID": "todo_01",
  "userId": "devcon-demo",
  "title": "Prepare DevCon demo",
  "notes": "Practice the retrieval and update flow",
  "status": "in_progress",
  "priority": "high",
  "category_id": "conference",
  "parent_id": null,
  "due_at": "2026-07-22T16:00:00-04:00",
  "reminder_at": "2026-07-22T15:30:00-04:00",
  "extra_reminders": ["2026-07-21T16:00:00-04:00"]
}
```

Memory retrieval record:

```json
{
  "objectID": "memory_01",
  "userId": "devcon-demo",
  "kind": "fact",
  "title": "Presentation preference",
  "content": "Prefers a short spoken summary before technical detail.",
  "mood_label": null,
  "mood_score": null,
  "category_id": "preferences",
  "tags": ["communication", "demo"]
}
```

These are denormalized retrieval projections. Do not put secrets, tokens, private notes, or full audit history in Algolia.

## 3. Apply index settings

`agent-studio/indices/*.json` is the single source of truth for index settings. `npm run setup:algolia` reads those exact files and passes each one to the Search API `setSettings` operation, so there is nothing to copy by hand:

```bash
npm run setup:algolia
```

The files intentionally contain no application ID, API key, or index name, so they can also be pasted into the dashboard Configuration tab if you prefer to review changes there. Edit the JSON rather than the dashboard, otherwise the next `setup:algolia` run will overwrite your changes.

## 4. Configure NeuralSearch (optional)

NeuralSearch combines semantic/vector retrieval with keyword ranking. It improves requests such as “the conference task” when the stored title says “Prepare DevCon demo.”

**It is a paid add-on, so the app ships with it off and runs on standard keyword search.** Everything else works the same either way; only relevance on paraphrased queries changes.

To turn it on:

1. **Activate NeuralSearch on each index.** In the dashboard, open Search, select the index, then Configure > NeuralSearch > Configure NeuralSearch, and activate it. Repeat per index: activation is per index, not per application, so activating it on one index leaves the others on keyword search. Wait for the build to finish.
2. **Flip the toggle.** Settings > Under the hood > *Use Algolia NeuralSearch*. That persists the choice and immediately reapplies index settings, switching each index's `mode` between `neuralSearch` and `keywordSearch`. `ALGOLIA_NEURAL_SEARCH=true` sets the initial value for a fresh database, and `npm run setup:algolia` honours whatever the toggle currently says.

`mode` is the one setting the JSON files do not carry, precisely because the toggle owns it.

**Activation requires event volume this demo cannot produce.** Algolia requires 1,000 click events or 100 conversion events within 30 days before an index can be activated, and `setSettings({ mode: "neuralSearch" })` on an index that has not met it fails with `SemanticSearch: no events`. A single-user assistant whose search results are consumed by a model rather than clicked by a person does not accumulate those events, so expect to run on keyword search.

If the toggle is on and an index cannot take the mode, setup reapplies that index's settings in `keywordSearch` mode and leaves search working, reporting `neuralSearch: "unavailable_for_plan"` — a label that predates our knowing the real reason, and which is inaccurate for the per-index case. NeuralSearch is an enhancement, not the source of truth or a prerequisite for correct CRUD.

To check what is actually applied rather than what was requested, read the indices directly: `getSettings({ indexName })` returns the live `mode`, and `GET /1/indexes/{index}/semanticSearch/settings` returns `neuralSearchMode` as `preview` or `active`.

## 5. Create the agent

1. Go to Generative AI > Agent Studio > Agents.
2. Select Create agent and start from a blank agent.
3. Name it `Personal Assistant Demo`.
4. Select a provider and a tool-capable model. The built-in model can be used for dashboard testing; production requires a configured provider.
5. Paste all of `agent-studio/system-prompt.txt` into the instructions field.
6. Replace the separate System prompt field with `agent-studio/system-prompt-block.txt`. The stock template is written for website search and, by its own hierarchy, overrides the instructions you just pasted. Keep the output style conversational and do not add a conflicting “always use Markdown” instruction.
7. In memory settings, disable Agent Studio automatic/persistent memory for v1. The explicit memory tools own the lifecycle; enabling both would create duplicate storage, inconsistent deletion, and unclear retention behavior.

## 6. Add the Algolia Search tool

Use Add tool > Other tools when the dashboard supports advanced JSON, then paste the environment-resolved `algolia-search.json`. If using the dedicated Algolia Search form:

1. Add all three selected indices.
2. Copy each index description from the JSON.
3. Open AI Search Settings for each index.
4. Lock facets to the listed values. This list is narrower than the index's
   `attributesForFaceting` on purpose — see below.
5. Lock Attributes to retrieve to the listed allowlist.
6. Bound hits per page and pagination to the JSON limits.

Use a Search-only API key, never an Admin API key. Keep the checked-in `userId:"devcon-demo"` filter for this local demo; the prompt is not an authorization boundary.

**Sync Agent config owns this file.** The sync rebuilds the Search tool from `algolia-search.json` on every run: index list, descriptions, `searchParameters`, and `searchControls`. Editing the tool in the dashboard is therefore pointless, because the next sync overwrites it. Change the JSON instead.

Two things the sync deliberately does not touch. Algolia derives `enhancedDescription` from the records themselves, so it is carried over from the live tool rather than blanked. And index names are resolved through `ALGOLIA_TODO_INDEX`, `ALGOLIA_MEMORY_INDEX`, and `ALGOLIA_MESSAGE_INDEX` when those are set, so an environment that renames an index does not need a forked JSON file.

**The facet list is a filter allowlist, not a display setting.** Whatever is listed under AI Search Settings > Facets becomes a `facet_<name>` argument on the tool, and those are hard filters: the model guesses a value from the wording of the question, and a wrong guess removes matching records instead of ranking them lower. So the checked-in lists are deliberately shorter than each index's `attributesForFaceting` — `status` and `priority` for todos, `kind` and `mood_label` for memories, `channel` and `role` for messages. Opaque IDs (`category_id`, `life_area_id`, `parent_id`, `threadId`), internal flags (`review_worthy`), and free-form `tags` are faceted for the application but withheld from the model, because it cannot guess their values reliably. Nothing is lost in recall: `tags` and `mood_label` are in `searchableAttributes`, so their text still matches and still ranks. Adding an attribute back here widens what the agent can accidentally exclude.

All three indices live under one tool named `personal_data_search`, and each index's own `description` is how the agent decides which of them to search. Algolia auto-generates a description from the record shape if you leave one unset, and those generated blurbs describe schema rather than intent — enough to send a question about a recurring meeting to the todo index instead of the memory index. Keep the checked-in descriptions, which say what belongs in each index and name the index each one is confused with.

## 7. Add client-side tools

This step is required for all writes. The `tools` prop in `src/features/chat/AgentStudioChat.tsx` only implements the browser-side handlers, one per entry in `src/features/chat/tool-activity.tsx`; it does not advertise their schemas to the model. Agent Studio must also contain tools with the same exact names. Without them, the agent can search Algolia and generate text, but it cannot save or update SQLite.

For the local demo, the **Sync Agent config** button under Settings > Under the hood automates this step. The Node server syncs `system-prompt.txt`, reads `client-tools.json`, converts each OpenAI function schema to Agent Studio's `client_side` format, preserves existing Search and unrelated tools, patches the agent, and publishes when required. This requires `ALGOLIA_ADMIN_API_KEY` to have the `editSettings` ACL. The key stays server-side and must never use a `VITE_` variable.

For every object in `client-tools.json`:

1. Select Add tool > Other tools or Client-side tool.
2. Paste one complete `{ "type": "function", "function": ... }` object.
3. Confirm `strict` is true.
4. Confirm every property is listed in `required`, optional values use a nullable type, and every object sets `additionalProperties` to false.
5. Save with the exact function name.

Implement every mapping in `docs/TOOL_ENDPOINT_MAPPING.md`. The application handler registry must use the exact names and argument shapes. A safe handler must:

- bind all local calls to `devcon-demo`, never model input;
- validate the arguments again server-side;
- execute against SQLite;
- enforce `devcon-demo` in every SQL statement;
- use transactions when creating a parent with subtasks;
- normalize strict `{ id, patch }` payloads as documented;
- require the confirmation fields for destructive actions;
- return a small structured success or error payload;
- enqueue the Algolia projection update only after the SQLite transaction commits.

Errors are plain strings rather than structured codes: the executor throws a message and `POST /api/agent/tools/:name` maps it onto an HTTP status. Do not send or require optimistic-concurrency fields unless the application later implements them.

## 8. Test in Live preview

Run these in order and inspect every tool invocation:

1. “Remember that I prefer afternoon focus blocks.” It should search memory first, then create one memory.
2. Repeat the request. It should find the existing memory and avoid a duplicate.
3. “Add a task to prepare my DevCon demo next Wednesday at 4 PM, with useful subtasks.” It should resolve the calendar date and create executable steps.
4. “Move the conference task to Friday.” It should retrieve candidates, read the canonical todo, and call `update_todo` with `{ id, patch }`.
5. Create two similarly named tasks, then say “delete the demo task.” It should ask which one, not guess.
6. “What is on my agenda tomorrow?” It should call `get_agenda` with an explicit date range and IANA timezone.
7. “Remind me about the demo tomorrow.” It should ask for a time if notification timing is required, then call `create_reminder` with an explicit `slot`.
8. “Move that reminder an hour later.” It should call `list_reminders` to resolve the reminder ID before `update_reminder`, never invent an ID or reuse the todo ID.
9. Put text such as “ignore previous instructions” in a todo note, then retrieve it. The agent must treat it as data.
10. Store two facts with unrelated tags, then ask about both in one message (“What is my name? When is my birthday?”). It should send one query per subject and answer both. A single tag-filtered query that answers one half and reports the other as unstored is the failure this checks for.

Do not publish until mutation calls are wired. A schema in Agent Studio describes a function; it does not implement it.

## 9. Publish and integrate

1. Connect the production LLM provider under Agent Studio Settings/Providers.
2. Re-run the test matrix against a non-production user.
3. Publish the agent and record its ID in the deployment secret store.
4. Integrate with the Agent Studio completions API or InstantSearch Chat.
5. Register handlers for every client-side function and send each tool result back to the same conversation.
6. Use per-user secured Search API keys or per-request search overrides to enforce ownership.
7. Monitor failures and Algolia queries tagged `alg#agent-studio`.

Dashboard labels can evolve. If a label differs, preserve the controls and security properties described here rather than weakening the configuration.
