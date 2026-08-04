import { type FormEvent, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Plus, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "../../api";
import type {
  LifeArea, Todo, TodoStatus,
} from "../../types";
import { Field, MarkdownEditor, Modal } from "../../components/ui";
import { friendlyDueDate, toZonedDateTimeLocal, useTimezone, zonedDateTimeLocalToIso } from "../../lib/timezone";
import { boardStatuses, statusMeta } from "../../lib/todo-meta";
import { invalidateContent } from "../../lib/invalidate";
import { CompleteParentDialog } from "./CompleteParentDialog";
import { SubtaskCheck } from "./SubtaskCheck";

export function TodoModal({ todo, subtasks, allTodos, lifeAreas, onClose }: { todo?: Todo; subtasks: Todo[]; allTodos: Todo[]; lifeAreas: LifeArea[]; onClose: () => void }) {
  const timezone = useTimezone();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(todo?.title || "");
  const [notes, setNotes] = useState(todo?.notes || "");
  const [dueAt, setDueAt] = useState(toZonedDateTimeLocal(todo?.due_at, timezone));
  const [reminderAt, setReminderAt] = useState(toZonedDateTimeLocal(todo?.reminder_at, timezone));
  const [extraReminders, setExtraReminders] = useState(
    () => (todo?.extra_reminders || []).map(value => toZonedDateTimeLocal(value, timezone)),
  );
  const [scheduleError, setScheduleError] = useState("");
  const [status, setStatus] = useState<TodoStatus>(todo?.status || "pending");
  const [priority, setPriority] = useState<NonNullable<Todo["priority"]>>(todo?.priority || "normal");
  const [parentId, setParentId] = useState(todo?.parent_id || "");
  const [lifeAreaId, setLifeAreaId] = useState(todo?.life_area_id || "");
  // A task being captured has no id to hang children off yet, so its steps are
  // held here and sent with the create call. An existing task writes each one
  // straight away, the way the checkboxes beside them already do.
  const [drafts, setDrafts] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  // Existing children win over a parent the record also has: the agent can
  // write a middle node, and its steps still have to be reachable.
  const nested = Boolean(parentId) && subtasks.length === 0;
  const save = useMutation({
    mutationFn: () => {
      const input = {
        title,
        notes,
        due_at: dueAt ? zonedDateTimeLocalToIso(dueAt, timezone) : null,
        reminder_at: reminderAt ? zonedDateTimeLocalToIso(reminderAt, timezone) : null,
        extra_reminders: [...new Set(
          extraReminders.filter(Boolean).map(value => zonedDateTimeLocalToIso(value, timezone)),
        )],
        status,
        priority,
        parent_id: parentId || null,
        life_area_id: lifeAreaId || null,
        life_area_source: lifeAreaId ? "user" as const : null,
      };
      return todo
        ? api.updateTodo(todo.id, input)
        : api.createTodo({ ...input, subtasks: nested ? [] : drafts.map(subtask => ({ title: subtask })) });
    },
    onSuccess: () => { invalidateContent(queryClient); onClose(); },
  });
  const addSubtask = useMutation({
    mutationFn: (subtaskTitle: string) => api.createTodo({
      title: subtaskTitle,
      parent_id: todo!.id,
      life_area_id: lifeAreaId || null,
      life_area_source: lifeAreaId ? "user" as const : null,
    }),
    onSuccess: () => invalidateContent(queryClient),
  });
  const setSubtaskStatus = useMutation({
    mutationFn: (input: { id: string; status: TodoStatus }) => api.setTodoStatus(input.id, input.status),
    onSuccess: () => invalidateContent(queryClient),
  });
  const removeSubtask = useMutation({
    mutationFn: (id: string) => api.deleteTodo(id),
    onSuccess: () => invalidateContent(queryClient),
  });
  const addDraft = () => {
    const next = draft.trim();
    if (!next) return;
    if (todo) addSubtask.mutate(next); else setDrafts([...drafts, next]);
    setDraft("");
  };
  const doneCount = subtasks.filter(subtask => subtask.status === "done").length;
  /*
   * Times the record already carries stay saveable once they are in the past, so
   * renaming a stale task does not force its old reminder forward first. A time
   * the user just typed is held to the same future-only rule as the API.
   */
  const scheduled = useMemo(
    () => new Set([todo?.reminder_at, ...(todo?.extra_reminders || [])]
      .map(value => toZonedDateTimeLocal(value, timezone))),
    [todo, timezone],
  );
  /*
   * The status select can finish a task too, so the editor asks the same
   * question the board does before it leaves subtasks behind.
   */
  const stillOpen = subtasks.filter(subtask => subtask.status !== "done" && subtask.status !== "cancelled");
  const [confirming, setConfirming] = useState(false);
  const finishSubtasks = useMutation({
    mutationFn: async () => { for (const subtask of stillOpen) await api.setTodoStatus(subtask.id, "done"); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const added = [reminderAt, ...extraReminders].filter(value => value && !scheduled.has(value));
    if (added.some(value => new Date(zonedDateTimeLocalToIso(value, timezone)) <= new Date())) {
      setScheduleError("A new reminder has to be in the future.");
      return;
    }
    setScheduleError("");
    if (status === "done" && todo?.status !== "done" && stillOpen.length) setConfirming(true);
    else save.mutate();
  };
  const remove = useMutation({ mutationFn: () => api.deleteTodo(todo!.id), onSuccess: () => { invalidateContent(queryClient); onClose(); } });
  /*
   * Two columns, split by the question each answers: the left is what the work
   * is, the right is when it happens and where it is filed. One long stack put
   * a parent picker between the notes and the reminder that would actually go
   * out, and everything read as equally important.
   */
  if (confirming && todo) {
    return <CompleteParentDialog
      todo={todo}
      open={stillOpen}
      pending={finishSubtasks.isPending || save.isPending}
      onCancel={() => setConfirming(false)}
      onConfirm={async withSubtasks => {
        if (withSubtasks) await finishSubtasks.mutateAsync();
        save.mutate();
      }}
    />;
  }
  return <Modal title={todo ? "Edit task" : "Capture a task"} onClose={onClose} wide>
    <form onSubmit={submit} className="task-form">
      <div className="task-form-main">
        <Field label="Task"><input className="input" value={title} onChange={e => setTitle(e.target.value)} required autoFocus /></Field>
        <Field label="Notes"><MarkdownEditor value={notes} onChange={setNotes} /></Field>
        <div className="subtask-editor">
          <div className="subtask-editor-head">
            <span className="eyebrow">Subtasks</span>
            {subtasks.length > 0 && <span className="subtask-tally">{doneCount} of {subtasks.length} done</span>}
          </div>
          {/* Steps under a step would be stored happily and drawn nowhere, so a
              task filed under another one is not offered a list. */}
          {nested && <p className="subtask-empty">Filed under another task, so this one carries no checklist of its own.</p>}
          {subtasks.length > 0 && <ul className="subtask-list">{subtasks.map(subtask => <li key={subtask.id} className={subtask.status === "done" ? "done" : ""}>
            <SubtaskCheck
              todo={subtask}
              disabled={setSubtaskStatus.isPending}
              onToggle={() => setSubtaskStatus.mutate({ id: subtask.id, status: subtask.status === "done" ? "pending" : "done" })}
            />
            <span className="subtask-name">{subtask.title}</span>
            {subtask.due_at && <span className="subtask-due">{friendlyDueDate(subtask.due_at, timezone)}</span>}
            <button type="button" className="button icon ghost" aria-label={`Delete subtask ${subtask.title}`} onClick={() => removeSubtask.mutate(subtask.id)}><Trash2 size={13}/></button>
          </li>)}</ul>}
          {!nested && drafts.length > 0 && <ul className="subtask-list">{drafts.map((subtask, index) => <li key={index}>
            <span className="subtask-check" aria-hidden="true"><Square size={14}/></span>
            <span className="subtask-name">{subtask}</span>
            <button type="button" className="button icon ghost" aria-label={`Remove subtask ${subtask}`} onClick={() => setDrafts(drafts.filter((_, at) => at !== index))}><X size={13}/></button>
          </li>)}</ul>}
          {!nested && !subtasks.length && !drafts.length && <p className="subtask-empty">No subtasks yet. Each one you add gets its own line under this task on the board.</p>}
          {!nested && <div className="subtask-add">
            <input
              className="input"
              aria-label="New subtask"
              placeholder="Add a subtask"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addDraft(); } }}
            />
            <button type="button" className="button ghost" disabled={!draft.trim() || addSubtask.isPending} onClick={addDraft}>
              {addSubtask.isPending ? <LoaderCircle className="spin" size={13}/> : <Plus size={13}/>}Add
            </button>
          </div>}
          {addSubtask.error && <div className="inline-error"><TriangleAlert size={14}/><span>{addSubtask.error.message}</span></div>}
        </div>
      </div>
      <aside className="task-form-side">
        <section className="task-panel">
          <span className="eyebrow">Schedule</span>
          <Field label={`Due · ${timezone}`}><input type="datetime-local" className="input" value={dueAt} onChange={e => setDueAt(e.target.value)} /></Field>
          <Field label={`Remind me · ${timezone}`} hint="A due date on its own never notifies you. Reminders do.">
            <input type="datetime-local" className="input" value={reminderAt} onChange={e => setReminderAt(e.target.value)} />
          </Field>
          {extraReminders.length > 0 && <span className="eyebrow">Extra reminders</span>}
          {extraReminders.map((value, index) => <div className="reminder-extra" key={index}>
            <input
              type="datetime-local"
              className="input"
              aria-label={`Extra reminder ${index + 1}`}
              value={value}
              onChange={e => setExtraReminders(extraReminders.map((entry, at) => at === index ? e.target.value : entry))}
            />
            <button
              type="button"
              className="button icon ghost"
              aria-label={`Remove extra reminder ${index + 1}`}
              onClick={() => setExtraReminders(extraReminders.filter((_, at) => at !== index))}
            ><X size={13}/></button>
          </div>)}
          <button type="button" className="button ghost" onClick={() => setExtraReminders([...extraReminders, ""])}><Plus size={13}/>Add a reminder</button>
        </section>
        <section className="task-panel">
          <span className="eyebrow">Filing</span>
          <div className="task-pair">
            <Field label="Status"><select className="select" value={status} onChange={e => setStatus(e.target.value as TodoStatus)}>{boardStatuses.map(s => <option key={s} value={s}>{statusMeta[s].label}</option>)}</select></Field>
            <Field label="Priority"><select className="select" value={priority} onChange={e => setPriority(e.target.value as NonNullable<Todo["priority"]>)}><option>low</option><option>normal</option><option>high</option><option>urgent</option></select></Field>
          </div>
          <Field label="Life area"><select className="select" value={lifeAreaId} onChange={e => setLifeAreaId(e.target.value)}><option value="">Unclassified</option>{lifeAreas.map(area => <option value={area.id} key={area.id}>{area.name}</option>)}</select></Field>
          {/* Only one level of nesting is ever drawn, so a task that already has
              steps of its own cannot be filed under another one and disappear. */}
          <Field label="Parent" hint={subtasks.length ? "A task with its own subtasks stays top level." : undefined}>
            <select className="select" value={parentId} disabled={subtasks.length > 0} onChange={e => setParentId(e.target.value)}><option value="">Top-level task</option>{allTodos.filter(t => t.id !== todo?.id).map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select>
          </Field>
        </section>
      </aside>
      {scheduleError && <div className="inline-error"><TriangleAlert size={14}/><span>{scheduleError}</span></div>}
      {save.error && <div className="inline-error"><TriangleAlert size={14}/><span>{save.error.message}</span></div>}
      <div className="modal-actions">
        {todo && <button type="button" className="button danger" onClick={() => confirm("Delete this task?") && remove.mutate()}><Trash2 size={14}/>Delete</button>}
        <span style={{ flex: 1 }} /><button type="button" className="button ghost" onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}Save</button>
      </div>
    </form>
  </Modal>;
}
