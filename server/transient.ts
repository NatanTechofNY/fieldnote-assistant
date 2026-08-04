/**
 * A failure that says nothing about whether the request itself was valid: the
 * connection dropped, the machine slept mid-flight, or the provider asked us to
 * come back later. Scheduled work retries these rather than spending the one
 * slot it gets per day, which is the difference between a laptop that happened
 * to be asleep at 08:00 and a digest brief whose Jira query no longer resolves.
 */
export class TransientFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientFailure";
  }
}

/**
 * undici surfaces a dropped connection as `TypeError: fetch failed` and keeps
 * the reason on `cause.code`, so the code is what this matches on. Sniffing
 * messages instead would tie retry behaviour to wording we do not control.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Depth limit so a self-referencing `cause` cannot spin here forever. */
const MAX_CAUSE_DEPTH = 5;

export function isTransientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof TransientFailure) return true;
    // An aborted request is our own deadline firing, not a rejected request.
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    // The exact shape undici throws when it never reached the other end. Matched
    // on type and full message so a real TypeError elsewhere is not swept up.
    if (current instanceof TypeError && current.message === "fetch failed") return true;
    current = current.cause;
  }
  return false;
}
