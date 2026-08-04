import { Paperclip } from "lucide-react";
import type { AgentAttachment } from "../../lib/agent-attachments";
import { useAgentPanel } from "../../lib/agent-panel";

/**
 * Hands the row the user is looking at to the agent, so their next sentence can
 * be about it without naming it. Pressing it again on an attached record only
 * reopens the panel, which is where the chip is.
 */
export function AttachButton({ item, size = 12 }: { item: AgentAttachment; size?: number }) {
  const { attach, attachments } = useAgentPanel();
  const isAttached = attachments.some(attachment => attachment.key === item.key);
  return <button
    type="button"
    className="button icon ghost attach-button"
    aria-label={`${isAttached ? "Attached to chat" : "Attach to chat"}: ${item.label}`}
    aria-pressed={isAttached}
    title={isAttached ? "Attached to chat" : "Attach to chat"}
    onClick={event => { event.stopPropagation(); attach(item); }}
    // A board card opens its editor on double-click, and two quick presses here
    // are someone attaching rather than someone opening the card.
    onDoubleClick={event => event.stopPropagation()}
  ><Paperclip size={size}/></button>;
}
