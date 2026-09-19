import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";

/** Matches `CHECKIN_PROMPT_MAX` on the server; the server is the one that refuses. */
export const ASK_MAX = 600;

/**
 * The wording of one check-in's ask, with the default shown and an override
 * over it. What the owner writes replaces only the ask: the day's context and
 * the no-tools rule are still supplied underneath by the app, so a rewording
 * can change the tone or the questions but never what the turn is allowed to
 * do. Clearing the field goes back to the default.
 *
 * `onSave` is called with the trimmed wording, or null for the default. When it
 * is omitted the editor is uncontrolled-by-server: `onChange` reports the draft
 * and the parent saves it with its own form.
 */
export function AskEditor({ label, name, fallback, value, saving, onSave, onChange }: {
  label: string;
  /** Names the field for assistive tech and tests, e.g. `Morning check-in wording for Home`. */
  name: string;
  fallback: string;
  value: string | null;
  saving?: boolean;
  onSave?: (ask: string | null) => void;
  onChange?: (draft: string) => void;
}) {
  // The draft is kept against the server value it was typed over: when that
  // value changes (the save landed, or a reset), the field shows the new value
  // rather than a stale draft, without an effect.
  const [state, setState] = useState({ base: value, draft: value ?? "" });
  const draft = state.base === value ? state.draft : (value ?? "");
  const setDraft = (next: string) => setState({ base: value, draft: next });
  const custom = draft.trim().length > 0;
  const dirty = (draft.trim() || null) !== (value?.trim() || null);
  const over = draft.trim().length > ASK_MAX;
  return <div className={`ask-editor ${custom ? "custom" : ""}`}>
    <div className="ask-editor-head">
      <strong>{label}</strong>
      <span className="ask-editor-state">{custom ? "Your wording" : "Default"}</span>
    </div>
    <textarea
      className="input ask-editor-text"
      aria-label={name}
      rows={3}
      value={draft}
      placeholder={fallback}
      onChange={event => { setDraft(event.target.value); onChange?.(event.target.value); }}
    />
    <div className="ask-editor-foot">
      <small className={over ? "over" : ""}>
        {custom ? `${draft.trim().length} / ${ASK_MAX}` : "Leave blank to use the default shown."}
      </small>
      {onSave && <span className="ask-editor-actions">
        {custom && (
          <button className="button ghost" type="button" disabled={saving} onClick={() => { setDraft(""); onSave(null); }}>
            <RotateCcw size={13}/>Use default
          </button>
        )}
        <button className="button ghost" type="button" disabled={!dirty || over || saving} onClick={() => onSave(draft.trim() || null)}>
          <Check size={13}/>Save wording
        </button>
      </span>}
    </div>
  </div>;
}
