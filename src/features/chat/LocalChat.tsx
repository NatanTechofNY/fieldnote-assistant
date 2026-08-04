import { type FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Bot, LoaderCircle, MessagesSquare, Send, Sparkles, X, Zap } from "lucide-react";
import { api } from "../../api";
import type {
  Message,
} from "../../types";
import { Loading, MarkdownContent } from "../../components/ui";
import { invalidateContent } from "../../lib/invalidate";
import { useAgentPanel } from "../../lib/agent-panel";
import { attachmentsAsText } from "../../lib/agent-attachments";
import { AgentExpandButton } from "./AgentExpandButton";
import { AttachmentChips } from "./AttachmentChips";

const PROMPTS = [
  "Remember that my conference talk is about NeuralSearch.",
  "Create a task to rehearse my demo tomorrow at 10 AM.",
  "What have I said about the presentation?",
  "Show my blocked tasks and help me pick one.",
];

/**
 * The demo assistant used when Agent Studio credentials are absent. It renders
 * the same panel chrome as the real chat so the shortcut behaves identically.
 */
export function LocalChat() {
  const queryClient = useQueryClient();
  const panel = useAgentPanel();
  const { pendingQuestion, consumeQuestion, pendingDraft, consumeDraft, attachments, clearAttachments } = panel;
  const [input, setInput] = useState("");
  const composerRef = useRef<HTMLInputElement>(null);
  const [optimistic, setOptimistic] = useState<Message[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const { data: persisted = [], isLoading } = useQuery({ queryKey: ["messages"], queryFn: api.messages });
  const messages = [...persisted, ...optimistic];
  const send = useMutation({
    mutationFn: api.chat,
    onMutate: content => setOptimistic([{ id: `temp-${Date.now()}`, role: "user", content, created_at: new Date().toISOString() }]),
    onSuccess: () => { setOptimistic([]); invalidateContent(queryClient); void queryClient.invalidateQueries({ queryKey: ["messages"] }); },
    onError: (error, content) => setOptimistic([
      { id: `temp-user`, role: "user", content, created_at: new Date().toISOString() },
      { id: `temp-error`, role: "system", content: error instanceof Error ? error.message : "Agent Studio is not configured.", created_at: new Date().toISOString() },
    ]),
  });
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages.length, send.isPending]);
  // A question handed over from search was already confirmed with Enter, so it
  // is sent here rather than parked in the composer.
  const askQuestion = send.mutate;
  useEffect(() => {
    if (!pendingQuestion) return;
    consumeQuestion();
    askQuestion(pendingQuestion);
  }, [pendingQuestion, consumeQuestion, askQuestion]);
  // A draft arrives half-written from a button on the page and waits in the
  // composer for the user to finish it. The composer is adjusted here rather
  // than in an effect so the sentence lands in the same render it arrives in.
  const [draftSeen, setDraftSeen] = useState(0);
  if (pendingDraft && pendingDraft.id !== draftSeen) {
    setDraftSeen(pendingDraft.id);
    setInput(pendingDraft.text);
  }
  useEffect(() => {
    if (!pendingDraft) return;
    consumeDraft();
    composerRef.current?.focus?.();
  }, [pendingDraft, consumeDraft]);
  // `/api/chat` takes a sentence and nothing else, so here the attached records
  // ride along as text rather than as the hidden turn context the real agent
  // gets. Sending spends them either way.
  function submit(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || send.isPending) return;
    setInput("");
    clearAttachments();
    send.mutate(`${attachmentsAsText(attachments)}${content}`);
  }
  return <>
    <header className="agent-panel-head">
      <span className="agent-panel-mark"><Sparkles size={13}/></span>
      <div>
        <strong>Fieldnote agent</strong>
        <div className="eyebrow">Local demo mode</div>
      </div>
      <button type="button" className="button icon ghost" aria-label="Conversations" onClick={panel.showThreads}>
        <MessagesSquare size={15}/>
      </button>
      <AgentExpandButton />
      <button type="button" className="button icon ghost" aria-label="Close agent panel" onClick={panel.close}>
        <X size={15}/>
      </button>
    </header>
    <div className="agent-panel-messages">
      {isLoading ? <Loading/> : messages.length ? messages.map(message => (
        <ChatMessage key={message.id} message={message} />
      )) : <div className="agent-chat-empty">
        <div className="agent-chat-mark"><Bot size={17}/></div>
        <h3>Start with what’s on your mind.</h3>
        <p>I can organize tasks, keep memories, and recall them with NeuralSearch.</p>
        <div className="agent-panel-prompts">
          {PROMPTS.map(prompt => (
            <button key={prompt} type="button" className="prompt-chip" onClick={() => setInput(prompt)}>{prompt}</button>
          ))}
        </div>
      </div>}
      {send.isPending && <div className="message assistant"><div className="bubble"><LoaderCircle size={14} className="spin"/> Agent Studio is thinking…</div></div>}
      <div ref={endRef}/>
    </div>
    <form className="composer" onSubmit={submit}>
      <AttachmentChips />
      <input ref={composerRef} className="input" aria-label="Message the agent" value={input} onChange={event => setInput(event.target.value)} placeholder="Tell your assistant anything…" />
      <button className="button primary" aria-label="Send" disabled={send.isPending}><Send size={16}/></button>
    </form>
  </>;
}

function ChatMessage({ message }: { message: Message }) {
  return <div className={`message ${message.role}`}><div className="bubble">
    {message.role === "tool" && <><Zap size={12} style={{ display: "inline", marginRight: 6 }}/>{message.tool_name || "Tool"}<br/></>}
    {message.role === "tool" ? message.content : <MarkdownContent content={message.content}/>}
  </div><time>{format(new Date(message.created_at), "h:mm a")}</time></div>;
}
