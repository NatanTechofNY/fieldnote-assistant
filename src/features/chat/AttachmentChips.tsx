import { Brain, Check, CornerDownRight, ListTodo, X } from "lucide-react";
import type { AgentAttachmentType } from "../../lib/agent-attachments";
import { useAgentPanel } from "../../lib/agent-panel";

const typeMeta: Record<AgentAttachmentType, { icon: typeof ListTodo; label: string }> = {
  todo: { icon: ListTodo, label: "Task" },
  subtask: { icon: CornerDownRight, label: "Subtask" },
  memory: { icon: Brain, label: "Memory" },
  "completed-task": { icon: Check, label: "Completed task" },
};

/**
 * Sits above the composer as the widget's prompt header. What is attached has to
 * be visible before the message is sent, because the records travel as turn
 * context rather than as text the user can read back in their own sentence.
 *
 * The widget's header slot is typed as always returning an element, so nothing
 * attached renders nothing at all and the wrapper is hidden while `:empty`.
 */
export function AttachmentChips() {
  const { attachments, detach } = useAgentPanel();
  if (!attachments.length) return <></>;
  return <div className="agent-attachments">
    {attachments.map(attachment => {
      const meta = typeMeta[attachment.type];
      const Icon = meta.icon;
      return <span className="agent-attachment-chip" key={attachment.key}>
        <Icon size={12} aria-hidden="true"/>
        <span className="agent-attachment-kind">{meta.label}</span>
        <span className="agent-attachment-label">{attachment.label}</span>
        <button
          type="button"
          aria-label={`Remove ${attachment.label} from the message`}
          onClick={() => detach(attachment.key)}
        ><X size={11}/></button>
      </span>;
    })}
  </div>;
}
