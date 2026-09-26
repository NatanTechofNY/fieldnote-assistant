import type { AlgoliaSync } from "./algolia.ts";
import {
  getConfluencePage, getJiraIssue, listConfluenceComments, listConfluencePages,
  listConfluenceSpaces, listJiraBoards, listJiraIssues, listJiraUsers,
} from "./atlassian-service.ts";
import { productCaption, productJson, searchStoreProductsLocally, STORE_NAME } from "./catalog.ts";
import {
  getMemory, getReminders, getStoreProduct, getTodo, GROUP_NAME_SQL, id, insertOutboundChannelMessage, instant, now,
  OWN_AREA_CLAUSE, queueIndexJob, recordMessageReaction, renameLifeArea, syncTodoReminders, USER_ID, userTimezone,
} from "./db.ts";
import {
  DERIVED_REMINDER, DERIVED_SCHEDULE, REPEATING_PARENT, REPEATING_SUBTASK,
  isDerivedReminder, parseRecurrence, planRecurrenceWrite, recurrenceJson, type RecurrenceRule,
} from "./recurrence.ts";
import { fiscalQuarterRange, type FiscalQuarter } from "./fiscal-quarter.ts";
import { refreshRosterMemory, rememberGroupMember } from "./group-members.ts";
import {
  addressesAssistant, ASSISTANT_NAME, groupIdOfAddress, OWNER_SPEAKER_NAME, speakerLabel, speakerNameOf,
} from "./group-thread.ts";
import type { SmsProvider } from "./integrations.ts";
import { localIsoWithOffset, zonedToInstant } from "./local-time.ts";
import { sendSms, type SmsSender } from "./messaging.ts";
import { type IncomingMood, parseMoods, resolveMoodFields } from "./moods.ts";
import { reflectionPeriod, reflectionScopeKey, type ReflectionPeriod, type ReflectionPreset } from "./reflection-period.ts";
import { toolInput, type ToolName } from "./schemas.ts";
import { sendSendblueReaction } from "./sendblue-service.ts";
import { completeParentIfSettled, completionStats, hasSubtasks, startParentIfPending, syncOccurrenceCompletion } from "./todo-status.ts";
import type { Db, MemoryRow, StoreProductRow, TodoRow, TodoStatus } from "./types.ts";

/**
 * Writes need only the flush; the catalog search also reads Algolia when it is
 * configured. Both are optional so a test double that supplies neither still
 * exercises every tool through the local fallbacks.
 */
type SearchWriter = Pick<AlgoliaSync, "flushSoon"> & Partial<Pick<AlgoliaSync, "client" | "searchProducts">>;
type Input = Record<string, unknown>;

const todoJson = (row: TodoRow) => ({
  id: row.id, title: row.title, notes: row.notes, category_id: row.category_id,
  category_name: row.category_name ?? null, life_area_id: row.life_area_id,
  life_area_name: row.life_area_name ?? null, life_area_slug: row.life_area_slug ?? null,
  life_area_source: row.life_area_source, parent_id: row.parent_id, due_at: row.due_at,
  reminder_at: row.reminder_at, extra_reminders: JSON.parse(row.extra_reminders_json),
  priority: row.priority, status: row.status, started_at: row.started_at,
  completed_at: row.completed_at,
  recurrence: (() => { const rule = parseRecurrence(row.recurrence_json); return rule ? recurrenceJson(rule) : null; })(),
  last_completed_at: row.last_completed_at ?? null,
  assistant_says: Boolean(row.assistant_says),
  created_at: row.created_at, updated_at: row.updated_at,
});

const memoryJson = (row: MemoryRow) => ({
  id: row.id, title: row.title, content: row.content, kind: row.kind,
  mood_label: row.mood_label, mood_score: row.mood_score, moods: parseMoods(row.moods_json), category_id: row.category_id,
  category_name: row.category_name ?? null, life_area_id: row.life_area_id,
  life_area_name: row.life_area_name ?? null, life_area_slug: row.life_area_slug ?? null,
  life_area_source: row.life_area_source, occurred_at: row.occurred_at,
  review_worthy: Boolean(row.review_worthy), tags: JSON.parse(row.tags_json),
  created_at: row.created_at, updated_at: row.updated_at,
});

export function getReviewEvidence(
  db: Db,
  year: number,
  quarter: FiscalQuarter,
  timezone: string,
) {
  const range = fiscalQuarterRange(year, quarter, timezone);
  const memoryCandidates = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=?
      AND COALESCE(m.occurred_at,m.created_at)>=? AND COALESCE(m.occurred_at,m.created_at)<?
    ORDER BY COALESCE(m.occurred_at,m.created_at) DESC
  `).all(USER_ID, range.start, range.endExclusive) as MemoryRow[])
    .filter((memory) => !(JSON.parse(memory.tags_json) as string[]).includes("performance-review"));
  const todoCandidates = db.prepare(`
    SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM todos t LEFT JOIN categories c ON c.id=t.category_id
    LEFT JOIN life_areas la ON la.id=t.life_area_id
    WHERE t.user_id=? AND t.status='done'
      AND t.completed_at>=? AND t.completed_at<?
    ORDER BY t.completed_at DESC
  `).all(USER_ID, range.start, range.endExclusive) as TodoRow[];
  const memories = memoryCandidates.filter(memory => memory.life_area_id === "area_work");
  const todos = todoCandidates.filter(todo => todo.life_area_id === "area_work");
  const drafts = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=? AND m.life_area_id='area_work' ORDER BY m.updated_at DESC
  `).all(USER_ID) as MemoryRow[]).filter((memory) => {
    const tags = JSON.parse(memory.tags_json) as string[];
    return tags.includes("performance-review") && tags.includes(range.key);
  });
  return {
    range,
    memories: memories.map(memoryJson),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.map(memoryJson),
    todo_candidates: todoCandidates.map(todoJson),
    draft: drafts[0] ? memoryJson(drafts[0]) : null,
  };
}

export function getReflectionEvidence(
  db: Db,
  period: ReflectionPeriod,
  filters: {
    lifeAreaIds?: string[];
    categoryIds?: string[];
    sources?: Array<"memories" | "todos">;
    /** Leave out every group chat's records, whatever areas are asked for. */
    ownAreasOnly?: boolean;
  } = {},
) {
  const lifeAreaIds = [...new Set(filters.lifeAreaIds || [])];
  const categoryIds = [...new Set(filters.categoryIds || [])];
  const sources = [...new Set(filters.sources?.length ? filters.sources : ["memories", "todos"])] as Array<"memories" | "todos">;
  const own = (alias: string) => filters.ownAreasOnly ? `AND ${OWN_AREA_CLAUSE(alias)}` : "";
  const memoryCandidates = sources.includes("memories")
    ? (db.prepare(`
      SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM memories m LEFT JOIN categories c ON c.id=m.category_id
      LEFT JOIN life_areas la ON la.id=m.life_area_id
      WHERE m.user_id=? AND COALESCE(m.occurred_at,m.created_at)>=? AND COALESCE(m.occurred_at,m.created_at)<? ${own("m")}
      ORDER BY COALESCE(m.occurred_at,m.created_at) DESC
    `).all(USER_ID, period.start, period.endExclusive) as MemoryRow[]).filter(memory => {
      const tags = JSON.parse(memory.tags_json) as string[];
      return !tags.includes("performance-review") && !tags.includes("reflection-draft");
    })
    : [];
  const todoCandidates = sources.includes("todos")
    ? db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? AND t.status='done' AND t.completed_at>=? AND t.completed_at<? ${own("t")}
      ORDER BY t.completed_at DESC
    `).all(USER_ID, period.start, period.endExclusive) as TodoRow[]
    : [];
  const scopeKey = reflectionScopeKey(period, { lifeAreaIds, categoryIds, sources });
  const selections = db.prepare(`
    SELECT entity_type,entity_id FROM reflection_selections
    WHERE user_id=? AND scope_key=?
  `).all(USER_ID, scopeKey) as Array<{ entity_type: "memory" | "todo"; entity_id: string }>;
  const selected = new Set(selections.map(item => `${item.entity_type}:${item.entity_id}`));
  const inScope = (row: MemoryRow | TodoRow) =>
    (!lifeAreaIds.length || Boolean(row.life_area_id && lifeAreaIds.includes(row.life_area_id)))
    && (!categoryIds.length || Boolean(row.category_id && categoryIds.includes(row.category_id)));
  const memories = memoryCandidates.filter(memory => inScope(memory) && selected.has(`memory:${memory.id}`));
  const todos = todoCandidates.filter(todo => inScope(todo) && selected.has(`todo:${todo.id}`));
  const draft = (db.prepare(`
    SELECT m.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
    FROM memories m LEFT JOIN categories c ON c.id=m.category_id
    LEFT JOIN life_areas la ON la.id=m.life_area_id
    WHERE m.user_id=? ORDER BY m.updated_at DESC
  `).all(USER_ID) as MemoryRow[]).find(memory => {
    const tags = JSON.parse(memory.tags_json) as string[];
    return tags.includes("reflection-draft") && tags.includes(scopeKey);
  });
  return {
    range: period,
    scope_key: scopeKey,
    scope: {
      life_area_ids: lifeAreaIds,
      category_ids: categoryIds,
      sources,
    },
    memories: memories.map(memoryJson),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.filter(inScope).map(memoryJson),
    todo_candidates: todoCandidates.filter(inScope).map(todoJson),
    selected: selections.map(item => ({ type: item.entity_type, id: item.entity_id })),
    draft: draft ? memoryJson(draft) : null,
  };
}

/**
 * How many candidate rows the agent payload carries per source. A day or a week
 * fits well inside this; a month of journaling would otherwise crowd out the
 * turn, so `candidate_totals` reports the true count and a truncated list can
 * still be described honestly.
 */
const AGENT_CANDIDATE_LIMIT = 25;

/**
 * Evidence as the agent sees it. `memories` and `todos` stay the curated set a
 * saved draft may quote, but the candidate lists have to survive into the
 * payload: they are the difference between "nothing was selected" and "nothing
 * happened", and an end-of-day check-in that cannot tell those apart reports an
 * empty day to someone who just closed something out.
 */
function agentEvidence<T extends {
  memory_candidates: unknown[];
  todo_candidates: unknown[];
}>(evidence: T) {
  const { memory_candidates: memories, todo_candidates: todos, ...rest } = evidence;
  return {
    ...rest,
    memory_candidates: memories.slice(0, AGENT_CANDIDATE_LIMIT),
    todo_candidates: todos.slice(0, AGENT_CANDIDATE_LIMIT),
    candidate_totals: { memories: memories.length, todos: todos.length },
  };
}

/**
 * The fence around a group chat turn. Everything the group creates is filed
 * under its own life area, and from inside the group nothing else of the
 * owner's exists: the by-id reads, the lists, and the conversation lookup all
 * stop at this area and this thread. The owner sees the group's records from
 * the app and their own 1:1 thread; the fence is one-directional.
 */
export type GroupScope = {
  lifeAreaId: string;
  threadId: string;
  /** The assistant has not yet answered in this group since the area was created, so it still owes it a name. */
  lifeAreaIsNew?: boolean;
};

/**
 * What a tool needs to know about the turn it is running inside. Every other
 * tool reads and writes the user's own records and needs none of this; the two
 * iMessage tools act on the conversation itself, which has no representation in
 * SQLite that a model-supplied argument could name.
 */
export type ToolTurnContext = {
  channel: "sms" | "web";
  address: string;
  threadId: string;
  provider?: SmsProvider;
  /**
   * The iMessage group the turn is answering in, when it is one. A text sent
   * mid-turn goes to the group, and a todo created here keeps the thread so its
   * reminders come back to the same chat.
   */
  groupId?: string;
  /** Set on a group turn; the single field that says "this turn belongs to a group". */
  scope?: GroupScope;
  /**
   * The message being answered came from the recipient's own number. Decided by
   * the worker, not by the agent from a label, so the tools that only the owner
   * may drive in a group have something to check.
   */
  speakerIsOwner?: boolean;
  /**
   * Who wrote the message being answered, as the app names them: a trusted
   * contact's name in a group, the owner on their own line. A mood saved
   * without a name is this person's.
   */
  speakerName?: string;
  /**
   * The speaker's number in a group. It never reaches the model; it is what
   * `remember_group_member` resolves "speaker" to, so a person can only ever
   * name themselves.
   */
  speakerPhone?: string;
  /** The message being answered, and so the only one a tapback may land on. */
  inboundMessageHandle?: string;
  /** Set by `reply_in_thread`, read by the caller once the turn ends. */
  replyToMessageHandle?: string;
  /**
   * Set by `stay_quiet`: the agent judged the message was the people in the
   * group talking to each other, so a turn that ends without text is silence
   * on purpose rather than a model that forgot to answer.
   */
  stayedQuiet?: boolean;
  /** Set by the runner once a write to a record has landed this turn: something now needs saying. */
  changedRecord?: boolean;
  /** The text being answered, for the one judgment the server makes itself: a message that names the assistant is for it. */
  inboundText?: string;
  /**
   * Set once a tapback has landed on the inbound message. A turn that reacted
   * and then had nothing to add has answered, so the caller sends no text
   * rather than a filler sentence.
   */
  reacted?: boolean;
  /**
   * Set once `send_message` has texted mid-turn. Like a tapback, a turn that
   * said everything through it has answered and owes no closing bubble.
   */
  sentText?: boolean;
  /** How a tool that texts mid-turn sends; the active provider unless a test supplies one. */
  sendSms?: SmsSender;
  /**
   * The kind of app-composed turn this is (`group_morning`, `evening_checkin`,
   * …), when it is one. The check-ins are told they use no tools; this is
   * what makes it so whatever the text — or a record quoted in it — says.
   */
  appTurn?: string;
};

/**
 * App-composed turns that only write a message, never a record: the check-ins
 * and the wording draft. Their instruction quotes records people saved — in a
 * group, anyone in it — so "no tools" cannot be left to the prompt. Digests
 * and reflection drafts are app-composed too, but are meant to read.
 */
/** How many rows a speaker-filtered `read_conversation` looks through per call before handing back a cursor. */
const SPEAKER_SCAN_LIMIT = 5000;

const NO_TOOL_APP_TURNS = new Set(["group_morning", "group_evening", "evening_checkin", "checkin_ask_draft", "assistant_say"]);

/**
 * App-composed turns that report on the owner's own day. A group's work is its
 * own check-ins' to report, so these read only what is not filed under a group
 * chat — the reverse of a group turn's fence. The owner asking on their own
 * line is not fenced: "did we clean the kitchen?" is theirs to ask.
 */
const OWN_RECORDS_APP_TURNS = new Set(["daily_digest", "digest_brief"]);

export function ownRecordsOnly(context: ToolTurnContext | undefined): boolean {
  return !context?.scope && Boolean(context?.appTurn && OWN_RECORDS_APP_TURNS.has(context.appTurn));
}

/**
 * Tools that read the owner's working life or their Atlassian account. None of
 * it belongs in a group chat, so in a group they are refused before touching the
 * database or the network rather than filtered.
 */
const OWNER_ONLY_TOOLS = new Set([
  "get_review_evidence", "get_reflection_evidence",
  "list_jira_boards", "list_jira_issues", "get_jira_issue", "list_jira_users",
  "list_confluence_spaces", "list_confluence_pages", "get_confluence_page", "list_confluence_comments",
]);

/**
 * Whether the turn's speaker may record only their own mood on a shared entry:
 * anyone in a group who is not the owner. The owner, in a group or on their own
 * line, may name whose mood they are recording — "Sarah said she's a 2".
 */
function ownMoodOnly(context: ToolTurnContext | undefined): boolean {
  return Boolean(context?.scope) && context?.speakerIsOwner !== true;
}

/**
 * "Laundry is in progress" was answered with set_todo_status on an id that
 * appeared in no search, no result, and no message, and the refusal read as the
 * end of the road. It is the same text in and out of a group, so it says nothing
 * about records the turn cannot see.
 */
const TODO_NOT_FOUND = "Todo not found. Never guess or reuse a todo id: search the todo index for the task by its words, then retry with the objectID of the hit";

/**
 * A todo as the turn may see it. Outside a group this is `getTodo`; inside one,
 * a todo from any other life area is indistinguishable from one that does not
 * exist, so the caller's own "not found" fires and nothing about the owner's
 * other records leaks through the error.
 */
function scopedTodo(db: Db, todoId: string, scope: GroupScope | undefined): TodoRow | undefined {
  const row = getTodo(db, todoId);
  if (row && scope && row.life_area_id !== scope.lifeAreaId) return undefined;
  return row;
}

function scopedMemory(db: Db, memoryId: string, scope: GroupScope | undefined): MemoryRow | undefined {
  const row = getMemory(db, memoryId);
  if (row && scope && row.life_area_id !== scope.lifeAreaId) return undefined;
  return row;
}

/**
 * How a new record is classified: in a group, the group's own area and no
 * category; elsewhere, what the agent chose. Categories are the owner's taxonomy
 * and a group turn has no way to list them, so accepting one would only make
 * the tool an oracle for their names.
 */
/** Title comparison for the duplicate guard: case, surrounding space, and runs of space do not make a different task. */
function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The open todo `create_todo` would duplicate, if there is one.
 *
 * The prompt's duplicate preflight is an Algolia search, and a search is not
 * the record. Thirty seconds after ten todos were written, a preflight for the
 * same titles came back with two of them, and the eight it missed were created
 * again. SQLite is the source of truth, so the same question is asked of it
 * here, narrowly: the same title, in the same life area, under the same parent,
 * and still open. Two trips can each have a "Book tickets" step, a done task
 * can be created afresh, and a different area is a different list; anything
 * closer than that is the same task, and the model is told which record it is
 * so it can update it instead. A repeating todo is open for as long as it
 * repeats: done for today, it is back tomorrow, and a twin made in between
 * would leave two of it on the list.
 */
function openTodoTitled(
  db: Db, title: string, lifeAreaId: string | null, parentId: string | null,
): { id: string; title: string } | null {
  // SQL narrows to titles that agree once case and every space are dropped;
  // the exact comparison, with runs of space collapsed rather than removed,
  // is made in JS on those few rows.
  const rows = db.prepare(`
    SELECT id,title FROM todos
    WHERE user_id=? AND life_area_id IS ? AND parent_id IS ?
      AND status<>'cancelled' AND (status<>'done' OR recurrence_json IS NOT NULL)
      AND replace(lower(title),' ','')=replace(lower(?),' ','')
    ORDER BY created_at
  `).all(USER_ID, lifeAreaId, parentId, title) as Array<{ id: string; title: string }>;
  const wanted = normalizedTitle(title);
  return rows.find(row => normalizedTitle(row.title) === wanted) ?? null;
}

function classificationForWrite(
  scope: GroupScope | undefined,
  chosen: { life_area_id?: unknown; category_id?: unknown },
): { life_area_id: string | null; life_area_source: "agent" | null; category_id: string | null } {
  const lifeAreaId = scope?.lifeAreaId ?? (typeof chosen.life_area_id === "string" && chosen.life_area_id ? chosen.life_area_id : null);
  const categoryId = !scope && typeof chosen.category_id === "string" && chosen.category_id ? chosen.category_id : null;
  return { life_area_id: lifeAreaId, life_area_source: lifeAreaId ? "agent" : null, category_id: categoryId };
}

/**
 * A turn that can text: an SMS conversation, group or 1:1. The browser has no
 * bubbles to send, so on web the tool tells the agent to put it in the reply.
 */
function textingTurn(context: ToolTurnContext | undefined): ToolTurnContext {
  if (!context || context.channel !== "sms") {
    throw new Error("This is not a text conversation; put the message in the reply instead");
  }
  return context;
}

/**
 * Catalog search goes to Algolia when it is configured and falls back to the
 * local ranking otherwise, or when Algolia fails. A shopping question on stage
 * should get an answer either way, and the result names which store answered.
 */
async function searchStoreProducts(
  db: Db,
  search: SearchWriter,
  options: { query: string; category: string | null; maxPriceCents: number | null; limit: number },
): Promise<{ source: "algolia" | "local"; rows: StoreProductRow[] }> {
  if (search.client && search.searchProducts) {
    try {
      const ids = await search.searchProducts(options.query, {
        category: options.category,
        maxPriceCents: options.maxPriceCents,
        limit: options.limit,
      });
      const rows = ids.map(productId => getStoreProduct(db, productId))
        .filter((row): row is StoreProductRow => Boolean(row));
      return { source: "algolia", rows };
    } catch (error) {
      console.warn("Product search fell back to SQLite:", error instanceof Error ? error.message : error);
    }
  }
  return { source: "local", rows: searchStoreProductsLocally(db, options) };
}

/**
 * A turn that has a message to act on, or the reason it does not. The browser
 * chat and Twilio both reach here, and so does an SMS turn the app composed
 * itself, none of which is answering an iMessage.
 */
function imessageTurn(
  context: ToolTurnContext | undefined,
): ToolTurnContext & { inboundMessageHandle: string } {
  if (!context || context.channel !== "sms" || context.provider !== "sendblue") {
    throw new Error("This turn has no iMessage to act on: the conversation is not on iMessage");
  }
  if (!context.inboundMessageHandle) {
    throw new Error("This turn has no iMessage to act on: the user did not send the message that started it");
  }
  return context as ToolTurnContext & { inboundMessageHandle: string };
}

export async function executeAgentTool(
  db: Db,
  search: SearchWriter,
  name: string,
  input: Input,
  context?: ToolTurnContext,
): Promise<unknown> {
  // Tool arguments come from a model, so they get the same Zod validation as
  // the REST API instead of ad-hoc presence checks. A ZodError here surfaces
  // as a 400 through the shared error handler.
  const schema = toolInput[name as ToolName];
  if (schema) input = schema.parse(input) as Input;
  if (context?.appTurn && NO_TOOL_APP_TURNS.has(context.appTurn)) {
    throw new Error(
      `This turn is the app asking you to write the ${context.appTurn.replace(/_/g, " ")}; it uses no tools`
      + (name === "stay_quiet" ? " — there is no message to stay quiet on" : ", so write the text instead"),
    );
  }
  const scope = context?.scope;
  if (scope && OWNER_ONLY_TOOLS.has(name)) throw new Error(`${name} is not available in a group chat`);
  const ownOnly = ownRecordsOnly(context);

  if (name === "send_message") {
    // One bubble now, ahead of the turn's own reply: an emoji, an "on it", a
    // line that deserves to stand alone. Filed like a product card, so the
    // archive and the index carry it as a message the assistant sent.
    const turn = textingTurn(context);
    const text = input.text as string;
    const send = turn.sendSms ?? sendSms;
    const delivered = await send(db, turn.address, text, turn.groupId ? { groupId: turn.groupId } : undefined);
    insertOutboundChannelMessage(db, turn.threadId, text, delivered.sid, delivered.status, { kind: "message" });
    turn.sentText = true;
    search.flushSoon();
    return { sent: true, message_handle: delivered.sid, status: delivered.status };
  }
  if (name === "name_group_chat") {
    if (!context?.groupId || !scope) throw new Error("This conversation is not a group chat");
    const groupName = input.name as string;
    // Asking for the name the group already has changes nothing, so nobody
    // needs permission for it. Refusing it read as a failed rename to a model
    // that had only restated the current name on a non-owner's message.
    const current = db.prepare("SELECT name FROM life_areas WHERE id=? AND user_id=?")
      .get(scope.lifeAreaId, USER_ID) as { name: string } | undefined;
    if (current && current.name.trim() === groupName.trim()) {
      return { life_area_id: scope.lifeAreaId, name: current.name, unchanged: true };
    }
    // The first name is the assistant's to give; after that the area is the
    // owner's record, and a rename asked for by anyone else is refused here
    // rather than left to the prompt.
    if (!scope.lifeAreaIsNew && !context.speakerIsOwner) {
      throw new Error("Only the owner can rename the group chat");
    }
    renameLifeArea(db, scope.lifeAreaId, groupName);
    refreshRosterMemory(db, scope.lifeAreaId);
    search.flushSoon();
    return { life_area_id: scope.lifeAreaId, name: groupName };
  }
  if (name === "remember_group_member") {
    if (!context?.groupId || !scope) throw new Error("This conversation is not a group chat");
    const result = rememberGroupMember(db, {
      threadId: scope.threadId,
      lifeAreaId: scope.lifeAreaId,
      speakerIsOwner: context.speakerIsOwner === true,
      speakerPhone: context.speakerPhone,
    }, {
      who: input.who as string,
      name: input.name as string,
      relationship: (input.relationship as string | null | undefined) ?? null,
    });
    search.flushSoon();
    return result;
  }

  if (name === "react_to_message") {
    const turn = imessageTurn(context);
    const reaction = input.reaction as string;
    await sendSendblueReaction(db, turn.inboundMessageHandle, reaction);
    // Filed only once Sendblue has taken it, so the archive never shows a
    // tapback on a message that never got one.
    recordMessageReaction(db, turn.threadId, turn.inboundMessageHandle, reaction);
    // Taking a reaction back is not an acknowledgement, so it does not earn the
    // turn the right to say nothing.
    if (!reaction.startsWith("-")) turn.reacted = true;
    return { reacted: true, reaction };
  }
  if (name === "reply_in_thread") {
    // Nothing is sent here. The turn's own answer is what gets threaded, and it
    // has not been written yet, so this records the intent for whoever delivers
    // it once the loop finishes.
    const turn = imessageTurn(context);
    turn.replyToMessageHandle = turn.inboundMessageHandle;
    return { threaded: true };
  }
  if (name === "stay_quiet") {
    // People talk to each other in a group, and not every message is for the
    // assistant. The reason lands in the archive as this tool's row; the turn
    // itself sends nothing. A 1:1 text is always for the assistant.
    if (!context?.groupId || !scope) throw new Error("This conversation is not a group chat; a text sent to you is for you");
    // A scheduled check-in is the assistant speaking to the room, not a
    // message to judge; there is no inbound to stay quiet on.
    if (!context.inboundMessageHandle) throw new Error("This turn is the app asking you to write to the group; there is no message to stay quiet on");
    // Until the assistant has answered once in a group, the owner has just
    // brought it in and the room is owed an introduction and a name for its
    // area; a quiet first turn would consume both cues for good.
    if (scope.lifeAreaIsNew) {
      throw new Error("Nobody here has heard from you yet; introduce yourself in a line and name the group instead of staying quiet");
    }
    // A record changed in this turn is a side effect the room has not been
    // told about; silence after it would be an unconfirmed write.
    if (context.changedRecord) throw new Error("You changed a record this turn; say what changed instead of staying quiet");
    // The one judgment the server makes for itself. Everything else about
    // whether a message is for the assistant is the model's call, but a
    // message that says its name is not a close call, and no one in the chat
    // should be able to talk it into ignoring one.
    if (context.inboundText && addressesAssistant(context.inboundText)) {
      throw new Error(`This message names ${ASSISTANT_NAME}; it is for you, whoever wrote it`);
    }
    context.stayedQuiet = true;
    // Who was passed over is kept beside why, so a suppressed request from the
    // owner can be found in the archive.
    return { quiet: true, reason: input.reason as string, speaker_is_owner: context.speakerIsOwner === true };
  }

  /*
   * The shopping tools read a demo catalog rather than the user's records. They
   * never buy anything: the search returns store links, and the cards tool
   * texts those links with a picture so the user can tap through themselves.
   */
  if (name === "search_store_products") {
    const maxPrice = input.max_price as number | null | undefined;
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);
    const result = await searchStoreProducts(db, search, {
      query: input.query as string,
      category: (input.category as string | null | undefined) ?? null,
      maxPriceCents: maxPrice == null ? null : Math.round(maxPrice * 100),
      limit,
    });
    return {
      store: STORE_NAME,
      source: result.source,
      products: result.rows.map(productJson),
    };
  }
  if (name === "send_product_cards") {
    const productIds = input.product_ids as string[];
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
    const found: StoreProductRow[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const productId of new Set(productIds)) {
      const row = getStoreProduct(db, productId);
      if (row) found.push(row);
      else failed.push({ id: productId, error: "Product not found" });
    }
    const cards = found.map(row => ({ ...productJson(row), caption: productCaption(row) }));
    // The browser has no Messages thread to drop a picture into, so the cards
    // come back for the agent to describe instead of being sent nowhere.
    if (!context || context.channel !== "sms") {
      return { store: STORE_NAME, channel: "web", sent: 0, cards, failed };
    }
    const send = context.sendSms ?? sendSms;
    const group = context.groupId ? { groupId: context.groupId } : undefined;
    const sent: Array<Record<string, unknown>> = [];
    if (note && found.length) {
      const delivered = await send(db, context.address, note, group);
      insertOutboundChannelMessage(db, context.threadId, note, delivered.sid, delivered.status, {
        kind: "product_note",
      });
    }
    // One message per product, in the order the agent ranked them. Sequential
    // rather than parallel so the cards land in that order too.
    for (const row of found) {
      const caption = productCaption(row);
      try {
        const delivered = await send(db, context.address, caption, { mediaUrl: row.image_url, ...group });
        insertOutboundChannelMessage(db, context.threadId, caption, delivered.sid, delivered.status, {
          kind: "product_card",
          productCard: productJson(row),
          mediaUrl: row.image_url,
        });
        sent.push({ id: row.id, name: row.name, message_handle: delivered.sid, status: delivered.status });
      } catch (error) {
        failed.push({ id: row.id, error: error instanceof Error ? error.message : "Send failed" });
      }
    }
    return { store: STORE_NAME, channel: "sms", sent: sent.length, cards: sent, failed };
  }

  if (name === "get_todo") {
    const todo = scopedTodo(db, input.id as string, scope);
    if (!todo) throw new Error(TODO_NOT_FOUND);
    const stats = completionStats(db, todo);
    return {
      todo: todoJson(todo),
      // The owner may file a subtask of a group todo elsewhere from the app;
      // from inside the group that subtask does not exist.
      subtasks: (db.prepare(`
        SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
        FROM todos t LEFT JOIN categories c ON c.id=t.category_id
        LEFT JOIN life_areas la ON la.id=t.life_area_id
        WHERE t.user_id=? AND t.parent_id=? ${scope ? "AND t.life_area_id=?" : ""} ORDER BY t.created_at
      `).all(...(scope ? [USER_ID, todo.id, scope.lifeAreaId] : [USER_ID, todo.id])) as TodoRow[]).map(todoJson),
      reminders: getReminders(db, todo.id),
      ...(stats ? {
        completions: stats.completions.map(row => ({ occurrence_at: row.occurrence_at, completed_at: row.completed_at })),
        completion_count: stats.completion_count,
        streak: stats.streak,
      } : {}),
    };
  }
  if (name === "list_life_areas") {
    // A group knows only its own area; the owner's three defaults are not
    // something it can file under or ask about.
    return db.prepare(`
      SELECT id,slug,name,color,CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END is_group
      FROM life_areas WHERE user_id=? ${scope ? "AND id=?" : ""} ORDER BY
        CASE slug WHEN 'work' THEN 0 WHEN 'personal' THEN 1 WHEN 'side-project' THEN 2 ELSE 3 END,name
    `).all(...(scope ? [USER_ID, scope.lifeAreaId] : [USER_ID]));
  }
  if (name === "get_conversation_context") {
    const threadId = input.thread_id as string;
    const thread = db.prepare(`
      SELECT t.id,t.channel,t.address,${GROUP_NAME_SQL} group_name FROM channel_threads t
      LEFT JOIN life_areas la ON la.thread_id=t.id
      WHERE t.id=? AND t.user_id=?
    `).get(threadId, USER_ID) as { id: string; channel: "web" | "sms"; address: string; group_name: string | null } | undefined;
    // From inside a group, the owner's other conversations do not exist; from
    // a turn about the owner's own day, the groups' do not.
    if (!thread || (scope && thread.id !== scope.threadId) || (ownOnly && groupIdOfAddress(thread.address))) {
      throw new Error("Conversation not found");
    }
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 40);
    const rows = db.prepare(`
      SELECT id,role,content,created_at,metadata_json FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant')
        AND json_extract(metadata_json,'$.reactionText') IS NULL
      ORDER BY created_at,rowid
    `).all(threadId) as Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      created_at: string;
      metadata_json: string;
    }>;
    const messageId = typeof input.message_id === "string" ? input.message_id : null;
    const anchorIndex = messageId ? rows.findIndex(row => row.id === messageId) : rows.length - 1;
    if (messageId && anchorIndex < 0) throw new Error("Conversation message not found");
    const center = Math.max(anchorIndex, 0);
    const start = Math.min(
      Math.max(0, center - Math.floor((limit - 1) / 2)),
      Math.max(0, rows.length - limit),
    );
    const messages = rows.slice(start, Math.min(rows.length, start + limit)).map(row => {
      const speaker = speakerNameOf(row.metadata_json);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        // Who said it, by name only: the phone number stays out of tool results.
        ...(row.role === "user" && speaker ? { speaker } : {}),
      };
    });
    return {
      thread_id: thread.id,
      channel: thread.channel,
      ...(thread.group_name ? { group_name: thread.group_name } : {}),
      messages,
    };
  }
  if (name === "read_conversation") {
    const threadId = typeof input.thread_id === "string" && input.thread_id ? input.thread_id : context?.threadId;
    if (!threadId) throw new Error("There is no conversation to read here; search the message index instead");
    if (scope && threadId !== scope.threadId) throw new Error("Conversation not found");
    const thread = db.prepare(`
      SELECT t.id,t.channel,t.address,${GROUP_NAME_SQL} group_name FROM channel_threads t
      LEFT JOIN life_areas la ON la.thread_id=t.id
      WHERE t.id=? AND t.user_id=?
    `).get(threadId, USER_ID) as { id: string; channel: "web" | "sms"; address: string; group_name: string | null } | undefined;
    // A turn that reports on the owner's own day does not read a group's chat.
    if (!thread || (ownOnly && groupIdOfAddress(thread.address))) throw new Error("Conversation not found");
    const timezone = userTimezone(db);
    const dateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    // A day the user named runs midnight to midnight on their own clock.
    const dayStart = (date: string) => zonedToInstant(date, "00:00", timezone).toISOString();
    const nextDay = (date: string) => {
      const [year, month, day] = date.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    };
    // A `next_from` cursor is the next row's instant and rowid, so a page
    // resumes exactly there even when several rows share a millisecond.
    const cursor = /^(.+)#(\d+)$/.exec(input.from as string);
    const fromValue = cursor ? cursor[1] : input.from as string;
    const afterRowid = cursor ? Number(cursor[2]) : 0;
    const toValue = (input.to as string | null | undefined) ?? null;
    // Without it the next page would quietly run on to now, past the range that was asked for.
    if (cursor && !toValue) throw new Error("Pass next_to as to when paging with next_from");
    const from = dateOnly(fromValue) ? dayStart(fromValue) : new Date(fromValue).toISOString();
    const to = toValue
      ? dateOnly(toValue) ? dayStart(nextDay(toValue)) : new Date(toValue).toISOString()
      // "Until now" includes the message being answered, saved a moment ago.
      : dateOnly(fromValue) ? dayStart(nextDay(fromValue)) : new Date(Date.now() + 1000).toISOString();
    if (to <= from) throw new Error("The end of the range has to come after its start");
    const wanted = typeof input.speaker === "string" ? input.speaker.trim().toLowerCase() : null;
    const limit = Number(input.limit) || 50;
    // Speakers are matched on their label, which is worked out per row, so a
    // filtered read scans further before it is cut; either way it is bounded.
    const rows = db.prepare(`
      SELECT role,content,created_at,metadata_json,rowid FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant') AND status<>'failed'
        AND (created_at>? OR (created_at=? AND rowid>=?)) AND created_at<?
        AND NOT (role='user' AND COALESCE(json_extract(metadata_json,'$.internal'),0)=1)
        AND json_extract(metadata_json,'$.copyOf') IS NULL
        AND json_extract(metadata_json,'$.reactionText') IS NULL
      ORDER BY created_at,rowid LIMIT ?
    `).all(thread.id, from, from, afterRowid, to, wanted ? SPEAKER_SCAN_LIMIT : limit + 1) as Array<{
      role: "user" | "assistant"; content: string; created_at: string; metadata_json: string; rowid: number;
    }>;
    // Who said it, by name or redacted number; the assistant's own lines are "you".
    const labelled = rows.map(row => ({
      ...row,
      speaker: row.role === "assistant" ? "you" : speakerLabel(row.metadata_json) ?? OWNER_SPEAKER_NAME,
    }));
    const matching = wanted
      ? labelled.filter(row => row.speaker.toLowerCase() === wanted
        || (row.role === "assistant" && ["assistant", ASSISTANT_NAME.toLowerCase()].includes(wanted)))
      : labelled;
    const MAX_CONTENT = 1000;
    return {
      thread_id: thread.id,
      ...(thread.group_name ? { group_name: thread.group_name } : {}),
      timezone,
      from: localIsoWithOffset(new Date(from), timezone),
      to: localIsoWithOffset(new Date(to), timezone),
      messages: matching.slice(0, limit).map(row => ({
        at: localIsoWithOffset(new Date(row.created_at), timezone),
        speaker: row.speaker,
        content: row.content.length > MAX_CONTENT ? `${row.content.slice(0, MAX_CONTENT)}…` : row.content,
      })),
      // The next page is the same range from the next message on: pass both back.
      ...(matching.length > limit
        ? { has_more: true, next_from: `${matching[limit].created_at}#${matching[limit].rowid}`, next_to: to }
        // A speaker read that stopped at its scan bound has not seen the rest of the range yet.
        : wanted && rows.length === SPEAKER_SCAN_LIMIT
          ? { has_more: true, next_from: `${rows.at(-1)!.created_at}#${rows.at(-1)!.rowid + 1}`, next_to: to }
          : { has_more: false }),
    };
  }
  if (name === "list_todos") {
    let rows = db.prepare(`
      SELECT t.*,c.name category_name,la.name life_area_name,la.slug life_area_slug
      FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN life_areas la ON la.id=t.life_area_id
      WHERE t.user_id=? ${ownOnly ? `AND ${OWN_AREA_CLAUSE("t")}` : ""} ORDER BY t.created_at DESC
    `).all(USER_ID) as TodoRow[];
    // A group lists its own area whatever the agent asked for.
    if (scope) input = { ...input, life_area_id: scope.lifeAreaId };
    for (const key of ["status", "priority", "category_id", "life_area_id", "parent_id"] as const) {
      if (input[key] != null) rows = rows.filter(row => row[key] === input[key]);
    }
    if (input.due_from) rows = rows.filter(row => Boolean(row.due_at && row.due_at >= String(input.due_from)));
    if (input.due_to) rows = rows.filter(row => Boolean(row.due_at && row.due_at <= String(input.due_to)));
    if (typeof input.recurring === "boolean") {
      rows = rows.filter(row => Boolean(row.recurrence_json) === input.recurring);
    }
    return rows.slice(0, Number(input.limit) || 50).map(todoJson);
  }
  if (name === "create_todo") {
    const timestamp = now();
    const todoId = id("todo");
    const repeat = planRecurrenceWrite(
      input.recurrence as RecurrenceRule | null | undefined, undefined, userTimezone(db),
    );
    const subtasks = Array.isArray(input.subtasks) ? input.subtasks : [];
    const extras = Array.isArray(input.extra_reminders) ? input.extra_reminders : [];
    if (repeat.recurrence_json) {
      if (input.parent_id) throw new Error(REPEATING_SUBTASK);
      if (subtasks.length) throw new Error(REPEATING_PARENT);
      if (input.due_at || input.reminder_at || extras.length) throw new Error(DERIVED_SCHEDULE);
    }
    if (input.parent_id) {
      const parent = scopedTodo(db, input.parent_id as string, scope);
      if (!parent) throw new Error("Parent todo not found");
      if (parent.recurrence_json) throw new Error(REPEATING_PARENT);
    }
    const area = classificationForWrite(scope, input);
    const existing = openTodoTitled(db, input.title as string, area.life_area_id, (input.parent_id as string | null | undefined) ?? null);
    if (existing) {
      throw new Error(
        `A todo titled "${existing.title}" already exists (${existing.id}); update it with update_todo instead of creating another`,
      );
    }
    const schedule = repeat.derived ?? {
      due_at: (input.due_at as string | null | undefined) ?? null,
      reminder_at: (input.reminder_at as string | null | undefined) ?? null,
      extra_reminders_json: JSON.stringify(input.extra_reminders ?? []),
    };
    db.transaction(() => {
      db.prepare(`
        INSERT INTO todos(
          id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
          priority,status,started_at,completed_at,recurrence_json,reply_thread_id,assistant_says,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        todoId, USER_ID, input.title as string, input.notes ?? null,
        area.category_id, area.life_area_id,
        area.life_area_source, input.parent_id ?? null, schedule.due_at,
        schedule.reminder_at, schedule.extra_reminders_json,
        input.priority ?? null, "pending", null, null, repeat.recurrence_json,
        // Only a group chat is remembered: a 1:1 or web todo reminds the
        // recipient's own number, which needs no thread to find.
        context?.groupId ? context.threadId : null,
        // A step is something someone does; only a top-level todo is said.
        input.assistant_says === true && !input.parent_id ? 1 : 0,
        timestamp, timestamp,
      );
      const created = getTodo(db, todoId);
      if (created) syncTodoReminders(db, created);
      for (const raw of subtasks) {
        const subtask = raw as Input;
        const childId = id("todo");
        db.prepare(`
          INSERT INTO todos(
            id,user_id,title,notes,category_id,life_area_id,life_area_source,parent_id,due_at,reminder_at,extra_reminders_json,
            priority,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,NULL,'[]',?,'pending',?,?)
        `).run(
          childId, USER_ID, subtask.title as string, subtask.notes ?? null,
          area.category_id, area.life_area_id,
          area.life_area_source, todoId, subtask.due_at ?? null,
          subtask.priority ?? null, timestamp, timestamp,
        );
        queueIndexJob(db, "todo", childId);
      }
      queueIndexJob(db, "todo", todoId);
    })();
    search.flushSoon();
    // The steps' ids are in no other result the next turn can see: without them
    // "wash is in progress" could only be written to the parent.
    const steps = db.prepare("SELECT id,title,status FROM todos WHERE user_id=? AND parent_id=? ORDER BY rowid")
      .all(USER_ID, todoId) as Array<{ id: string; title: string; status: string }>;
    return { ...todoJson(getTodo(db, todoId) as TodoRow), ...(steps.length ? { subtasks: steps } : {}) };
  }
  if (name === "update_todo") {
    const todoId = input.id as string;
    const current = scopedTodo(db, todoId, scope);
    if (!current) throw new Error(TODO_NOT_FOUND);
    const patch = (input.patch || {}) as Input;
    const clear = new Set(Array.isArray(patch.clear_fields) ? patch.clear_fields.map(String) : []);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "extra_reminders" ? [] : null) : patch[key] ?? currentValue;
    if (!scope && current.life_area_source === "user"
      && patch.life_area_id !== undefined
      && patch.life_area_id !== current.life_area_id
      && input.override_user_classification !== true) {
      throw new Error("Life area is user-classified; explicit override confirmation is required");
    }
    // In a group the area is the group's and stays so; nothing can be moved out.
    const lifeAreaId = scope ? scope.lifeAreaId : value("life_area_id", current.life_area_id);
    const lifeAreaSource = lifeAreaId === current.life_area_id
      ? current.life_area_source
      : lifeAreaId ? "agent" : null;
    // A null patch value means "unchanged" everywhere else in this tool, so
    // clearing the rule goes through clear_fields like any other nullable.
    const incomingRule = clear.has("recurrence")
      ? null
      : (patch.recurrence as RecurrenceRule | null | undefined) ?? undefined;
    const repeat = planRecurrenceWrite(incomingRule, current, userTimezone(db));
    const parentId = value("parent_id", current.parent_id) as string | null;
    if (repeat.recurrence_json) {
      if (parentId) throw new Error(REPEATING_SUBTASK);
      const extras = Array.isArray(patch.extra_reminders) ? patch.extra_reminders : [];
      if (patch.due_at || patch.reminder_at || extras.length) throw new Error(DERIVED_SCHEDULE);
      if (!current.recurrence_json && hasSubtasks(db, current.id)) throw new Error(REPEATING_PARENT);
    }
    if (parentId && parentId !== current.parent_id) {
      const parent = scopedTodo(db, parentId, scope);
      if (!parent) throw new Error("Parent todo not found");
      if (parent.recurrence_json) throw new Error(REPEATING_PARENT);
    }
    const schedule = repeat.derived ?? {
      due_at: value("due_at", current.due_at) as string | null,
      reminder_at: value("reminder_at", current.reminder_at) as string | null,
      extra_reminders_json: JSON.stringify(value("extra_reminders", JSON.parse(current.extra_reminders_json))),
    };
    // A rule change opens a new occurrence: the finished one is in the log
    // already, and a done status is not carried on to a day that has not come.
    const reopen = repeat.occurrenceMoved && (current.status === "done" || current.status === "in_progress");
    const assistantSays = parentId ? 0 : typeof patch.assistant_says === "boolean" ? Number(patch.assistant_says) : current.assistant_says;
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE todos SET title=?,notes=?,category_id=?,life_area_id=?,life_area_source=?,parent_id=?,due_at=?,reminder_at=?,
          extra_reminders_json=?,priority=?,recurrence_json=?,assistant_says=?,status=?,started_at=?,completed_at=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(
        value("title", current.title), value("notes", current.notes),
        scope ? current.category_id : value("category_id", current.category_id), lifeAreaId, lifeAreaSource,
        parentId, schedule.due_at, schedule.reminder_at, schedule.extra_reminders_json,
        value("priority", current.priority), repeat.recurrence_json, assistantSays,
        reopen ? "pending" : current.status,
        repeat.occurrenceMoved ? null : current.started_at,
        repeat.occurrenceMoved ? null : current.completed_at,
        now(), current.id, USER_ID,
      );
      const row = getTodo(db, todoId) as TodoRow;
      syncTodoReminders(db, row);
      syncOccurrenceCompletion(db, row);
      queueIndexJob(db, "todo", todoId);
      return getTodo(db, todoId) as TodoRow;
    })();
    search.flushSoon();
    return todoJson(updated);
  }
  if (name === "set_todo_status") {
    const todoId = input.id as string;
    const status = input.status as TodoStatus;
    const current = scopedTodo(db, todoId, scope);
    if (!current) throw new Error(TODO_NOT_FOUND);
    const timestamp = now();
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE todos SET status=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND user_id=?
      `).run(
        status,
        status === "in_progress" ? current.started_at ?? timestamp : current.started_at,
        status === "done" ? current.completed_at ?? timestamp : null,
        timestamp, todoId, USER_ID,
      );
      const row = getTodo(db, todoId) as TodoRow;
      syncTodoReminders(db, row);
      syncOccurrenceCompletion(db, row);
      completeParentIfSettled(db, row, scope?.lifeAreaId);
      startParentIfPending(db, row, scope?.lifeAreaId);
      queueIndexJob(db, "todo", todoId);
      // Re-read: logging an occurrence stamps last_completed_at on the row.
      return getTodo(db, todoId) as TodoRow;
    })();
    search.flushSoon();
    return todoJson(updated);
  }
  if (name === "delete_todo") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const todoId = input.id as string;
    if (!scopedTodo(db, todoId, scope)) throw new Error(TODO_NOT_FOUND);
    db.transaction(() => {
      db.prepare("DELETE FROM todos WHERE id=? AND user_id=?").run(todoId, USER_ID);
      queueIndexJob(db, "todo", todoId, "delete");
    })();
    search.flushSoon();
    return { id: todoId };
  }
  if (name === "get_memory") {
    const memory = scopedMemory(db, input.id as string, scope);
    if (!memory) throw new Error("Memory not found");
    return memoryJson(memory);
  }
  if (name === "create_memory") {
    const timestamp = now();
    const memoryId = id("memory");
    const area = classificationForWrite(scope, input);
    const mood = resolveMoodFields({
      existingJson: null,
      incoming: input.moods as IncomingMood[] | null | undefined,
      clear: false,
      plain: { mood_label: (input.mood_label as string | null | undefined) ?? null, mood_score: (input.mood_score as number | null | undefined) ?? null },
      speakerName: context?.speakerName,
      ownMoodOnly: ownMoodOnly(context),
    });
    db.prepare(`
      INSERT INTO memories(
        id,user_id,title,content,kind,mood_label,mood_score,moods_json,category_id,life_area_id,life_area_source,
        occurred_at,review_worthy,tags_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      memoryId, USER_ID, input.title ?? null, input.content as string, input.kind || "note",
      mood.mood_label, mood.mood_score, mood.moods_json, area.category_id,
      area.life_area_id, area.life_area_source,
      input.occurred_at ?? null, input.review_worthy === true ? 1 : 0,
      JSON.stringify(input.tags ?? []), timestamp, timestamp,
    );
    queueIndexJob(db, "memory", memoryId);
    search.flushSoon();
    return memoryJson(getMemory(db, memoryId) as MemoryRow);
  }
  if (name === "update_memory") {
    const memoryId = input.id as string;
    const current = scopedMemory(db, memoryId, scope);
    if (!current) throw new Error("Memory not found");
    const patch = (input.patch || {}) as Input;
    const clear = new Set(Array.isArray(patch.clear_fields) ? patch.clear_fields.map(String) : []);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "tags" ? [] : null) : patch[key] ?? currentValue;
    if (!scope && current.life_area_source === "user"
      && patch.life_area_id !== undefined
      && patch.life_area_id !== current.life_area_id
      && input.override_user_classification !== true) {
      throw new Error("Life area is user-classified; explicit override confirmation is required");
    }
    const lifeAreaId = scope ? scope.lifeAreaId : value("life_area_id", current.life_area_id);
    const lifeAreaSource = lifeAreaId === current.life_area_id
      ? current.life_area_source
      : lifeAreaId ? "agent" : null;
    const mood = resolveMoodFields({
      existingJson: current.moods_json,
      incoming: patch.moods as IncomingMood[] | null | undefined,
      clear: clear.has("moods"),
      plain: {
        mood_label: value("mood_label", current.mood_label) as string | null,
        mood_score: value("mood_score", current.mood_score) as number | null,
      },
      speakerName: context?.speakerName,
      ownMoodOnly: ownMoodOnly(context),
    });
    db.transaction(() => {
      db.prepare(`
        UPDATE memories SET kind=?,title=?,content=?,mood_label=?,mood_score=?,moods_json=?,category_id=?,
          life_area_id=?,life_area_source=?,occurred_at=?,review_worthy=?,tags_json=?,updated_at=?
        WHERE id=? AND user_id=?
      `).run(
        value("kind", current.kind), value("title", current.title), value("content", current.content),
        mood.mood_label, mood.mood_score, mood.moods_json,
        scope ? current.category_id : value("category_id", current.category_id), lifeAreaId, lifeAreaSource,
        value("occurred_at", current.occurred_at),
        value("review_worthy", Boolean(current.review_worthy)) ? 1 : 0,
        JSON.stringify(value("tags", JSON.parse(current.tags_json))), now(), memoryId, USER_ID,
      );
      queueIndexJob(db, "memory", memoryId);
    })();
    search.flushSoon();
    return memoryJson(getMemory(db, memoryId) as MemoryRow);
  }
  if (name === "delete_memory") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const memoryId = input.id as string;
    if (!scopedMemory(db, memoryId, scope)) throw new Error("Memory not found");
    db.transaction(() => {
      db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(memoryId, USER_ID);
      queueIndexJob(db, "memory", memoryId, "delete");
    })();
    search.flushSoon();
    return { id: memoryId };
  }
  if (name === "get_agenda") {
    const start = input.start_date as string;
    const end = input.end_date as string;
    const todos = (db.prepare(`
      SELECT t.*,c.name category_name FROM todos t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=? AND t.due_at IS NOT NULL ${scope ? "AND t.life_area_id=?" : ""}
        ${ownOnly ? `AND ${OWN_AREA_CLAUSE("t")}` : ""} ORDER BY t.due_at
    `).all(...(scope ? [USER_ID, scope.lifeAreaId] : [USER_ID])) as TodoRow[]).filter(todo => {
      const date = todo.due_at?.slice(0, 10) || "";
      return date >= start && date <= end;
    });
    const reminders = getReminders(db, undefined, { lifeAreaId: scope?.lifeAreaId, ownAreasOnly: ownOnly }).filter(reminder => {
      const date = reminder.scheduled_for.slice(0, 10);
      return date >= start && date <= end;
    });
    return { todos: todos.map(todoJson), reminders };
  }
  if (name === "get_review_evidence") {
    const year = input.year as number;
    const quarter = input.quarter as FiscalQuarter;
    const timezone = input.timezone as string;
    return agentEvidence(getReviewEvidence(db, year, quarter, timezone));
  }
  if (name === "get_reflection_evidence") {
    const preset = input.preset as ReflectionPreset;
    const timezone = input.timezone as string;
    const strings = (key: string) => Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : [];
    const period = reflectionPeriod(preset, timezone, {
      startDate: typeof input.start_date === "string" ? input.start_date : undefined,
      endDate: typeof input.end_date === "string" ? input.end_date : undefined,
    });
    return agentEvidence(getReflectionEvidence(db, period, {
      lifeAreaIds: strings("life_area_ids"),
      categoryIds: strings("category_ids"),
      sources: strings("sources") as Array<"memories" | "todos">,
      ownAreasOnly: ownOnly,
    }));
  }
  if (name === "create_reminder") {
    const todo = scopedTodo(db, input.todo_id as string, scope);
    if (!todo) throw new Error(TODO_NOT_FOUND);
    const reminderAt = input.reminder_at as string;
    const extras = JSON.parse(todo.extra_reminders_json) as string[];
    if (isDerivedReminder(todo, input.slot === "extra" ? "escalation" : "pre")) throw new Error(DERIVED_REMINDER);
    db.transaction(() => {
      if (input.slot === "extra") {
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set([...extras, reminderAt])]), now(), todo.id, USER_ID);
      } else {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return getReminders(db, todo.id).find(reminder => instant(reminder.scheduled_for) === instant(reminderAt));
  }
  if (name === "list_reminders") {
    const from = instant(input.from as string);
    const to = instant(input.to as string);
    return getReminders(db, undefined, { lifeAreaId: scope?.lifeAreaId })
      .filter(reminder => instant(reminder.scheduled_for) >= from && instant(reminder.scheduled_for) <= to)
      .slice(0, Number(input.limit) || 50);
  }
  if (name === "update_reminder") {
    const reminderId = input.id as string;
    const reminderAt = input.reminder_at as string;
    const reminder = getReminders(db, undefined, { lifeAreaId: scope?.lifeAreaId }).find(row => row.id === reminderId);
    if (!reminder) throw new Error("Reminder not found");
    const todo = scopedTodo(db, reminder.todo_id, scope);
    if (!todo) throw new Error("Reminder not found");
    if (isDerivedReminder(todo, reminder.kind)) throw new Error(DERIVED_REMINDER);
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=?,updated_at=? WHERE id=? AND user_id=?")
          .run(reminderAt, now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .map(value => instant(value) === instant(reminder.scheduled_for) ? reminderAt : value);
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify([...new Set(extras)]), now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return getReminders(db, todo.id).find(row => instant(row.scheduled_for) === instant(reminderAt));
  }
  if (name === "delete_reminder") {
    if (input.confirmed !== true) throw new Error("Explicit confirmation is required");
    const reminderId = input.id as string;
    const reminder = getReminders(db, undefined, { lifeAreaId: scope?.lifeAreaId }).find(row => row.id === reminderId);
    if (!reminder) throw new Error("Reminder not found");
    const todo = scopedTodo(db, reminder.todo_id, scope);
    if (!todo) throw new Error("Reminder not found");
    if (isDerivedReminder(todo, reminder.kind)) throw new Error(DERIVED_REMINDER);
    db.transaction(() => {
      if (reminder.kind === "due") {
        db.prepare("UPDATE todos SET due_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else if (reminder.kind === "pre") {
        db.prepare("UPDATE todos SET reminder_at=NULL,updated_at=? WHERE id=? AND user_id=?")
          .run(now(), todo.id, USER_ID);
      } else {
        const extras = (JSON.parse(todo.extra_reminders_json) as string[])
          .filter(value => instant(value) !== instant(reminder.scheduled_for));
        db.prepare("UPDATE todos SET extra_reminders_json=?,updated_at=? WHERE id=? AND user_id=?")
          .run(JSON.stringify(extras), now(), todo.id, USER_ID);
      }
      syncTodoReminders(db, getTodo(db, todo.id) as TodoRow);
      queueIndexJob(db, "todo", todo.id);
    })();
    search.flushSoon();
    return { id: reminderId };
  }
  /*
   * Atlassian tools read a remote system rather than SQLite, so they own no
   * projection and queue no index job. Each throws "Atlassian is not configured"
   * when no credential is stored, which the agent is told to report rather than
   * work around.
   */
  if (name === "list_jira_boards") {
    return listJiraBoards(db, {
      name_filter: input.name_filter as string | null,
      project_key: input.project_key as string | null,
      include_columns: input.include_columns as boolean | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "list_jira_issues") {
    return listJiraIssues(db, {
      board_id: input.board_id as number | null,
      assignee: input.assignee as string | null,
      project_key: input.project_key as string | null,
      status_ids: input.status_ids as string[] | null,
      text: input.text as string | null,
      updated_within_days: input.updated_within_days as number | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "get_jira_issue") {
    return getJiraIssue(db, {
      key: input.key as string,
      include_recent_changes: input.include_recent_changes as boolean | null,
    });
  }
  if (name === "list_jira_users") {
    return listJiraUsers(db, { query: input.query as string, limit: input.limit as number | null });
  }
  if (name === "list_confluence_spaces") {
    return listConfluenceSpaces(db, {
      keys: input.keys as string[] | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "list_confluence_pages") {
    return listConfluencePages(db, {
      space_keys: input.space_keys as string[] | null,
      text: input.text as string | null,
      modified_within_days: input.modified_within_days as number | null,
      mine_only: input.mine_only as boolean | null,
      limit: input.limit as number | null,
    });
  }
  if (name === "get_confluence_page") {
    return getConfluencePage(db, { id: input.id as string });
  }
  if (name === "list_confluence_comments") {
    return listConfluenceComments(db, {
      space_keys: input.space_keys as string[] | null,
      within_days: input.within_days as number | null,
      only_my_pages: input.only_my_pages as boolean | null,
      limit: input.limit as number | null,
    });
  }
  throw new Error(`Unsupported tool: ${name}`);
}
