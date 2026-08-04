import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Database, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { api } from "../../api";
import type {
  Memory, MemoryKind,
} from "../../types";
import { PageHead } from "../../components/layout/PageHead";
import { AttachButton, Empty, ErrorState, Loading, MarkdownContent, MemoryIcon } from "../../components/ui";
import { memoryAttachment } from "../../lib/agent-attachments";
import { moodEmoji } from "../../lib/mood";
import { useDebounced } from "../../lib/use-debounced";
import { useDeepLinkTarget } from "../../lib/use-deep-link-target";
import { LifeAreaFilter } from "../../components/ui/LifeAreaFilter";
import { LifeAreaPill } from "../../components/ui/LifeAreaPill";
import { MemoryModal } from "./MemoryModal";

export function MemoriesPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"all" | MemoryKind>("all");
  const [query, setQuery] = useState("");
  const [lifeAreaId, setLifeAreaId] = useState("");
  const [editor, setEditor] = useState<Memory | "new" | null>(null);
  const debouncedQuery = useDebounced(query.trim());
  const { data: lifeAreas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const { data, isLoading, error } = useQuery({
    queryKey: ["memories", kind, debouncedQuery, lifeAreaId],
    queryFn: () => api.memories({ kind, query: debouncedQuery, life_area_id: lifeAreaId || undefined }),
    placeholderData: previous => previous,
  });
  const memories = useMemo(() => data?.memories ?? [], [data]);
  // `?open=` is how search results land on a specific memory.
  const deepLink = useDeepLinkTarget(memories);
  const editing = editor ?? deepLink.target ?? null;
  const closeEditor = () => { setEditor(null); deepLink.clear(); };
  const remove = useMutation({ mutationFn: api.deleteMemory, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["memories"] }); void queryClient.invalidateQueries({ queryKey: ["overview"] }); } });
  const journalGroups = useMemo(() => {
    const map = new Map<string, Memory[]>();
    [...memories].sort((a, b) =>
      new Date(b.occurred_at || b.created_at).getTime() - new Date(a.occurred_at || a.created_at).getTime()
    ).forEach(m => {
      const key = format(new Date(m.occurred_at || m.created_at), "MMMM d, yyyy");
      map.set(key, [...(map.get(key) || []), m]);
    });
    return [...map.entries()];
  }, [memories]);
  return <div className="page">
    <PageHead eyebrow="Semantic recall" title="Memory, made useful." description="Facts, notes, and journal entries become searchable context—not a pile of forgotten text." />
    <div className="toolbar">
      <div className="search"><Search size={16} aria-hidden="true"/><input className="input" aria-label="Search memories" placeholder="Search by meaning, person, place, or phrase…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      {debouncedQuery && data && <span className={`source-pill ${data.source}`}>
        {data.source === "algolia" ? <><Sparkles size={11}/>Ranked by Algolia</> : <><Database size={11}/>SQLite fallback</>}
      </span>}
      <div className="toolbar-actions">
        <button className="button primary" onClick={() => setEditor("new")}><Plus size={15}/>Remember something</button>
      </div>
    </div>
    <LifeAreaFilter areas={lifeAreas} value={lifeAreaId} onChange={setLifeAreaId}/>
    <div className="tabs">{(["all", "fact", "note", "journal"] as const).map(k => <button key={k} className={`tab ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>{k === "all" ? "Everything" : `${k[0].toUpperCase()}${k.slice(1)}s`}</button>)}</div>
    {isLoading ? <Loading/> : error ? <ErrorState error={error}/> : kind === "journal" ? <div className="journal">{journalGroups.map(([date, entries]) => <section className="journal-day" key={date}><div className="journal-date">{date}</div><div>{entries.map(memory => <article className="journal-entry" key={memory.id} onDoubleClick={() => setEditor(memory)}><h3><button type="button" className="card-open" onClick={() => setEditor(memory)}>{memory.mood_score ? moodEmoji(memory.mood_score) : "·"} {memory.title || "Untitled entry"}</button><AttachButton item={memoryAttachment(memory)}/></h3><MarkdownContent content={memory.content}/><div className="todo-meta"><LifeAreaPill name={memory.life_area_name} slug={memory.life_area_slug}/>{memory.tags.join(" · ")}</div></article>)}</div></section>)}</div> :
      memories.length ? <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col" className="cell-title">Title</th>
              <th scope="col" className="cell-optional">Area</th>
              <th scope="col" className="cell-optional">Tags</th>
              <th scope="col">Date</th>
              <th scope="col"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {memories.map(memory => <tr key={memory.id}>
              <td><span className="memory-kind"><MemoryIcon kind={memory.kind}/>{memory.kind}{memory.mood_score ? ` · ${moodEmoji(memory.mood_score)}` : ""}{memory.review_worthy ? " · review" : ""}</span></td>
              <td className="cell-title"><button type="button" onClick={() => setEditor(memory)}>{memory.title || "Untitled"}</button></td>
              <td className="cell-optional"><LifeAreaPill name={memory.life_area_name} slug={memory.life_area_slug}/></td>
              <td className="cell-quiet cell-optional">{memory.tags.slice(0, 2).join(" · ") || "—"}</td>
              <td className="cell-quiet">{format(new Date(memory.occurred_at || memory.created_at), "MMM d, yyyy")}</td>
              <td className="cell-actions">
                <AttachButton item={memoryAttachment(memory)}/>
                <button className="button icon ghost" aria-label="Delete memory" onClick={() => { if (confirm("Delete this memory?")) remove.mutate(memory.id); }}><Trash2 size={12}/></button>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div> : null}
    {!isLoading && !memories.length && <Empty label="No memories match this view." />}
    {editing && <MemoryModal memory={editing === "new" ? undefined : editing} defaultKind={kind === "all" ? "fact" : kind} lifeAreas={lifeAreas} onClose={closeEditor} />}
  </div>;
}
