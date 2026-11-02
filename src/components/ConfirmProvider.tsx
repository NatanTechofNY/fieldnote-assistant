import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Confirm, type ConfirmOptions, ConfirmContext } from "../lib/confirm";
import { Modal } from "./ui/Modal";

type Pending = { options: ConfirmOptions; resolve: (answer: boolean) => void };

/**
 * A question the person has to answer before anything happens, asked in the page.
 *
 * `window.confirm` is not available everywhere the app runs. The macOS app is a
 * WKWebView, which draws no JavaScript dialogs unless its host implements them,
 * so every `confirm(...) && act()` there answered "no" without ever showing a
 * question, and the button looked dead. An in-page dialog is drawn the same way
 * in a browser and in the app.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Held so a second question asked while one is open refuses the first rather than leaving it waiting forever.
  const open = useRef<Pending | null>(null);
  const ask = useCallback<Confirm>(options => new Promise<boolean>(resolve => {
    open.current?.resolve(false);
    const next = { options: typeof options === "string" ? { message: options } : options, resolve };
    open.current = next;
    setPending(next);
  }), []);
  const answer = useCallback((value: boolean) => {
    const current = open.current;
    open.current = null;
    setPending(null);
    current?.resolve(value);
  }, []);
  // The dialog can sit above another one (a note inside a task), and every
  // dialog closes on Escape from a window listener. Taking the key first, in the
  // capture phase, means Escape cancels the question and leaves the task open.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      answer(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, answer]);
  const options = pending?.options;
  return <ConfirmContext.Provider value={ask}>
    {children}
    {options && <Modal title={options.title ?? "Are you sure?"} onClose={() => answer(false)}>
      <div className="destructive-modal confirm-dialog">
        <p>{options.message}</p>
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={() => answer(false)}>Cancel</button>
          <button
            type="button"
            className={`button ${options.danger === false ? "primary" : "danger"}`}
            autoFocus
            onClick={() => answer(true)}
          >{options.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </Modal>}
  </ConfirmContext.Provider>;
}
