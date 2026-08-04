import { CheckCircle2, Circle, Pause, Play, X } from "lucide-react";
import type {
  Reminder, TodoStatus,
} from "../types";

/**
 * The colours are token references rather than literals so status reads correctly
 * in both themes; they are used in `style={{ color }}` and `outline`, where a
 * `var()` string resolves the same as a hex would.
 */
export const statusMeta: Record<TodoStatus, { label: string; icon: typeof Circle; color: string }> = {
  pending: { label: "To do", icon: Circle, color: "var(--status-todo)" },
  in_progress: { label: "In progress", icon: Play, color: "var(--status-progress)" },
  blocked: { label: "Blocked", icon: Pause, color: "var(--status-blocked)" },
  done: { label: "Done", icon: CheckCircle2, color: "var(--status-done)" },
  cancelled: { label: "Cancelled", icon: X, color: "var(--status-cancelled)" },
};

export const boardStatuses: TodoStatus[] = ["pending", "in_progress", "blocked", "done"];

/**
 * A todo's due date and its reminders are all rows in the same schedule, so any
 * list of them has to say which one it is showing.
 */
export const reminderKindLabels: Record<Reminder["kind"], string> = {
  due: "Due",
  pre: "Reminder",
  escalation: "Extra",
};
