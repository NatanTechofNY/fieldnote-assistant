import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEndEvent, DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { Archive, BellRing, CalendarDays, ChevronRight, CornerDownRight, GripVertical, Columns3, List, Plus, Repeat, Search } from "lucide-react";
import { api } from "../../api";
import type {
  LifeArea, Todo, TodoStatus,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { AttachButton, ErrorState, Loading } from "../../components/ui";
import { LifeAreaFilter } from "../../components/ui/LifeAreaFilter";
import { areaFilterParams, inAreaFilter } from "../../lib/area-filter";
import { useAreaFilter } from "../../lib/use-area-filter";
import { LifeAreaPill } from "../../components/ui/LifeAreaPill";
import { CompleteParentDialog } from "./CompleteParentDialog";
import { SubtaskCheck } from "./SubtaskCheck";
import { TodoModal } from "./TodoModal";
import { CalendarView } from "./calendar/CalendarView";
import { describeRecurrence } from "../../lib/recurrence";
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
  const { data: lifeAreas = [], isSuccess: areasLoaded } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  // The board opens on the owner's own work, or wherever it was left last
  // time. A group chat's tasks are shared with the people in it, and a busy
  // chat or two would otherwise be most of what the first screen shows.
  const [lifeAreaId, setLifeAreaId] = useAreaFilter("todos:area", lifeAreas, areasLoaded);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Todo | "new" | null>(null);
  // A task captured from the calendar opens on the slot that was clicked.
  const [capturedAt, setCapturedAt] = useState("");
  const areaParams = areaFilterParams(lifeAreaId);
  const { data: fetched = [], isLoading, error } = useQuery({
    queryKey: ["todos", showDone, areaParams.life_area_id ?? "", areaParams.scope ?? ""],
    queryFn: () => api.todos(showDone, areaParams.life_area_id, areaParams.scope),
    // Switching areas keeps the page up and narrows what is already here;
    // `inAreaFilter` below makes the held-over rows correct for the new pick.
    placeholderData: previous => previous,
  });
  const todos = useMemo(() => narrowTodos(fetched, lifeAreas, lifeAreaId, query), [fetched, lifeAreas, lifeAreaId, query]);
  // `?open=` is how search results land on a specific card. Deriving the editor
  // from the URL keeps the deep link working on a refresh, and it is resolved
  // against everything fetched so a link to a group's task opens whatever the
  // filter is showing.
  const deepLink = useDeepLinkTarget(fetched);
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
  // Two maps of steps under their parent: what is drawn follows the search,
  // what is owed does not. A search that hides a step must not hide it from
  // the question asked when its parent is finished.
  const children = useMemo(() => stepsByParent(todos), [todos]);
  const allChildren = useMemo(() => stepsByParent(fetched), [fetched]);
  const top = todos.filter(t => !t.parent_id);
  /*
   * Whichever way a task is finished — the row's menu, a drag to Done, the
   * editor — the steps it still owes are settled first. Every path routes
   * through here so the question cannot be skipped by taking another one.
   */
  const [finishing, setFinishing] = useState<Todo | null>(null);
  const openSubtasks = (todo: Todo) => (allChildren.get(todo.id) || [])
    .filter(subtask => subtask.status !== "done" && subtask.status !== "cancelled");
  const setStatus = (id: string, status: TodoStatus) => {
    const todo = fetched.find(candidate => candidate.id === id);
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
    {/* The page's own controls sit on the toolbar: the top right corner
        belongs to the launcher now. Search narrows whatever view is open. */}
    <div className="toolbar">
      <div className="search"><Search size={16} aria-hidden="true"/><input className="input" aria-label="Search tasks" placeholder="Search tasks by title, notes, or area…" value={query} onChange={e => setQuery(e.target.value)} /></div>
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
    <LifeAreaFilter areas={lifeAreas} value={lifeAreaId} onChange={setLifeAreaId}/>
    {view === "table" && <TodoTable todos={top} children={children} onOpen={setEditor} onStatus={setStatus}/>}
    {/* Hiding done work hides the cards, never the column: finishing a task
        is a drag to Done, and the target has to be there to drag to. */}
    {view === "board" && <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {query.trim() && !top.length && <div className="table-empty">No tasks match this view.</div>}
      <div className="board">
        {boardStatuses.map(status => <TodoColumn
          key={status}
          status={status}
          todos={top.filter(t => t.status === status)}
          children={children}
          hiddenNote={status === "done" && !showDone ? "Done tasks are hidden" : undefined}
          onOpen={setEditor}
          onStatus={setStatus}
        />)}
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
      subtasks={editing === "new" ? [] : allChildren.get(editing.id) || []}
      allTodos={fetched.filter(t => !t.parent_id)}
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

/** Steps grouped under the id of the task they belong to. */
function stepsByParent(todos: Todo[]): Map<string, Todo[]> {
  const map = new Map<string, Todo[]>();
  todos.forEach(t => { if (t.parent_id) map.set(t.parent_id, [...(map.get(t.parent_id) || []), t]); });
  return map;
}

/**
 * What the page shows of what it fetched: the area filter's two aggregate
 * views are applied here, and so is the search. A match anywhere in a task's
 * family keeps the whole family — the task and every step, whichever of them
 * matched — so the board never shows a step with nowhere to hang, and a
 * task's "2/5 subtasks" means what it says while a search is on.
 */
function narrowTodos(todos: Todo[], areas: LifeArea[], areaFilter: string, query: string): Todo[] {
  const inArea = todos.filter(todo => inAreaFilter(areaFilter, areas, todo.life_area_id));
  const needle = query.trim().toLowerCase();
  if (!needle) return inArea;
  const matches = (todo: Todo) =>
    [todo.title, todo.notes, todo.category_name, todo.life_area_name]
      .some(field => field?.toLowerCase().includes(needle));
  const rootOf = (todo: Todo) => todo.parent_id ?? todo.id;
  const families = new Set(inArea.filter(matches).map(rootOf));
  return inArea.filter(todo => families.has(rootOf(todo)));
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
                {todo.recurrence
                  ? <RepeatSummary todo={todo} timezone={timezone}/>
                  : <>
                    {todo.due_at ? friendlyDueDate(todo.due_at, timezone) : "—"}
                    {todo.reminder_at && <span className="cell-reminder" title="Reminder">
                      <BellRing size={11}/>{friendlyDate(todo.reminder_at, timezone)}{todo.extra_reminders?.length ? ` +${todo.extra_reminders.length}` : ""}
                    </span>}
                  </>}
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
 * A repeating task is described by its rule rather than by one date. Once it
 * is done the row says so for the rest of the day, and names when it comes
 * round again, so a checked-off task does not read as finished for good.
 */
function RepeatSummary({ todo, timezone }: { todo: Todo; timezone: string }) {
  if (!todo.recurrence) return null;
  const finished = todo.status === "done";
  return <span className="repeat-cell" title={describeRecurrence(todo.recurrence)}>
    <Repeat size={11} aria-hidden="true"/>
    {finished
      ? <>Done for today{todo.due_at ? ` · ${describeRecurrence(todo.recurrence)}` : ""}</>
      : <>{todo.due_at ? `Next ${friendlyDate(todo.due_at, timezone)}` : describeRecurrence(todo.recurrence)}</>}
  </span>;
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

function TodoColumn({ status, todos, children, hiddenNote, onOpen, onStatus }: {
  status: TodoStatus;
  todos: Todo[];
  children: Map<string, Todo[]>;
  /** Set when the column's cards are hidden by choice, so the empty column says why and still takes a drop. */
  hiddenNote?: string;
  onOpen: (todo: Todo) => void;
  onStatus: (id: string, status: TodoStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = statusMeta[status];
  return <section ref={setNodeRef} className="column" style={{ outline: isOver ? `1px solid ${meta.color}` : undefined }}>
    {/* A finished task still holding open steps stays on the board whatever
        the setting, so the badge counts whenever there is something to count. */}
    <div className="column-head"><strong style={{ color: meta.color }}>{meta.label}</strong>{hiddenNote && !todos.length ? <span className="badge" title={hiddenNote}>hidden</span> : <span className="badge">{todos.length}</span>}</div>
    <div className="column-body">{todos.map(todo => <DraggableTodo key={todo.id} todo={todo} subtasks={children.get(todo.id) || []} onOpen={onOpen} onStatus={onStatus} />)}
      {!todos.length && <div className="empty"><span className="eyebrow">{hiddenNote ? `${hiddenNote} · drop here to finish` : "Drop here"}</span></div>}
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
      <LifeAreaPill name={todo.life_area_name} slug={todo.life_area_slug}/>{todo.category_name && <span>{todo.category_name}</span>} {todo.recurrence
        ? <span title="Repeats"><Repeat size={11}/>{todo.status === "done" ? "Done for today" : describeRecurrence(todo.recurrence)}</span>
        : <>{todo.due_at && <span>Due {friendlyDueDate(todo.due_at, timezone)}</span>} {todo.reminder_at && <span title="Reminder"><BellRing size={11}/>{friendlyDate(todo.reminder_at, timezone)}{todo.extra_reminders?.length ? ` +${todo.extra_reminders.length}` : ""}</span>}</>} {todo.priority && <span>! {todo.priority}</span>}
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
