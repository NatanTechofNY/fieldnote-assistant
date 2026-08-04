import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Brain, Check, Copy, ListTodo, MessageSquareText } from "lucide-react";
import { api } from "../../api";
import { useAgentPanel } from "../../lib/agent-panel";

/**
 * Deliberately unfinished: the point is that the agent takes the rest of the
 * sentence in your words, so a form's worth of fields never has to appear.
 */
const drafts = {
  todo: "Add a todo to ",
  memory: "Remember that ",
};

/**
 * The one thing to do on landing: say something. Everything the app can do is
 * reachable from a sentence, so the day starts with a way to write one rather
 * than with a form.
 */
export function TodayHero() {
  const panel = useAgentPanel();
  const { data: integrations } = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const [copied, setCopied] = useState(false);
  /*
   * The number the app texts from is the number you text back, so it follows the
   * provider currently selected for delivery rather than whichever one happens
   * to be connected.
   */
  const connection = integrations?.notifications.smsProvider === "sendblue"
    ? integrations?.sendblue
    : integrations?.twilio;
  const phone = connection?.configured ? connection.fromPhone : null;
  const copy = async () => {
    if (!phone) return;
    await navigator.clipboard?.writeText?.(phone);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <section className="today-hero">
    <div className="today-hero-top">
      <div className="today-hero-intro">
        <div className="eyebrow">Start here</div>
        <h3>Just say what you need.</h3>
        <p>Add a task, keep a memory, or find something you said weeks ago. The agent does the filing.</p>
      </div>
      {/* The two sentences the agent can finish are the offer, so they are the
          buttons; reaching the agent at all is a detail of the footer. */}
      <div className="today-hero-actions">
        <button type="button" className="button primary" onClick={() => panel.draft(drafts.memory)}>
          <Brain size={15}/>Remember something
        </button>
        <button type="button" className="button" onClick={() => panel.draft(drafts.todo)}>
          <ListTodo size={15}/>Add a todo
        </button>
      </div>
    </div>
    <div className="today-hero-agent">
      <button type="button" className="today-hero-talk" onClick={panel.open}>
        <Bot size={14}/>Talk to the agent<kbd>⌘I</kbd>
      </button>
      {phone && <div className="today-hero-sms">
        <span>or text</span>
        <a href={`sms:${phone}`}><MessageSquareText size={14}/>{phone}</a>
        <button type="button" className="today-hero-copy-number" aria-label="Copy the number" onClick={copy}>
          {copied ? <Check size={13}/> : <Copy size={13}/>}
        </button>
      </div>}
    </div>
  </section>;
}
