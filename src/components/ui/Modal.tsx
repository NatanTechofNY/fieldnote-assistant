import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * `palette` keeps every dialog behaviour (focus trap, Escape, scroll lock,
 * focus restore) but drops the visible heading and chrome, because a command
 * palette owns its own header row.
 */
export function Modal({ title, children, onClose, variant = "dialog", wide = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: "dialog" | "palette";
  /** A form that reads as two columns needs the width to hold them. */
  wide?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Read during the first render: by the time effects run, React has already
  // applied any `autoFocus` inside the dialog and the opener is lost.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    // Without this the dialog is announced but never reached: focus stays on the
    // page behind it, so Tab walks the background and Escape is the only way out.
    // A dialog with its own `autoFocus` has already placed focus and is left alone.
    if (!dialog.current?.contains(document.activeElement)) focusable()[0]?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      // Keep Tab inside the dialog; a modal that leaks focus to the page behind
      // it lets a keyboard user edit content they cannot see.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", fn);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", fn);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose, opener]);
  const palette = variant === "palette";
  return createPortal(
    <div
      className={`modal-backdrop${palette ? " palette-backdrop" : ""}`}
      role="presentation"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className={palette ? "modal palette" : `modal${wide ? " wide" : ""}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {palette ? <h3 id={titleId} className="visually-hidden">{title}</h3> : <div style={{ display: "flex" }}>
          <h3 id={titleId}>{title}</h3>
          <button aria-label="Close" className="button icon ghost" style={{ marginLeft: "auto", alignSelf: "start" }} onClick={onClose}><X size={15}/></button>
        </div>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
