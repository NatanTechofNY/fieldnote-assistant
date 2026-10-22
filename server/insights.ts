import { OWN_AREA_CLAUSE, USER_ID } from "./db.ts";
import { OWNER_SPEAKER_NAME } from "./group-thread.ts";
import { getNotificationPreferences } from "./integrations.ts";
import { localParts, zonedToInstant } from "./local-time.ts";
import { parseMoods } from "./moods.ts";
import type { Db } from "./types.ts";

/*
 * The numbers behind the Insights page: a read-only view derived from rows the
 * app already keeps. Nothing here writes, queues an index job, or is reachable
 * as an agent tool, so there is no scope to enforce beyond the one the caller
 * asks for — and that one is applied in SQL, the way the board and the
 * memories page apply "My items".
 *
 * Rows are bucketed by the owner's own day rather than UTC's, the way
 * `/api/overview` decides what is due today, so an entry saved at 11pm lands on
 * the evening it was written in.
 */

/** Whose records are counted: the owner's own, one life area's, or everything. */
export type InsightsScope = { kind: "mine" } | { kind: "area"; id: string } | { kind: "all" };

export type InsightsOptions = { days: number; scope: InsightsScope; now?: Date };

/** How far back streaks are read, whatever window the charts show. */
const STREAK_HORIZON_DAYS = 400;
const DAY_MS = 86_400_000;

/**
 * Threads the app opens for its own work. What is said in them is the app
 * talking to the agent, not the owner talking to it.
 */
export const INTERNAL_THREAD_PREFIXES = [
  "digest:", "sweep:", "profile:", "reflection:", "performance-review:", "checkin-ask:",
] as const;

const DURATION_LABELS = ["Under a day", "1–3 days", "3–7 days", "1–2 weeks", "Over 2 weeks"] as const;
const STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low", "none"] as const;
const KINDS = ["fact", "note", "journal"] as const;

/** What a successful tool call is worth saying the assistant did for the owner. */
const DID_FOR_YOU: Record<string, string> = {
  create_todo: "Tasks added",
  update_todo: "Tasks changed",
  set_todo_status: "Tasks moved",
  add_todo_comment: "Notes added to tasks",
  create_memory: "Memories saved",
  update_memory: "Memories updated",
  create_reminder: "Reminders set",
  create_page: "Pages made",
};

export type Count = { label: string; count: number };

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Monday is 0, the way the week reads on the board's calendar. */
function weekdayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

const weekStart = (date: string) => addDays(date, -weekdayIndex(date));

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/** Which of five growing spans a number of days falls in. */
function durationBucket(days: number): number {
  return days < 1 ? 0 : days < 3 ? 1 : days < 7 ? 2 : days < 14 ? 3 : 4;
}

/**
 * Consecutive days ending today, or yesterday while today is still open: a
 * streak is not broken by the day not being over yet.
 */
function currentStreak(days: Set<string>, today: string): number {
  let cursor = days.has(today) ? today : addDays(today, -1);
  let length = 0;
  while (days.has(cursor)) {
    length += 1;
    cursor = addDays(cursor, -1);
  }
  return length;
}

function bestStreak(days: Set<string>): number {
  let best = 0;
  for (const day of days) {
    if (days.has(addDays(day, -1))) continue;
    let length = 0;
    for (let cursor = day; days.has(cursor); cursor = addDays(cursor, 1)) length += 1;
    best = Math.max(best, length);
  }
  return best;
}

function scopeSql(scope: InsightsScope, alias: string): { sql: string; args: string[] } {
  if (scope.kind === "mine") return { sql: ` AND ${OWN_AREA_CLAUSE(alias)}`, args: [] };
  if (scope.kind === "area") return { sql: ` AND ${alias}.life_area_id=?`, args: [scope.id] };
  return { sql: "", args: [] };
}

/** The days the charts run along, as dated buckets: a day each, or a week each once the range is long. */
function timeline(today: string, days: number, timezone: string) {
  const granularity: "day" | "week" = days > 90 ? "week" : "day";
  const keyOf = (date: string) => granularity === "week" ? weekStart(date) : date;
  // A long range is read in whole weeks, so its first bar is a week and not the tail of one.
  const first = granularity === "week" ? weekStart(addDays(today, -(days - 1))) : addDays(today, -(days - 1));
  const buckets: string[] = [];
  for (let date = first; date <= today; date = addDays(date, 1)) {
    const key = keyOf(date);
    if (buckets[buckets.length - 1] !== key) buckets.push(key);
  }
  const index = new Map(buckets.map((key, position) => [key, position]));

  /*
   * Where each local day begins, as an instant, for every day the page reads. A
   * row's own day is then a search through these few hundred numbers rather than
   * a formatted date, which is what made a year of messages slow. Each start is
   * worked out on its own, so a day a clock change makes 23 or 25 hours long is
   * bounded correctly. Anything outside them falls back to the formatter.
   */
  const starts: Array<{ date: string; at: number }> = [];
  for (let date = addDays(today, -(STREAK_HORIZON_DAYS + 2)); date <= addDays(today, 1); date = addDays(date, 1)) {
    starts.push({ date, at: zonedToInstant(date, "00:00", timezone).getTime() });
  }
  const startOf = (date: string) => starts.find(entry => entry.date === date)?.at ?? 0;
  const lastStart = starts[starts.length - 1].at;

  /** The owner's local date of an instant, or null when it is not a date. */
  const dateOf = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return null;
    if (at < starts[0].at || at >= lastStart + 2 * DAY_MS) return localParts(new Date(at), timezone).date;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle].at <= at) low = middle; else high = middle - 1;
    }
    return starts[low].date;
  };
  /** The bucket an instant falls in, or -1 outside the range. */
  const bucketOf = (iso: string | null | undefined): number => {
    const date = dateOf(iso);
    if (!date || date < first || date > today) return -1;
    return index.get(keyOf(date)) ?? -1;
  };
  return {
    first, granularity, buckets, dateOf, bucketOf,
    /** The range as instants: the start of its first day, and the start of the day after today. */
    startIso: new Date(startOf(first)).toISOString(),
    endIso: new Date(lastStart).toISOString(),
  };
}

type Frame = ReturnType<typeof timeline>;
const zeros = (length: number) => Array.from({ length }, () => 0);

type TodoRecord = {
  id: string; title: string; status: string; priority: string | null; parent_id: string | null;
  due_at: string | null; created_at: string; completed_at: string | null; recurring: 0 | 1;
  life_area_id: string | null;
};
type Completion = { todo_id: string; completed_at: string; title: string; life_area_id: string | null };
type AreaRow = { id: string; name: string; color: string; thread_id: string | null };

function tasksSection(db: Db, scope: InsightsScope, frame: Frame, today: string, timezone: string, now: Date, areas: AreaRow[]) {
  const where = scopeSql(scope, "t");
  const horizon = new Date(now.getTime() - STREAK_HORIZON_DAYS * DAY_MS).toISOString();
  // What is open, or was started or finished inside the history read: a task closed years ago says nothing here.
  const todos = db.prepare(`
    SELECT t.id,t.title,t.status,t.priority,t.parent_id,t.due_at,t.created_at,t.completed_at,
      t.recurrence_json IS NOT NULL recurring,t.life_area_id
    FROM todos t WHERE t.user_id=? AND t.assistant_says=0
      AND (t.status IN ('pending','in_progress','blocked') OR t.created_at>=? OR t.completed_at>=?)${where.sql}
  `).all(USER_ID, horizon, horizon, ...where.args) as TodoRecord[];
  // Occurrences of repeating tasks live in their own log; a one-off task is finished once, on its own row.
  const occurrences = db.prepare(`
    SELECT c.todo_id,c.completed_at,t.title,t.life_area_id FROM todo_completions c
    JOIN todos t ON t.id=c.todo_id
    WHERE c.user_id=? AND c.completed_at>=? AND t.assistant_says=0${where.sql}
  `).all(USER_ID, horizon, ...where.args) as Completion[];

  type Finished = { at: string; todoId: string; title: string; areaId: string | null; recurring: boolean; created?: string };
  const finished: Finished[] = [
    ...todos.filter(todo => todo.status === "done" && !todo.recurring && todo.completed_at)
      .map(todo => ({ at: todo.completed_at as string, todoId: todo.id, title: todo.title, areaId: todo.life_area_id, recurring: false, created: todo.created_at })),
    ...occurrences.map(item => ({ at: item.completed_at, todoId: item.todo_id, title: item.title, areaId: item.life_area_id, recurring: true })),
  ];
  const inWindow = finished.filter(item => frame.bucketOf(item.at) >= 0);

  const created = zeros(frame.buckets.length);
  const completed = zeros(frame.buckets.length);
  for (const todo of todos) {
    const bucket = frame.bucketOf(todo.created_at);
    if (bucket >= 0) created[bucket] += 1;
  }
  for (const item of inWindow) completed[frame.bucketOf(item.at)] += 1;

  const createdTodos = todos.filter(todo => frame.bucketOf(todo.created_at) >= 0);
  // Of what was started this period, how much is done now. Repeating tasks never finish, and a cancelled one was never owed.
  const owed = createdTodos.filter(todo => !todo.recurring && todo.status !== "cancelled");
  const owedSteps = owed.filter(todo => todo.parent_id);
  const open = todos.filter(todo => todo.status === "pending" || todo.status === "in_progress" || todo.status === "blocked");
  const overdue = open.filter(todo => todo.due_at && Date.parse(todo.due_at) < now.getTime());

  const finishDays = inWindow.filter(item => !item.recurring && item.created)
    .map(item => (Date.parse(item.at) - Date.parse(item.created as string)) / DAY_MS)
    .filter(value => Number.isFinite(value) && value >= 0);
  const finishBuckets = zeros(DURATION_LABELS.length);
  for (const value of finishDays) finishBuckets[durationBucket(value)] += 1;
  const overdueBuckets = zeros(DURATION_LABELS.length);
  for (const todo of overdue) overdueBuckets[durationBucket((now.getTime() - Date.parse(todo.due_at as string)) / DAY_MS)] += 1;

  const dates = new Set(finished.map(item => frame.dateOf(item.at)).filter((date): date is string => Boolean(date)));

  const heatmap = Array.from({ length: 7 }, () => zeros(24));
  for (const item of inWindow) {
    const at = new Date(item.at);
    const date = localParts(at, timezone);
    heatmap[weekdayIndex(date.date)][Math.min(23, Number(date.time.slice(0, 2)) || 0)] += 1;
  }

  const repeats = new Map<string, { title: string; count: number }>();
  for (const item of inWindow.filter(entry => entry.recurring)) {
    const entry = repeats.get(item.todoId) ?? { title: item.title, count: 0 };
    entry.count += 1;
    repeats.set(item.todoId, entry);
  }

  const areaName = new Map(areas.map(area => [area.id, area]));
  const byArea = new Map<string, { id: string | null; name: string; color: string | null; created: number; completed: number }>();
  const areaEntry = (areaId: string | null) => {
    const key = areaId ?? "none";
    const known = areaId ? areaName.get(areaId) : undefined;
    if (!byArea.has(key)) byArea.set(key, { id: areaId, name: known?.name ?? "No area", color: known?.color ?? null, created: 0, completed: 0 });
    return byArea.get(key)!;
  };
  for (const todo of createdTodos) areaEntry(todo.life_area_id).created += 1;
  for (const item of inWindow) areaEntry(item.areaId).completed += 1;

  return {
    kpis: {
      created: createdTodos.length,
      completed: inWindow.length,
      completion_rate: owed.length ? round(owed.filter(todo => todo.status === "done").length / owed.length, 3) : null,
      open: open.length,
      overdue: overdue.length,
      median_days_to_finish: (() => { const value = median(finishDays); return value === null ? null : round(value); })(),
      streak: currentStreak(dates, today),
      best_streak: bestStreak(dates),
      subtask_completion_rate: owedSteps.length ? round(owedSteps.filter(todo => todo.status === "done").length / owedSteps.length, 3) : null,
    },
    created,
    completed,
    by_status: STATUSES.map(status => ({ label: status, count: createdTodos.filter(todo => todo.status === status).length })),
    by_priority: PRIORITIES.map(priority => ({
      label: priority,
      count: createdTodos.filter(todo => (todo.priority ?? "none") === priority).length,
    })),
    by_area: [...byArea.values()].sort((a, b) => b.created + b.completed - (a.created + a.completed)),
    time_to_finish: DURATION_LABELS.map((label, position) => ({ label, count: finishBuckets[position] })),
    overdue_aging: DURATION_LABELS.map((label, position) => ({ label, count: overdueBuckets[position] })),
    heatmap,
    recurring: [...repeats.values()].sort((a, b) => b.count - a.count).slice(0, 5).map(item => ({ label: item.title, count: item.count })),
  };
}

type MemoryRecord = {
  id: string; kind: string; mood_label: string | null; mood_score: number | null; moods_json: string | null;
  tags_json: string; occurred_at: string | null; created_at: string; review_worthy: 0 | 1; has_pictures: 0 | 1;
};

function memoriesSection(db: Db, scope: InsightsScope, frame: Frame, today: string, now: Date) {
  const where = scopeSql(scope, "m");
  const horizon = new Date(now.getTime() - STREAK_HORIZON_DAYS * DAY_MS).toISOString();
  const rows = db.prepare(`
    SELECT m.id,m.kind,m.mood_label,m.mood_score,m.moods_json,m.tags_json,m.occurred_at,m.created_at,m.review_worthy,
      EXISTS(SELECT 1 FROM memory_attachments ma WHERE ma.memory_id=m.id) has_pictures
    FROM memories m WHERE m.user_id=? AND (m.created_at>=? OR COALESCE(m.occurred_at,m.created_at)>=?)${where.sql}
  `).all(USER_ID, horizon, horizon, ...where.args) as MemoryRecord[];

  const saved = rows.filter(row => frame.bucketOf(row.created_at) >= 0);
  const volume: Record<string, number[]> = Object.fromEntries(KINDS.map(kind => [kind, zeros(frame.buckets.length)]));
  for (const row of saved) if (volume[row.kind]) volume[row.kind][frame.bucketOf(row.created_at)] += 1;

  const tags = new Map<string, number>();
  for (const row of saved) {
    let list: unknown = [];
    try { list = JSON.parse(row.tags_json); } catch { /* a stored tag list that is not JSON counts for nothing */ }
    if (!Array.isArray(list)) continue;
    for (const tag of new Set(list.filter((item): item is string => typeof item === "string").map(item => item.trim().toLowerCase()).filter(Boolean))) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }

  // Mood is about the day it was felt. "Mine" leaves out an entry carrying anyone else's mood, as the overview chart does.
  const moodRows = rows.filter(row => {
    if (row.mood_score === null) return false;
    const date = frame.bucketOf(row.occurred_at ?? row.created_at);
    if (date < 0) return false;
    return scope.kind !== "mine" || parseMoods(row.moods_json).every(mood => mood.name === OWNER_SPEAKER_NAME);
  });
  const dailySums = frame.buckets.map(() => [] as number[]);
  const weekdays = Array.from({ length: 7 }, () => [] as number[]);
  const distribution = zeros(5);
  const labels = new Map<string, number>();
  for (const row of moodRows) {
    const at = row.occurred_at ?? row.created_at;
    dailySums[frame.bucketOf(at)].push(row.mood_score as number);
    const date = frame.dateOf(at) as string;
    weekdays[weekdayIndex(date)].push(row.mood_score as number);
    distribution[(row.mood_score as number) - 1] += 1;
    const people = parseMoods(row.moods_json);
    const words = people.length
      ? people.filter(mood => scope.kind !== "mine" || mood.name === OWNER_SPEAKER_NAME).map(mood => mood.label)
      : row.mood_label ? [row.mood_label] : [];
    for (const word of words) {
      const key = word.trim().toLowerCase();
      if (key) labels.set(key, (labels.get(key) ?? 0) + 1);
    }
  }

  const journalDays = new Set(rows.filter(row => row.kind === "journal")
    .map(row => frame.dateOf(row.occurred_at ?? row.created_at)).filter((date): date is string => Boolean(date)));
  const top = (counts: Map<string, number>, limit: number): Count[] =>
    [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([label, count]) => ({ label, count }));

  return {
    kpis: {
      saved: saved.length,
      journal_streak: currentStreak(journalDays, today),
      review_worthy: saved.filter(row => row.review_worthy).length,
      with_pictures: saved.filter(row => row.has_pictures).length,
      average_mood: average(moodRows.map(row => row.mood_score as number)),
      mood_entries: moodRows.length,
    },
    by_kind: KINDS.map(kind => ({ label: kind, count: saved.filter(row => row.kind === kind).length })),
    volume,
    top_tags: top(tags, 10),
    mood: {
      daily: dailySums.map(values => average(values)),
      distribution,
      by_weekday: weekdays.map(values => average(values)),
      top_labels: top(labels, 8),
    },
  };
}

type Outcome = "ok" | "failed" | "unknown";

/**
 * Whether a tool call worked. The app's own tools say so in `output.success`;
 * a hosted tool such as the search carries only the state the call ended in, so
 * that is read when the output is silent, and a call that says nothing either
 * way is left out of the success rate rather than counted as a failure.
 */
function outcomeOf(success: unknown, state: unknown): Outcome {
  if (success === 1 || success === true) return "ok";
  if (success === 0 || success === false) return "failed";
  if (state === "output-error") return "failed";
  if (state === "output-available") return "ok";
  return "unknown";
}

type ToolRow = { thread_id: string; address: string; tool: string; success: unknown; state: unknown; n: number };

function assistantSection(db: Db, scope: InsightsScope, frame: Frame, areas: AreaRow[]) {
  // Which threads count, decided from the life areas: a group chat is the thread one of them owns.
  const groupThreads = new Set(areas.map(area => area.thread_id).filter((id): id is string => Boolean(id)));
  const areaById = new Map(areas.map(area => [area.id, area]));
  const scopedArea = scope.kind === "area" ? areaById.get(scope.id) : undefined;
  /*
   * The chat a piece of work belongs to. The app does some of its work on
   * threads of its own, named for what they read: a group's memory sweep runs
   * on `sweep:<thread>`, its profile rewrite on `profile:<area>`, a check-in's
   * wording on `checkin-ask:<kind>:<area>`. What those threads do is the
   * group's, and must not land in the owner's own view; everything else the app
   * composes is the owner's, and is the empty string, which is no group.
   */
  const sourceOf = (address: string, threadId: string): string => {
    const [prefix, ...rest] = address.split(":");
    if (prefix === "sweep") return rest.join(":");
    if (prefix === "profile") return areaById.get(rest.join(":"))?.thread_id ?? "";
    if (prefix === "checkin-ask") return areaById.get(rest[1] ?? "")?.thread_id ?? "";
    return INTERNAL_THREAD_PREFIXES.some(known => address.startsWith(known)) ? "" : threadId;
  };
  const threadWanted = (threadId: string): boolean => {
    if (scope.kind === "all") return true;
    if (scope.kind === "mine") return !groupThreads.has(threadId);
    // An area with no group chat has no conversation of its own to count.
    return scopedArea?.thread_id === threadId;
  };
  const internal = INTERNAL_THREAD_PREFIXES.map(() => "t.address NOT LIKE ?").join(" AND ");
  const prefixArgs = INTERNAL_THREAD_PREFIXES.map(prefix => `${prefix}%`);

  /*
   * Messages to the assistant: what the owner typed, in the app or by text, and
   * in a group what the owner said there. What other members say in a group, or
   * says before the assistant has been named, is the group talking, not the
   * owner using the assistant.
   */
  const messages = (db.prepare(`
    SELECT m.created_at,m.thread_id,t.channel,
      json_extract(m.metadata_json,'$.speakerIsOwner') owner,json_extract(m.metadata_json,'$.heldUntilNamed') held
    FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND m.role='user' AND m.direction='inbound' AND m.created_at>=? AND m.created_at<? AND ${internal}
      AND COALESCE(json_extract(m.metadata_json,'$.internal'),0)=0
      AND COALESCE(json_extract(m.metadata_json,'$.reactionText'),0)=0
  `).all(USER_ID, frame.startIso, frame.endIso, ...prefixArgs) as Array<{
    created_at: string; thread_id: string; channel: string; owner: number | null; held: number | null;
  }>).filter(row => threadWanted(row.thread_id)
    && (!groupThreads.has(row.thread_id) || (row.owner === 1 && row.held !== 1)));
  const series = { web: zeros(frame.buckets.length), sms: zeros(frame.buckets.length), group: zeros(frame.buckets.length) };
  const activeDays = new Set<string>();
  let counted = 0;
  for (const row of messages) {
    const bucket = frame.bucketOf(row.created_at);
    if (bucket < 0) continue;
    counted += 1;
    const kind = groupThreads.has(row.thread_id) ? "group" : row.channel === "web" ? "web" : "sms";
    series[kind][bucket] += 1;
    const date = frame.dateOf(row.created_at);
    if (date) activeDays.add(date);
  }

  /*
   * Tool calls, grouped in SQL so a year of them is a few rows. Two places keep
   * them: the server writes a `tool` row for every call it runs itself (texts,
   * groups, its own work), and the app's chat panel runs its tools from the
   * browser and syncs them as parts on its assistant messages.
   */
  const served = db.prepare(`
    SELECT t.id thread_id,t.address,m.content tool,
      json_extract(m.metadata_json,'$.output.success') success,json_extract(m.metadata_json,'$.state') state,COUNT(*) n
    FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id
    WHERE t.user_id=? AND m.role='tool' AND m.created_at>=? AND m.created_at<?
    GROUP BY t.id,t.address,m.content,success,state
  `).all(USER_ID, frame.startIso, frame.endIso) as ToolRow[];
  const browsed = db.prepare(`
    SELECT t.id thread_id,t.address,substr(json_extract(p.value,'$.type'),6) tool,
      json_extract(p.value,'$.output.success') success,json_extract(p.value,'$.state') state,COUNT(*) n
    FROM channel_messages m JOIN channel_threads t ON t.id=m.thread_id,
      json_each(CASE WHEN json_valid(m.metadata_json) THEN m.metadata_json ELSE '{}' END,'$.parts') p
    WHERE t.user_id=? AND t.channel='web' AND m.role='assistant' AND m.created_at>=? AND m.created_at<?
      AND json_extract(p.value,'$.type') LIKE 'tool-%'
    GROUP BY t.id,t.address,tool,success,state
  `).all(USER_ID, frame.startIso, frame.endIso) as ToolRow[];
  const tools = [...served, ...browsed].filter(row => threadWanted(sourceOf(row.address, row.thread_id)));

  const perTool = new Map<string, { calls: number; ok: number; failed: number }>();
  const did = new Map<string, number>();
  let calls = 0;
  let succeeded = 0;
  let failed = 0;
  for (const row of tools) {
    const outcome = outcomeOf(row.success, row.state);
    const entry = perTool.get(row.tool) ?? { calls: 0, ok: 0, failed: 0 };
    entry.calls += row.n;
    calls += row.n;
    if (outcome === "ok") {
      entry.ok += row.n;
      succeeded += row.n;
      const label = DID_FOR_YOU[row.tool];
      if (label) did.set(label, (did.get(label) ?? 0) + row.n);
    } else if (outcome === "failed") {
      entry.failed += row.n;
      failed += row.n;
    }
    perTool.set(row.tool, entry);
  }
  const rate = (ok: number, bad: number) => ok + bad ? round(ok / (ok + bad), 3) : null;

  // A sweep is named for the thread it read, so a group's sweeps are fenced the same way its messages are.
  const sweeps = (db.prepare(`
    SELECT status,idempotency_key,scheduled_for FROM scheduled_dispatches WHERE user_id=? AND kind='memory_sweep' AND scheduled_for>=?
  `).all(USER_ID, frame.startIso) as Array<{ status: string; idempotency_key: string; scheduled_for: string }>)
    .filter(row => frame.bucketOf(row.scheduled_for) >= 0 && threadWanted(row.idempotency_key.split(":")[1] ?? ""));

  return {
    kpis: {
      messages: counted,
      active_days: activeDays.size,
      tool_calls: calls,
      tool_success_rate: rate(succeeded, failed),
    },
    messages: series,
    top_tools: [...perTool].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0])).slice(0, 10)
      .map(([tool, entry]) => ({ tool, calls: entry.calls, success_rate: rate(entry.ok, entry.failed) })),
    did_for_you: [...did].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    sweeps: {
      runs: sweeps.length,
      sent: sweeps.filter(row => row.status === "sent").length,
      failed: sweeps.filter(row => row.status === "failed").length,
    },
  };
}

export function buildInsights(db: Db, options: InsightsOptions) {
  const now = options.now ?? new Date();
  const timezone = getNotificationPreferences(db).timezone;
  const today = localParts(now, timezone).date;
  const frame = timeline(today, options.days, timezone);
  const areas = db.prepare("SELECT id,name,color,thread_id FROM life_areas WHERE user_id=?").all(USER_ID) as AreaRow[];
  return {
    range: { days: options.days, from: frame.first, to: today, timezone, granularity: frame.granularity, buckets: frame.buckets },
    tasks: tasksSection(db, options.scope, frame, today, timezone, now, areas),
    memories: memoriesSection(db, options.scope, frame, today, now),
    assistant: assistantSection(db, options.scope, frame, areas),
  };
}
