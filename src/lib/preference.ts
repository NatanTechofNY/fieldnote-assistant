import { useCallback, useState } from "react";

const PREFIX = "fieldnote:";

/**
 * A setting the page should still be wearing tomorrow. Which view you work in
 * and what you keep hidden are habits, not part of a visit, and having to set
 * them again on every load is the kind of small tax that adds up.
 *
 * Values are matched against the options they are allowed to take, so a stale
 * or hand-edited entry falls back rather than putting the page into a state it
 * has no way to render.
 */
export function usePreference<T extends string | boolean>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(PREFIX + key);
      return allowed.find(option => String(option) === stored) ?? fallback;
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
      return fallback;
    }
  });
  const update = useCallback((next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(PREFIX + key, String(next));
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
    }
  }, [key]);
  return [value, update];
}

export const BOOLEAN: readonly boolean[] = [true, false];
