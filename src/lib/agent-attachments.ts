import type { Memory, Todo } from "../types";

export type AgentAttachmentType = "todo" | "subtask" | "memory" | "completed-task";

/**
 * A record the user handed to the agent from the page they were already looking
 * at, so the message they type can be about it without naming it again.
 */
export interface AgentAttachment {
  /** `${type}:${id}`, so attaching the same row twice keeps one chip. */
  key: string;
  type: AgentAttachmentType;
  id: string;
  /** What the chip above the composer reads. */
  label: string;
  /** The fields the agent is shown. Ids in here are canonical SQLite ids. */
  record: Record<string, unknown>;
}

/** How many records one turn may carry, and how much of each. */
export const maxAttachments = 5;
const maxProseLength = 280;
const maxSerializedLength = 3500;

const trim = (value: string | null | undefined, limit = maxProseLength) => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/**
 * Drops keys the agent would have to reason about the absence of. A record of
 * mostly nulls reads as missing data rather than as an unset optional field.
 */
function compact(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) =>
      value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length),
    ),
  );
}

/**
 * A parent carries its steps so that "the subtask I just finished" resolves to
 * an id without a second lookup, and so a follow-up step can be created under
 * the right parent in the same turn.
 */
export function todoAttachment(todo: Todo, subtasks: Todo[] = [], parentTitle?: string): AgentAttachment {
  const type: AgentAttachmentType = todo.parent_id ? "subtask" : "todo";
  return {
    key: `${type}:${todo.id}`,
    type,
    id: todo.id,
    label: todo.title,
    record: compact({
      type: type === "subtask" ? "subtask" : "todo",
      id: todo.id,
      title: todo.title,
      status: todo.status,
      notes: trim(todo.notes),
      due_at: todo.due_at,
      reminder_at: todo.reminder_at,
      priority: todo.priority,
      life_area: todo.life_area_name,
      category: todo.category_name,
      parent_id: todo.parent_id,
      parent_title: parentTitle,
      subtasks: subtasks.map(subtask => ({ id: subtask.id, title: subtask.title, status: subtask.status })),
    }),
  };
}

/** A completed task attached as reflection evidence rather than as live work. */
export function completedTaskAttachment(todo: Todo): AgentAttachment {
  return {
    key: `completed-task:${todo.id}`,
    type: "completed-task",
    id: todo.id,
    label: todo.title,
    record: compact({
      type: "completed_todo",
      id: todo.id,
      title: todo.title,
      status: todo.status,
      notes: trim(todo.notes),
      completed_at: todo.completed_at,
      life_area: todo.life_area_name,
      category: todo.category_name,
    }),
  };
}

export function memoryAttachment(memory: Memory): AgentAttachment {
  return {
    key: `memory:${memory.id}`,
    type: "memory",
    id: memory.id,
    label: memory.title || trim(memory.content, 60) || "Untitled memory",
    record: compact({
      type: "memory",
      id: memory.id,
      kind: memory.kind,
      title: memory.title,
      content: trim(memory.content),
      tags: memory.tags,
      occurred_at: memory.occurred_at,
      mood_label: memory.mood_label,
      life_area: memory.life_area_name,
      review_worthy: memory.review_worthy || undefined,
    }),
  };
}

const attachmentNote =
  "Records the user attached from the app UI for this turn. The ids are canonical and may be used directly.";

/**
 * Turn context is a flat `Record<string, string>` that Agent Studio validates
 * for key and value length, so the records are serialized into one value and
 * dropped from the tail until they fit rather than being sent oversized.
 */
export function serializeAttachments(attachments: AgentAttachment[]): Record<string, string> {
  if (!attachments.length) return {};
  let records = attachments.slice(0, maxAttachments).map(attachment => attachment.record);
  let serialized = JSON.stringify(records);
  while (records.length > 1 && serialized.length > maxSerializedLength) {
    records = records.slice(0, -1);
    serialized = JSON.stringify(records);
  }
  return {
    attachedRecordCount: String(records.length),
    attachedRecordsNote: attachmentNote,
    attachedRecords: serialized.slice(0, maxSerializedLength),
  };
}

/**
 * The local demo agent has no context channel, so the same records go in as
 * text. Kept terse: the regex assistant behind it only reads the user's own
 * sentence, and a human rereading the transcript should still recognise it.
 */
export function attachmentsAsText(attachments: AgentAttachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.slice(0, maxAttachments).map(attachment => `- ${attachment.label}`);
  return `[Attached ${attachments.length === 1 ? "record" : "records"}]\n${lines.join("\n")}\n\n`;
}
