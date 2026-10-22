import { Pencil } from "lucide-react";
import type { Todo } from "../../types";
import { type OpenOptions, useTaskOpenModeValue } from "../../lib/task-open-mode";

/**
 * The way to the form while a click on a task goes to the chat. Drawn only in
 * chat mode: when a click already opens the editor there is nothing for it to
 * add. It sits beside `AttachButton` and stops its clicks the same way.
 */
export function EditButton({ todo, onOpen, size = 12 }: {
  todo: Todo;
  onOpen: (todo: Todo, options?: OpenOptions) => void;
  size?: number;
}) {
  if (useTaskOpenModeValue() !== "chat") return null;
  return <button
    type="button"
    className="button icon ghost attach-button edit-button"
    aria-label={`Edit: ${todo.title}`}
    title="Edit in the form"
    onClick={event => { event.stopPropagation(); onOpen(todo, { manual: true }); }}
    onDoubleClick={event => event.stopPropagation()}
  ><Pencil size={size}/></button>;
}
