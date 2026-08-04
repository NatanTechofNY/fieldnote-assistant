import { Square, SquareCheck } from "lucide-react";
import type { Todo } from "../../types";

/**
 * The one control a subtask needs everywhere it is listed. A button rather than
 * a real checkbox, because the value it writes is a status the rest of the app
 * also sets from a menu and a drag, not a boolean of its own.
 */
export function SubtaskCheck({ todo, onToggle, disabled }: { todo: Todo; onToggle: () => void; disabled?: boolean }) {
  const done = todo.status === "done";
  return <button
    type="button"
    role="checkbox"
    aria-checked={done}
    aria-label={`${done ? "Reopen" : "Complete"} subtask ${todo.title}`}
    className="subtask-check"
    disabled={disabled}
    onClick={onToggle}
  >{done ? <SquareCheck size={14}/> : <Square size={14}/>}</button>;
}
