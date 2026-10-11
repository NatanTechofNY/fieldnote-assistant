import { type AlgoliaSync, configuredIndexNames, escapeFilterValue } from "./algolia.ts";
import {
  adoptStagedAttachments, attachmentFileIntact, attachmentForLink, attachmentsFull, attachmentsForMessage, readAttachment,
  setAttachmentDescription, stageAttachment, stageForMessage, storableType,
} from "./attachments.ts";
import { ensureGroupLifeArea, groupAreas, id, now, queueIndexJob, recordMessageReaction, USER_ID } from "./db.ts";
import { recordGroupParticipants, rosterLine } from "./group-members.ts";
import { EVENING_ANSWER_WINDOW_MS, eveningBeingAnswered, eveningEntryFor, eveningOccurredAt } from "./group-journal.ts";
import { addressesAssistant, OWNER_SPEAKER_NAME, redactedNumber, speakerLabel, withoutQuotedSpans } from "./group-thread.ts";
import { assertSendableImage, pullGifLine } from "./image-output.ts";
import { getNotificationPreferences, type SmsProvider } from "./integrations.ts";
import { localIsoWithOffset } from "./local-time.ts";
import {
  claimsReminder,
  claimsSave,
  MAX_CLAIM_SCAN,
  mentionsTodo,
  readShowsReminder,
  DUE_CLAIM_CHECK,
  REMINDER_CLAIM_CHECK,
  REMINDER_WRITE_TOOLS,
  SAVE_CLAIM_CHECK,
  todoWriteSetsReminder,
  writeChangesDue,
  claimsDueChange,
} from "./claims.ts";
import { plainText, type SmsSender } from "./messaging.ts";
import { sendSendblueReaction } from "./sendblue-service.ts";
import {
  describeMediaDetailed, fetchPicture, fillPendingPictures, hasImageDescription, imageInputMode, PICTURE_BUDGET_MS,
  PICTURE_FETCH_TIMEOUT_MS, PICTURE_PENDING, unviewedPictures, withoutMediaLines,
} from "./image-input.ts";
import { relevantFacts } from "./memory-context.ts";
import { servableGroupProfile, servableOwnerProfile } from "./profile.ts";
import { groupVoice, groupVoiceForThread, ownerSoul } from "./soul.ts";
import { executeAgentTool, ownRecordsOnly, type GroupScope, type ToolTurnContext } from "./tool-executor.ts";
import { TransientFailure } from "./transient.ts";
import type { AttachmentRow, Db } from "./types.ts";

/** What saving every picture of one message may take in all, whatever the number of links or how slow each is. */
const STAGING_BUDGET_MS = 30_000;

/**
 * Without a deadline an in-flight completion can outlive the reason anybody
 * wanted it. A laptop that slept mid-request left one pending for 89 minutes and
 * only rejected on wake, by which point the digest brief it belonged to had
 * already lost its send slot for the day.
 */
const COMPLETION_TIMEOUT_MS = 45_000;

/**
 * How far back a turn is answered against, and so also how long one Agent Studio
 * conversation lasts. The two are deliberately the same number: a conversation
 * that outlives the window holds turns the model was never shown.
 */
const CONTEXT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How many completions a turn may take before it is abandoned. A runaway loop
 * needs a ceiling, but the ceiling has to clear honest work: a twelve-item
 * checklist turned into todos one create per round ran out at eight, with ten
 * records written and no reply, and the retry two seconds later was overtaken
 * by the next text in the thread.
 */
const MAX_TOOL_ITERATIONS = 16;
/** Rounds a turn may spend showing the model a call Agent Studio refused. */
const MAX_REFUSED_ROUNDS = 2;
/** A claim check costs a model round; with less than this left in the budget the reply goes out as written. */
const CLAIM_CHECK_MARGIN_MS = 60_000;

/**
 * How long a turn may keep going before it is abandoned. The round cap bounds
 * a loop; this bounds the clock, which is what the rest of the worker feels:
 * inbound texts are answered one at a time and reminders wait behind them, so
 * sixteen slow rounds would otherwise hold every other thread for a quarter
 * of an hour. A completion already in flight still gets its own 45 seconds.
 */
const TURN_BUDGET_MS = 4 * 60_000;

function newConversationId(): string {
  return `alg_cnv_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The memory search is optional: a test double without it falls back to a lexical scan. */
type SearchWriter = Pick<AlgoliaSync, "flushSoon"> & Partial<Pick<AlgoliaSync, "searchMemories">>;
type AgentPart = {
  type?: string;
  text?: string;
  toolCallId?: string;
  tool_call_id?: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  [key: string]: unknown;
};
type AgentMessage = {
  id?: string;
  role: "user" | "assistant";
  parts: AgentPart[];
  metadata?: {
    turnContext?: Record<string, string | boolean>;
  };
};

type ChannelThreadRow = {
  id: string;
  agent_conversation_id: string;
};

function agentConfig(): { appId: string; apiKey: string; agentId: string } {
  const appId = process.env.ALGOLIA_APPLICATION_ID;
  const apiKey = process.env.ALGOLIA_AGENT_API_KEY || process.env.ALGOLIA_SEARCH_API_KEY;
  const agentId = process.env.ALGOLIA_AGENT_ID;
  if (!appId || !apiKey || !agentId) throw new Error("Agent Studio server credentials are not configured");
  return { appId, apiKey, agentId };
}

/**
 * Insert-then-select rather than select-then-insert: two concurrent messages
 * from a new address would both miss on a plain lookup, and the loser of the
 * race used to surface a UNIQUE violation as a 409 instead of joining the
 * thread that was just created.
 */
function getOrCreateThread(db: Db, channel: "sms" | "web", address: string): ChannelThreadRow {
  const timestamp = now();
  db.prepare(`
    INSERT OR IGNORE INTO channel_threads(id,user_id,channel,address,agent_conversation_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(
    id("thread"), USER_ID, channel, address,
    newConversationId(), timestamp, timestamp,
  );
  const thread = db.prepare(`
    SELECT id,agent_conversation_id FROM channel_threads
    WHERE user_id=? AND channel=? AND address=?
  `).get(USER_ID, channel, address) as ChannelThreadRow;
  return rotateStaleConversation(db, thread);
}

/**
 * Agent Studio files every turn under the conversation id we send, titles the
 * conversation from its first message, and never retitles it. One id pinned to a
 * phone number for life therefore collected three weeks of texts into a single
 * record named after whatever was said first — 54 messages deep, sorted among
 * the day it was created, and effectively unfindable in the dashboard. Rotating
 * once the thread falls outside the context window gives each conversation the
 * same span the model is shown, and a title drawn from its own opening line.
 */
function rotateStaleConversation(db: Db, thread: ChannelThreadRow): ChannelThreadRow {
  const latest = db.prepare(`
    SELECT max(created_at) last FROM channel_messages WHERE thread_id=?
  `).get(thread.id) as { last: string | null };
  if (!latest.last || Date.now() - Date.parse(latest.last) < CONTEXT_WINDOW_MS) return thread;
  const agent_conversation_id = newConversationId();
  db.prepare("UPDATE channel_threads SET agent_conversation_id=?,updated_at=? WHERE id=?")
    .run(agent_conversation_id, now(), thread.id);
  return { ...thread, agent_conversation_id };
}

/** Whether a GIF the reply picked is still one the provider can fetch; if not, the words go out alone. */
async function sendableGif(url: string): Promise<boolean> {
  try {
    await assertSendableImage(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether pictures sent on this thread are kept as files. Only a group's area
 * carries the switch; the owner's own chat always keeps them.
 */
export function threadKeepsPictures(db: Db, threadId: string): boolean {
  const row = db.prepare("SELECT keep_pictures FROM life_areas WHERE thread_id=? AND user_id=?")
    .get(threadId, USER_ID) as { keep_pictures: 0 | 1 } | undefined;
  return row?.keep_pictures !== 0;
}

/**
 * Tools that change SQLite, and so the only tools whose results are evidence of
 * what a past turn did rather than what it looked at.
 */
const WRITE_TOOLS = new Set([
  "create_todo", "update_todo", "set_todo_status", "delete_todo",
  "create_memory", "update_memory", "delete_memory",
  "create_reminder", "update_reminder", "delete_reminder",
  // A tapback changes nothing in SQLite but is just as irreversible from the
  // user's side, and a retried turn that cannot see the first one sends a
  // second. The same goes for a bubble sent mid-turn.
  "react_to_message", "send_message", "send_image",
  "send_to_group", "react_in_group",
  // Naming the group twice is harmless, but a retry should know it was done.
  "name_group_chat",
  "remember_group_member",
  "update_soul", "update_group_settings",
]);

/**
 * Tools that act on the conversation itself rather than look something up or
 * change a record. None of them is "working on it": a tapback, a threaded
 * reply, and an early bubble are the answer's own gestures, and the product
 * cards are messages. A GIF is a gesture too, and finding one is part of it:
 * a 🔍 on the message before a meme lands would read as a stall.
 */
const GESTURE_TOOLS = new Set([
  "react_to_message", "reply_in_thread", "send_product_cards", "send_message", "stay_quiet", "find_gif", "send_image",
  "send_to_group", "react_in_group",
]);

/**
 * The tapback that sits on the user's message while the turn is looking things
 * up. The typing bubble says someone is there; this says what they are doing,
 * which on a turn of two or three tool rounds is the difference between a pause
 * and a stall. It is placed by the runtime rather than the model so it costs no
 * completion, arrives the moment the first tool call comes back, and never
 * outlives the work: it gives way to the closing mark below when the answer is
 * in, or comes off before the agent's own tapback so that one stands alone.
 *
 * Which mark goes up says *what* is being looked at: the todo list, the
 * memories, the calendar, a Jira board. A batch of tools that all read the same
 * store gets that store's mark; a batch that spans stores, or a tool with no
 * entry here, gets the plain magnifier. iMessage keeps one tapback per sender
 * per message, so when the next round turns to a different store the new mark
 * simply replaces the old one on the device, and the archive is told the same.
 *
 * The hosted `personal_data_search` tool is not in this table because the
 * runner never sees it in flight: Algolia runs it inside the completion and
 * the `algolia_search_index_<index>` parts arrive with their hits already in
 * them, so there is no moment at which a mark could be raised. The client
 * tools that read the same records are what the marks follow.
 */
const PROGRESS_REACTIONS: Record<string, string> = {
  list_todos: "📋", get_todo: "📋", create_todo: "📋", update_todo: "📋", set_todo_status: "📋", delete_todo: "📋",
  get_memory: "🧠", create_memory: "🧠", update_memory: "🧠", delete_memory: "🧠",
  list_reminders: "⏰", create_reminder: "⏰", update_reminder: "⏰", delete_reminder: "⏰",
  get_agenda: "📅",
  get_conversation_context: "💬", read_conversation: "💬", list_group_chats: "💬",
  remember_group_member: "🧠",
  list_life_areas: "🗂️",
  get_review_evidence: "🪞", get_reflection_evidence: "🪞",
  list_jira_boards: "🎫", list_jira_issues: "🎫", get_jira_issue: "🎫", list_jira_users: "🎫",
  list_confluence_spaces: "📄", list_confluence_pages: "📄", get_confluence_page: "📄", list_confluence_comments: "📄",
  search_store_products: "🛒",
  web_search: "🌐", read_web_page: "🌐",
  view_image: "🖼️",
};
const GENERAL_PROGRESS_REACTION = "🔍";
/**
 * Sendblue has no typing indicator for group chats, so a message that is aimed
 * at the assistant gets this the moment its turn starts instead. It is a
 * progress mark like the others: a tool's mark replaces it, and it comes off
 * when the reply goes out.
 */
export const WORKING_MARK = "👀";
/** Every mark the runtime may place, so the archive can tell them from the agent's own reactions. */
const PROGRESS_MARKS = new Set([...Object.values(PROGRESS_REACTIONS), GENERAL_PROGRESS_REACTION, WORKING_MARK]);

/**
 * The tapback left on the message once the turn has answered, when the agent
 * did not leave one of its own. A progress mark that is simply lifted leaves
 * the message bare, and a reply about a todo that was just created reads
 * better under a ✅ than under nothing: the mark is the receipt. A turn that
 * only looked things up gets Apple's thumbs-up, the ordinary "got it". A turn
 * that ran no tools gets nothing from the runtime — whether "I had a rough
 * day" deserves a reaction, and which one, is the model's call, and the prompt
 * already asks it to react to what the user shares.
 */
const CLOSING_REACTIONS = { soul: "👻", memory: "🧠", changed: "✅", answered: "like" } as const;

/**
 * The writes the room should be able to see happened. A fact kept or a change
 * in how the assistant talks was invisible behind a generic ✅ or a tapback the
 * model chose, so these get a mark of their own, on the message and in the reply.
 */
const MEMORY_WRITE_TOOLS = new Set(["create_memory", "update_memory", "remember_group_member"]);
const SOUL_WRITE_TOOLS = new Set(["update_soul"]);

/**
 * The marks used to be appended to the reply's text as well. Every answer to an
 * evening check-in saves to the journal, so every reply in the group ended in
 * 🧠 and the model began adding it unprompted. The mark is a tapback only now;
 * rows an earlier version wrote still end in it, so replay strips it rather than
 * let history keep teaching the habit.
 */
const TRAILING_WRITE_MARKS = /(?:\s*(?:🧠|👻))+\s*$/u;
/** Every tapback the runtime places, progress or closing: what a retry may find already on the message. */
const RUNTIME_MARKS = new Set<string>([...PROGRESS_MARKS, ...Object.values(CLOSING_REACTIONS)]);

/**
 * The writes a ✅ confirms: the ones that change a record. Gestures sit in
 * `WRITE_TOOLS` so a retry does not repeat them, but they confirm nothing.
 */
const RECORD_WRITE_TOOLS = new Set([...WRITE_TOOLS].filter(name => !GESTURE_TOOLS.has(name)));

/**
 * A reply that says a todo's status changed. "Marked “Leave for PCP
 * appointment” as done" went out beside two creates and a get_todo, with no
 * set_todo_status anywhere in the turn: the prompt's rule against unbacked
 * claims is advice the model can skip, so the runner holds it to the claim.
 */
const STATUS_CLAIM = /\b(?:marked|checked off|crossed off)\b[^.!?\n]{0,120}?\b(?:done|complete(?:d)?|finished|cancell?ed|in progress|blocked|pending)\b|\b(?:checked|crossed) (?:it|that|them|those) off\b/i;

const STATUS_CLAIM_CHECK = [
  "[runtime check, not from the user] Your reply says a todo's status was changed,",
  "but no set_todo_status call succeeded in this turn, so no status changed.",
  "Call set_todo_status now for each todo you said you changed, then write your reply again.",
  "If a tool result showed a todo already had that status, say that instead of claiming you changed it.",
].join(" ");

/** The mark for one round of tool calls, or `undefined` when the round is gestures only. */
function progressReactionFor(toolNames: string[]): string | undefined {
  const marks = new Set(
    toolNames.filter(name => !GESTURE_TOOLS.has(name)).map(name => PROGRESS_REACTIONS[name] ?? GENERAL_PROGRESS_REACTION),
  );
  if (marks.size === 0) return undefined;
  return marks.size === 1 ? [...marks][0] : GENERAL_PROGRESS_REACTION;
}

/**
 * Rebuilds one stored assistant turn for the replayed window.
 *
 * A turn flattened to its own prose leaves the model unable to tell a write it
 * performed from one it only promised. "I'll remind you at 1:45" read back
 * identically to a reminder that existed, so the agent took its own sentence as
 * the record, skipped the create on the user's "yes", and reported success for a
 * reminder that was never written. Replaying the write results keeps the evidence
 * beside the claim.
 *
 * Reads are deliberately left out. Repeating a search costs little and the
 * duplicate preflight is supposed to run again, whereas a preflight hit replayed
 * as history is what the agent misread as proof that the write behind it landed.
 */
function assistantParts(content: string, metadataJson: string): AgentPart[] {
  const stored = ((): AgentPart[] => {
    try {
      return (JSON.parse(metadataJson) as { parts?: AgentPart[] }).parts ?? [];
    } catch {
      return [];
    }
  })();
  const writes = stored.filter(part =>
    typeof part.type === "string"
    && part.type.startsWith("tool-")
    && WRITE_TOOLS.has(part.type.slice(5))
    && part.state === "output-available"
    // Only a confirmed success is evidence. A failed write replayed without its
    // error would be the same mistake in the opposite direction.
    && (part.output as { success?: boolean } | null | undefined)?.success === true,
  );
  return [...writes, { type: "text", text: reminderNote(content.replace(TRAILING_WRITE_MARKS, "") || content, metadataJson) }];
}

/**
 * A reminder the app texted is an assistant row with no turn behind it, so the
 * owner's "will do that tomorrow around 2" answered it with nothing saying which
 * todo it was about, and the reply confirmed a new time without changing one.
 * The todo id rides along on the replayed row so the answer can be acted on.
 */
function reminderNote(content: string, metadataJson: string): string {
  try {
    const metadata = JSON.parse(metadataJson) as { kind?: unknown; todoId?: unknown };
    if (metadata.kind === "reminder" && typeof metadata.todoId === "string") {
      return `${content}\n[app note, not sent: this text was the reminder for todo ${metadata.todoId}]`;
    }
  } catch {
    // A row with unreadable metadata is replayed as plain text.
  }
  return content;
}

/**
 * The message an inline reply sits under. Sendblue's `reply_to` on an inbound
 * text is the message before it in the chat, which can be a tapback or a line
 * outside the thread; `thread_originator` is the thread's root and decides
 * whenever it is present.
 */
function threadParentHandle(inbound: { replyTo?: string; threadOriginator?: string } | undefined): string | undefined {
  return inbound?.threadOriginator || inbound?.replyTo || undefined;
}

/** How much of a quoted parent is worth carrying before it crowds out the reply. */
const QUOTE_LENGTH = 200;

/**
 * What a text sent as an iMessage inline reply is answering.
 *
 * The thread the user picked is not the one the transcript implies: "that works"
 * attached to this morning's flight question reads as agreement with whatever was
 * said last. The handle is on the row, and the parent is another row in the same
 * thread, so the quote is recoverable and belongs in front of the reply.
 */
function quotedParent(db: Db, threadId: string, metadataJson: string): string | null {
  const handle = ((): string | undefined => {
    try {
      return threadParentHandle(JSON.parse(metadataJson) as { replyTo?: string; threadOriginator?: string });
    } catch {
      return undefined;
    }
  })();
  if (!handle) return null;
  const parent = db.prepare(`
    SELECT content FROM channel_messages WHERE thread_id=? AND provider_message_id=?
  `).get(threadId, handle) as { content: string } | undefined;
  if (!parent) return null;
  const quote = parent.content.length > QUOTE_LENGTH
    ? `${parent.content.slice(0, QUOTE_LENGTH)}…`
    : parent.content;
  return quote;
}

/**
 * The recent window a turn is answered against. An abandoned app-composed turn is
 * excluded: the row stays for the audit trail, but replaying an instruction that
 * is about to be composed again stacks a second copy of the ask in front of the
 * live one, and a retried digest brief that read its own instruction twice — with
 * an unrelated check-in wedged between — filtered on an assignee nobody asked for.
 */
/** The id of the synthetic assistant message that carries an unanswered turn's writes. */
function orphanedWritesMessageId(userRowId: string): string {
  return `alg_msg_writes_${userRowId.replaceAll("-", "_")}`;
}

/** The id a stored row travels under in the window; Agent Studio wants its own prefix and no dashes. */
function historyMessageId(rowId: string): string {
  return rowId.startsWith("alg_msg_") ? rowId : `alg_msg_${rowId.replaceAll("-", "_")}`;
}

type UserRow = { id: string; content: string; metadata_json: string };

/**
 * A stored user row as the model reads it. A 1:1 thread has one voice and
 * needs no label; a shared one has several, and without it every request in
 * the window reads as the owner's. The label is a name, or a redacted number
 * when there is none: no full phone number leaves the server for the model.
 * The quote and the speaker are assembled here rather than stored, so the row
 * and its Algolia projection keep the text the user actually sent.
 */
function userMessage(db: Db, threadId: string, row: UserRow): AgentMessage {
  const quote = quotedParent(db, threadId, row.metadata_json);
  const speaker = speakerLabel(row.metadata_json);
  return {
    id: historyMessageId(row.id),
    role: "user",
    parts: [{
      type: "text",
      text: `${speaker ? `[${speaker}] ` : ""}${quote ? `[replying to "${quote}"] ` : ""}${row.content}`,
    }],
  };
}

function threadHistory(db: Db, threadId: string): AgentMessage[] {
  const cutoff = new Date(Date.now() - CONTEXT_WINDOW_MS).toISOString();
  /*
   * An app-composed instruction is not part of the conversation. It is the
   * turn being answered when it is current — `runChannelAgent()` appends it
   * then — and once answered it would only read back as a stranger's message:
   * a group's morning check-in instruction, replayed the next day in the
   * group's shared window, with no speaker and the app's wording. The reply it
   * produced stays, since that is what the people in the thread are answering.
   * A copy of a group's check-in echoed to the owner (`copyOf`) is not a
   * question asked of them either: left in, the owner's next line on their own
   * thread would read as the answer to an evening check-in of theirs.
   */
  const rows = db.prepare(`
    SELECT id,role,content,metadata_json,rowid FROM (
      SELECT id,role,content,metadata_json,created_at,rowid FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant') AND created_at>=?
        AND status<>'failed'
        AND NOT (role='user' AND COALESCE(json_extract(metadata_json,'$.internal'),0)=1)
        AND json_extract(metadata_json,'$.copyOf') IS NULL
        AND json_extract(metadata_json,'$.reactionText') IS NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 40
    ) ORDER BY created_at,rowid
  `).all(threadId, cutoff) as Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    metadata_json: string;
    rowid: number;
  }>;
  return rows.flatMap((row, index) => {
    const message: AgentMessage = row.role === "assistant"
      ? { id: historyMessageId(row.id), role: "assistant", parts: assistantParts(row.content, row.metadata_json) }
      : userMessage(db, threadId, row);
    if (row.role === "assistant") return [message];
    /*
     * A user turn with no reply after it is one nobody answered: the attempt
     * died, or it is the turn being answered now. Its tool rows still say what
     * it wrote, and without them the next turn in the thread reads the request
     * as untouched. A "yes" that created ten todos and then hit the iteration
     * cap was followed, two seconds later, by "all due Sunday" — a turn that
     * saw the list unanswered and created all ten again.
     *
     * Only the runner's own reply counts as an answer. An "on it 👀" bubble
     * sent mid-turn, a product card, and a reminder delivered into the thread
     * are assistant rows too, and none of them says the turn finished.
     */
    let answered = false;
    let nextUser: { rowid: number } | undefined;
    for (const later of rows.slice(index + 1)) {
      if (later.role === "user") {
        nextUser = later;
        break;
      }
      if (isRunnerReply(later.metadata_json)) {
        answered = true;
        break;
      }
    }
    if (answered) return [message];
    const writes = orphanedWrites(db, threadId, row.rowid, nextUser?.rowid);
    if (!writes.length) return [message];
    return [message, { id: orphanedWritesMessageId(row.id), role: "assistant", parts: writes }];
  });
}

/** Whether an assistant row is the reply `runChannelAgent()` wrote, which alone carries the turn's `parts`. */
function isRunnerReply(metadataJson: string): boolean {
  try {
    return Array.isArray((JSON.parse(metadataJson) as { parts?: unknown }).parts);
  } catch {
    return false;
  }
}

/**
 * The writes a turn made without ever writing its assistant row, shaped as the
 * assistant message that would have carried them.
 *
 * A turn that times out after its `update_todo` has changed the record but never
 * written the assistant row `threadHistory()` replays, so the retry two seconds
 * later saw the user's request and nothing else, made the same write again, and
 * a third attempt — finding the notes already in place — reported them as
 * something that had always been there. The tool rows survive the failure, so
 * the retry can be shown what it already did and pick up from there; the same
 * rule as `assistantParts()`, that a write result beside the request is the only
 * evidence a write happened. Reads are left out for the same reason they are
 * left out of the replay: repeating one is cheap, and a stale one is misleading.
 *
 * The rows are the tool rows filed after the user row and, when a later user
 * row exists, before it: insertion order rather than the clock, because two
 * turns can land in the same millisecond, and the earlier one's write is not
 * this turn's.
 */
function orphanedWrites(db: Db, threadId: string, afterRowid: number, beforeRowid?: number): AgentPart[] {
  const rows = db.prepare(`
    SELECT content,metadata_json FROM channel_messages
    WHERE thread_id=? AND role='tool' AND rowid>? AND (? IS NULL OR rowid<?) ORDER BY rowid
  `).all(threadId, afterRowid, beforeRowid ?? null, beforeRowid ?? null) as Array<{ content: string; metadata_json: string }>;
  return rows.flatMap(row => {
    if (!WRITE_TOOLS.has(row.content)) return [];
    let trace: { input?: Record<string, unknown>; output?: unknown; toolCallId?: string };
    try {
      trace = JSON.parse(row.metadata_json) as typeof trace;
    } catch {
      return [];
    }
    if (!trace.toolCallId || (trace.output as { success?: boolean } | undefined)?.success !== true) return [];
    return [{
      type: `tool-${row.content}`,
      toolCallId: trace.toolCallId,
      state: "output-available",
      input: trace.input,
      output: trace.output,
    }];
  });
}

/**
 * Takes the runtime's progress mark off a message whose turn is being given up.
 *
 * A failed turn leaves its mark up on purpose, because the retry is still
 * coming; once the worker stops retrying, nothing else would ever take it down,
 * and a 🔍 that never resolves is a promise the app did not keep. The agent's
 * own reaction, if it made one, is not touched. Best effort, like every tapback.
 */
export async function liftProgressMark(db: Db, address: string, providerMessageId: string): Promise<void> {
  const thread = db.prepare(`
    SELECT id FROM channel_threads WHERE user_id=? AND channel='sms' AND address=?
  `).get(USER_ID, address) as { id: string } | undefined;
  if (!thread) return;
  const mark = reactionsOn(db, thread.id, providerMessageId).runtime.find(reaction => PROGRESS_MARKS.has(reaction));
  if (!mark) return;
  try {
    await sendSendblueReaction(db, providerMessageId, `-${mark}`);
    recordMessageReaction(db, thread.id, providerMessageId, `-${mark}`, "runtime");
  } catch (error) {
    console.warn("Could not lift the progress tapback:", error instanceof Error ? error.message : error);
  }
}

/**
 * The tapbacks on the inbound message and not taken back, per the archive:
 * all of them, and the ones the runtime placed. A row written before the
 * archive told the two apart has no `runtimeReactions`; for it, a progress
 * mark's emoji is taken to be the runtime's, which is what it always was then.
 */
function reactionsOn(db: Db, threadId: string, providerMessageId: string): { all: string[]; runtime: string[] } {
  const row = db.prepare(`
    SELECT rowid,metadata_json FROM channel_messages WHERE thread_id=? AND provider_message_id=?
  `).get(threadId, providerMessageId) as { rowid: number; metadata_json: string | null } | undefined;
  if (!row) return { all: [], runtime: [] };
  try {
    const metadata = JSON.parse(row.metadata_json || "{}") as { reactions?: unknown; runtimeReactions?: unknown };
    const strings = (list: unknown): string[] =>
      (Array.isArray(list) ? list : []).filter((value): value is string => typeof value === "string");
    const all = strings(metadata.reactions);
    if (Array.isArray(metadata.runtimeReactions)) return { all, runtime: strings(metadata.runtimeReactions) };
    /*
     * A row from before the archive said who placed what. A progress-mark
     * emoji on it is the runtime's unless the agent is on record choosing that
     * very emoji for this message: `react_to_message` leaves a tool row after
     * the inbound with the reaction in its input, so the record is there to ask.
     */
    const chosen = new Set(agentReactionsAfter(db, threadId, row.rowid));
    return { all, runtime: all.filter(reaction => PROGRESS_MARKS.has(reaction) && !chosen.has(reaction)) };
  } catch {
    return { all: [], runtime: [] };
  }
}

/** The reactions the agent's own `react_to_message` calls placed on the turn that starts at `inboundRowid`. */
function agentReactionsAfter(db: Db, threadId: string, inboundRowid: number): string[] {
  const rows = db.prepare(`
    SELECT json_extract(metadata_json,'$.input.reaction') reaction FROM channel_messages
    WHERE thread_id=? AND role='tool' AND content='react_to_message' AND rowid>?
      AND rowid<COALESCE((SELECT min(rowid) FROM channel_messages WHERE thread_id=? AND role='user' AND rowid>?),9223372036854775807)
      AND json_extract(metadata_json,'$.output.success')=1
  `).all(threadId, inboundRowid, threadId, inboundRowid) as Array<{ reaction: unknown }>;
  return rows.map(row => row.reaction).filter((value): value is string => typeof value === "string" && !value.startsWith("-"));
}

function saveChannelMessage(
  db: Db,
  threadId: string,
  direction: "inbound" | "outbound",
  role: "user" | "assistant" | "tool" | "system",
  content: string,
  providerMessageId?: string,
  metadata: Record<string, unknown> = {},
): string {
  const messageId = id("channel_message");
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO channel_messages(
        id,thread_id,direction,role,content,provider_message_id,status,metadata_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      messageId, threadId, direction, role, content, providerMessageId ?? null,
      role === "tool" ? "delivered" : "received", JSON.stringify(metadata), timestamp, timestamp,
    );
    db.prepare("UPDATE channel_threads SET updated_at=? WHERE id=?").run(timestamp, threadId);
    if (role === "user" || role === "assistant") queueIndexJob(db, "channel_message", messageId);
  })();
  return messageId;
}

/**
 * A redelivered or retried inbound text has to resume its turn rather than land
 * a second row. `provider_message_id` is unique, so the plain insert aborted the
 * retry before the agent ran at all: a turn whose tool calls had already
 * succeeded but whose reply never came could not be answered on any later
 * attempt, and the constraint violation overwrote the real reason it first
 * failed. Reusing the row leaves the retry looking at the history it needs.
 */
function saveInboundMessage(
  db: Db,
  threadId: string,
  body: string,
  providerMessageId: string | undefined,
  metadata: Record<string, unknown>,
): string {
  if (providerMessageId) {
    const existing = db.prepare(`
      SELECT id FROM channel_messages
      WHERE thread_id=? AND direction='inbound' AND provider_message_id=?
    `).get(threadId, providerMessageId) as { id: string } | undefined;
    if (existing) {
      // An earlier attempt that gave up mid-turn may have parked the row outside
      // the recent window; the turn being answered now belongs back inside it.
      db.prepare("UPDATE channel_messages SET status='received',updated_at=? WHERE id=?")
        .run(now(), existing.id);
      adoptStagedAttachments(db, threadId, providerMessageId, existing.id);
      return existing.id;
    }
  }
  // Born knowing who placed what: only a row from before the list existed is
  // ever read by inference.
  const messageId = saveChannelMessage(db, threadId, "inbound", "user", body, providerMessageId, { ...metadata, runtimeReactions: [] });
  // The pictures it came with were saved to disk before it was filed.
  adoptStagedAttachments(db, threadId, providerMessageId, messageId);
  return messageId;
}

/**
 * Keeps a copy of every picture on an inbound message before anything else
 * touches it, whether or not the assistant will look at it: the provider's
 * link can expire, and a group's held picture may not be asked about for an
 * hour. Ties itself to the message if it is already filed (a held group
 * message is), and otherwise `saveInboundMessage` ties it when it is. A link
 * that cannot be fetched is logged, and the turn that reads the message tries
 * it again from the provider and keeps what it gets.
 */
export async function stageInboundPictures(
  db: Db,
  address: string,
  providerMessageId: string | undefined,
  urls: string[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!urls.length) return;
  const thread = getOrCreateThread(db, "sms", address);
  // A group that keeps no pictures still has them read; the turn fetches each from the provider's link.
  if (!threadKeepsPictures(db, thread.id)) return;
  // The message's pictures share one allowance, so dead links cannot add up to a long wait.
  const budget = AbortSignal.timeout(STAGING_BUDGET_MS);
  for (const url of urls) {
    if (budget.aborted) {
      console.warn("Saving attachments ran out of time; the rest are left for the turn to fetch.");
      return;
    }
    try {
      const have = db.prepare(`
        SELECT * FROM attachments WHERE thread_id=? AND COALESCE(provider_message_id,'')=? AND source_url=?
      `).get(thread.id, providerMessageId ?? "", url) as AttachmentRow | undefined;
      // A row whose file has gone is staged again; `stageAttachment` repairs it.
      if (have && attachmentFileIntact(db, have)) continue;
      const picture = await fetchPicture(url, fetcher, AbortSignal.any([AbortSignal.timeout(PICTURE_FETCH_TIMEOUT_MS), budget]));
      if (!picture.bytes || !storableType(picture.type)) continue;
      if (attachmentsFull(db, picture.bytes.length)) {
        console.warn("Not keeping a picture: ATTACHMENTS_MAX_MB is reached.");
        continue;
      }
      stageAttachment(db, { threadId: thread.id, providerMessageId, sourceUrl: url, contentType: picture.type, bytes: picture.bytes });
      // Converting a photo is synchronous work; let the server answer a request between two of them.
      await new Promise(resolve => setImmediate(resolve));
    } catch (error) {
      console.warn("Saving an attachment failed:", error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Files a tapback that arrived as text ("Loved “…”") without answering it. It
 * stays in the archive, so the history page shows what was sent, but is marked
 * so the window, the history tool, and the index all leave it out: it is a
 * reaction to a message, not something anyone said.
 */
export function archiveReactionText(
  db: Db,
  address: string,
  body: string,
  providerMessageId: string | undefined,
  metadata: Record<string, unknown> = {},
): string {
  const thread = getOrCreateThread(db, "sms", address);
  return saveInboundMessage(db, thread.id, body, providerMessageId, { ...metadata, reactionText: true });
}

/**
 * The text an earlier attempt already archived for this inbound message, so a
 * retry answers the same words rather than paying to describe its pictures again.
 */
export function archivedInboundText(db: Db, address: string, providerMessageId: string | undefined): string | undefined {
  if (!providerMessageId) return undefined;
  const row = db.prepare(`
    SELECT m.content FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND t.channel='sms' AND t.address=? AND m.direction='inbound' AND m.provider_message_id=?
  `).get(USER_ID, address, providerMessageId) as { content: string } | undefined;
  return row?.content;
}

/** Whether the message is an inline reply to one of the assistant's own messages. */
function repliesToAssistant(db: Db, threadId: string, inbound: InboundContext | undefined): boolean {
  const handle = threadParentHandle(inbound);
  return Boolean(handle && db.prepare(`
    SELECT 1 found FROM channel_messages WHERE thread_id=? AND provider_message_id=? AND role='assistant'
  `).get(threadId, handle));
}

/** How long a reminder or morning note in the chat can still be answered with a bare "done". */
const PROMPTED_ANSWER_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Files a group message without answering it, when the group has asked the
 * assistant to stay out until named and this message does not name it or
 * reply to it. Returns false — nothing filed — when the message is for it after
 * all. Two exceptions, both the app asking the room something: answers to the
 * evening question are the day's shared journal entry, which only the
 * assistant writes, so for a few hours after it went out every message still
 * reaches the agent; and when the last thing the assistant said was a reminder
 * or the morning note, "done" or "push it to Monday" is an answer to it.
 */
export function holdUntilNamed(
  db: Db,
  address: string,
  body: string,
  providerMessageId: string | undefined,
  inbound: InboundContext | undefined,
  metadata: Record<string, unknown>,
): boolean {
  const thread = db.prepare("SELECT id FROM channel_threads WHERE user_id=? AND channel='sms' AND address=?")
    .get(USER_ID, address) as { id: string } | undefined;
  if (!thread) return false;
  const voice = groupVoiceForThread(db, thread.id);
  if (voice?.replyMode !== "named_only") return false;
  if (addressesAssistant(body, voice.assistantNickname) || repliesToAssistant(db, thread.id, inbound)) return false;
  // A burst's earlier message that named the assistant is answered by this turn.
  const burst = burstRows(db, thread.id, providerMessageId);
  if (burst.some(row => row.forAssistant(db, thread.id, voice.assistantNickname))) return false;
  const since = new Date(Date.now() - EVENING_ANSWER_WINDOW_MS).toISOString();
  const eveningAsked = db.prepare(`
    SELECT 1 found FROM channel_messages
    WHERE thread_id=? AND role='assistant' AND status<>'failed'
      AND json_extract(metadata_json,'$.kind')='group_evening' AND created_at>=?
    LIMIT 1
  `).get(thread.id, since);
  if (eveningAsked) return false;
  const lastSaid = db.prepare(`
    SELECT json_extract(metadata_json,'$.kind') kind,created_at FROM channel_messages
    WHERE thread_id=? AND role='assistant' AND status<>'failed'
    ORDER BY created_at DESC,rowid DESC LIMIT 1
  `).get(thread.id) as { kind: string | null; created_at: string } | undefined;
  if (lastSaid && ["reminder", "group_morning"].includes(lastSaid.kind ?? "")
    && Date.now() - Date.parse(lastSaid.created_at) < PROMPTED_ANSWER_WINDOW_MS) {
    return false;
  }
  saveInboundMessage(db, thread.id, body, providerMessageId, { ...metadata, heldUntilNamed: true });
  // What was folded into this message is held with it, for the turn that is next named.
  if (providerMessageId) {
    db.prepare(`
      UPDATE channel_messages
      SET metadata_json=json_set(json_remove(metadata_json,'$.foldedInto'),'$.heldUntilNamed',json('true'))
      WHERE thread_id=? AND role='user' AND json_extract(metadata_json,'$.foldedInto')=?
    `).run(thread.id, providerMessageId);
  }
  return true;
}

/**
 * Files a group message the next queued message's turn will answer with it.
 * People send a thought in two or three bubbles, or two of them ask the same
 * thing at once, and a turn per bubble answered each: three bubbles in a row
 * got three versions of the same reply. The row names the message whose turn
 * answers it (`foldedInto`), so the burst belongs to exactly that turn — not
 * to whatever turn runs next — and anything already folded into this message
 * moves along with it. The thread's handles are kept so a folded inline reply
 * to the assistant still counts as one.
 */
export function foldIntoNextTurn(
  db: Db,
  address: string,
  body: string,
  providerMessageId: string,
  inbound: InboundContext | undefined,
  metadata: Record<string, unknown>,
  foldedInto: string,
): void {
  const thread = getOrCreateThread(db, "sms", address);
  db.transaction(() => {
    saveInboundMessage(db, thread.id, body, providerMessageId, {
      ...metadata,
      ...(inbound?.replyTo ? { replyTo: inbound.replyTo } : {}),
      ...(inbound?.threadOriginator ? { threadOriginator: inbound.threadOriginator } : {}),
      foldedInto,
    });
    db.prepare(`
      UPDATE channel_messages SET metadata_json=json_set(metadata_json,'$.foldedInto',?)
      WHERE thread_id=? AND role='user' AND json_extract(metadata_json,'$.foldedInto')=?
    `).run(foldedInto, thread.id, providerMessageId);
  })();
}

/** When the oldest message a burst has been gathering since arrived: the burst stops growing past a bound. */
export function burstStartedAt(db: Db, address: string, providerMessageId: string): string | undefined {
  const row = db.prepare(`
    SELECT min(m.created_at) started FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND t.channel='sms' AND t.address=? AND m.role='user'
      AND json_extract(m.metadata_json,'$.foldedInto')=?
  `).get(USER_ID, address, providerMessageId) as { started: string | null };
  return row.started ?? undefined;
}

type BurstRow = {
  id: string;
  content: string;
  speaker: string;
  /** The speaker's number, as filed; never shown to the model. */
  phone?: string;
  isOwner: boolean;
  /** Whether it named the assistant in its own words, or was an inline reply to one of its messages. */
  forAssistant: (db: Db, threadId: string, nickname: string | null | undefined) => boolean;
};

/** The messages folded into `handle`, oldest first: the burst that message's turn answers. */
function burstRows(db: Db, threadId: string, handle: string | undefined): BurstRow[] {
  if (!handle) return [];
  const rows = db.prepare(`
    SELECT id,content,metadata_json FROM channel_messages
    WHERE thread_id=? AND role='user' AND json_extract(metadata_json,'$.foldedInto')=?
    ORDER BY created_at,rowid
  `).all(threadId, handle) as Array<{ id: string; content: string; metadata_json: string }>;
  return rows.map(row => {
    const metadata = JSON.parse(row.metadata_json || "{}") as {
      replyTo?: string; threadOriginator?: string; speaker?: string; speakerIsOwner?: boolean;
    };
    return {
      id: row.id,
      content: row.content,
      speaker: speakerLabel(row.metadata_json) ?? OWNER_SPEAKER_NAME,
      phone: metadata.speaker,
      isOwner: metadata.speakerIsOwner === true,
      forAssistant: (database, thread, nickname) =>
        addressesAssistant(withoutQuotedSpans(withoutMediaLines(row.content)), nickname)
        || repliesToAssistant(database, thread, { provider: "sendblue", replyTo: metadata.replyTo, threadOriginator: metadata.threadOriginator }),
    };
  });
}

/** How recently the assistant has to have spoken for a message to read as a reply to it. */
const FOLLOW_UP_WINDOW_MS = 10 * 60_000;

/**
 * Whether a group message is aimed at the assistant, as far as the server can
 * tell before the model has read it: it names the assistant, it is an inline
 * reply to one of the assistant's messages, or the same person is carrying on
 * a back-and-forth the assistant answered a moment ago. Someone else speaking
 * up after the assistant's reply is as likely talking to the room. Only these
 * get the working mark; the model still decides for itself whether to answer.
 */
function aimedAtAssistant(
  db: Db,
  threadId: string,
  inboundId: string,
  text: string,
  inbound: InboundContext | undefined,
  speakerPhone: string | undefined,
  handle: string | undefined,
): boolean {
  const nickname = groupVoiceForThread(db, threadId)?.assistantNickname;
  if (addressesAssistant(text, nickname)) return true;
  if (repliesToAssistant(db, threadId, inbound)) return true;
  if (burstRows(db, threadId, handle).some(row => row.forAssistant(db, threadId, nickname))) return true;
  if (!speakerPhone) return false;
  // The last few rows before this one, newest first, read off the thread's
  // (thread_id, created_at) index rather than a sort of the whole thread.
  const earlier = db.prepare(`
    SELECT role,created_at,json_extract(metadata_json,'$.speaker') speaker,
      COALESCE(json_extract(metadata_json,'$.internal'),0) internal
    FROM channel_messages
    WHERE thread_id=? AND role IN ('user','assistant') AND status<>'failed'
      AND json_extract(metadata_json,'$.reactionText') IS NULL
      AND created_at<=(SELECT created_at FROM channel_messages WHERE id=?) AND id<>?
    ORDER BY created_at DESC,rowid DESC LIMIT 6
  `).all(threadId, inboundId, inboundId) as Array<{ role: string; created_at: string; speaker: string | null; internal: number }>;
  const latest = earlier[0];
  if (latest?.role !== "assistant" || Date.now() - Date.parse(latest.created_at) >= FOLLOW_UP_WINDOW_MS) return false;
  // Past the assistant's reply, which may have been two bubbles, to what it answered.
  const answered = earlier.find(row => row.role === "user");
  // A scheduled check-in asked the room something; whoever answers it is talking to the assistant.
  if (answered?.internal) return true;
  return answered?.speaker === speakerPhone;
}

/** How recently the assistant has to have spoken to still be part of the exchange. */
const IN_CONVERSATION_MS = 3 * 60_000;

/**
 * Whether the assistant is in the middle of the exchange: it wrote one of the
 * last four messages before this one, a few minutes ago at most. A question to
 * the room then includes it. Without this it answered one question and then
 * sat out the follow-up asked to the room as banter that asked nothing of it.
 */
function assistantInConversation(db: Db, threadId: string, inboundId: string): boolean {
  const recent = db.prepare(`
    SELECT role,created_at FROM channel_messages
    WHERE thread_id=? AND role IN ('user','assistant') AND status<>'failed'
      AND json_extract(metadata_json,'$.reactionText') IS NULL
      AND created_at<=(SELECT created_at FROM channel_messages WHERE id=?) AND id<>?
    ORDER BY created_at DESC,rowid DESC LIMIT 4
  `).all(threadId, inboundId, inboundId) as Array<{ role: string; created_at: string }>;
  return recent.some(row => row.role === "assistant" && Date.now() - Date.parse(row.created_at) < IN_CONVERSATION_MS);
}

/** A message's words, for telling whether two texts say the same thing. */
function sameWords(text: string): string {
  return text.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** How long a held picture waits to be looked at; past this it belongs to an earlier conversation. */
const HELD_PICTURE_WINDOW_MS = 60 * 60_000;
/**
 * The most pictures one turn looks at, its own first and then held ones newest
 * first. Each can take the vision call's full timeout, and every other thread
 * waits behind the turn.
 */
const PICTURES_PER_TURN = 4;
/** The runtime's mark on a message while its pictures are being looked at. */
const VIEWING_MARK = PROGRESS_REACTIONS.view_image;

/** A row's pictures still to look at, the first of its unviewed ones, of `urlCount` attachments in all. */
type UnviewedPictures = { id: string; content: string; urls: string[]; urlCount: number };

function mediaUrlList(value: unknown): string[] {
  const list = typeof value === "string" ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return []; }
  })() : value;
  return Array.isArray(list) ? list.filter((url): url is string => typeof url === "string") : [];
}

function unviewedOn(id: string, content: string, mediaUrls: unknown, limit: number): UnviewedPictures[] {
  const all = mediaUrlList(mediaUrls);
  const urls = unviewedPictures(content, all).slice(0, Math.max(limit, 0));
  return urls.length ? [{ id, content, urls, urlCount: all.length }] : [];
}

/**
 * Where the pictures held for this turn start: the assistant's last word in
 * the group, or an hour back when that is longer ago. A retry has the same
 * start, since its turn has not replied yet.
 */
function heldPicturesSince(db: Db, threadId: string): string {
  const since = new Date(Date.now() - HELD_PICTURE_WINDOW_MS).toISOString();
  const lastSaid = db.prepare(`
    SELECT created_at FROM channel_messages WHERE thread_id=? AND role='assistant' AND status<>'failed'
    ORDER BY created_at DESC LIMIT 1
  `).get(threadId) as { created_at: string } | undefined;
  return lastSaid && lastSaid.created_at > since ? lastSaid.created_at : since;
}

/**
 * The group's messages this turn reads with its own, newest first, whose text
 * carries `marker`: those held since `since`, and those folded into this very
 * message, whenever they came.
 */
function heldRows(db: Db, threadId: string, inbound: { id: string; handle?: string }, since: string, marker: string, limit: number) {
  return db.prepare(`
    SELECT id,content,json_extract(metadata_json,'$.mediaUrls') urls FROM channel_messages
    WHERE thread_id=? AND role='user' AND direction='inbound' AND id<>? AND instr(content,?)>0
      AND ((json_extract(metadata_json,'$.heldUntilNamed')=1 AND created_at>?)
        OR (? IS NOT NULL AND json_extract(metadata_json,'$.foldedInto')=?))
    ORDER BY created_at DESC,rowid DESC LIMIT ?
  `).all(threadId, inbound.id, marker, since, inbound.handle ?? null, inbound.handle ?? null, limit) as Array<{ id: string; content: string; urls: unknown }>;
}

/**
 * Pictures sent in a group while it asked the assistant to stay out, since
 * the assistant last spoke there and within the hour. They were filed
 * unviewed, and being named right after one is usually being asked about it.
 */
function heldPictures(db: Db, threadId: string, inbound: { id: string; handle?: string }, since: string, limit: number): UnviewedPictures[] {
  if (limit <= 0) return [];
  let budget = limit;
  return heldRows(db, threadId, inbound, since, PICTURE_PENDING, limit).flatMap(row => {
    const found = unviewedOn(row.id, row.content, row.urls, budget);
    budget -= found[0]?.urls.length ?? 0;
    return found;
  });
}

/**
 * Looks at the pictures this turn can see and has not yet: the ones on the
 * message being answered and, in a group, the ones held while the assistant
 * was told to stay out. Each archived row gets what was seen in place of its
 * pending line, so the window, the index, and a retry all read the
 * description, and the look is filed as a `view_image` tool row so the
 * history shows the vision call was made. With pictures off, held ones are
 * left pending for when they can be seen. Returns the answered message's
 * text, and whether a held message in play carries a description — its quoted
 * words are in the window, on the attempt that looked and on any retry.
 */
async function viewUnviewedPictures(
  db: Db,
  threadId: string,
  inbound: { id: string; handle?: string; body: string; mediaUrls: unknown },
  group: boolean,
  fetcher: typeof fetch | undefined,
  showMark: (() => Promise<void>) | undefined,
): Promise<{ body: string; describedEarlier: boolean; attachmentIds: string[] }> {
  const looking = imageInputMode() === "describe";
  const keeps = threadKeepsPictures(db, threadId);
  const since = group ? heldPicturesSince(db, threadId) : "";
  const own = unviewedOn(inbound.id, inbound.body, inbound.mediaUrls, PICTURES_PER_TURN);
  const held = group && looking ? heldPictures(db, threadId, inbound, since, PICTURES_PER_TURN - (own[0]?.urls.length ?? 0)) : [];
  const pending = [...own, ...held];
  let body = inbound.body;
  const seen: string[] = [];
  // The mark goes out beside the first look rather than ahead of it, and has
  // landed before the turn reads the archive for the marks already up.
  const marking = pending.length && looking ? showMark?.() : undefined;
  // Every picture of the turn shares one allowance of time, so a burst of
  // receipts cannot keep the worker from the next thread for long.
  const budget = AbortSignal.timeout(PICTURE_BUDGET_MS);
  for (const picture of pending) {
    // The copy kept when the picture arrived is what gets read, so a link that
    // has since expired costs nothing; a picture never kept comes from its link.
    const stored = new Map<string, ReturnType<typeof attachmentForLink>>();
    const looks = await describeMediaDetailed(picture.urls, fetcher, url => {
      const row = attachmentForLink(db, picture.id, url);
      const bytes = row && attachmentFileIntact(db, row) ? readAttachment(db, row) : undefined;
      if (row && bytes) stored.set(url, row);
      return row && bytes ? { type: row.content_type, bytes } : undefined;
    }, budget);
    // A link the arrival could not fetch, but this look could, is kept now.
    looks.forEach((look, index) => {
      const url = picture.urls[index];
      if (!look.fetched || stored.has(url) || !keeps || attachmentsFull(db, look.fetched.bytes.length)) return;
      try {
        const row = stageForMessage(db, picture.id, url, look.fetched);
        if (row) stored.set(url, row);
      } catch (error) {
        console.warn("Saving an attachment failed:", error instanceof Error ? error.message : error);
      }
    });
    const lines = looks.map(look => look.line);
    seen.push(...lines);
    const content = fillPendingPictures(picture.content, lines, picture.urlCount);
    db.transaction(() => {
      db.prepare("UPDATE channel_messages SET content=?,updated_at=? WHERE id=?").run(content, now(), picture.id);
      queueIndexJob(db, "channel_message", picture.id);
      // What each picture was found to be travels with its file.
      looks.forEach((look, index) => {
        const row = stored.get(picture.urls[index]);
        if (row && look.description) setAttachmentDescription(db, row.id, look.description, look.kind);
      });
    })();
    if (picture.id === inbound.id) body = content;
  }
  await marking;
  const describedEarlier = group
    && heldRows(db, threadId, inbound, since, "[Image", 1).some(row => hasImageDescription(row.content));
  if (pending.length && looking) {
    saveChannelMessage(db, threadId, "outbound", "tool", "view_image", undefined, {
      input: { pictures: seen.length },
      output: { success: !seen.some(line => line.includes("could not be viewed")), data: { descriptions: seen } },
      toolCallId: id("vision"),
      state: "output-available",
    });
  }
  return { body, describedEarlier, attachmentIds: turnAttachmentIds(db, threadId, inbound, group, since) };
}

/**
 * The saved pictures this turn answers: the ones on its own message and, in a
 * group, those held while the assistant was told to stay out. A memory the turn
 * saves carries them. Read from the archive rather than from what was just
 * looked at, so a retried turn links the same pictures its first attempt did.
 */
function turnAttachmentIds(
  db: Db,
  threadId: string,
  inbound: { id: string; handle?: string },
  group: boolean,
  since: string,
): string[] {
  const messageIds = [inbound.id];
  if (group) {
    // "[Picture attached" takes the pending line and the one a failed look leaves
    // ("it could not be viewed"), so a held picture is linked whether or not it was read.
    for (const marker of ["[Image", "[Picture attached"]) {
      messageIds.push(...heldRows(db, threadId, inbound, since, marker, PICTURES_PER_TURN).map(row => row.id));
    }
  }
  return [...new Set(messageIds)]
    .flatMap(messageId => attachmentsForMessage(db, messageId).map(row => row.id))
    .slice(0, PICTURES_PER_TURN * 3);
}

export function recordOutboundChannelMessage(
  db: Db,
  channel: "sms" | "web",
  address: string,
  content: string,
  providerMessageId?: string,
  status = "sent",
  metadata: Record<string, unknown> = {},
): { messageId: string; threadId: string } {
  const thread = getOrCreateThread(db, channel, address);
  const messageId = saveChannelMessage(
    db,
    thread.id,
    "outbound",
    "assistant",
    content,
    providerMessageId,
    metadata,
  );
  db.prepare("UPDATE channel_messages SET status=?,updated_at=? WHERE id=?")
    .run(status === "queued" ? "queued" : "sent", now(), messageId);
  return { messageId, threadId: thread.id };
}

function saveToolTrace(db: Db, threadId: string, part: AgentPart): void {
  const toolCallId = part.toolCallId || part.tool_call_id;
  if (!toolCallId || typeof part.type !== "string") return;
  const existing = db.prepare(`
    SELECT id FROM channel_messages
    WHERE thread_id=? AND role='tool' AND json_extract(metadata_json,'$.toolCallId')=?
  `).get(threadId, toolCallId);
  if (existing) return;
  saveChannelMessage(
    db,
    threadId,
    "outbound",
    "tool",
    part.type.slice(5),
    undefined,
    { input: part.input, output: part.output, toolCallId, state: part.state },
  );
}

/**
 * The search filters a group turn sends with its completion.
 *
 * The hosted `personal_data_search` tool runs inside Agent Studio with a fixed
 * `userId` filter. Its calls do come back in the completion, as
 * `algolia_search_index_<index>` parts already carrying their hits, but by
 * then the search has run, so nothing in the tool executor could stop a
 * question asked in a group from pulling the owner's other todos back. Agent
 * Studio accepts per-request overrides keyed by
 * index name, and a query-time `filters` outranks the one in the tool
 * configuration; it replaces rather than merges, so the user clause is repeated.
 * Todos and memories are fenced to the group's life area, messages to its thread.
 */
function groupSearchParameters(scope: GroupScope): Record<string, { filters: string }> {
  const indices = configuredIndexNames();
  const user = `userId:"${escapeFilterValue(USER_ID)}"`;
  const area = `${user} AND life_area_id:"${escapeFilterValue(scope.lifeAreaId)}"`;
  return {
    [indices.todo]: { filters: area },
    [indices.memory]: { filters: area },
    [indices.message]: { filters: `${user} AND threadId:"${escapeFilterValue(scope.threadId)}"` },
  };
}

/**
 * The same override for a turn fenced to the owner's own records: every group
 * chat's area and thread is excluded, and an unclassified record still matches.
 * Without a group there is nothing to leave out, so nothing is sent.
 */
function ownSearchParameters(db: Db): Record<string, { filters: string }> | undefined {
  const groups = groupAreas(db);
  if (!groups.length) return undefined;
  const indices = configuredIndexNames();
  const user = `userId:"${escapeFilterValue(USER_ID)}"`;
  const excluding = (attribute: string, values: string[]) =>
    [user, ...values.map(value => `NOT ${attribute}:"${escapeFilterValue(value)}"`)].join(" AND ");
  const areas = excluding("life_area_id", groups.map(group => group.id));
  return {
    [indices.todo]: { filters: areas },
    [indices.memory]: { filters: areas },
    [indices.message]: { filters: excluding("threadId", groups.map(group => group.thread_id)) },
  };
}

async function completion(
  conversationId: string,
  messages: AgentMessage[],
  fetcher: typeof fetch,
  searchParameters?: Record<string, { filters: string }>,
): Promise<AgentMessage> {
  const { appId, apiKey, agentId } = agentConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(
      `https://${appId}.algolia.net/agent-studio/1/agents/${encodeURIComponent(agentId)}/completions?stream=false&compatibilityMode=ai-sdk-5`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-algolia-application-id": appId,
          "x-algolia-api-key": apiKey,
        },
        body: JSON.stringify({
          id: conversationId,
          messages,
          ...(searchParameters ? { algolia: { searchParameters } } : {}),
        }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TransientFailure(
        `Agent Studio did not respond within ${COMPLETION_TIMEOUT_MS / 1000}s`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    // Throttling and a bad gateway are both invitations to try again later; a
    // 4xx means the turn we sent will fail the same way every time.
    if (response.status === 429 || response.status >= 500) {
      throw new TransientFailure(`Agent Studio is unavailable (${response.status}): ${detail}`);
    }
    throw new Error(`Agent Studio completion failed (${response.status}): ${detail}`);
  }
  return await response.json() as AgentMessage;
}

/**
 * What a group turn runs inside: the group's own life area, created on its
 * first message, and the fence the tools and the search filters apply. The name
 * iMessage gave the chat seeds the thread title only while there is none; once
 * the assistant or the owner has named the group, an iMessage rename does not
 * overwrite it.
 *
 * Two cues for the prompt are read off the thread rather than off this call or
 * the context window, so a retried or long-quiet turn gets them right:
 * `firstMessage` is true only while no one else has ever written in the thread,
 * and `areaIsNew` stays true until the assistant has taken a turn since the
 * area was created, so a first turn that failed in flight still names it.
 */
function groupTurnSetup(
  db: Db,
  threadId: string,
  inboundId: string,
  groupName: string | undefined,
): { area: ReturnType<typeof ensureGroupLifeArea>; areaIsNew: boolean; firstMessage: boolean; scope: GroupScope } {
  if (groupName) {
    db.prepare("UPDATE channel_threads SET display_name=? WHERE id=? AND display_name IS NULL").run(groupName, threadId);
  }
  // The thread's title, not the provider's name: an area recreated after the
  // owner deleted it starts from what the group was last called here.
  const thread = db.prepare("SELECT display_name FROM channel_threads WHERE id=?").get(threadId) as { display_name: string | null };
  const area = ensureGroupLifeArea(db, threadId, thread.display_name ?? groupName);
  const earlierMessage = db.prepare(
    "SELECT 1 found FROM channel_messages WHERE thread_id=? AND role='user' AND id<>? LIMIT 1",
  ).get(threadId, inboundId);
  // The app's own look at a picture is not the assistant taking a turn.
  const answeredSinceCreated = db.prepare(`
    SELECT 1 found FROM channel_messages
    WHERE thread_id=? AND role IN ('assistant','tool') AND created_at>=? AND NOT (role='tool' AND content='view_image') LIMIT 1
  `).get(threadId, area.createdAt);
  return {
    area,
    areaIsNew: !answeredSinceCreated,
    firstMessage: !earlierMessage,
    scope: { lifeAreaId: area.id, threadId },
  };
}

/**
 * Who is in the room and when the app writes to it on its own. Without the
 * roster the agent met each person fresh every day; without the schedule it
 * told a group asking for a daily good morning that it could not text on its
 * own, while a morning check-in was already set for 9.
 */
function groupRoomContext(db: Db, threadId: string, areaId: string): Record<string, string> {
  const roster = rosterLine(db, threadId);
  const times = db.prepare("SELECT morning_checkin_time,evening_checkin_time FROM life_areas WHERE id=?")
    .get(areaId) as { morning_checkin_time: string | null; evening_checkin_time: string | null } | undefined;
  const keepsPictures = threadKeepsPictures(db, threadId);
  const schedule = [
    times?.morning_checkin_time ? `morning note at ${times.morning_checkin_time}` : null,
    times?.evening_checkin_time ? `evening question at ${times.evening_checkin_time}` : null,
  ].filter(Boolean).join(", ");
  return {
    ...(roster ? { groupMembers: roster } : {}),
    groupCheckins: schedule || "none set; the owner can turn them on in the app",
    ...(keepsPictures ? {} : {
      groupPictures: "Pictures sent here are read but not kept: a memory holds only the text read off one, so never say a picture is attached or saved.",
    }),
  };
}

/**
 * What the provider said about the message that started a turn. `groupId` is
 * set when the text arrived in an iMessage group chat, which changes where the
 * answer and any reminders the turn creates are sent.
 */
export type InboundContext = {
  provider: SmsProvider;
  replyTo?: string;
  threadOriginator?: string;
  groupId?: string;
  /** Every number in the group conversation, as the provider listed it; the roster is kept from these. */
  participants?: string[];
};

/** What the runner says when the model finished a turn without any text to send. */
export const NO_TEXT_FALLBACK = "I completed that request, but did not receive a text response.";

/**
 * What a turn hands back: the text to send and the thread it ran on, plus the
 * rows it wrote so a caller that sends afterwards can pin the provider's id to
 * the right row, or mark the turn failed when the send does not go through.
 */
export type AgentTurnResult = {
  text: string;
  threadId: string;
  replyTo?: string;
  /** The row of the message being answered (the instruction, on an app-composed turn). */
  inboundMessageId?: string;
  /** The archived reply; absent when the turn ended without one (a gesture, or stay_quiet). */
  replyMessageId?: string;
  /** A GIF the reply picked with `GIF: <url>` on a turn that may attach one, sent with the text. */
  mediaUrl?: string;
};

export async function runChannelAgent(
  db: Db,
  search: SearchWriter,
  channel: "sms" | "web",
  address: string,
  body: string,
  providerMessageId?: string,
  options: {
    fetcher?: typeof fetch;
    userMessageMetadata?: Record<string, unknown>;
    /**
     * The turn was composed by the app rather than typed by the user, as with
     * the daily digest and reflection drafts. Both ends of it are kept out of
     * the conversation index so recall cannot quote an internal instruction
     * back as something the user said.
     */
    internal?: boolean;
    /**
     * The turn may attach a GIF: a scheduled message the owner asked to carry
     * one. The reply picks it with a final `GIF: <url>` line, which has to be a
     * link `find_gif` returned this turn; it is taken out of the words and
     * handed back as `mediaUrl` for the caller to send with them.
     */
    gif?: boolean;
    /**
     * What the provider said about the message that started this turn. An
     * app-composed turn has none, which is what stops the iMessage tools from
     * reacting to a message the user never sent.
     */
    inbound?: InboundContext;
    /** The sender a tool that texts mid-turn uses; the worker passes its own so a test can capture both. */
    sendSms?: SmsSender;
    /**
     * Filed on the reply row alongside its parts. A scheduled group check-in
     * marks its reply this way so the archive, the history page, and the
     * prompt's reply rules can tell it from an ordinary answer.
     */
    assistantMetadata?: Record<string, unknown>;
    /**
     * Whether the reply row is marked internal too. Defaults to `internal`,
     * right for a scratch thread whose real message is recorded elsewhere once
     * sent. A group check-in composes on the group's real thread, where the
     * reply *is* the message the room receives, so it passes false and the
     * reply stays public — in the window and in the index.
     */
    replyInternal?: boolean;
    /** What fetches the pictures and asks the vision model about them; the worker passes its own. */
    mediaFetch?: typeof fetch;
    /** A tighter round cap and time budget for background work, so a live reply never waits long behind it. */
    maxRounds?: number;
    turnBudgetMs?: number;
  } = {},
): Promise<AgentTurnResult> {
  const thread = getOrCreateThread(db, channel, address);
  const internalMark = options.internal ? { internal: true } : {};
  const threadMark = options.inbound?.replyTo
    ? {
      replyTo: options.inbound.replyTo,
      ...(options.inbound.threadOriginator ? { threadOriginator: options.inbound.threadOriginator } : {}),
    }
    : {};
  const inboundId = saveInboundMessage(db, thread.id, body, providerMessageId, {
    ...options.userMessageMetadata,
    ...internalMark,
    ...threadMark,
  });
  // A group turn names the room and the speaker so the agent knows it is in a
  // shared chat and whose request it is answering.
  const speaker = options.userMessageMetadata as {
    speaker?: string; speakerName?: string; speakerIsOwner?: boolean; groupName?: string;
  } | undefined;
  const group = options.inbound?.groupId ? groupTurnSetup(db, thread.id, inboundId, speaker?.groupName) : undefined;
  if (group) recordGroupParticipants(db, thread.id, group.area.id, options.inbound?.participants, speaker?.speaker);
  let describedEarlier = false;
  let attachmentIds: string[] = [];
  if (!options.internal && channel === "sms") {
    // The picture's own mark goes up while it is looked at, on a message that
    // is for the assistant and carries no tapback yet; the turn's marks then
    // replace it like any other progress mark.
    const handle = options.inbound?.provider === "sendblue" ? providerMessageId : undefined;
    const showMark = handle ? async () => {
      if (reactionsOn(db, thread.id, handle).all.length) return;
      if (group && !aimedAtAssistant(db, thread.id, inboundId, body, options.inbound, speaker?.speaker, providerMessageId)) return;
      try {
        await sendSendblueReaction(db, handle, VIEWING_MARK);
        recordMessageReaction(db, thread.id, handle, VIEWING_MARK, "runtime");
      } catch (error) {
        console.warn("Viewing tapback failed:", error instanceof Error ? error.message : error);
      }
    } : undefined;
    ({ body, describedEarlier, attachmentIds } = await viewUnviewedPictures(
      db, thread.id, { id: inboundId, handle: providerMessageId, body, mediaUrls: options.userMessageMetadata?.mediaUrls },
      Boolean(group), options.mediaFetch, showMark,
    ));
  }
  /*
   * A memory sweep of a group runs on a scratch thread, but what it keeps is
   * the group's: it carries the group's scope, so every write is filed under
   * the area and its hosted search is fenced there, and nothing of the owner's
   * rides along. The area is read from its own row, never taken on trust.
   */
  let sweepScope: GroupScope | undefined;
  if (options.internal && options.userMessageMetadata?.kind === "memory_sweep" && options.userMessageMetadata.lifeAreaId) {
    const area = db.prepare("SELECT thread_id FROM life_areas WHERE id=? AND user_id=? AND thread_id IS NOT NULL")
      .get(String(options.userMessageMetadata.lifeAreaId), USER_ID) as { thread_id: string } | undefined;
    if (!area) throw new Error("A group's memory sweep can only run for a group chat's own area");
    sweepScope = { lifeAreaId: String(options.userMessageMetadata.lifeAreaId), threadId: area.thread_id };
  }
  // Read after the pictures, so a folded picture's description is what the burst carries.
  const burst = group && !options.internal ? burstRows(db, thread.id, providerMessageId) : [];
  const inConversation = group && !options.internal ? assistantInConversation(db, thread.id, inboundId) : false;
  // The evening question still being answered, and the entry its answers go in.
  const eveningDate = group && !options.internal ? eveningBeingAnswered(db, thread.id) : undefined;
  const eveningTimezone = getNotificationPreferences(db).timezone;
  const eveningEntry = eveningDate && group ? eveningEntryFor(db, group.area.id, eveningDate, eveningTimezone) : undefined;
  /*
   * A burst can hold more than one person's words, and the owner's standing
   * belongs to the owner's words alone: a turn that also answers someone
   * else's folded request has none, or that person's "rename the chat" would
   * go through on the owner's "lol". With more than one voice there is no
   * single speaker for "who: speaker" to name, and moods are kept per person.
   */
  const ownerStanding = speaker?.speakerIsOwner === true && burst.every(row => row.isOwner);
  const burstVoices = new Set([...burst.map(row => row.phone ?? row.speaker), speaker?.speaker ?? ""]);
  const mixedBurst = burst.length > 0 && burstVoices.size > 1;
  const turnSpeakerName = group
    ? speaker?.speakerName ?? (speaker?.speaker ? redactedNumber(speaker.speaker) : undefined)
    : OWNER_SPEAKER_NAME;
  const burstSpeakerNames = mixedBurst
    ? [...new Set([...burst.map(row => row.speaker), turnSpeakerName].filter((name): name is string => Boolean(name)))]
    : undefined;
  const context: ToolTurnContext = {
    channel,
    address,
    threadId: thread.id,
    provider: options.inbound?.provider,
    groupId: options.inbound?.groupId,
    ...(group ? { scope: { ...group.scope, lifeAreaIsNew: group.areaIsNew }, speakerIsOwner: ownerStanding } : {}),
    ...(sweepScope ? { scope: { ...sweepScope, lifeAreaIsNew: false } } : {}),
    ...(group && !options.internal && speaker?.speaker && !mixedBurst ? { speakerPhone: speaker.speaker } : {}),
    ...(burstSpeakerNames ? { burstSpeakerNames } : {}),
    ...(eveningDate ? { eveningDate } : {}),
    // In a group the speaker is whoever wrote — by name, or by the redacted number the
    // transcript uses for someone the owner never named; on the owner's own line or the
    // web it is the owner. An app-composed turn has no speaker.
    ...(options.internal ? {} : { speakerName: turnSpeakerName }),
    inboundMessageHandle: options.internal ? undefined : providerMessageId,
    inboundText: options.internal ? undefined : body,
    ...(burst.length ? { burstTexts: burst.map(row => row.content) } : {}),
    ...(options.internal ? { internal: true } : {}),
    ...(attachmentIds.length ? { turnAttachmentIds: attachmentIds } : {}),
    // A picture's description quotes words the sender did not write, like a
    // page does, so the same refusals apply from the start of the turn.
    ...(!options.internal && (hasImageDescription(body) || describedEarlier) ? { readWeb: true, readUntrusted: true } : {}),
    sendSms: options.sendSms,
    ...(options.internal && typeof options.userMessageMetadata?.kind === "string" ? { appTurn: options.userMessageMetadata.kind } : {}),
  };
  search.flushSoon();
  const messages = threadHistory(db, thread.id);
  const preferences = getNotificationPreferences(db);
  // How to talk here, and what is known about the people here: the group's own
  // in a group, the owner's everywhere else. App-composed turns carry the voice
  // but not the facts; their instruction already says what to draw on.
  const voice = group ? groupVoice(db, group.area.id) : undefined;
  // Who the owner is travels with their own turns only; a group never reads it,
  // nor does anything written for a group: its check-in wording or its profile.
  const kind = options.userMessageMetadata?.kind;
  const writingForGroup = kind === "checkin_ask_draft" || kind === "group_profile_refresh" || Boolean(sweepScope);
  const soul = voice ? voice.soul : kind === "group_profile_refresh" || sweepScope ? null : ownerSoul(db);
  // A profile written from a fact that has since gone or changed may say what
  // is no longer true, so it is held back until the rewrite catches up.
  const profile = voice || writingForGroup ? null : servableOwnerProfile(db);
  const roomProfile = group ? servableGroupProfile(db, group.area.id) : null;
  const facts = options.internal ? [] : await relevantFacts(db, search, group ? { areaId: group.area.id } : { own: true }, body);
  /*
   * The turn context belongs on the message being answered. That is usually
   * the last one in the window, but a retry that was overtaken is answering an
   * earlier text, and stapling the owner's speakerIsOwner onto whatever a later
   * speaker said would lend that speaker the owner's standing. An inbound that
   * has aged out of the window altogether — a retry after a long outage — is
   * put back at the end, so the model reads the text it is answering.
   */
  let latestUserMessage = messages.find(message => message.id === historyMessageId(inboundId));
  if (!latestUserMessage) {
    const row = db.prepare("SELECT id,content,metadata_json FROM channel_messages WHERE id=?").get(inboundId) as UserRow;
    latestUserMessage = userMessage(db, thread.id, row);
    messages.push(latestUserMessage);
  }
  latestUserMessage.metadata = {
    turnContext: {
      localUserId: USER_ID,
      channel,
      timezone: preferences.timezone,
      currentDateTime: new Date().toISOString(),
      // The same moment as the user's wall clock with its offset: the shape
      // every date-time sent to a tool should take, so "5:30 PM" is written
      // as 17:30 with this offset rather than converted to UTC and then
      // given the offset as well.
      currentLocalDateTime: localIsoWithOffset(new Date(), preferences.timezone),
      // An app-composed turn says what it is, so the prompt's rules for it key
      // on a name rather than on the wording of the instruction.
      ...(options.internal && typeof options.userMessageMetadata?.kind === "string"
        ? { appTurn: options.userMessageMetadata.kind }
        : {}),
      ...(soul ? { soul } : {}),
      ...(profile ? { profile } : {}),
      ...(roomProfile ? { groupProfile: roomProfile } : {}),
      ...(facts.length ? { [group ? "groupFacts" : "ownerFacts"]: facts } : {}),
      ...(voice ? {
        replyMode: voice.replyMode,
        ...(voice.assistantNickname ? { assistantNickname: voice.assistantNickname } : {}),
      } : {}),
      ...(options.inbound?.groupId && group
        ? {
          groupId: options.inbound.groupId,
          groupLifeAreaId: group.area.id,
          groupLifeAreaName: group.area.name,
          ...(group.areaIsNew ? { groupLifeAreaIsNew: true } : {}),
          ...(group.firstMessage ? { firstMessageInGroup: true } : {}),
          // The speaker's number never reaches the model; a redacted form is
          // enough to tell two unnamed voices apart.
          ...(speaker?.speaker ? { speaker: redactedNumber(speaker.speaker) } : {}),
          ...(speaker?.speakerName ? { speakerName: speaker.speakerName } : {}),
          // Stated either way, so "not the owner" is a fact the model was
          // told rather than a field it did not see.
          // Across the burst: the owner's standing only when every message in it is the owner's.
          speakerIsOwner: ownerStanding,
          ...(burst.length
            ? { burst: burst.map(row => `[${row.speaker}] ${row.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") }
            : {}),
          ...(burstSpeakerNames ? { burstSpeakers: burstSpeakerNames.join(", ") } : {}),
          ...(inConversation ? { inConversation: true } : {}),
          ...(eveningDate ? {
            eveningDate,
            eveningEntry: eveningEntry
              ? `${eveningEntry.id}: tonight's shared entry; add this answer to it with update_memory`
              : `none yet: create tonight's entry with occurred_at ${eveningOccurredAt(eveningDate, eveningTimezone)}`,
          } : {}),
          ...groupRoomContext(db, thread.id, group.area.id),
        }
        : {}),
    },
  };
  // A retry resumes the turn rather than restarting it. `threadHistory()` has
  // already placed the earlier attempt's writes after the inbound row when that
  // row is inside the window; this covers the inbound that fell outside it.
  const inboundRowid = (db.prepare("SELECT rowid FROM channel_messages WHERE id=?")
    .get(inboundId) as { rowid: number }).rowid;
  // Bounded at the next text in the thread, as in the window: a turn that was
  // overtaken does not own the writes the texts behind it made.
  const nextInbound = db.prepare(`
    SELECT rowid FROM channel_messages WHERE thread_id=? AND role='user' AND rowid>? ORDER BY rowid LIMIT 1
  `).get(thread.id, inboundRowid) as { rowid: number } | undefined;
  const priorWrites = orphanedWrites(db, thread.id, inboundRowid, nextInbound?.rowid);
  const replayId = orphanedWritesMessageId(inboundId);
  if (priorWrites.length && !messages.some(message => message.id === replayId)) {
    messages.push({ id: replayId, role: "assistant", parts: priorWrites });
  }

  // Best effort at both ends: a runtime tapback that fails to land, or to
  // change, is not a reason to lose the answer. The archive is what says
  // whether a mark is up, so a retried attempt neither sends it twice nor takes
  // it down between attempts: the turn is still being worked, and the mark
  // stays until it ends.
  const markHandle = channel === "sms" && options.inbound?.provider === "sendblue"
    ? context.inboundMessageHandle
    : undefined;
  const alreadyOn = markHandle ? reactionsOn(db, thread.id, markHandle) : { all: [], runtime: [] };
  /**
   * The runtime's mark currently on the message, per the archive; `undefined`
   * when there is none. A closing receipt from an attempt whose reply then
   * failed to send counts: the retry's first mark replaces it on the device,
   * and the archive has to be told so.
   */
  let markShown: string | undefined = alreadyOn.runtime.find(reaction => RUNTIME_MARKS.has(reaction));
  /*
   * iMessage keeps one tapback per sender per message, so the mark does not sit
   * beside the agent's own reaction: it replaces it, and lifting it afterwards
   * leaves the message bare. A heart in the first round followed by a lookup in
   * the second ended with no tapback at all. Once the agent has reacted — this
   * attempt or, per the archive, an earlier one — the runtime places nothing.
   * The archive says who placed what, so an agent that chose 📅 for "dinner
   * Friday?" is not mistaken for a progress mark.
   */
  const agentReacted = (): boolean =>
    context.reacted || alreadyOn.all.some(reaction => !alreadyOn.runtime.includes(reaction));
  /**
   * Puts `reaction` up, or takes the current mark down when it is `undefined`.
   * Switching marks is one send: the new tapback replaces the old one on the
   * device, so only the archive has to be told the old entry is gone.
   */
  const applyMark = async (reaction: string | undefined): Promise<void> => {
    if (!markHandle || markShown === reaction) return;
    if (reaction && agentReacted()) return;
    try {
      if (reaction) {
        await sendSendblueReaction(db, markHandle, reaction);
        if (markShown) recordMessageReaction(db, thread.id, markHandle, `-${markShown}`, "runtime");
        recordMessageReaction(db, thread.id, markHandle, reaction, "runtime");
      } else if (markShown) {
        await sendSendblueReaction(db, markHandle, `-${markShown}`);
        recordMessageReaction(db, thread.id, markHandle, `-${markShown}`, "runtime");
      }
      markShown = reaction;
    } catch (error) {
      console.warn("Runtime tapback failed:", error instanceof Error ? error.message : error);
    }
  };
  // Mark changes go out one at a time and in order, so the working mark can be
  // sent without holding up the first completion and still land before
  // whatever replaces it. `applyMark` never rejects.
  let markQueue: Promise<void> = Promise.resolve();
  const setMark = (reaction: string | undefined): Promise<void> => {
    markQueue = markQueue.then(() => applyMark(reaction));
    return markQueue;
  };
  // What the turn has done so far, for the closing mark. A write an earlier
  // attempt landed counts: the retry that answers is confirming that write.
  let changedRecord = priorWrites.some(part => RECORD_WRITE_TOOLS.has(String(part.type).slice(5)));
  let changedStatus = priorWrites.some(part => part.type === "tool-set_todo_status");
  let savedMemory = priorWrites.some(part => MEMORY_WRITE_TOOLS.has(String(part.type).slice(5)));
  let changedSoul = priorWrites.some(part => SOUL_WRITE_TOOLS.has(String(part.type).slice(5)));
  // A reminder is backed by a write that left one, or by a read that showed one.
  let reminderBacked = priorWrites.some(part => {
    const tool = String(part.type).slice(5);
    return REMINDER_WRITE_TOOLS.has(tool)
      || todoWriteSetsReminder(tool, part.input, (part.output as { data?: unknown } | undefined)?.data);
  });
  // A time moved is backed by a write that moved one.
  let movedDue = priorWrites.some(part =>
    writeChangesDue(String(part.type).slice(5), part.input, (part.output as { data?: unknown } | undefined)?.data));
  // Each kind of unbacked claim is sent back once per turn, so a model that insists cannot loop the turn out of its budget.
  const checkedClaims = new Set<string>();
  let lookedUp = false;
  const closingMark = (): string | undefined => {
    if (changedSoul) return CLOSING_REACTIONS.soul;
    if (savedMemory) return CLOSING_REACTIONS.memory;
    if (changedRecord) return CLOSING_REACTIONS.changed;
    if (lookedUp) return CLOSING_REACTIONS.answered;
    return undefined;
  };

  /*
   * A group's profile is written on a scratch thread with no scope of its own,
   * so its hosted search is fenced to that group the way a group turn's is.
   * The chat is read from the area's own row, not taken from the caller, and
   * without one the turn does not run: an unfenced search would reach the
   * owner's records and every other group's.
   */
  let writingGroupProfile: GroupScope | undefined;
  if (kind === "group_profile_refresh") {
    const areaId = typeof options.userMessageMetadata?.lifeAreaId === "string" ? options.userMessageMetadata.lifeAreaId : "";
    const area = db.prepare("SELECT thread_id FROM life_areas WHERE id=? AND user_id=? AND thread_id IS NOT NULL")
      .get(areaId, USER_ID) as { thread_id: string } | undefined;
    if (!options.internal || !area) throw new Error("A group's profile can only be written for a group chat's own area");
    writingGroupProfile = { lifeAreaId: areaId, threadId: area.thread_id };
  }
  const searchParameters = context.scope
    ? groupSearchParameters(context.scope)
    : writingGroupProfile ? groupSearchParameters(writingGroupProfile)
      : ownRecordsOnly(context) ? ownSearchParameters(db) : undefined;
  // A retry that already shows a mark keeps it; the working mark never
  // replaces a more specific one.
  // Whether this message was for the assistant: a group message that was not
  // may be answered by a kept fact's 🧠 alone; one that was needs words.
  const forAssistant = !group || Boolean(options.internal)
    || aimedAtAssistant(db, thread.id, inboundId, body, options.inbound, speaker?.speaker, providerMessageId);
  if (group && !options.internal && !markShown && markHandle && forAssistant) {
    void setMark(WORKING_MARK);
  }
  /*
   * On the owner's own turn nothing is fenced, so a search or a conversation
   * read can hand back what someone in a group wrote. That text could be
   * asking to change how the assistant talks to the owner, so once a result
   * carries a group's area or thread, the owner's Soul is off limits for the
   * rest of the turn. Which groups it came from is kept too: text from one
   * group can then post only into that group, never steer a post into another.
   */
  const groupThreadOf = new Map(context.scope ? [] : groupAreas(db).flatMap(area => [
    [area.id, area.thread_id] as const, [area.thread_id, area.thread_id] as const,
  ]));
  const noteGroupContent = (turn: ToolTurnContext, output: unknown, toolName?: string) => {
    if (!groupThreadOf.size || output === undefined) return;
    const serialized = JSON.stringify(output) ?? "";
    const threads = [...groupThreadOf].filter(([marker]) => serialized.includes(marker)).map(([, threadId]) => threadId);
    if (!threads.length) return;
    turn.readUntrusted = true;
    // The directory names every group and quotes nobody in any of them.
    if (toolName === "list_group_chats") return;
    turn.groupThreadsRead = new Set([...turn.groupThreadsRead ?? [], ...threads]);
  };
  const budgetMs = options.turnBudgetMs ?? TURN_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let refusedRounds = 0;
  try {
    for (let iteration = 0; iteration < (options.maxRounds ?? MAX_TOOL_ITERATIONS); iteration += 1) {
      if (Date.now() >= deadline) {
        throw new Error(`Agent exceeded its time budget of ${budgetMs / 60_000} minutes`);
      }
      const response = await completion(thread.agent_conversation_id, messages, options.fetcher || fetch, searchParameters);
      response.id ||= `alg_msg_${crypto.randomUUID().replaceAll("-", "")}`;
      /*
       * Agent Studio checks a tool call's input against the tool's schema before
       * it reaches us, and a call it refuses comes back as `output-error` with
       * the reason and no output, never as an `input-available` part. It was
       * invisible here: a mood score of 0 failed that way, the turn had no tool
       * to run and no text, and "I completed that request, but did not receive a
       * text response" went into the group. It is a failed tool result like any
       * other, so the model is shown the reason and gets another round.
       */
      let rejectedCalls = 0;
      for (const part of response.parts) {
        if (typeof part.type !== "string" || !part.type.startsWith("tool-") || part.state !== "output-error") continue;
        const rejected = part as AgentPart & { raw_input?: unknown; rawInput?: unknown; error_text?: unknown; errorText?: unknown };
        part.input ??= (rejected.raw_input ?? rejected.rawInput ?? {}) as Record<string, unknown>;
        const reason = rejected.error_text ?? rejected.errorText;
        part.output = { success: false, error: typeof reason === "string" && reason ? `The call was refused: ${reason}` : "The call was refused" };
        part.state = "output-available";
        delete rejected.raw_input; delete rejected.rawInput; delete rejected.error_text; delete rejected.errorText;
        rejectedCalls += 1;
      }
      for (const part of response.parts.filter(part =>
        typeof part.type === "string"
        && part.type.startsWith("tool-")
        && part.state === "output-available"
        && part.output !== undefined
      )) {
        saveToolTrace(db, thread.id, part);
        // Hosted search hits arrive already answered, so this is where one from a group is seen.
        // The continued message also hands back every client tool answered in an earlier round,
        // under its own name, so the group directory is still not a read of every group.
        noteGroupContent(context, part.output, String(part.type).slice(5));
      }
      const toolParts = response.parts.filter(part =>
        typeof part.type === "string"
        && part.type.startsWith("tool-")
        && part.state === "input-available"
        && (part.toolCallId || part.tool_call_id),
      );
      if (!toolParts.length) {
        // The only thing this round produced was refused calls: show the model why and let it fix them, a couple of times at most.
        if (rejectedCalls && refusedRounds < MAX_REFUSED_ROUNDS && !response.parts.some(part => part.type === "text" && typeof part.text === "string" && part.text.trim())) {
          refusedRounds += 1;
          appendResponse(messages, response);
          continue;
        }
        const written = response.parts
          .filter(part => part.type === "text" && typeof part.text === "string")
          .map(part => part.text)
          .join("\n")
          .trim();
        /*
         * In a group, staying quiet is final. A model that called stay_quiet and
         * then chatted anyway ("We hit collective idle mode") was the room's
         * top complaint, so the text is dropped — unless a record changed
         * after the call, which the room has to be told about.
         */
        const spokenOrQuiet = context.scope && context.stayedQuiet && !changedRecord ? "" : written;
        // The GIF line is not words: it comes out before the claims are read and the text is archived.
        const picked = options.gif ? pullGifLine(spokenOrQuiet, context.foundGifs) : { text: spokenOrQuiet };
        const kept = picked.text;
        // Checked before a repeat is dropped: "checked it off" said twice is still a claim to back.
        // App-composed turns are told to save nothing and promise nothing, so only a status claim is held there.
        const unbacked = [
          { name: "status", claimed: () => STATUS_CLAIM.test(kept.slice(0, MAX_CLAIM_SCAN)), backed: changedStatus, check: STATUS_CLAIM_CHECK },
          // A memory write backs a save; a todo write backs it only for a reply that is about a todo or a list.
          { name: "save", claimed: () => claimsSave(kept), backed: savedMemory || (changedRecord && mentionsTodo(kept)) || Boolean(options.internal), check: SAVE_CLAIM_CHECK },
          { name: "reminder", claimed: () => claimsReminder(kept), backed: reminderBacked || Boolean(options.internal), check: REMINDER_CLAIM_CHECK },
          { name: "due", claimed: () => claimsDueChange(kept), backed: movedDue || Boolean(options.internal), check: DUE_CLAIM_CHECK },
        ].find(claim => !claim.backed && !checkedClaims.has(claim.name) && claim.claimed());
        // Near the end of the budget there is no round left to answer a check in: the reply goes as written.
        const roomForCheck = iteration < (options.maxRounds ?? MAX_TOOL_ITERATIONS) - 2 && Date.now() < deadline - CLAIM_CHECK_MARGIN_MS;
        if (unbacked && roomForCheck) {
          checkedClaims.add(unbacked.name);
          appendResponse(messages, response);
          messages.push({
            id: `alg_msg_${crypto.randomUUID().replaceAll("-", "")}`,
            role: "user",
            parts: [{ type: "text", text: unbacked.check }],
          });
          continue;
        }
        // A closing line that only repeats what already went out — the model
        // restating the caption it sent with a GIF — would text it twice.
        const said = new Set((context.sentWords ?? []).map(sameWords));
        const text = said.has(sameWords(kept)) ? "" : kept;
        // The answer is in. The progress mark gives way to the closing one, or
        // comes down when there is nothing to confirm; the agent's own reaction,
        // if it made one, is left exactly where it is. A turn that decided the
        // message was not for it leaves no receipt at all, whatever it read on
        // the way to deciding — unless it wrote something after all, which the
        // mark is then the only word of.
        const quiet = context.stayedQuiet && !text && !changedRecord;
        await setMark(quiet ? undefined : closingMark());
        /*
         * A tapback with nothing after it is a complete answer to "thanks" or
         * "ok", the way it is between people. The reaction is already filed on
         * the message it landed on and as a tool row, so no assistant bubble is
         * written: an empty one would read as a turn that said nothing, and a
         * filler sentence would undo the gesture. The same holds when the turn
         * already said its piece through send_message, and when it judged the
         * message was the group talking among themselves and said so with
         * stay_quiet. Without any of those, silence is a model that forgot to
         * answer, and the fallback says so.
         */
        // A fact kept on a message that was not for the assistant is answered by
        // its 🧠 alone; words would interrupt the people talking.
        const keptFactQuietly = savedMemory && group && !forAssistant && Boolean(markHandle);
        if (!text && (context.reacted || context.sentText || context.stayedQuiet || context.adjustedVoice || keptFactQuietly)) {
          search.flushSoon();
          return { text: "", threadId: thread.id, replyTo: context.replyToMessageHandle, inboundMessageId: inboundId };
        }
        // A text message shows markdown as typed, so what is archived is what the phone shows.
        const spoken = channel === "sms" ? plainText(text) : text;
        /*
         * The fallback is for a person who would otherwise hear nothing back from
         * a message to the assistant. In a group it only ever read as noise ("I
         * completed that request…" after a journal save), and an app-composed
         * turn would send it as the check-in itself, so a group turn with
         * nothing to say says nothing; the closing tapback is already on the message.
         */
        if (!spoken && group) {
          search.flushSoon();
          return { text: "", threadId: thread.id, replyTo: context.replyToMessageHandle, inboundMessageId: inboundId };
        }
        const finalText = spoken || NO_TEXT_FALLBACK;
        // The reply is marked internal with the instruction on a scratch thread,
        // where the real message is recorded elsewhere once sent; on a real
        // thread the caller keeps it public, since it is the message.
        const replyMark = (options.replyInternal ?? options.internal) ? { internal: true } : {};
        // A GIF rides with words only, and only one the provider can still fetch.
        const mediaUrl = spoken && picked.url && await sendableGif(picked.url) ? picked.url : undefined;
        const replyMessageId = saveChannelMessage(db, thread.id, "outbound", "assistant", finalText, undefined, {
          ...options.assistantMetadata,
          ...(mediaUrl ? { mediaUrl } : {}),
          parts: response.parts,
          agentConversationId: thread.agent_conversation_id,
          ...replyMark,
        });
        search.flushSoon();
        return {
          text: finalText, threadId: thread.id, replyTo: context.replyToMessageHandle, inboundMessageId: inboundId, replyMessageId,
          ...(mediaUrl ? { mediaUrl } : {}),
        };
      }

      // Real work is about to start, and the mark says on what. A batch that
      // already carries the agent's own tapback needs no placeholder in front
      // of it; a gestures-only batch resolves to no mark and changes nothing.
      const toolNames = toolParts.map(part => String(part.type).slice(5));
      const mark = progressReactionFor(toolNames);
      if (mark && !toolNames.includes("react_to_message")) {
        await setMark(mark);
      }
      for (const part of toolParts) {
        const toolName = String(part.type).slice(5);
        // The agent's tapback is the one that stays; the placeholder comes off first.
        if (toolName === "react_to_message") await setMark(undefined);
        if (!GESTURE_TOOLS.has(toolName)) lookedUp = true;
        try {
          const data = await executeAgentTool(db, search, toolName, part.input || {}, context);
          noteGroupContent(context, data, toolName);
          // An undefined payload disappears from the serialized body, leaving a
          // bare `{"success":true}` that reads as a truncated result rather than
          // a confirmation. An explicit null says the write landed and returned
          // nothing to show for it.
          part.output = { success: true, data: data ?? null };
          // Only a write that landed earns the ✅; a refused delete confirms nothing.
          if (RECORD_WRITE_TOOLS.has(toolName)) {
            changedRecord = true;
            context.changedRecord = true;
          }
          if (toolName === "set_todo_status") changedStatus = true;
          if (REMINDER_WRITE_TOOLS.has(toolName) || readShowsReminder(toolName, data)
            || todoWriteSetsReminder(toolName, part.input, data)) reminderBacked = true;
          if (writeChangesDue(toolName, part.input, data)) movedDue = true;
          if (MEMORY_WRITE_TOOLS.has(toolName)) savedMemory = true;
          if (SOUL_WRITE_TOOLS.has(toolName)) changedSoul = true;
        } catch (error) {
          part.output = { success: false, error: error instanceof Error ? error.message : "Tool failed" };
        }
        part.state = "output-available";
        saveToolTrace(db, thread.id, part);
      }
      appendResponse(messages, response);
    }
    throw new Error("Agent exceeded the maximum tool-call iterations");
  } catch (error) {
    /*
     * The progress mark is deliberately left up. Every failed inbound turn is
     * retried behind a short backoff, so the search really is still running as
     * far as the user is concerned, and lifting and replacing it on every
     * attempt is the flicker that made a two-minute turn look like six
     * tapbacks. The attempt that finally answers takes it down.
     */
    /*
     * An app-composed turn is written again from scratch on the next attempt, so
     * the abandoned copy leaves the recent window rather than being read twice.
     * A text the user actually sent stays: nothing recomposes it, and it belongs
     * to the conversation whether or not we managed to answer it.
     */
    if (options.internal) {
      db.prepare("UPDATE channel_messages SET status='failed',updated_at=? WHERE id=?")
        .run(now(), inboundId);
    }
    // A working mark still in flight lands before the failure is reported, so
    // the archive shows it and a give-up can take it down.
    await markQueue;
    throw error;
  }
}

/*
 * Agent Studio does not answer a trailing assistant message with a new
 * one; it continues it, handing back the same id with the accumulated
 * parts. Pushed as a second message, the two copies shared an id and the
 * next completion was refused with `Messages must have unique ids`, so
 * every turn that needed two tool rounds failed on its first attempt and
 * was rescued, slowly, by the retry. The continuation replaces what it
 * continued.
 */
function appendResponse(messages: AgentMessage[], response: AgentMessage): void {
  const trailing = messages[messages.length - 1];
  if (trailing?.role === "assistant" && trailing.id === response.id) {
    messages[messages.length - 1] = response;
  } else {
    messages.push(response);
  }
}

export async function runSmsAgent(
  db: Db,
  search: SearchWriter,
  fromPhone: string,
  body: string,
  providerMessageId?: string,
  options: {
    fetcher?: typeof fetch;
    internal?: boolean;
    gif?: boolean;
    userMessageMetadata?: Record<string, unknown>;
    inbound?: InboundContext;
    sendSms?: SmsSender;
    assistantMetadata?: Record<string, unknown>;
    replyInternal?: boolean;
    mediaFetch?: typeof fetch;
    maxRounds?: number;
    turnBudgetMs?: number;
  } = {},
): Promise<AgentTurnResult> {
  return runChannelAgent(db, search, "sms", fromPhone, body, providerMessageId, options);
}

/**
 * `replyTo` is the handle the message actually threaded under, which the sender
 * reports back rather than the caller assuming. The agent can ask to thread and
 * have Sendblue refuse, and a reply the archive draws under a parent it never
 * reached is a lie the reader has no way to catch.
 */
export function recordOutboundProviderMessage(
  db: Db,
  threadId: string,
  providerMessageId: string,
  status: string,
  replyTo?: string,
  /** The row to pin to; without it, the latest outbound row on the thread. */
  messageId?: string,
): void {
  db.prepare(`
    UPDATE channel_messages SET provider_message_id=?,status=?,updated_at=?,
      metadata_json=CASE WHEN ? IS NULL THEN metadata_json
        ELSE json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.replyTo',?) END
    WHERE id=COALESCE(?,(SELECT id FROM channel_messages WHERE thread_id=? AND direction='outbound'
      ORDER BY created_at DESC LIMIT 1))
  `).run(
    providerMessageId,
    status === "queued" ? "queued" : "sent",
    now(),
    replyTo ?? null,
    replyTo ?? null,
    messageId ?? null,
    threadId,
  );
}

/**
 * Takes an app-composed turn out of the conversation after its send failed:
 * the instruction and the reply it produced are both marked failed, so the
 * window skips them, the archive does not show a message nobody received, and
 * the retry composes fresh instead of reading its own undelivered note. The
 * rows stay for the record; `queueIndexJob` drops the reply from the index.
 */
export function failAgentTurn(db: Db, turn: Pick<AgentTurnResult, "inboundMessageId" | "replyMessageId">): void {
  const ids = [turn.inboundMessageId, turn.replyMessageId].filter((value): value is string => Boolean(value));
  if (!ids.length) return;
  db.prepare(`UPDATE channel_messages SET status='failed',updated_at=? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .run(now(), ...ids);
  if (turn.replyMessageId) queueIndexJob(db, "channel_message", turn.replyMessageId, "delete");
}
