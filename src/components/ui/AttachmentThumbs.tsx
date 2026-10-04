import { useState } from "react";
import { FileText } from "lucide-react";
import type { Attachment } from "../../types";
import { Modal } from "./Modal";

/**
 * The pictures kept with a record, as a row of thumbnails. A click opens the
 * full picture beside what the assistant read off it, which for a receipt is
 * the vendor, the date, and the amounts.
 */
export function AttachmentThumbs({ attachments, size = 44 }: { attachments?: Attachment[]; size?: number }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (!attachments?.length) return null;
  return <>
    <span className="attachment-thumbs">
      {attachments.map(attachment => <button
        type="button"
        key={attachment.id}
        className="attachment-thumb"
        style={{ width: size, height: size }}
        aria-label={attachment.kind === "document" ? "Open the saved document" : "Open the saved picture"}
        title={attachment.description ?? "Saved picture"}
        onClick={() => setOpen(attachment)}
      >
        <img src={attachment.url} alt="" loading="lazy" width={size} height={size} />
        {attachment.kind === "document" && <FileText size={11} className="attachment-thumb-badge" aria-hidden="true" />}
      </button>)}
    </span>
    {open && <AttachmentViewer attachment={open} onClose={() => setOpen(null)} />}
  </>;
}

export function AttachmentViewer({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return <Modal title={attachment.kind === "document" ? "Saved document" : "Saved picture"} onClose={onClose} wide>
    <div className="attachment-viewer">
      <img src={attachment.url} alt={attachment.description ?? "A picture sent to the assistant"} />
      {attachment.description && <p className="attachment-description">{attachment.description}</p>}
    </div>
  </Modal>;
}
