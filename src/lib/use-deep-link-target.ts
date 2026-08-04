import { useSearchParams } from "react-router-dom";

/**
 * Resolves `?open=<id>` against a loaded list, so the command palette can open
 * a specific record on a page that owns its own editor state. Deriving the
 * target from the URL means the link survives a refresh, and clearing it on
 * close leaves a shareable page URL behind.
 */
export function useDeepLinkTarget<T extends { id: string }>(items: T[]): {
  target: T | undefined;
  clear: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedId = searchParams.get("open");
  return {
    target: requestedId ? items.find(item => item.id === requestedId) : undefined,
    clear: () => {
      if (!requestedId) return;
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      setSearchParams(next, { replace: true });
    },
  };
}
