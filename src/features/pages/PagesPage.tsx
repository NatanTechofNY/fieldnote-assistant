import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Ban, CalendarRange, Check, ChartColumn, Copy, ExternalLink, Eye, Lock, Plus, Users } from "lucide-react";
import { api } from "../../api";
import { PageHead } from "../../components/layout/PageHead";
import { Empty, ErrorState, Loading, Toast } from "../../components/ui";
import { useRedact } from "../../lib/demo-mode";
import type { HostedPage, PageBlockResult } from "../../types";

type Filter = "active" | "all";

const FILTERS: Array<[Filter, string]> = [["active", "Active"], ["all", "Expired & closed"]];

const kindLabel = (page: HostedPage): string => {
  if (page.template) return page.template.replace(/_/g, " ");
  return page.kind === "poll" ? "poll" : page.kind;
};

function expiry(page: HostedPage): string {
  if (page.revoked) return "Closed";
  const at = new Date(page.expires_at);
  return at.getTime() <= Date.now()
    ? `Expired ${formatDistanceToNowStrict(at)} ago`
    : `Expires in ${formatDistanceToNowStrict(at)}`;
}

/**
 * Every hosted page the assistant or you have made: where it was sent, who has
 * opened or answered it, and a way to turn its link off. A private page opens
 * only for you when you are signed in; a shared one opens for anyone with the link.
 */
export function PagesPage() {
  const queryClient = useQueryClient();
  const redact = useRedact();
  const [filter, setFilter] = useState<Filter>("active");
  const [openResults, setOpenResults] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const notify = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };
  const { data: pages = [], isLoading, error } = useQuery({
    queryKey: ["pages", filter],
    queryFn: () => api.pages(filter === "all"),
  });
  const shown = filter === "all" ? pages.filter(page => !page.live) : pages;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["pages"] });
  const revoke = useMutation({
    mutationFn: api.revokePage,
    onSuccess: () => { refresh(); notify("Link turned off"); },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const create = useMutation({
    mutationFn: (template: "today" | "week") => api.createPage({ template }),
    onSuccess: page => { refresh(); notify(page.url ? "Page ready" : "Page made; set PUBLIC_BASE_URL to get a link"); },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  const copy = async (page: HostedPage) => {
    const link = page.url ?? `${window.location.origin}${page.path}`;
    try {
      await navigator.clipboard.writeText(link);
      notify("Link copied");
    } catch {
      // The address is not put on screen: in demo mode it would show what the mask hides.
      notify("Could not copy the link; open the page and copy it from the address bar");
    }
  };
  return <div className="page">
    <PageHead
      eyebrow="Shared"
      title="Pages."
      description="Lists, plans, and polls the assistant built as links. Private pages open only for you; shared pages open for anyone holding the link until they expire."
    />
    <div className="pages-toolbar">
      <div className="tabs">{FILTERS.map(([value, label]) =>
        <button key={value} type="button" className={`tab ${filter === value ? "active" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      <div className="pages-new">
        <button type="button" className="button ghost" disabled={create.isPending} onClick={() => create.mutate("today")}>
          <Plus size={13}/>Today&rsquo;s page
        </button>
        <button type="button" className="button ghost" disabled={create.isPending} onClick={() => create.mutate("week")}>
          <Plus size={13}/>This week
        </button>
      </div>
    </div>
    {isLoading ? <Loading/> : error ? <ErrorState error={error}/> : shown.length ? <div className="pages-list">
      {shown.map(page => <article className={`card page-row ${page.live ? "" : "gone"}`} key={page.id}>
        <div className="page-row-main">
          <div className="page-row-title">
            <strong>{page.title}</strong>
            <span className={`page-audience ${page.audience}`}>
              {page.audience === "owner" ? <><Lock size={11}/>Private</> : <><Users size={11}/>Shared</>}
            </span>
            <span className="page-kind">{kindLabel(page)}</span>
          </div>
          <div className="page-row-meta">
            <span>{page.group ? `In ${redact.text(page.group, 12)}` : "Not sent to a chat"}</span>
            <span><Eye size={11}/>{page.view_count} {page.view_count === 1 ? "view" : "views"}</span>
            {page.kind === "poll" && <span><ChartColumn size={11}/>{page.voters} {page.voters === 1 ? "answer" : "answers"}</span>}
            <span><CalendarRange size={11}/>{expiry(page)}</span>
          </div>
          {page.url && <code className="page-row-link">{redact.url(page.url)}</code>}
        </div>
        <div className="page-row-actions">
          {page.kind === "poll" && <button
            type="button"
            className="button ghost"
            aria-expanded={openResults === page.id}
            onClick={() => setOpenResults(openResults === page.id ? null : page.id)}
          >Results</button>}
          {page.live && <a className="button ghost" href={page.path} target="_blank" rel="noreferrer"><ExternalLink size={12}/>Open</a>}
          {page.live && <button type="button" className="button ghost" onClick={() => void copy(page)}><Copy size={12}/>Copy link</button>}
          {page.live && <button
            type="button"
            className="button ghost danger"
            disabled={revoke.isPending}
            onClick={() => {
              if (confirm(`Turn off the link to "${page.title}"? Anyone opening it will see that it is gone.`)) revoke.mutate(page.id);
            }}
          ><Ban size={12}/>Revoke</button>}
        </div>
        {openResults === page.id && <PollResults pageId={page.id}/>}
      </article>)}
    </div> : <Empty label={filter === "active"
      ? "No pages yet. Ask the assistant for a list, a plan, or a poll, or make today's page above."
      : "Nothing has expired or been closed."}/>}
    {toast && <Toast><Check size={13}/> {toast}</Toast>}
  </div>;
}

function PollResults({ pageId }: { pageId: string }) {
  const redact = useRedact();
  const { data, isLoading, error } = useQuery({ queryKey: ["page-results", pageId], queryFn: () => api.pageResults(pageId) });
  if (isLoading) return <Loading/>;
  if (error || !data) return <ErrorState error={error}/>;
  if (!data.length) return <p className="cell-quiet">This page has nothing to vote on.</p>;
  return <div className="page-results">{data.map((result: PageBlockResult) => <section key={result.block_id}>
    <h4>{result.question}{result.closed && <small> · closed</small>}</h4>
    {!result.voters.length ? <p className="cell-quiet">Nobody has answered yet.</p> : <ul>
      {result.options.map(option => <li key={option.id} className={result.leaders.includes(option.label) ? "leading" : ""}>
        <span>{option.label}</span>
        <strong>{option.count}</strong>
        <small>{option.voters.map(name => redact.text(name, 6)).join(", ")}</small>
      </li>)}
    </ul>}
  </section>)}</div>;
}
