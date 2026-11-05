import type { Request } from "express";
import { throttleKey } from "./auth.ts";

/**
 * A sliding-window counter per caller, for the public endpoints that have no
 * session to hang a limit on. The caller is the socket peer, not `req.ip`,
 * which follows X-Forwarded-For and so is whatever the sender says it is.
 */
export function slidingWindow(limit: number, windowMs: number): {
  exceeded: (req: Request, scope?: string) => boolean;
  clear: () => void;
} {
  const hits = new Map<string, number[]>();
  return {
    exceeded(req, scope = "") {
      const key = `${scope}|${throttleKey(req)}`;
      const cutoff = Date.now() - windowMs;
      const recent = (hits.get(key) ?? []).filter(at => at > cutoff);
      if (hits.size > 2000) {
        for (const [candidate, times] of hits) if (!times.some(at => at > cutoff)) hits.delete(candidate);
      }
      if (recent.length >= limit) {
        hits.set(key, recent);
        return true;
      }
      hits.set(key, [...recent, Date.now()]);
      return false;
    },
    clear: () => hits.clear(),
  };
}
