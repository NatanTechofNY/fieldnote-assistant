import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { localParts } from "./local-time.ts";

/*
 * Web search and page reading through Bright Data's hosted MCP server, whose
 * free tier covers `search_engine` and `scrape_as_markdown`. The server is the
 * MCP client here, not Agent Studio: added to the agent as an MCP tool, it
 * would run outside the executor, so none of the checks below would apply and
 * a group chat could reach it unfenced.
 */

const MCP_URL = "https://mcp.brightdata.com/mcp";
/**
 * One budget for the whole call — initialize, the initialized notification,
 * and the tool call — under the browser's 20s tool deadline with room for the
 * round trip back. The unlocker solves bot checks before it answers, so a tight
 * budget would fail pages that are merely guarded.
 */
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * The SDK reads and parses a whole response before anything here can cut it,
 * so a page is refused past this size rather than held in memory to keep 6 KB.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_TEXT_LIMIT = 6000;
const SNIPPET_LIMIT = 300;
/** How long a search result stays readable: long enough for a slow turn and its retries. */
const RESULT_TTL_MS = 30 * 60_000;
const DEFAULT_DAILY_LIMIT = 100;
/** The part of the day's lookups every group chat together may use; the rest is the owner's. */
const GROUP_SHARE = 0.25;

export type WebResult = { title: string; url: string; snippet: string };

/**
 * Every failure this module reports. Its message is already free of the token
 * and ready for the model; `timedOut` marks a call Bright Data may still have
 * run and billed, which keeps its place in the day's count.
 */
export class WebServiceError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, options: { cause?: unknown; timedOut?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = "WebServiceError";
    this.timedOut = options.timedOut ?? false;
  }
}

/** Checked before a lookup is counted, so an unconfigured app spends none of the day's allowance. */
export function webConfig(): { token: string } {
  const token = process.env.BRIGHTDATA_API_TOKEN?.trim();
  if (!token) throw new Error("Web access is not configured");
  return { token };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Errors a byte stream once it passes the cap, whatever the headers claimed. */
function capped(response: Response): Response {
  if (!response.body || [101, 204, 205, 304].includes(response.status)) return response;
  let seen = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) {
        controller.error(new WebServiceError(`Bright Data returned more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`));
      } else {
        controller.enqueue(chunk);
      }
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The WebServiceError somewhere in a chain of causes, when the SDK wrapped one of ours. */
function ownError(error: unknown): WebServiceError | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof WebServiceError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * One MCP session per call: connect, call the tool, close. A lookup is rare
 * enough that the extra initialize round trip costs less than keeping a
 * session alive that the server may already have expired.
 */
async function callTool(
  tool: string,
  args: Record<string, string>,
  what: string,
  maxChars = Number.POSITIVE_INFINITY,
): Promise<string> {
  const { token } = webConfig();
  // The token rides in the URL, percent-encoded, so both spellings are scrubbed.
  const scrub = (text: string) => text.replaceAll(token, "…").replaceAll(encodeURIComponent(token), "…");
  const timeoutMs = envNumber("BRIGHTDATA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const url = new URL(MCP_URL);
  url.searchParams.set("token", token);
  const client = new Client({ name: "fieldnote", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    // Every request the SDK makes shares the deadline, including the initialized
    // notification, which the SDK sends with no timeout of its own.
    fetch: async (input, init) => capped(await fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    })),
  });
  try {
    const options = { signal: deadline, timeout: timeoutMs };
    await client.connect(transport, options);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, options);
    let text = "";
    for (const part of Array.isArray(result.content) ? result.content : []) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      text += (text ? "\n" : "") + part.text;
      if (text.length > maxChars) break;
    }
    if (result.isError) throw new WebServiceError(`Bright Data ${what} failed: ${scrub(text).slice(0, 300) || "no detail"}`);
    return text;
  } catch (error) {
    const own = ownError(error);
    if (own) throw own;
    if (deadline.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) {
      throw new WebServiceError(`Bright Data did not respond within ${timeoutMs / 1000}s (${what})`, { cause: error, timedOut: true });
    }
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new WebServiceError(`Bright Data rejected the API token (${error.code})`, { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WebServiceError(`Bright Data ${what} failed: ${scrub(message).slice(0, 300)}`, { cause: error });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Organic Google results on public https pages, trimmed to what the model needs to pick one. */
export async function searchWeb(query: string, limit: number): Promise<WebResult[]> {
  const raw = await callTool("search_engine", { query, engine: "google" }, "search");
  let organic: Array<Record<string, unknown>>;
  try {
    organic = (JSON.parse(raw) as { organic?: Array<Record<string, unknown>> }).organic || [];
  } catch {
    // Google comes back as JSON; any other engine, or a format change, as markdown links.
    organic = [...raw.matchAll(/\[([^\]\n]{1,300})\]\((https:\/\/[^)\s]+)\)/g)]
      .map(match => ({ title: match[1], link: match[2] }));
  }
  return organic
    .map(hit => ({
      title: String(hit.title ?? "").trim(),
      url: String(hit.link ?? hit.url ?? "").trim(),
      snippet: String(hit.description ?? hit.snippet ?? "").trim().slice(0, SNIPPET_LIMIT),
    }))
    .filter(hit => hit.title && isPublicUrl(hit.url))
    .slice(0, limit);
}

/** One page as markdown, cut to a size a text-message turn can afford. */
export async function readWebPage(url: string): Promise<{ text: string; truncated: boolean }> {
  const text = (await callTool("scrape_as_markdown", { url }, "page read", PAGE_TEXT_LIMIT)).trim();
  return text.length > PAGE_TEXT_LIMIT
    ? { text: text.slice(0, PAGE_TEXT_LIMIT), truncated: true }
    : { text, truncated: false };
}

/*
 * Links a search returned, per conversation. Reading is limited to these so the
 * model can never fetch a URL it composed itself — a result with the owner's
 * records appended to its query string. What the model puts in a search query
 * is a separate path, and only the prompt guards that one.
 */
const returned = new Map<string, Map<string, number>>();

export function rememberResults(key: string, results: WebResult[]): void {
  const now = Date.now();
  // A sweep on every write keeps threads that stopped searching from staying in memory.
  for (const [thread, links] of returned) {
    for (const [link, expires] of links) if (expires <= now) links.delete(link);
    if (!links.size) returned.delete(thread);
  }
  if (!results.length) return;
  const links = returned.get(key) ?? new Map<string, number>();
  for (const result of results) links.set(result.url, now + RESULT_TTL_MS);
  returned.set(key, links);
}

export function wasReturned(key: string, url: string): boolean {
  const expires = returned.get(key)?.get(url);
  return expires !== undefined && expires > Date.now();
}

function isPublicUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // The WHATWG parser keeps a trailing dot, and "localhost." is still localhost.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  return !(
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
    || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")
  );
}

/**
 * The page a read may fetch: https to a named, non-local host. Bright Data does
 * the fetching from its own network, so this is not what keeps the app's
 * network out of reach; it keeps obvious local and internal targets from being
 * asked for at all. A name that merely resolves to a private address passes.
 */
export function assertPublicUrl(url: string): void {
  if (!/^https:/i.test(url.trim())) throw new Error("Only https pages can be read");
  if (!isPublicUrl(url)) throw new Error("Only public web pages can be read");
}

/*
 * A spending guard across both tools. Group chats together may use only a
 * share of the day, so the people in them cannot spend the owner's allowance.
 * The app runs as one process, so these counters are the whole count; a
 * restart resets them, which errs toward a working assistant.
 */
let usage = { day: "", calls: 0, groupCalls: 0 };

/**
 * Counts one lookup and returns how to give it back. A call that failed before
 * Bright Data could have done the work — a refused token, an upstream error —
 * is returned; one that timed out keeps its place, since it may have been billed.
 */
export function takeWebCall(timezone: string, inGroup: boolean): () => void {
  const limit = Math.floor(envNumber("BRIGHTDATA_DAILY_LIMIT", DEFAULT_DAILY_LIMIT));
  if (limit === 0) throw new Error("Web access is turned off");
  const day = localParts(new Date(), timezone).date;
  if (usage.day !== day) usage = { day, calls: 0, groupCalls: 0 };
  if (usage.calls >= limit) {
    throw new Error(`Web access has reached its limit of ${limit} lookups for today`);
  }
  const groupLimit = Math.max(1, Math.floor(limit * GROUP_SHARE));
  if (inGroup && usage.groupCalls >= groupLimit) {
    throw new Error(`Web access has reached its limit of ${groupLimit} lookups for today in group chats`);
  }
  usage.calls += 1;
  if (inGroup) usage.groupCalls += 1;
  const counted = usage;
  let released = false;
  return () => {
    if (released || usage !== counted) return;
    released = true;
    usage.calls -= 1;
    if (inGroup) usage.groupCalls -= 1;
  };
}

/** Clears the per-conversation links and the day's count; tests start from nothing. */
export function resetWebState(): void {
  returned.clear();
  usage = { day: "", calls: 0, groupCalls: 0 };
}
