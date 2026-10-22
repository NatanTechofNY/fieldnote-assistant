import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Insights, InsightsRange, LifeArea, TodoStatus } from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { ErrorState, Loading } from "../../components/ui";
import { LifeAreaFilter } from "../../components/ui/LifeAreaFilter";
import { areaFilterParams } from "../../lib/area-filter";
import { moodEmoji } from "../../lib/mood";
import { usePreference } from "../../lib/preference";
import { statusMeta } from "../../lib/todo-meta";
import { useAreaFilter } from "../../lib/use-area-filter";
import { BarList, BarSeries, Columns, Heatmap, InsightCard, LineSeries, StackedBar } from "./charts";
import { WEEKDAYS, hourLabel, percent, shortDate, toolLabel } from "./format";

const RANGES: readonly InsightsRange[] = [30, 90, 365];
const RANGE_PREFERENCE = ["30", "90", "365"] as const;
const RANGE_LABELS: Record<InsightsRange, string> = { 30: "30 days", 90: "90 days", 365: "1 year" };

const priorityColor: Record<string, string> = {
  urgent: "var(--danger)", high: "var(--warn)", normal: "var(--accent)", low: "var(--gray-400)", none: "var(--border-strong)",
};
const priorityLabel: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low", none: "No priority" };
const kindColor: Record<string, string> = { fact: "var(--info)", note: "var(--accent)", journal: "var(--success)" };
const kindLabel: Record<string, string> = { fact: "Facts", note: "Notes", journal: "Journal" };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function InsightsPage() {
  // The window and the area are habits, so they are remembered like the board's view.
  const [rangeText, setRangeText] = usePreference<(typeof RANGE_PREFERENCE)[number]>("insights:range", "30", RANGE_PREFERENCE);
  const days = Number(rangeText) as InsightsRange;
  const { data: lifeAreas = [], isSuccess: areasLoaded } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const [lifeAreaId, setLifeAreaId] = useAreaFilter("insights:area", lifeAreas, areasLoaded);
  const areaParams = areaFilterParams(lifeAreaId);
  const { data, isLoading, error } = useQuery({
    queryKey: ["insights", days, areaParams.life_area_id ?? "", areaParams.scope ?? ""],
    queryFn: () => api.insights(days, areaParams),
    // Changing the window keeps the page up while the new numbers arrive.
    placeholderData: previous => previous,
  });
  return <div className="page">
    <PageHead
      eyebrow="Trends · habits · history"
      title="Insights."
      description="What you got done, what you kept, and how the assistant has been helping — drawn from your own records."
    />
    <div className="ins-toolbar">
      <LifeAreaFilter areas={lifeAreas} value={lifeAreaId} onChange={setLifeAreaId}/>
      <div className="view-toggle ins-period-toggle" role="group" aria-label="Period">
        {RANGES.map(range => <button
          key={range}
          type="button"
          className={days === range ? "active" : ""}
          aria-pressed={days === range}
          onClick={() => setRangeText(String(range) as (typeof RANGE_PREFERENCE)[number])}
        >{RANGE_LABELS[range]}</button>)}
      </div>
    </div>
    {isLoading ? <Loading/> : error || !data ? <ErrorState error={error}/> : <Dashboard data={data} areas={lifeAreas}/>}
  </div>;
}

function Dashboard({ data, areas }: { data: Insights; areas: LifeArea[] }) {
  const { range, tasks, memories, assistant } = data;
  const { buckets, granularity } = range;
  const mood = memories.kpis.average_mood;
  const kpis: Array<{ label: string; value: string; note: string; color: string }> = [
    { label: "Tasks completed", value: String(tasks.kpis.completed), note: `${tasks.kpis.created} created`, color: "var(--status-done)" },
    { label: "Completion rate", value: percent(tasks.kpis.completion_rate), note: "of what you started this period", color: "var(--accent)" },
    { label: "Streak", value: plural(tasks.kpis.streak, "day"), note: `best ${plural(tasks.kpis.best_streak, "day")}`, color: "var(--status-progress)" },
    { label: "Overdue", value: String(tasks.kpis.overdue), note: `${tasks.kpis.open} open now`, color: tasks.kpis.overdue ? "var(--danger)" : "var(--status-todo)" },
    { label: "Memories saved", value: String(memories.kpis.saved), note: `${plural(memories.kpis.journal_streak, "day")} journal streak`, color: "var(--info)" },
    { label: "Average mood", value: mood === null ? "—" : `${moodEmoji(Math.round(mood))} ${mood.toFixed(1)}`, note: plural(memories.kpis.mood_entries, "entry"), color: "var(--success)" },
    { label: "Messages", value: String(assistant.kpis.messages), note: `${plural(assistant.kpis.active_days, "active day")}`, color: "var(--warn)" },
  ];
  const areaColors = new Map(areas.map(area => [area.id, area.color]));
  const weekly = granularity === "week";
  return <>
    <p className="ins-period">
      {shortDate(range.from)} – {shortDate(range.to)} · {plural(range.days, "day")}{weekly ? " · charted by week" : ""} · {range.timezone}
    </p>
    <section className="kpi-strip ins-kpis" aria-label="Highlights">
      {kpis.map(item => <div key={item.label} style={{ "--kpi": item.color } as CSSProperties}>
        <span><i/>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small>
      </div>)}
    </section>

    <div className="ins-section"><h2>Tasks</h2><p>Work started, finished, and left behind.</p></div>
    <div className="ins-grid">
      <InsightCard title="Created vs completed" note={weekly ? "per week" : "per day"} wide>
        <BarSeries
          buckets={buckets}
          granularity={granularity}
          label="Tasks created and completed"
          series={[
            { label: "Created", color: "var(--info)", values: tasks.created },
            { label: "Completed", color: "var(--status-done)", values: tasks.completed },
          ]}
        />
      </InsightCard>
      <InsightCard title="Where tasks stand" note="created this period">
        <StackedBar
          label="Tasks by status"
          items={tasks.by_status.map(item => ({
            label: statusMeta[item.label as TodoStatus].label, count: item.count, color: statusMeta[item.label as TodoStatus].color,
          }))}
        />
      </InsightCard>
      <InsightCard title="By priority" note="created this period">
        <BarList items={tasks.by_priority.map(item => ({ label: priorityLabel[item.label], count: item.count, color: priorityColor[item.label] }))}/>
      </InsightCard>
      <InsightCard title="By life area" note="created this period">
        <BarList
          items={tasks.by_area.map(item => ({
            label: item.name,
            count: item.created,
            detail: `${item.completed} completed`,
            color: item.color ?? (item.id ? areaColors.get(item.id) : null),
          }))}
        />
      </InsightCard>
      <InsightCard
        title="How long tasks take"
        note={tasks.kpis.median_days_to_finish === null ? "from created to done" : `median ${tasks.kpis.median_days_to_finish} days`}
      >
        <Columns items={tasks.time_to_finish} color="var(--status-done)" label="Time to finish"/>
      </InsightCard>
      <InsightCard title="Overdue right now" note="how late">
        <Columns items={tasks.overdue_aging} color="var(--danger)" label="Overdue tasks by how late"/>
      </InsightCard>
      <InsightCard title="When you finish things" note="completions by weekday and hour" wide>
        <Heatmap
          rows={tasks.heatmap}
          rowLabels={[...WEEKDAYS]}
          columnLabel={hour => hour % 3 === 0 ? hourLabel(hour) : undefined}
          cell={(value, row, column) => `${plural(value, "completion")} at ${hourLabel(column)}, ${WEEKDAYS[row]}`}
          label="Completions by weekday and hour"
          color="var(--status-done)"
        />
      </InsightCard>
      <InsightCard title="Repeating tasks" note="occurrences finished">
        <BarList items={tasks.recurring} empty="Repeating tasks you finish will rank here."/>
        <div className="ins-stat-row">
          <span>Steps done <strong>{percent(tasks.kpis.subtask_completion_rate)}</strong></span>
        </div>
      </InsightCard>
    </div>

    <div className="ins-section"><h2>Memories and mood</h2><p>What you kept and how the days felt.</p></div>
    <div className="ins-grid">
      <InsightCard title="Memories saved" note={weekly ? "per week" : "per day"} wide>
        <BarSeries
          buckets={buckets}
          granularity={granularity}
          stacked
          label="Memories saved"
          series={(["fact", "note", "journal"] as const).map(kind => ({ label: kindLabel[kind], color: kindColor[kind], values: memories.volume[kind] }))}
        />
      </InsightCard>
      <InsightCard title="Mood over time" note="average score, 1 to 5">
        <LineSeries
          buckets={buckets}
          granularity={granularity}
          values={memories.mood.daily}
          min={1}
          max={5}
          color="var(--success)"
          label="Average mood"
        />
      </InsightCard>
      <InsightCard title="How the days scored" note={plural(memories.kpis.mood_entries, "entry")}>
        <Columns
          items={memories.mood.distribution.map((count, index) => ({ label: `${moodEmoji(index + 1)} ${index + 1}`, count }))}
          color="var(--success)"
          label="Entries by mood score"
        />
      </InsightCard>
      <InsightCard title="Mood by weekday" note="average score">
        <Heatmap
          rows={[memories.mood.by_weekday]}
          rowLabels={["Mood"]}
          columnLabel={index => WEEKDAYS[index]}
          min={1}
          max={5}
          cell={value => `${value.toFixed(1)} of 5`}
          label="Average mood by weekday"
          color="var(--success)"
        />
      </InsightCard>
      <InsightCard title="Moods in your words" note="most common">
        <BarList items={memories.mood.top_labels} color="var(--success)" empty="Moods you write will rank here."/>
      </InsightCard>
      <InsightCard title="Most used tags" note="this period">
        <BarList items={memories.top_tags} empty="Tag a memory and it will rank here."/>
      </InsightCard>
      <InsightCard title="What you keep" note="saved this period">
        <StackedBar
          label="Memories by kind"
          items={memories.by_kind.map(item => ({ label: kindLabel[item.label], count: item.count, color: kindColor[item.label] }))}
        />
        <div className="ins-stat-row">
          <span>Worth reviewing <strong>{memories.kpis.review_worthy}</strong></span>
          <span>With pictures <strong>{memories.kpis.with_pictures}</strong></span>
        </div>
      </InsightCard>
    </div>

    <div className="ins-section"><h2>Assistant</h2><p>How much you talk to it, and what it does.</p></div>
    <div className="ins-grid">
      <InsightCard title="Messages to the assistant" note={weekly ? "per week" : "per day"} wide>
        <BarSeries
          buckets={buckets}
          granularity={granularity}
          stacked
          label="Messages by chat"
          series={[
            { label: "App", color: "var(--accent)", values: assistant.messages.web },
            { label: "Text messages", color: "var(--success)", values: assistant.messages.sms },
            { label: "Group chats", color: "var(--warn)", values: assistant.messages.group },
          ]}
        />
      </InsightCard>
      <InsightCard title="What it did for you" note="successful actions">
        <BarList items={assistant.did_for_you} color="var(--success)" empty="Ask the assistant to add a task and it will count here."/>
      </InsightCard>
      <InsightCard title="Most used tools" note={assistant.kpis.tool_success_rate === null ? undefined : `${percent(assistant.kpis.tool_success_rate)} succeeded`}>
        <BarList
          items={assistant.top_tools.map(item => ({ label: toolLabel(item.tool), count: item.calls, detail: `${percent(item.success_rate)} succeeded` }))}
          empty="Tool calls will show up here."
        />
      </InsightCard>
      <InsightCard title="Background reading" note="memory sweeps">
        <div className="ins-stat-row">
          <span>Runs <strong>{assistant.sweeps.runs}</strong></span>
          <span>Finished <strong>{assistant.sweeps.sent}</strong></span>
          <span>Failed <strong>{assistant.sweeps.failed}</strong></span>
        </div>
      </InsightCard>
    </div>
  </>;
}
