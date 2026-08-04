import { useId, useState } from "react";
import { Eye, Pencil } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

/**
 * A textarea with a Preview tab. Journals, notes, and task notes are rendered as
 * markdown everywhere else in the app, so the editor has to be able to show what
 * the saved text will actually look like.
 */
export function MarkdownEditor({ value, onChange, required, autoFocus, placeholder, rows }: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  const [preview, setPreview] = useState(false);
  const panelId = useId();
  return <div className="markdown-editor">
    <div className="markdown-editor-tabs" role="tablist" aria-label="Editor mode">
      <button
        type="button"
        role="tab"
        aria-selected={!preview}
        aria-controls={panelId}
        className={`tab ${preview ? "" : "active"}`}
        onClick={() => setPreview(false)}
      >
        <Pencil size={12}/>Write
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={preview}
        aria-controls={panelId}
        className={`tab ${preview ? "active" : ""}`}
        onClick={() => setPreview(true)}
      >
        <Eye size={12}/>Preview
      </button>
      <span className="markdown-editor-hint">Markdown supported</span>
    </div>
    <div id={panelId} role="tabpanel">
      {preview ? <div className="markdown-editor-preview">
        {value.trim()
          ? <MarkdownContent content={value}/>
          : <p className="field-hint">Nothing to preview yet.</p>}
      </div> : <textarea
        className="textarea"
        value={value}
        onChange={event => onChange(event.target.value)}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        rows={rows}
      />}
    </div>
  </div>;
}
