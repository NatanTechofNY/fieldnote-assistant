import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen, CornerUpLeft, Database, LoaderCircle, Mail, MessageSquareText, Phone, Search,
  Settings2, Sparkles,
} from "lucide-react";
import { api } from "../../api";
import type {
  ChannelConversation, ChannelMessage, ConversationSearchHit,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { ErrorState, HighlightedText, Loading, MarkdownContent } from "../../components/ui";
import { HistoryToolGroup } from "./HistoryToolTrace";
import { historyTimeline } from "./tool-traces";
import { BackgroundWorkPanel } from "./BackgroundWorkPanel";
import { isBackgroundAddress, isGroupAddress, threadLabel, threadTitle } from "./thread-label";
import { friendlyDate, historyTimestamp, useTimezone } from "../../lib/timezone";
import { searchTerms, snippetAround } from "../../lib/highlight";
import { useDebounced } from "../../lib/use-debounced";
import { useAgentPanel } from "../../lib/agent-panel";
import { useRedact } from "../../lib/demo-mode";

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
/** What the app composes on a schedule, and how each kind is labelled in the archive. */
const SCHEDULED_KINDS = new Map<string, string>([
  ["daily_digest", "Daily digest"],
  ["digest_brief", "Digest brief"],
  ["evening_checkin", "Evening check-in"],
  ["group_morning", "Group morning check-in"],
  ["group_evening", "Group evening check-in"],
  ["checkin_ask_draft", "Check-in wording draft"],
  ["follow_up", "Follow-up"],
  ["memory_sweep", "Memory sweep"],
  ["profile_refresh", "Profile rewrite"],
  ["group_profile_refresh", "Group profile rewrite"],
]);

function DigestBlock({ message }: { message: ChannelMessage }) {
  const kind = typeof message.metadata.kind === "string" ? message.metadata.kind : "";
  const name = typeof message.metadata.briefName === "string" ? message.metadata.briefName : null;
  const date = typeof message.metadata.date === "string" ? message.metadata.date : null;
  const instruction = typeof message.metadata.instruction === "string" ? message.metadata.instruction : null;
  return <div className="digest-history-block">
    <span><Mail size={16}/></span>
    <div>
      <small>
        {SCHEDULED_KINDS.get(kind) ?? "Scheduled message"}
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

/**
 * Sendblue names the six classic tapbacks on the wire and takes an emoji for
 * anything else. Messages draws all of them as a glyph, so an unrecognised value
 * is already one and is shown as it arrived.
 */
const REACTION_GLYPHS: Record<string, string> = {
  love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓",
};

function messageReactions(message: ChannelMessage): string[] {
  const raw = Array.isArray(message.metadata.reactions) ? message.metadata.reactions : [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map(value => REACTION_GLYPHS[value] ?? value);
}

function metadataHandle(message: ChannelMessage, key: "replyTo" | "threadOriginator"): string | null {
  const value = message.metadata[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * The message a threaded reply was drawn under, as Messages draws it: the
 * thread's first message. Sendblue's `reply_to` on an inbound text is only the
 * message before it in the chat, often a tapback or one never archived, so the
 * `thread_originator` handle decides. An outbound reply names the inbound text
 * it answered, and shows that text's own thread root when it has one.
 */
function replyParent(
  message: ChannelMessage,
  byProviderId: Map<string, ChannelMessage>,
): { content: string } | null {
  const handle = metadataHandle(message, "threadOriginator") ?? metadataHandle(message, "replyTo");
  if (!handle) return null;
  const parent = byProviderId.get(handle);
  const root = parent && metadataHandle(parent, "threadOriginator");
  // A reply can point at a message from before this archive existed, and that it
  // was threaded at all is still worth drawing.
  return (root ? byProviderId.get(root) : undefined) ?? parent ?? { content: "an earlier message" };
}

/**
 * The picture a message the assistant sent carried: a GIF, a picture off a
 * page, a product card's photo. The text of a picture sent alone is only the
 * archive's "(picture)" placeholder, so the picture stands in for it.
 */
const PICTURE_PLACEHOLDER = "(picture)";

function sentPicture(message: ChannelMessage): string | null {
  const url = message.role === "assistant" ? message.metadata.mediaUrl : undefined;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

function StartConversationButton() {
  const panel = useAgentPanel();
  return <button type="button" className="button primary" onClick={panel.open}>
    <MessageSquareText size={14}/>Start a conversation
  </button>;
}

/** Conversations are the chats; Background work is what the assistant does on its own between them. */
const HISTORY_TABS = [["conversations", "Conversations"], ["background", "Background work"]] as const;
type HistoryTab = typeof HISTORY_TABS[number][0];
const tabPanelProps = (tab: HistoryTab) => ({ role: "tabpanel", id: `history-panel-${tab}`, "aria-labelledby": `history-tab-${tab}` }) as const;

function HistoryTabs({ active }: { active: HistoryTab }) {
  const [, setSearchParams] = useSearchParams();
  const open = (value: HistoryTab) => setSearchParams(value === "background" ? { tab: "background" } : {});
  // Arrow keys move between tabs and only the open one is in the tab order.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = HISTORY_TABS.findIndex(([value]) => value === active);
    const next = HISTORY_TABS[(index + step + HISTORY_TABS.length) % HISTORY_TABS.length][0];
    open(next);
    window.requestAnimationFrame(() => document.getElementById(`history-tab-${next}`)?.focus());
  };
  return <div className="tabs" role="tablist" aria-label="History view">
    {HISTORY_TABS.map(([value, label]) => <button
      key={value}
      id={`history-tab-${value}`}
      type="button"
      role="tab"
      aria-selected={active === value}
      aria-controls={`history-panel-${value}`}
      tabIndex={active === value ? 0 : -1}
      className={`tab ${active === value ? "active" : ""}`}
      onClick={() => open(value)}
      onKeyDown={onKeyDown}
    >{label}</button>)}
  </div>;
}

export function ConversationHistoryPage() {
  const [searchParams] = useSearchParams();
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["channel-conversations"],
    queryFn: api.channelConversations,
    refetchInterval: 15_000,
  });
  const backgroundPage = <div className="page">
    <PageHead eyebrow="Conversation archive" title="Every message, in one place." description="What the assistant does on its own: what it learned from each chat, and the Soul and profile it works from." />
    <HistoryTabs active="background" />
    <div {...tabPanelProps("background")}><BackgroundWorkPanel /></div>
  </div>;
  // The tab does not need the conversation list, so a failed list does not hide it.
  if (searchParams.get("tab") === "background") return backgroundPage;
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  // A link to a scratch thread (an old bookmark, a search hit) lands where its results now live.
  const thread = searchParams.get("thread");
  const linkedToBackground = Boolean(thread && data.some(item => item.id === thread && isBackgroundAddress(item.address)));
  if (linkedToBackground) return backgroundPage;
  const conversations = data.filter(item => !isBackgroundAddress(item.address));
  if (!conversations.length) return <div className="page">
    <PageHead eyebrow="Conversation archive" title="Every message, in one place." description="Web and SMS conversations are retained in local SQLite while the agent receives only a bounded context window." />
    <HistoryTabs active="conversations" />
    <section className="card archive-empty" {...tabPanelProps("conversations")}>
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
  return <DeepLinkedHistoryContent conversations={conversations}/>;
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
  const redact = useRedact();
  const { data: integrations } = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const ownerPhone = integrations?.notifications.recipientPhone ?? null;
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
  const selectedWorkflow = threadLabel(selected.address, selected.displayName);
  const selectedIsGroup = isGroupAddress(selected.address);
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
  const byProviderId = useMemo(() => new Map(messages
    .filter(message => typeof message.providerMessageId === "string")
    .map(message => [message.providerMessageId as string, message])), [messages]);
  const searchGroups = useMemo(() => {
    const groups = new Map<string, ConversationSearchHit[]>();
    for (const hit of searchResult?.hits ?? []) {
      // A hit on a scratch thread has no conversation here to open.
      if (!conversations.some(item => item.id === hit.threadId)) continue;
      groups.set(hit.threadId, [...(groups.get(hit.threadId) || []), hit]);
    }
    return [...groups.entries()];
  }, [searchResult, conversations]);
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
    <HistoryTabs active="conversations" />
    <section className="history-shell card" {...tabPanelProps("conversations")}>
      <aside className="history-threads">
        <div className="history-search"><Search size={14}/><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search conversations…"/></div>
        {debouncedSearch.length >= 2 ? <>
          <div className="history-section-title">Search results <span>{searchGroups.reduce((total, [, hits]) => total + hits.length, 0)}</span></div>
          {isSearching && <div className="history-search-state"><LoaderCircle className="spin" size={14}/>Searching meaning…</div>}
          {!isSearching && !searchGroups.length && <div className="history-search-state">No matching conversations.</div>}
          {searchGroups.map(([threadId, hits]) => {
            const thread = conversations.find(item => item.id === threadId);
            return <section className="history-result-group" key={threadId}>
              <header>{thread?.channel === "sms" ? <Phone size={11}/> : <MessageSquareText size={11}/>}<span>{thread ? threadTitle(thread, redact.phone, "Web Agent", ownerPhone) : "Web Agent"}</span></header>
              {hits.map(hit => <button
                key={hit.objectID}
                className={jump?.messageId === hit.objectID ? "opened" : ""}
                onClick={() => openSearchHit(hit)}
              >
                <small>{hit.speaker_name ?? hit.role} · {friendlyDate(hit.created_at, timezone)}</small>
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
            const workflow = threadLabel(thread.address, thread.displayName);
            return <button
              key={thread.id}
              className={`history-thread ${thread.id === selected.id ? "active" : ""}`}
              onClick={() => { setSelectedId(thread.id); setJump(null); }}
            >
              <span className="history-channel">
                {workflow && !isGroupAddress(thread.address) ? <Sparkles size={13}/> : thread.channel === "sms" ? <Phone size={13}/> : <MessageSquareText size={13}/>}
              </span>
              <span className="history-thread-copy">
                <strong>{threadTitle(thread, redact.phone, "Web Agent", ownerPhone)}</strong>
                <small>{isGroupAddress(thread.address) ? (thread.lastMessage || "No messages") : (workflow?.subtitle ?? (thread.lastMessage || "No messages"))}</small>
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
            <strong>{threadTitle(selected, redact.phone, "Fieldnote web agent", ownerPhone)}</strong>
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
              && typeof message.metadata.kind === "string" && SCHEDULED_KINDS.has(message.metadata.kind);
            const isJumpTarget = jump?.messageId === message.id;
            const parent = replyParent(message, byProviderId);
            const reactions = messageReactions(message);
            const picture = sentPicture(message);
            // Several people write into a group, so each of their bubbles says
            // who: by name, or by redacted number for a participant the owner
            // never named, so two unnamed voices still read as two.
            const speakerName = selectedIsGroup && message.role === "user"
              ? message.metadata.speakerIsOwner === true ? "You"
                : typeof message.metadata.speakerName === "string" ? message.metadata.speakerName
                : typeof message.metadata.speaker === "string" ? redact.phone(message.metadata.speaker)
                  : null
              : null;
            // A copy of a group's check-in echoed to the owner says which group it came from.
            const echoOf = message.role === "assistant" && typeof message.metadata.copyOf === "string"
              ? `Copy of ${typeof message.metadata.groupName === "string" ? `${message.metadata.groupName}’s` : "a group’s"} ${
                (SCHEDULED_KINDS.get(String(message.metadata.kind)) ?? "check-in").replace(/^Group /, "").toLowerCase()}`
              : null;
            return <article key={message.id} ref={node => { if (node) messageRefs.current.set(message.id, node); else messageRefs.current.delete(message.id); }} className={`history-message ${message.direction} role-${message.role} ${isJumpTarget ? "search-hit" : ""}`}>
              <div className="history-bubble">
                {speakerName && <div className="history-speaker">{speakerName}</div>}
                {echoOf && <div className="history-speaker">{echoOf}</div>}
                {parent && <div className="history-reply-quote">
                  <CornerUpLeft size={11}/>
                  <span>{parent.content}</span>
                </div>}
                {picture && <a className="history-picture" href={picture} target="_blank" rel="noreferrer">
                  <img src={picture} alt="Picture sent" loading="lazy" referrerPolicy="no-referrer"/>
                </a>}
                {isReflectionRequest
                  ? <ReflectionGenerationBlock message={message}/>
                  : isDigestRequest
                    ? <DigestBlock message={message}/>
                    : picture && message.content === PICTURE_PLACEHOLDER
                      ? null
                      : <MarkdownContent
                        content={message.content}
                        highlight={isJumpTarget ? jump.terms : undefined}
                      />}
                {reactions.length > 0 && <div className="history-reactions">
                  {reactions.map(reaction => <span key={reaction}>{reaction}</span>)}
                </div>}
                {traces.length > 0 && <div className="history-traces">
                  <HistoryToolGroup traces={traces}/>
                </div>}
                <footer>
                  <span>{message.status}</span>
                  {message.metadata.heldUntilNamed === true && <span className="history-held" title="The group asked the assistant to stay out until it is named, so this message was filed without an answer">Held — quiet until named</span>}
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
