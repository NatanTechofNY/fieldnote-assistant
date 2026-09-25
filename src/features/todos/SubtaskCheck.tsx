import { Square, SquareCheck, SquarePause, SquarePlay, SquareX } from "lucide-react";
import { statusMeta } from "../../lib/todo-meta";
import type { Todo, TodoStatus } from "../../types";

/** A step that is under way or stuck says so; the other states read from the box alone. */
const MARKED_STATES = new Set<TodoStatus>(["in_progress", "blocked"]);

const boxes: Record<TodoStatus, typeof Square> = {
  pending: Square,
  in_progress: SquarePlay,
  blocked: SquarePause,
  done: SquareCheck,
  cancelled: SquareX,
};

/**
 * The one control a subtask needs everywhere it is listed. A button rather than
 * a real checkbox, because the value it writes is a status the rest of the app
 * also sets from a menu and a drag, not a boolean of its own. Ticking only moves
 * between done and not done, but the box is drawn for whichever status the step
 * has, so a started step does not look untouched.
 */
export function SubtaskCheck({ todo, onToggle, disabled }: { todo: Todo; onToggle: () => void; disabled?: boolean }) {
  const done = todo.status === "done";
  const Box = boxes[todo.status];
  const marked = MARKED_STATES.has(todo.status);
  return <button
    type="button"
    role="checkbox"
    aria-checked={done}
    aria-label={`${done ? "Reopen" : "Complete"} subtask ${todo.title}${marked ? ` (${statusMeta[todo.status].label.toLowerCase()})` : ""}`}
    title={statusMeta[todo.status].label}
    className="subtask-check"
    data-status={todo.status}
    disabled={disabled}
    onClick={onToggle}
  ><Box size={14} style={marked ? { color: statusMeta[todo.status].color } : undefined}/></button>;
}

/** The status word beside a step's title, for the states the box alone is too small to carry. */
export function SubtaskState({ todo }: { todo: Todo }) {
  if (!MARKED_STATES.has(todo.status)) return null;
  const meta = statusMeta[todo.status];
  return <span className="subtask-state" style={{ color: meta.color }}>{meta.label}</span>;
}
