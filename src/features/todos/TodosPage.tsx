import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEndEvent, DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { Archive, BellRing, CalendarDays, ChevronRight, CornerDownRight, GripVertical, Columns3, List, Plus } from "lucide-react";
import { api } from "../../api";
import type {
  Todo, TodoStatus,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { AttachButton, ErrorState, Loading } from "../../components/ui";
import { LifeAreaFilter } from "../../components/ui/LifeAreaFilter";
import { LifeAreaPill } from "../../components/ui/LifeAreaPill";
import { CompleteParentDialog } from "./CompleteParentDialog";
import { SubtaskCheck } from "./SubtaskCheck";
import { TodoModal } from "./TodoModal";
import { CalendarView } from "./calendar/CalendarView";
import { friendlyDate, friendlyDueDate, useTimezone } from "../../lib/timezone";
import { boardStatuses, statusMeta } from "../../lib/todo-meta";
import { todoAttachment } from "../../lib/agent-attachments";
import { useDeepLinkTarget } from "../../lib/use-deep-link-target";
import { BOOLEAN, usePreference } from "../../lib/preference";

type TodoView = "table" | "board" | "calendar";

const TODO_VIEWS: readonly TodoView[] = ["table", "board", "calendar"];

export function TodosPage() {
  const queryClient = useQueryClient();
  // How you like to look at the board is a habit rather than a choice you want
  // to make again every morning.
  const [showDone, setShowDone] = usePreference("todos:show-done", true, BOOLEAN);
  const [view, setView] = usePreference<TodoView>("todos:view", "table", TODO_VIEWS);
  const [lifeAreaId, setLifeAreaId] = useState("");
  const [editor, setEditor] = useState<Todo | "new" | null>(null);
  // A task captured from the calendar opens on the slot that was clicked.
  const [capturedAt, setCapturedAt] = useState("");
  const { data: lifeAreas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const { data: todos = [], isLoading, error } = useQuery({
    queryKey: ["todos", showDone, lifeAreaId],
    queryFn: () => api.todos(showDone, lifeAreaId || undefined),
  });
  // `?open=` is how search results land on a specific card. Deriving the editor
  // from the URL keeps the deep link working on a refresh.
  const deepLink = useDeepLinkTarget(todos);
  const editing = editor ?? deepLink.target ?? null;
  const closeEditor = () => { setEditor(null); setCapturedAt(""); deepLink.clear(); };
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["todos"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };
  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TodoStatus }) => api.setTodoStatus(id, status),
    onSuccess: invalidate,
  });
  const finishAll = useMutation({
    mutationFn: async (ids: string[]) => { for (const id of ids) await api.setTodoStatus(id, "done"); },
    onSuccess: invalidate,
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  const children = useMemo(() => {
    const map = new Map<string, Todo[]>();
    todos.forEach(t => { if (t.parent_id) map.set(t.parent_id, [...(map.get(t.parent_id) || []), t]); });
    return map;
  }, [todos]);
  const top = todos.filter(t => !t.parent_id);
  /*
   * Whichever way a task is finished — the row's menu, a drag to Done, the
   * editor — the steps it still owes are settled first. Every path routes
   * through here so the question cannot be skipped by taking another one.
   */
  const [finishing, setFinishing] = useState<Todo | null>(null);
  const openSubtasks = (todo: Todo) => (children.get(todo.id) || [])
    .filter(subtask => subtask.status !== "done" && subtask.status !== "cancelled");
  const setStatus = (id: string, status: TodoStatus) => {
    const todo = todos.find(candidate => candidate.id === id);
    if (status === "done" && todo && openSubtasks(todo).length) setFinishing(todo);
    else mutation.mutate({ id, status });
  };
  function onDragEnd(event: DragEndEvent) {
    const status = event.over?.id as TodoStatus | undefined;
    if (status && boardStatuses.includes(status)) setStatus(String(event.active.id), status);
  }
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  return <div className="page">
    <PageHead eyebrow="Plan · move · finish" title="The board." description="Work stays visible. Change a task's state from the row, drag a card on the board, or ask the agent to do it for you." />
    {/* The page's own controls sit on the filter row: the top right corner
        belongs to the launcher now. */}
    <div className="toolbar">
      <LifeAreaFilter areas={lifeAreas} value={lifeAreaId} onChange={setLifeAreaId}/>
      <div className="toolbar-actions">
        <div className="view-toggle" role="group" aria-label="Task view">
          <button type="button" className={view === "table" ? "active" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}><List size={13}/>List</button>
          <button type="button" className={view === "board" ? "active" : ""} aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 size={13}/>Board</button>
          <button type="button" className={view === "calendar" ? "active" : ""} aria-pressed={view === "calendar"} onClick={() => setView("calendar")}><CalendarDays size={13}/>Calendar</button>
        </div>
        <button className="button ghost" onClick={() => setShowDone(!showDone)}><Archive size={15}/>{showDone ? "Hide done" : "Show done"}</button>
        <button className="button primary" onClick={() => setEditor("new")}><Plus size={15}/>New task</button>
      </div>
    </div>
    {view === "table" && <TodoTable todos={top} children={children} onOpen={setEditor} onStatus={setStatus}/>}
    {view === "board" && <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="board">
        {boardStatuses.filter(s => showDone || s !== "done").map(status => <TodoColumn key={status} status={status} todos={top.filter(t => t.status === status)} children={children} onOpen={setEditor} onStatus={setStatus} />)}
      </div>
    </DndContext>}
    {/* The calendar is given every task rather than only the top-level ones:
        a step with a date of its own is a real thing on a real day. */}
    {view === "calendar" && <CalendarView
      todos={todos}
      lifeAreas={lifeAreas}
      onOpen={setEditor}
      onCreate={local => { setCapturedAt(local); setEditor("new"); }}
    />}
    {editing && <TodoModal
      todo={editing === "new" ? undefined : editing}
      defaultDueAt={editing === "new" ? capturedAt : undefined}
      subtasks={editing === "new" ? [] : children.get(editing.id) || []}
      allTodos={top}
      lifeAreas={lifeAreas}
      onClose={closeEditor}
    />}
    {finishing && <CompleteParentDialog
      todo={finishing}
      open={openSubtasks(finishing)}
      pending={finishAll.isPending}
      onCancel={() => setFinishing(null)}
      onConfirm={withSubtasks => {
        const ids = withSubtasks ? [...openSubtasks(finishing).map(subtask => subtask.id), finishing.id] : [finishing.id];
        finishAll.mutate(ids, { onSuccess: () => setFinishing(null) });
      }}
    />}
  </div>;
}

/** Board order, so switching views does not reshuffle the same work. */
const statusRank = (status: TodoStatus) => {
  const index = boardStatuses.indexOf(status);
  return index === -1 ? boardStatuses.length : index;
};

function TodoTable({ todos, children, onOpen, onStatus }: {
  todos: Todo[];
  children: Map<string, Todo[]>;
  onOpen: (todo: Todo) => void;
  onStatus: (id: string, status: TodoStatus) => void;
}) {
  const timezone = useTimezone();
  const rows = useMemo(() => [...todos].sort((a, b) => statusRank(a.status) - statusRank(b.status)), [todos]);
  // A count on its own never said what the work was. The rows stay collapsed so
  // the list keeps its density, and either the chevron or the count opens them.
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) => setExpanded(ids => ids.includes(id) ? ids.filter(open => open !== id) : [...ids, id]);
  if (!rows.length) return <div className="table-wrap"><div className="table-empty">No tasks match this view.</div></div>;
  return <div className="table-wrap">
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col" className="cell-title">Task</th>
          <th scope="col" className="cell-optional">Area</th>
          <th scope="col">Due</th>
          <th scope="col" className="cell-optional">Priority</th>
          <th scope="col" className="cell-optional">Subtasks</th>
          <th scope="col"><span className="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map(todo => {
          const subtasks = children.get(todo.id) || [];
          const done = subtasks.filter(t => t.status === "done").length;
          const isOpen = expanded.includes(todo.id);
          return <Fragment key={todo.id}>
            <tr>
              <td><StatusPicker todo={todo} onStatus={onStatus}/></td>
              <td className="cell-title"><div className="title-cell">
                {subtasks.length > 0 && <button
                  type="button"
                  className="row-toggle"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Hide" : "Show"} subtasks of ${todo.title}`}
                  onClick={() => toggle(todo.id)}
                ><ChevronRight size={13}/></button>}
                <button type="button" className="title-open" onClick={() => onOpen(todo)}>{todo.title}</button>
              </div></td>
              <td className="cell-optional"><LifeAreaPill name={todo.life_area_name} slug={todo.life_area_slug}/></td>
              <td className="cell-quiet">
                {todo.due_at ? friendlyDueDate(todo.due_at, timezone) : "—"}
                {todo.reminder_at && <span className="cell-reminder" title="Reminder">
                  <BellRing size={11}/>{friendlyDate(todo.reminder_at, timezone)}{todo.extra_reminders?.length ? ` +${todo.extra_reminders.length}` : ""}
                </span>}
              </td>
              <td className="cell-quiet cell-optional">{todo.priority ? `! ${todo.priority}` : "—"}</td>
              <td className="cell-quiet cell-optional">{subtasks.length
                ? <button type="button" className="subtask-count" aria-expanded={isOpen} onClick={() => toggle(todo.id)}>{done}/{subtasks.length}</button>
                : "—"}</td>
              <td className="cell-actions"><AttachButton item={todoAttachment(todo, subtasks)}/></td>
            </tr>
            {isOpen && subtasks.map(subtask => <tr key={subtask.id} className="subtask-row">
              <td><StatusPicker todo={subtask} onStatus={onStatus}/></td>
              <td className="cell-title"><div className="title-cell">
                <CornerDownRight size={13} className="subtask-glyph" aria-hidden="true"/>
                <button type="button" className="title-open" onClick={() => onOpen(subtask)}>{subtask.title}</button>
              </div></td>
              <td className="cell-optional"><LifeAreaPill name={subtask.life_area_name} slug={subtask.life_area_slug}/></td>
              <td className="cell-quiet">{subtask.due_at ? friendlyDueDate(subtask.due_at, timezone) : "—"}</td>
              <td className="cell-quiet cell-optional">{subtask.priority ? `! ${subtask.priority}` : "—"}</td>
              <td className="cell-quiet cell-optional">—</td>
              <td className="cell-actions"><AttachButton item={todoAttachment(subtask, [], todo.title)}/></td>
            </tr>)}
          </Fragment>;
        })}
      </tbody>
    </table>
  </div>;
}

/**
 * The list view needs its own way to change state, since dragging only exists on
 * the board. Both call the same mutation.
 */
function StatusPicker({ todo, onStatus }: { todo: Todo; onStatus: (id: string, status: TodoStatus) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const meta = statusMeta[todo.status];
  const Icon = meta.icon;
  useEffect(() => {
    if (!isOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [isOpen]);
  // The menu is placed against the viewport, so a row near the bottom opens
  // upward and a row near the right edge pulls itself back in rather than
  // running off. Measured before the browser paints, so the menu never shows in
  // the wrong place first. A layout with no layout — jsdom — reports zeroes and
  // lands the menu in the corner, which no assertion depends on.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const size = menu.current?.getBoundingClientRect();
      if (!anchor || !size) return;
      const gap = 3, edge = 8;
      const below = anchor.bottom + gap;
      setAt({
        top: below + size.height > window.innerHeight - edge
          ? Math.max(edge, anchor.top - gap - size.height)
          : below,
        left: Math.max(edge, Math.min(anchor.left, window.innerWidth - edge - size.width)),
      });
    };
    place();
    window.addEventListener("resize", place);
    // Captured, since the box that scrolls under the menu is an ancestor and its
    // own scroll event never reaches the window.
    window.addEventListener("scroll", place, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, { capture: true });
    };
  }, [isOpen]);
  return <div className="status-pick" ref={wrapper}>
    <button
      type="button"
      ref={trigger}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      aria-label={`Status: ${meta.label}`}
      onClick={() => setIsOpen(open => !open)}
      onKeyDown={event => { if (event.key === "Escape") setIsOpen(false); }}
    >
      <Icon size={13} style={{ color: meta.color }}/>{meta.label}
    </button>
    {isOpen && <div className="status-pick-menu" role="menu" ref={menu} style={at ?? undefined}>
      {(Object.keys(statusMeta) as TodoStatus[]).map(status => {
        const option = statusMeta[status];
        const OptionIcon = option.icon;
        return <button
          key={status}
          type="button"
          role="menuitemradio"
          aria-checked={todo.status === status}
          onClick={() => { setIsOpen(false); if (status !== todo.status) onStatus(todo.id, status); }}
        >
          <OptionIcon size={13} style={{ color: option.color }}/>{option.label}
        </button>;
      })}
    </div>}
  </div>;
}

function TodoColumn({ status, todos, children, onOpen, onStatus }: { status: TodoStatus; todos: Todo[]; children: Map<string, Todo[]>; onOpen: (todo: Todo) => void; onStatus: (id: string, status: TodoStatus) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = statusMeta[status];
  return <section ref={setNodeRef} className="column" style={{ outline: isOver ? `1px solid ${meta.color}` : undefined }}>
    <div className="column-head"><strong style={{ color: meta.color }}>{meta.label}</strong><span className="badge">{todos.length}</span></div>
    <div className="column-body">{todos.map(todo => <DraggableTodo key={todo.id} todo={todo} subtasks={children.get(todo.id) || []} onOpen={onOpen} onStatus={onStatus} />)}
      {!todos.length && <div className="empty"><span className="eyebrow">Drop here</span></div>}
    </div>
  </section>;
}

function DraggableTodo({ todo, subtasks, onOpen, onStatus }: { todo: Todo; subtasks: Todo[]; onOpen: (todo: Todo) => void; onStatus: (id: string, status: TodoStatus) => void }) {
  const timezone = useTimezone();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: todo.id });
  // A card has the room the list row does not, so the steps are open by default
  // and the summary is there to fold a long one away.
  const [isOpen, setIsOpen] = useState(true);
  const done = subtasks.filter(t => t.status === "done").length;
  return <article ref={setNodeRef} className={`todo-card ${isDragging ? "dragging" : ""}`} style={{ transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined }} onDoubleClick={() => onOpen(todo)}>
    <div style={{ display: "flex", gap: 8 }}><button aria-label="Drag task" className="button icon ghost" {...listeners} {...attributes}><GripVertical size={13}/></button><div style={{ flex: 1 }}><h4><button type="button" className="card-open" onClick={() => onOpen(todo)}>{todo.title}</button></h4><div className="todo-meta">
      <LifeAreaPill name={todo.life_area_name} slug={todo.life_area_slug}/>{todo.category_name && <span>{todo.category_name}</span>} {todo.due_at && <span>Due {friendlyDueDate(todo.due_at, timezone)}</span>} {todo.reminder_at && <span title="Reminder"><BellRing size={11}/>{friendlyDate(todo.reminder_at, timezone)}{todo.extra_reminders?.length ? ` +${todo.extra_reminders.length}` : ""}</span>} {todo.priority && <span>! {todo.priority}</span>}
    </div></div><AttachButton item={todoAttachment(todo, subtasks)} size={13}/></div>
    {subtasks.length > 0 && <div className="card-subtasks" onDoubleClick={event => event.stopPropagation()}>
      <div className="progress"><span style={{ width: `${(done / subtasks.length) * 100}%` }}/></div>
      <button type="button" className="subtask-summary" aria-expanded={isOpen} onClick={() => setIsOpen(open => !open)}>
        <ChevronRight size={12}/>{done}/{subtasks.length} subtasks
      </button>
      {isOpen && <ul className="subtask-list">{subtasks.map(subtask => <li key={subtask.id}>
        <SubtaskCheck todo={subtask} onToggle={() => onStatus(subtask.id, subtask.status === "done" ? "pending" : "done")}/>
        <button type="button" className="subtask-title" onClick={() => onOpen(subtask)}>{subtask.title}</button>
        <AttachButton item={todoAttachment(subtask, [], todo.title)} size={11}/>
      </li>)}</ul>}
    </div>}
  </article>;
}
