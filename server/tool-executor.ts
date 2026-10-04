import type { AlgoliaSync } from "./algolia.ts";
import { attachmentJson, attachmentsForMemory, linkMemoryAttachments } from "./attachments.ts";
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
  DERIVED_REMINDER, DERIVED_SCHEDULE, REPEATING_SUBTASK, STEP_SCHEDULE,
  isDerivedReminder, parseRecurrence, planRecurrenceWrite, recurrenceJson, type RecurrenceRule,
} from "./recurrence.ts";
import { fiscalQuarterRange, type FiscalQuarter } from "./fiscal-quarter.ts";
import { withoutMediaLines } from "./image-input.ts";
import { assertSendableImage, giphyConfig, imagesInMarkdown, isRememberedImage, rememberImages, searchGifs } from "./image-output.ts";
import { refreshRosterMemory, rememberGroupMember } from "./group-members.ts";
import { entryDay, eveningEntryFor, eveningOccurredAt, isEveningEntry } from "./group-journal.ts";
import {
  addressesAssistant, ASSISTANT_NAME, GROUP_ADDRESS_PREFIX, groupIdOfAddress, OWNER_SPEAKER_NAME, redactedNumber,
  speakerLabel, speakerNameOf, withoutQuotedSpans,
} from "./group-thread.ts";
import { getNotificationPreferences, type SmsProvider } from "./integrations.ts";
import { localIsoWithOffset, zonedToInstant } from "./local-time.ts";
import { sendSms, type SmsSender } from "./messaging.ts";
import { type IncomingMood, parseMoods, resolveMoodFields } from "./moods.ts";
import { reflectionPeriod, reflectionScopeKey, type ReflectionPeriod, type ReflectionPreset } from "./reflection-period.ts";
import { SOUL_MAX, toolInput, type ToolName } from "./schemas.ts";
import { sendSendblueReaction } from "./sendblue-service.ts";
import { groupVoice, type ReplyMode, setGroupSettings, setGroupSoul, setOwnerSoul } from "./soul.ts";
import {
  clearStepSchedules, completeParentIfSettled, completionStats, isStepOfRepeating, reopenStepsForNextOccurrence,
  startParentIfPending, syncOccurrenceCompletion,
} from "./todo-status.ts";
import type { AttachmentRow, Db, MemoryRow, StoreProductRow, TodoRow, TodoStatus } from "./types.ts";
import {
  assertPublicUrl, linksIn, readWebPage, rememberResults, searchWeb, takeWebCall, wasReturned, webConfig, WebServiceError,
} from "./web-service.ts";

/** How far back a link someone pasted in the thread stays readable. */
const SHARED_LINK_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Whether a person in this conversation wrote `url` themselves: the message
 * being answered, or one of the thread's own recent messages. Only what people
 * wrote counts, never the assistant's replies, which the model composed.
 */
function sharedInThread(db: Db, context: ToolTurnContext | undefined, url: string): boolean {
  if (!context) return false;
  if (context.inboundText && linksIn(withoutMediaLines(context.inboundText)).includes(url)) return true;
  const since = new Date(Date.now() - SHARED_LINK_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT content FROM channel_messages
    WHERE thread_id=? AND role='user' AND direction='inbound' AND created_at>=? AND content LIKE ?
      AND COALESCE(json_extract(metadata_json,'$.internal'),0)=0
    ORDER BY created_at DESC LIMIT 50
  `).all(context.threadId, since, "%https://%") as Array<{ content: string }>;
  return rows.some(row => linksIn(withoutMediaLines(row.content)).includes(url));
}

/**
 * Writes need only the flush; the catalog search also reads Algolia when it is
 * configured. Both are optional so a test double that supplies neither still
 * exercises every tool through the local fallbacks.
 */
type SearchWriter = Pick<AlgoliaSync, "flushSoon"> & Partial<Pick<AlgoliaSync, "client" | "searchProducts">>;
type Input = Record<string, unknown>;

/**
 * The fields a patch empties. A field the same patch also gives a value is
 * being set, not cleared: "move it to Wednesday" arrived as the new time with
 * the old one listed to clear, and clearing it left the todo with no date.
 * An empty list is no value: moods merge rather than replace, so `[]` beside
 * a clear of them would otherwise leave every mood in place.
 */
function clearedFields(patch: Input): Set<string> {
  const names = Array.isArray(patch.clear_fields) ? patch.clear_fields.map(String) : [];
  const given = (value: unknown) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length);
  return new Set(names.filter(name => !given(patch[name])));
}

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

const memoryJson = (row: MemoryRow, attachments?: AttachmentRow[]) => ({
  id: row.id, title: row.title, content: row.content, kind: row.kind,
  mood_label: row.mood_label, mood_score: row.mood_score, moods: parseMoods(row.moods_json), category_id: row.category_id,
  category_name: row.category_name ?? null, life_area_id: row.life_area_id,
  life_area_name: row.life_area_name ?? null, life_area_slug: row.life_area_slug ?? null,
  life_area_source: row.life_area_source, occurred_at: row.occurred_at,
  review_worthy: Boolean(row.review_worthy), tags: JSON.parse(row.tags_json),
  created_at: row.created_at, updated_at: row.updated_at,
  // Only the reads of a single memory carry its pictures; a list of drafts does not.
  ...(attachments ? { attachments: attachments.map(attachment => attachmentJson(attachment)) } : {}),
});

/** A memory as one tool call returns it: with the saved pictures it holds. */
const memoryWithPictures = (db: Db, row: MemoryRow) => memoryJson(row, attachmentsForMemory(db, row.id));

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
    memories: memories.map(row => memoryJson(row)),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.map(row => memoryJson(row)),
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
    memories: memories.map(row => memoryJson(row)),
    todos: todos.map(todoJson),
    memory_candidates: memoryCandidates.filter(inScope).map(row => memoryJson(row)),
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
  /**
   * The saved pictures this turn answers (the ones on its message and, in a
   * group, those held while the assistant was told to stay out). A memory the
   * turn creates or updates carries them, which is how a receipt texted in
   * stays attached to the record that keeps its figures. Only pictures from
   * this turn's own thread are ever linked.
   */
  turnAttachmentIds?: string[];
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
  /** The burst's earlier messages this turn answers too; one that names the assistant makes the turn named. */
  burstTexts?: string[];
  /** Who wrote in a burst of more than one voice: the only names its moods may be filed under. */
  burstSpeakerNames?: string[];
  /** The day of the group's evening question still being answered: its answers go in that day's entry only. */
  eveningDate?: string;
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
  /**
   * The words already texted this turn, a bubble's or a picture's caption. A
   * closing reply that only says them again is the same message twice.
   */
  sentWords?: string[];
  /**
   * Set once a web tool has put someone else's text in front of the model this
   * turn. From then on deletes are refused until the user asks again, so a page
   * cannot talk the model into one with a `confirmed` flag it sets itself.
   */
  readWeb?: boolean;
  /**
   * Set by the web reads and the Jira and Confluence reads that return other
   * people's prose. A GIF title or a picture's words are short enough to
   * judge; a page is not, so after one nothing goes into another chat until
   * the owner asks again.
   */
  readPages?: boolean;
  /**
   * The group threads whose messages this turn has read, set by the runner
   * from what tools and the hosted search handed back. What someone wrote in
   * one group can then post only into that group.
   */
  groupThreadsRead?: Set<string>;
  /** The GIFs `find_gif` returned this turn: the only pictures `send_to_group` passes on. */
  foundGifs?: Set<string>;
  /**
   * Set once the turn has put text in front of the model that the person
   * answering did not write: anything `readWeb` covers, a picture's quoted
   * words, or — on the owner's own turn — records and messages people wrote in
   * a group. The Soul and the group settings change only on a person's own
   * words, so both refuse from then on.
   */
  readUntrusted?: boolean;
  /** An app-composed turn of any kind, named or not. */
  internal?: boolean;
  /** Set once update_soul or update_group_settings has landed: the change is the answer, and no text is owed. */
  adjustedVoice?: boolean;
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

const NO_TOOL_APP_TURNS = new Set([
  "group_morning", "group_evening", "evening_checkin", "checkin_ask_draft", "assistant_say", "follow_up", "profile_refresh",
  "group_profile_refresh",
]);

/**
 * App-composed turns that report on the owner's own day. A group's work is its
 * own check-ins' to report, so these read only what is not filed under a group
 * chat — the reverse of a group turn's fence. The owner asking on their own
 * line is not fenced: "did we clean the kitchen?" is theirs to ask.
 */
const OWN_RECORDS_APP_TURNS = new Set(["daily_digest", "digest_brief", "follow_up", "profile_refresh", "memory_sweep"]);

/**
 * The only tools a memory sweep may call. It reads a conversation someone else
 * wrote and its reply goes nowhere, so it keeps facts and does nothing else:
 * no sends, no deletes, no settings, whatever the quoted messages ask.
 */
const MEMORY_SWEEP_TOOLS = new Set(["get_memory", "create_memory", "update_memory"]);

export function ownRecordsOnly(context: ToolTurnContext | undefined): boolean {
  return !context?.scope && Boolean(context?.appTurn && OWN_RECORDS_APP_TURNS.has(context.appTurn));
}

/**
 * Tools that read the owner's working life or their Atlassian account, or reach
 * into the owner's other group chats. None of it belongs in a group chat, so in
 * a group they are refused before touching the database or the network rather
 * than filtered.
 */
const OWNER_ONLY_TOOLS = new Set([
  "get_review_evidence", "get_reflection_evidence",
  "list_jira_boards", "list_jira_issues", "get_jira_issue", "list_jira_users",
  "list_confluence_spaces", "list_confluence_pages", "get_confluence_page", "list_confluence_comments",
  "list_group_chats", "send_to_group", "react_in_group",
]);

const DELETE_TOOLS = new Set(["delete_todo", "delete_memory", "delete_reminder"]);

/** The Atlassian reads that hand back what coworkers wrote: descriptions, page bodies, comments, excerpts. */
const ATLASSIAN_PROSE_TOOLS = new Set([
  "list_jira_issues", "get_jira_issue", "list_confluence_pages", "get_confluence_page", "list_confluence_comments",
]);

/**
 * The browser route has no turn context, so its web reads are remembered
 * here: for a while after one, the owner's Soul changes only from Settings.
 */
const BROWSER_UNTRUSTED_MS = 15 * 60_000;
let browserReadUntrustedAt = 0;

/** Forgets the browser's last outside read; tests start from nothing. */
export function resetBrowserTurnState(): void {
  browserReadUntrustedAt = 0;
}

/**
 * How the assistant talks changes only on a person's own words: never on an
 * app-composed turn, and never once the turn has read text someone else
 * wrote, which could be asking for it.
 */
function assertOwnWords(context: ToolTurnContext | undefined, what: string): void {
  if (context?.internal || context?.appTurn) throw new Error(`This turn is the app writing, not a person; ${what} can change only when someone asks`);
  const untrusted = context
    ? context.readWeb || context.readUntrusted
    : Date.now() - browserReadUntrustedAt < BROWSER_UNTRUSTED_MS;
  if (untrusted) {
    throw new Error(`This turn read text someone else wrote, so ${what} can change only on a person's own message; ask them to say it again, or the owner can change it in Settings`);
  }
}

/** Marks a turn as having read outside text: a page, a search result, a GIF's title. */
function markReadWeb(context: ToolTurnContext | undefined): void {
  if (context) {
    context.readWeb = true;
    context.readUntrusted = true;
  } else {
    browserReadUntrustedAt = Date.now();
  }
}

/** Tools that put something in the chat besides the turn's own reply. */
const SENDING_TOOLS = new Set(["send_message", "send_image", "send_product_cards"]);

/**
 * One counted lookup: the call is returned to the day's allowance when it
 * failed without Bright Data doing the work, and kept when it timed out.
 */
async function countedWebCall<T>(db: Db, context: ToolTurnContext | undefined, call: () => Promise<T>): Promise<T> {
  const release = takeWebCall(userTimezone(db), Boolean(context?.scope));
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof WebServiceError && error.timedOut)) release();
    throw error;
  }
}

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

function scopedMemory(db: Db, memoryId: string, scope: GroupScope | undefined, ownOnly = false): MemoryRow | undefined {
  const row = getMemory(db, memoryId);
  if (row && scope && row.life_area_id !== scope.lifeAreaId) return undefined;
  // A turn fenced to the owner's own records does not find a group's, even by id.
  if (row && ownOnly && isGroupArea(db, row.life_area_id)) return undefined;
  return row;
}

/** The threads the app composes its own turns on: a digest, a profile rewrite, a memory sweep. */
function isScratchAddress(address: string): boolean {
  return /^(?:digest|profile|sweep):/.test(address);
}

function isGroupArea(db: Db, areaId: string | null | undefined): boolean {
  return Boolean(areaId && db.prepare("SELECT 1 found FROM life_areas WHERE id=? AND thread_id IS NOT NULL").get(areaId));
}

/** A turn fenced to the owner's own records cannot file anything under a group chat. */
function assertOwnArea(db: Db, ownOnly: boolean, areaId: string | null | undefined): void {
  if (ownOnly && isGroupArea(db, areaId)) throw new Error("This turn keeps only the owner's own records; a group chat's area is not one of them");
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

/**
 * Only the recipient's own number is the owner's line. With none configured
 * the inbound filter lets any 1:1 sender through, and nobody in that state may
 * reach the owner's groups.
 */
function assertOwnerLine(db: Db, context: ToolTurnContext): void {
  const owner = getNotificationPreferences(db).recipientPhone;
  if (!owner || context.address !== owner) throw new Error("Only the owner's own text chat can reach their group chats");
}

/** A group the owner has left, as far as the app saw, is not one the assistant speaks in for them. */
const OWNER_STILL_IN_GROUP = `NOT EXISTS (
  SELECT 1 FROM group_members gm WHERE gm.thread_id=t.id AND gm.is_owner=1 AND gm.left_at IS NOT NULL
)`;

/** How far back the owner's own messages on their line still count as naming the group to post in. */
const OWNER_ASK_WINDOW_MS = 30 * 60_000;

type OwnGroupThread = {
  id: string; address: string; groupId: string; group_name: string | null; area_name: string | null; display_name: string | null;
};

function ownGroupThread(db: Db, threadId: string): OwnGroupThread {
  const thread = db.prepare(`
    SELECT t.id,t.address,${GROUP_NAME_SQL} group_name,la.name area_name,t.display_name FROM channel_threads t
    LEFT JOIN life_areas la ON la.thread_id=t.id
    WHERE t.id=? AND t.user_id=? AND t.channel='sms' AND ${OWNER_STILL_IN_GROUP}
  `).get(threadId, USER_ID) as Omit<OwnGroupThread, "groupId"> | undefined;
  const groupId = thread ? groupIdOfAddress(thread.address) : undefined;
  if (!thread || !groupId) throw new Error("Group chat not found. Pass a thread_id from list_group_chats");
  return { ...thread, groupId };
}

/**
 * A turn that may act in `group` for the owner. Group turns never reach here
 * (`OWNER_ONLY_TOOLS`), and neither does anything the app composed, so a
 * check-in or a digest cannot post into a group whatever its instruction
 * quotes. The rest is what keeps someone else's words from choosing where the
 * owner speaks: the owner's own message has to name the group, and once the
 * turn has read what people wrote in some other group, or a page, nothing goes
 * out on it.
 */
function crossChatTurn(
  db: Db, context: ToolTurnContext | undefined, threadId: string,
): { turn: ToolTurnContext; group: OwnGroupThread } {
  if (!context || context.channel !== "sms") {
    throw new Error("This is not a text conversation; acting in a group chat works from the owner's own text chat");
  }
  if (context.appTurn || context.internal) {
    throw new Error("This turn is the app writing, not the owner; nothing goes into a group chat from it");
  }
  assertOwnerLine(db, context);
  const group = ownGroupThread(db, threadId);
  if (context.readPages) {
    throw new Error("This turn read a web page, search results, or a Jira or Confluence page, so nothing goes into another chat on it; ask the owner to say it again");
  }
  if ([...context.groupThreadsRead ?? []].some(threadId => threadId !== group.id)) {
    throw new Error("This turn read what people wrote in a different group chat, so nothing goes into this one on it; ask the owner to say it again");
  }
  // "Send it" answers the ask a few messages up, so the owner's own recent words on this line count too.
  const since = new Date(Date.now() - OWNER_ASK_WINDOW_MS).toISOString();
  const recent = db.prepare(`
    SELECT content FROM channel_messages
    WHERE thread_id=? AND role='user' AND direction='inbound' AND created_at>=?
      AND COALESCE(json_extract(metadata_json,'$.internal'),0)=0
  `).all(context.threadId, since) as Array<{ content: string }>;
  const asked = [context.inboundText ?? "", ...recent.map(row => row.content)]
    .map(text => withoutMediaLines(text).toLowerCase()).join("\n");
  const names = [group.area_name, group.display_name].map(name => name?.trim().toLowerCase()).filter(Boolean) as string[];
  if (!names.some(name => asked.includes(name))) {
    throw new Error(`The owner has to name the group to post there; ask them which chat they mean${group.group_name ? ` (this one is "${group.group_name}")` : ""}`);
  }
  return { turn: context, group };
}

/**
 * The provider handle of a message in that group, looked up by its archive id
 * within the group's own thread, so a handle from any other chat cannot be
 * aimed at.
 */
function groupMessageHandle(db: Db, threadId: string, messageId: string, forTapback: boolean): string {
  const row = db.prepare(`
    SELECT role,provider_message_id FROM channel_messages
    WHERE id=? AND thread_id=? AND role IN ('user','assistant') AND status<>'failed'
  `).get(messageId, threadId) as { role: "user" | "assistant"; provider_message_id: string | null } | undefined;
  if (!row?.provider_message_id) {
    throw new Error("Message not found. Pass a message_id from read_conversation on that group");
  }
  if (forTapback && row.role === "assistant") throw new Error("iMessage has no tapback for your own message; pick one someone else sent");
  return row.provider_message_id;
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
  if (context?.appTurn === "memory_sweep" && !MEMORY_SWEEP_TOOLS.has(name)) {
    throw new Error("This turn is the app keeping what a conversation established; it saves and updates memories and uses no other tool");
  }
  const scope = context?.scope;
  if (scope && OWNER_ONLY_TOOLS.has(name)) throw new Error(`${name} is not available in a group chat`);
  if (context?.readWeb && DELETE_TOOLS.has(name)) {
    throw new Error(
      "This turn read a web page or the words in a picture, so a delete needs the user's own go-ahead: ask them, and delete on their reply. Explicit confirmation is required",
    );
  }
  const ownOnly = ownRecordsOnly(context);
  // Staying quiet in a group is final: the text after it is dropped, and so is
  // anything sent another way.
  if (scope && context?.stayedQuiet && SENDING_TOOLS.has(name)) {
    throw new Error("You chose to stay quiet on this message; nothing more goes out this turn");
  }

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
    turn.sentWords = [...(turn.sentWords ?? []), text];
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

  /*
   * The Soul follows the conversation: in a group it is the group's, and
   * anyone there may shape how the assistant talks to them; everywhere else it
   * is the owner's own. A group turn can never reach the owner's. Neither is
   * changed by an app-composed turn or after a web page was read, since the
   * words asking for it have to be a person's.
   */
  if (name === "update_soul") {
    assertOwnWords(context, "the Soul");
    const soul = input.soul as string;
    if (!scope && soul.length > SOUL_MAX) throw new Error(`Keep the Soul under ${SOUL_MAX} characters`);
    const saved = scope
      ? { soul: setGroupSoul(db, scope.lifeAreaId, soul), applies_to: "this group chat" }
      : { soul: setOwnerSoul(db, soul), applies_to: "your own chats with the owner" };
    if (context) context.adjustedVoice = true;
    return saved;
  }
  if (name === "update_group_settings") {
    if (!context?.groupId || !scope) throw new Error("This conversation is not a group chat");
    const replyMode = (input.reply_mode as ReplyMode | null | undefined) ?? undefined;
    // "" clears the nickname; null leaves it as it is.
    const nickname = input.assistant_nickname === "" ? null : (input.assistant_nickname as string | null | undefined) ?? undefined;
    // The owner turning the assistant on or off is their own words even when
    // the turn has looked at the room's pictures on the way; a picture's words
    // could at worst flip a mode everyone can see. A page read still counts.
    const ownerReplyModeOnly = context.speakerIsOwner === true && nickname === undefined && !context.readPages;
    if (ownerReplyModeOnly) assertOwnWords({ ...context, readWeb: false, readUntrusted: false }, "group settings");
    else assertOwnWords(context, "group settings");
    if (replyMode === undefined && nickname === undefined) throw new Error("Pass reply_mode, assistant_nickname, or both");
    const voice = setGroupSettings(db, scope.lifeAreaId, { replyMode, assistantNickname: nickname });
    context.adjustedVoice = true;
    return { reply_mode: voice.replyMode, assistant_nickname: voice.assistantNickname };
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

  /*
   * The owner, from their own chat, acting in one of their groups. What goes
   * out is filed in the group's thread, so that group's next turn sees it in its
   * window and search finds it there; `sentFrom` says where it was asked for.
   */
  if (name === "list_group_chats") {
    if (context?.appTurn || context?.internal) throw new Error("This turn is the app writing, not the owner; it has no group chats to look through");
    if (context?.channel === "sms") assertOwnerLine(db, context);
    // The same rows read_conversation would show: nothing failed, no app instruction, no written-out tapback.
    const threads = db.prepare(`
      SELECT t.id,${GROUP_NAME_SQL} group_name,
        (SELECT created_at FROM channel_messages m
          WHERE m.thread_id=t.id AND m.role IN ('user','assistant') AND m.status<>'failed'
            AND NOT (m.role='user' AND COALESCE(json_extract(m.metadata_json,'$.internal'),0)=1)
            AND json_extract(m.metadata_json,'$.reactionText') IS NULL
          ORDER BY m.created_at DESC LIMIT 1) last_message_at
      FROM channel_threads t LEFT JOIN life_areas la ON la.thread_id=t.id
      WHERE t.user_id=? AND t.channel='sms' AND t.address LIKE ? AND ${OWNER_STILL_IN_GROUP}
      ORDER BY last_message_at IS NULL,last_message_at DESC
    `).all(USER_ID, `${GROUP_ADDRESS_PREFIX}%`) as Array<{ id: string; group_name: string | null; last_message_at: string | null }>;
    const members = db.prepare(`
      SELECT phone,name,is_owner FROM group_members WHERE thread_id=? AND left_at IS NULL ORDER BY is_owner DESC,name IS NULL,name
    `);
    // Anyone in a group can name it, so two groups can answer to the same name.
    const nameCounts = new Map<string, number>();
    for (const thread of threads) {
      const key = thread.group_name?.trim().toLowerCase();
      if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const timezone = userTimezone(db);
    return {
      groups: threads.map(thread => ({
        thread_id: thread.id,
        group_name: thread.group_name,
        // By name, or the shortened number a group turn would show; never the number itself.
        members: (members.all(thread.id) as Array<{ phone: string; name: string | null; is_owner: number }>)
          .map(member => member.is_owner ? OWNER_SPEAKER_NAME : member.name || redactedNumber(member.phone)),
        last_message_at: thread.last_message_at ? localIsoWithOffset(new Date(thread.last_message_at), timezone) : null,
        ...((nameCounts.get(thread.group_name?.trim().toLowerCase() ?? "") ?? 0) > 1 ? { name_shared: true } : {}),
      })),
    };
  }
  if (name === "send_to_group") {
    const { turn, group } = crossChatTurn(db, context, input.thread_id as string);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const imageUrl = typeof input.image_url === "string" && input.image_url ? input.image_url : undefined;
    if (imageUrl) {
      if (!turn.foundGifs?.has(imageUrl)) {
        throw new Error("Only a picture find_gif returned this turn can be sent; pass its URL exactly");
      }
      await assertSendableImage(imageUrl);
    }
    const replyTo = typeof input.reply_to_message_id === "string" && input.reply_to_message_id
      ? groupMessageHandle(db, group.id, input.reply_to_message_id, false)
      : undefined;
    const send = turn.sendSms ?? sendSms;
    const delivered = await send(db, group.address, text, {
      groupId: group.groupId,
      ...(imageUrl ? { mediaUrl: imageUrl } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    insertOutboundChannelMessage(db, group.id, text || "(picture)", delivered.sid, delivered.status, {
      kind: imageUrl ? "image" : "message",
      sentFrom: turn.threadId,
      ...(imageUrl ? { mediaUrl: imageUrl } : {}),
      ...(delivered.replyTo ? { replyTo: delivered.replyTo } : {}),
    });
    search.flushSoon();
    return {
      sent: true,
      group_name: group.group_name,
      threaded: Boolean(delivered.replyTo),
      message_handle: delivered.sid,
      status: delivered.status,
    };
  }
  if (name === "react_in_group") {
    const { group } = crossChatTurn(db, context, input.thread_id as string);
    const handle = groupMessageHandle(db, group.id, input.message_id as string, true);
    const reaction = input.reaction as string;
    await sendSendblueReaction(db, handle, reaction);
    // iMessage keeps one tapback per sender, so the receipt the runtime left on
    // that message is gone from the device the moment this one lands.
    if (!reaction.startsWith("-")) {
      const row = db.prepare("SELECT metadata_json FROM channel_messages WHERE thread_id=? AND provider_message_id=?")
        .get(group.id, handle) as { metadata_json: string | null } | undefined;
      const runtime = JSON.parse(row?.metadata_json || "{}").runtimeReactions;
      for (const mark of Array.isArray(runtime) ? runtime : []) {
        if (typeof mark === "string" && mark !== reaction) recordMessageReaction(db, group.id, handle, `-${mark}`, "runtime");
      }
    }
    recordMessageReaction(db, group.id, handle, reaction);
    return { reacted: true, reaction, group_name: group.group_name };
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
    // A name inside quotation marks is someone quoting a message, often a tapback
    // on one, not someone talking to the assistant. A tapback already answers a
    // message that names it but asks for nothing.
    const nickname = groupVoice(db, scope.lifeAreaId).assistantNickname;
    const ownWords = [context.inboundText ?? "", ...context.burstTexts ?? []]
      .map(text => withoutQuotedSpans(withoutMediaLines(text))).join("\n");
    if (!context.reacted && addressesAssistant(ownWords, nickname)) {
      const named = addressesAssistant(ownWords) ? ASSISTANT_NAME : nickname;
      throw new Error(`This message names ${named}, so it is for you, whoever wrote it: answer it, and when it asks nothing, a tapback alone is enough`);
    }
    context.stayedQuiet = true;
    // Who was passed over is kept beside why, so a suppressed request from the
    // owner can be found in the archive.
    return { quiet: true, reason: input.reason as string, speaker_is_owner: context.speakerIsOwner === true };
  }

  /*
   * The web tools read public pages, never the user's records, so a group may
   * use them too. What they return is someone else's text: it is marked
   * untrusted, and a read is limited to links a search in the same
   * conversation returned or a person in it sent.
   */
  if (name === "web_search") {
    webConfig();
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);
    const results = await countedWebCall(db, context, () => searchWeb(input.query as string, limit));
    rememberResults(context?.threadId ?? "web", results);
    markReadWeb(context);
    if (context) context.readPages = true;
    // Google answers "weather tomorrow" with its own widget and no organic
    // results at all, while "weather" alone returns the forecast sites.
    const hint = results.length ? undefined
      : "No results. Search again once with fewer words and no relative dates such as today or tomorrow, e.g. \"Blooming Grove NY weather\"";
    return { source: "web", untrusted: true, results, ...(hint ? { hint } : {}) };
  }
  if (name === "read_web_page") {
    webConfig();
    const url = input.url as string;
    assertPublicUrl(url);
    const shared = sharedInThread(db, context, url);
    if (!shared && !wasReturned(context?.threadId ?? "web", url)) {
      throw new Error("Only pages returned by web_search or links someone in this conversation sent can be read; pass one of those URLs exactly");
    }
    const page = await countedWebCall(db, context, () => readWebPage(url));
    markReadWeb(context);
    if (context) context.readPages = true;
    // The pictures on a page it read are ones send_image may pass on.
    rememberImages(context?.threadId ?? "web", imagesInMarkdown(page.text));
    const hint = page.text ? undefined
      : shared
        ? "The page returned no text (video sites often do). Go by what the link itself shows — the site, the path, the words in it — and never say you cannot open links"
        : "The page returned no text; answer from the search snippets or read another result";
    return { source: "web", untrusted: true, url, ...page, ...(hint ? { hint } : {}) };
  }

  /*
   * Pictures out. A GIF search reads nothing of the owner's, so a group may use
   * it; it shares the web allowance. send_image passes on only a picture a tool
   * in this conversation turned up: a GIF result, or one on a page it read.
   */
  if (name === "find_gif") {
    giphyConfig();
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);
    const gifs = await countedWebCall(db, context, () => searchGifs(input.query as string, limit));
    // Uploaders write the titles, so they are outside text like a search snippet.
    markReadWeb(context);
    rememberImages(context?.threadId ?? "web", gifs.map(gif => gif.url));
    if (context) context.foundGifs = new Set([...context.foundGifs ?? [], ...gifs.map(gif => gif.url)]);
    const hint = gifs.length ? undefined : "No GIFs. Try once more with one or two plainer words, e.g. \"happy dance\"";
    return { source: "giphy", untrusted: true, gifs, ...(hint ? { hint } : {}) };
  }
  if (name === "send_image") {
    const url = input.url as string;
    const caption = typeof input.caption === "string" && input.caption.trim() ? input.caption.trim() : "";
    if (!isRememberedImage(context?.threadId ?? "web", url)) {
      throw new Error("Only a picture find_gif returned or one on a page read_web_page read can be sent; pass its URL exactly");
    }
    // The browser has nowhere to drop an attachment; the agent shows the link instead.
    if (!context || context.channel !== "sms") return { channel: "web", sent: false, url };
    await assertSendableImage(url);
    const send = context.sendSms ?? sendSms;
    const delivered = await send(db, context.address, caption, { mediaUrl: url, ...(context.groupId ? { groupId: context.groupId } : {}) });
    insertOutboundChannelMessage(db, context.threadId, caption || "(picture)", delivered.sid, delivered.status, {
      kind: "image",
      mediaUrl: url,
    });
    context.sentText = true;
    if (caption) context.sentWords = [...(context.sentWords ?? []), caption];
    search.flushSoon();
    return { channel: "sms", sent: true, message_handle: delivered.sid, status: delivered.status };
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
    // a turn about the owner's own day, the groups' do not. The app's scratch
    // threads are nobody's conversation, and a sweep's holds a group's words.
    if (!thread || (scope && thread.id !== scope.threadId) || (ownOnly && groupIdOfAddress(thread.address)) || isScratchAddress(thread.address)) {
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
    // A turn that reports on the owner's own day does not read a group's chat,
    // and nobody reads the app's scratch threads.
    if (!thread || (ownOnly && groupIdOfAddress(thread.address)) || isScratchAddress(thread.address)) throw new Error("Conversation not found");
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
    const newestFirst = input.newest_first === true;
    if (newestFirst && cursor) throw new Error("next_from pages forward from the start of the range; pass newest_first null with it");
    // Speakers are matched on their label, which is worked out per row, so a
    // filtered read scans further before it is cut; either way it is bounded.
    const rows = db.prepare(`
      SELECT id,role,content,created_at,metadata_json,rowid FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant') AND status<>'failed'
        AND (created_at>? OR (created_at=? AND rowid>=?)) AND created_at<?
        AND NOT (role='user' AND COALESCE(json_extract(metadata_json,'$.internal'),0)=1)
        AND json_extract(metadata_json,'$.copyOf') IS NULL
        AND json_extract(metadata_json,'$.reactionText') IS NULL
      ORDER BY created_at ${newestFirst ? "DESC" : ""},rowid ${newestFirst ? "DESC" : ""} LIMIT ?
    `).all(thread.id, from, from, afterRowid, to, wanted ? SPEAKER_SCAN_LIMIT : limit + 1) as Array<{
      id: string; role: "user" | "assistant"; content: string; created_at: string; metadata_json: string; rowid: number;
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
    // Read from the end, the page is still listed in the order it was said.
    const page = newestFirst ? matching.slice(0, limit).reverse() : matching.slice(0, limit);
    return {
      thread_id: thread.id,
      ...(thread.group_name ? { group_name: thread.group_name } : {}),
      timezone,
      from: localIsoWithOffset(new Date(from), timezone),
      to: localIsoWithOffset(new Date(to), timezone),
      messages: page.map(row => ({
        message_id: row.id,
        at: localIsoWithOffset(new Date(row.created_at), timezone),
        speaker: row.speaker,
        content: row.content.length > MAX_CONTENT ? `${row.content.slice(0, MAX_CONTENT)}…` : row.content,
      })),
      ...(newestFirst
        // Older messages were left out; a narrower `to` or a read from the start reaches them.
        ? { has_earlier: matching.length > limit || Boolean(wanted && rows.length === SPEAKER_SCAN_LIMIT) }
        // The next page is the same range from the next message on: pass both back.
        : matching.length > limit
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
      if (input.due_at || input.reminder_at || extras.length) throw new Error(DERIVED_SCHEDULE);
      if (subtasks.some(raw => (raw as Input).due_at)) throw new Error(STEP_SCHEDULE);
    }
    if (input.parent_id) {
      const parent = scopedTodo(db, input.parent_id as string, scope);
      if (!parent) throw new Error("Parent todo not found");
      if (parent.recurrence_json && (input.due_at || input.reminder_at || extras.length)) throw new Error(STEP_SCHEDULE);
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
    const clear = clearedFields(patch);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "extra_reminders" ? [] : null) : patch[key] ?? currentValue;
    // Null in a patch means unchanged, so only an area the patch would really move to counts.
    if (!scope && current.life_area_source === "user"
      && value("life_area_id", current.life_area_id) !== current.life_area_id
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
    const extras = Array.isArray(patch.extra_reminders) ? patch.extra_reminders : [];
    const schedulePatched = Boolean(patch.due_at || patch.reminder_at || extras.length);
    if (repeat.recurrence_json) {
      if (parentId) throw new Error(REPEATING_SUBTASK);
      if (schedulePatched) throw new Error(DERIVED_SCHEDULE);
    }
    if (parentId && parentId !== current.parent_id && !scopedTodo(db, parentId, scope)) {
      throw new Error("Parent todo not found");
    }
    const stepOfRepeating = isStepOfRepeating(parentId, key => scopedTodo(db, key, scope));
    if (stepOfRepeating && schedulePatched) throw new Error(STEP_SCHEDULE);
    const schedule = repeat.derived ?? (stepOfRepeating ? { due_at: null, reminder_at: null, extra_reminders_json: "[]" } : {
      due_at: value("due_at", current.due_at) as string | null,
      reminder_at: value("reminder_at", current.reminder_at) as string | null,
      extra_reminders_json: JSON.stringify(value("extra_reminders", JSON.parse(current.extra_reminders_json))),
    });
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
      if (repeat.recurrence_json && !current.recurrence_json) clearStepSchedules(db, row);
      if (repeat.occurrenceMoved) reopenStepsForNextOccurrence(db, row);
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
    const memory = scopedMemory(db, input.id as string, scope, ownOnly);
    if (!memory) throw new Error("Memory not found");
    const found = memoryWithPictures(db, memory);
    // What a picture said is words from a document the owner did not write, the
    // same as an `[Image: …]` line in a message: a turn that has read it may
    // not act on it as the owner's word (see `assertOwnWords`).
    if (context && found.attachments?.some(picture => picture.description)) {
      context.readUntrusted = true;
    }
    return found;
  }
  if (name === "create_memory") {
    const timestamp = now();
    const memoryId = id("memory");
    const area = classificationForWrite(scope, input);
    assertOwnArea(db, ownOnly, area.life_area_id);
    // An answer to the group's evening question starts that evening's entry,
    // dated that evening, and there is only ever one.
    if (scope && context?.eveningDate
      && isEveningEntry({ kind: String(input.kind ?? "note"), tags_json: JSON.stringify(input.tags ?? []) })) {
      const timezone = userTimezone(db);
      const started = eveningEntryFor(db, scope.lifeAreaId, context.eveningDate, timezone);
      if (started) throw new Error(`Tonight's shared entry already exists (${started.id}); add this answer to it with update_memory`);
      if (entryDay((input.occurred_at as string | null | undefined) ?? null, timezone) !== context.eveningDate) {
        input = { ...input, occurred_at: eveningOccurredAt(context.eveningDate, timezone) };
      }
    }
    const mood = resolveMoodFields({
      existingJson: null,
      incoming: input.moods as IncomingMood[] | null | undefined,
      clear: false,
      plain: { mood_label: (input.mood_label as string | null | undefined) ?? null, mood_score: (input.mood_score as number | null | undefined) ?? null },
      speakerName: context?.speakerName,
      ownMoodOnly: ownMoodOnly(context),
      allowedNames: context?.burstSpeakerNames,
    });
    // One write, so a memory is never left without the pictures it was saved
    // from: the retry that would follow a half-finished call saves it twice.
    db.transaction(() => {
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
      // The pictures this turn was sent are kept with the record they produced.
      if (context?.threadId) linkMemoryAttachments(db, memoryId, context.turnAttachmentIds ?? [], context.threadId);
    })();
    search.flushSoon();
    return memoryWithPictures(db, getMemory(db, memoryId) as MemoryRow);
  }
  if (name === "update_memory") {
    const memoryId = input.id as string;
    const current = scopedMemory(db, memoryId, scope, ownOnly);
    if (!current) throw new Error("Memory not found");
    // While the group answers an evening question, an earlier evening's entry
    // is that evening's record: tonight's answers never land in it.
    if (scope && context?.eveningDate && isEveningEntry(current)) {
      const timezone = userTimezone(db);
      const day = entryDay(current.occurred_at, timezone);
      if (day !== context.eveningDate) {
        const tonight = eveningEntryFor(db, scope.lifeAreaId, context.eveningDate, timezone);
        throw new Error(`That entry is ${day ?? "another day"}'s; tonight's answers go in tonight's entry for ${context.eveningDate}${
          tonight ? ` (${tonight.id})` : ": create it with create_memory"}`);
      }
    }
    const patch = (input.patch || {}) as Input;
    const clear = clearedFields(patch);
    const value = (key: string, currentValue: unknown) =>
      clear.has(key) ? (key === "tags" ? [] : null) : patch[key] ?? currentValue;
    assertOwnArea(db, ownOnly, value("life_area_id", current.life_area_id) as string | null);
    // Null in a patch means unchanged, so only an area the patch would really move to counts.
    if (!scope && current.life_area_source === "user"
      && value("life_area_id", current.life_area_id) !== current.life_area_id
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
      allowedNames: context?.burstSpeakerNames,
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
      // Rewording a memory can be about a picture; retagging an old note in the
      // same turn is not, and must not pin the turn's receipt to it.
      const reworded = value("title", current.title) !== current.title || value("content", current.content) !== current.content;
      if (reworded && context?.threadId) linkMemoryAttachments(db, memoryId, context.turnAttachmentIds ?? [], context.threadId);
    })();
    search.flushSoon();
    return memoryWithPictures(db, getMemory(db, memoryId) as MemoryRow);
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
    if (isStepOfRepeating(todo.parent_id, key => scopedTodo(db, key, scope))) throw new Error(STEP_SCHEDULE);
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
    if (isStepOfRepeating(todo.parent_id, key => scopedTodo(db, key, scope))) throw new Error(STEP_SCHEDULE);
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
  if (context && ATLASSIAN_PROSE_TOOLS.has(name)) context.readPages = true;
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
