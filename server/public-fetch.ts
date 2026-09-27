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

/** The eight 16-bit groups of an IPv6 address, a trailing dotted IPv4 part included. */
function v6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const [a, b, c, d] = dotted.split(".").map(Number);
    text = text.slice(0, -dotted.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const v4Of = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/*
 * IPv6 is decoded rather than matched as text: the URL parser writes
 * [::ffff:127.0.0.1] as [::ffff:7f00:1], and NAT64, 6to4, and the old
 * IPv4-compatible form all carry an IPv4 address that is judged as one.
 */
function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address);
  const groups = v6Groups(address);
  if (!groups) return true;
  const zeroPrefix = (count: number) => groups.slice(0, count).every(group => group === 0);
  if (zeroPrefix(8)) return true;
  if (zeroPrefix(7) && groups[7] === 1) return true;
  if (zeroPrefix(5) && groups[5] === 0xffff) return privateV4(v4Of(groups[6], groups[7]));
  if (zeroPrefix(6)) return privateV4(v4Of(groups[6], groups[7]));
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return privateV4(v4Of(groups[6], groups[7]));
  if (groups[0] === 0x2002) return privateV4(v4Of(groups[1], groups[2]));
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 // unique local
    || (first & 0xffc0) === 0xfe80 // link-local
    || (first & 0xff00) === 0xff00 // multicast
    || first === 0x100 // discard
    || (first === 0x2001 && groups[1] === 0xdb8) // documentation
    || (first === 0x2001 && groups[1] === 0); // Teredo
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
