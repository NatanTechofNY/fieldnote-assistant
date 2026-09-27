/*
 * Pictures the assistant sends: GIFs from GIPHY, and images found on a web page
 * it read. A picture goes out as a Sendblue or Twilio attachment, which the
 * provider fetches itself, so the URL has to be public, an image, and small
 * enough; and it has to be one a tool in this conversation turned up, for the
 * same reason a page read is limited to returned links — a URL the model
 * composed could carry the owner's records to a server of someone else's
 * choosing in its query string.
 */

import { rememberLinks, wasReturned } from "./web-service.ts";

const GIPHY_URL = "https://api.giphy.com/v1/gifs/search";
const TIMEOUT_MS = 10_000;
/** Sendblue's cap on an attachment. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Sendblue wants the link to end with the picture's extension. */
const IMAGE_PATH = /\.(jpe?g|png|gif|webp)$/i;

export type GifResult = { id: string; title: string; url: string };

const imageKey = (threadKey: string) => `image:${threadKey}`;

export function giphyConfig(): { apiKey: string } {
  const apiKey = process.env.GIPHY_API_KEY?.trim();
  if (!apiKey) throw new Error("GIF search is not configured");
  return { apiKey };
}

/**
 * GIPHY's `downsized` rendition, which it keeps under 2 MB, with the tracking
 * query string taken off so the link ends in `.gif` the way Sendblue needs.
 */
export async function searchGifs(query: string, limit: number, fetcher: typeof fetch = fetch): Promise<GifResult[]> {
  const { apiKey } = giphyConfig();
  const url = new URL(GIPHY_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("rating", "pg-13");
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`GIPHY did not answer: ${error instanceof Error ? error.message : String(error)}`.replaceAll(apiKey, "…"));
  }
  if (!response.ok) throw new Error(`GIPHY search failed (${response.status})`);
  const json = await response.json() as {
    data?: Array<{ id?: string; title?: string; images?: Record<string, { url?: string } | undefined> }>;
  };
  const results: GifResult[] = [];
  for (const gif of json.data ?? []) {
    const raw = gif.images?.downsized?.url || gif.images?.fixed_height?.url || gif.images?.original?.url;
    if (!gif.id || !raw) continue;
    const link = new URL(raw);
    link.search = "";
    if (link.protocol !== "https:" || !IMAGE_PATH.test(link.pathname)) continue;
    results.push({ id: gif.id, title: (gif.title || "GIF").trim().slice(0, 120), url: link.toString() });
  }
  return results;
}

/** Makes these pictures sendable in this conversation for the next half hour. */
export function rememberImages(threadKey: string, urls: string[]): void {
  rememberLinks(imageKey(threadKey), urls);
}

export function isRememberedImage(threadKey: string, url: string): boolean {
  return wasReturned(imageKey(threadKey), url);
}

/** The https pictures a page's markdown shows, `![alt](url)`, that could go out as an attachment. */
export function imagesInMarkdown(markdown: string): string[] {
  const urls = [...markdown.matchAll(/!\[[^\]]{0,300}\]\((https:\/\/[^)\s]+)/g)].map(match => match[1]);
  return [...new Set(urls.filter(url => {
    try {
      return IMAGE_PATH.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }))].slice(0, 20);
}

/**
 * What the provider will find when it fetches the picture: refused here with
 * a reason the model can act on, rather than as a failed send in the chat.
 */
export async function assertSendableImage(url: string, fetcher: typeof fetch = fetch): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That is not a picture link");
  }
  if (parsed.protocol !== "https:") throw new Error("Only https pictures can be sent");
  if (!IMAGE_PATH.test(parsed.pathname)) {
    throw new Error("The link must end in .jpg, .png, .gif, or .webp to go out as a picture; pick another");
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response = await fetcher(url, { method: "HEAD", signal, redirect: "follow" });
  // Some image hosts answer HEAD with 403 or 405 and GET with the picture.
  if (!response.ok) {
    response = await fetcher(url, { method: "GET", signal, redirect: "follow" });
    void response.body?.cancel();
  }
  if (!response.ok) throw new Error(`The picture could not be fetched (HTTP ${response.status}); pick another`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`That link is ${type || "not"} a picture; pick another`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error("That picture is over 10 MB; pick a smaller one");
}
