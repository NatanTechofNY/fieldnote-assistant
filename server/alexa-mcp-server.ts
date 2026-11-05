import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import type { AlgoliaSync } from "./algolia.ts";
import { userTimezone } from "./db.ts";
import { HOUSEHOLD_ADDRESS } from "./group-thread.ts";
import { householdScope } from "./household.ts";
import { localIsoWithOffset, localParts, todayIs, zonedToInstant } from "./local-time.ts";
import { executeAgentTool, type ToolTurnContext } from "./tool-executor.ts";
import type { Db } from "./types.ts";

/*
 * The MCP server Alexa+ talks to. It is not Fieldnote's agent: Alexa's own
 * model decides what to call, so this exposes a handful of fast reads and
 * writes against the Household area and nothing else. Every call goes through
 * `executeAgentTool` with the Household as its scope, so it gets the group
 * fences (by-id reads, area-filtered lists, owner-only tools refused) and the
 * duplicate checks the agent gets, and its writes queue their Algolia
 * updates like any other.
 *
 * Alexa+ reads tool descriptions only when the add-on is deployed, so nothing
 * here can say what day it is. Times therefore come in as the owner's local
 * wall clock with no offset (`2026-11-06T16:00`) and are resolved here, in the
 * owner's timezone, rather than leaving a voice model to work out an offset.
 */

type SearchWriter = Pick<AlgoliaSync, "flushSoon">;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date such as 2026-11-06");
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/, "Use a local time such as 2026-11-06T16:00");
const entityId = z.string().min(1).max(100);

/** The time a due date with no time of day lands on. */
const DEFAULT_TIME = "09:00";

/** A local `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as an RFC 3339 instant with the owner's offset. */
export function localToIso(value: string, timezone: string, defaultTime = DEFAULT_TIME): string {
  const [date, time] = value.split("T");
  return localIsoWithOffset(zonedToInstant(date, time ?? defaultTime, timezone), timezone);
}

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function fail(error: unknown): CallToolResult {
  const message = error instanceof ZodError
    ? error.issues[0]?.message || "Invalid request"
    : error instanceof Error ? error.message : "Something went wrong";
  return { isError: true, content: [{ type: "text", text: message }] };
}

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
const OPEN_STATUSES = ["pending", "in_progress", "blocked"];
const TODO_KEYS = ["id", "title", "status", "priority", "due_at", "reminder_at", "parent_id"];

export function buildHouseholdServer(db: Db, search: SearchWriter): McpServer {
  const timezone = userTimezone(db);
  const today = localParts(new Date(), timezone).date;
  const server = new McpServer(
    { name: "fieldnote-household", version: "1.0.0" },
    {
      instructions: `Fieldnote keeps the household's tasks, reminders and agenda. ${todayIs(today, timezone)} `
        + "Dates and times are the household's local clock, with no offset. Look a task up with list_todos before creating one, "
        + "so the same thing is not added twice.",
    },
  );
  // Built per call: the scope is looked up (and created on first use) rather than trusted from a cache.
  const context = (): ToolTurnContext => {
    const scope = householdScope(db);
    return {
      channel: "web", address: HOUSEHOLD_ADDRESS, threadId: scope.threadId, scope,
      surface: "voice", speakerIsOwner: false, speakerName: "Alexa",
    };
  };
  const run = async (name: string, input: Record<string, unknown>): Promise<unknown> =>
    executeAgentTool(db, search, name, input, context());
  const guarded = (work: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
    try {
      return ok(await work());
    } catch (error) {
      return fail(error);
    }
  };

  server.registerTool("get_agenda", {
    description: "What is due or scheduled between two local dates, inclusive: tasks with a due time and the reminders set for them. "
      + "Use the same date twice for a single day.",
    inputSchema: { start_date: localDate, end_date: localDate },
    annotations: { readOnlyHint: true },
  }, args => guarded(async () => {
    const result = await run("get_agenda", { ...args, timezone }) as { todos: Array<Record<string, unknown>>; reminders: Array<Record<string, unknown>> };
    return {
      timezone,
      todos: result.todos.map(todo => pick(todo, TODO_KEYS)),
      reminders: result.reminders.map(reminder => pick(reminder as Record<string, unknown>, ["id", "todo_id", "todo_title", "scheduled_for", "kind", "status"])),
    };
  })());

  server.registerTool("list_todos", {
    description: "The household's open tasks, newest first. Pass include_done to see finished and cancelled ones as well.",
    inputSchema: { include_done: z.boolean().optional(), limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true },
  }, args => guarded(async () => {
    const limit = args.limit ?? 15;
    // The status is filtered by the executor before it applies the limit, so a long run of finished tasks cannot push an older open one out of the list.
    const rows = args.include_done
      ? await run("list_todos", { limit }) as Array<Record<string, unknown>>
      : (await Promise.all(OPEN_STATUSES.map(status => run("list_todos", { status, limit })) as Array<Promise<Array<Record<string, unknown>>>>))
        .flat()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    return { timezone, todos: rows.map(row => pick(row, TODO_KEYS)) };
  })());

  server.registerTool("get_todo", {
    description: "One task by its id (from list_todos or get_agenda): its notes, steps, reminders and recent notes added to it.",
    inputSchema: { id: entityId },
    annotations: { readOnlyHint: true },
  }, args => guarded(async () => {
    const result = await run("get_todo", { id: args.id }) as {
      todo: Record<string, unknown>; subtasks: Array<Record<string, unknown>>;
      reminders: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>>;
    };
    return {
      timezone,
      todo: { ...pick(result.todo, TODO_KEYS), notes: result.todo.notes ?? null },
      steps: result.subtasks.map(step => pick(step, ["id", "title", "status"])),
      reminders: result.reminders.map(reminder => pick(reminder as unknown as Record<string, unknown>, ["id", "scheduled_for", "kind", "status"])),
      notes: result.comments.map(comment => pick(comment, ["body", "author_name", "created_at"])),
    };
  })());

  server.registerTool("create_todo", {
    description: "Add a task to the household list. Check list_todos first: a task with the same title that is still open is refused. "
      + "`due` is optional: a local date, or a local date and time such as 2026-11-06T16:00 (a date alone means 9:00 in the morning).",
    inputSchema: {
      title: z.string().trim().min(1).max(300),
      notes: z.string().max(2000).optional(),
      due: localDateTime.optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    },
  }, args => guarded(async () => {
    const created = await run("create_todo", {
      title: args.title,
      notes: args.notes ?? null,
      priority: args.priority ?? null,
      due_at: args.due ? localToIso(args.due, timezone) : null,
    }) as Record<string, unknown>;
    return { timezone, todo: pick(created, TODO_KEYS) };
  })());

  server.registerTool("set_todo_status", {
    description: "Mark a task pending, in_progress, blocked, done or cancelled. Use the id from list_todos or get_agenda, and ask which one if more than one fits.",
    inputSchema: { id: entityId, status: z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]) },
  }, args => guarded(async () => {
    const updated = await run("set_todo_status", { id: args.id, status: args.status }) as Record<string, unknown>;
    return { todo: pick(updated, TODO_KEYS) };
  })());

  server.registerTool("add_todo_comment", {
    description: "Add a short note to an existing task, such as a detail someone mentioned. It does not change the task itself.",
    inputSchema: { id: entityId, body: z.string().trim().min(1).max(1000) },
  }, args => guarded(async () => {
    const comment = await run("add_todo_comment", { id: args.id, body: args.body }) as Record<string, unknown>;
    return { note: pick(comment, ["id", "body", "created_at"]) };
  })());

  server.registerTool("create_reminder", {
    description: "Remind the owner about an existing task at a local date and time such as 2026-11-06T16:00. Reminders are texted to the owner's phone. "
      + "By default it sets the task's main reminder, replacing the one it had; pass also: true to add one alongside the existing reminder. "
      + "A reminder needs a task, so create the task first if there is none.",
    inputSchema: { todo_id: entityId, remind_at: localDateTime, also: z.boolean().optional() },
  }, args => guarded(async () => {
    const reminder = await run("create_reminder", {
      todo_id: args.todo_id,
      reminder_at: localToIso(args.remind_at, timezone),
      slot: args.also ? "extra" : "primary",
    }) as Record<string, unknown> | undefined;
    return { timezone, reminder: reminder ? pick(reminder, ["id", "todo_id", "scheduled_for", "kind", "status"]) : null };
  })());

  server.registerTool("list_reminders", {
    description: "The reminders set between two local dates, inclusive, with the task each belongs to.",
    inputSchema: { from_date: localDate, to_date: localDate },
    annotations: { readOnlyHint: true },
  }, args => guarded(async () => {
    const reminders = await run("list_reminders", {
      from: localToIso(args.from_date, timezone, "00:00"),
      to: localToIso(args.to_date, timezone, "23:59"),
      limit: 50,
    }) as Array<Record<string, unknown>>;
    return { timezone, reminders: reminders.map(row => pick(row, ["id", "todo_id", "todo_title", "scheduled_for", "kind", "status"])) };
  })());

  return server;
}
