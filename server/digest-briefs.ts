import { describeJiraBoards } from "./atlassian-service.ts";
import { USER_ID } from "./db.ts";
import type { Db, DigestBriefResource, DigestBriefRow } from "./types.ts";

/** `sendSms` truncates at 1500, so the draft is asked to stop short of that. */
const SMS_BUDGET = 1200;

export const briefResources = (row: DigestBriefRow): DigestBriefResource[] => {
  const parsed = JSON.parse(row.resources_json || "[]") as DigestBriefResource[];
  return Array.isArray(parsed) ? parsed : [];
};

export const briefJson = (row: DigestBriefRow) => ({
  id: row.id,
  name: row.name,
  prompt: row.prompt,
  sendTime: row.send_time,
  resources: briefResources(row),
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function getDigestBrief(db: Db, briefId: string): DigestBriefRow | undefined {
  return db.prepare("SELECT * FROM digest_briefs WHERE id=? AND user_id=?")
    .get(briefId, USER_ID) as DigestBriefRow | undefined;
}

/**
 * Briefs whose send time has passed for the current local day. The dispatch row
 * is the claim, exactly as it is for the daily digest, so nothing is reserved
 * here and a repeated tick is collapsed by the idempotency key instead.
 */
export function dueDigestBriefs(db: Db, localTime: string): DigestBriefRow[] {
  return db.prepare(`
    SELECT * FROM digest_briefs WHERE user_id=? AND enabled=1 AND send_time<=?
    ORDER BY send_time,name
  `).all(USER_ID, localTime) as DigestBriefRow[];
}

const boardIds = (resources: DigestBriefResource[]): number[] => resources.flatMap((resource) =>
  resource.type === "jira_board" && /^\d+$/.test(resource.id) ? [Number(resource.id)] : []);

/**
 * The pinned boards and spaces, with each board's real column names and the
 * status IDs behind them. Without this the agent has to infer an opaque board ID
 * from the prompt wording and guess which statuses a phrase like "in review"
 * means, and a site with hundreds of boards is far too large to enumerate.
 */
async function resourceCatalog(db: Db, resources: DigestBriefResource[]): Promise<string[]> {
  const lines: string[] = [];
  const spaces = resources.filter((resource) => resource.type === "confluence_space");
  const boards = resources.filter((resource) => resource.type === "jira_board");
  if (boards.length) {
    lines.push("Pinned Jira boards:");
    let described: Awaited<ReturnType<typeof describeJiraBoards>> = [];
    try {
      described = await describeJiraBoards(db, boardIds(resources));
    } catch (error) {
      // A brief that also covers Confluence still has work to do, so a Jira
      // outage degrades the catalog rather than failing the send.
      lines.push(`- columns unavailable: ${error instanceof Error ? error.message : "Jira lookup failed"}`);
    }
    const columnsById = new Map(described.map((board) => [String(board.id), board.columns]));
    for (const board of boards) {
      const columns = (columnsById.get(board.id) || [])
        .map((column) => `${column.name} [${column.statuses.map((status) => status.id).join(",") || "none"}]`)
        .join(", ");
      lines.push(`- board_id ${board.id}${board.name ? ` "${board.name}"` : ""}${columns ? `; columns: ${columns}` : ""}`);
    }
  }
  if (spaces.length) {
    lines.push("Pinned Confluence spaces:");
    for (const space of spaces) {
      lines.push(`- space key ${space.id}${space.name ? ` "${space.name}"` : ""}`);
    }
  }
  return lines;
}

/**
 * The turn a brief is delivered as. The user's own instruction leads, and
 * everything the app knows follows it as clearly-labelled context so the agent
 * does not mistake the catalog for part of the request.
 */
export async function composeBriefTurn(
  db: Db,
  brief: DigestBriefRow,
  context: { date: string; timezone: string },
): Promise<string> {
  const catalog = await resourceCatalog(db, briefResources(brief));
  return [
    brief.prompt,
    "",
    `--- Context supplied by the app, not by me. Today is ${context.date} in ${context.timezone}.`,
    ...catalog,
    catalog.length
      ? "Use these IDs and keys directly; do not guess a board ID, space key, or status ID, and do not look up boards or spaces that are not listed."
      : "Nothing is pinned to this brief, so resolve any board or space by name with list_jira_boards or list_confluence_spaces before filtering.",
    `This is delivered as an SMS, so answer in under ${SMS_BUDGET} characters of plain text with no markdown, and lead with what changed.`,
  ].join("\n");
}
