import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import request from "supertest";
import { syncAgentStudioTools } from "../server/agent-studio.ts";
import { runSmsAgent } from "../server/agent-runner.ts";
import { AlgoliaSync } from "../server/algolia.ts";
import { createApp } from "../server/app.ts";
import { resetThrottling } from "../server/auth.ts";
import { getTodo, openDatabase, queueIndexJob, USER_ID } from "../server/db.ts";
import { currentFiscalQuarter, fiscalQuarterRange } from "../server/fiscal-quarter.ts";
import { reflectionPeriod } from "../server/reflection-period.ts";
import {
  getNotificationPreferences,
  getSearchPreferences,
  getSendblueSecret,
  getTwilioSecret,
  saveGranolaConfig,
  saveNotificationPreferences,
  saveSearchPreferences,
  saveSendblueConfig,
  saveTwilioConfig,
  setSmsProvider,
} from "../server/integrations.ts";
import { enqueueExternalEvent } from "../server/event-ingestion.ts";
import { toolInput } from "../server/schemas.ts";
import { startSendblueTypingIndicator } from "../server/sendblue-service.ts";
import { runWorkerOnce, startWorker } from "../server/worker.ts";
import type { Db } from "../server/types.ts";

process.env.SETTINGS_ENCRYPTION_KEY = "test-only-encryption-key";
process.env.TWILIO_SKIP_SIGNATURE_VALIDATION = "true";
process.env.NODE_ENV = "test";

const databases: Db[] = [];

function fakeSearch(db: Db) {
  const setupCalls: Array<"neural" | "keyword"> = [];
  return {
    setupCalls,
    /**
     * Left off by default so every route falls through to SQLite, which is what
     * an unconfigured demo does. Search tests assign these per case.
     */
    searchAll: undefined as AlgoliaSync["searchAll"] | undefined,
    searchMemories: undefined as AlgoliaSync["searchMemories"] | undefined,
    flushSoon() {},
    async flush() {
      return { configured: false, processed: 0, succeeded: 0, failed: 0 };
    },
    async reindex() {
      return { queued: 0, processed: 0 };
    },
    neuralSearchEnabled() {
      return getSearchPreferences(db).neuralSearchEnabled;
    },
    async setup() {
      setupCalls.push(this.neuralSearchEnabled() ? "neural" : "keyword");
      return { configured: false, details: { reason: "test" } };
    },
    async health() {
      return { ok: true, configured: false };
    },
  };
}

function fixture(
  agentStudio?: NonNullable<Parameters<typeof createApp>[0]>["agentStudio"],
  draftWithAgent?: NonNullable<Parameters<typeof createApp>[0]>["draftWithAgent"],
) {
  const db = openDatabase(":memory:");
  databases.push(db);
  const search = fakeSearch(db);
  return { db, search, api: request(createApp({ db, search, agentStudio, draftWithAgent }).app) };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

/**
 * A started worker defers its wake and then ticks through several awaits, none
 * of which are observable from the outside. Yielding the event loop a few times
 * lets one settle without pinning the test to a real interval.
 */
async function drainTicks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

/** Local days and quiet hours are read off the wall clock, so pin it. */
function atUtcTime(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const pinned = new Date(Date.UTC(2030, 0, 15, hour, minute));
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length ? args : [pinned.getTime()] as ConstructorParameters<typeof Date>));
    }
    static now() { return pinned.getTime(); }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  return () => { globalThis.Date = RealDate; };
}

describe("frontend API contract", () => {
  it("wraps responses and returns the Health contract", async () => {
    const { api } = fixture();
    const health = await api.get("/api/health").expect(200);
    assert.equal(health.body.success, true);
    assert.deepEqual(health.body.data, {
      sqlite: { ok: true, records: 0 },
      algolia: { ok: true, configured: false },
      agentStudio: { configured: false },
      auth: { enabled: false },
      neuralSearch: { enabled: false },
      indices: {
        todos: "devcon_assistant_todos",
        memories: "devcon_assistant_memories",
        messages: "devcon_assistant_messages",
      },
      pendingIndexJobs: 0,
    });
    const missing = await api.get("/api/not-real").expect(404);
    assert.deepEqual(missing.body, { success: false, error: "Route not found" });
    const invalid = await api.post("/api/todos").send({ title: "", priority: 4 }).expect(400);
    assert.equal(invalid.body.success, false);
    assert.equal(typeof invalid.body.error, "string");
  });

  it("returns complete Overview and category contracts", async () => {
    const { api } = fixture();
    await api.post("/api/admin/seed").send({}).expect(400);
    assert.deepEqual((await api.post("/api/admin/seed").send({ confirmation: "SEED" }).expect(200)).body, {
      success: true,
      data: { seeded: true },
    });
    const overview = (await api.get("/api/overview").expect(200)).body.data;
    assert.deepEqual(overview.counts, {
      pending: 1,
      in_progress: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
      active: 1,
      memories: 1,
    });
    for (const key of [
      "in_progress", "blocked", "due_today", "recent_memories",
      "upcoming_reminders", "mood_trend", "subtask_progress",
    ]) assert.ok(key in overview);
    const categories = (await api.get("/api/categories").expect(200)).body.data;
    assert.ok(categories.length >= 3);
    assert.deepEqual(Object.keys(categories[0]).sort(), ["color", "icon", "id", "kind", "name"]);
  });

  it("syncs and publishes Agent Studio client tools through the local admin API", async () => {
    let calls = 0;
    const { api } = fixture({
      async syncTools() {
        calls += 1;
        return {
          agentId: "agent_test",
          clientTools: 15,
          preservedTools: 1,
          searchIndices: 3,
          published: true,
        };
      },
    });
    const response = await api.post("/api/admin/agent-studio/sync-tools").expect(200);
    assert.equal(calls, 1);
    assert.deepEqual(response.body.data, {
      agentId: "agent_test",
      clientTools: 15,
      preservedTools: 1,
      searchIndices: 3,
      published: true,
    });
  });

  it("implements snake_case todo CRUD, priorities, detail, and includeDone", async () => {
    const { db, api } = fixture();
    await api.post("/api/admin/seed").send({ confirmation: "SEED" }).expect(200);
    const created = (await api.post("/api/todos").send({
      title: "Ship frontend contract",
      notes: "Keep snake_case",
      parent_id: "todo_welcome",
      due_at: "2026-08-01T12:00:00.000Z",
      reminder_at: "2026-07-31T12:00:00.000Z",
      extra_reminders: ["2026-07-30T12:00:00.000Z"],
      priority: "urgent",
      status: "in_progress",
    }).expect(201)).body.data;
    assert.equal(created.notes, "Keep snake_case");
    assert.equal(created.parent_id, "todo_welcome");
    assert.equal(created.priority, "urgent");
    assert.equal(created.status, "in_progress");
    assert.deepEqual(created.extra_reminders, ["2026-07-30T12:00:00.000Z"]);
    assert.equal(typeof created.started_at, "string");
    assert.equal((db.prepare("SELECT count(*) count FROM reminders WHERE todo_id=?")
      .get(created.id) as { count: number }).count, 3);

    const detail = (await api.get("/api/todos/todo_welcome").expect(200)).body.data;
    assert.equal(detail.todo.id, "todo_welcome");
    assert.ok(detail.subtasks.some((todo: { id: string }) => todo.id === created.id));
    assert.ok(Array.isArray(detail.reminders));

    const completed = (await api.patch(`/api/todos/${created.id}/status`)
      .send({ status: "done" }).expect(200)).body.data;
    assert.equal(typeof completed.completed_at, "string");
    const active = (await api.get("/api/todos?includeDone=false").expect(200)).body.data;
    assert.ok(!active.some((todo: { id: string }) => todo.id === created.id));
    const all = (await api.get("/api/todos?includeDone=true").expect(200)).body.data;
    assert.ok(all.some((todo: { id: string }) => todo.id === created.id));
    assert.deepEqual((await api.delete(`/api/todos/${created.id}`).expect(200)).body, {
      success: true,
      data: { id: created.id },
    });
  });

  it("stores memory mood and tags and filters with query", async () => {
    const { api } = fixture();
    const created = (await api.post("/api/memories").send({
      title: "Conference",
      content: "Algolia developer conference notes",
      kind: "journal",
      mood_label: "energized",
      mood_score: 5,
      tags: ["algolia", "devcon"],
    }).expect(201)).body.data;
    assert.equal(created.mood_label, "energized");
    assert.equal(created.mood_score, 5);
    assert.deepEqual(created.tags, ["algolia", "devcon"]);
    const results = (await api.get("/api/memories?kind=journal&query=conference").expect(200)).body.data;
    assert.equal(results.source, "sqlite");
    assert.equal(results.memories.length, 1);
    const updated = (await api.patch(`/api/memories/${created.id}`)
      .send({ mood_score: 4, tags: ["updated"] }).expect(200)).body.data;
    assert.equal(updated.mood_score, 4);
    assert.deepEqual(updated.tags, ["updated"]);
    assert.deepEqual((await api.delete(`/api/memories/${created.id}`).expect(200)).body.data, {
      id: created.id,
    });
  });

  it("returns canonical reminders without marking browser previews as delivered", async () => {
    const { api } = fixture();
    const todo = (await api.post("/api/todos").send({
      title: "Already due",
      due_at: "2020-01-01T00:00:00.000Z",
      reminder_at: "2020-01-01T01:00:00.000Z",
    }).expect(201)).body.data;
    const reminders = (await api.get("/api/reminders").expect(200)).body.data;
    assert.equal(reminders[0].todo_id, todo.id);
    assert.equal(reminders[0].todo_title, "Already due");
    assert.deepEqual(
      Object.keys(reminders[0]).sort(),
      ["id", "kind", "scheduled_for", "status", "todo_id", "todo_title"].sort(),
    );
    assert.equal((await api.get("/api/reminders/due").expect(200)).body.data.length, 2);
    assert.equal((await api.get("/api/reminders/due").expect(200)).body.data.length, 2);
    assert.deepEqual(
      (await api.get("/api/overview").expect(200)).body.data.upcoming_reminders,
      [],
      "Next reminders looks forward; a row whose time has passed does not squat at the top",
    );
  });

  it("keeps the reminder as well as the due date when the two name the same instant", async () => {
    const { api } = fixture();
    const at = "2030-01-01T21:00:00.000Z";
    await api.post("/api/todos").send({
      title: "One notification",
      due_at: at,
      reminder_at: "2030-01-01T21:00:00+00:00",
    }).expect(201);
    const reminders = (await api.get("/api/reminders").expect(200)).body.data;
    assert.deepEqual(
      reminders.map((reminder: { kind: string; scheduled_for: string }) => [reminder.kind, reminder.scheduled_for]),
      [["due", at], ["pre", at]],
      "the deliverable row has to survive sharing a moment with the due date",
    );
  });

  it("offers one local reminder per moment even when a due date shares it", async () => {
    const { api } = fixture();
    await api.post("/api/todos").send({
      title: "One notification",
      due_at: "2020-01-01T21:00:00.000Z",
      reminder_at: "2020-01-01T21:00:00+00:00",
    }).expect(201);
    const due = (await api.get("/api/reminders/due").expect(200)).body.data;
    assert.equal(due.length, 1, "dismissing the toast must not summon its twin");
  });

  it("keeps a task in Due today until midnight in the user's own timezone", async () => {
    const { db, api } = fixture();
    saveNotificationPreferences(db, {
      smsEnabled: false,
      recipientPhone: null,
      timezone: "America/New_York",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    // 22:00 on January 15 in New York, which UTC already calls the 16th.
    await api.post("/api/todos")
      .send({ title: "Tonight", due_at: "2030-01-16T03:00:00.000Z" }).expect(201);
    const restore = atUtcTime("23:00");
    try {
      const overview = (await api.get("/api/overview").expect(200)).body.data;
      assert.deepEqual(
        (overview.due_today as Array<{ title: string }>).map(todo => todo.title),
        ["Tonight"],
      );
    } finally { restore(); }
  });

  it("drops a task out of Due today once it is finished", async () => {
    const { api } = fixture();
    const due = new Date().toISOString();
    const finished = (await api.post("/api/todos").send({ title: "Filed the report", due_at: due }).expect(201)).body.data;
    await api.post("/api/todos").send({ title: "Still owed", due_at: due }).expect(201);
    await api.patch(`/api/todos/${finished.id}/status`).send({ status: "done" }).expect(200);

    const overview = (await api.get("/api/overview").expect(200)).body.data;
    assert.deepEqual(
      (overview.due_today as Array<{ title: string }>).map(todo => todo.title),
      ["Still owed"],
      "the day's list is what it still owes, not what it was owed this morning",
    );
    assert.equal(overview.counts.done, 1, "the finished task is still counted");
  });

  it("persists deterministic user, tool, and assistant chat messages", async () => {
    const { db, api } = fixture();
    const chat = (await api.post("/api/chat").send({
      content: "create todo: Prepare demo",
    }).expect(200)).body.data;
    assert.equal(chat.action, "create_todo");
    assert.deepEqual(chat.messages.slice(-3).map((message: { role: string }) => message.role),
      ["user", "tool", "assistant"]);
    assert.equal(chat.messages.at(-2).tool_name, "create_todo");
    assert.deepEqual(chat.messages.at(-2).tool_args, { title: "Prepare demo" });
    assert.equal((await api.get("/api/conversations/current/messages").expect(200)).body.data.length, 3);
    assert.equal((db.prepare("SELECT count(*) count FROM todos").get() as { count: number }).count, 1);
  });

  /*
   * The column used to hold the thread key, a value Agent Studio has never seen,
   * so nothing in the archive could be traced to a conversation on Algolia's
   * side. The browser owns that id because the chat widget is what sends it.
   */
  it("records the Agent Studio conversation the browser filed a sitting under", async () => {
    const { db, api } = fixture();
    const message = (text: string) => ({ id: `web_${text}`, role: "user" as const, parts: [{ type: "text", text }] });
    const stored = () => (db.prepare(`
      SELECT agent_conversation_id FROM channel_threads WHERE channel='web'
    `).get() as { agent_conversation_id: string }).agent_conversation_id;

    await api.post("/api/conversations/web/sync")
      .send({ conversationId: "browser-agent", agentConversationId: "alg_cnv_first", messages: [message("one")] })
      .expect(200);
    assert.equal(stored(), "alg_cnv_first");

    // A later sitting rotates the Agent Studio conversation, but the archive
    // thread is keyed on `conversationId` and stays one continuous timeline.
    await api.post("/api/conversations/web/sync")
      .send({ conversationId: "browser-agent", agentConversationId: "alg_cnv_second", messages: [message("two")] })
      .expect(200);
    assert.equal(stored(), "alg_cnv_second");
    const threads = (await api.get("/api/conversations/channels").expect(200)).body.data;
    assert.equal(threads.length, 1, "rotating the conversation does not fork the archive");
    assert.equal(threads[0].messageCount, 2);

    // An older client that sends no id must not overwrite a real one with the key.
    await api.post("/api/conversations/web/sync")
      .send({ conversationId: "browser-agent", messages: [message("three")] })
      .expect(200);
    assert.equal(stored(), "alg_cnv_second");
  });

  it("archives complete web channel history and exposes conversation threads", async () => {
    const { db, api } = fixture();
    const todo = (await api.post("/api/todos").send({ title: "Indexed archive task" }).expect(201)).body.data;
    const payload = {
      conversationId: "browser-agent",
      messages: [
        { id: "web_user_1", role: "user", parts: [{ type: "text", text: "What is due?" }] },
        { id: "web_assistant_1", role: "assistant", parts: [
          { type: "text", text: "Nothing is due." },
          {
            type: "tool-create_todo",
            state: "output-available",
            input: { title: "Indexed archive task" },
            output: { success: true, data: todo },
          },
        ] },
      ],
    };
    await api.post("/api/conversations/web/sync").send(payload).expect(200);
    await api.post("/api/conversations/web/sync").send(payload).expect(200);
    const threads = (await api.get("/api/conversations/channels").expect(200)).body.data;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].channel, "web");
    assert.equal(threads[0].messageCount, 2);
    const messages = (await api.get(`/api/conversations/channels/${threads[0].id}/messages`).expect(200)).body.data;
    assert.deepEqual(messages.map((message: { content: string }) => message.content), [
      "What is due?",
      "Nothing is due.",
    ]);
    const indexing = messages[1].metadata.parts[1].indexing;
    assert.equal(indexing.destination, "Algolia");
    assert.equal(indexing.entityType, "todo");
    assert.equal(indexing.operation, "upsert");
    assert.equal(indexing.status, "pending");
    assert.equal(indexing.lastError, null);
    assert.match(indexing.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((db.prepare(`
      SELECT count(*) count FROM index_jobs WHERE entity_type='channel_message'
    `).get() as { count: number }).count, 2);
    const stored = db.prepare(`
      SELECT id FROM channel_messages WHERE thread_id=? AND role='assistant'
    `).get(threads[0].id) as { id: string };
    const projection = new AlgoliaSync(db, { client: null }).projection("channel_message", stored.id);
    assert.deepEqual(projection, {
      objectID: stored.id,
      userId: USER_ID,
      threadId: threads[0].id,
      channel: "web",
      role: "assistant",
      content: "Nothing is due.",
      created_at: messages[1].createdAt,
    });
    assert.equal("metadata_json" in (projection || {}), false);
    assert.equal("provider_message_id" in (projection || {}), false);
    const search = (await api.get("/api/conversations/search?q=due").expect(200)).body.data;
    assert.equal(search.source, "sqlite");
    assert.equal(search.hits.length, 2);
    const context = (await api.post("/api/agent/tools/get_conversation_context").send({
      thread_id: threads[0].id,
      message_id: stored.id,
      limit: 10,
    }).expect(200)).body.data;
    assert.deepEqual(context.messages.map((message: { content: string }) => message.content), [
      "What is due?",
      "Nothing is due.",
    ]);
  });

  it("keeps app-composed turns out of the conversation index", async () => {
    const { db, api } = fixture();
    await api.post("/api/conversations/web/sync").send({
      conversationId: "browser-agent",
      messages: [{ id: "web_user_1", role: "user", parts: [{ type: "text", text: "What is due?" }] }],
    }).expect(200);
    const stored = db.prepare("SELECT id FROM channel_messages").get() as { id: string };
    const search = new AlgoliaSync(db, { client: null });
    assert.ok(search.projection("channel_message", stored.id), "a turn the user typed is indexable");
    const before = search.queueReindex();

    // Digest and reflection prompts are written by the app, so recall must not be
    // able to quote one back as something the user said.
    db.prepare("UPDATE channel_messages SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({ internal: true }), stored.id);
    assert.equal(
      search.projection("channel_message", stored.id),
      null,
      "a null projection deletes on the next flush and drops out of a rebuild",
    );
    assert.equal(search.queueReindex(), before - 1, "and it stops being counted as indexable");
  });

  it("supports atomic subtasks, agenda filters, and reminder mutation tools", async () => {
    const { api } = fixture();
    const tomorrow = new Date(Date.now() + 86_400_000);
    const later = new Date(Date.now() + 90_000_000);
    const next = new Date(Date.now() + 93_600_000);
    const parent = (await api.post("/api/todos").send({
      title: "Prepare talk",
      due_at: tomorrow.toISOString(),
      subtasks: [
        { title: "Rehearse", notes: null, priority: "high", due_at: later.toISOString() },
        { title: "Reset data", notes: null, priority: "normal", due_at: null },
      ],
    }).expect(201)).body.data;
    const detail = (await api.get(`/api/todos/${parent.id}`).expect(200)).body.data;
    assert.equal(detail.subtasks.length, 2);
    assert.ok(detail.subtasks.every((todo: { parent_id: string }) => todo.parent_id === parent.id));

    const createdReminder = (await api.post("/api/reminders").send({
      todo_id: parent.id,
      reminder_at: later.toISOString(),
      slot: "primary",
    }).expect(201)).body.data;
    assert.equal(createdReminder.todo_id, parent.id);
    const movedReminder = (await api.patch(`/api/reminders/${createdReminder.id}`).send({
      reminder_at: next.toISOString(),
    }).expect(200)).body.data;
    assert.equal(movedReminder.scheduled_for, next.toISOString());

    const date = tomorrow.toISOString().slice(0, 10);
    const agenda = (await api.get(`/api/agenda?start_date=${date}&end_date=${date}&timezone=UTC`).expect(200)).body.data;
    assert.ok(agenda.todos.some((todo: { id: string }) => todo.id === parent.id));
    await api.delete(`/api/reminders/${movedReminder.id}`).expect(200);
  });

  it("classifies todos and memories with shared life areas", async () => {
    const { api } = fixture();
    const areas = (await api.get("/api/life-areas").expect(200)).body.data;
    assert.deepEqual(areas.map((area: { slug: string }) => area.slug), ["work", "personal", "side-project"]);
    const todo = (await api.post("/api/todos").send({
      title: "Prepare launch review",
      life_area_id: "area_work",
      life_area_source: "user",
    }).expect(201)).body.data;
    assert.equal(todo.life_area_name, "Work");
    assert.equal(todo.life_area_source, "user");
    const memory = (await api.post("/api/memories").send({
      title: "Launch result",
      content: "Improved activation.",
      kind: "note",
      life_area_id: "area_work",
      life_area_source: "user",
      occurred_at: "2026-06-15T12:00:00.000Z",
      review_worthy: true,
      tags: ["brag"],
    }).expect(201)).body.data;
    assert.equal(memory.review_worthy, true);
    assert.equal(memory.life_area_slug, "work");
    assert.equal((await api.get("/api/memories?life_area_id=area_work&review_worthy=true").expect(200)).body.data.memories.length, 1);
    assert.equal((await api.get("/api/todos?life_area_id=area_work").expect(200)).body.data.length, 1);
  });

  it("manages custom life areas without allowing default deletion", async () => {
    const { api } = fixture();
    const custom = (await api.post("/api/life-areas").send({
      name: "Open Source",
      color: "#2563eb",
    }).expect(201)).body.data;
    assert.equal(custom.slug, "open-source");
    const memory = (await api.post("/api/memories").send({
      content: "Maintained a library",
      kind: "note",
      life_area_id: custom.id,
      life_area_source: "user",
      tags: [],
    }).expect(201)).body.data;
    await api.delete(`/api/life-areas/${custom.id}`).expect(200);
    assert.equal((await api.get(`/api/memories/${memory.id}`).expect(200)).body.data.life_area_id, null);
    await api.delete("/api/life-areas/area_work").expect(409);
  });

  it("protects a user-selected life area from implicit Agent replacement", async () => {
    const { api } = fixture();
    const memory = (await api.post("/api/memories").send({
      content: "Private appointment",
      kind: "note",
      life_area_id: "area_personal",
      life_area_source: "user",
      tags: [],
    }).expect(201)).body.data;
    await api.post("/api/agent/tools/update_memory").send({
      id: memory.id,
      patch: { life_area_id: "area_work" },
      override_user_classification: false,
    }).expect(409);
    const unchanged = (await api.get(`/api/memories/${memory.id}`).expect(200)).body.data;
    assert.equal(unchanged.life_area_id, "area_personal");
  });

  it("builds and persists a grounded quarterly review draft", async () => {
    let prompt = "";
    const { api } = fixture(undefined, async (value) => {
      prompt = value;
      return "## Impact\n- Shipped launch improvements (Launch result)";
    });
    await api.post("/api/memories").send({
      title: "Launch result",
      content: "Improved activation.",
      kind: "note",
      life_area_id: "area_work",
      life_area_source: "user",
      occurred_at: "2026-06-15T12:00:00.000Z",
      review_worthy: true,
      tags: ["brag"],
    }).expect(201);
    await api.post("/api/todos").send({
      title: "Ship onboarding",
      status: "done",
      completed_at: "2026-06-20T12:00:00.000Z",
      life_area_id: "area_work",
      life_area_source: "user",
    }).expect(201);
    const evidence = (await api.get("/api/reviews/quarter?year=2026&quarter=2").expect(200)).body.data;
    assert.equal(evidence.memories.length, 1);
    assert.equal(evidence.todos.length, 1);
    assert.equal(evidence.range.startDate, "2026-05-01");
    assert.equal(evidence.range.endDate, "2026-07-31");
    const drafted = (await api.post("/api/reviews/draft").send({
      year: 2026,
      quarter: 2,
      exclude_memory_ids: [],
      exclude_todo_ids: [],
    }).expect(200)).body.data;
    assert.match(prompt, /get_review_evidence/);
    assert.match(drafted.draft.content, /Shipped launch improvements/);
    const after = (await api.get("/api/reviews/quarter?year=2026&quarter=2").expect(200)).body.data;
    assert.equal(after.memories.length, 1, "saved review drafts must not become source evidence");
  });

  it("filters flexible reflection evidence and keeps scoped exclusions non-destructive", async () => {
    const { api, db } = fixture();
    const category = (await api.post("/api/categories").send({
      kind: "memory", name: "Projects", color: "#123456",
    }).expect(201)).body.data;
    const memory = (await api.post("/api/memories").send({
      title: "Ordinary work note",
      content: "A useful detail that was not marked as a standout win.",
      kind: "note",
      life_area_id: "area_work",
      life_area_source: "user",
      category_id: category.id,
      occurred_at: "2026-06-15T12:00:00.000Z",
      review_worthy: false,
      tags: [],
    }).expect(201)).body.data;
    await api.post("/api/memories").send({
      title: "Personal note",
      content: "A meaningful personal moment.",
      kind: "note",
      life_area_id: "area_personal",
      life_area_source: "user",
      occurred_at: "2026-06-16T12:00:00.000Z",
      tags: [],
    }).expect(201);
    const all = (await api.get("/api/reflections/period?preset=custom&start_date=2026-06-01&end_date=2026-06-30&sources=memories").expect(200)).body.data;
    assert.equal(all.memories.length, 0, "reflection evidence requires explicit selection");
    assert.equal(all.memory_candidates.length, 2);
    const work = (await api.get("/api/reflections/period?preset=custom&start_date=2026-06-01&end_date=2026-06-30&sources=memories&life_area_ids=area_work").expect(200)).body.data;
    assert.equal(work.memories.length, 0);
    assert.equal(work.memory_candidates.length, 1);
    const categoryOnly = (await api.get(`/api/reflections/period?preset=custom&start_date=2026-06-01&end_date=2026-06-30&sources=memories&category_ids=${category.id}`).expect(200)).body.data;
    assert.equal(categoryOnly.memory_candidates.length, 1);
    await api.patch("/api/reflections/selections").send({
      scope_key: work.scope_key,
      items: [{ type: "memory", id: memory.id, selected: true }],
    }).expect(200);
    const after = (await api.get("/api/reflections/period?preset=custom&start_date=2026-06-01&end_date=2026-06-30&sources=memories&life_area_ids=area_work").expect(200)).body.data;
    assert.equal(after.memories.length, 1);
    assert.equal(after.memory_candidates.length, 1);
    assert.equal(after.memory_candidates[0].life_area_id, "area_work");
    assert.equal((db.prepare("SELECT life_area_id FROM memories WHERE id=?").get(memory.id) as { life_area_id: string }).life_area_id, "area_work");
    assert.equal(all.memories.length, 0, "a different filter scope remains unselected");
    await api.patch("/api/reviews/evidence").send({ items: [
      { type: "memory", id: memory.id, included: false },
    ] }).expect(410);
  });

  it("upserts grounded reflection drafts as Journal entries and excludes them from evidence", async () => {
    let prompt = "";
    const { api } = fixture(undefined, async value => {
      prompt = value;
      return JSON.stringify({
        content: "## Highlights\n- Finished the garden plan (Garden plan)",
        tags: ["garden", "progress"],
        mood_score: 4,
        mood_label: "accomplished",
      });
    });
    await api.post("/api/memories").send({
      title: "Garden plan",
      content: "Finished planning the summer garden.",
      kind: "note",
      life_area_id: "area_personal",
      life_area_source: "user",
      occurred_at: "2026-06-12T12:00:00.000Z",
      tags: [],
    }).expect(201);
    const body = {
      preset: "custom",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      life_area_ids: ["area_personal"],
      category_ids: [],
      sources: ["memories"],
    };
    const evidence = (await api.get("/api/reflections/period?preset=custom&start_date=2026-06-01&end_date=2026-06-30&sources=memories&life_area_ids=area_personal").expect(200)).body.data;
    await api.patch("/api/reflections/selections").send({
      scope_key: evidence.scope_key,
      items: [{ type: "memory", id: evidence.memory_candidates[0].id, selected: true }],
    }).expect(200);
    const generated = (await api.post("/api/reflections/draft").send(body).expect(200)).body.data;
    assert.match(prompt, /get_reflection_evidence/);
    assert.equal(generated.draft, null, "generation must not persist a Journal entry");
    assert.match(generated.generated_draft.content, /Finished the garden plan/);
    assert.deepEqual(generated.generated_draft.tags, ["garden", "progress"]);
    assert.equal(generated.generated_draft.mood_score, 4);
    const first = (await api.post("/api/reflections/draft/save").send({
      ...body,
      content: generated.generated_draft.content,
      tags: generated.generated_draft.tags,
      mood_score: generated.generated_draft.mood_score,
      mood_label: generated.generated_draft.mood_label,
    }).expect(200)).body.data;
    assert.equal(first.draft.kind, "journal");
    assert.equal(first.draft.life_area_id, "area_personal");
    assert.equal(first.draft.occurred_at.slice(0, 10), "2026-06-30");
    assert.ok(first.draft.tags.includes("reflection-draft"));
    assert.ok(first.draft.tags.includes("garden"));
    assert.equal(first.draft.mood_score, 4);
    assert.equal(first.draft.mood_label, "accomplished");
    assert.equal(first.memories.length, 1);
    const refreshed = (await api.post("/api/reflections/draft").send(body).expect(200)).body.data;
    assert.equal(refreshed.draft.id, first.draft.id);
    const second = (await api.post("/api/reflections/draft/save").send({
      ...body,
      content: `${refreshed.generated_draft.content}\n\nNext steps\n- Plant seeds`,
      tags: refreshed.generated_draft.tags,
      mood_score: refreshed.generated_draft.mood_score,
      mood_label: refreshed.generated_draft.mood_label,
    }).expect(200)).body.data;
    assert.equal(second.draft.id, first.draft.id, "refreshing the same scope must update its Journal entry");
    assert.equal(second.memories.length, 1, "the saved reflection must never become its own source");
  });
});

/** The three record types the palette searches, seeded through the API. */
async function seedSearchCorpus(api: request.Agent) {
  const todo = (await api.post("/api/todos").send({
    title: "Prepare the DevCon demo",
    notes: "Rehearse the NeuralSearch story",
    status: "in_progress",
  }).expect(201)).body.data;
  const memory = (await api.post("/api/memories").send({
    title: "Talk framing",
    content: "The demo lands better when the search story comes first.",
    kind: "note",
    tags: ["demo"],
  }).expect(201)).body.data;
  await api.post("/api/conversations/web/sync").send({
    conversationId: "browser-agent",
    messages: [
      { id: "web_user_demo", role: "user", parts: [{ type: "text", text: "How is the demo going?" }] },
    ],
  }).expect(200);
  const message = (await api.get("/api/conversations/channels").expect(200)).body.data[0];
  return { todo, memory, threadId: message.id };
}

describe("universal search", () => {
  it("groups Algolia hits by type and reports each count", async () => {
    const { search, api } = fixture();
    const { todo, memory } = await seedSearchCorpus(api);
    let asked: { query: string; types?: string[]; limit?: number } | null = null;
    search.searchAll = async (query, options = {}) => {
      asked = { query, types: options.types, limit: options.limit };
      return {
        counts: { todo: 1, memory: 4, message: 0 },
        hits: {
          todo: [{ objectID: todo.id, title: todo.title, notes: todo.notes, status: "in_progress" }],
          memory: [{ objectID: memory.id, title: memory.title, content: memory.content, kind: "note" }],
          message: [],
        },
      };
    };
    const body = (await api.get("/api/search?q=demo&limit=5").expect(200)).body.data;
    assert.deepEqual(asked, { query: "demo", types: ["todo", "memory", "message"], limit: 5 });
    assert.equal(body.source, "algolia");
    // Counts come from Algolia's totals, not from the rows that fit in `limit`.
    assert.deepEqual(body.counts, { todo: 1, memory: 4, message: 0 });
    assert.deepEqual(body.hits.map((hit: { type: string; title: string }) => [hit.type, hit.title]), [
      ["todo", "Prepare the DevCon demo"],
      ["memory", "Talk framing"],
    ]);
    assert.equal(body.hits[0].snippet, "Rehearse the NeuralSearch story");
  });

  it("narrows to the requested types", async () => {
    const { search, api } = fixture();
    const { memory } = await seedSearchCorpus(api);
    let requestedTypes: string[] | undefined;
    search.searchAll = async (_query, options = {}) => {
      requestedTypes = options.types;
      return {
        counts: { todo: 0, memory: 1, message: 0 },
        hits: {
          todo: [],
          memory: [{ objectID: memory.id, title: memory.title, content: memory.content, kind: "note" }],
          message: [],
        },
      };
    };
    const body = (await api.get("/api/search?q=demo&types=memory").expect(200)).body.data;
    assert.deepEqual(requestedTypes, ["memory"]);
    assert.deepEqual(body.hits.map((hit: { type: string }) => hit.type), ["memory"]);
  });

  it("answers from SQLite when Algolia fails, with the same hit shape", async () => {
    const { search, api } = fixture();
    await seedSearchCorpus(api);
    search.searchAll = async () => {
      throw new Error("Algolia is unreachable");
    };
    const body = (await api.get("/api/search?q=demo").expect(200)).body.data;
    assert.equal(body.source, "sqlite");
    assert.deepEqual(body.counts, { todo: 1, memory: 1, message: 1 });
    assert.deepEqual(body.hits.map((hit: { type: string }) => hit.type), ["todo", "memory", "message"]);
    const message = body.hits.find((hit: { type: string }) => hit.type === "message");
    assert.equal(message.snippet, "How is the demo going?");
    assert.equal(message.channel, "web");
    assert.equal(message.role, "user");
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    const { api } = fixture();
    await api.post("/api/memories").send({ content: "Progress is 50% done", kind: "note" }).expect(201);
    await api.post("/api/memories").send({ content: "Nothing to report", kind: "note" }).expect(201);
    const percent = (await api.get(`/api/search?q=${encodeURIComponent("50%")}&types=memory`).expect(200)).body.data;
    assert.equal(percent.hits.length, 1);
    // Unescaped, a bare `%` is the LIKE wildcard and would match both rows.
    const wildcard = (await api.get(`/api/search?q=${encodeURIComponent("%")}&types=memory`).expect(200)).body.data;
    assert.deepEqual(wildcard.hits.map((hit: { snippet: string }) => hit.snippet), ["Progress is 50% done"]);
    const underscore = (await api.get(`/api/search?q=${encodeURIComponent("_")}&types=memory`).expect(200)).body.data;
    assert.deepEqual(underscore.hits, []);
  });

  it("never returns another user's records and honors limit", async () => {
    const { db, api } = fixture();
    await seedSearchCorpus(api);
    await api.post("/api/todos").send({ title: "Second demo rehearsal" }).expect(201);
    db.prepare(`
      INSERT INTO todos(id,user_id,title,status,extra_reminders_json,created_at,updated_at)
      VALUES('todo_other','user_other','Someone else demo','pending','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')
    `).run();
    const body = (await api.get("/api/search?q=demo&types=todo&limit=1").expect(200)).body.data;
    assert.equal(body.hits.length, 1);
    assert.equal(body.hits[0].title, "Second demo rehearsal");
    const all = (await api.get("/api/search?q=demo&types=todo").expect(200)).body.data;
    assert.deepEqual(
      all.hits.map((hit: { title: string }) => hit.title).sort(),
      ["Prepare the DevCon demo", "Second demo rehearsal"],
    );
  });

  it("rejects a missing, empty, or oversized query", async () => {
    const { api } = fixture();
    await api.get("/api/search").expect(400);
    await api.get("/api/search?q=%20").expect(400);
    await api.get(`/api/search?q=${"a".repeat(501)}`).expect(400);
    await api.get("/api/search?q=demo&types=nonsense").expect(400);
    await api.get("/api/search?q=demo&limit=99").expect(400);
  });
});

describe("memory search", () => {
  it("keeps Algolia's order through SQLite hydration and skips stale hits", async () => {
    const { search, api } = fixture();
    const first = (await api.post("/api/memories").send({ content: "Older note about search", kind: "note" }).expect(201)).body.data;
    const second = (await api.post("/api/memories").send({ content: "Newer note about search", kind: "note" }).expect(201)).body.data;
    // Reverse of the created_at order the SQL fallback would produce, plus an id
    // Algolia still has but SQLite has already dropped.
    search.searchMemories = async () => [first.id, "memory_deleted", second.id];
    const body = (await api.get("/api/memories?query=search").expect(200)).body.data;
    assert.equal(body.source, "algolia");
    assert.deepEqual(body.memories.map((memory: { id: string }) => memory.id), [first.id, second.id]);
  });

  it("forwards facet filters and still applies occurrence bounds in SQL", async () => {
    const { search, api } = fixture();
    const inRange = (await api.post("/api/memories").send({
      content: "Launch retro worth reviewing",
      kind: "journal",
      life_area_id: "area_work",
      review_worthy: true,
      mood_label: "proud",
      occurred_at: "2026-06-15T12:00:00.000Z",
    }).expect(201)).body.data;
    const outOfRange = (await api.post("/api/memories").send({
      content: "Older launch retro",
      kind: "journal",
      life_area_id: "area_work",
      review_worthy: true,
      occurred_at: "2026-01-05T12:00:00.000Z",
    }).expect(201)).body.data;
    let filters: Record<string, unknown> | null = null;
    search.searchMemories = async (_query, options = {}) => {
      filters = { ...options };
      return [inRange.id, outOfRange.id];
    };
    const body = (await api.get(
      "/api/memories?query=retro&kind=journal&life_area_id=area_work&review_worthy=true&mood_label=proud"
      + "&occurred_from=2026-05-01T00:00:00.000Z&limit=10",
    ).expect(200)).body.data;
    assert.deepEqual(filters, {
      limit: 10,
      kind: "journal",
      category_id: undefined,
      life_area_id: "area_work",
      mood_label: "proud",
      review_worthy: true,
    });
    // occurred_from is not facetable, so it has to narrow the hydrated rows.
    assert.deepEqual(body.memories.map((memory: { id: string }) => memory.id), [inRange.id]);
  });

  it("falls back to LIKE and says so when Algolia fails", async () => {
    const { search, api } = fixture();
    await api.post("/api/memories").send({ content: "Wifi password is on the fridge", kind: "fact" }).expect(201);
    search.searchMemories = async () => {
      throw new Error("Algolia is unreachable");
    };
    const body = (await api.get("/api/memories?query=wifi").expect(200)).body.data;
    assert.equal(body.source, "sqlite");
    assert.equal(body.memories.length, 1);
  });
});

describe("Algolia fiscal quarters", () => {
  it("uses February 1 boundaries and keeps January in the prior Q4", () => {
    const q1 = fiscalQuarterRange(2026, 1, "America/New_York");
    assert.equal(q1.startDate, "2026-02-01");
    assert.equal(q1.endDate, "2026-04-30");
    const january = currentFiscalQuarter("America/New_York", new Date("2027-01-15T12:00:00.000Z"));
    assert.deepEqual(january, { year: 2026, quarter: 4 });
  });
});

describe("reflection periods", () => {
  it("uses timezone-safe inclusive day, Monday week, month, and custom boundaries", () => {
    const at = new Date("2026-03-08T06:30:00.000Z");
    const day = reflectionPeriod("today", "America/New_York", { at });
    assert.equal(day.startDate, "2026-03-08");
    assert.equal(day.start, "2026-03-08T05:00:00.000Z");
    assert.equal(day.endExclusive, "2026-03-09T04:00:00.000Z");
    const week = reflectionPeriod("week", "America/New_York", { at });
    assert.equal(week.startDate, "2026-03-02");
    assert.equal(week.endDate, "2026-03-08");
    const month = reflectionPeriod("month", "America/New_York", { at });
    assert.equal(month.startDate, "2026-03-01");
    assert.equal(month.endDate, "2026-03-31");
    const custom = reflectionPeriod("custom", "UTC", { startDate: "2026-02-27", endDate: "2026-03-02" });
    assert.equal(custom.endExclusive, "2026-03-03T00:00:00.000Z");
  });
});

describe("outbox and Algolia integration", () => {
  it("commits entity mutation and outbox enqueue atomically", async () => {
    const { db, api } = fixture();
    db.exec(`
      CREATE TRIGGER reject_index_job BEFORE INSERT ON index_jobs
      BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;
    `);
    await api.post("/api/todos").send({ title: "Must roll back" }).expect(409);
    assert.equal((db.prepare("SELECT count(*) count FROM todos").get() as { count: number }).count, 0);
    db.exec("DROP TRIGGER reject_index_job");
    const created = (await api.post("/api/todos").send({ title: "Atomic todo" }).expect(201)).body.data;
    assert.equal(getTodo(db, created.id)?.title, "Atomic todo");
    assert.equal((db.prepare(`
      SELECT count(*) count FROM index_jobs WHERE entity_id=? AND operation='upsert'
    `).get(created.id) as { count: number }).count, 1);
  });

  it("uses canonical Algolia v5 projections and durable retries", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO todos(
        id,user_id,title,notes,life_area_id,life_area_source,extra_reminders_json,priority,status,created_at,updated_at
      ) VALUES('todo_sync',?,?,?,'area_work','user','["2026-08-01T00:00:00.000Z"]','high','pending',?,?)
    `).run(USER_ID, "Sync me", "Canonical notes", timestamp, timestamp);
    queueIndexJob(db, "todo", "todo_sync");

    const calls: Array<[string, Record<string, unknown>]> = [];
    let fail = true;
    const client = {
      async saveObjects(input: Record<string, unknown>) {
        calls.push(["save", input]);
        if (fail) throw new Error("temporary outage");
        return [];
      },
      async deleteObject(input: Record<string, unknown>) { calls.push(["delete", input]); return {}; },
      async setSettings(input: Record<string, unknown>) { calls.push(["settings", input]); return {}; },
      async searchSingleIndex() { return { nbHits: 0, hits: [] }; },
    };
    const sync = new AlgoliaSync(db, { client: client as never });
    assert.equal(sync.todoIndex, "devcon_assistant_todos");
    assert.equal(sync.memoryIndex, "devcon_assistant_memories");
    assert.equal((await sync.flush()).failed, 1);
    const failed = db.prepare("SELECT * FROM index_jobs").get() as {
      id: string; status: string; attempts: number; last_error: string;
    };
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /temporary outage/);

    fail = false;
    db.prepare("UPDATE index_jobs SET available_at=? WHERE id=?").run(timestamp, failed.id);
    assert.equal((await sync.flush()).succeeded, 1);
    const record = (calls.at(-1)?.[1].objects as Array<Record<string, unknown>>)[0];
    assert.equal(record.objectID, "todo_sync");
    assert.equal(record.userId, USER_ID);
    assert.equal(record.notes, "Canonical notes");
    assert.equal(record.priority, "high");
    assert.equal(record.life_area_slug, "work");
    assert.deepEqual(record.extra_reminders, ["2026-08-01T00:00:00.000Z"]);
  });

  it("reindexes and semantically searches redacted conversation messages", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const timestamp = "2026-07-22T12:00:00.000Z";
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_search',?,'sms','+17185550000','alg_cnv_test',?,?)
    `).run(USER_ID, timestamp, timestamp);
    db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES
        ('message_search','thread_search','inbound','user','Discussed the launch plan','SM-secret','received','{"private":"tool payload"}',?,?),
        ('message_tool','thread_search','outbound','tool','create_todo',NULL,'delivered','{"input":{"token":"secret"}}',?,?)
    `).run(timestamp, timestamp, timestamp, timestamp);
    const saved: Array<Record<string, unknown>> = [];
    const client = {
      async saveObjects(input: Record<string, unknown>) {
        saved.push(...input.objects as Array<Record<string, unknown>>);
        return [];
      },
      async deleteObject() { return {}; },
      async setSettings() { return {}; },
      async getSettings() {
        return { attributesForFaceting: ["filterOnly(userId)", "channel", "role", "filterOnly(threadId)"] };
      },
      async searchSingleIndex(input: Record<string, unknown>) {
        assert.equal(input.indexName, "devcon_assistant_messages");
        return {
          nbHits: 1,
          hits: [{
            objectID: "message_search",
            threadId: "thread_search",
            channel: "sms",
            role: "user",
            content: "Discussed the launch plan",
            created_at: timestamp,
          }],
        };
      },
    };
    const sync = new AlgoliaSync(db, { client: client as never });
    assert.equal(sync.queueReindex(), 1, "tool traces must not enter the conversation index");
    assert.equal((await sync.flush()).succeeded, 1);
    assert.deepEqual(saved[0], {
      objectID: "message_search",
      userId: USER_ID,
      threadId: "thread_search",
      channel: "sms",
      role: "user",
      content: "Discussed the launch plan",
      created_at: timestamp,
    });
    const hits = await sync.searchMessages("launch plan", 5);
    assert.equal(hits[0].threadId, "thread_search");
    assert.equal(JSON.stringify(saved).includes("SM-secret"), false);
    assert.equal(JSON.stringify(saved).includes("tool payload"), false);
    const misconfigured = new AlgoliaSync(db, {
      client: {
        ...client,
        async getSettings() { return { attributesForFaceting: [] }; },
      } as never,
    });
    await assert.rejects(
      () => misconfigured.searchMessages("launch plan", 5),
      /missing filterOnly\(userId\)/,
    );
  });

  it("searches all three indices in one request and filters memories by facet", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const requests: Array<Record<string, unknown>> = [];
    const singleIndexCalls: Array<Record<string, unknown>> = [];
    const client = {
      async getSettings() {
        return { attributesForFaceting: ["filterOnly(userId)", "kind", "review_worthy"] };
      },
      async search(input: { requests: Array<Record<string, unknown>> }) {
        requests.push(...input.requests);
        return {
          results: [
            { nbHits: 12, hits: [{ objectID: "todo_1", title: "Rehearse the demo" }] },
            { nbHits: 1, hits: [{ objectID: "memory_1", content: "Rehearsal notes" }] },
            { nbHits: 0, hits: [] },
          ],
        };
      },
      async searchSingleIndex(input: Record<string, unknown>) {
        singleIndexCalls.push(input);
        return { nbHits: 2, hits: [{ objectID: "memory_2" }, { objectID: "memory_1" }] };
      },
    };
    const sync = new AlgoliaSync(db, { client: client as never });

    const all = await sync.searchAll("rehearse", { limit: 5 });
    assert.deepEqual(requests.map(request => request.indexName), [
      "devcon_assistant_todos",
      "devcon_assistant_memories",
      "devcon_assistant_messages",
    ]);
    assert.deepEqual([...new Set(requests.map(request => request.filters))], [`userId:"${USER_ID}"`]);
    assert.deepEqual([...new Set(requests.map(request => request.hitsPerPage))], [5]);
    // Only what a result row renders travels back over the wire.
    assert.deepEqual(requests[2].attributesToRetrieve, [
      "objectID", "threadId", "channel", "role", "content", "created_at",
    ]);
    // Totals come from the index, so the palette can say there is more to see.
    assert.deepEqual(all.counts, { todo: 12, memory: 1, message: 0 });
    assert.deepEqual(all.hits.todo, [{ objectID: "todo_1", title: "Rehearse the demo" }]);
    assert.deepEqual(all.hits.message, []);

    requests.length = 0;
    await sync.searchAll("rehearse", { types: ["memory"] });
    assert.deepEqual(requests.map(request => request.indexName), ["devcon_assistant_memories"]);

    const ranked = await sync.searchMemories("rehearse", {
      limit: 3,
      kind: "journal",
      category_id: "category_launch",
      life_area_id: "area_work",
      mood_label: 'said "yes"',
      review_worthy: true,
    });
    assert.deepEqual(ranked, ["memory_2", "memory_1"]);
    const params = singleIndexCalls[0].searchParams as Record<string, unknown>;
    assert.equal(
      params.filters,
      `userId:"${USER_ID}" AND kind:"journal" AND category_id:"category_launch"`
      + ` AND life_area_id:"area_work" AND mood_label:"said \\"yes\\"" AND review_worthy:true`,
    );
    assert.equal(params.hitsPerPage, 3);
    // SQLite hydrates the rows, so only the ranking has to come back.
    assert.deepEqual(params.attributesToRetrieve, ["objectID"]);

    const misconfigured = new AlgoliaSync(db, {
      client: { ...client, async getSettings() { return { attributesForFaceting: [] }; } } as never,
    });
    await assert.rejects(() => misconfigured.searchAll("rehearse"), /missing filterOnly\(userId\)/);
    await assert.rejects(() => misconfigured.searchMemories("rehearse"), /missing filterOnly\(userId\)/);
    const unconfigured = new AlgoliaSync(db, { client: null });
    await assert.rejects(() => unconfigured.searchAll("rehearse"), /not configured/);
    await assert.rejects(() => unconfigured.searchMemories("rehearse"), /not configured/);
  });
});

describe("NeuralSearch toggle", () => {
  function settingsClient(rejectNeural = false, live: Record<string, unknown> = {}) {
    const applied: Array<{ indexName: string; indexSettings: Record<string, unknown> }> = [];
    const semantic: Array<{ path: string; body: Record<string, unknown> }> = [];
    const waits: string[] = [];
    return {
      applied,
      semantic,
      waits,
      async setSettings(input: { indexName: string; indexSettings: Record<string, unknown> }) {
        applied.push(input);
        return { taskID: applied.length };
      },
      async customGet() { return { neuralSearchMode: "preview", vectorModelId: "", ...live }; },
      async customPut(input: { path: string; body: Record<string, unknown> }) {
        if (rejectNeural && input.body.neuralSearchMode === "active") {
          throw new Error("SemanticSearch: no events");
        }
        semantic.push(input);
        return {};
      },
      async waitForTask({ indexName }: { indexName: string }) {
        waits.push(indexName);
        return {};
      },
      async searchSingleIndex() { return { nbHits: 0, hits: [] }; },
    };
  }

  it("returns without waiting for the settings tasks to publish", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const client = settingsClient();
    const sync = new AlgoliaSync(db, { client: client as never });

    await sync.setup();
    assert.equal(client.applied.length, 3);
    // A settings task on a NeuralSearch index stays unpublished while the index
    // re-vectorizes, so waiting makes this a multi-minute call and can time out
    // on settings Algolia already accepted.
    assert.deepEqual(client.waits, []);
  });

  it("never writes mode with index settings, since the semantic endpoint owns it", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const client = settingsClient();
    const sync = new AlgoliaSync(db, { client: client as never });

    await sync.setup();
    assert.equal(client.applied.length, 3);
    for (const entry of client.applied) {
      assert.equal("mode" in entry.indexSettings, false, "writing mode is refused even when it already holds that value");
    }
  });

  it("defaults to keyword search and only activates once enabled", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const client = settingsClient();
    const sync = new AlgoliaSync(db, { client: client as never });

    assert.equal(sync.neuralSearchEnabled(), false, "NeuralSearch is a paid add-on, so it is opt-in");
    assert.deepEqual(await sync.setup(), { configured: true, details: { search: "keyword" } });
    assert.equal(client.semantic.length, 0, "an index that was never activated needs no write to stay keyword");

    saveSearchPreferences(db, { neuralSearchEnabled: true });
    assert.deepEqual(await sync.setup(), { configured: true, details: { search: "neural" } });
    assert.deepEqual(client.semantic.map(entry => entry.body.neuralSearchMode), ["active", "active", "active"]);
    // No leading slash: with one the client fails as "Unreachable hosts".
    assert.deepEqual(
      client.semantic.map(entry => entry.path),
      [
        "1/indexes/devcon_assistant_todos/semanticSearch/settings",
        "1/indexes/devcon_assistant_memories/semanticSearch/settings",
        "1/indexes/devcon_assistant_messages/semanticSearch/settings",
      ],
    );
  });

  it("leaves an index alone when it already holds the requested mode", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    saveSearchPreferences(db, { neuralSearchEnabled: true });
    const live = { neuralSearchMode: "active", vectorModelId: "external://algolia-large-multilang-generic-v2410" };
    const client = settingsClient(false, live);
    const sync = new AlgoliaSync(db, { client: client as never });

    await sync.setup();
    assert.equal(client.semantic.length, 0, "neural operations are capped at 10 an hour, so re-running setup must be free");

    saveSearchPreferences(db, { neuralSearchEnabled: false });
    await sync.setup();
    assert.deepEqual(client.semantic.map(entry => entry.body.neuralSearchMode), ["inactive", "inactive", "inactive"]);
  });

  it("names the attributes to vectorize, which is what activation without events requires", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    saveSearchPreferences(db, { neuralSearchEnabled: true });
    const client = settingsClient();
    const sync = new AlgoliaSync(db, { client: client as never });

    await sync.setup();
    const [todos, , messages] = client.semantic;
    // Derived from searchableAttributes, with the modifiers unwrapped.
    assert.deepEqual(todos.body.neuralExpression, { title: 1, notes: 1 });
    assert.deepEqual(messages.body.neuralExpression, { content: 1 });
    assert.match(String(todos.body.vectorModelId), /^external:\/\//);
  });

  it("falls back to keyword search when Algolia refuses activation", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    saveSearchPreferences(db, { neuralSearchEnabled: true });
    const client = settingsClient(true);
    const sync = new AlgoliaSync(db, { client: client as never });

    const result = await sync.setup();
    assert.equal(result.configured, true, "a refused activation must not fail the whole setup");
    assert.equal(result.details?.search, "keyword");
    assert.equal(result.details?.neuralSearch, "unavailable");
    assert.match(String(result.details?.warning), /SemanticSearch: no events/);
    assert.equal(client.applied.length, 3, "the indices still get their keyword settings");
  });

  it("persists the toggle over REST and reapplies index settings", async () => {
    const { api, db, search } = fixture();
    const enabled = await api.put("/api/admin/algolia/neural-search").send({ enabled: true }).expect(200);
    assert.equal(enabled.body.data.enabled, true);
    assert.equal(getSearchPreferences(db).neuralSearchEnabled, true);
    assert.deepEqual(search.setupCalls, ["neural"], "flipping the toggle has to rewrite index mode immediately");
    assert.deepEqual((await api.get("/api/health").expect(200)).body.data.neuralSearch, { enabled: true });

    await api.put("/api/admin/algolia/neural-search").send({ enabled: false }).expect(200);
    assert.equal(getSearchPreferences(db).neuralSearchEnabled, false);
    assert.deepEqual(search.setupCalls, ["neural", "keyword"]);
    await api.put("/api/admin/algolia/neural-search").send({ enabled: "yes" }).expect(400);
  });

  it("keeps the saved choice when Algolia cannot be reached to apply it", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const search = {
      ...fakeSearch(db),
      async setup() { throw new Error("Unreachable hosts - your application id may be incorrect"); },
    };
    const api = request(createApp({ db, search }).app);

    const response = await api.put("/api/admin/algolia/neural-search").send({ enabled: true }).expect(200);
    assert.equal(response.body.data.enabled, true, "the preference is the user's, not Algolia's to reject");
    assert.equal(response.body.data.setup.configured, false);
    assert.match(response.body.data.setup.details.error, /Unreachable hosts/);
    assert.equal(getSearchPreferences(db).neuralSearchEnabled, true);
  });
});

describe("Agent Studio configuration sync", () => {
  it("owns the search tool and prompts, converts client schemas, patches the draft, and publishes", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET") {
        return new Response(JSON.stringify({
          tools: [
            {
              type: "algolia_search_index",
              name: "algolia_search_index",
              indices: [{
                index: "devcon_assistant_todos",
                description: "Auto-generated dashboard text",
                enhancedDescription: "Available Facets and Facet Values: status: [done]",
                searchParameters: null,
              }],
            },
            { type: "client_side", name: "list_memories", inputSchema: { type: "object" } },
            { type: "mcp", name: "unrelated" },
          ],
        }), { status: 200 });
      }
      if (method === "POST") {
        return new Response(JSON.stringify({ message: "Agent agent is already published" }), { status: 409 });
      }
      return new Response("{}", { status: 200 });
    };

    const result = await syncAgentStudioTools({
      applicationId: "app",
      apiKey: "key",
      agentId: "agent",
      fetcher,
    });
    assert.equal(result.clientTools, 27);
    assert.equal(result.preservedTools, 1, "unrelated tools survive, the search tool is rebuilt not preserved");
    assert.equal(result.searchIndices, 3);
    assert.deepEqual(calls.map(call => call.method), ["GET", "PATCH", "POST"]);
    const patch = JSON.parse(calls[1].body || "{}") as {
      instructions: string;
      systemPrompt: string;
      tools: Array<Record<string, unknown>>;
    };
    assert.match(patch.instructions, /name every todo that was successfully changed/);
    // The website-search template is replaced by a block that defers to them.
    assert.match(patch.systemPrompt, /agent instructions are authoritative/);
    assert.doesNotMatch(patch.systemPrompt, /Cite sources inline as markdown links/i);
    assert.doesNotMatch(patch.systemPrompt, /browse our website/i);
    assert.ok(patch.tools.some(tool => tool.type === "mcp"), "unrelated tool types are left alone");

    const search = patch.tools.find(tool => tool.type === "algolia_search_index") as {
      indices: Array<Record<string, unknown>>;
    };
    assert.deepEqual(search.indices.map(entry => entry.index), [
      "devcon_assistant_todos",
      "devcon_assistant_memories",
      "devcon_assistant_messages",
    ], "the messages index is added rather than left out");
    const todos = search.indices[0];
    assert.match(String(todos.description), /Do not use for background knowledge/);
    assert.equal(
      (todos.searchParameters as { filters?: string }).filters,
      'userId:"devcon-demo"',
      "the checked-in locks are actually applied",
    );
    assert.equal(
      todos.enhancedDescription,
      "Available Facets and Facet Values: status: [done]",
      "Algolia-derived fields the file does not own are carried over",
    );

    // Every facet here becomes a `facet_<name>` argument the model fills in by
    // guessing, and those are hard filters: a wrong guess hides the record rather
    // than ranking it lower, and the agent then reports it as not stored. Only
    // bounded enums belong here. Opaque IDs, internal flags, and free-form tags
    // stay faceted for the app but out of the model's reach, which costs nothing
    // because they are still matched as searchable text.
    for (const [index, expected] of [
      [search.indices[0], ["status", "priority"]],
      [search.indices[1], ["kind", "mood_label"]],
      [search.indices[2], ["channel", "role"]],
    ] as Array<[Record<string, unknown>, string[]]>) {
      const controls = index.searchControls as { facets: { default: string[] } };
      const parameters = index.searchParameters as { facets: string[] };
      assert.deepEqual(controls.facets.default, expected, `${index.index} exposes only safe facets`);
      assert.deepEqual(parameters.facets, expected, `${index.index} requests the same set it allows`);
    }
    assert.equal(patch.tools.filter(tool => tool.type === "client_side").length, 27);
    assert.ok(!patch.tools.some(tool => tool.name === "list_memories"));
    assert.ok(patch.tools.some(tool => tool.name === "list_jira_issues" && "inputSchema" in tool));
    assert.ok(patch.tools.some(tool => tool.name === "create_memory" && "inputSchema" in tool));
    assert.ok(patch.tools.some(tool => tool.name === "get_conversation_context" && "inputSchema" in tool));
    assert.ok(patch.tools.some(tool => tool.name === "get_reflection_evidence" && "inputSchema" in tool));

    /*
     * Strict mode has two rules the schemas have to keep: every property listed
     * in `required`, and `additionalProperties: false`. Publishing a schema that
     * breaks either one fails at call time rather than at sync time, so it is
     * cheaper to catch here. The names also have to match `toolInput` exactly,
     * or the agent can call something the server will not validate.
     */
    const published = patch.tools.filter(tool => tool.type === "client_side");
    for (const tool of published) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      const properties = Object.keys(schema.properties || {});
      // Agent Studio rejects the whole PATCH with a 422 over 200 characters, so
      // anything longer than a couple of sentences belongs in the prompt.
      assert.ok(
        String(tool.description).length <= 200,
        `${tool.name} has a ${String(tool.description).length}-character description; Agent Studio caps it at 200`,
      );
      assert.equal(schema.additionalProperties, false, `${tool.name} allows extra properties`);
      assert.deepEqual(
        [...(schema.required || [])].sort(),
        [...properties].sort(),
        `${tool.name} leaves a property out of required, which strict mode rejects`,
      );
    }
    assert.deepEqual(
      published.map(tool => String(tool.name)).sort(),
      Object.keys(toolInput).sort(),
      "the published tools and the validated tools are the same set",
    );
  });
});

describe("SMS, reminders, and channel agent execution", () => {
  it("rejects localhost webhook URLs before contacting Twilio", async () => {
    const { api } = fixture();
    const response = await api.post("/api/integrations/twilio/connect").send({
      accountSid: "AC11111111111111111111111111111111",
      authToken: "super-secret-auth-token",
      fromPhone: "+17185550000",
      webhookBaseUrl: "https://localhost",
      configureWebhook: true,
    }).expect(400);
    assert.match(response.body.error, /cannot reach localhost/i);
  });

  it("requires an auth token when no Twilio account is connected yet", async () => {
    const { api } = fixture();
    const response = await api.post("/api/integrations/twilio/connect").send({
      accountSid: "AC11111111111111111111111111111111",
      fromPhone: "+17185550000",
      webhookBaseUrl: "https://assistant.example.com",
      configureWebhook: true,
    }).expect(400);
    assert.match(response.body.error, /auth token is required/i);
  });

  it("stores Twilio secrets encrypted and deduplicates signed inbound webhooks", async () => {
    const { db, api } = fixture();
    saveTwilioConfig(db, {
      accountSid: "AC11111111111111111111111111111111",
      authToken: "super-secret-auth-token",
      fromPhone: "+17185550000",
      webhookBaseUrl: "https://assistant.example.com",
    });
    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "America/New_York",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    const integrations = (await api.get("/api/integrations").expect(200)).body.data;
    assert.equal(integrations.twilio.configured, true);
    assert.equal(JSON.stringify(integrations).includes("super-secret-auth-token"), false);
    const payload = {
      From: "+17185551111",
      To: "+17185550000",
      Body: "What is due today?",
      MessageSid: "SM_duplicate",
    };
    await api.post("/api/webhooks/twilio/sms").type("form").send(payload).expect(200);
    await api.post("/api/webhooks/twilio/sms").type("form").send(payload).expect(200);
    assert.equal(
      (db.prepare("SELECT count(*) count FROM external_events WHERE source='twilio'").get() as { count: number }).count,
      1,
    );
    await api.post("/api/webhooks/twilio/sms").type("form").send({
      ...payload,
      Body: "STOP",
      MessageSid: "SM_stop",
    }).expect(200);
    assert.equal(
      (db.prepare("SELECT sms_enabled FROM notification_preferences WHERE user_id=?").get(USER_ID) as { sms_enabled: number }).sms_enabled,
      0,
    );
  });

  it("executes Agent Studio client tools on the server and continues to final text", async () => {
    const { db } = fixture();
    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "America/New_York",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    });
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    const requests: unknown[] = [];
    let call = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          role: "assistant",
          parts: [{
            type: "tool-create_todo",
            tool_call_id: "call_1",
            state: "input-available",
            input: {
              title: "Prepare SMS demo",
              notes: null,
              priority: "high",
              category_id: null,
              parent_id: null,
              due_at: null,
              reminder_at: null,
              extra_reminders: [],
              subtasks: [],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        role: "assistant",
        parts: [{ type: "text", text: "Created “Prepare SMS demo”." }],
      }), { status: 200 });
    };
    const response = await runSmsAgent(
      db,
      fakeSearch(db),
      "+17185551111",
      "Create a todo to prepare the SMS demo",
      "SM_agent",
      { fetcher },
    );
    assert.equal(response.text, "Created “Prepare SMS demo”.");
    assert.equal((db.prepare("SELECT count(*) count FROM todos").get() as { count: number }).count, 1);
    assert.equal(requests.length, 2);
    const firstRequest = requests[0] as {
      messages: Array<{ role: string; metadata?: { turnContext?: Record<string, string> } }>;
    };
    const turnContext = firstRequest.messages.find(message => message.role === "user")?.metadata?.turnContext;
    assert.equal(turnContext?.timezone, "America/New_York");
    assert.equal(turnContext?.channel, "sms");
    assert.match(turnContext?.currentDateTime || "", /^\d{4}-\d{2}-\d{2}T/);
    assert.match(JSON.stringify(requests[1]), /output-available/);
    const archived = db.prepare(`
      SELECT role,metadata_json FROM channel_messages ORDER BY created_at,rowid
    `).all() as Array<{ role: string; metadata_json: string }>;
    const toolMetadata = JSON.parse(archived.find(message => message.role === "tool")!.metadata_json);
    const assistantMetadata = JSON.parse(archived.find(message => message.role === "assistant")!.metadata_json);
    assert.equal(toolMetadata.input.title, "Prepare SMS demo");
    assert.equal(toolMetadata.output.success, true);
    assert.equal(assistantMetadata.parts[0].type, "text");
  });

  /*
   * Agent Studio does not replay a conversation, so a turn flattened to its own
   * prose left the model unable to tell a write it had made from one it had only
   * promised. "I'll remind you at 1:45" read back exactly like a reminder that
   * existed: on the user's "yes" the agent ran its duplicate preflight, took the
   * hit on an unrelated todo as confirmation, called nothing, and reported a
   * reminder that no row anywhere had ever held. Write results now come back with
   * the window. Searches stay out, because the preflight is meant to run again and
   * its hits were the thing being misread as proof.
   */
  it("replays past write results into the window and leaves reads out", async () => {
    const { db } = fixture();
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    type Part = Record<string, unknown>;
    type Body = { messages: Array<{ role: string; parts: Part[] }> };
    const searchPart: Part = {
      type: "tool-algolia_search_index_devcon_assistant_todos",
      tool_call_id: "call_search",
      state: "output-available",
      input: { queries: [{ query: "trash" }] },
      output: { hits: [], nbHits: 0 },
    };
    let nextTitle = "Take out trash";
    const requests: Body[] = [];
    // Agent Studio hands the accumulated turn back on every pass, which is how the
    // executed tool parts reach the stored assistant message in the first place.
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      requests.push(body);
      const last = body.messages.at(-1)!;
      const parts: Part[] = last.role === "assistant"
        ? [...last.parts, { type: "text", text: "Done." }]
        : [searchPart, {
          type: "tool-create_todo",
          tool_call_id: `call_write_${requests.length}`,
          state: "input-available",
          input: {
            title: nextTitle, notes: null, priority: null, category_id: null,
            parent_id: null, due_at: null, reminder_at: null, extra_reminders: [], subtasks: [],
          },
        }];
      return new Response(JSON.stringify({ role: "assistant", parts }), { status: 200 });
    };
    const run = (text: string) =>
      runSmsAgent(db, fakeSearch(db), "+17185551111", text, undefined, { fetcher });

    await run("Remind me to throw the trash out tomorrow at 9pm");
    requests.length = 0;
    await run("Yes that’s fine");

    const replayed = requests[0].messages.filter(message => message.role === "assistant");
    assert.equal(replayed.length, 1, "the one finished turn is replayed once");
    assert.deepEqual(
      replayed[0].parts.map(part => part.type),
      ["tool-create_todo", "text"],
      "the write comes back with the window and the preflight search does not",
    );
    const output = replayed[0].parts[0].output as { success: boolean; data: { title: string } };
    assert.equal(output.success, true);
    assert.equal(output.data.title, "Take out trash", "the model can see which record it wrote");

    // A write that failed is not evidence of anything either, so replaying it
    // would only invert the mistake.
    nextTitle = "";
    await run("Remind me about the JIRA backlog at 1:45");
    requests.length = 0;
    await run("Anything else?");
    const latest = requests[0].messages.filter(message => message.role === "assistant").at(-1)!;
    assert.deepEqual(latest.parts.map(part => part.type), ["text"], "a rejected write is not replayed");
  });

  /*
   * Agent Studio titles a conversation from its first message and never retitles,
   * so one id pinned to a phone number for life collected three weeks of texts
   * into a single record named after whatever was said first. A conversation now
   * lasts exactly as long as the window the model is shown.
   */
  it("retires an Agent Studio conversation once the thread falls outside the context window", async () => {
    const { db } = fixture();
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    const sent: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      sent.push((JSON.parse(String(init?.body)) as { id: string }).id);
      return new Response(JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "ok" }] }), { status: 200 });
    };
    const run = (body: string) => runSmsAgent(db, fakeSearch(db), "+17185551111", body, undefined, { fetcher });

    await run("first");
    await run("still the same sitting");
    assert.equal(sent[0], sent[1], "a live thread keeps its conversation");

    // Age everything past the window, the way an overnight gap would.
    db.prepare("UPDATE channel_messages SET created_at=?").run("2020-01-01T00:00:00.000Z");
    await run("a day later");
    assert.notEqual(sent[2], sent[1], "a stale thread starts a new conversation");
    assert.match(sent[2], /^alg_cnv_[0-9a-f]{32}$/);
    assert.equal(
      (db.prepare("SELECT agent_conversation_id FROM channel_threads WHERE channel='sms'")
        .get() as { agent_conversation_id: string }).agent_conversation_id,
      sent[2],
      "the rotated id is the one the thread keeps",
    );
  });

  /*
   * A turn whose tools ran but whose reply never arrived used to be unanswerable
   * forever: the retry re-inserted the inbound row, hit the unique index on the
   * provider message id, and failed before reaching the agent — so the todos got
   * marked done and the sender was told nothing, on every one of sixteen
   * attempts. The constraint error also replaced the real reason in `last_error`.
   */
  it("answers a redelivered inbound text whose first attempt died after its tools ran", async () => {
    const { db } = fixture();
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    const toolTurn = () => new Response(JSON.stringify({
      role: "assistant",
      parts: [{
        type: "tool-create_todo",
        tool_call_id: `call_${Math.random()}`,
        state: "input-available",
        input: {
          title: "Prepare SMS demo", notes: null, priority: "high", category_id: null,
          parent_id: null, due_at: null, reminder_at: null, extra_reminders: [], subtasks: [],
        },
      }],
    }), { status: 200 });

    let call = 0;
    const failing: typeof fetch = async () => {
      call += 1;
      // The tools land, then the completion that would have written the reply dies.
      return call === 1 ? toolTurn() : new Response("upstream gone", { status: 502 });
    };
    await assert.rejects(
      runSmsAgent(db, fakeSearch(db), "+17185551111", "Mark the Paul todo done", "SB_stuck", { fetcher: failing }),
      /502/,
    );

    call = 0;
    const recovering: typeof fetch = async () => {
      call += 1;
      return call === 1 ? toolTurn() : new Response(JSON.stringify({
        role: "assistant",
        parts: [{ type: "text", text: "Marked it done." }],
      }), { status: 200 });
    };
    const retry = await runSmsAgent(
      db, fakeSearch(db), "+17185551111", "Mark the Paul todo done", "SB_stuck", { fetcher: recovering },
    );
    assert.equal(retry.text, "Marked it done.");
    assert.equal(
      (db.prepare(`
        SELECT count(*) count FROM channel_messages WHERE direction='inbound' AND provider_message_id='SB_stuck'
      `).get() as { count: number }).count,
      1,
      "the redelivered text is one message in the archive, not two",
    );
  });

  /*
   * A scheduled send composes the same instruction again on its next attempt, so
   * the abandoned copy has to leave the recent window. It stayed once, and the
   * retry read a digest brief twice with an unrelated check-in wedged between
   * them and answered a question about assignees that nobody had asked.
   */
  it("keeps a turn nothing answered out of the next attempt's history", async () => {
    const { db } = fixture();
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    const search = fakeSearch(db);
    const instruction = "Check the boards attached for any ticket updates in the last 24 hours.";
    const unavailable = async () => { throw new Error("Agent Studio is unavailable (503)"); };
    await assert.rejects(
      runSmsAgent(db, search, "+17185551111", instruction, undefined, {
        fetcher: unavailable,
        internal: true,
      }),
      /503/,
    );
    let retry: { messages: Array<{ role: string; parts: Array<{ text?: string }> }> } | undefined;
    const answer: typeof fetch = async (_input, init) => {
      retry = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        role: "assistant",
        parts: [{ type: "text", text: "Nothing moved on either board." }],
      }), { status: 200 });
    };
    await runSmsAgent(db, search, "+17185551111", instruction, undefined, {
      fetcher: answer,
      internal: true,
    });
    assert.deepEqual(
      retry?.messages.map(message => message.parts[0]?.text),
      [instruction],
      "the retry reads the instruction once, not once per attempt",
    );
    assert.deepEqual(
      (db.prepare(`
        SELECT status FROM channel_messages WHERE role='user' ORDER BY created_at,rowid
      `).all() as Array<{ status: string }>).map(row => row.status),
      ["failed", "received"],
      "the abandoned turn survives for the audit trail",
    );

    // Nothing recomposes a text the user sent, so a failure to answer it must not
    // erase it from the conversation the next message is read against.
    await assert.rejects(
      runSmsAgent(db, search, "+17185551111", "Did they ship it?", "SM_unanswered", {
        fetcher: unavailable,
      }),
      /503/,
    );
    await runSmsAgent(db, search, "+17185551111", "Hello?", "SM_next", { fetcher: answer });
    assert.deepEqual(
      retry?.messages.map(message => message.parts[0]?.text).slice(-3),
      ["Nothing moved on either board.", "Did they ship it?", "Hello?"],
      "an unanswered message from the user stays in the recent window",
    );
  });

  /**
   * The reminder is written on the parent, so the steps it was broken into are
   * the part the text was missing. Only the open ones, and only a few of them.
   */
  it("names a task's open subtasks in the reminder it sends", async () => {
    const { db, api } = fixture();
    const created = await api.post("/api/todos").send({
      title: "Follow up with Paul",
      reminder_at: "2020-01-01T00:00:00.000Z",
      subtasks: [
        { title: "Ask about the PRs" },
        { title: "Agree the UI handover" },
        { title: "Book the review" },
        { title: "Write it up" },
        { title: "Send the recap" },
      ],
    }).expect(201);
    const subtasks = (await api.get(`/api/todos/${created.body.data.id}`).expect(200)).body.data.subtasks;
    await api.patch(`/api/todos/${subtasks[0].id}/status`).send({ status: "done" }).expect(200);
    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    let content = "";
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async (_db, _to, body) => { content = body; return { sid: "SM_1", status: "queued" }; },
      runSmsAgent: async () => ({ text: "digest", threadId: "unused" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });
    assert.equal(
      content,
      "Reminder: Follow up with Paul\n4 open: Agree the UI handover; Book the review; Write it up; +1 more",
    );
  });

  it("claims each due reminder once and records provider delivery IDs", async () => {
    const { db, api } = fixture();
    await api.post("/api/todos").send({
      title: "Send only once",
      reminder_at: "2020-01-01T00:00:00.000Z",
    }).expect(201);
    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    let sends = 0;
    const dependencies = {
      sendSms: async () => ({ sid: `SM_${++sends}`, status: "queued" }),
      runSmsAgent: async () => ({ text: "digest", threadId: "unused" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    };
    await runWorkerOnce(db, fakeSearch(db), dependencies);
    await runWorkerOnce(db, fakeSearch(db), dependencies);
    assert.equal(sends, 1);
    const reminder = db.prepare("SELECT status,provider_message_id FROM reminders").get() as {
      status: string;
      provider_message_id: string;
    };
    assert.deepEqual(reminder, { status: "sent", provider_message_id: "SM_1" });
    const archived = db.prepare(`
      SELECT role,content,provider_message_id,metadata_json
      FROM channel_messages ORDER BY created_at,rowid
    `).all() as Array<{ role: string; content: string; provider_message_id: string; metadata_json: string }>;
    assert.equal(archived[0].role, "assistant");
    assert.equal(archived[0].content, "Reminder: Send only once");
    assert.equal(archived[0].provider_message_id, "SM_1");
    assert.equal(JSON.parse(archived[0].metadata_json).kind, "reminder");

    let completionRequest: { messages: Array<{ role: string; parts: Array<{ text?: string }> }> } | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      completionRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        role: "assistant",
        parts: [{ type: "text", text: "Marked “Send only once” as done." }],
      }), { status: 200 });
    };
    await runSmsAgent(db, fakeSearch(db), "+17185551111", "It's done", "SM_reply", { fetcher });
    assert.deepEqual(
      completionRequest?.messages.slice(0, 2).map(message => message.parts[0].text),
      ["Reminder: Send only once", "It's done"],
      "the Agent receives the reminder immediately before the reply",
    );
  });
});

describe("agent tools over /api/agent/tools/:name", () => {
  /** Every local tool the agent is allowed to call, exercised end to end. */
  it("covers all nineteen local tools declared in the client contract", async () => {
    const { api, db } = fixture();
    const call = async (name: string, input: object = {}, expected = 200) =>
      (await api.post(`/api/agent/tools/${name}`).send(input).expect(expected)).body;

    const declared = Object.keys(toolInput);
    assert.equal(declared.length, 27, "the tool contract changed; extend this test with it");
    // The Atlassian tools read a remote system rather than SQLite, so they are
    // exercised against a stubbed site in their own block instead of here.
    const remote = declared.filter(name => /_(jira|confluence)_/.test(name));
    assert.equal(remote.length, 8, "every Atlassian tool has to be named for its product");

    const areas = (await call("list_life_areas")).data;
    const work = areas.find((area: { slug: string }) => area.slug === "work");
    assert.ok(work, "the built-in life areas must be discoverable by the agent");

    const created = (await call("create_todo", {
      title: "Draft the DevCon script",
      notes: "Cover the outbox",
      priority: "high",
      life_area_id: work.id,
      due_at: "2030-03-01T17:00:00.000Z",
      subtasks: [{ title: "Outline" }],
    })).data;
    assert.equal(created.title, "Draft the DevCon script");
    assert.equal((await call("get_todo", { id: created.id })).data.todo.notes, "Cover the outbox");
    assert.ok((await call("list_todos", { status: "pending", limit: 10 })).data
      .some((todo: { id: string }) => todo.id === created.id));

    const patched = (await call("update_todo", {
      id: created.id,
      patch: { title: "Draft the talk", clear_fields: ["notes", "priority"] },
    })).data;
    assert.equal(patched.title, "Draft the talk");
    assert.equal(patched.notes, null, "clear_fields has to null the column server-side");
    assert.equal(patched.priority, null, "priority is nullable, so clearing it means unset rather than normal");

    assert.equal((await call("set_todo_status", { id: created.id, status: "in_progress" })).data.status, "in_progress");
    await call("set_todo_status", { id: created.id, status: "not_a_status" }, 400);

    const reminder = (await call("create_reminder", {
      todo_id: created.id,
      reminder_at: "2030-02-28T17:00:00.000Z",
      slot: "extra",
    })).data;
    assert.ok((await call("list_reminders", {
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-12-31T00:00:00.000Z",
    })).data.some((row: { id: string }) => row.id === reminder.id));
    // Rescheduling rewrites the todo's reminder set, so the row is replaced
    // rather than updated in place and the caller gets a new id back.
    const moved = (await call("update_reminder", {
      id: reminder.id,
      reminder_at: "2030-02-27T17:00:00.000Z",
    })).data;
    assert.equal(moved.scheduled_for, "2030-02-27T17:00:00.000Z");
    await call("delete_reminder", { id: moved.id }, 409);
    assert.equal((await call("delete_reminder", { id: moved.id, confirmed: true })).data.id, moved.id);

    const memory = (await call("create_memory", {
      content: "Decided to lead with the consistency contract.",
      title: "Talk framing",
      kind: "note",
      tags: ["devcon"],
    })).data;
    assert.equal((await call("get_memory", { id: memory.id })).data.title, "Talk framing");
    const updatedMemory = (await call("update_memory", {
      id: memory.id,
      patch: { content: "Lead with the outbox instead.", clear_fields: ["title", "tags"] },
    })).data;
    assert.equal(updatedMemory.title, null);
    assert.deepEqual(updatedMemory.tags, []);

    const agenda = (await call("get_agenda", {
      start_date: "2030-02-01",
      end_date: "2030-03-31",
      timezone: "UTC",
    })).data;
    assert.deepEqual(
      agenda.todos.map((todo: { id: string }) => todo.id),
      [created.id],
      "the agenda window has to include the todo due inside it",
    );
    const narrowed = (await call("get_agenda", { start_date: "2030-01-01", end_date: "2030-01-31" })).data;
    assert.deepEqual(narrowed.todos, [], "and exclude anything outside it");

    const review = (await call("get_review_evidence", { year: 2030, quarter: 1, timezone: "UTC" })).data;
    assert.ok(review.range, "review evidence is scoped to a fiscal quarter");
    assert.ok(Array.isArray(review.memory_candidates), "the agent payload carries the candidate lists");
    assert.ok(review.candidate_totals, "and the true counts behind a truncated list");
    const reflection = (await call("get_reflection_evidence", {
      preset: "month",
      timezone: "UTC",
      sources: ["memories", "todos"],
    })).data;
    assert.ok(reflection.range);

    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_ctx',?,'sms','+17185551111','cnv_ctx',?,?)
    `).run(USER_ID, timestamp, timestamp);
    db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES('msg_ctx','thread_ctx','inbound','user','What did we decide?',NULL,'received','{}',?,?)
    `).run(timestamp, timestamp);
    const context = (await call("get_conversation_context", { thread_id: "thread_ctx", limit: 5 })).data;
    assert.equal(context.messages[0].content, "What did we decide?");

    await call("delete_memory", { id: memory.id }, 409);
    assert.equal((await call("delete_memory", { id: memory.id, confirmed: true })).data.id, memory.id);
    await call("delete_todo", { id: created.id }, 409);
    assert.equal((await call("delete_todo", { id: created.id, confirmed: true })).data.id, created.id);

    const exercised = new Set([
      "list_life_areas", "create_todo", "get_todo", "list_todos", "update_todo", "set_todo_status",
      "create_reminder", "list_reminders", "update_reminder", "delete_reminder", "create_memory",
      "get_memory", "update_memory", "get_agenda", "get_review_evidence", "get_reflection_evidence",
      "get_conversation_context", "delete_memory", "delete_todo",
      ...remote,
    ]);
    assert.deepEqual(declared.filter(name => !exercised.has(name)), [], "every declared tool must be covered");
  });

  /**
   * `memories` and `todos` hold only what the user ticked on the Reflections
   * page, so on an account that has never curated a reflection by hand they are
   * empty no matter how much got done. The tool used to strip the candidate
   * lists as well, which left the evening check-in with an all-empty payload and
   * no way to tell "nothing was selected" from "nothing happened": it told a
   * user who had closed a task out that hours earlier that their day was empty.
   */
  it("reports a todo completed today even though nothing is selected for the reflection", async () => {
    const { api, db } = fixture();
    const call = async (name: string, input: object = {}, expected = 200) =>
      (await api.post(`/api/agent/tools/${name}`).send(input).expect(expected)).body;

    const todo = (await call("create_todo", { title: "Review the backlog cleanup" })).data;
    assert.ok((await call("set_todo_status", { id: todo.id, status: "done" })).data.completed_at);
    assert.equal(
      (db.prepare("SELECT count(*) count FROM reflection_selections").get() as { count: number }).count,
      0,
      "the failure only shows up when the user has never selected evidence by hand",
    );

    const evidence = (await call("get_reflection_evidence", {
      preset: "today",
      timezone: "UTC",
      sources: ["memories", "todos"],
    })).data;
    assert.deepEqual(evidence.todos, [], "selection stays a user action, so the curated list is still empty");
    assert.deepEqual(
      evidence.todo_candidates.map((row: { id: string }) => row.id),
      [todo.id],
      "but what actually got finished today has to reach the agent",
    );
    assert.equal(evidence.candidate_totals.todos, 1);
  });

  /**
   * The agent is instructed to send RFC 3339 with an explicit offset, while a
   * reminder row is stored in UTC. Every reminder tool used to match the two as
   * strings, so a write landed and then reported nothing back: the agent read
   * the empty result as a failure and told the user it could not create
   * reminders at all.
   */
  it("resolves a reminder written with a UTC offset rather than in Zulu time", async () => {
    const { api } = fixture();
    const call = async (name: string, input: object = {}, expected = 200) =>
      (await api.post(`/api/agent/tools/${name}`).send(input).expect(expected)).body;

    const todo = (await call("create_todo", { title: "Finish the process doc" })).data;
    const created = (await call("create_reminder", {
      todo_id: todo.id,
      reminder_at: "2030-08-06T09:00:00-04:00",
      slot: "extra",
    })).data;
    assert.equal(created?.scheduled_for, "2030-08-06T13:00:00.000Z", "the write has to report the row it made");

    const listed = (await call("list_reminders", {
      from: "2030-08-06T00:00:00-04:00",
      to: "2030-08-06T23:59:59-04:00",
    })).data;
    assert.ok(
      listed.some((row: { id: string }) => row.id === created.id),
      "a local day range has to cover an evening reminder UTC already calls tomorrow",
    );

    const moved = (await call("update_reminder", {
      id: created.id,
      reminder_at: "2030-08-06T15:00:00-04:00",
    })).data;
    assert.equal(moved?.scheduled_for, "2030-08-06T19:00:00.000Z");
    assert.deepEqual(
      (await call("get_todo", { id: todo.id })).data.todo.extra_reminders,
      ["2030-08-06T15:00:00-04:00"],
      "rescheduling replaces the extra reminder instead of stacking a second one",
    );

    await call("delete_reminder", { id: moved.id, confirmed: true });
    assert.deepEqual(
      (await call("get_todo", { id: todo.id })).data.todo.extra_reminders,
      [],
      "a deleted extra reminder must not survive to be recreated on the next sync",
    );
    assert.deepEqual(
      (await call("list_reminders", { from: "2030-01-01T00:00:00Z", to: "2031-01-01T00:00:00Z" })).data,
      [],
    );
  });

  it("maps caller mistakes onto real status codes instead of 500", async () => {
    const { api } = fixture();
    const unknown = await api.post("/api/agent/tools/drop_database").send({}).expect(400);
    assert.match(unknown.body.error, /Unsupported tool: drop_database/);
    await api.post("/api/agent/tools/create_todo").send({ title: "" }).expect(400);

    const missing = await api.post("/api/agent/tools/get_todo").send({ id: "todo_missing" }).expect(404);
    assert.equal(missing.body.error, "Todo not found");
    await api.post("/api/agent/tools/get_memory").send({ id: "mem_missing" }).expect(404);
    await api.post("/api/agent/tools/update_reminder")
      .send({ id: "rem_missing", reminder_at: "2030-01-01T00:00:00.000Z" }).expect(404);
  });
});

describe("todo and reminder REST edges", () => {
  /**
   * Closing a parent is a judgement call, so the cascade is a preference rather
   * than a rule, and the same preference governs the REST route and the agent.
   */
  it("closes the parent with its last subtask only when asked to", async () => {
    const { api } = fixture();
    const parent = (await api.post("/api/todos").send({
      title: "Ship the release",
      subtasks: [{ title: "Cut the branch" }, { title: "Write the notes" }],
    }).expect(201)).body.data;
    const subtasks = (await api.get(`/api/todos/${parent.id}`).expect(200)).body.data.subtasks;

    await api.patch(`/api/todos/${subtasks[0].id}/status`).send({ status: "done" }).expect(200);
    await api.patch(`/api/todos/${subtasks[1].id}/status`).send({ status: "done" }).expect(200);
    assert.equal(
      (await api.get(`/api/todos/${parent.id}`).expect(200)).body.data.todo.status,
      "pending",
      "a parent stays open by default, because it can carry work of its own",
    );

    await api.put("/api/integrations/tasks").send({ autoCompleteParent: true }).expect(200);
    await api.patch(`/api/todos/${subtasks[1].id}/status`).send({ status: "pending" }).expect(200);
    await api.patch(`/api/todos/${subtasks[1].id}/status`).send({ status: "done" }).expect(200);
    const closed = (await api.get(`/api/todos/${parent.id}`).expect(200)).body.data.todo;
    assert.equal(closed.status, "done");
    assert.ok(closed.completed_at, "the parent is stamped with the moment its last step landed");
  });

  /**
   * Only top-level rows are drawn, so a hidden parent takes its unfinished
   * children off the board with it.
   */
  it("keeps a finished parent listed while its subtasks are still open", async () => {
    const { api } = fixture();
    const parent = (await api.post("/api/todos").send({
      title: "Close the quarter",
      subtasks: [{ title: "File the report" }],
    }).expect(201)).body.data;
    await api.patch(`/api/todos/${parent.id}/status`).send({ status: "done" }).expect(200);

    const listed = (await api.get("/api/todos?includeDone=false").expect(200)).body.data as Array<{ title: string }>;
    assert.deepEqual(
      listed.map(todo => todo.title).sort(),
      ["Close the quarter", "File the report"],
    );

    await api.post("/api/todos").send({ title: "Nothing owed", status: "done" }).expect(201);
    const withoutChildren = (await api.get("/api/todos?includeDone=false").expect(200)).body.data as Array<{ title: string }>;
    assert.ok(
      !withoutChildren.some(todo => todo.title === "Nothing owed"),
      "a finished task that owes nothing still drops out of the view",
    );
  });

  it("patches a todo field by field and keeps reminders in step", async () => {
    const { api, db } = fixture();
    const created = (await api.post("/api/todos").send({
      title: "Write the outline",
      notes: "Three acts",
      priority: "low",
      due_at: "2030-05-01T12:00:00.000Z",
    }).expect(201)).body.data;

    const patched = (await api.patch(`/api/todos/${created.id}`)
      .send({ title: "Write the talk", reminder_at: "2030-04-30T12:00:00.000Z" }).expect(200)).body.data;
    assert.equal(patched.title, "Write the talk");
    assert.equal(patched.notes, "Three acts", "an omitted field is left alone rather than nulled");
    assert.equal(patched.priority, "low");
    assert.deepEqual(
      (db.prepare("SELECT kind FROM reminders WHERE todo_id=? ORDER BY kind").all(created.id) as Array<{ kind: string }>)
        .map(row => row.kind),
      ["due", "pre"],
      "a patched reminder_at has to materialise a reminder row",
    );

    const cleared = (await api.patch(`/api/todos/${created.id}`).send({ notes: null }).expect(200)).body.data;
    assert.equal(cleared.notes, null, "an explicit null clears the column");

    await api.patch(`/api/todos/${created.id}`).send({ parent_id: created.id }).expect(400);
    await api.patch("/api/todos/todo_missing").send({ title: "Nope" }).expect(404);
    await api.patch(`/api/todos/${created.id}`).send({ priority: "critical" }).expect(400);

    const done = (await api.patch(`/api/todos/${created.id}/status`).send({ status: "done" }).expect(200)).body.data;
    assert.ok(done.completed_at, "finishing a todo stamps completed_at");
    assert.equal(
      (db.prepare("SELECT count(*) count FROM reminders WHERE todo_id=? AND status='pending'").get(created.id) as { count: number }).count,
      0,
      "a completed todo must not keep pending reminders queued",
    );
  });

  it("refuses reminders in the past and reschedules the rest", async () => {
    const { api } = fixture();
    const todo = (await api.post("/api/todos").send({ title: "Ship the deck" }).expect(201)).body.data;
    await api.post("/api/reminders")
      .send({ todo_id: todo.id, reminder_at: "2020-01-01T00:00:00.000Z" }).expect(400);
    await api.post("/api/reminders")
      .send({ todo_id: "todo_missing", reminder_at: "2030-01-01T00:00:00.000Z" }).expect(404);

    const reminder = (await api.post("/api/reminders")
      .send({ todo_id: todo.id, reminder_at: "2030-01-01T00:00:00.000Z", slot: "extra" }).expect(201)).body.data;
    assert.equal(reminder.scheduled_for, "2030-01-01T00:00:00.000Z");

    const listed = (await api.get("/api/reminders?from=2029-01-01T00:00:00.000Z&to=2031-01-01T00:00:00.000Z")
      .expect(200)).body.data;
    assert.ok(listed.some((row: { id: string }) => row.id === reminder.id));
    const outside = (await api.get("/api/reminders?to=2025-01-01T00:00:00.000Z").expect(200)).body.data;
    assert.deepEqual(outside, []);

    await api.patch(`/api/reminders/${reminder.id}`).send({ reminder_at: "2020-01-01T00:00:00.000Z" }).expect(400);
    await api.patch("/api/reminders/rem_missing").send({ reminder_at: "2030-06-01T00:00:00.000Z" }).expect(404);
    const moved = (await api.patch(`/api/reminders/${reminder.id}`)
      .send({ reminder_at: "2030-06-01T00:00:00.000Z" }).expect(200)).body.data;
    assert.equal(moved.scheduled_for ?? moved.reminder?.scheduled_for, "2030-06-01T00:00:00.000Z");
  });
});

describe("admin controls", () => {
  it("seeds, reindexes, configures Algolia, and resets behind a typed confirmation", async () => {
    const { api, db } = fixture();
    await api.post("/api/admin/seed").send({ confirmation: "PLEASE" }).expect(400);
    assert.equal((await api.post("/api/admin/seed").send({ confirmation: "SEED" }).expect(200)).body.data.seeded, true);
    assert.ok((db.prepare("SELECT count(*) count FROM todos").get() as { count: number }).count > 0);

    assert.deepEqual((await api.post("/api/admin/reindex").expect(200)).body.data, { queued: 0, processed: 0 });
    assert.deepEqual(
      (await api.post("/api/admin/algolia/setup").expect(200)).body.data,
      { configured: false, details: { reason: "test" } },
    );

    await api.post("/api/admin/reset").send({ confirmation: "SEED" }).expect(400);
    assert.equal((await api.post("/api/admin/reset").send({ confirmation: "RESET" }).expect(200)).body.data.reset, true);
    assert.equal((db.prepare("SELECT count(*) count FROM todos").get() as { count: number }).count, 0);
    assert.ok(
      (db.prepare("SELECT count(*) count FROM life_areas").get() as { count: number }).count > 0,
      "a reset clears content but keeps the taxonomy",
    );
  });
});

describe("categories and life areas", () => {
  it("creates, edits, and deletes categories", async () => {
    const { api } = fixture();
    const created = (await api.post("/api/categories")
      .send({ kind: "todo", name: "Deep work", color: "#315b47" }).expect(201)).body.data;
    assert.equal(created.icon, null);
    assert.ok((await api.get("/api/categories").expect(200)).body.data
      .some((row: { id: string }) => row.id === created.id));

    const patched = (await api.patch(`/api/categories/${created.id}`)
      .send({ name: "Focus", icon: "brain" }).expect(200)).body.data;
    assert.deepEqual(
      { name: patched.name, icon: patched.icon, color: patched.color },
      { name: "Focus", icon: "brain", color: "#315b47" },
      "unspecified fields keep their previous value",
    );

    await api.patch(`/api/categories/${created.id}`).send({}).expect(400);
    await api.patch("/api/categories/cat_missing").send({ name: "Nope" }).expect(404);
    await api.delete(`/api/categories/${created.id}`).expect(200);
    await api.delete(`/api/categories/${created.id}`).expect(404);
  });

  it("derives unique slugs and protects the built-in life areas", async () => {
    const { api } = fixture();
    const first = (await api.post("/api/life-areas")
      .send({ name: "Side Project", color: "#7a5c91" }).expect(201)).body.data;
    assert.equal(first.slug, "side-project-2", "the built-in side-project slug is already taken");
    const second = (await api.post("/api/life-areas")
      .send({ name: "Side Project", color: "#7a5c91" }).expect(201)).body.data;
    assert.equal(second.slug, "side-project-3");

    const renamed = (await api.patch(`/api/life-areas/${first.id}`)
      .send({ name: "Music" }).expect(200)).body.data;
    assert.equal(renamed.slug, "side-project-2", "renaming must not move existing references");
    assert.equal(renamed.is_builtin, 0);
    await api.patch("/api/life-areas/area_missing").send({ name: "Nope" }).expect(404);
    await api.post("/api/life-areas").send({ name: "Bad", color: "not-a-hex" }).expect(400);

    const builtin = (await api.get("/api/life-areas").expect(200)).body.data
      .find((area: { slug: string }) => area.slug === "work");
    await api.delete(`/api/life-areas/${builtin.id}`).expect(409);
    await api.delete("/api/life-areas/area_missing").expect(404);
  });

  it("unassigns and reindexes content when a life area is deleted", async () => {
    const { api, db } = fixture();
    const area = (await api.post("/api/life-areas")
      .send({ name: "Sabbatical", color: "#315b47" }).expect(201)).body.data;
    const todo = (await api.post("/api/todos")
      .send({ title: "Plan the trip", life_area_id: area.id }).expect(201)).body.data;
    const memory = (await api.post("/api/memories")
      .send({ content: "Booked flights", life_area_id: area.id }).expect(201)).body.data;
    db.prepare("UPDATE index_jobs SET status='done'").run();

    await api.delete(`/api/life-areas/${area.id}`).expect(200);
    assert.equal(getTodo(db, todo.id)?.life_area_id, null);
    const requeued = db.prepare(`
      SELECT entity_id FROM index_jobs WHERE status='pending' ORDER BY entity_id
    `).all() as Array<{ entity_id: string }>;
    assert.deepEqual(
      requeued.map(row => row.entity_id).sort(),
      [memory.id, todo.id].sort(),
      "orphaned rows have to be reprojected so Algolia drops the stale life area",
    );
  });
});

describe("Granola ingestion", () => {
  const note = { id: "granola_1", title: "Pricing sync", summary: "Agreed to ship tiered pricing." };

  function stubFetch(handler: (url: string) => Response) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      handler(String(input))) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  it("rejects a bad API key and stores a working one", async () => {
    const { api, db } = fixture();
    let restore = stubFetch(() => new Response("nope", { status: 401 }));
    try {
      const rejected = await api.post("/api/integrations/granola/connect")
        .send({ apiKey: "wrong-api-key-value" }).expect(400);
      assert.match(rejected.body.error, /Granola rejected the API key \(401\)/);
    } finally { restore(); }
    assert.equal((await api.get("/api/integrations").expect(200)).body.data.granola.configured, false);

    restore = stubFetch(() => new Response(JSON.stringify({ notes: [note] }), { status: 200 }));
    try {
      const connected = await api.post("/api/integrations/granola/connect")
        .send({ apiKey: "correct-api-key-value" }).expect(200);
      assert.equal(connected.body.data.config.configured, true);
      assert.deepEqual(connected.body.data.poll, { fetched: 1, queued: 1 });
      assert.equal(JSON.stringify(connected.body).includes("correct-api-key-value"), false);

      const repolled = await api.post("/api/integrations/granola/poll").expect(200);
      assert.deepEqual(repolled.body.data, { fetched: 1, queued: 0 }, "the same note must not requeue");
    } finally { restore(); }

    await api.delete("/api/integrations/granola").expect(200);
    assert.equal(
      (db.prepare("SELECT status FROM integration_settings WHERE provider='granola'").get() as { status: string }).status,
      "disconnected",
    );
  });

  it("turns a reviewed event into a memory and can ignore the rest", async () => {
    const { api, db } = fixture();
    enqueueExternalEvent(db, "granola", note.id, "granola.note.updated", note);
    enqueueExternalEvent(db, "granola", "granola_2", "granola.note.updated", { id: "granola_2" });

    type EventSummary = { id: string; externalId: string; payload: { title?: string } };
    const events: EventSummary[] = (await api.get("/api/integrations/events?limit=10").expect(200)).body.data;
    assert.equal(events.length, 2);
    const withNotes = events.find(event => event.externalId === note.id)!;
    const empty = events.find(event => event.externalId === "granola_2")!;
    assert.equal(withNotes.payload.title, "Pricing sync");
    await api.get("/api/integrations/events?limit=0").expect(400);

    const reviewed = await api.post(`/api/integrations/events/${withNotes.id}/review`)
      .send({ action: "create_memory" }).expect(200);
    assert.equal(reviewed.body.data.memory.title, "Pricing sync");
    assert.equal(reviewed.body.data.memory.content, "Agreed to ship tiered pricing.");
    assert.deepEqual(reviewed.body.data.memory.tags, ["granola", "meeting"]);

    const ignored = await api.post(`/api/integrations/events/${empty.id}/review`)
      .send({ action: "ignore" }).expect(200);
    assert.deepEqual(ignored.body.data, { ignored: true });
    assert.deepEqual(
      (db.prepare("SELECT external_id,status FROM external_events ORDER BY external_id")
        .all() as Array<{ external_id: string; status: string }>),
      [{ external_id: "granola_1", status: "processed" }, { external_id: "granola_2", status: "ignored" }],
    );

    await api.post("/api/integrations/events/event_missing/review").send({ action: "ignore" }).expect(404);
    await api.post(`/api/integrations/events/${empty.id}/review`).send({ action: "delete" }).expect(400);
  });

  it("records a polling failure against the integration instead of crashing the worker", async () => {
    const { db } = fixture();
    saveGranolaConfig(db, { apiKey: "granola-api-key-value" });
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async () => ({ sid: "SM_x", status: "queued" }),
      runSmsAgent: async () => ({ text: "", threadId: "t" }),
      pollGranola: async () => { throw new Error("Granola API failed (500)"); },
    });
    const row = db.prepare(`
      SELECT status,last_error FROM integration_settings WHERE provider='granola'
    `).get() as { status: string; last_error: string };
    assert.equal(row.status, "error");
    assert.match(row.last_error, /Granola API failed \(500\)/);
  });
});

describe("Twilio webhooks and controls", () => {
  function connectedFixture() {
    const context = fixture();
    saveTwilioConfig(context.db, {
      accountSid: "AC11111111111111111111111111111111",
      authToken: "super-secret-auth-token",
      fromPhone: "+17185550000",
      webhookBaseUrl: "https://assistant.example.com",
    });
    return context;
  }

  it("rejects an unsigned webhook with 403 once validation is enforced", async () => {
    const { api } = connectedFixture();
    delete process.env.TWILIO_SKIP_SIGNATURE_VALIDATION;
    try {
      const sms = await api.post("/api/webhooks/twilio/sms").type("form").send({
        From: "+17185551111",
        Body: "hello",
        MessageSid: "SM_unsigned",
      }).expect(403);
      assert.match(sms.text, /Invalid Twilio signature/);

      await api.post("/api/webhooks/twilio/sms").type("form")
        .set("x-twilio-signature", "not-a-real-signature")
        .send({ From: "+17185551111", Body: "hello", MessageSid: "SM_forged" })
        .expect(403);

      await api.post("/api/webhooks/twilio/status").type("form")
        .send({ MessageSid: "SM_unsigned", MessageStatus: "delivered" })
        .expect(403);
    } finally {
      process.env.TWILIO_SKIP_SIGNATURE_VALIDATION = "true";
    }
  });

  it("ignores webhooks entirely when Twilio is not connected", async () => {
    const { api } = fixture();
    const sms = await api.post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "+17185551111", Body: "hi", MessageSid: "SM_none" }).expect(503);
    assert.match(sms.text, /<Response><\/Response>/);
    await api.post("/api/webhooks/twilio/status").type("form")
      .send({ MessageSid: "SM_none", MessageStatus: "delivered" }).expect(204);
  });

  it("validates inbound fields and the allowed sender", async () => {
    const { api, db } = connectedFixture();
    await api.post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "+17185551111", MessageSid: "SM_empty", Body: "   " }).expect(400);

    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    const stranger = await api.post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "+15550000000", Body: "let me in", MessageSid: "SM_stranger" }).expect(403);
    assert.match(stranger.text, /not allowed/);

    await api.post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "+17185551111", Body: "STOP", MessageSid: "SM_stop" }).expect(200);
    assert.ok(getNotificationPreferences(db).optedOutAt, "STOP records an opt-out timestamp");
    await api.post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "+17185551111", Body: "start", MessageSid: "SM_start" }).expect(200);
    assert.equal(getNotificationPreferences(db).optedOutAt, null);
    assert.equal(getNotificationPreferences(db).smsEnabled, true);
  });

  it("maps delivery receipts onto messages and failed reminders", async () => {
    const { api, db } = connectedFixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_status',?,'sms','+17185551111','cnv_status',?,?)
    `).run(USER_ID, timestamp, timestamp);
    db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES('msg_status','thread_status','outbound','assistant','Reminder: Ship it','SM_track','queued','{}',?,?)
    `).run(timestamp, timestamp);
    const todo = (await api.post("/api/todos")
      .send({ title: "Ship it", reminder_at: "2030-01-01T00:00:00.000Z" }).expect(201)).body.data;
    db.prepare("UPDATE reminders SET provider_message_id='SM_track' WHERE todo_id=?").run(todo.id);

    await api.post("/api/webhooks/twilio/status").type("form")
      .send({ MessageSid: "SM_track", MessageStatus: "sent" }).expect(204);
    assert.equal(
      (db.prepare("SELECT status FROM channel_messages WHERE id='msg_status'").get() as { status: string }).status,
      "sent",
    );

    await api.post("/api/webhooks/twilio/status").type("form")
      .send({ MessageSid: "SM_track", MessageStatus: "undelivered", ErrorMessage: "Carrier rejected" })
      .expect(204);
    const reminder = db.prepare("SELECT status,last_error FROM reminders WHERE todo_id=?").get(todo.id) as {
      status: string; last_error: string;
    };
    assert.deepEqual(reminder, { status: "failed", last_error: "Carrier rejected" });
  });

  it("requires a recipient before sending the connection test and can disconnect", async () => {
    const { api, db } = connectedFixture();
    const missing = await api.post("/api/integrations/twilio/test").expect(400);
    assert.match(missing.body.error, /recipient phone number/i);

    await api.put("/api/integrations/notifications").send({
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "Mars/Olympus",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    }).expect(400);

    await api.delete("/api/integrations/twilio").expect(200);
    assert.equal((await api.get("/api/integrations").expect(200)).body.data.twilio.configured, false);
    assert.equal(getTwilioSecret(db), null);
  });
});

describe("Sendblue provider", () => {
  const RECIPIENT = "+17185551111";
  const LINE = "+15551234567";
  const SECRET = "webhook-secret-value";
  const CREDENTIALS = {
    apiKeyId: "sendblue-key-id",
    apiSecret: "sendblue-api-secret",
    fromPhone: LINE,
  };

  type Call = { url: URL; method: string; body: Record<string, unknown> };

  /**
   * Sendblue is reached with plain `fetch`, so the whole account is a routing
   * table keyed by path. Every call is recorded because what the app sends
   * matters as much as what it does with the reply: the registered webhook URL
   * and the per-message status callback both have to carry the secret.
   */
  function stubSendblue(routes: Record<string, (call: Call) => Response>) {
    const original = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const call = { url, method: init?.method || "GET", body };
      calls.push(call);
      const route = routes[url.pathname];
      return route
        ? route(call)
        : new Response(JSON.stringify({ message: `no stub for ${url.pathname}` }), { status: 404 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const lines = () => json({ lines: [{ number: LINE, label: "Shared" }] });
  const accepted = (handle = "SB_handle") =>
    json({ message_handle: handle, status: "QUEUED", error_code: null });

  /** Skips the connect handshake for cases about delivery rather than setup. */
  function connectedFixture(provider: "twilio" | "sendblue" = "sendblue") {
    const context = fixture();
    saveSendblueConfig(context.db, {
      ...CREDENTIALS,
      webhookBaseUrl: "https://assistant.example.com",
      webhookSecret: SECRET,
    }, { webhooksRegistered: true, autoTypingIndicator: true, autoMarkRead: true });
    saveNotificationPreferences(context.db, {
      smsEnabled: true,
      recipientPhone: RECIPIENT,
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    setSmsProvider(context.db, provider);
    return context;
  }

  it("connects against the account lines and registers a secured webhook", async () => {
    const { api, db } = fixture();
    const stub = stubSendblue({
      "/api/lines": lines,
      "/api/account/webhooks": () => json({ status: "OK" }),
      "/accounts/settings/auto-typing-indicator": () => json({ status: "OK" }),
      "/accounts/settings/auto-mark-read": () => json({ status: "OK" }),
    });
    let result;
    try {
      result = await api.post("/api/integrations/sendblue/connect").send({
        ...CREDENTIALS,
        webhookBaseUrl: "https://assistant.example.com",
        configureWebhooks: true,
      }).expect(200);
    } finally { stub.restore(); }

    assert.equal(result.body.data.config.configured, true);
    assert.equal(result.body.data.config.fromPhone, LINE);
    assert.equal(result.body.data.config.webhooksRegistered, true);
    assert.equal(
      JSON.stringify(result.body).includes(CREDENTIALS.apiSecret),
      false,
      "the API secret is stored encrypted and never echoed",
    );
    assert.equal(result.body.data.config.autoTypingIndicator, true);
    assert.equal(result.body.data.config.autoMarkRead, true);
    assert.deepEqual(result.body.data.notes, []);
    const registrations = stub.calls.filter(call =>
      call.url.pathname === "/api/account/webhooks" && call.method === "POST");
    assert.deepEqual(
      registrations.map(call => call.body.type),
      ["receive", "line_blocked", "line_assigned"],
      "a blocked or reassigned line is otherwise a silent outage",
    );
    const registered = (registrations[0].body.webhooks as Array<{ url: string; secret: string }>)[0];
    assert.match(registered.url, /^https:\/\/assistant\.example\.com\/api\/webhooks\/sendblue\/inbound\?token=/);
    assert.equal(
      registered.secret,
      new URL(registered.url).searchParams.get("token"),
      "the URL token and the header secret have to be the same value to verify either one",
    );
    const stored = getSendblueSecret(db);
    assert.equal(stored?.apiSecret, CREDENTIALS.apiSecret);
    assert.equal(stored?.webhookSecret, registered.secret);
  });

  it("clears its own stale webhook URLs and leaves hand-added ones alone", async () => {
    const { api } = fixture();
    const staleTunnel = "https://old-tunnel.ngrok-free.app/api/webhooks/sendblue/inbound?token=old";
    const stub = stubSendblue({
      "/api/lines": lines,
      "/api/account/webhooks": call => call.method === "GET"
        ? json({
          status: "OK",
          webhooks: {
            receive: [{ url: staleTunnel, secret: "old" }, "https://ops.example.com/audit"],
            globalSecret: "account-wide",
          },
        })
        : json({ status: "OK" }),
      "/accounts/settings/auto-typing-indicator": () => json({ status: "OK" }),
      "/accounts/settings/auto-mark-read": () => json({ status: "OK" }),
    });
    try {
      await api.post("/api/integrations/sendblue/connect").send({
        ...CREDENTIALS,
        webhookBaseUrl: "https://assistant.example.com",
        configureWebhooks: true,
      }).expect(200);
    } finally { stub.restore(); }

    const deletes = stub.calls.filter(call => call.method === "DELETE");
    assert.deepEqual(
      deletes.map(call => call.body.webhooks),
      [[staleTunnel]],
      "registration appends, so a dead tunnel URL would keep receiving retries forever",
    );
  });

  it("connects when Sendblue refuses to enable read receipts", async () => {
    const { api } = fixture();
    const stub = stubSendblue({
      "/api/lines": lines,
      "/accounts/settings/auto-typing-indicator": () => json({ status: "OK" }),
      "/accounts/settings/auto-mark-read": () =>
        json({ status: "ERROR", message: "Read receipts are not enabled for this account" }, 403),
    });
    let result;
    try {
      result = await api.post("/api/integrations/sendblue/connect").send(CREDENTIALS).expect(200);
    } finally { stub.restore(); }

    assert.equal(result.body.data.config.configured, true, "an acknowledgement is not worth failing a connection over");
    assert.equal(result.body.data.config.autoTypingIndicator, true);
    assert.equal(result.body.data.config.autoMarkRead, false);
    assert.match(result.body.data.notes[0], /Read receipts stayed off.*not enabled for this account/);
  });

  it("records a blocked line and a reassigned line, and rejects unverified line events", async () => {
    const { api, db } = connectedFixture();
    await api.post("/api/webhooks/sendblue/line-blocked").send({ number: LINE }).expect(403);
    assert.equal(
      (await api.get("/api/integrations").expect(200)).body.data.sendblue.lastError,
      undefined,
      "an unverified caller cannot post a notice into the Settings card",
    );

    await api.post(`/api/webhooks/sendblue/line-blocked?token=${SECRET}`)
      .send({ number: LINE, message: "Reported as spam" }).expect(200);
    const blocked = await api.get("/api/integrations").expect(200);
    assert.match(blocked.body.data.sendblue.lastError, /blocked.*Reported as spam/);
    assert.equal(
      blocked.body.data.sendblue.configured,
      true,
      "the credentials still work, so the connection stays usable while the trouble shows",
    );

    // A reassignment to the number already in use is the normal case on a shared line.
    await api.post(`/api/webhooks/sendblue/line-assigned?token=${SECRET}`).send({ number: LINE }).expect(200);
    await api.post(`/api/webhooks/sendblue/line-assigned?token=${SECRET}`)
      .send({ number: "+15129990000" }).expect(200);
    assert.match(
      (await api.get("/api/integrations").expect(200)).body.data.sendblue.lastError,
      /assigned line \+15129990000.*Reconnect Sendblue/s,
    );
    assert.equal(getSendblueSecret(db)?.fromPhone, LINE, "the stored line is not rewritten from a webhook payload");
  });

  it("refuses a number that is not on the account and credentials the API rejects", async () => {
    const { api } = fixture();
    const wrongNumber = stubSendblue({ "/api/lines": lines });
    try {
      const rejected = await api.post("/api/integrations/sendblue/connect")
        .send({ ...CREDENTIALS, fromPhone: "+15550001111" }).expect(400);
      assert.match(rejected.body.error, /not a line on this Sendblue account/);
    } finally { wrongNumber.restore(); }

    const unauthorized = stubSendblue({
      "/api/lines": () => json({ status: "ERROR", message: "Unauthorized" }, 401),
    });
    try {
      const rejected = await api.post("/api/integrations/sendblue/connect").send(CREDENTIALS).expect(400);
      assert.match(rejected.body.error, /401/);
      assert.match(rejected.body.error, /Unauthorized/);
    } finally { unauthorized.restore(); }

    assert.equal((await api.get("/api/integrations").expect(200)).body.data.sendblue.configured, false);
  });

  it("surfaces a non-JSON rejection and still connects when the lines cannot be read", async () => {
    const { api } = fixture();
    const gateway = stubSendblue({ "/api/lines": () => new Response("gateway timeout", { status: 502 }) });
    try {
      const rejected = await api.post("/api/integrations/sendblue/connect").send(CREDENTIALS).expect(400);
      assert.match(rejected.body.error, /502/);
      assert.match(rejected.body.error, /gateway timeout/);
    } finally { gateway.restore(); }

    // An account whose lines come back in a shape this app cannot read still
    // connects: the number is checked when it can be, not gated on it.
    const unreadable = stubSendblue({ "/api/lines": () => json({ lines: [{ id: "line_1" }] }) });
    try {
      const connected = await api.post("/api/integrations/sendblue/connect").send(CREDENTIALS).expect(200);
      assert.deepEqual(connected.body.data.lines, []);
      assert.equal(connected.body.data.config.configured, true);
    } finally { unreadable.restore(); }
  });

  it("only sends through the provider that is selected, and refuses one that is not connected", async () => {
    const { api, db } = connectedFixture("twilio");
    assert.equal(getNotificationPreferences(db).smsProvider, "twilio");

    const switched = await api.put("/api/integrations/sms-provider").send({ provider: "sendblue" }).expect(200);
    assert.equal(switched.body.data.smsProvider, "sendblue");

    const unavailable = await api.put("/api/integrations/sms-provider").send({ provider: "twilio" }).expect(400);
    assert.match(unavailable.body.error, /Connect Twilio/);
    assert.equal(getNotificationPreferences(db).smsProvider, "sendblue", "a refused switch changes nothing");

    saveTwilioConfig(db, {
      accountSid: "AC11111111111111111111111111111111",
      authToken: "super-secret-auth-token",
      fromPhone: "+17185550000",
    });
    await api.put("/api/integrations/sms-provider").send({ provider: "twilio" }).expect(200);
    assert.equal(getNotificationPreferences(db).smsProvider, "twilio");
  });

  it("delivers a due reminder as an iMessage with a secured status callback", async () => {
    const { db, api } = connectedFixture();
    await api.post("/api/todos")
      .send({ title: "Call the plumber", reminder_at: "2020-01-01T00:00:00.000Z" }).expect(201);
    const stub = stubSendblue({ "/api/send-message": () => accepted("SB_reminder") });
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        runSmsAgent: async () => ({ text: "unused", threadId: "thread" }),
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { stub.restore(); }

    const sent = stub.calls.find(call => call.url.pathname === "/api/send-message");
    assert.equal(sent?.body.number, RECIPIENT);
    assert.equal(sent?.body.from_number, LINE);
    assert.equal(sent?.body.content, "Reminder: Call the plumber");
    assert.equal(
      String(sent?.body.status_callback),
      `https://assistant.example.com/api/webhooks/sendblue/status?token=${SECRET}`,
    );
    const reminder = db.prepare("SELECT status,provider_message_id FROM reminders").get() as {
      status: string; provider_message_id: string;
    };
    assert.deepEqual(reminder, { status: "sent", provider_message_id: "SB_reminder" });
  });

  it("treats a declined message as a delivery failure rather than a send", async () => {
    const { db, api } = connectedFixture();
    await api.post("/api/todos")
      .send({ title: "Text an unverified contact", reminder_at: "2020-01-01T00:00:00.000Z" }).expect(201);
    // Sendblue answers 200 and reports the refusal in the body, so the outcome
    // has to be read from the payload or an undelivered message looks sent.
    const stub = stubSendblue({
      "/api/send-message": () => json({
        message_handle: "SB_declined",
        status: "DECLINED",
        error_code: 4000,
        error_message: "Recipient is not a verified contact",
      }),
    });
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        runSmsAgent: async () => ({ text: "unused", threadId: "thread" }),
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { stub.restore(); }

    const reminder = db.prepare("SELECT status,last_error FROM reminders").get() as {
      status: string; last_error: string;
    };
    assert.equal(reminder.status, "failed");
    assert.match(reminder.last_error, /not a verified contact/);
  });

  it("answers an inbound iMessage once and ignores an echo of its own reply", async () => {
    const { db, api } = connectedFixture();
    const inbound = {
      from_number: RECIPIENT,
      number: RECIPIENT,
      to_number: LINE,
      content: "add milk to my list",
      message_handle: "SB_inbound",
      is_outbound: false,
      service: "iMessage",
    };
    await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`).send(inbound).expect(200);
    await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`).send(inbound).expect(200);
    const echo = await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`)
      .send({ ...inbound, message_handle: "SB_echo", is_outbound: true }).expect(200);
    assert.equal(echo.body.ignored, "outbound");
    assert.equal(
      (db.prepare("SELECT count(*) count FROM external_events WHERE source='sendblue'").get() as { count: number }).count,
      1,
      "the message handle deduplicates a redelivered webhook",
    );

    const replies: string[] = [];
    const typing: string[] = [];
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async (_db: Db, to: string, body: string) => {
        replies.push(`${to}:${body}`);
        return { sid: "SB_reply", status: "queued" };
      },
      runSmsAgent: async () => ({ text: "Added milk.", threadId: "thread_sb" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
      startTypingIndicator: (_db: Db, to: string) => {
        typing.push(`start:${to}`);
        return { release: () => typing.push("release"), cancel: () => typing.push("cancel") };
      },
    });
    assert.deepEqual(replies, [`${RECIPIENT}:Added milk.`]);
    assert.deepEqual(
      typing,
      [`start:${RECIPIENT}`, "release", "cancel"],
      "the bubble goes up before the turn and comes down once the reply is out",
    );
    assert.equal(
      (db.prepare("SELECT status FROM external_events WHERE external_id='SB_inbound'").get() as { status: string }).status,
      "processed",
    );
  });

  it("asks for the typing indicator repeatedly so the first message after an idle gap gets a bubble", async () => {
    const { db } = connectedFixture();
    const indicator = () => json({ status: "SENT", number: RECIPIENT, error_message: null });
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const stub = stubSendblue({ "/api/send-typing-indicator": indicator });
    try {
      const typing = startSendblueTypingIndicator(db, RECIPIENT, [0, 5, 10]);
      await sleep(30);
      typing.cancel();
      await sleep(5);
    } finally { stub.restore(); }
    const sent = stub.calls.filter(call => call.url.pathname === "/api/send-typing-indicator");
    assert.deepEqual(
      sent.map(call => call.body.state),
      ["start", "start", "start", "stop"],
      "Sendblue drops an indicator sent over a cold conversation route and reports it as sent anyway",
    );
    assert.equal(sent[0].body.number, RECIPIENT);
    assert.equal(sent[0].body.from_number, LINE);
    assert.equal(sent[0].body.max_duration_ms, 120_000, "a slow agent turn outlasts the 60s default");

    const released = stubSendblue({ "/api/send-typing-indicator": indicator });
    try {
      const typing = startSendblueTypingIndicator(db, RECIPIENT, [0, 30]);
      await sleep(10);
      typing.release();
      await sleep(40);
    } finally { released.restore(); }
    assert.deepEqual(
      released.calls.map(call => call.body.state),
      ["start"],
      "a turn that finishes first must not raise a bubble the reply has already answered",
    );
  });

  it("reads a refused typing indicator out of the 200 it arrives in", async () => {
    const { db } = connectedFixture();
    const warn = console.warn;
    const capture = async (answer: () => Response) => {
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      const stub = stubSendblue({ "/api/send-typing-indicator": answer });
      try {
        startSendblueTypingIndicator(db, RECIPIENT, [0]);
        await new Promise(resolve => setTimeout(resolve, 20));
      } finally { stub.restore(); console.warn = warn; }
      return warnings.join("\n");
    };

    assert.match(
      await capture(() => json({ status: "ERROR", error_message: "No recent conversation" })),
      /No recent conversation/,
      "a refusal answers 200 like a send does, so it is invisible unless the body is read",
    );
    /*
     * Saying nothing has to mean the request was accepted and nothing else.
     * Otherwise a missing bubble leaves no way to tell an indicator Sendblue
     * dropped from a request it never understood.
     */
    assert.match(
      await capture(() => json({ ok: true })),
      /did not accept.*ok/s,
      "an answer in an unknown shape is not evidence the bubble went up",
    );
    // The reference documents `SENT` and the worked example answers `QUEUED`.
    assert.equal(await capture(() => json({ status: "SENT", error_message: null })), "");
    assert.equal(
      await capture(() => json({ status: "QUEUED", status_code: 200, error_message: null, number: RECIPIENT })),
      "",
    );
  });

  it("falls back to a bare start when the line's firmware refuses typing-v2", async () => {
    const { db } = connectedFixture();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    const stub = stubSendblue({
      "/api/send-typing-indicator": call => call.body.max_duration_ms || call.body.state
        ? json({
          status: "ERROR",
          status_code: 503,
          error_message: 'Worker firmware iowa-1.9.80 does not yet support typing-v2 state="stop".'
            + " Fleet update is rolling out; retry shortly.",
          number: RECIPIENT,
        }, 503)
        : json({ status: "QUEUED", status_code: 200, error_message: null, number: RECIPIENT }),
    });
    try {
      startSendblueTypingIndicator(db, RECIPIENT, [0]);
      await new Promise(resolve => setTimeout(resolve, 30));
    } finally { stub.restore(); console.warn = warn; }

    const bodies = stub.calls.map(call => call.body);
    assert.deepEqual(
      bodies.map(body => [body.state, body.max_duration_ms]),
      [["start", 120_000], [undefined, undefined]],
      "a bare start is documented to work on every firmware, so the bubble is still worth one ask",
    );
    assert.equal(bodies[1].number, RECIPIENT);
    assert.deepEqual(warnings, [], "a firmware too old for a duration is handled, not reported");
  });

  it("answers a new inbound message on the webhook instead of waiting out the poll interval", async () => {
    const { db, api } = connectedFixture();
    const replies: string[] = [];
    const stop = startWorker(db, fakeSearch(db), {
      sendSms: async (_db: Db, to: string, body: string) => {
        replies.push(`${to}:${body}`);
        return { sid: "SB_woken", status: "queued" };
      },
      runSmsAgent: async () => ({ text: "On it.", threadId: "thread_wake" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
      // This case is about the wake, and the real indicator would reach for the
      // network on the way through.
      startTypingIndicator: () => ({ release: () => {}, cancel: () => {} }),
    });
    try {
      // The startup tick has to finish first, or it would answer the message on
      // its own and the wake would prove nothing.
      await drainTicks();
      assert.deepEqual(replies, []);

      await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`).send({
        from_number: RECIPIENT,
        content: "what is on my list",
        message_handle: "SB_wake",
        is_outbound: false,
      }).expect(200);
      await drainTicks();

      assert.deepEqual(
        replies,
        [`${RECIPIENT}:On it.`],
        "the webhook woke the worker rather than leaving the reply for the 60s tick",
      );
      assert.equal(
        (db.prepare("SELECT status FROM external_events WHERE external_id='SB_wake'").get() as { status: string }).status,
        "processed",
      );
    } finally { stop(); }
  });

  it("rejects an inbound webhook without the secret, a stranger, and one with no connection", async () => {
    const { db, api } = connectedFixture();
    const inbound = { from_number: RECIPIENT, content: "hello", message_handle: "SB_unsigned" };
    await api.post("/api/webhooks/sendblue/inbound").send(inbound).expect(403);
    await api.post("/api/webhooks/sendblue/inbound?token=guessed").send(inbound).expect(403);
    // The secret is also accepted from a header, which is where Sendblue puts it
    // for a webhook that was registered outside this app.
    await api.post("/api/webhooks/sendblue/inbound")
      .set("sb-webhook-secret", SECRET).send(inbound).expect(200);

    const stranger = await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`)
      .send({ from_number: "+15550000000", content: "let me in", message_handle: "SB_stranger" }).expect(403);
    assert.equal(stranger.body.received, false);
    await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`)
      .send({ from_number: RECIPIENT, content: "   ", message_handle: "SB_empty" }).expect(400);

    await api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`)
      .send({ from_number: RECIPIENT, content: "STOP", message_handle: "SB_stop" }).expect(200);
    assert.ok(getNotificationPreferences(db).optedOutAt, "STOP records an opt-out timestamp");

    const disconnected = fixture();
    await disconnected.api.post(`/api/webhooks/sendblue/inbound?token=${SECRET}`).send(inbound).expect(503);
    await disconnected.api.post(`/api/webhooks/sendblue/status?token=${SECRET}`)
      .send({ message_handle: "SB_none", status: "DELIVERED" }).expect(204);
  });

  it("maps Sendblue delivery receipts onto messages and failed reminders", async () => {
    const { db, api } = connectedFixture();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
      VALUES('thread_sb_status',?,'sms',?,'cnv_sb',?,?)
    `).run(USER_ID, RECIPIENT, timestamp, timestamp);
    db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES('msg_sb','thread_sb_status','outbound','assistant','Reminder: Ship it','SB_track','queued','{}',?,?)
    `).run(timestamp, timestamp);
    const todo = (await api.post("/api/todos")
      .send({ title: "Ship it", reminder_at: "2030-01-01T00:00:00.000Z" }).expect(201)).body.data;
    db.prepare("UPDATE reminders SET provider_message_id='SB_track' WHERE todo_id=?").run(todo.id);

    await api.post(`/api/webhooks/sendblue/status?token=${SECRET}`)
      .send({ message_handle: "SB_track", status: "SENT" }).expect(204);
    assert.equal(
      (db.prepare("SELECT status FROM channel_messages WHERE id='msg_sb'").get() as { status: string }).status,
      "sent",
      "SENT is terminal for SMS but not for iMessage, so it stays distinct from delivered",
    );

    await api.post(`/api/webhooks/sendblue/status?token=${SECRET}`)
      .send({ message_handle: "SB_track", status: "ERROR", error_message: "Carrier rejected" }).expect(204);
    assert.deepEqual(
      db.prepare("SELECT status,last_error FROM reminders WHERE todo_id=?").get(todo.id),
      { status: "failed", last_error: "Carrier rejected" },
    );
  });

  it("requires a recipient before the connection test and can disconnect", async () => {
    const { api, db } = fixture();
    saveSendblueConfig(db, { ...CREDENTIALS, webhookSecret: SECRET }, {
      webhooksRegistered: false,
      autoTypingIndicator: false,
      autoMarkRead: false,
    });
    const missing = await api.post("/api/integrations/sendblue/test").expect(400);
    assert.match(missing.body.error, /recipient phone number/i);

    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: RECIPIENT,
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    const stub = stubSendblue({ "/api/send-message": () => accepted("SB_test") });
    try {
      const sent = await api.post("/api/integrations/sendblue/test").expect(200);
      assert.deepEqual(sent.body.data, { sid: "SB_test", status: "queued" });
    } finally { stub.restore(); }
    const withoutCallback = stub.calls.find(call => call.url.pathname === "/api/send-message");
    assert.equal(
      withoutCallback?.body.status_callback,
      undefined,
      "with no public URL there is nowhere for a receipt to land",
    );

    await api.delete("/api/integrations/sendblue").expect(200);
    assert.equal((await api.get("/api/integrations").expect(200)).body.data.sendblue.configured, false);
    assert.equal(getSendblueSecret(db), null);
  });
});

describe("Atlassian reads", () => {
  const CREDENTIALS = {
    siteUrl: "https://example.atlassian.net",
    email: "demo@example.com",
    apiToken: "atlassian-api-token-value",
  };
  const ME = { accountId: "acc_me", displayName: "Dana Scully" };
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const STATUSES = [
    { id: "10000", name: "To Do", statusCategory: { name: "To Do" } },
    { id: "3", name: "In Progress", statusCategory: { name: "In Progress" } },
    { id: "10083", name: "In Review", statusCategory: { name: "In Progress" } },
    { id: "13560", name: "Peer Review", statusCategory: { name: "In Progress" } },
  ];
  const ISSUE = {
    key: "GROW-12",
    fields: {
      summary: "Ship the picker",
      status: { name: "In Review", statusCategory: { name: "In Progress" } },
      assignee: { accountId: "acc_me", displayName: "Dana Scully" },
      priority: { name: "High" },
      issuetype: { name: "Task" },
      project: { key: "GROW" },
      duedate: null,
      updated: "2030-01-14T10:00:00.000Z",
    },
  };

  type Route = (url: URL) => Response | Promise<Response>;

  /**
   * A stubbed Atlassian site routed by path, so one case can span both products.
   * Longest prefix wins, because `/rest/api/3/status` and `/rest/api/3/search/jql`
   * would otherwise both match a shorter key.
   */
  function stubAtlassian(routes: Record<string, Route>) {
    const original = globalThis.fetch;
    const seen: string[] = [];
    const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(`${url.pathname}${url.search}`);
      const match = prefixes.find(prefix => url.pathname.startsWith(prefix));
      return match
        ? routes[match](url)
        : new Response(JSON.stringify({ errorMessages: [`no stub for ${url.pathname}`] }), { status: 404 });
    }) as typeof fetch;
    return { seen, restore: () => { globalThis.fetch = original; } };
  }

  const connected = {
    "/rest/api/3/myself": () => json(ME),
    "/wiki/rest/api/user/current": () => json(ME),
  } satisfies Record<string, Route>;

  async function connect(api: ReturnType<typeof fixture>["api"], routes: Record<string, Route>) {
    const stub = stubAtlassian({ ...connected, ...routes });
    try {
      await api.post("/api/integrations/atlassian/connect").send(CREDENTIALS).expect(200);
    } finally {
      // Connect and the tool calls need different stubs, so this only covers the
      // handshake; each test reinstalls its own.
      stub.restore();
    }
  }

  it("rejects credentials the site refuses and leaves the tools unavailable", async () => {
    const { api } = fixture();
    const stub = stubAtlassian({
      "/rest/api/3/myself": () => new Response("unauthorized", { status: 401 }),
      "/wiki/rest/api/user/current": () => new Response("unauthorized", { status: 401 }),
    });
    try {
      const rejected = await api.post("/api/integrations/atlassian/connect").send(CREDENTIALS).expect(400);
      assert.match(rejected.body.error, /401/);
      assert.match(rejected.body.error, /scoped token/, "the message has to name the likely cause");
    } finally { stub.restore(); }

    assert.equal((await api.get("/api/integrations").expect(200)).body.data.atlassian.configured, false);
    const unavailable = await api.post("/api/agent/tools/list_jira_boards").send({}).expect(503);
    assert.equal(unavailable.body.error, "Atlassian is not configured");
  });

  it("connects when only one product is licensed", async () => {
    const { api } = fixture();
    const stub = stubAtlassian({
      "/rest/api/3/myself": () => json(ME),
      "/wiki/rest/api/user/current": () => new Response("no license", { status: 403 }),
    });
    try {
      const result = await api.post("/api/integrations/atlassian/connect").send(CREDENTIALS).expect(200);
      assert.equal(result.body.data.config.jiraAvailable, true);
      assert.equal(result.body.data.config.confluenceAvailable, false);
      assert.equal(result.body.data.config.displayName, "Dana Scully");
      assert.equal(
        JSON.stringify(result.body).includes(CREDENTIALS.apiToken),
        false,
        "the token is stored encrypted and never echoed",
      );
    } finally { stub.restore(); }
  });

  it("resolves a board column to the status IDs behind it", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/agile/1.0/board/84/configuration": () => json({
        filter: { id: "12" },
        columnConfig: {
          columns: [
            { name: "To Do", statuses: [{ id: "10000" }] },
            // One column, two distinct statuses: exactly why a status category
            // cannot answer "what is in review".
            { name: "In Review", statuses: [{ id: "10083" }, { id: "13560" }] },
          ],
        },
      }),
      "/rest/agile/1.0/board": () => json({
        values: [{ id: 84, name: "Growth", type: "scrum", location: { projectKey: "GROW" } }],
        total: 1,
        isLast: true,
      }),
      "/rest/api/3/status": () => json(STATUSES),
    });
    try {
      const result = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "Grow", include_columns: true }).expect(200);
      const [board] = result.body.data.boards;
      assert.equal(board.id, 84);
      assert.deepEqual(board.columns[1], {
        name: "In Review",
        statuses: [
          { id: "10083", name: "In Review", category: "In Progress" },
          { id: "13560", name: "Peer Review", category: "In Progress" },
        ],
      });
    } finally { stub.restore(); }
  });

  it("routes a board query to the board endpoint and escapes the JQL it builds", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/software/1.0/board/84/issue": () => json({ issues: [ISSUE], isLast: true }),
      "/rest/api/3/search/jql": () => json({ issues: [] }),
    });
    try {
      const board = await api.post("/api/agent/tools/list_jira_issues")
        .send({ board_id: 84, assignee: "me", status_ids: ["10083", "13560"], limit: 10 }).expect(200);
      assert.equal(board.body.data.issues[0].key, "GROW-12");
      assert.equal(board.body.data.issues[0].url, "https://example.atlassian.net/browse/GROW-12");
      assert.equal(board.body.data.jql, "assignee = currentUser() AND status IN (10083, 13560) ORDER BY updated DESC");

      const escaped = await api.post("/api/agent/tools/list_jira_issues")
        .send({ project_key: "GROW", text: 'Ship "v2" \\ now', updated_within_days: 3 }).expect(200);
      assert.equal(
        escaped.body.data.jql,
        'project = "GROW" AND text ~ "Ship \\"v2\\" \\\\ now" AND updated >= -3d ORDER BY updated DESC',
      );

      // A bare ORDER BY is a 400 on the search endpoint, so an unfiltered query
      // still has to carry a bound.
      const unfiltered = await api.post("/api/agent/tools/list_jira_issues").send({}).expect(200);
      assert.equal(unfiltered.body.data.jql, "updated >= -30d ORDER BY updated DESC");
    } finally { stub.restore(); }
    assert.ok(
      stub.seen.some(path => path.startsWith("/rest/software/1.0/board/84/issue")),
      "board issues come from /rest/software/1.0, since the agile equivalent is being removed",
    );
    assert.ok(stub.seen.every(path => path.includes("fields=summary")), "an explicit field list is mandatory");
  });

  it("reads one issue with its recent transitions", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/api/3/issue/GROW-12": () => json({
        ...ISSUE,
        fields: {
          ...ISSUE.fields,
          labels: ["launch"],
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Pin the boards first." }] },
              { type: "paragraph", content: [{ type: "text", text: "Then ship." }] },
            ],
          },
        },
        changelog: {
          histories: [
            {
              created: "2030-01-14T09:00:00.000Z",
              author: { displayName: "Fox Mulder" },
              items: [
                { field: "status", fromString: "In Progress", toString: "In Review" },
                { field: "description", fromString: "old", toString: "new" },
              ],
            },
          ],
        },
      }),
    });
    try {
      const result = await api.post("/api/agent/tools/get_jira_issue")
        .send({ key: "GROW-12", include_recent_changes: true }).expect(200);
      assert.equal(result.body.data.description, "Pin the boards first.\nThen ship.");
      assert.deepEqual(result.body.data.recent_changes, [{
        at: "2030-01-14T09:00:00.000Z",
        by: "Fox Mulder",
        changes: [{ field: "status", from: "In Progress", to: "In Review" }],
      }], "only the fields a digest calls movement are kept");
    } finally { stub.restore(); }
  });

  it("reports an empty user search as unconfirmed rather than absent", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({ "/rest/api/3/user/search": () => json([]) });
    try {
      const result = await api.post("/api/agent/tools/list_jira_users")
        .send({ query: "mulder" }).expect(200);
      assert.deepEqual(result.body.data.users, []);
      assert.equal(
        result.body.data.permission_uncertain,
        true,
        "Jira answers 200 with an empty list when the account cannot browse users",
      );
    } finally { stub.restore(); }
  });

  it("resolves a real person and leaves app accounts out", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/api/3/user/search": () => json([
        { accountId: "acc_fox", accountType: "atlassian", displayName: "Fox Mulder", emailAddress: null, active: true },
        { accountId: "acc_bot", accountType: "app", displayName: "Automation for Jira" },
      ]),
    });
    try {
      const result = await api.post("/api/agent/tools/list_jira_users")
        .send({ query: "mulder", limit: 5 }).expect(200);
      assert.deepEqual(result.body.data.users, [
        { account_id: "acc_fox", display_name: "Fox Mulder", email: null, active: true },
      ]);
      assert.equal(result.body.data.permission_uncertain, false);
    } finally { stub.restore(); }
  });

  it("lists boards plainly and does not let one inaccessible board hide the rest", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/agile/1.0/board/99/configuration": () => new Response("no license", { status: 403 }),
      "/rest/agile/1.0/board/84/configuration": () => json({
        columnConfig: { columns: [{ name: "Done", statuses: [] }] },
      }),
      "/rest/agile/1.0/board": () => json({
        values: [{ id: 84, name: "Growth" }, { id: 99 }],
        isLast: false,
      }),
      "/rest/api/3/status": () => json(STATUSES),
    });
    try {
      const plain = await api.post("/api/agent/tools/list_jira_boards").send({}).expect(200);
      assert.deepEqual(plain.body.data.boards[1], { id: 99, name: null, type: null, project_key: null });
      assert.equal(plain.body.data.total, 2, "a listing with no total falls back to what it returned");
      assert.equal(plain.body.data.has_more, true);

      const detailed = await api.post("/api/agent/tools/list_jira_boards")
        .send({ include_columns: true }).expect(200);
      assert.deepEqual(detailed.body.data.boards[0].columns, [{ name: "Done", statuses: [] }]);
      assert.match(detailed.body.data.boards[1].columns_error, /403/);
    } finally { stub.restore(); }
  });

  /*
   * Asking for "the ENG board" is asking by project key, but Jira only matches
   * `name` against board names, so the token has to be read as a key too.
   */
  it("finds a board named by its project key rather than its name", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/agile/1.0/board": (url) => {
        if (url.searchParams.get("projectKeyOrId") === "ENG") {
          return json({
            values: [{ id: 1001, name: "Engineering Delivery", type: "scrum", location: { projectKey: "ENG" } }],
            total: 1,
            isLast: true,
          });
        }
        // Jira is case sensitive about keys and rejects one it does not know.
        if (url.searchParams.has("projectKeyOrId")) {
          return new Response(
            JSON.stringify({ errorMessages: ["No project could be found with key 'NOPE'."] }),
            { status: 400 },
          );
        }
        return json({ values: [], total: 0, isLast: true });
      },
    });
    try {
      const byKey = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "ENG", limit: 10 }).expect(200);
      assert.deepEqual(byKey.body.data.boards, [
        { id: 1001, name: "Engineering Delivery", type: "scrum", project_key: "ENG" },
      ]);
      // Lower case reaches Jira as a key it would otherwise refuse.
      const lowered = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "eng", limit: 10 }).expect(200);
      assert.equal(lowered.body.data.boards.length, 1);

      // A rejected key is the same "nothing matched" the name search gave, so it
      // stays an empty listing rather than becoming a tool failure.
      const missing = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "NOPE", limit: 10 }).expect(200);
      assert.deepEqual(missing.body.data.boards, []);
      assert.equal(missing.body.data.total, 0);
    } finally { stub.restore(); }

    // A filter that cannot be a key is never retried as one.
    const phrase = stubAtlassian({
      "/rest/agile/1.0/board": () => json({ values: [], total: 0, isLast: true }),
    });
    try {
      await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "Engineering Delivery", limit: 10 }).expect(200);
      assert.equal(
        phrase.seen.filter(path => path.includes("projectKeyOrId")).length,
        0,
        "a name with a space is not a project key and must not be sent as one",
      );
    } finally { phrase.restore(); }
  });

  /*
   * Both readings of a key-shaped token cost a request, and the client abandons a
   * tool call at 20s while each request may take 10s. Waiting for the name search
   * to come back empty before asking about the key spends the whole deadline, so
   * the chat gave up on a board that was there all along.
   */
  it("asks both readings of a key-shaped name at the same time", async () => {
    const { api } = fixture();
    await connect(api, {});
    let nameAnswered = false;
    let keyAskedWhileNameOpen = false;
    const stub = stubAtlassian({
      "/rest/agile/1.0/board": async (url) => {
        if (url.searchParams.has("projectKeyOrId")) {
          keyAskedWhileNameOpen = !nameAnswered;
          return json({
            values: [{ id: 1001, name: "Engineering Delivery", type: "scrum", location: { projectKey: "ENG" } }],
            total: 1,
            isLast: true,
          });
        }
        // Held open long enough that a sequential fallback could not have started.
        await new Promise(resolve => setTimeout(resolve, 50));
        nameAnswered = true;
        return json({ values: [], total: 0, isLast: true });
      },
    });
    try {
      const result = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "ENG", limit: 10 }).expect(200);
      assert.deepEqual(result.body.data.boards, [
        { id: 1001, name: "Engineering Delivery", type: "scrum", project_key: "ENG" },
      ]);
      assert.ok(keyAskedWhileNameOpen, "the key lookup waited for the name search to finish");
    } finally { stub.restore(); }
  });

  /*
   * The model reads one token and has two filters to put it in. Jira ANDs them,
   * so filling both from "OPS" could only ever match nothing.
   */
  it("drops a name filter that is only echoing the project key", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/rest/agile/1.0/board": (url) => url.searchParams.has("name")
        ? json({ values: [], total: 0, isLast: true })
        : json({
          values: [{ id: 1002, name: "Operations Delivery", type: "scrum", location: { projectKey: "OPS" } }],
          total: 1,
          isLast: true,
        }),
    });
    try {
      const result = await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "OPS", project_key: "OPS", include_columns: false, limit: 10 }).expect(200);
      assert.deepEqual(result.body.data.boards, [
        { id: 1002, name: "Operations Delivery", type: "scrum", project_key: "OPS" },
      ]);
      assert.equal(
        stub.seen.filter(path => path.includes("name=")).length,
        0,
        "the redundant name filter never reaches Jira, so one request still answers it",
      );
    } finally { stub.restore(); }

    // A name filter that genuinely narrows within a project is still honoured.
    const narrowing = stubAtlassian({
      "/rest/agile/1.0/board": () => json({ values: [], total: 0, isLast: true }),
    });
    try {
      await api.post("/api/agent/tools/list_jira_boards")
        .send({ name_filter: "Delivery", project_key: "OPS", limit: 10 }).expect(200);
      assert.ok(
        narrowing.seen.some(path => path.includes("name=Delivery")),
        "a name that is not the key has to keep filtering",
      );
    } finally { narrowing.restore(); }
  });

  it("passes an upstream refusal through with its own cause named", async () => {
    const { api } = fixture();
    await connect(api, {});
    let stub = stubAtlassian({
      "/rest/agile/1.0/board": () => new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    });
    try {
      const limited = await api.post("/api/agent/tools/list_jira_boards").send({}).expect(502);
      assert.match(limited.body.error, /rate limited the request; retry after 30s/);
    } finally { stub.restore(); }

    stub = stubAtlassian({ "/rest/agile/1.0/board": () => new Response("", { status: 503 }) });
    try {
      const broken = await api.post("/api/agent/tools/list_jira_boards").send({}).expect(502);
      assert.match(broken.body.error, /Atlassian API failed \(503\)/, "an unmapped status still names itself");
    } finally { stub.restore(); }

    // A token that worked at connect time expires on its own schedule, so the
    // rotation hint has to reach the agent mid-session too.
    stub = stubAtlassian({ "/rest/api/3/user/search": () => new Response("", { status: 401 }) });
    try {
      const expired = await api.post("/api/agent/tools/list_jira_users").send({ query: "x" }).expect(502);
      assert.match(expired.body.error, /API tokens expire within a year/);
    } finally { stub.restore(); }
  });

  it("re-checks comment timestamps because the site timezone shifts the window", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/wiki/rest/api/search": () => json({
        results: [
          {
            title: "Fresh",
            url: "/spaces/GROW/pages/111?focusedCommentId=901",
            content: { id: "901", container: { id: "111", title: "Launch plan" } },
            lastModified: "2030-01-15T09:00:00.000Z",
          },
          {
            title: "Stale",
            url: "/spaces/GROW/pages/111?focusedCommentId=902",
            content: {
              id: "902",
              container: { id: "111", title: "Launch plan" },
              history: { createdDate: "2020-01-15T09:00:00.000Z" },
            },
          },
        ],
      }),
    });
    try {
      const result = await api.post("/api/agent/tools/list_confluence_comments")
        .send({ space_keys: ["GROW"], within_days: 2 }).expect(200);
      assert.deepEqual(result.body.data.comments.map((row: { id: string }) => row.id), ["901"]);
      assert.equal(result.body.data.scoped_to_my_pages, false);
      const [only] = result.body.data.comments;
      assert.deepEqual([only.author, only.excerpt, only.location, only.space], [null, null, null, null]);
      assert.match(result.body.data.cql, /^type = comment AND created >= now\("-2d"\) AND space IN \("GROW"\)/);
    } finally { stub.restore(); }
    assert.equal(
      stub.seen.filter(path => path.startsWith("/wiki/rest/api/search")).length,
      1,
      "without the ownership filter there is nothing to fan in to",
    );
  });

  it("keeps only the comments left on pages the user owns", async () => {
    const { api } = fixture();
    await connect(api, {});
    const comment = (id: string, pageId: string, pageTitle: string, author: string) => ({
      title: `Re: ${pageTitle}`,
      excerpt: "  looks   good to me ",
      url: `/spaces/GROW/pages/${pageId}?focusedCommentId=${id}`,
      lastModified: "2030-01-15T09:00:00.000Z",
      content: {
        id,
        type: "comment",
        container: { id: pageId, title: pageTitle },
        space: { key: "GROW" },
        history: { createdDate: "2030-01-15T09:00:00.000Z", createdBy: { displayName: author } },
        extensions: { location: "inline" },
      },
    });
    const stub = stubAtlassian({
      "/wiki/rest/api/search": (url) => {
        const cql = url.searchParams.get("cql") || "";
        // The second call is the fan-in: comment containment is not indexed, so
        // ownership has to be asked about the container pages separately.
        if (cql.includes("currentUser()")) {
          assert.match(cql, /id IN \(111, 222\)/);
          return json({ results: [{ content: { id: "111" } }] });
        }
        assert.match(cql, /^type = comment AND created >= now\("-1d"\)/);
        return json({
          results: [
            comment("901", "111", "Launch plan", "Fox Mulder"),
            comment("902", "222", "Someone else's page", "Walter Skinner"),
          ],
          totalSize: 2,
          _links: { base: "https://example.atlassian.net/wiki" },
        });
      },
    });
    try {
      const result = await api.post("/api/agent/tools/list_confluence_comments")
        .send({ within_days: 1, only_my_pages: true }).expect(200);
      assert.deepEqual(result.body.data.comments.map((row: { id: string }) => row.id), ["901"]);
      const [only] = result.body.data.comments;
      assert.equal(only.author, "Fox Mulder");
      assert.equal(only.excerpt, "looks good to me");
      assert.equal(
        only.url,
        "https://example.atlassian.net/wiki/spaces/GROW/pages/111?focusedCommentId=901",
        "the search URL already focuses the comment, so it is only made absolute",
      );
    } finally { stub.restore(); }
    assert.equal(
      stub.seen.filter(path => path.startsWith("/wiki/rest/api/search")).length,
      2,
      "the fan-in stays at two requests however many pages the user owns",
    );
  });

  it("flattens a Confluence body out of its double-encoded ADF", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/wiki/api/v2/pages/111": () => json({
        id: "111",
        title: "Launch plan",
        spaceId: "77",
        version: { number: 4, createdAt: "2030-01-15T08:00:00.000Z" },
        body: {
          atlas_doc_format: {
            value: JSON.stringify({
              type: "doc",
              content: [
                { type: "heading", content: [{ type: "text", text: "Rollout" }] },
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Owner is " },
                    { type: "mention", attrs: { text: "@Dana" } },
                  ],
                },
                { type: "extension", attrs: { extensionKey: "jira-issues" } },
              ],
            }),
          },
        },
        _links: { webui: "/spaces/GROW/pages/111/Launch+plan" },
      }),
    });
    try {
      const result = await api.post("/api/agent/tools/get_confluence_page").send({ id: "111" }).expect(200);
      assert.equal(result.body.data.text, "Rollout\nOwner is @Dana");
      assert.equal(result.body.data.version, 4);
      assert.equal(result.body.data.url, "https://example.atlassian.net/wiki/spaces/GROW/pages/111/Launch+plan");
    } finally { stub.restore(); }
  });

  it("builds the page CQL from the filters it was given", async () => {
    const { api } = fixture();
    await connect(api, {});
    const stub = stubAtlassian({
      "/wiki/rest/api/search": () => json({
        results: [{
          title: "Launch plan",
          excerpt: "Rollout in three stages",
          url: "/spaces/GROW/pages/111/Launch+plan",
          lastModified: "2030-01-15T08:00:00.000Z",
          content: {
            id: "111",
            title: "Launch plan",
            space: { key: "GROW" },
            history: { createdBy: { displayName: "Dana Scully" } },
          },
        }],
        totalSize: 1,
      }),
      "/wiki/api/v2/spaces": () => json({ results: [{ id: "77", key: "GROW", name: "Growth", type: "global" }] }),
    });
    try {
      const spaces = await api.post("/api/agent/tools/list_confluence_spaces").send({}).expect(200);
      assert.equal(spaces.body.data.spaces[0].url, "https://example.atlassian.net/wiki/spaces/GROW");

      const pages = await api.post("/api/agent/tools/list_confluence_pages")
        .send({ space_keys: ["GROW"], text: "launch", modified_within_days: 7, mine_only: true }).expect(200);
      assert.equal(
        pages.body.data.cql,
        'type = page AND space IN ("GROW") AND text ~ "launch" AND lastmodified >= now("-7d")'
        + " AND (creator = currentUser() OR owner = currentUser()) ORDER BY lastmodified DESC",
      );
      assert.deepEqual(pages.body.data.pages, [{
        id: "111",
        title: "Launch plan",
        space: "GROW",
        author: "Dana Scully",
        last_modified: "2030-01-15T08:00:00.000Z",
        excerpt: "Rollout in three stages",
        // No `_links.base` came back, so the site URL supplies the /wiki prefix.
        url: "https://example.atlassian.net/wiki/spaces/GROW/pages/111/Launch+plan",
      }]);
      assert.equal(pages.body.data.total, 1);
    } finally { stub.restore(); }
    assert.ok(
      stub.seen.every(path => !path.includes("body.storage")),
      "expanding a body silently caps CQL results at 50, so the excerpt is used instead",
    );
  });
});

describe("digest briefs", () => {
  it("validates a brief and stores its pinned resources", async () => {
    const { api } = fixture();
    const created = (await api.post("/api/digest-briefs").send({
      name: "Morning Jira sweep",
      prompt: "Check the Growth board for anything in review.",
      sendTime: "07:30",
      resources: [{ type: "jira_board", id: "84", name: "Growth" }],
    }).expect(201)).body.data;
    assert.equal(created.enabled, true);
    assert.deepEqual(created.resources, [{ type: "jira_board", id: "84", name: "Growth" }]);

    await api.post("/api/digest-briefs")
      .send({ name: "Bad time", prompt: "x", sendTime: "7:30" }).expect(400);
    await api.post("/api/digest-briefs")
      .send({ name: "Bad resource", prompt: "x", resources: [{ type: "notion_page", id: "1" }] }).expect(400);

    const patched = (await api.patch(`/api/digest-briefs/${created.id}`)
      .send({ enabled: false }).expect(200)).body.data;
    assert.equal(patched.enabled, false);
    assert.equal(patched.prompt, created.prompt, "an omitted field is left alone");
    // The create schema defaults these three, and a patch derived with
    // `.partial()` would still apply those defaults to keys the caller never
    // sent, silently resetting the send time and unpinning every board.
    assert.equal(patched.sendTime, "07:30", "an omitted send time is left alone");
    assert.deepEqual(patched.resources, created.resources, "an omitted resource list is left alone");
    const reworded = (await api.patch(`/api/digest-briefs/${created.id}`)
      .send({ prompt: "Check the Growth board for anything blocked." }).expect(200)).body.data;
    assert.equal(reworded.enabled, false, "a disabled brief is not re-enabled by an unrelated patch");

    await api.patch("/api/digest-briefs/brief_missing").send({ enabled: false }).expect(404);
    assert.equal((await api.delete(`/api/digest-briefs/${created.id}`).expect(200)).body.data.id, created.id);
    assert.deepEqual((await api.get("/api/digest-briefs").expect(200)).body.data, []);
  });

  it("runs a brief on demand and hands back the draft without texting it", async () => {
    const prompts: string[] = [];
    const { db, api } = fixture(undefined, async (prompt, address, options) => {
      prompts.push(prompt);
      assert.equal(address, "digest:+17185551111", "a preview shares the thread real sends draft on");
      assert.equal(options?.channel, "sms");
      assert.deepEqual(options?.context, {
        kind: "digest_brief",
        briefId: "brief_preview",
        briefName: "Morning sweep",
        instruction: "What is in review on the Growth board?",
        date: options?.context?.kind === "digest_brief" ? options.context.date : "",
        preview: true,
      });
      return "GROW-12 moved to In Review.";
    });
    saveNotificationPreferences(db, {
      smsEnabled: true,
      recipientPhone: "+17185551111",
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    db.prepare(`
      INSERT INTO digest_briefs(
        id,user_id,name,prompt,send_time,resources_json,enabled,created_at,updated_at
      ) VALUES('brief_preview',?,'Morning sweep',?,'07:30','[]',1,?,?)
    `).run(
      USER_ID,
      "What is in review on the Growth board?",
      "2030-01-15T00:00:00.000Z",
      "2030-01-15T00:00:00.000Z",
    );

    const preview = (await api.post("/api/digest-briefs/brief_preview/test").expect(200)).body.data;
    assert.equal(preview.text, "GROW-12 moved to In Review.");
    assert.equal(preview.sent, false, "a preview never reaches Twilio");
    assert.match(preview.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(prompts[0], /^What is in review on the Growth board\?/);
    assert.match(prompts[0], /Nothing is pinned to this brief/);
    // The preview must not consume the day's send slot, or a brief tested in the
    // morning would silently skip its own schedule.
    assert.equal(
      (db.prepare("SELECT count(*) count FROM scheduled_dispatches").get() as { count: number }).count,
      0,
    );
    await api.post("/api/digest-briefs/brief_missing/test").expect(404);
  });

  /*
   * Every deployed database predates 'digest_brief', so this widening runs for
   * real on upgrade rather than only in theory. A file database is the only way
   * to reopen one, since `:memory:` dies with its connection.
   */
  it("widens the dispatch kinds on an existing database without losing its rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "fieldnote-migration-"));
    const path = join(directory, "upgrade.db");
    try {
      const before = openDatabase(path);
      before.exec("DROP TABLE scheduled_dispatches");
      before.exec(`
        CREATE TABLE scheduled_dispatches (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('daily_digest','reminder')),
          idempotency_key TEXT NOT NULL UNIQUE,
          scheduled_for TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','processing','sent','failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          provider_message_id TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      before.prepare(`
        INSERT INTO scheduled_dispatches(
          id,user_id,kind,idempotency_key,scheduled_for,status,attempts,created_at,updated_at
        ) VALUES('dispatch_old',?,'daily_digest','daily_digest:2030-01-14','2030-01-14T09:00:00.000Z','sent',1,?,?)
      `).run(USER_ID, "2030-01-14T09:00:00.000Z", "2030-01-14T09:00:00.000Z");
      before.prepare("DELETE FROM schema_migrations WHERE version=12").run();
      before.close();

      const after = openDatabase(path);
      try {
        after.prepare(`
          INSERT INTO scheduled_dispatches(
            id,user_id,kind,idempotency_key,scheduled_for,status,attempts,created_at,updated_at
          ) VALUES('dispatch_brief',?,'digest_brief','digest_brief:brief_1:2030-01-15','2030-01-15T07:30:00.000Z','pending',0,?,?)
        `).run(USER_ID, "2030-01-15T07:30:00.000Z", "2030-01-15T07:30:00.000Z");
        assert.deepEqual(
          (after.prepare("SELECT id FROM scheduled_dispatches ORDER BY id").all() as Array<{ id: string }>)
            .map(row => row.id),
          ["dispatch_brief", "dispatch_old"],
          "the history the copy carried over is still there",
        );
      } finally { after.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("worker scheduling", () => {
  const RECIPIENT = "+17185551111";

  function schedulingFixture(preferences: Partial<Parameters<typeof saveNotificationPreferences>[1]> = {}) {
    const context = fixture();
    saveNotificationPreferences(context.db, {
      smsEnabled: true,
      recipientPhone: RECIPIENT,
      timezone: "UTC",
      dailyDigestEnabled: false,
      dailyDigestTime: "09:00",
      quietHoursStart: null,
      quietHoursEnd: null,
      ...preferences,
    });
    return context;
  }

  it("texts the reminder the user asked for and never the due date itself", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/todos").send({
      title: "Review RFC for Alex",
      due_at: "2020-01-02T00:00:00.000Z",
      reminder_at: "2020-01-02T09:00:00.000Z",
    }).expect(201);
    const sent: string[] = [];
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async () => ({ text: "digest", threadId: "thread" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });
    assert.deepEqual(sent, ["Reminder: Review RFC for Alex"]);
    assert.deepEqual(
      db.prepare("SELECT kind,status FROM reminders ORDER BY kind").all(),
      [{ kind: "due", status: "pending" }, { kind: "pre", status: "sent" }],
      "the due row stays in the schedule so it can still be listed and moved",
    );
  });

  it("still texts a reminder that falls on the due date, in either spelling", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/todos").send({
      title: "Take out trash",
      due_at: "2020-01-01T21:00:00-04:00",
      reminder_at: "2020-01-02T01:00:00.000Z",
    }).expect(201);
    assert.deepEqual(
      db.prepare("SELECT kind,scheduled_for FROM reminders ORDER BY kind").all(),
      [
        { kind: "due", scheduled_for: "2020-01-02T01:00:00.000Z" },
        { kind: "pre", scheduled_for: "2020-01-02T01:00:00.000Z" },
      ],
      "a due row must not crowd out the reminder sharing its instant",
    );
    const sent: string[] = [];
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async () => ({ text: "digest", threadId: "thread" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });
    assert.deepEqual(sent, ["Reminder: Take out trash"]);
  });

  it("sends one text when a pre and an escalation share an instant", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/todos").send({
      title: "Ship the release",
      reminder_at: "2020-01-02T01:00:00.000Z",
      extra_reminders: ["2020-01-01T21:00:00-04:00"],
    }).expect(201);
    const sent: string[] = [];
    await runWorkerOnce(db, fakeSearch(db), {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async () => ({ text: "digest", threadId: "thread" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });
    assert.deepEqual(sent, ["Reminder: Ship the release"], "one moment is worth one text");
  });

  it("holds reminders during quiet hours and releases them afterwards", async () => {
    const { db, api } = schedulingFixture({ quietHoursStart: "22:00", quietHoursEnd: "07:00" });
    await api.post("/api/todos")
      .send({ title: "Quiet hours task", reminder_at: "2020-01-01T00:00:00.000Z" }).expect(201);
    const sent: string[] = [];
    const dependencies = {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async () => ({ text: "digest", threadId: "thread" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    };

    let restore = atUtcTime("23:30");
    try { await runWorkerOnce(db, fakeSearch(db), dependencies); } finally { restore(); }
    assert.deepEqual(sent, [], "nothing goes out inside an overnight quiet window");

    restore = atUtcTime("03:00");
    try { await runWorkerOnce(db, fakeSearch(db), dependencies); } finally { restore(); }
    assert.deepEqual(sent, [], "03:00 is still inside 22:00-07:00");

    restore = atUtcTime("08:00");
    try { await runWorkerOnce(db, fakeSearch(db), dependencies); } finally { restore(); }
    assert.deepEqual(sent, ["Reminder: Quiet hours task"]);
  });

  it("sends one daily digest per local day once the digest time has passed", async () => {
    const { db } = schedulingFixture({ dailyDigestEnabled: true, dailyDigestTime: "09:00" });
    const prompts: string[] = [];
    const sent: string[] = [];
    const drafts: Array<{ address: string; internal: boolean }> = [];
    const dependencies = {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async (
        _db: Db,
        _search: unknown,
        address: string,
        prompt: string,
        _providerMessageId?: string,
        options?: { internal?: boolean },
      ) => {
        prompts.push(prompt);
        drafts.push({ address, internal: Boolean(options?.internal) });
        return { text: "Here is your day.", threadId: "thread_digest" };
      },
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    };

    let restore = atUtcTime("08:30");
    try { await runWorkerOnce(db, fakeSearch(db), dependencies as never); } finally { restore(); }
    assert.deepEqual(sent, [], "the digest waits for its configured time");

    restore = atUtcTime("09:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), dependencies as never);
      await runWorkerOnce(db, fakeSearch(db), dependencies as never);
    } finally { restore(); }
    assert.deepEqual(sent, ["Here is your day."], "the idempotency key collapses repeat ticks");
    assert.match(prompts[0], /no pending reminders/);
    const dispatch = db.prepare("SELECT kind,status,idempotency_key FROM scheduled_dispatches").get() as {
      kind: string; status: string; idempotency_key: string;
    };
    assert.equal(dispatch.kind, "daily_digest");
    assert.equal(dispatch.status, "sent");
    assert.match(dispatch.idempotency_key, /^daily_digest:.*:2030-01-15$/);
    // Drafted on a scratch thread marked internal, so the app-composed prompt
    // stays out of the real history and out of the conversation index.
    assert.deepEqual(drafts, [{ address: `digest:${RECIPIENT}`, internal: true }]);
    // But what reached the phone is recorded on the number it went to, otherwise
    // a reply lands on a thread whose recent window never held the digest.
    const recorded = db.prepare(`
      SELECT m.role,m.content,m.provider_message_id FROM channel_messages m
      JOIN channel_threads t ON t.id=m.thread_id WHERE t.address=?
    `).all(RECIPIENT) as Array<{ role: string; content: string; provider_message_id: string }>;
    assert.deepEqual(recorded, [
      { role: "assistant", content: "Here is your day.", provider_message_id: "SM_1" },
    ]);
  });

  /**
   * Captures the digest prompt for a fixture whose todos are already in place.
   * The wall clock is pinned to 2030-01-15, so "today" is that date in UTC.
   */
  async function digestPrompt(db: Db): Promise<string> {
    const prompts: string[] = [];
    const restore = atUtcTime("09:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_1", status: "queued" }),
        runSmsAgent: async (
          _db: Db,
          _search: unknown,
          _address: string,
          prompt: string,
        ) => {
          prompts.push(prompt);
          return { text: "Here is your day.", threadId: "thread_digest" };
        },
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      } as never);
    } finally { restore(); }
    return prompts[0];
  }

  /** Two todos land on 2030-01-15, two deliberately do not, and three are late. */
  async function digestTodoFixture(digestIncludeTodos: boolean, digestIncludeOverdue = false) {
    const context = schedulingFixture({
      dailyDigestEnabled: true,
      dailyDigestTime: "09:00",
      digestIncludeTodos,
      digestIncludeOverdue,
    });
    await context.api.post("/api/todos").send({
      title: "Review RFC for Alex",
      priority: "high",
      due_at: "2030-01-15T17:00:00.000Z",
      reminder_at: "2030-01-15T14:00:00.000Z",
    }).expect(201);
    // Reminds today without being due today, which is the second half of the ask.
    await context.api.post("/api/todos").send({
      title: "Nudge the vendor",
      due_at: "2030-01-20T17:00:00.000Z",
      reminder_at: "2030-01-15T16:00:00.000Z",
    }).expect(201);
    await context.api.post("/api/todos")
      .send({ title: "Ship the deck", due_at: "2030-01-16T12:00:00.000Z" }).expect(201);
    const finished = (await context.api.post("/api/todos")
      .send({ title: "Book the flight", due_at: "2030-01-15T20:00:00.000Z" }).expect(201)).body.data;
    await context.api.patch(`/api/todos/${finished.id}/status`).send({ status: "done" }).expect(200);
    // Late by its due date alone.
    await context.api.post("/api/todos")
      .send({ title: "Renew the domain", due_at: "2030-01-13T15:00:00.000Z" }).expect(201);
    // Late by a reminder that already fired, with no due date to fall behind.
    await context.api.post("/api/todos")
      .send({ title: "Call the plumber", reminder_at: "2030-01-14T13:00:00.000Z" }).expect(201);
    // Late but reminding again today, so it belongs to today and not to both.
    await context.api.post("/api/todos").send({
      title: "Chase the invoice",
      due_at: "2030-01-14T17:00:00.000Z",
      reminder_at: "2030-01-15T11:00:00.000Z",
    }).expect(201);
    const lapsed = (await context.api.post("/api/todos")
      .send({ title: "Archive Q4 notes", due_at: "2030-01-12T10:00:00.000Z" }).expect(201)).body.data;
    await context.api.patch(`/api/todos/${lapsed.id}/status`).send({ status: "done" }).expect(200);
    return context;
  }

  it("covers today's open todos in the digest when the option is on", async () => {
    const { db } = await digestTodoFixture(true);
    const prompt = await digestPrompt(db);
    assert.match(prompt, /Open todos that are due today or set to remind me today:/);
    assert.match(prompt, /- "Review RFC for Alex" \[pending, high\] due 17:00; reminder 14:00/);
    assert.match(prompt, /- "Nudge the vendor" \[pending\] reminder 16:00/);
    assert.ok(!prompt.includes("Ship the deck"), "a todo due tomorrow is not today's business");
    assert.ok(!prompt.includes("Book the flight"), "a finished todo needs no attention today");
    assert.ok(!prompt.includes("Renew the domain"), "overdue coverage is its own option");
    assert.ok(!prompt.includes("Call the plumber"), "a reminder that already fired is not today's");
  });

  it("carries todos left over from an earlier day when the overdue option is on", async () => {
    const { db } = await digestTodoFixture(true, true);
    const prompt = await digestPrompt(db);
    assert.match(prompt, /Still open from before today, unfinished and already past their date:/);
    // Oldest first, and a missed reminder counts even without a due date.
    assert.match(
      prompt,
      /- "Renew the domain" \[pending\] due 2030-01-13 15:00\n- "Call the plumber" \[pending\] reminder 2030-01-14 13:00/,
    );
    assert.ok(!prompt.includes("Archive Q4 notes"), "a finished todo is not a backlog item");
    assert.ok(!prompt.includes("Ship the deck"), "a todo due tomorrow is not late");
    // Late but reminding again today: reported once, under today, still marked late.
    assert.match(prompt, /- "Chase the invoice" \[pending\] overdue since 2030-01-14 17:00; reminder 11:00/);
    assert.equal(prompt.match(/Chase the invoice/g)?.length, 1);
    assert.match(prompt, /2 things are still open from an earlier day\./);
  });

  it("tells the agent the day is not clear when only the backlog has anything in it", async () => {
    const { db, api } = schedulingFixture({
      dailyDigestEnabled: true,
      dailyDigestTime: "09:00",
      digestIncludeTodos: true,
      digestIncludeOverdue: true,
    });
    await api.post("/api/todos")
      .send({ title: "Renew the domain", due_at: "2030-01-13T15:00:00.000Z" }).expect(201);
    const prompt = await digestPrompt(db);
    assert.match(prompt, /the day is not clear: the rows below are still outstanding\./);
    assert.ok(
      !prompt.includes("say the day is clear"),
      "an unfinished task from Monday is exactly what the check-in used to lose",
    );
  });

  it("leaves the backlog out of the digest when the overdue option is off", async () => {
    const { db } = await digestTodoFixture(false);
    const prompt = await digestPrompt(db);
    assert.ok(!prompt.includes("Renew the domain"));
    assert.ok(!prompt.includes("Context supplied by the app"));
  });

  it("leaves todos out of the digest when the option is off", async () => {
    const { db } = await digestTodoFixture(false);
    const prompt = await digestPrompt(db);
    assert.ok(!prompt.includes("Review RFC for Alex"));
    assert.ok(
      !prompt.includes("Context supplied by the app"),
      "the prompt stays the single sentence it was before the option existed",
    );
  });

  it("says the day is clear rather than inviting the agent to look for todos", async () => {
    const { db } = schedulingFixture({
      dailyDigestEnabled: true,
      dailyDigestTime: "09:00",
      digestIncludeTodos: true,
    });
    const prompt = await digestPrompt(db);
    assert.match(prompt, /Nothing open is due today and nothing is set to remind me today/);
    assert.ok(
      !prompt.includes("still open from an earlier day"),
      "the backlog was never checked, so the prompt cannot claim it is empty",
    );
  });

  it("says both lists are empty when both options are on and nothing is open", async () => {
    const { db } = schedulingFixture({
      dailyDigestEnabled: true,
      dailyDigestTime: "09:00",
      digestIncludeTodos: true,
      digestIncludeOverdue: true,
    });
    const prompt = await digestPrompt(db);
    assert.match(
      prompt,
      /Nothing open is due today and nothing is set to remind me today, and nothing is still open from an earlier day/,
    );
  });

  it("sends each brief once per local day on its own send time", async () => {
    const { db, api } = schedulingFixture({ quietHoursStart: "22:00", quietHoursEnd: "07:00" });
    await api.post("/api/digest-briefs").send({
      name: "Morning Jira sweep",
      prompt: "Check the Growth board for anything in review.",
      sendTime: "08:00",
      resources: [
        { type: "jira_board", id: "84", name: "Growth" },
        { type: "confluence_space", id: "GROW", name: "Growth space" },
      ],
    }).expect(201);
    await api.post("/api/digest-briefs").send({
      name: "Paused sweep",
      prompt: "Never sent.",
      sendTime: "06:00",
      enabled: false,
    }).expect(201);
    await api.post("/api/digest-briefs").send({
      name: "Unpinned sweep",
      prompt: "Anything on my plate today?",
      sendTime: "08:15",
    }).expect(201);
    const prompts: string[] = [];
    const sent: string[] = [];
    const dependencies = {
      sendSms: async (_db: Db, _to: string, body: string) => {
        sent.push(body);
        return { sid: `SM_${sent.length}`, status: "queued" };
      },
      runSmsAgent: async (
        _db: Db,
        _search: unknown,
        _address: string,
        prompt: string,
        _providerMessageId?: string,
        options?: { internal?: boolean; userMessageMetadata?: Record<string, unknown> },
      ) => {
        assert.equal(options?.internal, true, "the composed instruction stays out of the SMS history");
        // History renders the draft turn from this rather than from the composed
        // prompt, so the board IDs and length rules stay collapsed.
        assert.equal(options?.userMessageMetadata?.kind, "digest_brief");
        assert.equal(options?.userMessageMetadata?.instruction, prompt.split("\n")[0]);
        prompts.push(prompt);
        return { text: `Answer ${prompts.length}.`, threadId: "thread_brief" };
      },
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    };

    // Inside quiet hours the brief is held even though its send time has passed,
    // because briefs run inside the same gate as reminders.
    let restore = atUtcTime("06:30");
    try { await runWorkerOnce(db, fakeSearch(db), dependencies as never); } finally { restore(); }
    assert.deepEqual(sent, []);

    restore = atUtcTime("08:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), dependencies as never);
      await runWorkerOnce(db, fakeSearch(db), dependencies as never);
    } finally { restore(); }
    assert.deepEqual(sent, ["Answer 1.", "Answer 2."], "the per-day key collapses repeat ticks");
    assert.equal(prompts.length, 2, "the disabled brief never runs");
    assert.match(prompts[0], /^Check the Growth board for anything in review\./);
    assert.match(prompts[0], /board_id 84 "Growth"/, "the pinned catalog is injected rather than guessed");
    assert.match(prompts[0], /space key GROW "Growth space"/);
    assert.match(prompts[0], /do not guess a board ID/);
    assert.match(prompts[0], /Today is 2030-01-15 in UTC/);
    // Atlassian is not connected in this fixture, so the catalog degrades to the
    // pinned names rather than failing the send.
    assert.match(prompts[0], /columns unavailable: Atlassian is not configured/);
    assert.match(prompts[1], /Nothing is pinned to this brief/);
    const dispatches = db.prepare(`
      SELECT status,idempotency_key FROM scheduled_dispatches WHERE kind='digest_brief' ORDER BY created_at,rowid
    `).all() as Array<{ status: string; idempotency_key: string }>;
    assert.deepEqual(dispatches.map(row => row.status), ["sent", "sent"]);
    assert.match(dispatches[0].idempotency_key, /^digest_brief:brief_.*:2030-01-15$/);
    const recorded = db.prepare(`
      SELECT m.content,m.metadata_json FROM channel_messages m
      JOIN channel_threads t ON t.id=m.thread_id WHERE t.address=? ORDER BY m.created_at,m.rowid
    `).all(RECIPIENT) as Array<{ content: string; metadata_json: string }>;
    assert.equal(recorded[0].content, "Answer 1.");
    assert.equal(JSON.parse(recorded[0].metadata_json).kind, "digest_brief");
    assert.equal(JSON.parse(recorded[0].metadata_json).briefName, "Morning Jira sweep");
  });

  it("injects the resolved board columns a pinned brief needs", async () => {
    const { db, api } = schedulingFixture();
    const prompts: string[] = [];
    const original = globalThis.fetch;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input));
      if (pathname === "/rest/api/3/myself" || pathname === "/wiki/rest/api/user/current") {
        return json({ accountId: "acc_me", displayName: "Dana Scully" });
      }
      if (pathname === "/rest/api/3/status") {
        return json([{ id: "10083", name: "In Review", statusCategory: { name: "In Progress" } }]);
      }
      if (pathname === "/rest/agile/1.0/board/84/configuration") {
        return json({ columnConfig: { columns: [{ name: "In Review", statuses: [{ id: "10083" }] }] } });
      }
      if (pathname === "/rest/agile/1.0/board/99/configuration") {
        return json({ columnConfig: { columns: [{ name: "Backlog", statuses: [] }] } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      await api.post("/api/integrations/atlassian/connect").send({
        siteUrl: "https://example.atlassian.net",
        email: "demo@example.com",
        apiToken: "atlassian-api-token-value",
      }).expect(200);
      await api.post("/api/digest-briefs").send({
        name: "Pinned sweep",
        prompt: "What is in review?",
        sendTime: "08:00",
        resources: [
          { type: "jira_board", id: "84", name: "Growth" },
          { type: "jira_board", id: "99" },
        ],
      }).expect(201);
      const restore = atUtcTime("08:30");
      try {
        await runWorkerOnce(db, fakeSearch(db), {
          sendSms: async () => ({ sid: "SM_1", status: "queued" }),
          runSmsAgent: async (
            _db: Db,
            _search: unknown,
            _address: string,
            prompt: string,
          ) => {
            prompts.push(prompt);
            return { text: "GROW-12 is in review.", threadId: "thread_brief" };
          },
          pollGranola: async () => ({ fetched: 0, queued: 0 }),
        } as never);
      } finally { restore(); }
    } finally { globalThis.fetch = original; }
    // The column word in the prompt now has real status IDs behind it, which is
    // the whole reason the pinned catalog exists.
    assert.match(prompts[0], /- board_id 84 "Growth"; columns: In Review \[10083\]/);
    assert.match(prompts[0], /- board_id 99; columns: Backlog \[none\]/);
  });

  it("records a failed brief once instead of retrying every minute", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/digest-briefs")
      .send({ name: "Broken brief", prompt: "Check a board that is gone.", sendTime: "08:00" }).expect(201);
    const restore = atUtcTime("08:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_1", status: "queued" }),
        runSmsAgent: async () => { throw new Error("Atlassian rate limited the request"); },
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_2", status: "queued" }),
        runSmsAgent: async () => ({ text: "second attempt", threadId: "thread" }),
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    const dispatches = db.prepare(`
      SELECT status,last_error FROM scheduled_dispatches WHERE kind='digest_brief'
    `).all() as Array<{ status: string; last_error: string }>;
    assert.equal(dispatches.length, 1, "the failure receipt stops the same day repeating");
    assert.equal(dispatches[0].status, "failed");
    assert.match(dispatches[0].last_error, /rate limited/);
  });

  /*
   * A laptop asleep at the send time used to cost the brief its whole day: the
   * request died with the socket, and the failure receipt that exists to stop a
   * broken query looping also blocked the attempt that would have worked.
   */
  it("retries a brief whose request died with the connection", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/digest-briefs")
      .send({ name: "Morning Jira sweep", prompt: "Check the boards.", sendTime: "08:00" }).expect(201);
    const sent: string[] = [];
    const dropped = new TypeError("fetch failed");
    dropped.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    let restore = atUtcTime("08:02");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_1", status: "queued" }),
        runSmsAgent: async () => { throw dropped; },
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    const pending = db.prepare(`
      SELECT status,attempts FROM scheduled_dispatches WHERE kind='digest_brief'
    `).get() as { status: string; attempts: number };
    assert.equal(pending.status, "pending", "a dropped connection hands the slot back");
    assert.equal(pending.attempts, 1);
    assert.equal(sent.length, 0, "nothing reached the phone on the failed attempt");

    // The lid opens half an hour later, still the same local day.
    restore = atUtcTime("08:32");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async (_db: Db, _to: string, body: string) => {
          sent.push(body);
          return { sid: "SM_2", status: "queued" };
        },
        runSmsAgent: async () => ({ text: "GROW-12 moved to review.", threadId: "thread" }),
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    const dispatches = db.prepare(`
      SELECT status,attempts FROM scheduled_dispatches WHERE kind='digest_brief'
    `).all() as Array<{ status: string; attempts: number }>;
    assert.equal(dispatches.length, 1, "the retry reuses the day's slot rather than adding one");
    assert.equal(dispatches[0].status, "sent");
    assert.equal(dispatches[0].attempts, 2);
    assert.deepEqual(sent, ["GROW-12 moved to review."]);
  });

  it("stops retrying a brief once the connection keeps dropping", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/digest-briefs")
      .send({ name: "Morning Jira sweep", prompt: "Check the boards.", sendTime: "08:00" }).expect(201);
    const dropped = new TypeError("fetch failed");
    dropped.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    let attempts = 0;
    // Each tick is far enough ahead to clear the longest backoff the retry uses.
    for (const time of ["08:02", "09:02", "10:02", "11:02", "12:02", "13:02"]) {
      const restore = atUtcTime(time);
      try {
        await runWorkerOnce(db, fakeSearch(db), {
          sendSms: async () => ({ sid: "SM_1", status: "queued" }),
          runSmsAgent: async () => { attempts += 1; throw dropped; },
          pollGranola: async () => ({ fetched: 0, queued: 0 }),
        });
      } finally { restore(); }
    }
    const dispatch = db.prepare(`
      SELECT status,attempts FROM scheduled_dispatches WHERE kind='digest_brief'
    `).get() as { status: string; attempts: number };
    assert.equal(attempts, 5, "the retry budget is spent, not unbounded");
    assert.equal(dispatch.status, "failed");
    assert.equal(dispatch.attempts, 5);
  });

  it("retries the daily digest when the connection dropped, not the request", async () => {
    const { db } = schedulingFixture({ dailyDigestEnabled: true, dailyDigestTime: "09:00" });
    const dropped = new TypeError("fetch failed");
    dropped.cause = Object.assign(new Error("other side closed"), { code: "ECONNRESET" });
    let restore = atUtcTime("09:00");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_1", status: "queued" }),
        runSmsAgent: async () => { throw dropped; },
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    assert.equal(
      (db.prepare("SELECT status FROM scheduled_dispatches").get() as { status: string }).status,
      "pending",
    );
    restore = atUtcTime("09:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_2", status: "queued" }),
        runSmsAgent: async () => ({ text: "Two reminders today.", threadId: "thread" }),
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    const dispatches = db.prepare("SELECT status,attempts FROM scheduled_dispatches").all() as Array<{
      status: string; attempts: number;
    }>;
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].status, "sent");
    assert.equal(dispatches[0].attempts, 2);
  });

  it("treats an unavailable Agent Studio as retryable and a rejected turn as final", async () => {
    const { db } = schedulingFixture();
    process.env.ALGOLIA_APPLICATION_ID = "app";
    process.env.ALGOLIA_SEARCH_API_KEY = "key";
    process.env.ALGOLIA_AGENT_ID = "agent";
    const respondWith = (status: number): typeof fetch =>
      async () => new Response("upstream said no", { status });
    await assert.rejects(
      () => runSmsAgent(db, fakeSearch(db), RECIPIENT, "hi", undefined, { fetcher: respondWith(503) }),
      (error: Error) => error.name === "TransientFailure" && /unavailable \(503\)/.test(error.message),
    );
    await assert.rejects(
      () => runSmsAgent(db, fakeSearch(db), RECIPIENT, "hi", undefined, { fetcher: respondWith(400) }),
      (error: Error) => error.name === "Error" && /completion failed \(400\)/.test(error.message),
    );
  });

  it("records a failed digest without blocking the next day", async () => {
    const { db } = schedulingFixture({ dailyDigestEnabled: true, dailyDigestTime: "09:00" });
    const restore = atUtcTime("09:30");
    try {
      await runWorkerOnce(db, fakeSearch(db), {
        sendSms: async () => ({ sid: "SM_1", status: "queued" }),
        runSmsAgent: async () => { throw new Error("Agent Studio timed out"); },
        pollGranola: async () => ({ fetched: 0, queued: 0 }),
      });
    } finally { restore(); }
    const dispatch = db.prepare("SELECT status,last_error FROM scheduled_dispatches").get() as {
      status: string; last_error: string;
    };
    assert.equal(dispatch.status, "failed");
    assert.match(dispatch.last_error, /Agent Studio timed out/);
  });

  it("backs a failed reminder off and releases the dispatch claim for a retry", async () => {
    const { db, api } = schedulingFixture();
    await api.post("/api/todos")
      .send({ title: "Retry me", reminder_at: "2020-01-01T00:00:00.000Z" }).expect(201);
    let attempts = 0;
    const dependencies = {
      sendSms: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Twilio 500");
        return { sid: "SM_retry", status: "queued" };
      },
      runSmsAgent: async () => ({ text: "", threadId: "thread" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    };

    await runWorkerOnce(db, fakeSearch(db), dependencies);
    const failed = db.prepare("SELECT status,attempts,available_at,last_error FROM reminders").get() as {
      status: string; attempts: number; available_at: string; last_error: string;
    };
    assert.equal(failed.status, "failed");
    assert.match(failed.last_error, /Twilio 500/);
    assert.ok(new Date(failed.available_at).getTime() > Date.now(), "a failure has to back off before retrying");
    assert.equal(
      (db.prepare("SELECT count(*) count FROM scheduled_dispatches").get() as { count: number }).count,
      0,
      "an undelivered message must not leave an idempotency claim behind",
    );

    db.prepare("UPDATE reminders SET available_at=?").run("2020-01-01T00:00:00.000Z");
    await runWorkerOnce(db, fakeSearch(db), dependencies);
    assert.equal(attempts, 2);
    assert.equal(
      (db.prepare("SELECT status FROM reminders").get() as { status: string }).status,
      "sent",
    );
  });

  it("prunes old completed jobs and flushes the outbox on the tick", async () => {
    const { db } = fixture();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO index_jobs(id,user_id,entity_type,entity_id,operation,status,attempts,available_at,created_at,updated_at)
      VALUES('job_old',?,'todo','todo_gone','upsert','done',1,?,?,?)
    `).run(USER_ID, old, old, old);
    db.prepare(`
      INSERT INTO scheduled_dispatches(
        id,user_id,kind,idempotency_key,scheduled_for,status,attempts,created_at,updated_at
      ) VALUES('dispatch_old',?,'daily_digest','daily_digest:old','2020-01-01','sent',1,?,?)
    `).run(USER_ID, old, old);
    queueIndexJob(db, "todo", "todo_pending");

    const search = fakeSearch(db);
    let flushed = 0;
    await runWorkerOnce(db, { ...search, flush: async () => { flushed += 1; return { configured: false, processed: 0, succeeded: 0, failed: 0 }; } } as never, {
      sendSms: async () => ({ sid: "SM_1", status: "queued" }),
      runSmsAgent: async () => ({ text: "", threadId: "t" }),
      pollGranola: async () => ({ fetched: 0, queued: 0 }),
    });

    assert.equal(flushed, 1, "queued outbox work must not wait for the next unrelated write");
    assert.equal(
      (db.prepare("SELECT count(*) count FROM index_jobs WHERE id='job_old'").get() as { count: number }).count,
      0,
    );
    assert.equal(
      (db.prepare("SELECT count(*) count FROM scheduled_dispatches").get() as { count: number }).count,
      0,
    );
  });
});

describe("authentication", () => {
  const PASSWORD = "correct-horse-battery-staple";

  function authFixture() {
    process.env.APP_ADMIN_PASSWORD = PASSWORD;
    resetThrottling();
    return fixture();
  }

  afterEach(() => {
    delete process.env.APP_ADMIN_PASSWORD;
    resetThrottling();
  });

  it("keeps health and provider webhooks reachable without credentials", async () => {
    const { api } = authFixture();
    const health = await api.get("/api/health").expect(200);
    assert.deepEqual(health.body.data, { ok: true }, "anonymous callers get liveness only");
    await api.post("/api/webhooks/twilio/status").send({ MessageSid: "SM_none" }).expect(204);
  });

  it("sends browsers to the login page and answers the API with 401", async () => {
    const { api } = authFixture();
    const page = await api.get("/todos").expect(302);
    assert.equal(page.headers.location, "/login?next=%2Ftodos", "the original path is preserved");
    const json = await api.get("/api/todos").expect(401);
    assert.equal(json.body.success, false);
  });

  it("rejects a wrong password and issues a session for the right one", async () => {
    const { api } = authFixture();

    const denied = await api.post("/login").type("form").send({ password: "wrong" }).expect(401);
    assert.match(denied.text, /Incorrect password/);
    assert.equal(denied.headers["set-cookie"], undefined, "no session is created on failure");

    const allowed = await api.post("/login").type("form").send({ password: PASSWORD }).expect(302);
    assert.equal(allowed.headers.location, "/");
    const cookie = allowed.headers["set-cookie"][0];
    assert.match(cookie, /^fieldnote_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    await api.get("/api/todos").set("Cookie", cookie).expect(200);
  });

  it("stores only a hash of the session token", async () => {
    const { api, db } = authFixture();
    const login = await api.post("/login").type("form").send({ password: PASSWORD }).expect(302);
    const token = /fieldnote_session=([^;]+)/.exec(login.headers["set-cookie"][0])?.[1];
    const stored = db.prepare("SELECT token_hash FROM sessions").all() as Array<{ token_hash: string }>;
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].token_hash, token, "the raw token is never written to the database");
  });

  it("revokes the session on logout", async () => {
    const { api } = authFixture();
    const login = await api.post("/login").type("form").send({ password: PASSWORD }).expect(302);
    const cookie = login.headers["set-cookie"][0];

    await api.post("/logout").set("Cookie", cookie).expect(302);
    await api.get("/api/todos").set("Cookie", cookie).expect(401);
  });

  it("locks out repeated password guesses", async () => {
    const { api } = authFixture();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await api.post("/login").type("form").send({ password: "wrong" }).expect(401);
    }
    const locked = await api.post("/login").type("form").send({ password: "wrong" }).expect(429);
    assert.match(locked.text, /Too many attempts/);
    // The correct password is refused too, so lockout cannot be sidestepped.
    await api.post("/login").type("form").send({ password: PASSWORD }).expect(429);
  });

  it("refuses to redirect somewhere off-site after login", async () => {
    const { api } = authFixture();
    const login = await api.post("/login").type("form")
      .send({ password: PASSWORD, next: "//evil.example.com/steal" })
      .expect(302);
    assert.equal(login.headers.location, "/", "an off-site next is discarded");
  });

  it("still accepts Basic Auth for scripts and integrations", async () => {
    const { api } = authFixture();
    await api.get("/api/todos").auth("admin", PASSWORD).expect(200);
    await api.get("/api/todos").auth("admin", "wrong").expect(401);
  });

  it("serves everything when no password is configured", async () => {
    delete process.env.APP_ADMIN_PASSWORD;
    const { api } = fixture();
    await api.get("/api/todos").expect(200);
  });
});
