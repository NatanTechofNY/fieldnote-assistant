import { getAtlassianSecret, type AtlassianMeta, type AtlassianSecretConfig } from "./integrations.ts";
import type { Db } from "./types.ts";

/*
 * One Basic-auth client for both products. Jira answers under `/rest/api/3` and
 * `/rest/agile/1.0`, Confluence under `/wiki`, and the same `email:apiToken`
 * pair authenticates all of them on the same host.
 *
 * Two path prefixes for Jira boards is deliberate, not leftover: the eight
 * issue-listing endpoints under `/rest/agile/1.0` are removed after 1 Nov 2026
 * and live on at `/rest/software/1.0`, while board listing, configuration, and
 * sprints stay on `/rest/agile/1.0` and are not deprecated.
 */

/**
 * Half the browser's 20s tool deadline, so a slow call fails as a tool error the
 * agent can read rather than as an abort the client reports to nobody. Half and
 * not all of it because one tool call can need a second Atlassian request: those
 * belong alongside the first, never after it, or the pair outlives the deadline
 * they were each sized to fit inside.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const ISSUE_FIELDS = "summary,status,assignee,priority,issuetype,project,duedate,updated,created";
const PAGE_TEXT_LIMIT = 4000;
/** Long `id IN (...)` lists eventually break the URL, so containment is asked in chunks. */
const PAGE_ID_CHUNK = 50;
/** Token pagination is sequential, so resources are the only axis left to widen. */
const RESOURCE_CONCURRENCY = 4;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Math.trunc(value)));

const siteBase = (config: AtlassianSecretConfig): string => config.siteUrl.replace(/\/+$/, "");

/**
 * JQL and CQL both delimit string literals with double quotes and escape with a
 * backslash. Model-supplied text reaches these builders, so anything that could
 * terminate the literal early is escaped and line breaks are flattened.
 */
const quoted = (value: string): string =>
  `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/[\r\n\t]+/g, " ")}"`;

const numericOnly = (values: readonly string[]): string[] =>
  values.map(String).filter((value) => /^\d+$/.test(value));

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Carries the HTTP status alongside the message so a caller can branch on it
 * without parsing prose Atlassian owns.
 */
class AtlassianRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AtlassianRequestError";
    this.status = status;
  }
}

async function atlassianError(response: Response, path: string): Promise<Error> {
  const body = (await response.text()).slice(0, 300);
  if (response.status === 401) {
    return new AtlassianRequestError(
      "Atlassian rejected the credentials (401). API tokens expire within a year, and a scoped token only authenticates against api.atlassian.com rather than the site URL.",
      401,
    );
  }
  if (response.status === 403) {
    return new AtlassianRequestError(
      `Atlassian denied access to ${path} (403). Board endpoints also answer 403 when the account holds no Jira Software license.`,
      403,
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return new AtlassianRequestError(
      `Atlassian rate limited the request${retryAfter ? `; retry after ${retryAfter}s` : ""}`,
      429,
    );
  }
  return new AtlassianRequestError(
    `Atlassian API failed (${response.status}) on ${path}: ${body || response.statusText}`,
    response.status,
  );
}

async function requestJson<T>(
  config: AtlassianSecretConfig,
  path: string,
  query: Query = {},
): Promise<T> {
  const url = new URL(`${siteBase(config)}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw await atlassianError(response, path);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Atlassian did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${path})`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += RESOURCE_CONCURRENCY) {
    results.push(...await Promise.all(items.slice(start, start + RESOURCE_CONCURRENCY).map(task)));
  }
  return results;
}

function requireSecret(db: Db): AtlassianSecretConfig {
  const secret = getAtlassianSecret(db);
  if (!secret) throw new Error("Atlassian is not configured");
  return secret;
}

/* Rich text ------------------------------------------------------------------ */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
};

/** Nodes after which a line break belongs, so flattened text keeps its shape. */
const ADF_BLOCKS = new Set([
  "paragraph", "heading", "listItem", "blockquote", "codeBlock", "panel", "rule",
  "tableRow", "mediaSingle", "taskItem", "expand",
]);

/**
 * Neither a Jira description nor a Confluence body arrives as text: both are
 * ADF, a JSON document tree, which Confluence delivers double-encoded as a
 * string. Walking the tree beats parsing storage-format XHTML, and macros are
 * discrete nodes that simply contribute nothing.
 */
export function adfToText(value: unknown, limit = PAGE_TEXT_LIMIT): string {
  let root: unknown = value;
  if (typeof value === "string") {
    try {
      root = JSON.parse(value);
    } catch {
      return value.slice(0, limit);
    }
  }
  const parts: string[] = [];
  const walk = (node: AdfNode | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") parts.push(node.text);
    if (node.type === "mention" && typeof node.attrs?.text === "string") parts.push(node.attrs.text);
    for (const child of node.content || []) walk(child);
    if (node.type && ADF_BLOCKS.has(node.type)) parts.push("\n");
  };
  walk(root as AdfNode);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

/* Connect -------------------------------------------------------------------- */

type AtlassianUser = { accountId?: string; displayName?: string };

/**
 * Product access is licensed per product, so a token that works for Jira says
 * nothing about Confluence. Each is probed independently and only a pair of
 * failures rejects the credentials.
 */
export async function validateAtlassianConfig(
  config: AtlassianSecretConfig,
): Promise<AtlassianMeta> {
  const [jira, confluence] = await Promise.allSettled([
    requestJson<AtlassianUser>(config, "/rest/api/3/myself"),
    requestJson<AtlassianUser>(config, "/wiki/rest/api/user/current"),
  ]);
  const jiraUser = jira.status === "fulfilled" ? jira.value : null;
  const confluenceUser = confluence.status === "fulfilled" ? confluence.value : null;
  if (!jiraUser && !confluenceUser) {
    throw jira.status === "rejected" && jira.reason instanceof Error
      ? jira.reason
      : new Error("Atlassian rejected the credentials");
  }
  const user = jiraUser || confluenceUser;
  return {
    accountId: user?.accountId ?? null,
    displayName: user?.displayName ?? null,
    jiraAvailable: Boolean(jiraUser),
    confluenceAvailable: Boolean(confluenceUser),
  };
}

/* Jira ----------------------------------------------------------------------- */

type JiraStatusRaw = {
  id?: string | number;
  name?: string;
  statusCategory?: { key?: string; name?: string };
};

type JiraBoardRaw = {
  id?: number;
  name?: string;
  type?: string;
  location?: { projectKey?: string; projectName?: string };
};

type JiraIssueRaw = {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    status?: { name?: string; statusCategory?: { name?: string } };
    assignee?: { accountId?: string; displayName?: string } | null;
    priority?: { name?: string } | null;
    issuetype?: { name?: string };
    project?: { key?: string; name?: string };
    duedate?: string | null;
    updated?: string;
    created?: string;
  };
  changelog?: {
    histories?: Array<{
      created?: string;
      author?: { displayName?: string };
      items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }>;
    }>;
  };
};

/** What a digest means by "what moved"; the rest of a changelog is noise here. */
const TRACKED_CHANGE_FIELDS = new Set(["status", "assignee", "priority", "resolution", "sprint"]);

async function statusIndex(config: AtlassianSecretConfig): Promise<Map<string, JiraStatusRaw>> {
  // Browse Projects is enough here. The `/rest/api/3/statuses` family looks like
  // the same thing but requires Administer Jira.
  const statuses = await requestJson<JiraStatusRaw[]>(config, "/rest/api/3/status");
  return new Map(statuses.map((status) => [String(status.id), status]));
}

const projectIssue = (config: AtlassianSecretConfig, issue: JiraIssueRaw) => {
  const fields = issue.fields || {};
  return {
    key: issue.key ?? null,
    summary: fields.summary ?? null,
    status: fields.status?.name ?? null,
    status_category: fields.status?.statusCategory?.name ?? null,
    assignee: fields.assignee
      ? { account_id: fields.assignee.accountId ?? null, display_name: fields.assignee.displayName ?? null }
      : null,
    priority: fields.priority?.name ?? null,
    type: fields.issuetype?.name ?? null,
    project: fields.project?.key ?? null,
    due_at: fields.duedate ?? null,
    updated_at: fields.updated ?? null,
    url: issue.key ? `${siteBase(config)}/browse/${issue.key}` : null,
  };
};

async function boardColumns(
  config: AtlassianSecretConfig,
  boardId: number,
  statuses: Map<string, JiraStatusRaw>,
) {
  const configuration = await requestJson<{
    filter?: { id?: string };
    columnConfig?: { columns?: Array<{ name?: string; statuses?: Array<{ id?: string }> }> };
  }>(config, `/rest/agile/1.0/board/${boardId}/configuration`);
  return {
    filter_id: configuration.filter?.id ?? null,
    columns: (configuration.columnConfig?.columns || []).map((column) => ({
      name: column.name ?? "",
      // Column config carries status IDs only, so names come from the status index.
      statuses: (column.statuses || []).flatMap((entry) => {
        if (!entry.id) return [];
        const status = statuses.get(String(entry.id));
        return [{
          id: String(entry.id),
          name: status?.name ?? null,
          category: status?.statusCategory?.name ?? null,
        }];
      }),
    })),
  };
}

export type JiraBoardFilters = {
  name_filter?: string | null;
  project_key?: string | null;
  include_columns?: boolean | null;
  limit?: number | null;
};

/** A Jira project key: 2-10 characters, leading letter, no whitespace. */
const PROJECT_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]{1,9}$/;

async function boardPage(
  config: AtlassianSecretConfig,
  query: { maxResults: number; name?: string; projectKeyOrId?: string },
) {
  const payload = await requestJson<{ values?: JiraBoardRaw[]; total?: number; isLast?: boolean }>(
    config,
    "/rest/agile/1.0/board",
    { startAt: 0, ...query },
  );
  return {
    boards: (payload.values || []).flatMap((board) => board.id === undefined ? [] : [{
      id: board.id,
      name: board.name ?? null,
      // Team-managed boards report "simple" whatever they are configured as, so
      // this cannot be used to infer sprint support.
      type: board.type ?? null,
      project_key: board.location?.projectKey ?? null,
    }]),
    total: payload.total,
    isLast: payload.isLast,
  };
}

/**
 * The board page for a project key, or nothing at all. Keys are case sensitive
 * and an unknown one answers 400, which says exactly what an empty list says and
 * must not reach the agent as a tool failure.
 */
async function boardPageByKey(config: AtlassianSecretConfig, maxResults: number, key: string) {
  try {
    return await boardPage(config, { maxResults, projectKeyOrId: key });
  } catch (error) {
    if (error instanceof AtlassianRequestError && error.status === 400) return null;
    throw error;
  }
}

/*
 * Jira matches `name` against board names only and ANDs it with
 * `projectKeyOrId`, so a project key in the name filter matches nothing: the
 * board behind a key like ENG is named "Engineering Delivery". Both shapes
 * below come from the model reading one token, "the ENG board", and having two
 * places to put it, so precedence between them is decided here rather than left
 * to the guess.
 */
export async function listJiraBoards(db: Db, filters: JiraBoardFilters = {}) {
  const config = requireSecret(db);
  const maxResults = clamp(filters.limit ?? 25, 1, 50);
  const name = filters.name_filter?.trim() || undefined;
  const key = filters.project_key?.trim() || undefined;
  // Both filters filled from the same token can only match nothing, and a
  // project key is never a board name, so the key is the one that meant it.
  const echoesKey = Boolean(name && key && name.toUpperCase() === key.toUpperCase());
  const keyCandidate = !key && name && PROJECT_KEY_SHAPE.test(name) ? name.toUpperCase() : null;
  /*
   * A key-shaped name filter is worth reading both ways, but asking Jira the
   * second way only after the first came back empty spends two request timeouts
   * on one tool call and the client gives up before either answer arrives. Both
   * readings go at once, and the literal one still wins when it matched.
   */
  const [named, keyed] = await Promise.allSettled([
    boardPage(config, { maxResults, name: echoesKey ? undefined : name, projectKeyOrId: key }),
    keyCandidate ? boardPageByKey(config, maxResults, keyCandidate) : Promise.resolve(null),
  ]);
  if (named.status === "rejected") throw named.reason;
  // The speculative lookup only gets to fail the call when it was the only one
  // that could still have found something.
  if (!named.value.boards.length && keyed.status === "rejected") throw keyed.reason;
  const keyedPage = keyed.status === "fulfilled" ? keyed.value : null;
  const page = named.value.boards.length || !keyedPage ? named.value : keyedPage;
  const boards = page.boards;
  if (!filters.include_columns || !boards.length) {
    return { boards, total: page.total ?? boards.length, has_more: page.isLast === false };
  }
  const statuses = await statusIndex(config);
  const detailed = await mapLimited(boards, async (board) => {
    try {
      return { ...board, ...await boardColumns(config, board.id, statuses) };
    } catch (error) {
      // One inaccessible board should not fail a listing of the others.
      return {
        ...board,
        filter_id: null,
        columns: [],
        columns_error: error instanceof Error ? error.message : "Board configuration unavailable",
      };
    }
  });
  return { boards: detailed, total: page.total ?? detailed.length, has_more: page.isLast === false };
}

/**
 * Columns for boards a digest brief has pinned. The names come from the pinned
 * record, so this only pays for the configuration lookups and one shared status
 * index.
 */
export async function describeJiraBoards(db: Db, boardIds: readonly number[]) {
  if (!boardIds.length) return [];
  const config = requireSecret(db);
  const statuses = await statusIndex(config);
  return mapLimited(boardIds, async (boardId) => {
    try {
      return { id: boardId, ...await boardColumns(config, boardId, statuses) };
    } catch (error) {
      return {
        id: boardId,
        filter_id: null,
        columns: [],
        columns_error: error instanceof Error ? error.message : "Board configuration unavailable",
      };
    }
  });
}

export type JiraIssueFilters = {
  board_id?: number | null;
  assignee?: string | null;
  project_key?: string | null;
  status_ids?: string[] | null;
  text?: string | null;
  updated_within_days?: number | null;
  limit?: number | null;
};

/**
 * JQL has no `board` field, so a board query goes to the board's own issue
 * endpoint where its filter is already applied. Everything else goes to
 * `/search/jql`, which rejects an unbounded query, hence the fallback clause.
 */
function issueJql(filters: JiraIssueFilters, requireBound: boolean): string | undefined {
  const clauses: string[] = [];
  if (filters.assignee) {
    clauses.push(filters.assignee === "me"
      ? "assignee = currentUser()"
      : `assignee = ${quoted(filters.assignee)}`);
  }
  if (filters.project_key) clauses.push(`project = ${quoted(filters.project_key)}`);
  const statusIds = numericOnly(filters.status_ids || []);
  if (statusIds.length) clauses.push(`status IN (${statusIds.join(", ")})`);
  if (filters.text) clauses.push(`text ~ ${quoted(filters.text)}`);
  if (filters.updated_within_days) {
    clauses.push(`updated >= -${clamp(filters.updated_within_days, 1, 365)}d`);
  }
  if (!clauses.length) return requireBound ? "updated >= -30d ORDER BY updated DESC" : undefined;
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

export async function listJiraIssues(db: Db, filters: JiraIssueFilters = {}) {
  const config = requireSecret(db);
  const boardId = filters.board_id ?? null;
  const jql = issueJql(filters, boardId === null);
  const payload = await requestJson<{
    issues?: JiraIssueRaw[];
    nextPageToken?: string;
    isLast?: boolean;
  }>(
    config,
    boardId === null ? "/rest/api/3/search/jql" : `/rest/software/1.0/board/${boardId}/issue`,
    {
      jql,
      // Both endpoints return bare issue IDs unless the fields are named.
      fields: ISSUE_FIELDS,
      maxResults: clamp(filters.limit ?? 20, 1, 50),
    },
  );
  return {
    issues: (payload.issues || []).map((issue) => projectIssue(config, issue)),
    board_id: boardId,
    jql: jql ?? null,
    // These endpoints are token-paginated and report no total, so the only
    // honest signal is whether another page exists.
    has_more: Boolean(payload.nextPageToken) && payload.isLast !== true,
  };
}

export async function getJiraIssue(
  db: Db,
  params: { key: string; include_recent_changes?: boolean | null },
) {
  const config = requireSecret(db);
  const issue = await requestJson<JiraIssueRaw>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(params.key)}`,
    {
      fields: `${ISSUE_FIELDS},description,labels`,
      expand: params.include_recent_changes ? "changelog" : undefined,
    },
  );
  const histories = params.include_recent_changes ? issue.changelog?.histories || [] : [];
  return {
    ...projectIssue(config, issue),
    description: adfToText(issue.fields?.description),
    labels: issue.fields?.labels || [],
    recent_changes: histories
      .slice(-10)
      .reverse()
      .flatMap((history) => {
        const items = (history.items || []).filter(
          (item) => item.field && TRACKED_CHANGE_FIELDS.has(item.field.toLowerCase()),
        );
        return items.length ? [{
          at: history.created ?? null,
          by: history.author?.displayName ?? null,
          changes: items.map((item) => ({
            field: item.field ?? null,
            from: item.fromString ?? null,
            to: item.toString ?? null,
          })),
        }] : [];
      }),
  };
}

export async function listJiraUsers(db: Db, params: { query: string; limit?: number | null }) {
  const config = requireSecret(db);
  const users = await requestJson<Array<{
    accountId?: string;
    accountType?: string;
    displayName?: string;
    emailAddress?: string | null;
    active?: boolean;
  }>>(config, "/rest/api/3/user/search", {
    query: params.query,
    maxResults: clamp(params.limit ?? 20, 1, 50),
  });
  const people = users.filter((user) => user.accountType !== "app");
  return {
    users: people.map((user) => ({
      account_id: user.accountId ?? null,
      display_name: user.displayName ?? null,
      // Absent whenever the person's profile visibility hides it, so it is never
      // a reliable key.
      email: user.emailAddress ?? null,
      active: user.active ?? null,
    })),
    /*
     * Without the Browse Users permission this endpoint answers 200 with an
     * empty array rather than 403, so an empty result cannot be reported as
     * "no such person".
     */
    permission_uncertain: people.length === 0,
  };
}

/* Confluence ----------------------------------------------------------------- */

type ConfluenceSearchHit = {
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
  content?: {
    id?: string;
    type?: string;
    title?: string;
    space?: { key?: string; name?: string };
    history?: { createdDate?: string; createdBy?: { accountId?: string; displayName?: string } };
    container?: { id?: string; title?: string; _links?: { webui?: string } };
    extensions?: { location?: string };
  };
  resultGlobalContainer?: { title?: string; displayUrl?: string };
};

type CqlResponse = {
  results?: ConfluenceSearchHit[];
  totalSize?: number;
  _links?: { base?: string; next?: string };
};

async function cqlSearch(
  config: AtlassianSecretConfig,
  cql: string,
  options: { expand?: string; limit: number },
): Promise<CqlResponse> {
  // CQL search has no v2 equivalent, so this stays on v1. Body expansion is
  // avoided deliberately: it silently caps results at 50.
  return requestJson<CqlResponse>(config, "/wiki/rest/api/search", {
    cql,
    expand: options.expand,
    limit: options.limit,
    excerpt: "highlight_unescaped",
  });
}

const spaceClause = (keys: readonly string[]): string =>
  `space IN (${keys.map(quoted).join(", ")})`;

const relativeDays = (days: number): string => quoted(`-${days}d`);

const absoluteUrl = (config: AtlassianSecretConfig, base: string | undefined, path: string | undefined) =>
  path ? `${base || `${siteBase(config)}/wiki`}${path}` : null;

const trimExcerpt = (excerpt: string | undefined): string | null =>
  excerpt ? excerpt.replace(/\s+/g, " ").trim().slice(0, 500) || null : null;

export async function listConfluenceSpaces(
  db: Db,
  params: { keys?: string[] | null; limit?: number | null } = {},
) {
  const config = requireSecret(db);
  const payload = await requestJson<{
    results?: Array<{ id?: string; key?: string; name?: string; type?: string }>;
    _links?: { next?: string };
  }>(config, "/wiki/api/v2/spaces", {
    limit: clamp(params.limit ?? 25, 1, 100),
    keys: params.keys?.length ? params.keys.join(",") : undefined,
    status: "current",
  });
  return {
    spaces: (payload.results || []).map((space) => ({
      id: space.id ?? null,
      key: space.key ?? null,
      name: space.name ?? null,
      type: space.type ?? null,
      url: space.key ? `${siteBase(config)}/wiki/spaces/${space.key}` : null,
    })),
    has_more: Boolean(payload._links?.next),
  };
}

export type ConfluencePageFilters = {
  space_keys?: string[] | null;
  text?: string | null;
  modified_within_days?: number | null;
  mine_only?: boolean | null;
  limit?: number | null;
};

export async function listConfluencePages(db: Db, filters: ConfluencePageFilters = {}) {
  const config = requireSecret(db);
  const clauses = ["type = page"];
  if (filters.space_keys?.length) clauses.push(spaceClause(filters.space_keys));
  if (filters.text) clauses.push(`text ~ ${quoted(filters.text)}`);
  if (filters.modified_within_days) {
    clauses.push(`lastmodified >= now(${relativeDays(clamp(filters.modified_within_days, 1, 365))})`);
  }
  // `creator` still points at the original author after an ownership transfer,
  // so both are accepted as "mine".
  if (filters.mine_only) clauses.push("(creator = currentUser() OR owner = currentUser())");
  const cql = `${clauses.join(" AND ")} ORDER BY lastmodified DESC`;
  const payload = await cqlSearch(config, cql, {
    expand: "content.history,content.space",
    limit: clamp(filters.limit ?? 20, 1, 50),
  });
  const base = payload._links?.base;
  return {
    pages: (payload.results || []).map((hit) => ({
      id: hit.content?.id ?? null,
      title: hit.content?.title ?? hit.title ?? null,
      space: hit.content?.space?.key ?? null,
      author: hit.content?.history?.createdBy?.displayName ?? null,
      last_modified: hit.lastModified ?? null,
      excerpt: trimExcerpt(hit.excerpt),
      url: absoluteUrl(config, base, hit.url),
    })),
    total: payload.totalSize ?? null,
    cql,
  };
}

export async function getConfluencePage(db: Db, params: { id: string }) {
  const config = requireSecret(db);
  const page = await requestJson<{
    id?: string;
    title?: string;
    spaceId?: string;
    version?: { number?: number; createdAt?: string };
    body?: { atlas_doc_format?: { value?: string } };
    _links?: { webui?: string };
  }>(config, `/wiki/api/v2/pages/${encodeURIComponent(params.id)}`, {
    // The response field is named after the format requested, so this has to
    // match what is read below.
    "body-format": "atlas_doc_format",
  });
  return {
    id: page.id ?? null,
    title: page.title ?? null,
    space_id: page.spaceId ?? null,
    version: page.version?.number ?? null,
    updated_at: page.version?.createdAt ?? null,
    text: adfToText(page.body?.atlas_doc_format?.value),
    url: page._links?.webui ? `${siteBase(config)}/wiki${page._links.webui}` : null,
  };
}

/**
 * CQL cannot join a comment to its page: `type = comment AND ancestor = <pageId>`
 * matches nothing, because comment-to-page containment is not indexed even
 * though `ancestor` works fine for pages. So the container pages are collected
 * from the comment hits and asked about in one follow-up query, which holds this
 * to two round trips however many pages the user owns.
 */
async function myPageIds(
  config: AtlassianSecretConfig,
  pageIds: readonly string[],
): Promise<Set<string>> {
  const mine = new Set<string>();
  const candidates = numericOnly(pageIds);
  for (let start = 0; start < candidates.length; start += PAGE_ID_CHUNK) {
    const chunk = candidates.slice(start, start + PAGE_ID_CHUNK);
    const payload = await cqlSearch(
      config,
      `type = page AND (creator = currentUser() OR owner = currentUser()) AND id IN (${chunk.join(", ")})`,
      { limit: chunk.length },
    );
    for (const hit of payload.results || []) {
      if (hit.content?.id) mine.add(String(hit.content.id));
    }
  }
  return mine;
}

export type ConfluenceCommentFilters = {
  space_keys?: string[] | null;
  within_days?: number | null;
  only_my_pages?: boolean | null;
  limit?: number | null;
};

export async function listConfluenceComments(db: Db, filters: ConfluenceCommentFilters = {}) {
  const config = requireSecret(db);
  const days = clamp(filters.within_days ?? 1, 1, 30);
  const limit = clamp(filters.limit ?? 25, 1, 100);
  const clauses = ["type = comment", `created >= now(${relativeDays(days)})`];
  if (filters.space_keys?.length) clauses.push(spaceClause(filters.space_keys));
  const cql = `${clauses.join(" AND ")} ORDER BY created DESC`;
  const payload = await cqlSearch(config, cql, {
    expand: "content.container,content.history,content.space,content.extensions",
    // Room to discard comments whose page turns out to belong to someone else.
    limit: filters.only_my_pages ? Math.min(100, limit * 3) : limit,
  });
  /*
   * `now("-1d")` resolves in the site timezone rather than UTC, so the returned
   * timestamps are re-checked against a real boundary instead of trusted.
   */
  const cutoff = Date.now() - days * 86_400_000;
  let hits = (payload.results || []).filter((hit) => {
    const created = hit.content?.history?.createdDate || hit.lastModified;
    return created ? Date.parse(created) >= cutoff : true;
  });
  if (filters.only_my_pages) {
    const containerIds = [...new Set(
      hits.flatMap((hit) => hit.content?.container?.id ? [String(hit.content.container.id)] : []),
    )];
    const mine = await myPageIds(config, containerIds);
    hits = hits.filter((hit) => mine.has(String(hit.content?.container?.id)));
  }
  const base = payload._links?.base;
  return {
    comments: hits.slice(0, limit).map((hit) => ({
      id: hit.content?.id ?? null,
      page: {
        id: hit.content?.container?.id ?? null,
        title: hit.content?.container?.title ?? null,
      },
      space: hit.content?.space?.key ?? null,
      // Only the first version's author is the original commenter, which the v1
      // history gives directly; the v2 comment endpoints only expose the last
      // editor.
      author: hit.content?.history?.createdBy?.displayName ?? null,
      created_at: hit.content?.history?.createdDate ?? hit.lastModified ?? null,
      location: hit.content?.extensions?.location ?? null,
      excerpt: trimExcerpt(hit.excerpt),
      // Already carries ?focusedCommentId=, so it lands on the comment itself.
      url: absoluteUrl(config, base, hit.url),
    })),
    scoped_to_my_pages: Boolean(filters.only_my_pages),
    cql,
  };
}
