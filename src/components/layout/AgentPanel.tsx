import { AgentStudioChat } from "../../features/chat/AgentStudioChat";
import { LocalChat } from "../../features/chat/LocalChat";
import { PanelConversations } from "../../features/chat/PanelConversations";
import { useAgentPanel } from "../../lib/agent-panel";

/**
 * The agent lives outside the router so a conversation survives navigation.
 * Nothing is mounted until the panel is opened for the first time; after that it
 * is only hidden, because unmounting would throw the conversation away.
 */
export function AgentPanel() {
  const { isOpen, hasOpened, view, isExpanded } = useAgentPanel();
  if (!hasOpened) return null;
  const agentStudioConfigured = Boolean(
    import.meta.env.VITE_ALGOLIA_APPLICATION_ID &&
    import.meta.env.VITE_ALGOLIA_SEARCH_API_KEY &&
    import.meta.env.VITE_ALGOLIA_AGENT_ID,
  );
  // The archive covers the live chat rather than replacing it, so a conversation
  // in progress is still there when you come back from reading an old one.
  const conversations = isOpen && view === "threads" ? <PanelConversations /> : null;
  // Agent Studio brings its own side-panel layout and animates itself; the local
  // fallback needs the drawer built here.
  if (agentStudioConfigured) return <>
    <AgentStudioChat />
    {conversations}
  </>;
  return <>
    <aside
      className="agent-panel"
      data-open={isOpen}
      data-expanded={isExpanded}
      aria-label="Fieldnote agent"
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <LocalChat />
    </aside>
    {conversations}
  </>;
}
