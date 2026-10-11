import { Play, Square, SquareCheck, SquarePause, SquarePlay, SquareX } from "lucide-react";
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

/**
 * Marks a step as started, or sends it back to to do. Only the two states it
 * moves between get the control: a finished, blocked, or cancelled step is not
 * one the owner is about to start, and the checkbox and menu already reach them.
 */
export function SubtaskStart({ todo, onToggle, disabled }: { todo: Todo; onToggle: () => void; disabled?: boolean }) {
  if (todo.status !== "pending" && todo.status !== "in_progress") return null;
  const going = todo.status === "in_progress";
  // One fixed name with `aria-pressed` carrying the state, so a screen reader says it once.
  return <button
    type="button"
    aria-pressed={going}
    aria-label={`In progress: subtask ${todo.title}`}
    title={going ? "In progress: click to move back to to do" : "Mark in progress"}
    className="subtask-start"
    disabled={disabled}
    onClick={onToggle}
  ><Play size={12}/></button>;
}

/**
 * How far through its steps a task is: done in green, started in the
 * in-progress colour behind it. Shared by every view that counts a task's steps.
 * A compact bar sits inside or beside a count that already says it in words,
 * so it is hidden from assistive tech rather than read twice.
 */
export function SubtaskProgress({ done, going = 0, total, compact }: { done: number; going?: number; total: number; compact?: boolean }) {
  if (!total) return null;
  const semantics = compact
    ? { "aria-hidden": true }
    : { role: "progressbar", "aria-label": `${done} of ${total} subtasks done`, "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done };
  return <span className={`progress${compact ? " compact" : ""}`} {...semantics}>
    <span style={{ width: `${(done / total) * 100}%` }}/>
    {going > 0 && <span className="progress-going" style={{ width: `${(going / total) * 100}%` }}/>}
  </span>;
}

/** The status word beside a step's title, for the states the box alone is too small to carry. */
export function SubtaskState({ todo }: { todo: Todo }) {
  if (!MARKED_STATES.has(todo.status)) return null;
  const meta = statusMeta[todo.status];
  return <span className="subtask-state" style={{ color: meta.color }}>{meta.label}</span>;
}
