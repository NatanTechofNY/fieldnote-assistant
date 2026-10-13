import { getAtlassianConfig } from "../integrations.ts";
import { listJiraIssues } from "../atlassian-service.ts";
import { likePattern, USER_ID } from "../db.ts";
import type { PageBlock } from "../pages.ts";
import { PageError } from "../pages.ts";
import type { TemplateBuilder } from "./types.ts";

const snippet = (text: string, length = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

/**
 * What is on file about the people in a meeting: the memories that name them,
 * Granola notes from earlier meetings, and Jira issues that mention them. A
 * snapshot taken when the page is made; the owner reads it, nobody else.
 */
export const meetingPrep: TemplateBuilder = async (db, _scope, params) => {
  const people = params.items ?? [];
  if (!people.length) throw new PageError("meeting_prep needs the attendees' names in items");
  const blocks: PageBlock[] = [];
  if (params.when) blocks.push({ type: "countdown", text: params.title || "The meeting", when: params.when });
  const jira = getAtlassianConfig(db);
  for (const person of people.slice(0, 6)) {
    const memories = db.prepare(`
      SELECT title,content FROM memories WHERE user_id=? AND (content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
        AND (life_area_id IS NULL OR life_area_id NOT IN (SELECT id FROM life_areas WHERE thread_id IS NOT NULL))
      ORDER BY updated_at DESC LIMIT 4
    `).all(USER_ID, likePattern(person), likePattern(person)) as Array<{ title: string | null; content: string }>;
    const meetings = db.prepare(`
      SELECT json_extract(payload_json,'$.title') title,created_at FROM external_events
      WHERE user_id=? AND source='granola' AND payload_json LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3
    `).all(USER_ID, likePattern(person)) as Array<{ title: string | null; created_at: string }>;
    let issues: string[] = [];
    if (jira.configured && jira.jiraAvailable) {
      try {
        issues = (await listJiraIssues(db, { text: person, updated_within_days: 60, limit: 3 })).issues
          .map(issue => `${issue.key}: ${issue.summary ?? ""} (${issue.status ?? "unknown"})`);
      } catch {
        // Jira being unreachable should not stop the page; the section is simply left out.
      }
    }
    blocks.push({ type: "heading", text: person });
    const lines = [
      ...memories.map(memory => `${memory.title ? `${memory.title}: ` : ""}${snippet(memory.content)}`),
      ...meetings.map(meeting => `Earlier meeting: ${meeting.title ?? "Untitled"} (${meeting.created_at.slice(0, 10)})`),
      ...issues,
    ];
    blocks.push(lines.length ? { type: "checklist", items: lines.map(line => snippet(line, 200)) } : { type: "text", text: "Nothing on file yet." });
  }
  return { title: params.title || "Meeting prep", audience: "owner", expiresInDays: 7, blocks };
};
