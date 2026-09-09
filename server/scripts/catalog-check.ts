/**
 * Pre-demo check for the store catalog. Sendblue fetches every `image_url`
 * itself before attaching it, so a dead link means a card with no picture, and
 * the product links are what the audience taps. Run this the morning of the
 * talk: `npm run catalog:check`. Exits non-zero on the first broken entry.
 *
 * Images are probed with the anonymous library user agents a messaging
 * provider's fetcher presents, not a browser one. The first host we used
 * (Wikimedia) served this script fine and answered those same agents with 403,
 * so two of three demo cards arrived without a picture. A host has to say yes
 * to all of them before it counts.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readStoreCatalog } from "../db.ts";
import { PRODUCT_CATEGORIES } from "../schemas.ts";

const BROWSER_AGENT = "Mozilla/5.0 (compatible; FieldnoteCatalogCheck/1.0)";
const FETCHER_AGENTS = ["axios/1.6.0", "python-requests/2.31.0", "node", "curl/8.4.0"];
const IMAGE_BASE = "https://raw.githubusercontent.com/NatanTechofNY/fieldnote-assistant/main/server/catalog/images/";
const IMAGE_DIR = new URL("../catalog/images/", import.meta.url);
const TIMEOUT_MS = 15_000;

interface Problem { sku: string; field: "image_url" | "product_url"; detail: string }

async function probe(url: string, method: "HEAD" | "GET", userAgent = BROWSER_AGENT): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      headers: { "user-agent": userAgent, accept: "*/*" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Some hosts refuse HEAD; a GET that is cancelled after the headers is as cheap.
 * A 429 is the host asking for patience rather than a broken link, so it is
 * retried with a growing pause before it counts as a problem.
 */
async function fetchHeaders(url: string, userAgent?: string): Promise<Response> {
  let response: Response | null = null;
  for (const pause of [0, 5_000, 15_000]) {
    if (pause) await sleep(pause);
    const head = await probe(url, "HEAD", userAgent).catch(() => null);
    if (head && head.ok) return head;
    response = await probe(url, "GET", userAgent);
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 429) return response;
  }
  return response as Response;
}

async function checkImage(sku: string, url: string): Promise<Problem | null> {
  if (!/^https:\/\//.test(url)) return { sku, field: "image_url", detail: "must be an https URL" };
  if (!/\.(jpe?g|png|gif|webp|heic)$/i.test(new URL(url).pathname)) {
    return { sku, field: "image_url", detail: "Sendblue wants the URL to end with the image's extension" };
  }
  // The published URL serves whatever is on the public repo's main branch, so a
  // file that exists here but was never pushed is the failure this catches.
  if (url.startsWith(IMAGE_BASE)) {
    const file = fileURLToPath(new URL(url.slice(IMAGE_BASE.length), IMAGE_DIR));
    if (!existsSync(file)) return { sku, field: "image_url", detail: `no such file ${file}` };
  }
  try {
    for (const agent of FETCHER_AGENTS) {
      const response = await fetchHeaders(url, agent);
      if (!response.ok) return { sku, field: "image_url", detail: `HTTP ${response.status} for user-agent "${agent}"` };
      const type = response.headers.get("content-type") || "";
      if (!type.startsWith("image/")) return { sku, field: "image_url", detail: `content-type ${type || "missing"}` };
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 10 * 1024 * 1024) return { sku, field: "image_url", detail: `${length} bytes is over the 10 MB cap` };
    }
    return null;
  } catch (error) {
    return { sku, field: "image_url", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkLink(sku: string, url: string): Promise<Problem | null> {
  if (!/^https:\/\//.test(url)) return { sku, field: "product_url", detail: "must be an https URL" };
  try {
    const response = await fetchHeaders(url);
    // Retail sites answer bots with 403 or a challenge page fairly often; that
    // still resolves for a person tapping the link, so only a hard failure counts.
    if (response.status >= 500 || response.status === 404) {
      return { sku, field: "product_url", detail: `HTTP ${response.status}` };
    }
    return null;
  } catch (error) {
    return { sku, field: "product_url", detail: error instanceof Error ? error.message : String(error) };
  }
}

const products = readStoreCatalog();
const problems: Problem[] = [];
const skus = new Set<string>();
for (const product of products) {
  if (skus.has(product.sku)) problems.push({ sku: product.sku, field: "product_url", detail: "duplicate SKU" });
  skus.add(product.sku);
  if (!(PRODUCT_CATEGORIES as readonly string[]).includes(product.category)) {
    problems.push({ sku: product.sku, field: "product_url", detail: `unknown category ${product.category}` });
  }
}
// Sequential on purpose: a burst can trip a host's rate limit, and a false alarm
// the morning of the talk is worse than a slow check.
for (const [index, product] of products.entries()) {
  if (index) await sleep(250);
  const image = await checkImage(product.sku, product.image_url);
  const link = await checkLink(product.sku, product.product_url);
  for (const problem of [image, link]) if (problem) problems.push(problem);
  const mark = image || link ? "FAIL" : "ok  ";
  console.log(`${mark} ${product.sku} ${product.name}`);
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem.sku} ${problem.field}: ${problem.detail}`);
  process.exit(1);
}
console.log(`\nAll ${products.length} catalog entries resolve.`);
