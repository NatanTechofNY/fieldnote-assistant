import { Maximize2, Minimize2 } from "lucide-react";
import { useAgentPanel } from "../../lib/agent-panel";

/**
 * Both chats carry this, because a long answer is worth widening whichever agent
 * produced it. The panel floats over the page either way, so the only question is
 * how much of the page it is worth covering to read one.
 */
export function AgentExpandButton() {
  const { isExpanded, toggleExpanded } = useAgentPanel();
  return <button
    type="button"
    className="button icon ghost agent-panel-expand"
    aria-label={isExpanded ? "Collapse the agent panel" : "Expand the agent panel"}
    aria-pressed={isExpanded}
    onClick={toggleExpanded}
  >
    {isExpanded ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}
  </button>;
}
