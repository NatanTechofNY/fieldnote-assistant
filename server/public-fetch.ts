/*
 * Fetches this server makes to a URL someone else chose: a picture on a web
 * page the agent read, or an attachment a provider hands us. Unlike a page
 * read, which Bright Data fetches from its own network, these leave from ours,
 * so every hop — the URL and each redirect — must resolve to a public address,
 * or a page could point the check at the metadata service or the LAN.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type Resolver = (host: string) => Promise<string[]>;

const MAX_REDIRECTS = 3;

let resolveHost: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address);

/** Tests have no DNS; they stand in a resolver. */
export function setHostResolver(resolver: Resolver | null): void {
  resolveHost = resolver ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address));
}

function privateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address);
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return privateV4(mapped);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

/** Refuses a URL that is not https or whose host resolves to any non-public address. */
export async function assertPublicHost(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That is not a link");
  }
  if (parsed.protocol !== "https:") throw new Error("Only https links can be fetched");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => []);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error("That link does not point at a public address");
  return parsed;
}

/**
 * A fetch that checks the host before every hop instead of letting redirects
 * run unchecked. The final response is returned whatever its status.
 */
export async function publicFetch(url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  let next = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(next);
    const response = await fetcher(next, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    void response.body?.cancel();
    next = new URL(location, next).toString();
  }
  throw new Error("That link redirects too many times");
}

/** The body, refused once it passes `limit` bytes whatever the headers claimed. */
export async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) {
    void response.body?.cancel();
    throw new Error(`larger than ${Math.round(limit / 1024 / 1024)} MB`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > limit) {
      void reader.cancel();
      throw new Error(`larger than ${Math.round(limit / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
