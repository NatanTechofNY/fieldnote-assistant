import type { CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowRight, Bell, Clock3 } from "lucide-react";
import { api } from "../../api";
import type {
  Reminder, Todo,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { Empty, ErrorState, Loading, MemoryIcon } from "../../components/ui";
import { friendlyDate, friendlyDueDate, useTimezone } from "../../lib/timezone";
import { reminderKindLabels, statusMeta } from "../../lib/todo-meta";
import { TodayHero } from "./TodayHero";

export function OverviewPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} />;
  const stats = [
    ["To do", data.counts.pending, "var(--status-todo)"],
    ["In motion", data.counts.in_progress, "var(--status-progress)"],
    ["Memories", data.counts.memories, "var(--accent)"],
  ] as const;
  /* One list in the order a day is worked — what is moving, what is due, what is
     stuck — instead of three cards asking to be cross-referenced. A task that is
     both in motion and due today belongs to the day once. */
  const focus = [...data.in_progress, ...data.due_today, ...data.blocked]
    .filter((todo, index, all) => all.findIndex(item => item.id === todo.id) === index)
    .slice(0, 7);
  /* A due date and the reminders asked for around it are separate rows in the
     schedule, and printed as separate rows they read as the same task listed
     twice. One task, one row: when it is owed, with its alerts underneath. */
  const schedule = new Map<string, Schedule>();
  for (const reminder of data.upcoming_reminders) {
    const key = reminder.todo_id || reminder.id;
    const entry = schedule.get(key)
      || { key, title: reminder.todo_title || "Reminder", alerts: [] };
    if (reminder.kind === "due") entry.due = reminder;
    else entry.alerts.push(reminder);
    schedule.set(key, entry);
  }
  const upcoming = [...schedule.values()].slice(0, 5);
  return <div className="page page-focus">
    <PageHead eyebrow={format(new Date(), "EEEE · MMMM d")} title="Your day, in focus." description="Everything you're doing and remembering, in one conversation." />
    <TodayHero />
    <section className="kpi-strip">
      {/* The cell's hue tints its own background as well as the dot, so the
          colour is handed over as a property rather than a single declaration. */}
      {stats.map(([label, value, color]) => <div key={label} style={{ "--kpi": color } as CSSProperties}>
        <span><i/>{label}</span><strong>{value ?? 0}</strong>
      </div>)}
    </section>
    <div className="stack">
      <article className="card card-pad">
        <div className="card-title">
          <h3>What you have to do</h3>
          <NavLink to="/todos" className="card-link">Open board<ArrowRight size={13}/></NavLink>
        </div>
        <div className="list">
          {focus.length
            ? focus.map(todo => <TodoRow key={todo.id} todo={todo} progress={data.subtask_progress[todo.id]} />)
            : <Empty label="Nothing needs you right now. Your runway is clear." />}
        </div>
      </article>
      <article className="card card-pad">
        <div className="card-title">
          <h3>Recently remembered</h3>
          <NavLink to="/memories" className="card-link">Open memory<ArrowRight size={13}/></NavLink>
        </div>
        <div className="list">
          {data.recent_memories.length
            ? data.recent_memories.slice(0, 4).map(memory => <div className="list-row" key={memory.id}>
              <MemoryIcon kind={memory.kind} />
              <div className="list-main"><strong>{memory.title || memory.content.slice(0, 48)}</strong><small>{memory.content}</small></div>
              <span className="badge">{memory.kind}</span>
            </div>)
            : <Empty label="Tell the agent something worth keeping." />}
        </div>
      </article>
      <article className="card card-pad">
        <div className="card-title"><h3>Coming up</h3><Clock3 size={17} /></div>
        <div className="list">
          {upcoming.length
            ? upcoming.map(entry => <ScheduleRow key={entry.key} entry={entry} />)
            : <Empty label="No reminders scheduled." />}
        </div>
      </article>
    </div>
  </div>;
}

/** One task's place in the schedule: when it is owed, and what will chase it. */
type Schedule = { key: string; title: string; due?: Reminder; alerts: Reminder[] };

function ScheduleRow({ entry }: { entry: Schedule }) {
  const timezone = useTimezone();
  // The first line carries the due date when there is one, and the earliest
  // alert when there is not, so whatever it took is not repeated underneath.
  const anchor = entry.due ?? entry.alerts[0];
  const alerts = entry.due ? entry.alerts : entry.alerts.slice(1);
  return <div className="list-row">
    <span className="row-icon"><Clock3 size={13}/></span>
    <div className="list-main">
      <strong>{entry.title}</strong>
      <small>{entry.due
        ? `Due ${friendlyDueDate(entry.due.scheduled_for, timezone)}`
        : friendlyDate(anchor.scheduled_for, timezone)}</small>
      {alerts.length > 0 && <ul className="row-times">
        {alerts.map(alert => <li key={alert.id}>
          <Bell size={11}/>
          <span>{reminderKindLabels[alert.kind]}</span>
          {friendlyDate(alert.scheduled_for, timezone)}
        </li>)}
      </ul>}
    </div>
    <span className="badge">{entry.due ? "Due" : reminderKindLabels[anchor.kind]}</span>
  </div>;
}

function TodoRow({ todo, progress }: { todo: Todo; progress?: { done: number; total: number } }) {
  const timezone = useTimezone();
  const meta = statusMeta[todo.status];
  const Icon = meta.icon;
  return <div className="list-row">
    <Icon size={18} style={{ color: meta.color }} />
    <div className="list-main"><strong>{todo.title}</strong><small>{friendlyDueDate(todo.due_at, timezone)}{progress?.total ? ` · ${progress.done}/${progress.total} subtasks` : ""}</small></div>
    {todo.status === "blocked" && <span className="badge warn">Blocked</span>}
    {todo.priority && <span className="badge">{todo.priority}</span>}
  </div>;
}
