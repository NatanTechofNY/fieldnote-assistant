import { type ReactNode, useState } from "react";
import { Check, RotateCcw } from "lucide-react";

/** Matches `SOUL_MAX` (and `PROFILE_MAX`) on the server; the server is the one that refuses. */
export const SOUL_MAX = 1200;

/**
 * A Soul: how the assistant talks in one place, as short rules. The agent
 * rewrites it when someone gives it feedback, so what is shown is whatever it
 * last wrote; editing it here replaces that, and clearing it goes back to the
 * assistant's default voice. The profile uses the same editor under its own
 * labels, since it is also text the assistant writes and the owner corrects.
 */
export function SoulEditor({
  name, value, placeholder, saving, onSave,
  title = "Soul", setLabel = "Shaped", emptyLabel = "Default voice", saveLabel = "Save Soul",
  hint = "Blank uses the assistant's default voice. It also updates itself when you give it feedback in chat.",
  action,
}: {
  /** One more button beside Save, held off while there is an unsaved draft it would overwrite. */
  action?: { label: string; icon: ReactNode; pending: boolean; onClick: () => void };
  /** Names the field for assistive tech and tests, e.g. `Soul for Home`. */
  name: string;
  value: string | null;
  placeholder: string;
  saving?: boolean;
  onSave: (text: string | null) => void;
  title?: string;
  setLabel?: string;
  emptyLabel?: string;
  saveLabel?: string;
  hint?: string;
}) {
  // The draft is kept against the value it was typed over, so a save or an
  // agent rewrite landing shows the new text rather than a stale draft.
  const [state, setState] = useState({ base: value, draft: value ?? "" });
  const text = state.base === value ? state.draft : (value ?? "");
  const setText = (next: string) => setState({ base: value, draft: next });
  const custom = text.trim().length > 0;
  const dirty = (text.trim() || null) !== (value?.trim() || null);
  const over = text.trim().length > SOUL_MAX;
  return <div className={`ask-editor ${custom ? "custom" : ""}`}>
    <div className="ask-editor-head">
      <strong>{title}</strong>
      <span className="ask-editor-state">{value ? setLabel : emptyLabel}</span>
    </div>
    <textarea
      className="input ask-editor-text"
      aria-label={name}
      rows={5}
      value={text}
      placeholder={placeholder}
      onChange={event => setText(event.target.value)}
    />
    <div className="ask-editor-foot">
      <small className={over ? "over" : ""}>
        {custom ? `${text.trim().length} / ${SOUL_MAX}` : hint}
      </small>
      <span className="ask-editor-actions">
        {action && (
          <button
            className="button ghost"
            type="button"
            disabled={dirty || saving || action.pending}
            title={dirty ? "Save or discard your edits first" : undefined}
            onClick={action.onClick}
          >
            {action.icon}{action.label}
          </button>
        )}
        {value && (
          <button className="button ghost" type="button" disabled={saving} onClick={() => { setText(""); onSave(null); }}>
            <RotateCcw size={13}/>Reset
          </button>
        )}
        <button className="button ghost" type="button" disabled={!dirty || over || saving} onClick={() => onSave(text.trim() || null)}>
          <Check size={13}/>{saveLabel}
        </button>
      </span>
    </div>
  </div>;
}
