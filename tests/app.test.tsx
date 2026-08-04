import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { api } from "../src/api";
import { ReminderWatcher } from "../src/components/ReminderWatcher";
import { memoryAttachment, serializeAttachments, todoAttachment } from "../src/lib/agent-attachments";
import { toZonedDateTimeLocal, zonedDateTimeLocalToIso } from "../src/lib/timezone";
import type { Memory, Todo } from "../src/types";

/**
 * The fixtures below sit on fixed dates, and the UI prints a date landing on the
 * current day as "Today". Left to the wall clock the suite would pass every day
 * except the ones it describes, so every test reads from the same pinned instant.
 */
const now = new Date("2026-07-24T15:00:00.000Z");
beforeEach(() => {
  vi.setSystemTime(now);
  agentStream = [];
  // The chat widget parks a finished conversation in sessionStorage and restores
  // it on the next mount, which would carry one test's messages into the next.
  window.sessionStorage.clear();
});

const health = {
  sqlite: { ok: true, records: 0 },
  algolia: { ok: false, configured: false },
  agentStudio: { configured: false },
  auth: { enabled: true },
  neuralSearch: { enabled: false },
  indices: { todos: "devcon_assistant_todos", memories: "devcon_assistant_memories", messages: "devcon_assistant_messages" },
  pendingIndexJobs: 0,
};

const lifeAreas = [
  { id: "area_work", slug: "work", name: "Work", color: "#2c5f8a", is_builtin: 1 },
  { id: "area_personal", slug: "personal", name: "Personal", color: "#b27a22", is_builtin: 1 },
];

const todo = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "todo_1",
  title: "Prepare the DevCon demo",
  notes: null,
  status: "pending",
  priority: "high",
  category_id: null,
  category_name: null,
  life_area_id: "area_work",
  life_area_name: "Work",
  life_area_slug: "work",
  life_area_source: "user",
  parent_id: null,
  due_at: "2026-08-01T16:00:00.000Z",
  reminder_at: null,
  extra_reminders: [],
  started_at: null,
  completed_at: null,
  created_at: "2026-07-20T12:00:00.000Z",
  updated_at: "2026-07-20T12:00:00.000Z",
  ...over,
});

const todos = [
  todo(),
  todo({ id: "todo_sub", title: "Write the outline", parent_id: "todo_1", status: "done" }),
  todo({ id: "todo_2", title: "Rehearse the walkthrough", status: "in_progress", priority: "normal" }),
  todo({ id: "todo_done", title: "Book the flight", status: "done", completed_at: "2026-07-21T12:00:00.000Z" }),
  // Captured from "tomorrow, remind me at 9am": a midnight due date in New York
  // plus reminders of its own.
  todo({
    id: "todo_reminder",
    title: "Review RFC for Alex",
    priority: null,
    due_at: "2026-07-29T04:00:00.000Z",
    reminder_at: "2026-07-29T13:00:00.000Z",
    extra_reminders: ["2026-07-29T18:00:00.000Z"],
  }),
  // A task with a step still standing, so finishing it has something to ask about.
  todo({ id: "todo_open_parent", title: "Wrap the sprint", priority: null, due_at: null }),
  todo({ id: "todo_open_sub", title: "Send the recap", parent_id: "todo_open_parent", priority: null, due_at: null }),
];

/** Stateful so a saved preference reads back the way the server would return it. */
const taskPreferences = { autoCompleteParent: false };

const memory = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "memory_1",
  kind: "note",
  title: "Talk framing",
  content: "Lead with the consistency contract.",
  mood_label: null,
  mood_score: null,
  category_id: null,
  category_name: null,
  life_area_id: "area_work",
  life_area_name: "Work",
  life_area_slug: "work",
  life_area_source: "user",
  occurred_at: "2026-07-18T12:00:00.000Z",
  review_worthy: false,
  tags: ["devcon"],
  created_at: "2026-07-18T12:00:00.000Z",
  updated_at: "2026-07-18T12:00:00.000Z",
  ...over,
});

const memories = [
  memory(),
  memory({ id: "memory_fact", kind: "fact", title: "Venue wifi", content: "Guest network is throttled." }),
  memory({
    id: "memory_journal",
    kind: "journal",
    title: "Good run-through",
    content: "Felt ready.",
    mood_score: 4,
  }),
];

/** One hit per surface the palette groups, all matching the query "the". */
const universalHits = [
  {
    type: "memory", objectID: "memory_1", title: "Talk framing",
    snippet: "Lead with the consistency contract.", kind: "note", life_area_name: "Work",
  },
  {
    type: "todo", objectID: "todo_1", title: "Prepare the DevCon demo",
    snippet: null, status: "pending", life_area_name: "Work",
  },
  {
    type: "message", objectID: "message_launch", title: null,
    snippet: "We discussed the NeuralSearch launch plan.",
    threadId: "thread_web", channel: "web", role: "user",
  },
  // Out of type order on purpose: a relevance-ranked response interleaves types,
  // while the palette renders them grouped.
  {
    type: "memory", objectID: "memory_2", title: "Demo runbook",
    snippet: "Check the indices before the talk.", kind: "note", life_area_name: "Work",
  },
];

/** Query-string aware so the tests can assert what the page actually asked for. */
const requestedUrls: string[] = [];

/** Todo writes, so a form test can assert the payload and not just the call. */
const todoWrites: Array<{ method: string; body: Record<string, unknown> }> = [];

/** Lets a test stand in for an Algolia plan without NeuralSearch, or an unreachable one. */
let neuralSearchSetupDetails: Record<string, string> | null = null;

/**
 * Holds an admin action open so a test can look at the button row while one is
 * still running. These resolve instantly otherwise, and the pending state is
 * the whole point of the assertion.
 */
let adminActionGate: Promise<void> | null = null;

/** Mutable so one test can connect Atlassian and then configure a brief against it. */
let atlassian = {
  configured: false,
  status: "disconnected",
  siteUrl: null as string | null,
  email: null as string | null,
  accountId: null as string | null,
  displayName: null as string | null,
  jiraAvailable: false,
  confluenceAvailable: false,
};
let digestBriefs: Array<Record<string, unknown> & { id: string }> = [];

/**
 * What Agent Studio streams back, one entry per request the widget makes. A
 * client-side tool call ends a stream: the widget runs the tool, reports the
 * result, and asks for the rest of the turn in a second request, so a turn that
 * uses a tool is scripted as two entries.
 */
let agentStream: Array<Array<Record<string, unknown>>> = [];

const streamChunks = (chunks: Array<Record<string, unknown>>) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.close();
  },
}));

function resetAtlassianFixtures() {
  atlassian = {
    configured: false,
    status: "disconnected",
    siteUrl: null,
    email: null,
    accountId: null,
    displayName: null,
    jiraAvailable: false,
    confluenceAvailable: false,
  };
  digestBriefs = [];
}

vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requestedUrls.push(url);
  // A test that has not scripted a reply gets an empty stream, which closes
  // without leaving a message behind for the tests that count them.
  if (url.includes("/agent-studio/1/agents/")) return streamChunks(agentStream.shift() ?? []);
  if (url.includes("/api/agent/tools/set_todo_status")) {
    const { id, status } = JSON.parse(String(init?.body ?? "{}")) as { id: string; status: string };
    return new Response(JSON.stringify({
      success: true,
      data: todo({ id, title: "Review RFC for Alex", status }),
    }));
  }
  if (url.includes("/api/admin/algolia/neural-search")) {
    const { enabled } = JSON.parse(String(init?.body ?? "{}")) as { enabled: boolean };
    const details = neuralSearchSetupDetails;
    // The preference is saved before setup runs, so it sticks even on fallback.
    health.neuralSearch.enabled = enabled;
    return new Response(JSON.stringify({
      success: true,
      data: { enabled, setup: { configured: !details, details: details ?? undefined } },
    }));
  }
  if (url.includes("/api/admin/")) {
    if (adminActionGate) await adminActionGate;
    return new Response(JSON.stringify({ success: true, data: { queued: 0, processed: 0 } }));
  }
  if (url.includes("/api/health")) return new Response(JSON.stringify({ success: true, data: health }));
  if (url.includes("/api/life-areas")) return new Response(JSON.stringify({ success: true, data: lifeAreas }));
  if (url.includes("/api/todos")) {
    const method = init?.method || "GET";
    if (method !== "GET") {
      todoWrites.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    }
    const includeDone = !url.includes("includeDone=false");
    return new Response(JSON.stringify({
      success: true,
      data: todos.filter(item => includeDone || item.status !== "done"),
    }));
  }
  if (url.includes("/api/memories?") || url.endsWith("/api/memories")) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const kind = params.get("kind");
    const query = (params.get("query") || "").toLowerCase();
    return new Response(JSON.stringify({
      success: true,
      data: {
        // Only a query can be ranked by Algolia; a plain list is a SQLite read.
        source: query ? "algolia" : "sqlite",
        memories: memories
          .filter(item => !kind || kind === "all" || item.kind === kind)
          .filter(item => !query || `${item.title} ${item.content}`.toLowerCase().includes(query)),
      },
    }));
  }
  if (url.includes("/api/search")) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const query = (params.get("q") || "").toLowerCase();
    const types = (params.get("types") || "todo,memory,message").split(",");
    const hits = universalHits
      .filter(hit => types.includes(hit.type))
      .filter(hit => `${hit.title ?? ""} ${hit.snippet ?? ""}`.toLowerCase().includes(query));
    return new Response(JSON.stringify({
      success: true,
      data: {
        source: "algolia",
        counts: {
          todo: hits.filter(hit => hit.type === "todo").length,
          memory: hits.filter(hit => hit.type === "memory").length,
          message: hits.filter(hit => hit.type === "message").length,
        },
        hits,
      },
    }));
  }
  if (url.includes("/api/overview")) return new Response(JSON.stringify({
    success: true,
    data: {
      counts: { pending: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0, active: 0, memories: 0 },
      in_progress: [], blocked: [], due_today: [], recent_memories: [], mood_trend: [], subtask_progress: {},
      // One task, two schedule rows: its due date and the reminder it was asked for.
      upcoming_reminders: [
        {
          id: "reminder_due", todo_id: "todo_reminder", todo_title: "Review RFC for Alex",
          kind: "due", scheduled_for: "2026-07-29T04:00:00.000Z", status: "pending",
        },
        {
          id: "reminder_pre", todo_id: "todo_reminder", todo_title: "Review RFC for Alex",
          kind: "pre", scheduled_for: "2026-07-29T13:00:00.000Z", status: "pending",
        },
      ],
    },
  }));
  if (url.includes("/api/integrations/events")) return new Response(JSON.stringify({ success: true, data: [] }));
  if (url.includes("/api/integrations/atlassian/connect")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { siteUrl: string; email: string };
    atlassian = {
      configured: true,
      status: "connected",
      siteUrl: body.siteUrl,
      email: body.email,
      accountId: "acc_me",
      displayName: "Dana Scully",
      jiraAvailable: true,
      confluenceAvailable: true,
    };
    return new Response(JSON.stringify({ success: true, data: { config: atlassian } }));
  }
  // The board and space pickers read Atlassian through the agent tool endpoint,
  // so the UI sees exactly what the Agent would.
  if (url.includes("/api/agent/tools/list_jira_boards")) {
    const { name_filter: filter } = JSON.parse(String(init?.body ?? "{}")) as { name_filter: string | null };
    const boards = [{ id: 84, name: "Growth", project_key: "GROW" }]
      .filter(board => !filter || board.name.toLowerCase().includes(filter.toLowerCase()));
    return new Response(JSON.stringify({ success: true, data: { boards } }));
  }
  if (url.includes("/api/agent/tools/list_confluence_spaces")) return new Response(JSON.stringify({
    success: true,
    data: { spaces: [{ id: "77", key: "GROW", name: "Growth space" }] },
  }));
  if (url.includes("/api/digest-briefs")) {
    const method = init?.method || "GET";
    if (url.endsWith("/test")) {
      const briefId = url.split("/").at(-2) || "";
      const brief = digestBriefs.find(entry => entry.id === briefId);
      if (!brief) return new Response(JSON.stringify({ success: false, error: "Digest brief not found" }), { status: 404 });
      return new Response(JSON.stringify({
        success: true,
        data: {
          text: "GROW-12 moved to In Review since yesterday.",
          sent: false,
          date: "2026-07-28",
          timezone: "America/New_York",
        },
      }));
    }
    const briefId = url.split("/").pop() || "";
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const brief = {
        id: `brief_${digestBriefs.length + 1}`,
        resources: [],
        enabled: true,
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:00.000Z",
        ...body,
      };
      digestBriefs.push(brief);
      return new Response(JSON.stringify({ success: true, data: brief }));
    }
    if (method === "PATCH") {
      const index = digestBriefs.findIndex(brief => brief.id === briefId);
      digestBriefs[index] = {
        ...digestBriefs[index],
        ...JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ success: true, data: digestBriefs[index] }));
    }
    if (method === "DELETE") {
      digestBriefs = digestBriefs.filter(brief => brief.id !== briefId);
      return new Response(JSON.stringify({ success: true, data: { id: briefId } }));
    }
    return new Response(JSON.stringify({ success: true, data: digestBriefs }));
  }
  if (url.includes("/api/conversations/channels/thread_test/messages")) return new Response(JSON.stringify({
    success: true,
    data: [{
      id: "message_test",
      direction: "inbound",
      role: "user",
      content: "Remember this conversation",
      status: "received",
      metadata: {},
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:00:00.000Z",
    }, {
      // The same call, stored the two ways the agent runner stores it: its own
      // tool row, then again inside the parts of the reply that closes the turn.
      id: "message_test_tool",
      direction: "outbound",
      role: "tool",
      content: "create_memory",
      status: "delivered",
      metadata: {
        toolCallId: "call_remember",
        input: { kind: "journal", title: "A day worth remembering" },
        output: { success: true, data: { title: "A day worth remembering" } },
      },
      createdAt: "2026-07-20T20:00:05.000Z",
      updatedAt: "2026-07-20T20:00:05.000Z",
    }, {
      // Two more calls in the same run, one of them repeated, so the archive has
      // a run to condense rather than three cards to stack.
      id: "message_test_tool_2",
      direction: "outbound",
      role: "tool",
      content: "set_todo_status",
      status: "delivered",
      metadata: {
        toolCallId: "call_status_a",
        input: { id: "todo_a", status: "done" },
        output: { success: true, data: { title: "Follow up with Paul" } },
      },
      createdAt: "2026-07-20T20:00:06.000Z",
      updatedAt: "2026-07-20T20:00:06.000Z",
    }, {
      id: "message_test_tool_3",
      direction: "outbound",
      role: "tool",
      content: "set_todo_status",
      status: "delivered",
      metadata: {
        toolCallId: "call_status_b",
        input: { id: "todo_b", status: "done" },
        output: { success: true, data: { title: "Ask Paul for a status update" } },
      },
      createdAt: "2026-07-20T20:00:07.000Z",
      updatedAt: "2026-07-20T20:00:07.000Z",
    }, {
      id: "message_test_reply",
      direction: "outbound",
      role: "assistant",
      content: "Saved it as today's journal entry.",
      status: "delivered",
      metadata: {
        parts: [{
          type: "tool-create_memory",
          tool_call_id: "call_remember",
          state: "output-available",
          input: { kind: "journal", title: "A day worth remembering" },
          output: { success: true, data: { title: "A day worth remembering" } },
        }, { type: "text", text: "Saved it as today's journal entry." }],
      },
      createdAt: "2026-07-20T20:00:08.000Z",
      updatedAt: "2026-07-20T20:00:08.000Z",
    }],
  }));
  if (url.includes("/api/conversations/channels/thread_reflection/messages")) return new Response(JSON.stringify({
    success: true,
    data: [{
      id: "message_reflection_request",
      direction: "inbound",
      role: "user",
      content: "Draft a personal reflection for This month. Call get_reflection_evidence with internal arguments.",
      status: "received",
      metadata: { kind: "reflection_generation", label: "This month · Jul 1–Jul 31", selectedCount: 2 },
      createdAt: "2026-07-22T21:57:00.000Z",
      updatedAt: "2026-07-22T21:57:00.000Z",
    }, {
      id: "message_reflection_result",
      direction: "outbound",
      role: "assistant",
      content: "## Highlights\n- Shipped onboarding",
      status: "delivered",
      metadata: {},
      createdAt: "2026-07-22T21:58:00.000Z",
      updatedAt: "2026-07-22T21:58:00.000Z",
    }],
  }));
  if (url.includes("/api/conversations/channels/thread_digest/messages")) return new Response(JSON.stringify({
    success: true,
    data: [{
      id: "message_brief_request",
      direction: "inbound",
      role: "user",
      content: [
        "Check the Operations Delivery board for ticket updates in the last 24 hours",
        "",
        "--- Context supplied by the app, not by me. Today is 2026-07-28 in America/New_York.",
        "Pinned Jira boards:",
        "- board_id 1002 \"Operations Delivery\"; columns: In Review [10083], Done [10001,10069]",
      ].join("\n"),
      status: "received",
      metadata: {
        kind: "digest_brief",
        briefId: "brief_1",
        briefName: "Morning Jira sweep",
        instruction: "Check the Operations Delivery board for ticket updates in the last 24 hours",
        date: "2026-07-28",
      },
      createdAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:00.000Z",
    }, {
      id: "message_brief_result",
      direction: "outbound",
      role: "assistant",
      content: "OPS-12 moved to In Review.",
      status: "sent",
      metadata: { kind: "digest_brief", briefName: "Morning Jira sweep" },
      createdAt: "2026-07-28T11:00:30.000Z",
      updatedAt: "2026-07-28T11:00:30.000Z",
    }],
  }));
  if (url.includes("/api/conversations/channels/thread_web/messages")) return new Response(JSON.stringify({
    success: true,
    data: Array.from({ length: 35 }, (_, index) => ({
      id: index === 14 ? "message_launch" : `message_web_${index}`,
      direction: index % 2 ? "outbound" : "inbound",
      role: index % 2 ? "assistant" : "user",
      content: index === 14 ? "We discussed the NeuralSearch launch plan." : `Web conversation message ${index + 1}`,
      status: "delivered",
      metadata: {},
      createdAt: `2026-07-20T20:${String(index).padStart(2, "0")}:00.000Z`,
      updatedAt: `2026-07-20T20:${String(index).padStart(2, "0")}:00.000Z`,
    })),
  }));
  if (url.includes("/api/conversations/search")) return new Response(JSON.stringify({
    success: true,
    data: {
      source: "algolia",
      hits: [{
        objectID: "message_launch",
        threadId: "thread_web",
        channel: "web",
        role: "user",
        content: "We discussed the NeuralSearch launch plan.",
        created_at: "2026-07-20T20:14:00.000Z",
      }],
    },
  }));
  if (url.endsWith("/api/conversations/channels")) return new Response(JSON.stringify({
    success: true,
    data: [{
      id: "thread_web",
      channel: "web",
      address: "browser-agent",
      messageCount: 35,
      lastMessage: "Web conversation message 35",
      lastMessageAt: "2026-07-20T20:34:00.000Z",
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:34:00.000Z",
    }, {
      id: "thread_test",
      channel: "sms",
      address: "+17185551111",
      messageCount: 3,
      lastMessage: "Saved it as today's journal entry.",
      lastMessageAt: "2026-07-20T20:00:08.000Z",
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:00:00.000Z",
    }, {
      id: "thread_reflection",
      channel: "web",
      address: "reflection:1234567890abcdef1234",
      messageCount: 2,
      lastMessage: "## Highlights\n- Shipped onboarding",
      lastMessageAt: "2026-07-22T21:58:00.000Z",
      createdAt: "2026-07-22T21:57:00.000Z",
      updatedAt: "2026-07-22T21:58:00.000Z",
    }, {
      id: "thread_digest",
      channel: "sms",
      address: "digest:+17185551111",
      messageCount: 2,
      lastMessage: "OPS-12 moved to In Review.",
      lastMessageAt: "2026-07-28T11:00:30.000Z",
      createdAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:30.000Z",
    }],
  }));
  if (url.endsWith("/api/integrations/tasks")) {
    Object.assign(taskPreferences, JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ success: true, data: taskPreferences }));
  }
  if (url.endsWith("/api/integrations")) return new Response(JSON.stringify({
    success: true,
    data: {
      secretStorageReady: true,
      twilio: { configured: false, status: "disconnected" },
      sendblue: { configured: false, status: "disconnected" },
      granola: { configured: false, status: "disconnected" },
      atlassian,
      notifications: {
        smsEnabled: false,
        smsProvider: "twilio",
        recipientPhone: null,
        timezone: "America/New_York",
        dailyDigestEnabled: false,
        dailyDigestTime: "09:00",
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        optedOutAt: null,
      },
      tasks: { ...taskPreferences },
      webhookPaths: {
        sms: "/api/webhooks/twilio/sms",
        status: "/api/webhooks/twilio/status",
        sendblueInbound: "/api/webhooks/sendblue/inbound",
        sendblueStatus: "/api/webhooks/sendblue/status",
      },
    },
  }));
  if (url.includes("/api/reminders/due")) return new Response(JSON.stringify({ success: true, data: [] }));
  if (url.includes("/api/reflections/period")) return new Response(JSON.stringify({
    success: true,
    data: {
      range: {
        preset: "month", key: "month:2026-07", label: "This month · Jul 1–Jul 31",
        start: "2026-07-01T04:00:00.000Z", endExclusive: "2026-08-01T04:00:00.000Z",
        startDate: "2026-07-01", endDate: "2026-07-31", timezone: "America/New_York",
      },
      scope_key: "reflection:1234567890abcdef1234",
      scope: { life_area_ids: [], category_ids: [], sources: ["memories", "todos"] },
      memories: [],
      todos: [],
      memory_candidates: [{
        id: "memory_win", title: "Shipped onboarding", content: "Reduced setup friction.", kind: "note",
        tags: ["highlight"], life_area_id: "area_work", life_area_name: "Work", life_area_slug: "work",
        occurred_at: "2026-07-10T14:00:00.000Z", review_worthy: true,
        created_at: "2026-07-10T14:00:00.000Z", updated_at: "2026-07-10T14:00:00.000Z",
      }],
      todo_candidates: [],
      selected: [],
      draft: null,
    },
  }));
  return new Response(JSON.stringify({ success: true, data: [] }));
}));

it("renders the standalone assistant shell and overview", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><App /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
  expect(screen.getByText("Fieldnote")).toBeInTheDocument();

  // A due date and the reminder asked for around it belong to one task, and two
  // rows for it read as a duplicate. A due date that only ever carried a day
  // must also not claim midnight.
  const reminders = screen.getByText("Coming up").closest("article") as HTMLElement;
  const rows = within(reminders).getAllByText("Review RFC for Alex");
  expect(rows).toHaveLength(1);
  const row = rows[0].closest(".list-row") as HTMLElement;
  expect(within(row).getByText("Due Jul 29")).toBeInTheDocument();
  expect(within(row).getByText("Reminder")).toBeInTheDocument();
  expect(within(row).getByText("Jul 29 · 9:00 AM")).toBeInTheDocument();
  expect(within(row).getByText("Due")).toBeInTheDocument();
});

/**
 * Three tabs is the point of the rail, so the pages about the app rather than
 * about your work are one row down and one click in — but still reachable.
 */
it("keeps how it works and settings in the sidebar's footer menu", async () => {
  renderAt("/");
  expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "How it works" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /More/ }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "How it works" })).toHaveAttribute("href", "/setup");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Settings" }));
  expect(await screen.findByText("Settings.")).toBeInTheDocument();
  // Choosing something closes the menu behind you.
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

/**
 * The theme is an attribute on <html> and a tint on the browser chrome, so it
 * outlives the React tree that set it and has to be restored on the next visit.
 */
it("switches the theme from the sidebar and remembers the choice", async () => {
  window.localStorage.clear();
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  document.head.append(meta);
  try {
    const first = renderAt("/");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    // Nothing is stored yet, so the app follows the system, which jsdom reports
    // as light because it implements no colour-scheme query at all.
    expect(document.documentElement.dataset.theme).toBe("light");

    const appearance = () => screen.getByRole("group", { name: "Appearance" });
    await userEvent.click(within(appearance()).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#101113");
    expect(window.localStorage.getItem("fieldnote:theme")).toBe("dark");

    first.unmount();
    renderAt("/");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    expect(within(appearance()).getByRole("button", { name: "Dark" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");

    await userEvent.click(within(appearance()).getByRole("button", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("fieldnote:theme")).toBe("system");
  } finally {
    meta.remove();
    window.localStorage.clear();
  }
});

/**
 * Collapsing the rail takes the labels off rows that are still there, so the test
 * asserts the links survive it — and that the choice outlives the tree, since a
 * rail you have to re-collapse on every visit is not a preference.
 */
it("collapses the sidebar to a rail and remembers it", async () => {
  window.localStorage.clear();
  try {
    const shell = () => document.querySelector(".app-shell");
    const first = renderAt("/");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    expect(shell()).toHaveAttribute("data-rail", "full");

    await userEvent.click(screen.getByRole("button", { name: "Collapse the navigation" }));
    expect(shell()).toHaveAttribute("data-rail", "collapsed");
    // Icon-only is a matter of CSS; every page has to stay reachable and named.
    expect(screen.getByRole("link", { name: "Memory" })).toHaveAttribute("href", "/memories");
    expect(window.localStorage.getItem("fieldnote:nav-collapsed")).toBe("true");

    first.unmount();
    renderAt("/");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    expect(shell()).toHaveAttribute("data-rail", "collapsed");

    await userEvent.click(screen.getByRole("button", { name: "Expand the navigation" }));
    expect(shell()).toHaveAttribute("data-rail", "full");
    expect(window.localStorage.getItem("fieldnote:nav-collapsed")).toBe("false");
  } finally {
    window.localStorage.clear();
  }
});

/** The panel stays mounted once opened, so "open" is a state, not presence. */
const agentPanel = () => document.querySelector(".agent-studio-panel");
/**
 * Both halves matter: the app's own wrapper and the chat widget, which keeps its
 * own open flag. Asserting only the wrapper would pass while the chat itself
 * stayed shut.
 */
const agentPanelIsOpen = () => agentPanel()?.getAttribute("data-open") === "true"
  && Boolean(document.querySelector(".ais-Chat-container--open"));
/** The widget schedules its own render, so opening settles a few ticks later. */
const expectPanel = (open: boolean) =>
  waitFor(() => expect(agentPanelIsOpen()).toBe(open), { timeout: 3000 });

describe("agent side panel", () => {
  it("opens from any page with Cmd+I and survives navigation", async () => {
    renderAt("/todos");
    expect(await screen.findByText("The board.")).toBeInTheDocument();
    // Nothing is mounted until the agent is asked for.
    expect(agentPanel()).toBeNull();

    await userEvent.keyboard("{Meta>}i{/Meta}");
    await expectPanel(true);
    const mounted = agentPanel();
    await userEvent.type(screen.getByPlaceholderText(/Ask about your work/), "half a thought");

    await userEvent.click(screen.getByRole("link", { name: "Memory" }));
    expect(await screen.findByText("Memory, made useful.")).toBeInTheDocument();
    // The same element, not a remount: the conversation has to outlive the route.
    expect(agentPanel()).toBe(mounted);
    expect(agentPanelIsOpen()).toBe(true);
    // Chat state lives in the widget, which is rebuilt if any of its props stop
    // being identical between renders. A surviving draft proves it was not.
    expect(screen.getByPlaceholderText(/Ask about your work/)).toHaveValue("half a thought");

    await userEvent.keyboard("{Meta>}i{/Meta}");
    await expectPanel(false);
    expect(agentPanel()).toBe(mounted);
  });

  it("redirects the retired /chat route home with the panel open", async () => {
    renderAt("/chat");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    await expectPanel(true);
    expect(screen.queryByRole("link", { name: "Agent" })).not.toBeInTheDocument();
  });

  it("opens from the floating launcher", async () => {
    renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: /Ask Fieldnote/ }));
    await expectPanel(true);
  });

  /**
   * The panel covers a corner of the page rather than taking a column out of it,
   * and how much of the corner is a choice that outlives one answer.
   */
  it("expands and collapses the panel from its header", async () => {
    renderAt("/");
    await userEvent.keyboard("{Meta>}i{/Meta}");
    await expectPanel(true);
    expect(agentPanel()).toHaveAttribute("data-expanded", "false");

    await userEvent.click(screen.getByRole("button", { name: "Expand the agent panel" }));
    await waitFor(() => expect(agentPanel()).toHaveAttribute("data-expanded", "true"));
    expect(document.querySelector(".ais-Chat-container--maximized")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Collapse the agent panel" }));
    await waitFor(() => expect(agentPanel()).toHaveAttribute("data-expanded", "false"));
    expect(document.querySelector(".ais-Chat-container--maximized")).toBeNull();
  });

  /**
   * A prefilled sentence is an invitation, not a command: the point of the chips
   * on Today is that the agent gets your words, so the draft has to arrive
   * editable and unsent.
   */
  it("starts a sentence from Today without sending it", async () => {
    renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: "Add a todo" }));
    await expectPanel(true);
    const composer = screen.getByPlaceholderText(/Ask about your work/);
    await waitFor(() => expect(composer).toHaveValue("Add a todo to "));
    // Still on the empty state, so nothing was sent on the user's behalf.
    expect(screen.getByText("What should we work through?")).toBeInTheDocument();

    await userEvent.type(composer, "call the venue");
    expect(composer).toHaveValue("Add a todo to call the venue");
  });

  it("reads past conversations in the panel and hands the thread to History", async () => {
    renderAt("/");
    await userEvent.keyboard("{Meta>}i{/Meta}");
    await expectPanel(true);

    await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
    const threads = await screen.findByRole("complementary", { name: "Conversations" });
    await userEvent.click(await within(threads).findByRole("button", { name: /Web agent/ }));
    expect(await within(threads).findByText("We discussed the NeuralSearch launch plan.")).toBeInTheDocument();
    // Traces and workflow blocks are the archive's job, and it is one link away.
    expect(within(threads).getByRole("link", { name: /Open the full thread/ }))
      .toHaveAttribute("href", "/history?thread=thread_web");

    // The live chat was covered, not closed, so the conversation is still there.
    await userEvent.click(within(threads).getByRole("button", { name: "Live chat" }));
    expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull();
    expect(agentPanelIsOpen()).toBe(true);
  });

  /**
   * A result is matched back to the call it answers, and the widget will settle
   * for a match on the tool's *name* — which puts the second result on the first
   * call. Asking twice for the same tool is ordinary ("start it", then "it's
   * done"), and used to leave the second card spinning on a change that had
   * already been saved, with no reply after it, because the turn only continues
   * once every call it made has settled.
   */
  it("finishes the card the second time the agent reaches for one tool", async () => {
    const changesStatus = (toolCallId: string, status: string) => [
      { type: "start", messageId: `asst_${toolCallId}` },
      { type: "tool-input-available", toolCallId, toolName: "set_todo_status", input: { id: "todo_reminder", status } },
      { type: "finish" },
    ];
    const says = (id: string, text: string) => [
      { type: "start", messageId: `asst_${id}` },
      { type: "text-start", id },
      { type: "text-delta", id, delta: text },
      { type: "text-end", id },
      { type: "finish" },
    ];
    agentStream = [
      changesStatus("call_1", "in_progress"), says("said_1", "Marked it in progress."),
      changesStatus("call_2", "done"), says("said_2", "Marked it done."),
    ];

    renderAt("/");
    await userEvent.keyboard("{Meta>}i{/Meta}");
    await expectPanel(true);
    const panel = agentPanel() as HTMLElement;
    const composer = within(panel).getByPlaceholderText(/Ask about your work/);

    const send = async (text: string) => {
      await userEvent.type(composer, text);
      await userEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    };

    await send("Alex RFC is in progress");
    expect(await within(panel).findByText("Marked it in progress.")).toBeInTheDocument();

    await send("RFC for Alex is done");
    expect(await within(panel).findByText("Marked it done.")).toBeInTheDocument();

    expect(within(panel).getAllByText("Task status updated")).toHaveLength(2);
    expect(within(panel).queryByText("One moment…")).toBeNull();
  });
});

/**
 * What the widget put on the wire, which is the only place an attachment is
 * observable: it travels as turn context rather than as anything the user typed.
 */
function lastTurnContext(): Record<string, string> {
  const request = vi.mocked(fetch).mock.calls
    .filter(call => String(call[0]).includes("/agent-studio/1/agents/")).at(-1);
  const body = JSON.parse(String(request?.[1]?.body ?? "{}")) as {
    messages?: Array<{ metadata?: { turnContext?: Record<string, string> } }>;
  };
  return body.messages?.at(-1)?.metadata?.turnContext ?? {};
}

/** What the demo chat posted, which the panel may have prefixed for it. */
function lastChatMessage(): string | undefined {
  const request = vi.mocked(fetch).mock.calls
    .filter(call => String(call[0]).endsWith("/api/chat")).at(-1);
  return (JSON.parse(String(request?.[1]?.body ?? "{}")) as { content?: string }).content;
}

describe("attaching a record to the agent", () => {
  /**
   * The point of the paperclip is that the sentence after it can be short. The
   * record has to arrive whole — a parent with the ids and states of its steps —
   * or "the outline is done" is still a question about which outline.
   */
  it("carries an attached task into the turn and spends it on send", async () => {
    agentStream = [[
      { type: "start", messageId: "asst_attached" },
      { type: "text-start", id: "attached" },
      { type: "text-delta", id: "attached", delta: "Closed that step and added the next one." },
      { type: "text-end", id: "attached" },
      { type: "finish" },
    ]];
    renderAt("/todos");
    expect(await screen.findByText("The board.")).toBeInTheDocument();

    const row = taskRow("Prepare the DevCon demo");
    await userEvent.click(within(row).getByRole("button", { name: "Attach to chat: Prepare the DevCon demo" }));
    await expectPanel(true);
    const panel = agentPanel() as HTMLElement;
    expect(within(panel).getByText("Task")).toBeInTheDocument();
    expect(within(panel).getByText("Prepare the DevCon demo")).toBeInTheDocument();

    await userEvent.type(
      within(panel).getByPlaceholderText(/Ask about your work/),
      "the outline is done, follow it up with a rehearsal",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    expect(await within(panel).findByText("Closed that step and added the next one.")).toBeInTheDocument();

    const context = lastTurnContext();
    expect(context.attachedRecordCount).toBe("1");
    const attached = JSON.parse(context.attachedRecords) as Array<Record<string, unknown>>;
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ type: "todo", id: "todo_1", status: "pending" });
    expect(attached[0].subtasks).toEqual([{ id: "todo_sub", title: "Write the outline", status: "done" }]);

    // The message stayed the user's own sentence, and the chip went with it.
    expect(within(panel).getByText("the outline is done, follow it up with a rehearsal")).toBeInTheDocument();
    await waitFor(() => expect(
      within(panel).queryByRole("button", { name: /^Remove Prepare the DevCon demo/ }),
    ).toBeNull());
  });

  /** A subtask is attachable in its own right, and says which task it belongs to. */
  it("names the parent of an attached subtask", async () => {
    renderAt("/todos");
    expect(await screen.findByText("The board.")).toBeInTheDocument();
    await userEvent.click(within(taskRow("Prepare the DevCon demo")).getByText("1/1"));

    await userEvent.click(within(taskRow("Write the outline"))
      .getByRole("button", { name: "Attach to chat: Write the outline" }));
    await expectPanel(true);
    const panel = agentPanel() as HTMLElement;
    expect(within(panel).getByText("Subtask")).toBeInTheDocument();

    await userEvent.type(within(panel).getByPlaceholderText(/Ask about your work/), "this one is done");
    await userEvent.click(within(panel).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(lastTurnContext().attachedRecords).toBeDefined());
    expect(JSON.parse(lastTurnContext().attachedRecords)[0]).toMatchObject({
      type: "subtask",
      id: "todo_sub",
      parent_id: "todo_1",
      parent_title: "Prepare the DevCon demo",
    });
  });

  /**
   * Pressing the same paperclip twice is someone checking it worked, not someone
   * asking for the record twice.
   */
  it("attaches a memory once and lets it be taken back off", async () => {
    renderAt("/memories");
    expect(await screen.findByText("Memory, made useful.")).toBeInTheDocument();

    const attach = await screen.findByRole("button", { name: "Attach to chat: Talk framing" });
    await userEvent.click(attach);
    await expectPanel(true);
    const panel = agentPanel() as HTMLElement;
    await userEvent.click(screen.getByRole("button", { name: "Attached to chat: Talk framing" }));
    expect(within(panel).getAllByText("Memory")).toHaveLength(1);

    await userEvent.click(within(panel).getByRole("button", { name: "Remove Talk framing from the message" }));
    expect(within(panel).queryByText("Memory")).toBeNull();
  });

  /** Reflection evidence is attachable too, so a highlight can be talked through. */
  it("attaches reflection evidence from the evidence list", async () => {
    renderAt("/reflections");
    expect(await screen.findByText("Reflections.")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Attach to chat: Shipped onboarding" }));
    await expectPanel(true);
    expect(within(agentPanel() as HTMLElement).getByText("Shipped onboarding")).toBeInTheDocument();
  });

  /**
   * Turn context is validated for shape and length on the way in, so a rejected
   * payload would lose the whole turn rather than one over-long note.
   */
  it("keeps the serialized records inside the context contract", () => {
    const long = Array.from({ length: 8 }, (_, index) => memoryAttachment(
      memory({ id: `memory_${index}`, content: "x".repeat(4000) }) as unknown as Memory,
    ));
    const context = serializeAttachments(long);
    expect(context.attachedRecordCount).toBe("5");
    expect(context.attachedRecords.length).toBeLessThanOrEqual(3500);
    const records = JSON.parse(context.attachedRecords) as Array<{ id: string; content: string }>;
    expect(records.map(record => record.id)).toEqual([
      "memory_0", "memory_1", "memory_2", "memory_3", "memory_4",
    ]);
    // A truncated note says so rather than stopping mid-word with no sign.
    expect(records[0].content).toMatch(/x…$/);
    expect(records[0].content.length).toBeLessThan(300);

    expect(serializeAttachments([])).toEqual({});
  });

  /** Nulls the agent would have to reason about the absence of are left out. */
  it("sends only the fields a record actually has", () => {
    const bare = todoAttachment(todo({ due_at: null, priority: null }) as unknown as Todo);
    expect(bare.record).toEqual({
      type: "todo",
      id: "todo_1",
      title: "Prepare the DevCon demo",
      status: "pending",
      life_area: "Work",
    });
  });
});

describe("universal search", () => {
  const openPalette = async () => {
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const palette = await screen.findByRole("dialog");
    await userEvent.type(
      within(palette).getByLabelText("Search memories, todos, and conversations"),
      "the",
    );
    return palette;
  };

  it("groups results across memories, todos, and conversations", async () => {
    renderAt("/");
    expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
    const palette = await openPalette();

    expect(await within(palette).findByRole("option", { name: /Talk framing/ })).toBeInTheDocument();
    expect(within(palette).getByRole("option", { name: /Prepare the DevCon demo/ })).toBeInTheDocument();
    expect(within(palette).getByRole("option", { name: /NeuralSearch launch plan/ })).toBeInTheDocument();
    expect(within(palette).getByText("Conversation history")).toBeInTheDocument();
    // Counts come from the endpoint rather than the rendered rows.
    expect(within(palette).getByRole("button", { name: "Everything 4" })).toBeInTheDocument();

    await userEvent.click(within(palette).getByRole("button", { name: /^Todos/ }));
    await waitFor(() => expect(within(palette).queryByRole("option", { name: /Talk framing/ })).not.toBeInTheDocument());
    expect(within(palette).getByRole("option", { name: /Prepare the DevCon demo/ })).toBeInTheDocument();
    expect(requestedUrls.some(url => url.includes("/api/search") && url.includes("types=todo"))).toBe(true);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the memory a result points at", async () => {
    renderAt("/");
    const palette = await openPalette();
    await userEvent.click(await within(palette).findByRole("option", { name: /Talk framing/ }));

    const editor = await screen.findByRole("dialog");
    expect(editor).toHaveTextContent("Edit memory");
    expect(within(editor).getByDisplayValue("Talk framing")).toBeInTheDocument();
  });

  it("walks arrow keys down the rendered order, not the response order", async () => {
    renderAt("/");
    const palette = await openPalette();
    await within(palette).findByRole("option", { name: /Talk framing/ });

    // Rendered order is the agent, both memories, the todo, then the message —
    // the endpoint returns the second memory last.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(within(palette).getByRole("option", { name: /Prepare the DevCon demo/ }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("The board.")).toBeInTheDocument();
    expect(await screen.findByRole("dialog")).toHaveTextContent("Edit task");
  });

  it("keeps the highlighted row in view", async () => {
    // The result list scrolls, and jsdom has no layout, so the call is the only
    // observable part of following the highlight past the fold.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderAt("/");
      const palette = await openPalette();
      await within(palette).findByRole("option", { name: /Talk framing/ });
      scrollIntoView.mockClear();

      await userEvent.keyboard("{ArrowDown}");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("asks the agent on Enter without picking a row", async () => {
    renderAt("/");
    const palette = await openPalette();
    // The agent row is selected by default, so Enter needs no navigation.
    expect(await within(palette).findByRole("option", { name: /Ask the agent/ }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");
    await expectPanel(true);
    // Handing the question over sends it; it does not wait for a second Enter.
    const sent = await within(agentPanel() as HTMLElement).findByRole("article");
    expect(sent).toHaveAttribute("data-role", "user");
    expect(sent).toHaveTextContent("the");
    expect(screen.getByPlaceholderText(/Ask about your work/)).toHaveValue("");
  });
});

/** Without Agent Studio credentials the same shortcut has to reach the demo chat. */
describe("fallback agent panel", () => {
  it("takes over the panel and sends through the local demo chat", async () => {
    vi.stubEnv("VITE_ALGOLIA_AGENT_ID", "");
    try {
      renderAt("/");
      expect(await screen.findByText("Your day, in focus.")).toBeInTheDocument();
      await userEvent.keyboard("{Meta>}k{/Meta}");
      const palette = await screen.findByRole("dialog");
      await userEvent.type(within(palette).getByLabelText("Search memories, todos, and conversations"), "wifi");
      await userEvent.click(await within(palette).findByRole("option", { name: /Ask the agent/ }));

      const panel = await screen.findByRole("complementary", { name: "Fieldnote agent" });
      expect(within(panel).getByText("Local demo mode")).toBeInTheDocument();
      // The handed-over question is sent, not parked in the composer.
      await waitFor(() => expect(requestedUrls.some(url => url.endsWith("/api/chat"))).toBe(true));
      const composer = within(panel).getByLabelText("Message the agent");
      expect(composer).toHaveValue("");

      await userEvent.click(await within(panel).findByRole("button", { name: /Remember that my conference talk/ }));
      expect(composer).toHaveValue("Remember that my conference talk is about NeuralSearch.");
      const before = requestedUrls.length;
      await userEvent.click(within(panel).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(
        requestedUrls.slice(before).some(url => url.endsWith("/api/chat")),
      ).toBe(true));
      expect(composer).toHaveValue("");

      await userEvent.click(within(panel).getByRole("button", { name: "Close agent panel" }));
      await waitFor(() => expect(panel.getAttribute("data-open")).toBe("false"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("receives a prefilled sentence without sending it", async () => {
    vi.stubEnv("VITE_ALGOLIA_AGENT_ID", "");
    try {
      renderAt("/");
      await userEvent.click(await screen.findByRole("button", { name: "Remember something" }));
      const panel = await screen.findByRole("complementary", { name: "Fieldnote agent" });
      expect(within(panel).getByLabelText("Message the agent")).toHaveValue("Remember that ");
      expect(within(panel).getByText("Start with what’s on your mind.")).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * `/api/chat` takes a sentence and nothing else, so here the attachment has to
   * go in as text. The chip is the same either way.
   */
  it("writes an attached record into the message it cannot send as context", async () => {
    vi.stubEnv("VITE_ALGOLIA_AGENT_ID", "");
    try {
      renderAt("/memories");
      expect(await screen.findByText("Memory, made useful.")).toBeInTheDocument();
      await userEvent.click(await screen.findByRole("button", { name: "Attach to chat: Talk framing" }));

      const panel = await screen.findByRole("complementary", { name: "Fieldnote agent" });
      expect(within(panel).getByText("Talk framing")).toBeInTheDocument();
      await userEvent.type(within(panel).getByLabelText("Message the agent"), "what did I mean by this?");
      await userEvent.click(within(panel).getByRole("button", { name: "Send" }));

      await waitFor(() => expect(lastChatMessage()).toBe(
        "[Attached record]\n- Talk framing\n\nwhat did I mean by this?",
      ));
      expect(within(panel).queryByText("Talk framing")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("renders secure messaging and event integration settings", async () => {
  window.localStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Settings.")).toBeInTheDocument();
  expect(screen.getByText("Message provider")).toBeInTheDocument();
  expect(screen.getByText("Delivery schedule")).toBeInTheDocument();
  expect(screen.getByText("Meeting notes")).toBeInTheDocument();
  expect(screen.getByText("Twilio SMS")).toBeInTheDocument();
  expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
  // Sendblue is the other half of the toggle, and its form replaces Twilio's.
  await userEvent.click(screen.getByText("Message provider"));
  await userEvent.click(screen.getByRole("tab", { name: /Sendblue/ }));
  expect(screen.getByText("Sendblue iMessage")).toBeInTheDocument();
  expect(screen.queryByText("Twilio SMS")).not.toBeInTheDocument();
  expect(screen.getByLabelText("API key ID")).toHaveValue("");
  const delivery = screen.getByText("Delivery schedule").closest("details") as HTMLDetailsElement;
  expect(delivery.open).toBe(false);
  await userEvent.click(screen.getByText("Delivery schedule"));
  expect(delivery.open).toBe(true);
  expect(JSON.parse(window.localStorage.getItem("fieldnote:settings-sections") || "{}")).toMatchObject({
    "delivery-schedule": true,
  });
  await userEvent.click(screen.getByText("Under the hood"));
  // Search mode, its actions, and the index names share one panel now.
  expect(screen.getByText("Search mode")).toBeInTheDocument();
  expect(screen.getByText("devcon_assistant_todos")).toBeInTheDocument();
  const explainer = screen.getByText("The consistency contract").closest("details") as HTMLDetailsElement;
  expect(explainer.open).toBe(false);
  await userEvent.click(screen.getByText("Danger zone"));
  await userEvent.click(screen.getByRole("button", { name: "Replace with demo data" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("This cannot be undone");
  const destructiveButton = screen.getByRole("button", { name: "Delete and seed" });
  expect(destructiveButton).toBeDisabled();
  await userEvent.type(within(dialog).getByRole("textbox"), "SEED");
  expect(destructiveButton).toBeEnabled();
});

it("fills the brief form from the end-of-day template and flags a send time inside quiet hours", async () => {
  window.localStorage.clear();
  resetAtlassianFixtures();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Settings.")).toBeInTheDocument();

  await userEvent.click(screen.getByText("Digest briefs"));
  const briefSection = screen.getByText("Digest briefs").closest("details") as HTMLDetailsElement;
  const newBrief = briefSection.querySelector(".brief-new") as HTMLElement;
  await userEvent.click(within(newBrief).getByRole("button", { name: /End-of-day reflection/ }));

  const sendTime = within(newBrief).getByLabelText("Texted at");
  expect(within(newBrief).getByLabelText("Brief name")).toHaveValue("End-of-day reflection");
  expect(sendTime).toHaveValue("21:00");
  expect((within(newBrief).getByLabelText("Instruction") as HTMLTextAreaElement).value)
    .toContain("anything I want to record");

  // Quiet hours run 22:00–07:00, and a brief scheduled inside them is silently
  // never sent, so the form has to say so before the brief is created.
  expect(within(newBrief).queryByText(/falls inside your quiet hours/)).not.toBeInTheDocument();
  fireEvent.change(sendTime, { target: { value: "23:00" } });
  expect(await within(newBrief).findByText(/11:00 PM falls inside your quiet hours/)).toBeInTheDocument();
  fireEvent.change(sendTime, { target: { value: "21:00" } });
  expect(within(newBrief).queryByText(/falls inside your quiet hours/)).not.toBeInTheDocument();

  await userEvent.click(within(newBrief).getByRole("button", { name: /Add brief/ }));
  expect(await screen.findByText("Brief created. Pin the boards and spaces it should cover.")).toBeInTheDocument();
  expect(digestBriefs[0]).toMatchObject({ name: "End-of-day reflection", sendTime: "21:00" });
  expect(String(digestBriefs[0].prompt)).toContain("It is the end of my day.");
});

it("connects Atlassian and pins a board and a space to a digest brief", async () => {
  window.localStorage.clear();
  resetAtlassianFixtures();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Settings.")).toBeInTheDocument();

  await userEvent.click(screen.getByText("Jira & Confluence"));
  const atlassianSection = screen.getByText("Jira & Confluence").closest("details") as HTMLDetailsElement;
  const connect = within(atlassianSection).getByRole("button", { name: "Connect Atlassian" });
  expect(connect).toBeDisabled();
  await userEvent.type(within(atlassianSection).getByLabelText("Site URL"), "https://example.atlassian.net");
  await userEvent.type(within(atlassianSection).getByLabelText("Atlassian account email"), "demo@example.com");
  await userEvent.type(within(atlassianSection).getByLabelText("API token"), "atlassian-token");
  expect(connect).toBeEnabled();
  await userEvent.click(connect);
  expect(await screen.findByText("Atlassian connected for Jira and Confluence")).toBeInTheDocument();
  // Each product is licensed separately, so the card reports them separately.
  expect(await within(atlassianSection).findByText("Jira available")).toBeInTheDocument();
  expect(within(atlassianSection).getByText("Confluence available")).toBeInTheDocument();

  await userEvent.click(screen.getByText("Digest briefs"));
  const briefSection = screen.getByText("Digest briefs").closest("details") as HTMLDetailsElement;
  const newBrief = briefSection.querySelector(".brief-new") as HTMLElement;
  await userEvent.type(within(newBrief).getByLabelText("Brief name"), "Morning sweep");
  await userEvent.type(within(newBrief).getByLabelText("Instruction"), "What is in review?");
  await userEvent.click(within(newBrief).getByRole("button", { name: /Add brief/ }));
  expect(await screen.findByText("Brief created. Pin the boards and spaces it should cover.")).toBeInTheDocument();

  const saved = await within(briefSection).findByText("Morning sweep");
  await userEvent.click(saved);
  const editor = saved.closest("details") as HTMLDetailsElement;
  expect(within(editor).getByText(/Nothing pinned/)).toBeInTheDocument();

  await userEvent.type(within(editor).getByLabelText("Pin a Jira board"), "Grow");
  await userEvent.click(await within(editor).findByRole("button", { name: /Growth · GROW/ }));
  await userEvent.selectOptions(within(editor).getByLabelText("Pin a Confluence space"), "GROW");
  expect(within(editor).getByText("Unsaved")).toBeInTheDocument();
  expect(within(editor).getByRole("button", { name: /Unpin Growth$/ })).toBeInTheDocument();

  await userEvent.click(within(editor).getByRole("button", { name: /Save brief/ }));
  expect(await screen.findByText("“Morning sweep” saved")).toBeInTheDocument();
  expect(digestBriefs[0].resources).toEqual([
    { type: "jira_board", id: "84", name: "Growth" },
    { type: "confluence_space", id: "GROW", name: "Growth space" },
  ]);
  // The toast disappears after four seconds, so the write needs a confirmation
  // that stays with the brief it belongs to.
  expect(within(editor).queryByText("Unsaved")).not.toBeInTheDocument();
  expect(await within(editor).findByRole("status")).toHaveTextContent(/Saved\. It will text you at 8:00/);

  await userEvent.click(within(editor).getByRole("button", { name: /Test now/ }));
  expect(await within(editor).findByText("GROW-12 moved to In Review since yesterday.")).toBeInTheDocument();
  expect(within(editor).getByText("Preview · not sent")).toBeInTheDocument();
  expect(within(editor).getByText(/43 characters/)).toBeInTheDocument();

  // Unpinning is the only way back out, so it has to survive a round trip.
  await userEvent.click(within(editor).getByRole("button", { name: /Unpin Growth space/ }));
  await userEvent.click(within(editor).getByRole("button", { name: /Save brief/ }));
  await waitFor(() => expect(digestBriefs[0].resources).toEqual([
    { type: "jira_board", id: "84", name: "Growth" },
  ]));
});

it("defaults to keyword search and reports what the NeuralSearch toggle achieved", async () => {
  window.localStorage.clear();
  health.neuralSearch.enabled = false;
  neuralSearchSetupDetails = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByText("Under the hood"));
  expect(screen.getByText("Algolia keyword search")).toBeInTheDocument();

  const toggle = screen.getByRole("checkbox", { name: /NeuralSearch/ });
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);
  expect(await screen.findByText("Search mode set to NeuralSearch.")).toBeInTheDocument();
  expect(await screen.findByText("Algolia NeuralSearch")).toBeInTheDocument();

  // An application without the add-on keeps running, on keyword search.
  neuralSearchSetupDetails = { neuralSearch: "unavailable_for_plan" };
  await userEvent.click(screen.getByRole("checkbox", { name: /NeuralSearch/ }));
  expect(await screen.findByText(/not entitled to NeuralSearch/)).toBeInTheDocument();
  neuralSearchSetupDetails = null;
  health.neuralSearch.enabled = false;
});

/**
 * Whether finishing the last step finishes the task itself is a matter of how
 * someone works, so it is answered once in settings and enforced server-side
 * for every surface, including the Agent.
 */
it("saves whether a task closes itself with its last subtask", async () => {
  window.localStorage.clear();
  taskPreferences.autoCompleteParent = false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByText("Tasks"));
  expect(screen.getByText("Parent stays open")).toBeInTheDocument();

  const toggle = screen.getByRole("checkbox", { name: /last subtask/ });
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);

  expect(await screen.findByText("A task will close itself once its last subtask is done")).toBeInTheDocument();
  expect(taskPreferences.autoCompleteParent).toBe(true);
  expect(await screen.findByText("Parent closes itself")).toBeInTheDocument();
  taskPreferences.autoCompleteParent = false;
});

it("spins only the maintenance button that is actually running", async () => {
  window.localStorage.clear();
  let release = () => {};
  adminActionGate = new Promise<void>(resolve => { release = resolve; });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByText("Under the hood"));
  const reindex = screen.getByRole("button", { name: "Reindex" });
  const configure = screen.getByRole("button", { name: "Configure Algolia" });
  expect(reindex).toHaveAttribute("aria-busy", "false");

  await userEvent.click(reindex);
  // One mutation drives all three, so the row would otherwise spin as a whole.
  expect(reindex).toHaveAttribute("aria-busy", "true");
  expect(configure).toHaveAttribute("aria-busy", "false");
  expect(configure).toBeDisabled();

  release();
  adminActionGate = null;
  expect(await screen.findByText("Reindex complete")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Reindex" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Reindex" })).toHaveAttribute("aria-busy", "false");
});

it("explains searchable conversations and the core feature loops", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("One thought. One clear path.")).toBeInTheDocument();
  // The heading carries a deliberate line break, so match across its elements.
  expect(screen.getByRole("heading", { name: /One private system\.\s*Four useful loops\./ })).toBeInTheDocument();
  expect(screen.getByText("Remember the conversation")).toBeInTheDocument();
  expect(screen.getByText("Four doors into the same system.")).toBeInTheDocument();
  expect(screen.getByText("iMessage with Sendblue")).toBeInTheDocument();
  expect(screen.getByText("Read from Atlassian")).toBeInTheDocument();
  expect(screen.getByText(/A brief you write in your own words runs on its own schedule/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Recall/ }));
  expect(screen.getByText(/Web or SMS conversation text/)).toBeInTheDocument();
});

it("renders complete channel conversation history", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/history"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Every message, in one place.")).toBeInTheDocument();
  expect((await screen.findAllByText("Web Agent")).length).toBeGreaterThan(0);
  expect((await screen.findAllByText("Text Messages (Phone Number: +17185551111)")).length).toBeGreaterThan(0);
  expect((await screen.findAllByText("Web conversation message 35")).length).toBeGreaterThan(0);
  const search = screen.getByPlaceholderText("Search conversations…");
  await userEvent.type(search, "launch plan");
  expect(await screen.findByText("Semantic search · Algolia")).toBeInTheDocument();

  // A result marks the words it matched, in the row and in the message it opens,
  // and the message it opens is the one the reader is left looking at.
  const result = await screen.findByRole("button", { name: /We discussed the NeuralSearch launch plan/ });
  expect([...result.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(["launch", "plan"]);
  await userEvent.click(result);
  const opened = document.querySelector(".history-message.search-hit");
  expect(opened).toBeTruthy();
  expect([...(opened?.querySelectorAll("mark") ?? [])].map(mark => mark.textContent)).toEqual(["launch", "plan"]);
  await userEvent.clear(search);
  await userEvent.click((await screen.findAllByText("Reflection generator"))[0]);
  expect(await screen.findByText("This month · Jul 1–Jul 31")).toBeInTheDocument();
  expect(screen.getByText("Drafting from 2 selected records")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
  expect(screen.queryByText(/Call get_reflection_evidence with internal arguments/)).not.toBeInTheDocument();

  // A digest thread is a drafting workspace, not a conversation, and the turn the
  // app composed leads with the instruction rather than the board catalog.
  await userEvent.click((await screen.findAllByText("Digest drafts"))[0]);
  expect(await screen.findByText("Morning Jira sweep")).toBeInTheDocument();
  expect(screen.getByText("Digest brief")).toBeInTheDocument();
  expect(screen.getByText("Check the Operations Delivery board for ticket updates in the last 24 hours")).toBeInTheDocument();
  expect(screen.getByText("OPS-12 moved to In Review.")).toBeInTheDocument();
  expect(screen.getByText(/board_id 1002/)).not.toBeVisible();
  await userEvent.click(screen.getByText("What the app sent the agent"));
  expect(screen.getByText(/board_id 1002/)).toBeVisible();

  // A tool call is persisted twice, so the archive has to show it once, beside
  // the step that ran it rather than repeated under the reply that followed.
  await userEvent.click((await screen.findAllByText("Text Messages (Phone Number: +17185551111)"))[0]);
  expect(await screen.findByText("create_memory")).toBeInTheDocument();
  expect(screen.getAllByText("create_memory")).toHaveLength(1);
  const traced = document.querySelector(".history-message.role-tool");
  expect(traced?.querySelector(".history-trace")).toBeTruthy();
  // Delivery status belongs to messages the user was actually sent.
  expect(traced?.querySelector("footer")).not.toHaveTextContent("delivered");

  // A run of calls is one dated entry naming what it did, not one bubble per
  // call, and the individual cards are still there behind it.
  expect(document.querySelectorAll(".history-message.role-tool")).toHaveLength(1);
  expect(traced?.querySelectorAll("time")).toHaveLength(1);
  expect(screen.getByText("3 tool calls")).toBeInTheDocument();
  expect(screen.getByText("create_memory, set_todo_status ×2")).toBeInTheDocument();
  expect(traced?.querySelectorAll(".history-trace-run-body .history-trace")).toHaveLength(3);
});

/**
 * A deep-linked message used to be scrolled to and then immediately undone: the
 * same effect cleared the target, re-ran, found none, and pinned the list to the
 * newest message instead — so the jump worked or did not depending on timing.
 */
it("lands on a linked message instead of the newest one", async () => {
  const scrolled: number[] = [];
  const layout = {
    scrollTo: { configurable: true, writable: true, value: (to: ScrollToOptions) => void scrolled.push(to.top ?? 0) },
    scrollHeight: { configurable: true, get: () => 4000 },
    clientHeight: { configurable: true, get: () => 600 },
  };
  for (const [name, descriptor] of Object.entries(layout)) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  try {
    renderAt("/history?thread=thread_web&message=message_launch&q=launch+plan");
    const opened = await waitFor(() => {
      const node = document.querySelector(".history-message.search-hit");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(opened).toHaveTextContent("We discussed the NeuralSearch launch plan.");
    // The query travels with the link, so the palette's marks survive the jump.
    expect([...opened.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(["launch", "plan"]);
    await waitFor(() => expect(scrolled).not.toHaveLength(0));
    expect(scrolled).not.toContain(4000);
  } finally {
    for (const name of Object.keys(layout)) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
});

it("renders flexible reflection evidence, period controls, and highlight capture", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/reflections"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Reflections.")).toBeInTheDocument();
  expect(screen.getByText("Shipped onboarding")).toBeInTheDocument();
  expect(screen.getByText("0 selected")).toBeInTheDocument();
  const search = screen.getByLabelText("Search reflection evidence");
  await userEvent.type(search, "something missing");
  expect(screen.getByText("No matching evidence.")).toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole("button", { name: "Select" }));
  expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes("/api/reflections/selections"))).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Custom" }));
  expect(screen.getByLabelText("Reflection start date")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Log a highlight" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Capture a moment worth remembering");
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Rows are only comparable to each other once scoped to the task they describe. */
const taskRow = (title: string) =>
  screen.getByText(title).closest("tr") as HTMLElement;

it("lists tasks with status, schedule and subtask progress", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();

  const demo = taskRow("Prepare the DevCon demo");
  expect(within(demo).getByRole("button", { name: "Status: To do" })).toBeInTheDocument();
  expect(within(demo).getByText("Aug 1 · 12:00 PM")).toBeInTheDocument();
  expect(within(demo).getByText("! high")).toBeInTheDocument();
  expect(within(demo).getByText("1/1")).toBeInTheDocument();

  expect(within(taskRow("Rehearse the walkthrough"))
    .getByRole("button", { name: "Status: In progress" })).toBeInTheDocument();
  expect(within(taskRow("Book the flight"))
    .getByRole("button", { name: "Status: Done" })).toBeInTheDocument();
  // A subtask keeps the list dense by staying folded into its parent's count.
  expect(screen.queryByText("Write the outline")).not.toBeInTheDocument();

  // A row carries both times: the due date the task is measured against and the
  // reminder that will actually go out, with a count of the extras.
  const scheduled = taskRow("Review RFC for Alex");
  expect(within(scheduled).getByText("Jul 29")).toBeInTheDocument();
  expect(within(scheduled).getByText("Jul 29 · 9:00 AM +1")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Hide done/ }));
  expect(await screen.findByRole("button", { name: /Show done/ })).toBeInTheDocument();
  expect(requestedUrls.some(url => url.includes("includeDone=false"))).toBe(true);
  expect(screen.queryByText("Book the flight")).not.toBeInTheDocument();
});

/**
 * Dragging only exists on the board, so the list needs a way to move a task on
 * its own. Both views end up calling the same endpoint.
 */
it("changes a task's status from its row", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();

  const row = taskRow("Prepare the DevCon demo");
  await userEvent.click(within(row).getByRole("button", { name: "Status: To do" }));
  const menu = within(row).getByRole("menu");
  expect(within(menu).getByRole("menuitemradio", { name: "To do" }))
    .toHaveAttribute("aria-checked", "true");

  const writes = todoWrites.length;
  await userEvent.click(within(menu).getByRole("menuitemradio", { name: "In progress" }));
  await waitFor(() => expect(todoWrites.length).toBe(writes + 1));
  expect(todoWrites.at(-1)).toMatchObject({ method: "PATCH", body: { status: "in_progress" } });
  expect(within(row).queryByRole("menu")).not.toBeInTheDocument();
});

/**
 * The count told the reader that work existed without ever naming it, so both
 * the chevron and the count itself open the steps as rows of their own.
 */
it("opens a task's subtasks from its row", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();

  const demo = taskRow("Prepare the DevCon demo");
  await userEvent.click(within(demo).getByText("1/1"));
  const subtask = taskRow("Write the outline");
  expect(within(subtask).getByRole("button", { name: "Status: Done" })).toBeInTheDocument();

  await userEvent.click(within(demo).getByRole("button", { name: "Hide subtasks of Prepare the DevCon demo" }));
  expect(screen.queryByText("Write the outline")).not.toBeInTheDocument();
});

/**
 * A step left under a finished task is owed but unreachable, since only
 * top-level rows are ever drawn. The slip is caught where it happens.
 */
it("asks what to do with the open steps before finishing their task", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();
  const row = taskRow("Wrap the sprint");

  const writes = todoWrites.length;
  await userEvent.click(within(row).getByRole("button", { name: "Status: To do" }));
  await userEvent.click(within(within(row).getByRole("menu")).getByRole("menuitemradio", { name: "Done" }));
  const asked = await screen.findByRole("dialog");
  expect(asked).toHaveTextContent("Wrap the sprint still has 1 subtask to go");
  expect(within(asked).getByText("Send the recap")).toBeInTheDocument();
  expect(todoWrites.length).toBe(writes);

  await userEvent.click(within(asked).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(todoWrites.length).toBe(writes);

  await userEvent.click(within(row).getByRole("button", { name: "Status: To do" }));
  await userEvent.click(within(within(row).getByRole("menu")).getByRole("menuitemradio", { name: "Done" }));
  await userEvent.click(await screen.findByRole("button", { name: "Finish all 2" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(todoWrites.slice(writes)).toEqual([
    { method: "PATCH", body: { status: "done" } },
    { method: "PATCH", body: { status: "done" } },
  ]);
  // The step closes before the task that owns it, never the other way round.
  expect(requestedUrls.filter(url => url.includes("/status")).slice(-2)).toEqual([
    "/api/todos/todo_open_sub/status",
    "/api/todos/todo_open_parent/status",
  ]);
});

it("groups the same tasks into columns on the board", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Board" }));

  const pending = (await screen.findByText("To do")).closest("section") as HTMLElement;
  expect(within(pending).getByText("Prepare the DevCon demo")).toBeInTheDocument();
  expect(within(pending).getByText("1/1 subtasks")).toBeInTheDocument();
  expect(within(screen.getByText("In progress").closest("section") as HTMLElement)
    .getByText("Rehearse the walkthrough")).toBeInTheDocument();
  expect(within(screen.getByText("Done").closest("section") as HTMLElement)
    .getByText("Book the flight")).toBeInTheDocument();
  expect(within(pending).getByText("! high")).toBeInTheDocument();
  expect(within(pending).getByText("Due Aug 1 · 12:00 PM")).toBeInTheDocument();

  const scheduled = within(pending).getByText("Review RFC for Alex").closest("article") as HTMLElement;
  expect(within(scheduled).getByText("Due Jul 29")).toBeInTheDocument();
  expect(within(scheduled).getByText("Jul 29 · 9:00 AM +1")).toBeInTheDocument();

  // Cards are still draggable, which is the only reason the board is kept.
  expect(within(scheduled).getByRole("button", { name: "Drag task" })).toBeInTheDocument();
});

/** A card has room for the checklist, so the steps read and tick in place. */
it("ticks a subtask off from the board card it belongs to", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Board" }));

  const card = (await screen.findByText("Prepare the DevCon demo")).closest("article") as HTMLElement;
  const check = within(card).getByRole("checkbox", { name: "Reopen subtask Write the outline" });
  expect(check).toBeChecked();

  const writes = todoWrites.length;
  await userEvent.click(check);
  await waitFor(() => expect(todoWrites.length).toBe(writes + 1));
  expect(todoWrites.at(-1)).toMatchObject({ method: "PATCH", body: { status: "pending" } });

  // The summary folds a long list away without hiding that it is there.
  await userEvent.click(within(card).getByText("1/1 subtasks"));
  expect(within(card).queryByText("Write the outline")).not.toBeInTheDocument();
});

it("manages a task's subtasks from the editor", async () => {
  renderAt("/todos");
  await userEvent.click(await screen.findByRole("button", { name: "Prepare the DevCon demo" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("1 of 1 done")).toBeInTheDocument();
  expect(within(dialog).getByText("Write the outline")).toBeInTheDocument();
  // Nesting is only ever drawn one level deep, so a parent cannot be filed away.
  expect(within(dialog).getByLabelText("Parent")).toBeDisabled();

  const writes = todoWrites.length;
  await userEvent.type(within(dialog).getByLabelText("New subtask"), "Rehearse the close{Enter}");
  await waitFor(() => expect(todoWrites.length).toBe(writes + 1));
  expect(todoWrites.at(-1)).toMatchObject({
    method: "POST",
    body: { title: "Rehearse the close", parent_id: "todo_1" },
  });
  // Enter adds the line rather than saving the task and closing the editor.
  expect(within(dialog).getByLabelText("New subtask")).toHaveValue("");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

/** A task being captured has no id yet, so its steps ride along on the create. */
it("captures a new task together with its subtasks", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /New task/ }));
  const dialog = await screen.findByRole("dialog");

  await userEvent.type(within(dialog).getByLabelText("Task"), "Ship the demo script");
  await userEvent.type(within(dialog).getByLabelText("New subtask"), "Draft it{Enter}");
  await userEvent.type(within(dialog).getByLabelText("New subtask"), "Read it aloud{Enter}");
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove subtask Draft it" }));
  await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(todoWrites.at(-1)).toMatchObject({
    method: "POST",
    body: { title: "Ship the demo script", subtasks: [{ title: "Read it aloud" }] },
  });
});

it("filters the board by life area and opens the task editor", async () => {
  renderAt("/todos");
  expect(await screen.findByText("The board.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Work" }));
  await waitFor(() => expect(requestedUrls.some(url => url.includes("life_area_id=area_work"))).toBe(true));

  await userEvent.click(screen.getByRole("button", { name: /New task/ }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

it("edits the reminder and its extras from the task editor", async () => {
  const timezone = "America/New_York";
  const inDays = (days: number) =>
    toZonedDateTimeLocal(new Date(Date.now() + days * 86_400_000).toISOString(), timezone);
  renderAt("/todos");
  await userEvent.click(await screen.findByRole("button", { name: "Review RFC for Alex" }));
  const dialog = await screen.findByRole("dialog");

  // The schedule the agent wrote is what the form opens with, in the timezone the
  // user reads everything else in.
  const primary = within(dialog).getByLabelText(/Remind me/);
  expect(primary).toHaveValue("2026-07-29T09:00");
  expect(within(dialog).getByLabelText("Extra reminder 1")).toHaveValue("2026-07-29T14:00");

  // A reminder in the past would fire the moment it was saved, so it is refused
  // before the write rather than after it.
  const writes = todoWrites.length;
  fireEvent.change(primary, { target: { value: "2020-01-01T09:00" } });
  await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
  expect(await within(dialog).findByText("A new reminder has to be in the future.")).toBeInTheDocument();
  expect(todoWrites.length).toBe(writes);

  fireEvent.change(primary, { target: { value: inDays(2) } });
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove extra reminder 1" }));
  await userEvent.click(within(dialog).getByRole("button", { name: /Add a reminder/ }));
  fireEvent.change(within(dialog).getByLabelText("Extra reminder 1"), { target: { value: inDays(3) } });
  await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(todoWrites.at(-1)).toMatchObject({
    method: "PATCH",
    body: {
      reminder_at: zonedDateTimeLocalToIso(inDays(2), timezone),
      extra_reminders: [zonedDateTimeLocalToIso(inDays(3), timezone)],
    },
  });
});

it("opens a task from the keyboard and traps focus in the editor", async () => {
  renderAt("/todos");
  const title = await screen.findByRole("button", { name: "Prepare the DevCon demo" });

  title.focus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  // Shift+Tab off the first control has to wrap to the last one rather than
  // escaping to the page behind the dialog.
  const controls = [...dialog.querySelectorAll<HTMLElement>("button,input,select,textarea")];
  controls[0].focus();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(controls.at(-1));

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(document.activeElement).toBe(title);
});

it("switches memory views and searches by meaning", async () => {
  renderAt("/memories");
  expect(await screen.findByText("Memory, made useful.")).toBeInTheDocument();
  expect(await screen.findByText("Talk framing")).toBeInTheDocument();
  expect(screen.getByText("Venue wifi")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Facts" }));
  expect(await screen.findByText("Venue wifi")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Talk framing")).not.toBeInTheDocument());

  await userEvent.click(screen.getByRole("button", { name: "Journals" }));
  expect(await screen.findByText("Good run-through", { exact: false })).toBeInTheDocument();
  expect(screen.getByText("July 18, 2026")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Everything" }));
  const search = await screen.findByPlaceholderText("Search by meaning, person, place, or phrase…");
  // Nothing is being ranked until there is a query, so no engine is claimed.
  expect(screen.queryByText("Ranked by Algolia")).not.toBeInTheDocument();
  await userEvent.type(search, "wifi");
  expect(await screen.findByText("Venue wifi")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Talk framing")).not.toBeInTheDocument());
  expect(await screen.findByText("Ranked by Algolia")).toBeInTheDocument();
  expect(requestedUrls.some(url => url.includes("/api/memories?") && url.includes("query=wifi"))).toBe(true);

  await userEvent.clear(search);
  await userEvent.type(search, "nothing here");
  expect(await screen.findByText("No memories match this view.")).toBeInTheDocument();
});

it("previews markdown while editing a memory", async () => {
  renderAt("/memories?open=memory_1");
  const editor = await screen.findByRole("dialog");
  expect(editor).toHaveTextContent("Edit memory");

  const content = editor.querySelector("textarea") as HTMLTextAreaElement;
  await userEvent.clear(content);
  await userEvent.type(content, "## Framing{Enter}Lead with **the contract**.");
  await userEvent.click(within(editor).getByRole("tab", { name: /Preview/ }));

  expect(within(editor).getByRole("heading", { name: "Framing" })).toBeInTheDocument();
  expect(within(editor).getByText("the contract").tagName).toBe("STRONG");

  await userEvent.click(within(editor).getByRole("tab", { name: /Write/ }));
  expect(editor.querySelector("textarea")).toHaveValue("## Framing\nLead with **the contract**.");
});

it("asks before deleting a memory", async () => {
  renderAt("/memories");
  expect(await screen.findByText("Talk framing")).toBeInTheDocument();
  const before = requestedUrls.length;

  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await userEvent.click(screen.getAllByRole("button", { name: "Delete memory" })[0]);
    expect(confirmSpy).toHaveBeenCalled();
    expect(requestedUrls.slice(before).some(url => url.includes("/api/memories/memory_1"))).toBe(false);

    confirmSpy.mockReturnValue(true);
    await userEvent.click(screen.getAllByRole("button", { name: "Delete memory" })[0]);
    await waitFor(() =>
      expect(requestedUrls.some(url => url.includes("/api/memories/memory_1"))).toBe(true));
  } finally {
    confirmSpy.mockRestore();
  }
});

describe("session expiry", () => {
  function stubLocation(pathname: string, search = "") {
    const original = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, pathname, search, assign },
    });
    return {
      assign,
      restore: () => Object.defineProperty(window, "location", { configurable: true, value: original }),
    };
  }

  it("sends an expired session back to login with the current path preserved", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    const location = stubLocation("/memories", "?kind=fact");
    try {
      await expect(api.memories({ kind: "all", query: "" })).rejects.toThrowError(/Authentication required/);
      expect(location.assign).toHaveBeenCalledWith("/login?next=%2Fmemories%3Fkind%3Dfact");
    } finally {
      location.restore();
    }
  });

  it("never redirects away from the login page itself", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    const location = stubLocation("/login");
    try {
      await expect(api.health()).rejects.toThrowError(/Authentication required/);
      expect(location.assign).not.toHaveBeenCalled();
    } finally {
      location.restore();
    }
  });
});

describe("ReminderWatcher", () => {
  beforeEach(() => { window.localStorage.clear(); });

  const due = {
    id: "reminder_1",
    todo_id: "todo_1",
    todo_title: "Prepare the DevCon demo",
    kind: "due",
    slot: "primary",
    scheduled_for: "2026-07-26T12:00:00.000Z",
    status: "pending",
  };

  it("surfaces a due reminder once and lets it be dismissed", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: [due] })));
    try {
      render(<ReminderWatcher />);
      expect(await screen.findByText("Prepare the DevCon demo")).toBeInTheDocument();
      expect(screen.getByText("Local reminder")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button"));
      await waitFor(() => expect(screen.queryByText("Local reminder")).not.toBeInTheDocument());
    } finally {
      vi.mocked(fetch).mockReset();
    }
  });

  /*
   * A due date leaves its reminder row pending forever, because a date is not a
   * notification and nothing marks one delivered. Dismissal therefore has to
   * outlive the tab, or every reload re-raises a toast already acknowledged.
   */
  it("keeps a dismissed reminder dismissed after a reload", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: [due] })));
    try {
      const first = render(<ReminderWatcher />);
      expect(await screen.findByText("Prepare the DevCon demo")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button"));
      await waitFor(() => expect(screen.queryByText("Local reminder")).not.toBeInTheDocument());
      expect(JSON.parse(window.localStorage.getItem("fieldnote:dismissed-reminders") || "[]"))
        .toEqual(["reminder_1"]);
      first.unmount();

      vi.mocked(fetch).mockClear();
      render(<ReminderWatcher />);
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
      expect(screen.queryByText("Local reminder")).not.toBeInTheDocument();
    } finally {
      vi.mocked(fetch).mockReset();
    }
  });

  it("forgets a dismissal once the reminder stops being due", async () => {
    window.localStorage.setItem("fieldnote:dismissed-reminders", JSON.stringify(["reminder_gone"]));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: [due] })));
    try {
      render(<ReminderWatcher />);
      // Pruning to what is still due stops the store growing by one entry for
      // every reminder the account has ever had.
      expect(await screen.findByText("Prepare the DevCon demo")).toBeInTheDocument();
      await waitFor(() => expect(
        JSON.parse(window.localStorage.getItem("fieldnote:dismissed-reminders") || "[]"),
      ).toEqual([]));
    } finally {
      vi.mocked(fetch).mockReset();
    }
  });

  it("stays quiet when nothing is due and when the poll fails", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: [] })));
    const quiet = render(<ReminderWatcher />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Local reminder")).not.toBeInTheDocument();
    quiet.unmount();

    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(<ReminderWatcher />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Local reminder")).not.toBeInTheDocument();
    vi.mocked(fetch).mockReset();
  });
});

it("aborts an agent tool call whose response never arrives", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(fetch).mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = expect(api.executeAgentTool("create_memory", { content: "My name is Natan" }))
      .rejects.toThrowError(/abort/i);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});
