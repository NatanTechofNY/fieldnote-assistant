import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen, Database, LoaderCircle, Mail, MessageSquareText, Phone, Search, Settings2, Sparkles,
} from "lucide-react";
import { api } from "../../api";
import type {
  ChannelConversation, ChannelMessage, ConversationSearchHit,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { ErrorState, HighlightedText, Loading, MarkdownContent } from "../../components/ui";
import { HistoryToolGroup } from "./HistoryToolTrace";
import { historyTimeline } from "./tool-traces";
import { threadLabel } from "./thread-label";
import { friendlyDate, historyTimestamp, useTimezone } from "../../lib/timezone";
import { searchTerms, snippetAround } from "../../lib/highlight";
import { useDebounced } from "../../lib/use-debounced";
import { useAgentPanel } from "../../lib/agent-panel";

function ReflectionGenerationBlock({ message }: { message: ChannelMessage }) {
  const label = typeof message.metadata.label === "string"
    ? message.metadata.label
    : message.content.match(/reflection for (.+?)\. Call get_reflection_evidence/i)?.[1] || "Selected period";
  const selectedCount = typeof message.metadata.selectedCount === "number" ? message.metadata.selectedCount : null;
  return <div className="reflection-history-block">
    <span><Sparkles size={16}/></span>
    <div>
      <small>Reflection generator</small>
      <strong>{label}</strong>
      <p>{selectedCount === null ? "Drafting from your selected evidence" : `Drafting from ${selectedCount} selected ${selectedCount === 1 ? "record" : "records"}`}</p>
    </div>
  </div>;
}

/**
 * Digest turns are composed by the app: the user's instruction, then a block of
 * resolved board IDs, status IDs, and length rules. Printing all of that as a
 * chat bubble buries the one line the user wrote, so the machine half is
 * collapsed behind it.
 */
function DigestBlock({ message }: { message: ChannelMessage }) {
  const isBrief = message.metadata.kind === "digest_brief";
  const name = typeof message.metadata.briefName === "string" ? message.metadata.briefName : null;
  const date = typeof message.metadata.date === "string" ? message.metadata.date : null;
  const instruction = typeof message.metadata.instruction === "string" ? message.metadata.instruction : null;
  return <div className="digest-history-block">
    <span><Mail size={16}/></span>
    <div>
      <small>
        {isBrief ? "Digest brief" : "Daily digest"}
        {message.metadata.preview === true ? " · preview, not sent" : ""}
      </small>
      <strong>{name || date || "Scheduled digest"}</strong>
      {instruction && <p>{instruction}</p>}
      <details className="digest-history-context">
        <summary>What the app sent the agent</summary>
        <pre>{message.content}</pre>
      </details>
    </div>
  </div>;
}

function StartConversationButton() {
  const panel = useAgentPanel();
  return <button type="button" className="button primary" onClick={panel.open}>
    <MessageSquareText size={14}/>Start a conversation
  </button>;
}

export function ConversationHistoryPage() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["channel-conversations"],
    queryFn: api.channelConversations,
    refetchInterval: 15_000,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!data.length) return <div className="page">
    <PageHead eyebrow="Conversation archive" title="Every message, in one place." description="Web and SMS conversations are retained in local SQLite while the agent receives only a bounded context window." />
    <section className="card archive-empty">
      <div className="archive-empty-copy">
        <div className="archive-empty-mark" aria-hidden="true"><BookOpen size={17}/></div>
        <h2>The first page is yours to write.</h2>
        <p>Start a conversation with your agent here, or connect Twilio and send a text. Every exchange will appear in this private timeline.</p>
        <div className="archive-actions">
          <StartConversationButton />
          <NavLink to="/settings" className="button"><Settings2 size={14}/>Open settings</NavLink>
        </div>
        <div className="archive-assurance"><Database size={12}/><span>Stored locally in SQLite</span><i/>Nothing leaves your archive</div>
      </div>
    </section>
  </div>;
  return <DeepLinkedHistoryContent conversations={data}/>;
}

/**
 * `?thread=&message=&q=` is how a search result opens one message. Remounting on
 * a new deep link is what makes the jump land, since the thread and scroll
 * target are initial state rather than something the URL keeps in sync.
 */
function DeepLinkedHistoryContent({ conversations }: { conversations: ChannelConversation[] }) {
  const [searchParams] = useSearchParams();
  const thread = searchParams.get("thread");
  const message = searchParams.get("message");
  const query = searchParams.get("q");
  return <ConversationHistoryContent
    key={`${thread ?? ""}|${message ?? ""}|${query ?? ""}`}
    conversations={conversations}
    initialThreadId={thread}
    initialMessageId={message}
    initialQuery={query}
  />;
}

/**
 * The message a result was asked to open, the terms that found it, and a count
 * that makes reopening the same result a new jump rather than a no-op.
 */
type JumpTarget = { messageId: string; terms: string[]; nonce: number };

/**
 * `offsetTop` is measured against the nearest positioned ancestor, which is not
 * this scroller, so the jump used to land at an arbitrary offset or at the very
 * bottom. Measuring both boxes keeps it relative to the list itself.
 */
function scrollToMessage(container: HTMLElement, target: HTMLElement) {
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo?.({
    top: Math.max(0, container.scrollTop + offset - container.clientHeight / 3),
    behavior: "smooth",
  });
}

function ConversationHistoryContent({ conversations, initialThreadId, initialMessageId, initialQuery }: {
  conversations: ChannelConversation[];
  initialThreadId: string | null;
  initialMessageId: string | null;
  initialQuery: string | null;
}) {
  const timezone = useTimezone();
  const [selectedId, setSelectedId] = useState(
    () => conversations.some(item => item.id === initialThreadId)
      ? initialThreadId as string
      : conversations[0].id,
  );
  const [searchQuery, setSearchQuery] = useState(initialQuery ?? "");
  const debouncedSearch = useDebounced(searchQuery.trim());
  const terms = useMemo(() => searchTerms(debouncedSearch), [debouncedSearch]);
  const [jump, setJump] = useState<JumpTarget | null>(() => initialMessageId
    ? { messageId: initialMessageId, terms: searchTerms(initialQuery ?? ""), nonce: 0 }
    : null);
  const jumpCount = useRef(0);
  const settledJump = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const selected = conversations.find(item => item.id === selectedId) || conversations[0];
  const selectedWorkflow = threadLabel(selected.address);
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["channel-messages", selected.id],
    queryFn: () => api.channelMessages(selected.id),
    refetchInterval: 10_000,
  });
  const { data: searchResult, isFetching: isSearching } = useQuery({
    queryKey: ["conversation-search", debouncedSearch],
    queryFn: () => api.searchConversations(debouncedSearch),
    enabled: debouncedSearch.length >= 2,
  });
  const timeline = useMemo(() => historyTimeline(messages), [messages]);
  const searchGroups = useMemo(() => {
    const groups = new Map<string, ConversationSearchHit[]>();
    for (const hit of searchResult?.hits ?? []) {
      groups.set(hit.threadId, [...(groups.get(hit.threadId) || []), hit]);
    }
    return [...groups.entries()];
  }, [searchResult]);
  const jumpKey = jump ? `${selected.id}|${jump.messageId}|${jump.nonce}` : null;
  // Pinning in a layout effect rather than an animation frame is what keeps an
  // opened thread from painting at its first message and then racing down.
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (isLoading || !container || jump) return;
    const pin = () => { container.scrollTop = container.scrollHeight; };
    pin();
    // Traces and markdown can still grow a frame later, so the bottom is claimed
    // again once the thread has finished laying out.
    const frame = window.requestAnimationFrame(pin);
    return () => window.cancelAnimationFrame(frame);
  }, [isLoading, messages, jump]);
  useEffect(() => {
    const container = messagesRef.current;
    if (isLoading || !container || !jump || !jumpKey) return;
    // A jump lands once. Clearing the target instead would let the very next
    // run fall through to the pin above and yank the reader to the bottom, and
    // the ten-second refetch would do it again on every poll.
    if (settledJump.current === jumpKey) return;
    const target = messageRefs.current.get(jump.messageId);
    // The thread is still rendering, so the next commit gets another try.
    if (!target) return;
    settledJump.current = jumpKey;
    const frame = window.requestAnimationFrame(() => scrollToMessage(container, target));
    return () => window.cancelAnimationFrame(frame);
  }, [isLoading, messages, jump, jumpKey]);
  const openSearchHit = (hit: ConversationSearchHit) => {
    setSelectedId(hit.threadId);
    jumpCount.current += 1;
    setJump({ messageId: hit.objectID, terms, nonce: jumpCount.current });
  };
  return <div className="page page-constrained history-page">
    <PageHead eyebrow="Conversation archive" title="Every message, in one place." description="Full web and SMS history is retained in SQLite. The SMS agent context uses only the latest 40 messages from the last 24 hours." />
    <section className="history-shell card">
      <aside className="history-threads">
        <div className="history-search"><Search size={14}/><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search conversations…"/></div>
        {debouncedSearch.length >= 2 ? <>
          <div className="history-section-title">Search results <span>{searchResult?.hits.length ?? 0}</span></div>
          {isSearching && <div className="history-search-state"><LoaderCircle className="spin" size={14}/>Searching meaning…</div>}
          {!isSearching && !searchGroups.length && <div className="history-search-state">No matching conversations.</div>}
          {searchGroups.map(([threadId, hits]) => {
            const thread = conversations.find(item => item.id === threadId);
            return <section className="history-result-group" key={threadId}>
              <header>{thread?.channel === "sms" ? <Phone size={11}/> : <MessageSquareText size={11}/>}<span>{thread?.channel === "sms" ? 'Text Messages (' + thread.address + ')' : "Web Agent"}</span></header>
              {hits.map(hit => <button
                key={hit.objectID}
                className={jump?.messageId === hit.objectID ? "opened" : ""}
                onClick={() => openSearchHit(hit)}
              >
                <small>{hit.role} · {friendlyDate(hit.created_at, timezone)}</small>
                <span><HighlightedText text={snippetAround(hit.content, terms)} terms={terms}/></span>
              </button>)}
            </section>;
          })}
          {searchResult && <div className="history-search-source">
            <span className={`source-pill ${searchResult.source}`}>{searchResult.source === "algolia" ? "Semantic search · Algolia" : "Text fallback · SQLite"}</span>
          </div>}
        </> : <>
          <div className="history-section-title">Conversations <span>{conversations.length}</span></div>
          {conversations.map((thread) => {
            const workflow = threadLabel(thread.address);
            return <button
              key={thread.id}
              className={`history-thread ${thread.id === selected.id ? "active" : ""}`}
              onClick={() => { setSelectedId(thread.id); setJump(null); }}
            >
              <span className="history-channel">
                {workflow ? <Sparkles size={13}/> : thread.channel === "sms" ? <Phone size={13}/> : <MessageSquareText size={13}/>}
              </span>
              <span className="history-thread-copy">
                <strong>{workflow?.title ?? (thread.channel === "sms" ? 'Text Messages (Phone Number: ' + thread.address + ')' : "Web Agent")}</strong>
                <small>{workflow?.subtitle ?? (thread.lastMessage || "No messages")}</small>
              </span>
              <span className="history-count">{thread.messageCount}</span>
            </button>;
          })}
        </>}
      </aside>
      <div className="history-conversation">
        <header className="history-header">
          <div>
            <div className="eyebrow">{selectedWorkflow?.eyebrow ?? `${selected.channel} conversation`}</div>
            <strong>{selectedWorkflow?.title ?? (selected.channel === "sms" ? 'Text Messages (' + selected.address + ')' : "Fieldnote web agent")}</strong>
          </div>
          <span>{selected.messageCount} messages</span>
        </header>
        <div className="history-messages" ref={messagesRef}>
          {isLoading ? <Loading/> : timeline.map(row => {
            if (row.kind === "tools") return <article key={row.key} className="history-message outbound role-tool">
              <div className="history-bubble">
                <div className="history-traces"><HistoryToolGroup traces={row.traces}/></div>
                <footer><time>{historyTimestamp(row.createdAt, timezone)}</time></footer>
              </div>
            </article>;
            const { message, traces } = row;
            const isReflectionRequest = message.role === "user"
              && (message.metadata.kind === "reflection_generation" || selected.address.startsWith("reflection:"));
            const isDigestRequest = message.role === "user"
              && (message.metadata.kind === "digest_brief" || message.metadata.kind === "daily_digest");
            const isJumpTarget = jump?.messageId === message.id;
            return <article key={message.id} ref={node => { if (node) messageRefs.current.set(message.id, node); else messageRefs.current.delete(message.id); }} className={`history-message ${message.direction} role-${message.role} ${isJumpTarget ? "search-hit" : ""}`}>
              <div className="history-bubble">
                {isReflectionRequest
                  ? <ReflectionGenerationBlock message={message}/>
                  : isDigestRequest
                    ? <DigestBlock message={message}/>
                    : <MarkdownContent
                      content={message.content}
                      highlight={isJumpTarget ? jump.terms : undefined}
                    />}
                {traces.length > 0 && <div className="history-traces">
                  <HistoryToolGroup traces={traces}/>
                </div>}
                <footer>
                  <span>{message.status}</span>
                  <time>{historyTimestamp(message.createdAt, timezone)}</time>
                </footer>
              </div>
            </article>;
          })}
        </div>
      </div>
    </section>
  </div>;
}
