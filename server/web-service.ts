import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
 * Under the browser's 20s tool deadline, with room for the round trip back.
 * The unlocker solves bot checks before it answers, so it is slower than a
 * plain fetch and a tight budget would fail pages that are merely guarded.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_TEXT_LIMIT = 6000;
const SNIPPET_LIMIT = 300;
/** How long a search result stays readable: long enough for a slow turn and its retries. */
const RESULT_TTL_MS = 30 * 60_000;
const DEFAULT_DAILY_LIMIT = 100;

export type WebResult = { title: string; url: string; snippet: string };

/** Checked before a lookup is counted, so an unconfigured app spends none of the day's allowance. */
export function webConfig(): { token: string } {
  const token = process.env.BRIGHTDATA_API_TOKEN?.trim();
  if (!token) throw new Error("Web access is not configured");
  return { token };
}

/**
 * One MCP session per call: connect, call the tool, close. A lookup is rare
 * enough that the extra initialize round trip costs less than keeping a
 * session alive that the server may already have expired.
 */
async function callTool(tool: string, args: Record<string, string>, what: string): Promise<string> {
  const { token } = webConfig();
  const url = new URL(MCP_URL);
  url.searchParams.set("token", token);
  const client = new Client({ name: "fieldnote", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    // Read at call time so a test's stubbed fetch is the one used.
    fetch: (input, init) => fetch(input, init),
  });
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
    if (result.isError) throw new Error(`Bright Data ${what} failed: ${text.slice(0, 300) || "no detail"}`);
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Bright Data ")) throw error;
    // The token rides in the URL, so the SDK's own wording is passed on but never the endpoint.
    const detail = message.replaceAll(token, "…").slice(0, 300);
    if (/\b401\b|unauthori[sz]ed/i.test(detail)) throw new Error("Bright Data rejected the API token (401)", { cause: error });
    if (/timed? ?out|timeout/i.test(detail)) {
      throw new Error(`Bright Data did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${what})`, { cause: error });
    }
    throw new Error(`Bright Data ${what} failed: ${detail}`, { cause: error });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Organic Google results, trimmed to what the model needs to pick a page. */
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
    .filter(hit => hit.title && /^https:\/\//.test(hit.url))
    .slice(0, limit);
}

/** One page as markdown, cut to a size a text-message turn can afford. */
export async function readWebPage(url: string): Promise<{ text: string; truncated: boolean }> {
  const text = (await callTool("scrape_as_markdown", { url }, "page read")).trim();
  return text.length > PAGE_TEXT_LIMIT
    ? { text: text.slice(0, PAGE_TEXT_LIMIT), truncated: true }
    : { text, truncated: false };
}

/*
 * Links a search returned, per conversation. Reading is limited to these so the
 * model can never fetch a URL it composed itself, which is the one way a page
 * read could carry the owner's records off to a server of someone's choosing.
 */
const returned = new Map<string, Map<string, number>>();

export function rememberResults(key: string, results: WebResult[]): void {
  const now = Date.now();
  const links = returned.get(key) ?? new Map<string, number>();
  for (const [link, expires] of links) if (expires <= now) links.delete(link);
  for (const result of results) links.set(result.url, now + RESULT_TTL_MS);
  returned.set(key, links);
}

export function wasReturned(key: string, url: string): boolean {
  const expires = returned.get(key)?.get(url);
  return expires !== undefined && expires > Date.now();
}

/**
 * The page a read may fetch: https to a named public host. A search result
 * already passed this, so it only refuses what an allowlist could not catch
 * by itself — a result that points at the app's own network.
 */
export function assertPublicUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only https pages can be read");
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
    || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")
  ) {
    throw new Error("Only public web pages can be read");
  }
}

/*
 * A spending guard, shared by both tools and anyone who can text the
 * assistant. The app runs as one process, so a counter here is the whole
 * count; a restart resets it, which errs toward a working assistant.
 */
let usage = { day: "", calls: 0 };

export function takeWebCall(timezone: string): void {
  const limit = Number(process.env.BRIGHTDATA_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const day = localParts(new Date(), timezone).date;
  if (usage.day !== day) usage = { day, calls: 0 };
  if (usage.calls >= limit) {
    throw new Error(`Web access has reached its limit of ${limit} lookups for today`);
  }
  usage.calls += 1;
}

/** Clears the per-conversation links and the day's count; tests start from nothing. */
export function resetWebState(): void {
  returned.clear();
  usage = { day: "", calls: 0 };
}
