import { type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A toast belongs to the viewport, not to whatever rendered it. Rendering it in
 * place makes it a hostage of its ancestors: anything that animates or
 * transforms itself becomes the containing block for `position: fixed`, and the
 * toast then sits at the bottom of a long page rather than the bottom of the
 * screen, off-screen until the page happens to be short.
 */
export function Toast({ children }: { children: ReactNode }) {
  return createPortal(<div className="toast">{children}</div>, document.body);
}
