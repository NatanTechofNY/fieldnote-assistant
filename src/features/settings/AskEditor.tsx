import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";

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
 *
 * `draft`, when given, lets the agent write the wording: the owner says what
 * the chat is for or how they want to be asked, and the answer lands in the
 * field to read and save — never saved on its own.
 */
export function AskEditor({ label, name, fallback, value, saving, onSave, onChange, draft }: {
  label: string;
  /** Names the field for assistive tech and tests, e.g. `Morning check-in wording for Home`. */
  name: string;
  fallback: string;
  value: string | null;
  saving?: boolean;
  onSave?: (ask: string | null) => void;
  onChange?: (draft: string) => void;
  draft?: {
    /** What to ask the owner for, e.g. "What is this group chat for?" */
    prompt: string;
    placeholder: string;
    request: (brief: string, current: string | null) => Promise<string>;
    onError?: (message: string) => void;
  };
}) {
  // The draft is kept against the server value it was typed over: when that
  // value changes (the save landed, or a reset), the field shows the new value
  // rather than a stale draft, without an effect.
  const [state, setState] = useState({ base: value, draft: value ?? "" });
  const text = state.base === value ? state.draft : (value ?? "");
  const setText = (next: string) => { setState({ base: value, draft: next }); onChange?.(next); };
  const [helping, setHelping] = useState(false);
  const [brief, setBrief] = useState("");
  const assist = useMutation({
    mutationFn: (about: string) => draft!.request(about, text.trim() || null),
    onSuccess: (ask) => { setText(ask); setHelping(false); },
    onError: (error: Error) => draft?.onError?.(error.message),
  });
  const custom = text.trim().length > 0;
  const dirty = (text.trim() || null) !== (value?.trim() || null);
  const over = text.trim().length > ASK_MAX;
  return <div className={`ask-editor ${custom ? "custom" : ""}`}>
    <div className="ask-editor-head">
      <strong>{label}</strong>
      <span className="ask-editor-state">{custom ? "Your wording" : "Default"}</span>
    </div>
    <textarea
      className="input ask-editor-text"
      aria-label={name}
      rows={3}
      value={text}
      placeholder={fallback}
      onChange={event => setText(event.target.value)}
    />
    {draft && helping && <div className="ask-helper">
      <label>
        <span>{draft.prompt}</span>
        <input
          className="input"
          aria-label={`${name}: what it should be like`}
          value={brief}
          placeholder={draft.placeholder}
          disabled={assist.isPending}
          onChange={event => setBrief(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && brief.trim()) { event.preventDefault(); assist.mutate(brief); } }}
        />
      </label>
      <div className="ask-helper-actions">
        <button className="button ghost" type="button" disabled={assist.isPending} onClick={() => setHelping(false)}>
          <X size={13}/>Cancel
        </button>
        <button className="button primary" type="button" disabled={!brief.trim() || assist.isPending} onClick={() => assist.mutate(brief)}>
          {assist.isPending ? <LoaderCircle className="spin" size={13}/> : <Sparkles size={13}/>}
          {custom ? "Rewrite it" : "Write it"}
        </button>
      </div>
      <small className="field-hint">The suggestion lands in the field above for you to read; nothing is saved until you save the wording.</small>
    </div>}
    <div className="ask-editor-foot">
      <small className={over ? "over" : ""}>
        {custom ? `${text.trim().length} / ${ASK_MAX}` : "Leave blank to use the default shown."}
      </small>
      <span className="ask-editor-actions">
        {draft && !helping && (
          <button className="button ghost" type="button" disabled={saving} onClick={() => setHelping(true)}>
            <Sparkles size={13}/>Help me write it
          </button>
        )}
        {onSave && custom && (
          <button className="button ghost" type="button" disabled={saving} onClick={() => { setText(""); onSave(null); }}>
            <RotateCcw size={13}/>Use default
          </button>
        )}
        {onSave && (
          <button className="button ghost" type="button" disabled={!dirty || over || saving} onClick={() => onSave(text.trim() || null)}>
            <Check size={13}/>Save wording
          </button>
        )}
      </span>
    </div>
  </div>;
}
