import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, Check, Copy, Database, LoaderCircle, Plus, Search, Sparkles, TriangleAlert } from "lucide-react";
import { api } from "../../api";
import type {
  ReflectionPreset,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { AttachButton, ErrorState, Field, Loading, MarkdownContent, MarkdownEditor } from "../../components/ui";
import { completedTaskAttachment, memoryAttachment } from "../../lib/agent-attachments";
import { moodEmoji } from "../../lib/mood";
import { HighlightModal } from "./HighlightModal";
import { friendlyDate, toZonedDateTimeLocal, useTimezone } from "../../lib/timezone";

export function ReflectionsPage() {
  const queryClient = useQueryClient();
  const timezone = useTimezone();
  const today = toZonedDateTimeLocal(new Date().toISOString(), timezone).slice(0, 10);
  const [preset, setPreset] = useState<ReflectionPreset>("month");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [lifeAreaIds, setLifeAreaIds] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [sources, setSources] = useState<Array<"memories" | "todos">>(["memories", "todos"]);
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftMood, setDraftMood] = useState<number | null>(null);
  const [draftMoodLabel, setDraftMoodLabel] = useState("");
  const [showHighlight, setShowHighlight] = useState(false);
  const { data: lifeAreas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const input = {
    preset,
    ...(preset === "custom" ? { start_date: startDate, end_date: endDate } : {}),
    life_area_ids: lifeAreaIds,
    category_ids: categoryIds,
    sources,
  };
  const queryKey = ["reflection", preset, startDate, endDate, lifeAreaIds.join(","), categoryIds.join(","), sources.join(",")];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api.reflectionPeriod(input),
    enabled: preset !== "custom" || (Boolean(startDate && endDate) && startDate <= endDate),
  });
  const draft = useMutation({
    mutationFn: () => {
      if (!data) throw new Error("Reflection evidence is not loaded");
      return api.draftReflection(input);
    },
    onSuccess: next => {
      queryClient.setQueryData(queryKey, next);
      if (next.generated_draft) {
        setDraftContent(next.generated_draft.content);
        setDraftTags(next.generated_draft.tags.join(", "));
        setDraftMood(next.generated_draft.mood_score);
        setDraftMoodLabel(next.generated_draft.mood_label || "");
      }
    },
  });
  const saveDraft = useMutation({
    mutationFn: () => {
      if (!data?.generated_draft) throw new Error("Generate a draft before saving it");
      return api.saveReflectionDraft({
        ...input,
        content: draftContent,
        tags: draftTags.split(",").map(tag => tag.trim()).filter(Boolean),
        mood_score: draftMood,
        mood_label: draftMood ? draftMoodLabel.trim() || null : null,
      });
    },
    onSuccess: next => {
      queryClient.setQueryData(queryKey, next);
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const select = useMutation({
    mutationFn: (items: Array<{ type: "memory" | "todo"; id: string; selected: boolean }>) => {
      if (!data) throw new Error("Reflection evidence is not loaded");
      return api.setReflectionSelections(data.scope_key, items);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["reflection"] }),
  });
  if (isLoading) return <Loading/>;
  if (error || !data) return <ErrorState error={error}/>;
  const memories = data.memory_candidates;
  const todos = data.todo_candidates;
  const evidenceCount = memories.length + todos.length;
  const includedCount = data.memories.length + data.todos.length;
  const selected = new Set(data.selected.map(item => `${item.type}:${item.id}`));
  const searchText = evidenceSearch.trim().toLowerCase();
  const includesSearch = (...values: Array<string | null | undefined>) =>
    !searchText || values.some(value => value?.toLowerCase().includes(searchText));
  const visibleMemories = memories.filter(memory => includesSearch(
    memory.title, memory.content, memory.category_name, memory.life_area_name, memory.tags.join(" "),
  ));
  const visibleTodos = todos.filter(todo => includesSearch(
    todo.title, todo.notes, todo.category_name, todo.life_area_name,
  ));
  const visibleCount = visibleMemories.length + visibleTodos.length;
  const visibleSelectedCount = [
    ...visibleMemories.map(memory => `memory:${memory.id}`),
    ...visibleTodos.map(todo => `todo:${todo.id}`),
  ].filter(key => selected.has(key)).length;
  const updateVisible = (shouldSelect: boolean) => {
    const items = [
      ...visibleMemories.filter(item => selected.has(`memory:${item.id}`) !== shouldSelect).map(item => ({ type: "memory" as const, id: item.id, selected: shouldSelect })),
      ...visibleTodos.filter(item => selected.has(`todo:${item.id}`) !== shouldSelect).map(item => ({ type: "todo" as const, id: item.id, selected: shouldSelect })),
    ];
    if (items.length) select.mutate(items);
  };
  const toggleFilter = (value: string, values: string[], setValues: (next: string[]) => void) =>
    setValues(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  return <div className="page reviews-page">
    <PageHead
      eyebrow="Notice · understand · continue"
      title="Reflections."
      description="Turn the moments and completed work from any part of life into a grounded view of what changed."
    />
    <div className="toolbar">
      <div className="toolbar-actions">
        <button className="button ghost" onClick={() => setShowHighlight(true)}><Plus size={15}/>Log a highlight</button>
        <button className="button primary" disabled={draft.isPending || includedCount === 0} onClick={() => draft.mutate()}>
          {draft.isPending ? <LoaderCircle className="spin" size={14}/> : <Sparkles size={14}/>}
          {data.generated_draft ? "Regenerate draft" : data.draft ? "Generate new draft" : "Generate with Agent"}
        </button>
      </div>
    </div>
    <section className="review-command">
      <div className="reflection-period">
        <div className="eyebrow">Reflection window</div>
        <div className="reflection-presets">
          {(["today", "week", "month", "custom"] as ReflectionPreset[]).map(value =>
            <button className={preset === value ? "active" : ""} key={value} onClick={() => setPreset(value)}>
              {value === "today" ? "Today" : value === "week" ? "This week" : value === "month" ? "This month" : "Custom"}
            </button>)}
        </div>
        {preset === "custom" && <div className="reflection-dates">
          <input aria-label="Reflection start date" type="date" required value={startDate} onChange={event => {
            if (!event.target.value) return;
            setStartDate(event.target.value);
            if (event.target.value > endDate) setEndDate(event.target.value);
          }}/>
          <span>to</span>
          <input aria-label="Reflection end date" type="date" required value={endDate} onChange={event => {
            if (!event.target.value) return;
            setEndDate(event.target.value);
            if (event.target.value < startDate) setStartDate(event.target.value);
          }}/>
        </div>}
        <p>{data.range.startDate} through {data.range.endDate} · {data.range.timezone}</p>
      </div>
      <div className="review-tally"><strong>{includedCount}</strong><span>included signals</span></div>
      <div className="review-tally"><strong>{data.memories.length}</strong><span>memories</span></div>
      <div className="review-tally"><strong>{data.todos.length}</strong><span>completed tasks</span></div>
    </section>
    <section className="reflection-scope">
      <div><span>Life areas</span><div className="reflection-chips">
        {lifeAreas.map(area => <button key={area.id} className={lifeAreaIds.includes(area.id) ? "active" : ""} onClick={() => toggleFilter(area.id, lifeAreaIds, setLifeAreaIds)}>{area.name}</button>)}
        {!lifeAreas.length && <small>All life areas</small>}
      </div></div>
      <div><span>Categories</span><div className="reflection-chips">
        {categories.map(category => <button key={category.id} className={categoryIds.includes(category.id) ? "active" : ""} onClick={() => toggleFilter(category.id, categoryIds, setCategoryIds)}>{category.name}</button>)}
        {!categories.length && <small>All categories</small>}
      </div></div>
      <div><span>Sources</span><div className="reflection-chips">
        {(["memories", "todos"] as const).map(source => <button key={source} className={sources.includes(source) ? "active" : ""} onClick={() => {
          const next = sources.includes(source) ? sources.filter(item => item !== source) : [...sources, source];
          if (next.length) setSources(next);
        }}>{source === "memories" ? "Memories" : "Completed tasks"}</button>)}
      </div></div>
    </section>
    <section className="review-workspace">
      <div className="review-evidence">
        <header><div><div className="eyebrow">Source material</div><h3>Choose your evidence</h3></div><div className="evidence-bulk"><button disabled={select.isPending || visibleCount === 0 || visibleSelectedCount === visibleCount} onClick={() => updateVisible(true)}>Select results</button><button disabled={select.isPending || visibleSelectedCount === 0} onClick={() => updateVisible(false)}>Clear results</button><span>{includedCount} selected</span></div></header>
        <div className="evidence-search"><Search size={15}/><input value={evidenceSearch} onChange={event => setEvidenceSearch(event.target.value)} placeholder="Search memories and completed tasks…" aria-label="Search reflection evidence"/><span>{visibleCount} of {evidenceCount}</span></div>
        {!evidenceCount && <div className="review-empty"><Award size={26}/><h4>This window is ready to be noticed.</h4><p>Log a highlight, save a memory, or complete a task to begin.</p><button className="button primary" onClick={() => setShowHighlight(true)}>Log the first highlight</button></div>}
        {Boolean(evidenceCount && !visibleMemories.length && !visibleTodos.length) && <div className="review-empty compact"><Search size={22}/><h4>No matching evidence.</h4><p>Try a title, note, category, or life area.</p></div>}
        {visibleMemories.map(memory => {
          const key = `memory:${memory.id}`;
          const isSelected = selected.has(key);
          return <article className={`evidence-row ${isSelected ? "" : "excluded"}`} key={key}>
            <span className="evidence-icon win"><Award size={15}/></span>
            <div><small>{memory.review_worthy ? "Highlight" : `${memory.kind} memory`} · {friendlyDate(memory.occurred_at || memory.created_at, timezone)}</small><strong>{memory.title || "Untitled memory"}</strong><p>{memory.content}</p></div>
            <AttachButton item={memoryAttachment(memory)}/>
            <button disabled={select.isPending} onClick={() => select.mutate([{ type: "memory", id: memory.id, selected: !isSelected }])}>{isSelected ? "Remove" : "Select"}</button>
          </article>;
        })}
        {visibleTodos.map(todo => {
          const key = `todo:${todo.id}`;
          const isSelected = selected.has(key);
          return <article className={`evidence-row ${isSelected ? "" : "excluded"}`} key={key}>
            <span className="evidence-icon task"><Check size={15}/></span>
            <div><small>Completed task · {friendlyDate(todo.completed_at, timezone)}</small><strong>{todo.title}</strong>{todo.notes && <p>{todo.notes}</p>}</div>
            <AttachButton item={completedTaskAttachment(todo)}/>
            <button disabled={select.isPending} onClick={() => select.mutate([{ type: "todo", id: todo.id, selected: !isSelected }])}>{isSelected ? "Remove" : "Select"}</button>
          </article>;
        })}
      </div>
      <aside className="review-draft">
        <header><div><div className="eyebrow">Agent draft</div><h3>{data.range.label}</h3></div><div className="review-draft-actions">
          {(data.generated_draft || data.draft) && <button className="button icon ghost" aria-label="Copy reflection" onClick={() => navigator.clipboard.writeText(data.generated_draft ? draftContent : data.draft?.content || "")}><Copy size={14}/></button>}
          {data.generated_draft && <button className="button primary" disabled={saveDraft.isPending} onClick={() => saveDraft.mutate()}>
            {saveDraft.isPending ? <LoaderCircle className="spin" size={14}/> : <Database size={14}/>}
            {saveDraft.isPending ? "Saving…" : "Save to Journal"}
          </button>}
        </div></header>
        {draft.error && <div className="inline-error"><TriangleAlert size={14}/><span>{draft.error.message}</span></div>}
        {saveDraft.error && <div className="inline-error"><TriangleAlert size={14}/><span>{saveDraft.error.message}</span></div>}
        {draft.isPending ? <div className="review-draft-placeholder generating">
          <span><LoaderCircle className="spin" size={25}/></span>
          <h4>Writing your reflection…</h4>
          <p>The Agent is grounding the draft in {includedCount} selected {includedCount === 1 ? "record" : "records"}.</p>
        </div> : data.generated_draft ? <div className="reflection-editor">
          <div className="reflection-editor-fields">
            {/* The draft owns its own Write/Preview toggle, so the markdown can
                be checked without leaving the tags and mood behind. */}
            <Field label="Draft"><MarkdownEditor value={draftContent} onChange={setDraftContent} rows={14}/></Field>
            <Field label="Suggested tags"><input className="input" value={draftTags} onChange={event => setDraftTags(event.target.value)} placeholder="progress, family, learning"/></Field>
            <Field label="Suggested mood"><div className="reflection-mood">
              <button type="button" className={draftMood === null ? "active" : ""} onClick={() => { setDraftMood(null); setDraftMoodLabel(""); }}>None</button>
              {[1,2,3,4,5].map(score => <button type="button" key={score} className={draftMood === score ? "active" : ""} onClick={() => setDraftMood(score)}>{moodEmoji(score)}</button>)}
              {draftMood !== null && <input value={draftMoodLabel} onChange={event => setDraftMoodLabel(event.target.value)} placeholder="Mood label" aria-label="Reflection mood label"/>}
            </div></Field>
          </div>
        </div> : data.draft ? <div className="review-draft-copy"><MarkdownContent content={data.draft.content}/></div> : <div className="review-draft-placeholder">
          <span><Sparkles size={24}/></span>
          <h4>See the shape of this period.</h4>
          <p>The Agent will organize only included records into highlights, progress, lessons, and next steps—without inventing outcomes.</p>
        </div>}
        <footer>{data.generated_draft ? <><Sparkles size={12}/>Generated draft · not saved</> : data.draft ? <><Database size={12}/>Saved in Journal · grounded in canonical records</> : <><Database size={12}/>Nothing is saved until you choose Save to Journal</>}</footer>
      </aside>
    </section>
    {showHighlight && <HighlightModal lifeAreas={lifeAreas} initialLifeAreaId={lifeAreaIds.length === 1 ? lifeAreaIds[0] : ""} onClose={() => setShowHighlight(false)} onSaved={() => { setShowHighlight(false); void queryClient.invalidateQueries({ queryKey: ["reflection"] }); }}/>}
  </div>;
}
