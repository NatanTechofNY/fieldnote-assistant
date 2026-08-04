import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { Db } from "./types.ts";

export const SESSION_COOKIE = "fieldnote_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export function configuredPassword(): string {
  return process.env.APP_ADMIN_PASSWORD ?? "";
}

export function authEnabled(): boolean {
  return configuredPassword().length > 0;
}

// A per-process salt is enough: both sides of the comparison are derived in
// this process, and the password itself is never stored.
const salt = randomBytes(16);
let derived: { password: string; key: Buffer } | null = null;

function expectedKey(password: string): Buffer {
  if (!derived || derived.password !== password) {
    derived = { password, key: scryptSync(password, salt, 32) };
  }
  return derived.key;
}

/** Verifies a submitted password. scrypt makes each guess deliberately slow. */
export function verifyPassword(candidate: string): boolean {
  const password = configuredPassword();
  if (!password) return false;
  return timingSafeEqual(expectedKey(password), scryptSync(candidate, salt, 32));
}

export function verifyBasicAuth(header: string | undefined): boolean {
  const password = configuredPassword();
  if (!password || !header) return false;
  const expected = Buffer.from(`Basic ${Buffer.from(`admin:${password}`).toString("base64")}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/* Failed-attempt throttling ------------------------------------------------ */

type Attempt = { failures: number; lockedUntil: number };
const attempts = new Map<string, Attempt>();

/**
 * Keys throttling on the real socket peer rather than `req.ip`, because
 * `trust proxy` makes `req.ip` attacker-controlled via X-Forwarded-For.
 */
export function throttleKey(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function lockoutMsRemaining(key: string): number {
  const entry = attempts.get(key);
  return entry ? Math.max(0, entry.lockedUntil - Date.now()) : 0;
}

export function recordFailure(key: string): void {
  if (attempts.size > 1000) {
    const now = Date.now();
    for (const [candidate, entry] of attempts) {
      if (entry.lockedUntil < now) attempts.delete(candidate);
    }
  }
  const entry = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.failures = 0;
  }
  attempts.set(key, entry);
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}

export function resetThrottling(): void {
  attempts.clear();
}

/* Sessions ----------------------------------------------------------------- */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Returns a new session token. Only its hash is stored, so a leaked database
 * cannot be replayed as a live session.
 */
export function createSession(db: Db, userAgent?: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  db.prepare(`
    INSERT INTO sessions(token_hash, created_at, expires_at, last_seen_at, user_agent)
    VALUES(?,?,?,?,?)
  `).run(
    hashToken(token),
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    now.toISOString(),
    userAgent?.slice(0, 200) ?? null,
  );
  return token;
}

export function validateSession(db: Db, token: string | undefined): boolean {
  if (!token) return false;
  const nowIso = new Date().toISOString();
  const row = db.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
  ).get(hashToken(token), nowIso) as { token_hash: string } | undefined;
  if (!row) return false;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso, row.token_hash);
  return true;
}

export function destroySession(db: Db, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function pruneExpiredSessions(db: Db): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

/** Invalidates every session, used when the configured password changes. */
export function destroyAllSessions(db: Db): void {
  db.prepare("DELETE FROM sessions").run();
}

/* Cookies ------------------------------------------------------------------ */

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/**
 * `Secure` is set only for HTTPS requests: a great many installs are a LAN box
 * served over plain HTTP, where a Secure cookie would be silently dropped.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/* Login page --------------------------------------------------------------- */

/** Only same-origin paths are accepted, so `next` cannot become an open redirect. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string
  ));
}

export function loginPage(options: { next: string; error?: string }): string {
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in &middot; Fieldnote</title>
<style>
  :root {
    --paper: #f6f2e8; --ink: #192019; --muted: #6f756c;
    --line: #d8d1bf; --signal: #ff5a36;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #ebe6d8; color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: 100%; max-width: 380px; background: var(--paper);
    border: 1px solid var(--line); border-radius: 14px; padding: 32px;
    box-shadow: 0 12px 32px rgb(25 32 25 / 8%);
  }
  h1 { margin: 0 0 4px; font-size: 1.4rem; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: .9rem; }
  label { display: block; font-size: .82rem; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 9px;
    background: #fff; color: var(--ink); font-size: 1rem;
  }
  input:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 18px; padding: 11px 14px; border: 0; border-radius: 9px;
    background: var(--ink); color: var(--paper); font-size: .95rem; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #2c372c; }
  .error {
    margin: 0 0 18px; padding: 10px 12px; border-radius: 9px; font-size: .85rem;
    background: #fdece7; border: 1px solid #f6c6b8; color: #8c2c12;
  }
</style>
</head>
<body>
  <main>
    <h1>Fieldnote</h1>
    <p class="sub">Enter your password to continue.</p>
    ${error}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(options.next)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}
