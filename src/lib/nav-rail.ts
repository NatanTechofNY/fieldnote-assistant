import { useCallback, useMemo, useState } from "react";

const STORAGE_KEY = "fieldnote:nav-collapsed";

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
    return false;
  }
}

export type NavRailState = {
  isCollapsed: boolean;
  toggle: () => void;
};

/**
 * How wide the rail is is a preference about your own screen, not about the
 * page, so it outlives the session the way the theme does.
 */
export function useNavRail(): NavRailState {
  const [isCollapsed, setIsCollapsed] = useState(readStoredCollapsed);
  const toggle = useCallback(() => {
    setIsCollapsed(collapsed => {
      const next = !collapsed;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Browser storage can be unavailable in private or restricted contexts.
      }
      return next;
    });
  }, []);
  return useMemo(() => ({ isCollapsed, toggle }), [isCollapsed, toggle]);
}
