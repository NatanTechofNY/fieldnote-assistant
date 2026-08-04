import { Bot, Search } from "lucide-react";
import { useAgentPanel } from "../../lib/agent-panel";

/**
 * Finding something and asking for something are the same gesture — you say what
 * you want — so they share one control that floats over the page instead of two
 * separate rows in a sidebar that was collecting them.
 *
 * The labels collapse on narrow screens, so the accessible names are spelled out
 * rather than assembled from the visible text, and the agent's icon only appears
 * once its name is gone: with the name there, the icon is a second way of saying
 * the same thing.
 */
export function AskLauncher({ onSearch }: { onSearch: () => void }) {
  const panel = useAgentPanel();
  return <div className="ask-launcher">
    <button type="button" aria-label="Search everything" onClick={onSearch}>
      <Search size={13}/><span>Search</span><kbd>⌘K</kbd>
    </button>
    <button type="button" className="ask-launcher-agent" aria-label="Ask Fieldnote, the agent" onClick={panel.toggle}>
      <Bot size={14} className="ask-launcher-glyph"/><span>Ask Fieldnote</span><kbd>⌘I</kbd>
    </button>
  </div>;
}
