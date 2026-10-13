import { listJiraIssues } from "../atlassian-service.ts";
import { getAtlassianConfig } from "../integrations.ts";
import type { PageBlock } from "../pages.ts";
import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

/** Where the owner's Jira work stands: counts by status category and the issues that are blocked or due. A snapshot. */
export const jiraStatus: TemplateBuilder = async (db, _scope, params) => {
  const config = getAtlassianConfig(db);
  if (!config.configured || !config.jiraAvailable) throw new PageError("Connect Jira in Settings before making a Jira status page");
  const { issues } = await listJiraIssues(db, { assignee: "me", updated_within_days: 30, limit: 50 });
  const byCategory = new Map<string, number>();
  for (const issue of issues) byCategory.set(issue.status_category ?? "Other", (byCategory.get(issue.status_category ?? "Other") ?? 0) + 1);
  const line = (issue: (typeof issues)[number]) =>
    `${issue.key}: ${issue.summary ?? ""} (${issue.status ?? "unknown"}${issue.assignee?.display_name ? `, ${issue.assignee.display_name}` : ""})`;
  const blocked = issues.filter(issue => /block/i.test(issue.status ?? ""));
  const blocks: PageBlock[] = [
    { type: "stats", text: "My issues, updated in the last 30 days", items: [...byCategory].map(([name, count]) => `${name} | ${count}`) },
  ];
  if (blocked.length) blocks.push({ type: "heading", text: "Blocked" }, { type: "checklist", items: blocked.map(line) });
  const active = issues.filter(issue => issue.status_category !== "Done" && !blocked.includes(issue));
  if (active.length) blocks.push({ type: "heading", text: "In flight" }, { type: "checklist", items: active.slice(0, 20).map(line) });
  if (config.siteUrl) blocks.push({ type: "link", text: "Open Jira", url: config.siteUrl });
  return { title: params.title || "Jira status", audience: "owner", expiresInDays: 3, blocks };
};
