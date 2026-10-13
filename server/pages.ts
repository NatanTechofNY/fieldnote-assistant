/**
 * Hosted pages: a title and a list of blocks behind an unguessable link.
 *
 * Everything lives in SQLite (`shared_pages`, `page_votes`, `page_events`) and
 * none of it is searched, so nothing here queues an index job. A page shows
 * live data (todos, streaks, moods) by reading SQLite when it is opened; the
 * rows are never copied into the page. What a page may show is decided by its
 * `audience` and `life_area_id` when it is rendered, see `server/page-render.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import { id, now, USER_ID } from "./db.ts";
import { groupMembers } from "./group-members.ts";
import { getNotificationPreferences, getSendbluePublicConfig, getTwilioPublicConfig } from "./integrations.ts";
import { PAGE_BLOCK_TYPES, type TODO_BLOCK_RANGES, type pageBlockInput } from "./schemas.ts";
import type { Db } from "./types.ts";

/** `code` is `name`, `closed`, `full`, or `option` for a public form's notice, `not_found` for a missing page, else `invalid`. */
export class PageError extends Error {
  code: string;
  constructor(message: string, code = "invalid") {
    super(message);
    this.code = code;
  }
}

export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];
export type PageAudience = "owner" | "shared";
export type PageKind = "today" | "week" | "custom" | "poll";

/** A block as it is stored: only the fields its type uses are present. */
export type PageBlock = {
  type: PageBlockType;
  id?: string;
  text?: string;
  items?: string[];
  slots?: string[];
  url?: string;
  range?: (typeof TODO_BLOCK_RANGES)[number];
  multi?: boolean;
  closes_at?: string;
  when?: string;
  todo_id?: string;
  days?: number;
};

export type PageRow = {
  id: string;
  user_id: string;
  slug: string;
  kind: PageKind;
  template: string | null;
  title: string;
  blocks_json: string;
  audience: PageAudience;
  life_area_id: string | null;
  thread_id: string | null;
  group_id: string | null;
  dedupe_key: string | null;
  expires_at: string;
  revoked_at: string | null;
  results_posted_at: string | null;
  nudged_at: string | null;
  echoed_at: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const VOTER_NAME_MAX = 40;
/** Most distinct names a page holds, so a link in the wrong hands cannot stuff a poll without end. */
export const MAX_VOTERS = 100;

/** Blocks a viewer can write to: they carry a stable id the vote or check is filed under. */
export const INTERACTIVE_BLOCKS = new Set<PageBlockType>(["poll", "availability", "live_checklist"]);
/** Blocks that read the owner's or a group's records when the page is opened. */
export const RECORD_BLOCKS = new Set<PageBlockType>([
  "todos", "live_checklist", "progress", "habits", "mood_chart", "mood_heatmap",
]);

/* Links -------------------------------------------------------------------- */

/** The origin pages are served from: `PUBLIC_BASE_URL`, else the URL a provider's webhooks already use. */
export function publicBaseUrl(db: Db): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  const preferences = getNotificationPreferences(db);
  const candidates = [
    configured,
    preferences.smsProvider === "sendblue"
      ? getSendbluePublicConfig(db).webhookBaseUrl : getTwilioPublicConfig(db).webhookBaseUrl,
    getSendbluePublicConfig(db).webhookBaseUrl,
    getTwilioPublicConfig(db).webhookBaseUrl,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // A malformed value is skipped; the next source may be fine.
    }
  }
  return null;
}

export const NO_BASE_URL = "Pages need a public address to link to. Set PUBLIC_BASE_URL in the server environment, or save a webhook URL under Message provider in Settings.";

export function publicPageUrl(db: Db, slug: string): string {
  const base = publicBaseUrl(db);
  if (!base) throw new PageError(NO_BASE_URL);
  return `${base}/p/${slug}`;
}

export function tryPublicPageUrl(db: Db, slug: string): string | null {
  const base = publicBaseUrl(db);
  return base ? `${base}/p/${slug}` : null;
}

const SLUG_IN_TEXT = /\/p\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;

/** Owner-only pages whose link appears in `text`. */
export function ownerPagesLinkedIn(db: Db, text: string): PageRow[] {
  const found: PageRow[] = [];
  for (const match of text.matchAll(SLUG_IN_TEXT)) {
    const row = getPageBySlug(db, match[1]);
    if (row && row.audience === "owner" && !found.some(page => page.id === row.id)) found.push(row);
  }
  return found;
}

/** Refuses a message that would hand an owner-only page's link to anyone but the owner. */
export function assertNoOwnerPageLinks(db: Db, text: string): void {
  const owned = ownerPagesLinkedIn(db, text);
  if (owned.length) {
    throw new PageError(
      `"${owned[0].title}" is a private page that only opens for the owner, so its link cannot be sent to anyone else. `
      + "Make a shared page for them instead: create_page with audience shared.",
    );
  }
}

/* Blocks ------------------------------------------------------------------- */

const shortHash = (text: string): string =>
  createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 6);

/** An option's id comes from its words, so editing a poll keeps the votes for the options that survive. */
export const optionId = (label: string): string => `o${shortHash(label)}`;

export type PageOption = { id: string; label: string };

export function blockOptions(block: PageBlock): PageOption[] {
  const seen = new Set<string>();
  const unique = (candidate: string): string => {
    let next = candidate;
    for (let n = 2; seen.has(next); n += 1) next = `${candidate}${n}`;
    seen.add(next);
    return next;
  };
  if (block.type === "poll") {
    return (block.items ?? []).map(label => ({ id: unique(optionId(label)), label }));
  }
  if (block.type === "availability") {
    const days = block.items ?? [];
    const slots = block.slots ?? [];
    if (!slots.length) return days.map(day => ({ id: unique(optionId(day)), label: day }));
    return days.flatMap(day => slots.map(slot => ({
      id: unique(`${optionId(day)}-${optionId(slot)}`), label: `${day} · ${slot}`,
    })));
  }
  return [];
}

const httpsOnly = (value: string, what: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PageError(`${what} is not a link`);
  }
  if (url.protocol !== "https:") throw new PageError(`${what} must be an https link`);
  return url.toString();
};

function dropEmpty(block: Record<string, unknown>): PageBlock {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === "string" && !value.trim()) continue;
    out[key] = value;
  }
  return out as PageBlock;
}

/**
 * Holds each block to the fields its type needs and fills in the ids the
 * interactive ones are addressed by. The tool schema allows every field on
 * every block, because strict mode asks for that; this is where "a poll needs
 * a question and two options" is enforced.
 */
export function normalizeBlocks(inputs: Array<z.infer<typeof pageBlockInput>>): PageBlock[] {
  const counters = new Map<string, number>();
  const ids = new Set<string>();
  return inputs.map((input, index) => {
    const block = dropEmpty(input);
    const where = `Block ${index + 1} (${block.type})`;
    const need = (condition: unknown, message: string) => {
      if (!condition) throw new PageError(`${where} ${message}`);
    };
    switch (block.type) {
      case "heading":
      case "text":
        need(block.text, "needs text");
        break;
      case "checklist":
        need(block.items?.length, "needs items");
        break;
      case "link":
        need(block.url, "needs a url");
        block.url = httpsOnly(block.url as string, `${where} url`);
        break;
      case "image":
        need(block.url, "needs a url");
        block.url = httpsOnly(block.url as string, `${where} url`);
        break;
      case "todos":
        need(block.range, "needs a range: today, week, overdue, or done_week");
        break;
      case "poll":
        need(block.text, "needs the question in text");
        need(block.items && block.items.length >= 2 && block.items.length <= 10, "needs 2 to 10 options in items");
        break;
      case "availability":
        need(block.items?.length, "needs the days in items, such as \"Thu Oct 15\"");
        need((block.items?.length ?? 0) * Math.max(block.slots?.length ?? 0, 1) <= 80, "has too many cells; use fewer days or slots");
        break;
      case "live_checklist":
      case "progress":
        need(block.todo_id, "needs todo_id, the parent todo whose subtasks it shows");
        break;
      case "countdown":
        need(block.when, "needs when");
        need(block.text, "needs a label in text");
        break;
      case "itinerary":
        need(block.items?.length, "needs items like \"Fri 7pm | Dinner at Lucia's\"");
        break;
      case "stats":
        need(block.items?.length, "needs items like \"Done | 12\"");
        break;
      case "rotation":
        need(block.items && block.items.length >= 2, "needs at least two names in items");
        need(block.text, "needs the chore in text");
        break;
      default:
        break;
    }
    if (INTERACTIVE_BLOCKS.has(block.type)) {
      const next = (counters.get(block.type) ?? 0) + 1;
      counters.set(block.type, next);
      block.id = block.id?.replace(/[^A-Za-z0-9_-]/g, "") || `${block.type}${next}`;
      need(!ids.has(block.id), `repeats the id ${block.id}`);
      ids.add(block.id);
    } else {
      delete block.id;
    }
    if (block.type !== "poll" && block.type !== "availability" && block.type !== "live_checklist") delete block.multi;
    return block;
  });
}

export function pageBlocks(row: PageRow): PageBlock[] {
  try {
    const parsed = JSON.parse(row.blocks_json) as unknown;
    return Array.isArray(parsed) ? parsed as PageBlock[] : [];
  } catch {
    return [];
  }
}

/** Whether the page asks the viewer for a vote, so it is a poll rather than a read-only page. */
export const hasVoting = (blocks: PageBlock[]): boolean =>
  blocks.some(block => block.type === "poll" || block.type === "availability");

/** Pages that read records may not be shared outside a group unless they are filed under that group's area. */
export function assertRecordsAllowed(blocks: PageBlock[], audience: PageAudience, lifeAreaId: string | null): void {
  if (audience !== "shared" || lifeAreaId) return;
  const offending = blocks.find(block => RECORD_BLOCKS.has(block.type));
  if (offending) {
    throw new PageError(
      `A shared page cannot show your own records (${offending.type} block). Name the group with thread_id so it shows that group's records, or make the page private.`,
    );
  }
}

/* Pages -------------------------------------------------------------------- */

export function getPage(db: Db, pageId: string): PageRow | undefined {
  return db.prepare("SELECT * FROM shared_pages WHERE id=? AND user_id=?").get(pageId, USER_ID) as PageRow | undefined;
}

export function getPageBySlug(db: Db, slug: string): PageRow | undefined {
  return db.prepare("SELECT * FROM shared_pages WHERE slug=? AND user_id=?").get(slug, USER_ID) as PageRow | undefined;
}

export const pageIsLive = (row: PageRow, at: number = Date.now()): boolean =>
  !row.revoked_at && Date.parse(row.expires_at) > at;

const DEFAULT_DAYS: Record<PageKind, number> = { today: 2, week: 10, custom: 30, poll: 30 };

export type NewPage = {
  title: string;
  blocks: PageBlock[];
  kind?: PageKind;
  template?: string | null;
  audience: PageAudience;
  lifeAreaId?: string | null;
  threadId?: string | null;
  groupId?: string | null;
  expiresInDays?: number | null;
  dedupeKey?: string | null;
};

/**
 * When a page stops answering: at least `days` from now, and never before a
 * poll on it closes (plus a grace week for people to read the result), so the
 * close-out never links to a page that has gone.
 */
function expiryFor(blocks: PageBlock[], days: number): string {
  let at = Date.now() + days * DAY_MS;
  for (const block of blocks) {
    const closes = block.closes_at ? Date.parse(block.closes_at) : NaN;
    if (Number.isFinite(closes)) at = Math.max(at, closes + 3 * DAY_MS);
  }
  return new Date(at).toISOString();
}

export function createPage(db: Db, input: NewPage): PageRow {
  assertRecordsAllowed(input.blocks, input.audience, input.lifeAreaId ?? null);
  const kind: PageKind = input.kind ?? (hasVoting(input.blocks) ? "poll" : "custom");
  const timestamp = now();
  const row: PageRow = {
    id: id("page"),
    user_id: USER_ID,
    slug: randomBytes(16).toString("base64url"),
    kind,
    template: input.template ?? null,
    title: input.title.slice(0, 120),
    blocks_json: JSON.stringify(input.blocks),
    audience: input.audience,
    life_area_id: input.lifeAreaId ?? null,
    thread_id: input.threadId ?? null,
    group_id: input.groupId ?? null,
    dedupe_key: input.dedupeKey ?? null,
    expires_at: expiryFor(input.blocks, input.expiresInDays ?? DEFAULT_DAYS[kind]),
    revoked_at: null,
    results_posted_at: null,
    nudged_at: null,
    echoed_at: null,
    view_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(`
    INSERT INTO shared_pages(
      id,user_id,slug,kind,template,title,blocks_json,audience,life_area_id,thread_id,group_id,dedupe_key,
      expires_at,revoked_at,results_posted_at,nudged_at,echoed_at,view_count,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.id, row.user_id, row.slug, row.kind, row.template, row.title, row.blocks_json, row.audience,
    row.life_area_id, row.thread_id, row.group_id, row.dedupe_key, row.expires_at, null, null, null, null,
    0, timestamp, timestamp,
  );
  return row;
}

/**
 * Replaces the title or blocks behind the same link. Votes follow the options
 * by id: a vote for an option that is gone is dropped, a block that is gone
 * loses all of its votes, and everything else stays.
 */
export function updatePage(
  db: Db,
  row: PageRow,
  patch: { title?: string | null; blocks?: PageBlock[] | null; expiresInDays?: number | null },
): PageRow {
  const blocks = patch.blocks ?? pageBlocks(row);
  assertRecordsAllowed(blocks, row.audience, row.life_area_id);
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`
      UPDATE shared_pages SET title=?,blocks_json=?,expires_at=?,kind=?,updated_at=? WHERE id=?
    `).run(
      (patch.title ?? row.title).slice(0, 120),
      JSON.stringify(blocks),
      patch.expiresInDays || patch.blocks
        ? (patch.expiresInDays ? expiryFor(blocks, patch.expiresInDays) : laterOf(row.expires_at, expiryFor(blocks, 0)))
        : row.expires_at,
      row.kind === "today" || row.kind === "week" ? row.kind : hasVoting(blocks) ? "poll" : "custom",
      timestamp,
      row.id,
    );
    if (patch.blocks) pruneVotes(db, row.id, blocks);
  })();
  return getPage(db, row.id) as PageRow;
}

const laterOf = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

function pruneVotes(db: Db, pageId: string, blocks: PageBlock[]): void {
  const valid = new Map(blocks.filter(block => block.id && blockOptions(block).length)
    .map(block => [block.id as string, new Set(blockOptions(block).map(option => option.id))]));
  const votes = db.prepare("SELECT block_id,voter_name_key,option_ids_json FROM page_votes WHERE page_id=?")
    .all(pageId) as Array<{ block_id: string; voter_name_key: string; option_ids_json: string }>;
  for (const vote of votes) {
    const options = valid.get(vote.block_id);
    const kept = options ? (JSON.parse(vote.option_ids_json) as string[]).filter(option => options.has(option)) : [];
    if (!kept.length) {
      db.prepare("DELETE FROM page_votes WHERE page_id=? AND block_id=? AND voter_name_key=?")
        .run(pageId, vote.block_id, vote.voter_name_key);
    } else if (kept.length !== (JSON.parse(vote.option_ids_json) as string[]).length) {
      db.prepare("UPDATE page_votes SET option_ids_json=? WHERE page_id=? AND block_id=? AND voter_name_key=?")
        .run(JSON.stringify(kept), pageId, vote.block_id, vote.voter_name_key);
    }
  }
}

export function revokePage(db: Db, row: PageRow): PageRow {
  // The dedupe key goes too, so a briefing that wants today's page again makes a fresh one.
  db.prepare("UPDATE shared_pages SET revoked_at=COALESCE(revoked_at,?),dedupe_key=NULL,updated_at=? WHERE id=?")
    .run(now(), now(), row.id);
  return getPage(db, row.id) as PageRow;
}

export function listPages(
  db: Db,
  options: { includeExpired?: boolean; lifeAreaId?: string; audience?: PageAudience } = {},
): PageRow[] {
  const clauses = ["user_id=?"];
  const args: Array<string | number> = [USER_ID];
  if (!options.includeExpired) { clauses.push("revoked_at IS NULL AND expires_at>?"); args.push(now()); }
  if (options.lifeAreaId) { clauses.push("life_area_id=?"); args.push(options.lifeAreaId); }
  if (options.audience) { clauses.push("audience=?"); args.push(options.audience); }
  return db.prepare(`SELECT * FROM shared_pages WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`)
    .all(...args) as PageRow[];
}

export function recordPageView(db: Db, row: PageRow): void {
  db.prepare("UPDATE shared_pages SET view_count=view_count+1 WHERE id=?").run(row.id);
}

/**
 * Link-preview fetchers: Messages, Slack, and the rest open a link the moment
 * it is sent. They are not people, so they do not count as a view.
 */
const PREVIEW_AGENTS = /(bot|spider|crawl|preview|facebookexternalhit|slackbot|twitterbot|discordbot|whatsapp|telegram|linkedin|skypeuripreview|applebot|iMessage|CFNetwork.*Messages|embedly|curl|wget)/i;
export const isPreviewFetcher = (userAgent: string | undefined): boolean =>
  !userAgent || PREVIEW_AGENTS.test(userAgent);

/* Votes -------------------------------------------------------------------- */

/**
 * Control characters are whitespace here: `\s` takes the common ones, the rest are swapped one by one.
 * A name goes into chat texts and the agent's context, so the characters a link or an address needs are dropped.
 */
export const cleanVoterName = (value: unknown): string =>
  [...String(value ?? "")].map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("")
    .replace(/[<>"\\/:@]/g, "").replace(/\s+/g, " ").trim().slice(0, VOTER_NAME_MAX);

export const pollIsClosed = (block: PageBlock, at: number = Date.now()): boolean =>
  Boolean(block.closes_at && Date.parse(block.closes_at) <= at);

export function addPageEvent(
  db: Db,
  pageId: string,
  kind: "vote" | "check" | "claim",
  actor: string,
  detail: string,
): void {
  db.prepare("INSERT INTO page_events(id,page_id,kind,actor,detail,created_at) VALUES(?,?,?,?,?,?)")
    .run(id("page_event"), pageId, kind, actor, detail.slice(0, 200), now());
}

/**
 * Files one person's answer to one block. A second answer under the same name
 * replaces the first, so voting again is how a change of mind is made.
 * `byOwner` is a signed-in owner, whose own clicks are not echoed back to the
 * chat they started in.
 */
export function recordVote(
  db: Db,
  row: PageRow,
  input: { blockId: string; name: unknown; optionIds: string[]; byOwner?: boolean },
): { name: string; optionIds: string[] } {
  if (!pageIsLive(row)) throw new PageError("This page is no longer open");
  const block = pageBlocks(row).find(candidate => candidate.id === input.blockId
    && (candidate.type === "poll" || candidate.type === "availability"));
  if (!block) throw new PageError("There is nothing to vote on there");
  if (pollIsClosed(block)) throw new PageError("This poll has closed", "closed");
  const name = cleanVoterName(input.name);
  if (!name) throw new PageError("Enter your name so the group can see who voted", "name");
  const options = blockOptions(block);
  const valid = new Set(options.map(option => option.id));
  const chosen = [...new Set(input.optionIds)];
  if (chosen.some(option => !valid.has(option))) throw new PageError("That option is not on this poll", "option");
  const multi = block.type === "availability" || block.multi === true;
  if (!multi && chosen.length > 1) throw new PageError("Pick one option", "option");
  if (block.type === "poll" && !chosen.length) throw new PageError("Pick an option to vote", "option");
  const key = name.toLowerCase();
  const timestamp = now();
  const known = db.prepare("SELECT COUNT(DISTINCT voter_name_key) n FROM page_votes WHERE page_id=?").get(row.id) as { n: number };
  const already = db.prepare("SELECT 1 found FROM page_votes WHERE page_id=? AND voter_name_key=?").get(row.id, key);
  if (!already && known.n >= MAX_VOTERS) throw new PageError("This page has all the answers it can take", "full");
  db.transaction(() => {
    if (!chosen.length) {
      db.prepare("DELETE FROM page_votes WHERE page_id=? AND block_id=? AND voter_name_key=?").run(row.id, block.id, key);
    } else {
      db.prepare(`
        INSERT INTO page_votes(page_id,block_id,voter_name,voter_name_key,option_ids_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(page_id,block_id,voter_name_key) DO UPDATE SET
          voter_name=excluded.voter_name,option_ids_json=excluded.option_ids_json,updated_at=excluded.updated_at
      `).run(row.id, block.id, name, key, JSON.stringify(chosen), timestamp, timestamp);
    }
    if (!input.byOwner && chosen.length) {
      const labels = options.filter(option => chosen.includes(option.id)).map(option => option.label);
      addPageEvent(db, row.id, "vote", name, labels.length > 3 ? `${labels.slice(0, 3).join(", ")} +${labels.length - 3}` : labels.join(", "));
    }
  })();
  return { name, optionIds: chosen };
}

export type BlockResults = {
  block_id: string;
  type: "poll" | "availability";
  question: string;
  closed: boolean;
  closes_at: string | null;
  voters: string[];
  options: Array<{ id: string; label: string; count: number; voters: string[] }>;
  /** The option or options with the most votes; empty while nobody has voted. */
  leaders: string[];
};

export function pollResults(db: Db, row: PageRow): BlockResults[] {
  const votes = db.prepare("SELECT block_id,voter_name,option_ids_json FROM page_votes WHERE page_id=? ORDER BY created_at")
    .all(row.id) as Array<{ block_id: string; voter_name: string; option_ids_json: string }>;
  return pageBlocks(row)
    .filter(block => block.type === "poll" || block.type === "availability")
    .map(block => {
      const mine = votes.filter(vote => vote.block_id === block.id);
      const options = blockOptions(block).map(option => {
        const voters = mine
          .filter(vote => (JSON.parse(vote.option_ids_json) as string[]).includes(option.id))
          .map(vote => vote.voter_name);
        return { ...option, count: voters.length, voters };
      });
      const best = Math.max(0, ...options.map(option => option.count));
      return {
        block_id: block.id as string,
        type: block.type as "poll" | "availability",
        question: block.text ?? (block.type === "availability" ? "When can you make it?" : ""),
        closed: pollIsClosed(block),
        closes_at: block.closes_at ?? null,
        voters: mine.map(vote => vote.voter_name),
        options,
        leaders: best ? options.filter(option => option.count === best).map(option => option.label) : [],
      };
    });
}

/** Names the poll form suggests: the people the group has named, so one person is not counted under two spellings. */
export function voteNameSuggestions(db: Db, row: PageRow): string[] {
  if (!row.thread_id || !row.group_id) return [];
  const contacts = getNotificationPreferences(db).trustedContacts;
  const names = groupMembers(db, row.thread_id)
    .filter(member => !member.is_owner)
    .map(member => member.name ?? contacts.find(contact => contact.phone === member.phone)?.name ?? "")
    .filter(Boolean);
  return [...new Set(names)];
}

/* Chat follow-through: close-out, nudges, echoes, cleanup --------------------- */

/** "Sarah" and "sarah k" are the same voter as far as a headcount is concerned. */
export function sameVoter(a: string, b: string): boolean {
  const first = (value: string) => value.trim().toLowerCase().split(/\s+/)[0];
  return a.trim().toLowerCase() === b.trim().toLowerCase() || first(a) === first(b);
}

/** The group's named members (never the owner, whose name on a poll is their own choice) who have not voted on every block. */
export function missingVoters(db: Db, row: PageRow): string[] {
  const names = voteNameSuggestions(db, row);
  if (!names.length) return [];
  const results = pollResults(db, row);
  if (!results.length) return [];
  return names.filter(name => results.some(result => !result.voters.some(voter => sameVoter(voter, name))));
}

const interactiveBlocks = (row: PageRow) => pageBlocks(row).filter(block => block.type === "poll" || block.type === "availability");

/** Polls that have closed, or that everyone in their group has answered, and have not yet told their chat. */
export function pagesAwaitingResults(db: Db, at: number = Date.now()): PageRow[] {
  const rows = db.prepare(`
    SELECT * FROM shared_pages
    WHERE user_id=? AND kind='poll' AND revoked_at IS NULL AND results_posted_at IS NULL AND expires_at>?
      AND (thread_id IS NOT NULL OR group_id IS NOT NULL)
  `).all(USER_ID, new Date(at).toISOString()) as PageRow[];
  return rows.filter(row => {
    const blocks = interactiveBlocks(row);
    if (!blocks.length) return false;
    // A page with several polls waits for the last of them to close; the ones still open take votes.
    if (blocks.every(block => pollIsClosed(block, at))) return true;
    const names = voteNameSuggestions(db, row);
    return names.length > 0 && missingVoters(db, row).length === 0 && pollResults(db, row).every(result => result.voters.length > 0);
  });
}

/** A poll with a close time within two hours, a group that has not all voted, and no nudge sent yet. */
export function pagesToNudge(db: Db, at: number = Date.now()): Array<{ page: PageRow; missing: string[] }> {
  const rows = db.prepare(`
    SELECT * FROM shared_pages
    WHERE user_id=? AND kind='poll' AND revoked_at IS NULL AND results_posted_at IS NULL AND expires_at>?
      AND nudged_at IS NULL AND group_id IS NOT NULL AND thread_id IS NOT NULL
  `).all(USER_ID, new Date(at).toISOString()) as PageRow[];
  const due: Array<{ page: PageRow; missing: string[] }> = [];
  for (const page of rows) {
    const closes = interactiveBlocks(page).map(block => block.closes_at).filter(Boolean)
      .map(value => Date.parse(value as string)).sort((a, b) => a - b)[0];
    if (!closes || closes <= at || closes - at > 2 * 60 * 60 * 1000) continue;
    const missing = missingVoters(db, page);
    if (missing.length) due.push({ page, missing });
  }
  return due;
}

/** Closes every poll on a page that is still open, so a poll everyone has answered stops taking votes the moment its result is posted. */
export function closePollsNow(db: Db, row: PageRow, at: number = Date.now()): void {
  const stamp = new Date(at).toISOString();
  const blocks = pageBlocks(row).map(block =>
    (block.type === "poll" || block.type === "availability") && !pollIsClosed(block, at) ? { ...block, closes_at: stamp } : block);
  db.prepare("UPDATE shared_pages SET blocks_json=?,updated_at=? WHERE id=?").run(JSON.stringify(blocks), now(), row.id);
}

const joinNames = (names: string[]): string =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;

export function closeoutText(db: Db, row: PageRow): string {
  const lines = pollResults(db, row).map(result => {
    const voted = result.voters.length;
    const noun = voted === 1 ? "vote" : "votes";
    if (!voted) return `Nobody voted on "${result.question}".`;
    const top = result.options.find(option => option.label === result.leaders[0]) as BlockResults["options"][number];
    if (result.type === "availability") {
      return `Best time: ${result.leaders.length > 1 ? `${joinNames(result.leaders)} tie` : result.leaders[0]} (${top.count} of ${voted} can make it).`;
    }
    return result.leaders.length > 1
      ? `${result.question} ${joinNames(result.leaders)} tie with ${top.count} each (${voted} ${noun}).`
      : `${result.question} ${result.leaders[0]} wins with ${top.count} of ${voted} ${noun}.`;
  });
  // An owner's page is behind a sign-in; nobody in a chat can open it, so it is not offered to them.
  const link = row.audience === "shared" ? tryPublicPageUrl(db, row.slug) : null;
  return [`Poll closed. ${lines.join(" ")}`, link ? `Full results: ${link}` : ""].filter(Boolean).join("\n");
}

export function nudgeText(db: Db, row: PageRow, missing: string[]): string {
  const link = row.audience === "shared" ? tryPublicPageUrl(db, row.slug) : null;
  return `${joinNames(missing)}: "${row.title}" closes soon and still needs your vote.${link ? ` ${link}` : ""}`;
}

export type PendingEcho = { page: PageRow; events: Array<{ id: string; kind: string; actor: string; detail: string }> };

/** Page activity the chat has not heard about, once the newest of it has settled for `windowMs`. */
export function pendingEchoes(db: Db, at: number = Date.now(), windowMs = 2 * 60 * 1000): PendingEcho[] {
  const rows = db.prepare(`
    SELECT e.id,e.page_id,e.kind,e.actor,e.detail,e.created_at FROM page_events e
    JOIN shared_pages p ON p.id=e.page_id
    WHERE e.echoed_at IS NULL AND p.revoked_at IS NULL AND (p.thread_id IS NOT NULL OR p.group_id IS NOT NULL)
    ORDER BY e.created_at
  `).all() as Array<{ id: string; page_id: string; kind: string; actor: string; detail: string; created_at: string }>;
  const byPage = new Map<string, typeof rows>();
  for (const event of rows) byPage.set(event.page_id, [...byPage.get(event.page_id) ?? [], event]);
  const ready: PendingEcho[] = [];
  for (const [pageId, events] of byPage) {
    // Gathered over a window: the chat hears about a burst of votes once, not once per vote.
    // Unless it keeps going: after ten minutes the first of it is told whatever has come since.
    const newest = Date.parse(events[events.length - 1].created_at);
    if (newest + windowMs > at && Date.parse(events[0].created_at) + 5 * windowMs > at) continue;
    const page = getPage(db, pageId);
    if (page) ready.push({ page, events });
  }
  return ready;
}

export function markEchoed(db: Db, eventIds: string[]): void {
  const stamp = now();
  const update = db.prepare("UPDATE page_events SET echoed_at=? WHERE id=?");
  db.transaction(() => { for (const eventId of eventIds) update.run(stamp, eventId); })();
}

export function echoText(db: Db, pending: PendingEcho): string {
  // The latest action of each person stands for them.
  const latest = new Map<string, { kind: string; detail: string }>();
  for (const event of pending.events) latest.set(event.actor, event);
  const parts = [...latest].map(([actor, event]) => {
    if (event.kind === "check") return `${actor} ticked off ${event.detail}`;
    if (event.kind === "claim") return `${actor} took ${event.detail}`;
    return `${actor} chose ${event.detail}`;
  });
  const results = pollResults(db, pending.page);
  const tally = results[0] && results[0].voters.length
    ? ` (${results[0].voters.length} ${results[0].voters.length === 1 ? "has" : "have"} answered${results[0].leaders.length ? `; leading: ${joinNames(results[0].leaders)}` : ""})`
    : "";
  return `${pending.page.title}: ${parts.join("; ")}${tally}.`;
}

/** Hard-deletes pages that have been expired or revoked for a week, with their votes and events. */
export function sweepPages(db: Db, at: number = Date.now()): number {
  const cutoff = new Date(at - 7 * DAY_MS).toISOString();
  return db.prepare("DELETE FROM shared_pages WHERE user_id=? AND (expires_at<? OR (revoked_at IS NOT NULL AND revoked_at<?))")
    .run(USER_ID, cutoff, cutoff).changes;
}

/* Presentation ------------------------------------------------------------- */

/** The page as the tools, the REST API, and the Pages screen describe it. */
export function pageJson(db: Db, row: PageRow): Record<string, unknown> {
  const thread = row.thread_id
    ? db.prepare(`
      SELECT t.address,la.name area_name,t.display_name FROM channel_threads t
      LEFT JOIN life_areas la ON la.thread_id=t.id WHERE t.id=?
    `).get(row.thread_id) as { address: string; area_name: string | null; display_name: string | null } | undefined
    : undefined;
  const area = row.life_area_id
    ? db.prepare("SELECT name FROM life_areas WHERE id=?").get(row.life_area_id) as { name: string } | undefined
    : undefined;
  const results = pollResults(db, row);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    template: row.template,
    audience: row.audience,
    url: tryPublicPageUrl(db, row.slug),
    path: `/p/${row.slug}`,
    group: row.group_id ? (thread?.area_name ?? thread?.display_name ?? area?.name ?? "Group chat") : null,
    thread_id: row.thread_id,
    life_area_id: row.life_area_id,
    expires_at: row.expires_at,
    revoked: Boolean(row.revoked_at),
    live: pageIsLive(row),
    view_count: row.view_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    results_posted: Boolean(row.results_posted_at),
    voters: results.reduce((total, result) => Math.max(total, result.voters.length), 0),
    blocks: pageBlocks(row),
  };
}
