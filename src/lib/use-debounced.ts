import { useEffect, useState } from "react";

/**
 * Search boxes feed a React Query key, so an undebounced value fires one
 * request per keystroke. Only the value the user stopped typing on is worth
 * sending.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
