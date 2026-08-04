import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Bot, MessagesSquare, Phone, X } from "lucide-react";
import { api } from "../../api";
import type {
  ChannelConversation,
} from "../../types";
import { Loading, MarkdownContent } from "../../components/ui";
import { friendlyDate, historyTimestamp, useTimezone } from "../../lib/timezone";
import { useAgentPanel } from "../../lib/agent-panel";
import { threadTitle } from "../history/thread-label";

/**
 * The archive, in the panel, at the width of a phone: a thread list and a plain
 * transcript, the way a messages app does it.
 *
 * What is deliberately not here — tool traces, digest and reflection blocks,
 * conversation search — is the History page's job, one link away at the bottom.
 */
export function PanelConversations() {
  const panel = useAgentPanel();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: threads = [], isLoading } = useQuery({
    queryKey: ["channel-conversations"],
    queryFn: api.channelConversations,
    refetchInterval: 20_000,
  });
  const selected = threads.find(thread => thread.id === selectedId) ?? null;
  return <aside className="panel-threads" data-expanded={panel.isExpanded} aria-label="Conversations">
    <header className="agent-panel-head">
      {selected
        ? <button type="button" className="button icon ghost" aria-label="Back to conversations" onClick={() => setSelectedId(null)}>
          <ArrowLeft size={15}/>
        </button>
        : <span className="agent-panel-mark"><MessagesSquare size={13}/></span>}
      <div>
        <strong>{selected ? threadTitle(selected) : "Conversations"}</strong>
        <div className="eyebrow">{selected
          ? `${selected.messageCount} message${selected.messageCount === 1 ? "" : "s"}`
          : "Web and SMS, kept on this machine"}</div>
      </div>
      <button type="button" className="agent-panel-clear" onClick={panel.showChat}>Live chat</button>
      <button type="button" className="button icon ghost" aria-label="Close agent panel" onClick={panel.close}>
        <X size={15}/>
      </button>
    </header>
    {selected ? <Transcript thread={selected} onLeave={panel.close}/>
      : isLoading ? <Loading/>
        : threads.length ? <ThreadList threads={threads} onSelect={setSelectedId}/>
          : <div className="agent-chat-empty">
            <div className="agent-chat-mark"><MessagesSquare size={17}/></div>
            <h3>No conversations yet.</h3>
            <p>Everything you say here, and every text you send the agent, will be listed on this screen.</p>
          </div>}
  </aside>;
}

function ThreadList({ threads, onSelect }: { threads: ChannelConversation[]; onSelect: (id: string) => void }) {
  const timezone = useTimezone();
  return <div className="panel-thread-list">
    {threads.map(thread => <button key={thread.id} type="button" className="panel-thread" onClick={() => onSelect(thread.id)}>
      <span className="panel-thread-mark">{thread.channel === "sms" ? <Phone size={13}/> : <Bot size={13}/>}</span>
      <span className="panel-thread-body">
        <strong>{threadTitle(thread)}</strong>
        <small>{thread.lastMessage || "No messages yet"}</small>
      </span>
      <span className="panel-thread-meta">
        {thread.lastMessageAt && <time>{friendlyDate(thread.lastMessageAt, timezone)}</time>}
        <span className="badge">{thread.messageCount}</span>
      </span>
    </button>)}
  </div>;
}

function Transcript({ thread, onLeave }: { thread: ChannelConversation; onLeave: () => void }) {
  const timezone = useTimezone();
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["channel-messages", thread.id],
    queryFn: () => api.channelMessages(thread.id),
    refetchInterval: 15_000,
  });
  // Tool and system turns are machinery, not conversation.
  const spoken = messages.filter(message => message.role === "user" || message.role === "assistant");
  // A thread is read from its latest message, the way any messages app opens.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.();
  }, [spoken.length]);
  return <>
    <div className="agent-panel-messages">
      {isLoading ? <Loading/> : spoken.length
        ? spoken.map(message => <div key={message.id} className={`message ${message.role}`}>
          <div className="bubble"><MarkdownContent content={message.content}/></div>
          <time>{historyTimestamp(message.createdAt, timezone)}</time>
        </div>)
        : <div className="agent-chat-empty"><p>This thread has no messages in it.</p></div>}
      <div ref={endRef}/>
    </div>
    <footer className="panel-thread-foot">
      <NavLink to={`/history?thread=${encodeURIComponent(thread.id)}`} onClick={onLeave}>
        Open the full thread<ArrowUpRight size={13}/>
      </NavLink>
      <span>Tool calls and traces are kept there</span>
    </footer>
  </>;
}
