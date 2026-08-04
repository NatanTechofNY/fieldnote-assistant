import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "fieldnote:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

// The browser chrome around the app is tinted from these, so they track the
// `--bg` token of each theme block.
const themeColor: Record<ResolvedTheme, string> = { light: "#f7f8f9", dark: "#101113" };

const isPreference = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

function readStoredPreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(saved) ? saved : "system";
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
    return "system";
  }
}

function prefersDark(): boolean {
  return Boolean(window.matchMedia?.(DARK_QUERY).matches);
}

export type ThemeState = {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
};

export const ThemeContext = createContext<ThemeState>({
  preference: "system",
  theme: "light",
  setPreference: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export function useThemeState(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => (prefersDark() ? "dark" : "light"));
  // Following the OS only matters while the preference is "system", but the
  // listener is unconditional so switching back to it is already in sync.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const sync = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? "dark" : "light");
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const theme: ResolvedTheme = preference === "system" ? systemTheme : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[theme]);
  }, [theme]);
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
    }
  }, []);
  return useMemo(() => ({ preference, theme, setPreference }), [preference, theme, setPreference]);
}
