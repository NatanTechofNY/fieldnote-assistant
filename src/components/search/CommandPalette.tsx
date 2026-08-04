import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bot, Brain, Database, ListTodo, LoaderCircle, MessageSquareText, Phone, Search, Sparkles,
} from "lucide-react";
import { api } from "../../api";
import type { SearchHitType, UniversalSearchHit } from "../../types";
import { Modal } from "../ui";
import { useDebounced } from "../../lib/use-debounced";
import { statusMeta } from "../../lib/todo-meta";

type Filter = "all" | SearchHitType;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "memory", label: "Memories" },
  { id: "todo", label: "Todos" },
  { id: "message", label: "Conversations" },
];

const GROUP_LABELS: Record<SearchHitType, string> = {
  memory: "Memories",
  todo: "Todos",
  message: "Conversation history",
};

const GROUP_ORDER: SearchHitType[] = ["memory", "todo", "message"];

/**
 * Where a result lives, so Enter and click agree on the destination. A message
 * carries the query along so the archive can mark the same words there that are
 * marked here.
 */
function hitPath(hit: UniversalSearchHit, query: string): string {
  if (hit.type === "memory") return `/memories?open=${encodeURIComponent(hit.objectID)}`;
  if (hit.type === "todo") return `/todos?open=${encodeURIComponent(hit.objectID)}`;
  const thread = encodeURIComponent(hit.threadId ?? "");
  return `/history?thread=${thread}&message=${encodeURIComponent(hit.objectID)}`
    + `&q=${encodeURIComponent(query)}`;
}

export function CommandPalette({ onClose, onAskAgent }: {
  onClose: () => void;
  onAskAgent: (question: string) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const debounced = useDebounced(query.trim());
  // Tied to the result set it was chosen for, so a new query starts back at the
  // top without an effect that resets it after the fact.
  const [selection, setSelection] = useState({ key: "", index: 0 });
  const { data, isFetching } = useQuery({
    queryKey: ["universal-search", debounced, filter],
    queryFn: () => api.universalSearch(debounced, {
      types: filter === "all" ? undefined : [filter],
      limit: 6,
    }),
    enabled: debounced.length > 0,
    placeholderData: previous => previous,
  });
  const hits = useMemo(() => debounced ? data?.hits ?? [] : [], [debounced, data]);
  const groups = useMemo(() => GROUP_ORDER
    .map(type => ({ type, items: hits.filter(hit => hit.type === type) }))
    .filter(group => group.items.length > 0), [hits]);
  // Rows are numbered down the screen rather than in the order the endpoint
  // returned them, which interleaves types and would make arrow keys jump
  // between groups. Row 0 is the agent, so Enter on a fresh query asks it rather
  // than opening whatever happened to rank first, and a query that matches
  // nothing still has somewhere to go.
  const rows = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const rowCount = debounced ? rows.length + 1 : 0;
  const resultKey = `${debounced}|${filter}`;
  const active = selection.key === resultKey ? Math.min(selection.index, Math.max(rowCount - 1, 0)) : 0;
  const setActive = (index: number) => setSelection({ key: resultKey, index });

  const count = (id: Filter) => {
    if (!data) return undefined;
    return id === "all"
      ? Object.values(data.counts).reduce((total, value) => total + value, 0)
      : data.counts[id];
  };

  function activate(index: number) {
    if (!debounced) return;
    if (index === 0) {
      onAskAgent(debounced);
      return onClose();
    }
    navigate(hitPath(rows[index - 1], debounced));
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!rowCount) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((active + 1) % rowCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active - 1 + rowCount) % rowCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    }
  }

  const indexOf = (hit: UniversalSearchHit) => rows.indexOf(hit) + 1;
  const agentRow = useHighlightVisible(active === 0);

  return <Modal title="Search everything" variant="palette" onClose={onClose}>
    <div className="palette-body" onKeyDown={onKeyDown}>
      <div className="palette-input">
        <Search size={15} aria-hidden="true"/>
        <input
          className="input"
          aria-label="Search memories, todos, and conversations"
          aria-controls="palette-results"
          aria-activedescendant={rowCount ? `palette-row-${active}` : undefined}
          placeholder="Search memories, todos, and conversations…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          autoFocus
        />
        {isFetching && <LoaderCircle className="spin" size={15}/>}
      </div>
      <div className="palette-filters">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`tab ${filter === id ? "active" : ""}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}{debounced && count(id) !== undefined ? ` ${count(id)}` : ""}
          </button>
        ))}
      </div>
      <div className="palette-results" id="palette-results" role="listbox" aria-label="Search results">
        {!debounced ? <p className="palette-hint">
          Start typing to search saved memories, tasks on the board, and every conversation you have had.
        </p> : <>
          <div className="palette-group">
            <div className="eyebrow">Agent</div>
            <div
              ref={agentRow}
              id="palette-row-0"
              role="option"
              aria-selected={active === 0}
              className={`palette-row agent ${active === 0 ? "active" : ""}`}
              onMouseMove={() => setActive(0)}
              onClick={() => activate(0)}
            >
              <span className="palette-icon"><Bot size={13}/></span>
              <div className="palette-main">
                <strong>Ask the agent about “{debounced}”</strong>
                <span>Sends the question straight to the assistant panel.</span>
              </div>
            </div>
          </div>
          {groups.map(group => <div className="palette-group" key={group.type}>
            <div className="eyebrow">{GROUP_LABELS[group.type]}</div>
            {group.items.map(hit => <PaletteRow
              key={`${hit.type}-${hit.objectID}`}
              hit={hit}
              index={indexOf(hit)}
              active={active === indexOf(hit)}
              onHover={setActive}
              onSelect={activate}
            />)}
          </div>)}
          {!hits.length && !isFetching && <p className="palette-hint">No matches for “{debounced}”.</p>}
        </>}
      </div>
      <footer className="palette-foot">
        <span>Enter to ask the agent · ↑↓ to pick a result · Esc to close</span>
        {debounced && data && <span className={`source-pill ${data.source}`}>
          {data.source === "algolia" ? <><Sparkles size={11}/>Algolia</> : <><Database size={11}/>SQLite fallback</>}
        </span>}
      </footer>
    </div>
  </Modal>;
}

/**
 * Follows the highlight with the scroll position, since the result list is
 * taller than its own box and arrow keys are the only way to reach the bottom.
 * Hovering also highlights, but a row under the pointer is already in view, so
 * "nearest" makes that a no-op.
 */
function useHighlightVisible(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return ref;
}

function PaletteRow({ hit, index, active, onHover, onSelect }: {
  hit: UniversalSearchHit;
  index: number;
  active: boolean;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  const ref = useHighlightVisible(active);
  const icon = hit.type === "memory" ? <Brain size={15}/>
    : hit.type === "todo" ? <ListTodo size={15}/>
      : hit.channel === "sms" ? <Phone size={15}/> : <MessageSquareText size={15}/>;
  const label = hit.type === "memory" ? hit.kind
    : hit.type === "todo" ? (hit.status ? statusMeta[hit.status].label : "task")
      : `${hit.channel === "sms" ? "SMS" : "Web"} · ${hit.role}`;
  return <div
    ref={ref}
    id={`palette-row-${index}`}
    role="option"
    aria-selected={active}
    className={`palette-row ${active ? "active" : ""}`}
    onMouseMove={() => onHover(index)}
    onClick={() => onSelect(index)}
  >
    <span className="palette-icon">{icon}</span>
    <div className="palette-main">
      <strong>{hit.title ?? hit.snippet ?? "Untitled"}</strong>
      {hit.title && hit.snippet && <span>{hit.snippet}</span>}
    </div>
    <span className="palette-meta">
      {label}
      {hit.life_area_name ? ` · ${hit.life_area_name}` : ""}
    </span>
  </div>;
}
