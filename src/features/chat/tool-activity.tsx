import { type Tools } from "react-instantsearch";
import { BookText, Check, Database, LoaderCircle, SquareKanban, TriangleAlert } from "lucide-react";

type ToolLayoutProps = Parameters<NonNullable<Tools[string]["layoutComponent"]>>[0];

/** The Atlassian tools are the first that read outside SQLite, so the card names
 *  which system answered rather than assuming the local database. */
type ToolSource = "SQLite" | "Jira" | "Confluence";

const sourceIcon: Record<ToolSource, typeof Database> = {
  SQLite: Database,
  Jira: SquareKanban,
  Confluence: BookText,
};

export const toolActivityMeta: Record<string, { active: string; done: string; source: ToolSource }> = {
  list_life_areas: { active: "Checking classifications", done: "Classifications loaded", source: "SQLite" },
  get_conversation_context: { active: "Reading conversation context", done: "Conversation context loaded", source: "SQLite" },
  get_todo: { active: "Reading task", done: "Task loaded", source: "SQLite" },
  list_todos: { active: "Checking current tasks", done: "Tasks checked", source: "SQLite" },
  create_todo: { active: "Saving new task", done: "Task saved", source: "SQLite" },
  update_todo: { active: "Updating task", done: "Task updated", source: "SQLite" },
  set_todo_status: { active: "Changing task status", done: "Task status updated", source: "SQLite" },
  delete_todo: { active: "Removing task", done: "Task removed", source: "SQLite" },
  get_memory: { active: "Opening memory", done: "Memory recalled", source: "SQLite" },
  create_memory: { active: "Saving memory", done: "Memory saved", source: "SQLite" },
  update_memory: { active: "Updating memory", done: "Memory updated", source: "SQLite" },
  delete_memory: { active: "Removing memory", done: "Memory removed", source: "SQLite" },
  get_reflection_evidence: { active: "Gathering reflection evidence", done: "Reflection evidence ready", source: "SQLite" },
  get_review_evidence: { active: "Gathering quarterly evidence", done: "Review evidence ready", source: "SQLite" },
  get_agenda: { active: "Reviewing agenda", done: "Agenda checked", source: "SQLite" },
  create_reminder: { active: "Scheduling reminder", done: "Reminder scheduled", source: "SQLite" },
  list_reminders: { active: "Checking reminders", done: "Reminders checked", source: "SQLite" },
  update_reminder: { active: "Moving reminder", done: "Reminder updated", source: "SQLite" },
  delete_reminder: { active: "Removing reminder", done: "Reminder removed", source: "SQLite" },
  list_jira_boards: { active: "Finding Jira boards", done: "Jira boards loaded", source: "Jira" },
  list_jira_issues: { active: "Checking Jira issues", done: "Jira issues checked", source: "Jira" },
  get_jira_issue: { active: "Reading Jira issue", done: "Jira issue loaded", source: "Jira" },
  list_jira_users: { active: "Looking up person in Jira", done: "Person resolved", source: "Jira" },
  list_confluence_spaces: { active: "Finding Confluence spaces", done: "Confluence spaces loaded", source: "Confluence" },
  list_confluence_pages: { active: "Searching Confluence pages", done: "Confluence pages found", source: "Confluence" },
  get_confluence_page: { active: "Reading Confluence page", done: "Confluence page loaded", source: "Confluence" },
  list_confluence_comments: { active: "Checking Confluence comments", done: "Confluence comments checked", source: "Confluence" },
};

function toolResultDetail(output: unknown): string | null {
  if (!output || typeof output !== "object" || !("data" in output)) return null;
  const data = (output as { data?: unknown }).data;
  if (Array.isArray(data)) return `${data.length} ${data.length === 1 ? "record" : "records"}`;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.key === "string" && typeof record.summary === "string") {
      return `${record.key} · ${record.summary}`;
    }
    if (typeof record.title === "string") {
      return typeof record.status === "string"
        ? `${record.title} · ${record.status.replace("_", " ")}`
        : record.title;
    }
    const counts = ["todos", "reminders", "subtasks", "issues", "boards", "pages", "spaces", "comments", "users"].reduce((total, key) => {
      const value = record[key];
      return total + (Array.isArray(value) ? value.length : 0);
    }, 0);
    if (counts) return `${counts} ${counts === 1 ? "record" : "records"}`;
  }
  return null;
}

export function createToolActivityLayout(name: string) {
  const meta = toolActivityMeta[name] || { active: "Working", done: "Complete", source: "SQLite" as const };
  const SourceIcon = sourceIcon[meta.source];
  return function ToolActivity({ message }: ToolLayoutProps) {
    const finished = message.state === "output-available";
    const output = "output" in message ? message.output : undefined;
    const failed = finished && Boolean(
      output && typeof output === "object" && "success" in output && output.success === false,
    );
    const detail = finished && !failed ? toolResultDetail(output) : null;
    const error = failed && output && typeof output === "object" && "error" in output
      ? String(output.error)
      : null;
    return <div className={`agent-tool-activity ${finished ? "complete" : "working"} ${failed ? "failed" : ""}`}>
      <span className="agent-tool-symbol">
        {failed ? <TriangleAlert size={14}/> : finished ? <Check size={14}/> : <LoaderCircle className="spin" size={14}/>}
      </span>
      <span className="agent-tool-copy">
        <strong>{failed ? `${meta.active} failed` : finished ? meta.done : meta.active}</strong>
        <small>{error || detail || (finished ? "Confirmed" : "One moment…")}</small>
      </span>
      <span className="agent-tool-source"><SourceIcon size={10}/>{meta.source}</span>
    </div>;
  };
}
