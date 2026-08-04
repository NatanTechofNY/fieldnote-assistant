import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ChatHandle, type Tools, Chat, ChatOverlayLayout, InstantSearch, useInstantSearch,
} from "react-instantsearch";
import { BellRing, Bot, Brain, Clock3, ListTodo, MessagesSquare, Search, Sparkles, X } from "lucide-react";
import { liteClient as createSearchClient } from "algoliasearch/lite";
import { api } from "../../api";
import type {
  MemoryKind, Todo, TodoStatus,
} from "../../types";
import { moodEmoji } from "../../lib/mood";
import { createToolActivityLayout, toolActivityMeta } from "./tool-activity";
import { resolveAgentConversationId, touchAgentConversation } from "./conversation-id";
import { friendlyDate, friendlyDueDate, useTimezone } from "../../lib/timezone";
import { statusMeta } from "../../lib/todo-meta";
import { invalidateTaxonomy } from "../../lib/invalidate";
import { useAgentPanel } from "../../lib/agent-panel";
import { serializeAttachments } from "../../lib/agent-attachments";
import { AgentExpandButton } from "./AgentExpandButton";
import { AttachmentChips } from "./AttachmentChips";

type AgentSearchRecord = {
  objectID: string;
  title?: string | null;
  notes?: string | null;
  content?: string | null;
  kind?: MemoryKind;
  status?: TodoStatus;
  priority?: Todo["priority"];
  category_name?: string | null;
  due_at?: string | null;
  reminder_at?: string | null;
  mood_label?: string | null;
  mood_score?: number | null;
  tags?: string[];
};

function AgentSearchResultCard({ item }: { item: AgentSearchRecord }) {
  const timezone = useTimezone();
  const isMemory = Boolean(item.kind);
  const title = item.title || (isMemory ? "Saved memory" : "Untitled task");
  const detail = item.content || item.notes;
  return <article className={`agent-result-card ${isMemory ? "memory" : "todo"}`}>
    <div className="agent-result-top">
      <span className="agent-result-icon">{isMemory ? <Brain size={13}/> : <ListTodo size={13}/>}</span>
      <span className="agent-result-type">{isMemory ? item.kind : "task"}</span>
      <span className="agent-result-source"><Sparkles size={10}/>Algolia</span>
      {item.status && <span className={`agent-result-status status-${item.status}`}>{statusMeta[item.status]?.label || item.status}</span>}
    </div>
    <h4>{title}</h4>
    {detail && <p>{detail}</p>}
    <div className="agent-result-meta">
      {item.category_name && <span>{item.category_name}</span>}
      {item.due_at && <span><Clock3 size={11}/>Due {friendlyDueDate(item.due_at, timezone)}</span>}
      {item.reminder_at && <span><BellRing size={11}/>{friendlyDate(item.reminder_at, timezone)}</span>}
      {item.priority && <span>Priority: {item.priority}</span>}
      {item.mood_label && <span>{item.mood_score ? moodEmoji(item.mood_score) : "·"} {item.mood_label}</span>}
      {item.tags?.slice(0, 3).map(tag => <span key={tag}>#{tag}</span>)}
    </div>
  </article>;
}

function AgentChatEmpty() {
  return <div className="agent-chat-empty">
    <div className="agent-chat-mark"><Bot size={17}/></div>
    <h3>What should we work through?</h3>
    <p>Ask about your tasks, recall a memory, capture a journal entry, or plan what comes next.</p>
    <div className="agent-capabilities">
      <span><Search size={13}/>Semantic recall</span>
      <span><ListTodo size={13}/>Task actions</span>
      <span><Brain size={13}/>Durable memory</span>
    </div>
  </div>;
}

function AgentPromptFooter() {
  return <div className="agent-prompt-note"><span className="dot ok"/>Grounded in your Algolia indices and local SQLite data.</div>;
}

/**
 * The chat floats over the page in the corner rather than reserving a column in
 * it: reflowing the shell left the page a strip too narrow to read at any window
 * width between a phone and a desktop.
 *
 * The widget keeps its own maximized flag, but the app's copy of it is the one
 * the header button writes to, so the layout is told which to believe.
 */
const PanelLayout = (props: Parameters<typeof ChatOverlayLayout>[0]) => {
  const { isExpanded } = useAgentPanel();
  return <ChatOverlayLayout {...props} maximized={isExpanded} />;
};

/**
 * Pushes the app's panel state into the widget, which owns its own open flag and
 * input value.
 *
 * This lives inside `InstantSearch` on purpose: `InstantSearch` mounts its
 * children in a second pass, so an effect in the parent runs while the chat
 * handle is still null — which is exactly the commit where the panel is first
 * opened. From here the handle is already attached.
 */
function ChatSync({ handle }: { handle: RefObject<ChatHandle | null> }) {
  const { isOpen, pendingQuestion, consumeQuestion, pendingDraft, consumeDraft } = useAgentPanel();
  useEffect(() => {
    handle.current?.setOpen(isOpen);
  }, [handle, isOpen]);
  // Someone pressed Enter on "Ask the agent", so the question is sent rather
  // than left in the composer waiting for a second Enter.
  useEffect(() => {
    if (!pendingQuestion) return;
    handle.current?.sendMessage({ text: pendingQuestion });
    consumeQuestion();
  }, [handle, pendingQuestion, consumeQuestion]);
  // A draft is the opposite: half a sentence from a button on the page, for the
  // user to finish and send themselves.
  useEffect(() => {
    if (!pendingDraft) return;
    handle.current?.setInput(pendingDraft.text);
    consumeDraft();
  }, [handle, pendingDraft, consumeDraft]);
  return null;
}

/**
 * Replaces the library header so closing the panel always goes through the app's
 * own state. Two sources of truth for "is the panel open" would desync the
 * moment a user clicked the widget's own close button.
 */
function AgentPanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const panel = useAgentPanel();
  return <header className="agent-panel-head">
    <span className="agent-panel-mark"><Sparkles size={13}/></span>
    <div>
      <strong>Fieldnote agent</strong>
    </div>
    {canClear && <button type="button" className="agent-panel-clear" onClick={onClear}>Clear</button>}
    <button type="button" className="button icon ghost" aria-label="Conversations" onClick={panel.showThreads}>
      <MessagesSquare size={15}/>
    </button>
    <AgentExpandButton />
    <button type="button" className="button icon ghost" aria-label="Close agent panel" onClick={panel.close}>
      <X size={15}/>
    </button>
  </header>;
}

/**
 * Just the part of a finished turn the history sync needs. The widget's own
 * callback type sits behind a union of chat init shapes, so naming the fields is
 * simpler than extracting it.
 */
type FinishedTurn = { messages: Array<{ id: string; role: string; parts: unknown }> };

type ToolCall = Parameters<NonNullable<Tools[string]["onToolCall"]>>[0];

/** Reports a tool call's outcome by call id alone. */
type SettleToolCall = (result: { toolCallId: string; output: unknown }) => void;

/**
 * Where a finished tool call is reported, once the widget has said how.
 *
 * The `addToolResult` the widget hands a tool names the tool as well as the
 * call, and it takes either as the key: it settles the first message holding
 * any `tool-<name>` part, even when the id belongs to a later one. So from the
 * second time the agent uses a tool in one conversation, the result lands on
 * the earlier call's message, matches no id there, and is dropped. The work is
 * already done, but the card spins on "One moment…" and the turn never ends,
 * since the reply is only asked for once every call has settled. Naming only
 * the id leaves the lookup nothing ambiguous to match.
 *
 * The unnamed channel is only readable from inside the widget, while the tools
 * that use it are built outside, so it is handed over on mount.
 */
function ToolResultChannel({ settleRef }: { settleRef: RefObject<SettleToolCall | null> }) {
  const { indexRenderState } = useInstantSearch();
  const addToolResult = indexRenderState.chat?.addToolResult;
  useEffect(() => {
    settleRef.current = (addToolResult as unknown as SettleToolCall | undefined) ?? null;
  }, [settleRef, addToolResult]);
  return null;
}

// Reads can be replayed safely; a write may have committed before the response
// was lost, so retrying it would duplicate the record.
const isReadOnlyTool = (name: string) => /^(get|list)_/.test(name);
const isTransportError = (error: unknown) =>
  error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");

// A restarting API server refuses connections for about a second, which fails
// fast rather than timing out, so a read is worth replaying once.
async function runTool(name: string, input: unknown) {
  try {
    return await api.executeAgentTool(name, input);
  } catch (error) {
    if (!(error instanceof TypeError) || !isReadOnlyTool(name)) throw error;
    await new Promise(resolve => setTimeout(resolve, 600));
    return api.executeAgentTool(name, input);
  }
}

// `error` stays short enough for the tool card; `hint` tells the agent how to
// talk about it, since a lost response does not mean the write was lost too.
function toolFailure(name: string, error: unknown) {
  if (!isTransportError(error)) return { error: error instanceof Error ? error.message : "Tool failed" };
  return {
    error: error instanceof DOMException ? "Timed out reaching the local API" : "Lost connection to the local API",
    hint: isReadOnlyTool(name)
      ? "Nothing was changed. Ask the user to try again."
      : "The change may already be saved — check before retrying it.",
  };
}

export function AgentStudioChat() {
  const timezone = useTimezone();
  const queryClient = useQueryClient();
  const { isOpen, isExpanded, attachments, clearAttachments } = useAgentPanel();
  const chat = useRef<ChatHandle>(null);
  const settleToolCallRef = useRef<SettleToolCall | null>(null);
  const appId = import.meta.env.VITE_ALGOLIA_APPLICATION_ID as string;
  const apiKey = import.meta.env.VITE_ALGOLIA_SEARCH_API_KEY as string;
  const agentId = import.meta.env.VITE_ALGOLIA_AGENT_ID as string;
  const indexName = import.meta.env.VITE_ALGOLIA_TODO_INDEX || "devcon_assistant_todos";
  const searchClient = useMemo(() => createSearchClient(appId, apiKey), [appId, apiKey]);
  // Resolved once and held for the mount, because `id` is compared by value like
  // the props below and a new one would rebuild the widget mid-conversation.
  const [agentConversationId] = useState(resolveAgentConversationId);
  // `tools`, `context`, and `onFinish` reach the chat connector, which rebuilds
  // the widget — losing the conversation — whenever they stop being identical.
  // The panel now lives in the shell and re-renders with it, so they are all
  // pinned, and `timezone` is read through a ref because it arrives late.
  const timezoneRef = useRef(timezone);
  useEffect(() => {
    timezoneRef.current = timezone;
  }, [timezone]);
  // Attachments belong to the message being written, so they are read at send
  // time through the same kind of ref, for the same reason.
  const attachmentsRef = useRef(attachments);
  const clearAttachmentsRef = useRef(clearAttachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
    clearAttachmentsRef.current = clearAttachments;
  }, [attachments, clearAttachments]);
  // The server executor owns validation, delete confirmation, and clear_fields
  // patching, so there is nothing tool-specific to do here.
  const callTool = useCallback(async (name: string, call: ToolCall) => {
    let output: unknown;
    try {
      output = { success: true, data: await runTool(name, call.input) };
    } catch (error) {
      output = { success: false, ...toolFailure(name, error) };
    }
    // The agent can create or edit a life area as easily as a todo, so the
    // taxonomy is resynced alongside the content it labels — and a write that
    // lost its response may still have landed, so it happens either way.
    invalidateTaxonomy(queryClient);
    const settle = settleToolCallRef.current;
    if (settle) settle({ toolCallId: call.toolCallId, output });
    else call.addToolResult({ output });
  }, [queryClient]);
  // Built from toolActivityMeta so every tool the agent is told about has a
  // handler.
  const tools = useMemo<Tools>(() => Object.fromEntries(
    Object.keys(toolActivityMeta).map((name): [string, Tools[string]] => [name, {
      // `callTool` reads the result channel off a ref, and the rule cannot tell
      // that the widget only calls this while streaming a turn, never rendering.
      // eslint-disable-next-line react-hooks/refs
      onToolCall: call => callTool(name, call),
      layoutComponent: createToolActivityLayout(name),
    }]),
  ), [callTool]);
  // The connector resolves this once per send, whichever path sent the message,
  // so it is also where a turn's attachments are spent: they were context for
  // the sentence just written, not for the ones after it.
  const context = useCallback(() => {
    const attached = attachmentsRef.current;
    if (attached.length) queueMicrotask(() => clearAttachmentsRef.current());
    return {
      localUserId: "devcon-demo",
      timezone: timezoneRef.current,
      currentDateTime: new Date().toISOString(),
      ...serializeAttachments(attached),
    };
  }, []);
  const onFinish = useCallback(({ messages }: FinishedTurn) => {
    const history = messages
      .filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({
        id: message.id,
        role: message.role as "user" | "assistant",
        parts: JSON.parse(JSON.stringify(message.parts)) as Array<Record<string, unknown>>,
      }));
    touchAgentConversation(agentConversationId);
    void api.syncWebConversation(history, agentConversationId).then(() =>
      queryClient.invalidateQueries({ queryKey: ["channel-conversations"] }),
    );
  }, [queryClient, agentConversationId]);

  // A closed panel is still mounted to keep the conversation, so it has to be
  // taken out of the accessibility tree and out of the tab order.
  return <div
    className="agent-studio-panel"
    data-open={isOpen}
    data-expanded={isExpanded}
    aria-hidden={!isOpen}
    inert={!isOpen}
  >
    <InstantSearch searchClient={searchClient} indexName={indexName}>
      <Chat
        ref={chat}
        agentId={agentId}
        id={agentConversationId}
        layoutComponent={PanelLayout}
        headerComponent={AgentPanelHeader}
        itemComponent={AgentSearchResultCard}
        emptyComponent={AgentChatEmpty}
        promptHeaderComponent={AttachmentChips}
        promptFooterComponent={AgentPromptFooter}
        tools={tools}
        context={context}
        onFinish={onFinish}
        translations={{
          header: { title: "Fieldnote agent" },
          prompt: {
            textareaPlaceholder: "Ask about your work, save a memory, or plan the next move…",
            disclaimer: "",
          },
        }}
      />
      <ChatSync handle={chat} />
      <ToolResultChannel settleRef={settleToolCallRef} />
    </InstantSearch>
  </div>;
}
