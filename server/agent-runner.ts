import type { AlgoliaSync } from "./algolia.ts";
import { id, now, queueIndexJob, recordMessageReaction, USER_ID } from "./db.ts";
import { getNotificationPreferences, type SmsProvider } from "./integrations.ts";
import type { SmsSender } from "./messaging.ts";
import { sendSendblueReaction } from "./sendblue-service.ts";
import { executeAgentTool, type ToolTurnContext } from "./tool-executor.ts";
import { TransientFailure } from "./transient.ts";
import type { Db } from "./types.ts";

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

function newConversationId(): string {
  return `alg_cnv_${crypto.randomUUID().replaceAll("-", "")}`;
}

type SearchWriter = Pick<AlgoliaSync, "flushSoon">;
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
    turnContext?: Record<string, string>;
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
  // second.
  "react_to_message",
]);

/**
 * Tools that act on the conversation itself rather than look something up or
 * change a record. None of them is "working on it": a tapback and a threaded
 * reply are the answer's own gestures, and the product cards are messages.
 */
const GESTURE_TOOLS = new Set(["react_to_message", "reply_in_thread", "send_product_cards"]);

/**
 * The tapback that sits on the user's message while the turn is looking things
 * up. The typing bubble says someone is there; this says what they are doing,
 * which on a turn of two or three tool rounds is the difference between a pause
 * and a stall. It is placed by the runtime rather than the model so it costs no
 * completion, arrives the moment the first tool call comes back, and is always
 * taken off again — either before the reply, or before the agent's own tapback
 * so that one stands alone.
 */
const PROGRESS_REACTION = "🔍";

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
  return [...writes, { type: "text", text: content }];
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
      return (JSON.parse(metadataJson) as { replyTo?: string }).replyTo;
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
function threadHistory(db: Db, threadId: string): AgentMessage[] {
  const cutoff = new Date(Date.now() - CONTEXT_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT id,role,content,metadata_json FROM (
      SELECT id,role,content,metadata_json,created_at,rowid FROM channel_messages
      WHERE thread_id=? AND role IN ('user','assistant') AND created_at>=?
        AND status<>'failed'
      ORDER BY created_at DESC,rowid DESC LIMIT 40
    ) ORDER BY created_at,rowid
  `).all(threadId, cutoff) as Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    metadata_json: string;
  }>;
  return rows.map(row => {
    const quote = row.role === "user" ? quotedParent(db, threadId, row.metadata_json) : null;
    return {
      id: row.id.startsWith("alg_msg_") ? row.id : `alg_msg_${row.id.replaceAll("-", "_")}`,
      role: row.role,
      parts: row.role === "assistant"
        ? assistantParts(row.content, row.metadata_json)
        // The quote is assembled here rather than stored, so the row and its
        // Algolia projection keep the text the user actually sent.
        : [{ type: "text", text: quote ? `[replying to "${quote}"] ${row.content}` : row.content }],
    };
  });
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
      return existing.id;
    }
  }
  return saveChannelMessage(db, threadId, "inbound", "user", body, providerMessageId, metadata);
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

async function completion(
  conversationId: string,
  messages: AgentMessage[],
  fetcher: typeof fetch,
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
        body: JSON.stringify({ id: conversationId, messages }),
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
     * What the provider said about the message that started this turn. An
     * app-composed turn has none, which is what stops the iMessage tools from
     * reacting to a message the user never sent.
     */
    inbound?: { provider: SmsProvider; replyTo?: string; threadOriginator?: string };
    /** The sender a tool that texts mid-turn uses; the worker passes its own so a test can capture both. */
    sendSms?: SmsSender;
  } = {},
): Promise<{ text: string; threadId: string; replyTo?: string }> {
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
  const context: ToolTurnContext = {
    channel,
    address,
    threadId: thread.id,
    provider: options.inbound?.provider,
    inboundMessageHandle: options.internal ? undefined : providerMessageId,
    sendSms: options.sendSms,
  };
  search.flushSoon();
  const messages = threadHistory(db, thread.id);
  const preferences = getNotificationPreferences(db);
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user");
  if (latestUserMessage) {
    latestUserMessage.metadata = {
      turnContext: {
        localUserId: USER_ID,
        channel,
        timezone: preferences.timezone,
        currentDateTime: new Date().toISOString(),
      },
    };
  }

  // Best effort at both ends: a progress tapback that fails to land, or to lift,
  // is not a reason to lose the answer.
  const progressHandle = channel === "sms" && options.inbound?.provider === "sendblue"
    ? context.inboundMessageHandle
    : undefined;
  let progressShown = false;
  const setProgress = async (on: boolean): Promise<void> => {
    if (!progressHandle || progressShown === on) return;
    const reaction = on ? PROGRESS_REACTION : `-${PROGRESS_REACTION}`;
    try {
      await sendSendblueReaction(db, progressHandle, reaction);
      recordMessageReaction(db, thread.id, progressHandle, reaction);
      progressShown = on;
    } catch (error) {
      console.warn("Progress tapback failed:", error instanceof Error ? error.message : error);
    }
  };

  try {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const response = await completion(thread.agent_conversation_id, messages, options.fetcher || fetch);
      response.id ||= `alg_msg_${crypto.randomUUID().replaceAll("-", "")}`;
      for (const part of response.parts.filter(part =>
        typeof part.type === "string"
        && part.type.startsWith("tool-")
        && part.state === "output-available"
        && part.output !== undefined
      )) {
        saveToolTrace(db, thread.id, part);
      }
      const toolParts = response.parts.filter(part =>
        typeof part.type === "string"
        && part.type.startsWith("tool-")
        && part.state === "input-available"
        && (part.toolCallId || part.tool_call_id),
      );
      if (!toolParts.length) {
        await setProgress(false);
        const text = response.parts
          .filter(part => part.type === "text" && typeof part.text === "string")
          .map(part => part.text)
          .join("\n")
          .trim();
        /*
         * A tapback with nothing after it is a complete answer to "thanks" or
         * "ok", the way it is between people. The reaction is already filed on
         * the message it landed on and as a tool row, so no assistant bubble is
         * written: an empty one would read as a turn that said nothing, and a
         * filler sentence would undo the gesture. Without a reaction, silence is
         * a model that forgot to answer, and the fallback says so.
         */
        if (!text && context.reacted) {
          search.flushSoon();
          return { text: "", threadId: thread.id, replyTo: context.replyToMessageHandle };
        }
        const finalText = text || "I completed that request, but did not receive a text response.";
        saveChannelMessage(db, thread.id, "outbound", "assistant", finalText, undefined, {
          parts: response.parts,
          agentConversationId: thread.agent_conversation_id,
          ...internalMark,
        });
        search.flushSoon();
        return { text: finalText, threadId: thread.id, replyTo: context.replyToMessageHandle };
      }

      // Real work is about to start. A batch that already carries the agent's
      // own tapback needs no placeholder in front of it.
      const toolNames = toolParts.map(part => String(part.type).slice(5));
      if (toolNames.some(name => !GESTURE_TOOLS.has(name)) && !toolNames.includes("react_to_message")) {
        await setProgress(true);
      }
      for (const part of toolParts) {
        const toolName = String(part.type).slice(5);
        // The agent's tapback is the one that stays; the placeholder comes off first.
        if (toolName === "react_to_message") await setProgress(false);
        try {
          const data = await executeAgentTool(db, search, toolName, part.input || {}, context);
          // An undefined payload disappears from the serialized body, leaving a
          // bare `{"success":true}` that reads as a truncated result rather than
          // a confirmation. An explicit null says the write landed and returned
          // nothing to show for it.
          part.output = { success: true, data: data ?? null };
        } catch (error) {
          part.output = { success: false, error: error instanceof Error ? error.message : "Tool failed" };
        }
        part.state = "output-available";
        saveToolTrace(db, thread.id, part);
      }
      messages.push(response);
    }
    throw new Error("Agent exceeded the maximum tool-call iterations");
  } catch (error) {
    // A 🔍 left on a message nobody answered reads as a search still running.
    await setProgress(false);
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
    throw error;
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
    userMessageMetadata?: Record<string, unknown>;
    inbound?: { provider: SmsProvider; replyTo?: string; threadOriginator?: string };
    sendSms?: SmsSender;
  } = {},
): Promise<{ text: string; threadId: string; replyTo?: string }> {
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
): void {
  db.prepare(`
    UPDATE channel_messages SET provider_message_id=?,status=?,updated_at=?,
      metadata_json=CASE WHEN ? IS NULL THEN metadata_json
        ELSE json_set(COALESCE(NULLIF(metadata_json,''),'{}'),'$.replyTo',?) END
    WHERE id=(SELECT id FROM channel_messages WHERE thread_id=? AND direction='outbound'
      ORDER BY created_at DESC LIMIT 1)
  `).run(
    providerMessageId,
    status === "queued" ? "queued" : "sent",
    now(),
    replyTo ?? null,
    replyTo ?? null,
    threadId,
  );
}
