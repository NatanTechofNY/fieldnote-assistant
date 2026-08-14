import { useEffect } from "react";

interface Shortcuts {
  onSearch: () => void;
  onAgent: () => void;
  onDemoMode: () => void;
}

/**
 * App-wide Cmd/Ctrl shortcuts. Both browsers and the OS leave Cmd+K and Cmd+I
 * free in a page context, so `preventDefault` is safe and stops the browser
 * from running its own binding. Demo mode takes Shift as well, because Cmd+D is
 * the browser's own bookmark binding and worth leaving alone.
 */
export function useGlobalShortcuts({ onSearch, onAgent, onDemoMode }: Shortcuts): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "d" && event.shiftKey) {
        event.preventDefault();
        onDemoMode();
        return;
      }
      if (event.shiftKey) return;
      if (key !== "k" && key !== "i") return;
      event.preventDefault();
      if (key === "k") onSearch();
      else onAgent();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSearch, onAgent, onDemoMode]);
}
