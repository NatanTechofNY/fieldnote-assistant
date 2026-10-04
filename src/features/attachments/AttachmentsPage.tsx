import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { FileText, Trash2 } from "lucide-react";
import { api } from "../../api";
import { PageHead } from "../../components/layout/PageHead";
import { Empty, ErrorState, Loading } from "../../components/ui";
import { AttachmentViewer } from "../../components/ui/AttachmentThumbs";
import { LifeAreaPill } from "../../components/ui/LifeAreaPill";
import type { Attachment } from "../../types";

type Filter = "all" | "photo" | "document";

const FILTERS: Array<[Filter, string]> = [["all", "Everything"], ["photo", "Photos"], ["document", "Documents"]];

/** Every picture texted to the assistant and kept on the server, newest first. */
export function AttachmentsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["attachments", filter],
    queryFn: ({ pageParam }) => api.attachments({ kind: filter === "all" ? undefined : filter, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.next_before,
  });
  const remove = useMutation({
    mutationFn: api.deleteAttachment,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["attachments"] });
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const attachments = data?.pages.flatMap(page => page.attachments) ?? [];
  return <div className="page">
    <PageHead eyebrow="Kept locally" title="Pictures, kept." description="Receipts, invoices, and photos you text the assistant are saved on your server, with what it read off each one." />
    <div className="tabs">{FILTERS.map(([value, label]) =>
      <button key={value} className={`tab ${filter === value ? "active" : ""}`} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    {isLoading ? <Loading/> : error ? <ErrorState error={error}/> : attachments.length ? <>
      <div className="attachment-grid">
        {attachments.map(attachment => <article className="card attachment-card" key={attachment.id}>
          <button type="button" className="attachment-card-image" aria-label="Open the picture" onClick={() => setViewing(attachment)}>
            <img src={attachment.url} alt={attachment.description ?? "A picture sent to the assistant"} loading="lazy" />
          </button>
          <div className="attachment-card-body">
            <div className="attachment-card-meta">
              {attachment.kind === "document" && <span className="memory-kind"><FileText size={12}/>Document</span>}
              <LifeAreaPill name={attachment.life_area_name} />
              <span className="cell-quiet">{format(new Date(attachment.created_at), "MMM d, yyyy")}</span>
            </div>
            <p className="attachment-card-text">{attachment.description || "Not described"}</p>
            <div className="attachment-card-actions">
              {attachment.memory_ids?.map(memoryId =>
                <Link key={memoryId} className="button ghost" to={`/memories?open=${encodeURIComponent(memoryId)}`}>From memory</Link>)}
              <button
                type="button"
                className="button icon ghost"
                aria-label="Delete picture"
                onClick={() => { if (confirm("Delete this picture from the server?")) remove.mutate(attachment.id); }}
              ><Trash2 size={12}/></button>
            </div>
          </div>
        </article>)}
      </div>
      {hasNextPage && <div className="attachment-more">
        <button type="button" className="button" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          {isFetchingNextPage ? "Loading…" : "Show older"}
        </button>
      </div>}
    </> : <Empty label="No pictures yet. Text the assistant a receipt and it will be kept here." />}
    {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
  </div>;
}
