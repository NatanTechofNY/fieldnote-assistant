import { Check, ListChecks, LoaderCircle } from "lucide-react";
import type { Todo } from "../../types";
import { Modal } from "../../components/ui";

/**
 * Finishing a task whose steps are still open is usually a slip rather than a
 * decision, and the steps left behind are invisible: only top-level rows are
 * drawn, so nothing on the board would ever mention them again. The choice is
 * offered once, here, rather than assumed in either direction.
 */
export function CompleteParentDialog({ todo, open, pending, onCancel, onConfirm }: {
  todo: Todo;
  open: Todo[];
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (withSubtasks: boolean) => void;
}) {
  return <Modal title="Finish this task?" onClose={onCancel}>
    <p className="modal-intro">
      <strong>{todo.title}</strong> still has {open.length} subtask{open.length === 1 ? "" : "s"} to go.
    </p>
    <ul className="subtask-list confirm-list">{open.map(subtask => <li key={subtask.id}>
      <span className="subtask-check" aria-hidden="true"><ListChecks size={14}/></span>
      <span className="subtask-name">{subtask.title}</span>
    </li>)}</ul>
    <div className="modal-actions">
      <button type="button" className="button ghost" onClick={onCancel}>Cancel</button>
      <span style={{ flex: 1 }} />
      <button type="button" className="button" disabled={pending} onClick={() => onConfirm(false)}>Only this task</button>
      <button type="button" className="button primary" disabled={pending} onClick={() => onConfirm(true)}>
        {pending ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}Finish all {open.length + 1}
      </button>
    </div>
  </Modal>;
}
