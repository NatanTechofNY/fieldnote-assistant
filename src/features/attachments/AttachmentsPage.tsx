import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { FileText, Trash2 } from "lucide-react";
import { api } from "../../api";
import { PageHead } from "../../components/layout/PageHead";
import { Empty, ErrorState, Loading } from "../../components/ui";
import { AttachmentViewer } from "../../components/ui/AttachmentThumbs";
import { pictureLabel } from "../../components/ui/pictureLabel";
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
  // A picture that was not deleted must not look as if it were.
  const deleteFailed = remove.isError;
  const attachments = data?.pages.flatMap(page => page.attachments) ?? [];
  return <div className="page">
    <PageHead eyebrow="Kept locally" title="Pictures, kept." description="Receipts, invoices, and photos you text the assistant are saved on your server, with what it read off each one." />
    <div className="tabs">{FILTERS.map(([value, label]) =>
      <button key={value} className={`tab ${filter === value ? "active" : ""}`} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    {deleteFailed && <p role="alert" className="cell-quiet">That picture could not be deleted. It is still on the server; try again.</p>}
    {isLoading ? <Loading/> : error ? <ErrorState error={error}/> : attachments.length ? <>
      <div className="attachment-grid">
        {attachments.map(attachment => <article className="card attachment-card" key={attachment.id}>
          <button type="button" className="attachment-card-image" aria-label={`Open ${pictureLabel(attachment).toLowerCase()}`} onClick={() => setViewing(attachment)}>
            <img src={attachment.url} alt="" loading="lazy" />
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
                aria-label={`Delete ${pictureLabel(attachment).toLowerCase()}`}
                onClick={() => {
                  if (confirm("Delete this picture from the server? What the assistant read off it is also blanked in the conversation. A memory's own text stays; edit or delete the memory too if it quotes the picture.")) {
                    remove.mutate(attachment.id);
                  }
                }}
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
