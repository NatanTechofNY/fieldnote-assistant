import { createContext, useContext } from "react";

export type ConfirmOptions = {
  /** The question, in a sentence or two. */
  message: string;
  title?: string;
  confirmLabel?: string;
  /** Styles the confirming button as destructive. A sync or a save is not. */
  danger?: boolean;
};

export type Confirm = (options: string | ConfirmOptions) => Promise<boolean>;

/**
 * Without a provider the browser's own dialog answers, which keeps a page that
 * is rendered on its own working.
 */
const fallback: Confirm = async options =>
  window.confirm(typeof options === "string" ? options : options.message);

export const ConfirmContext = createContext<Confirm>(fallback);

/**
 * Asks the person a question before something happens, in the page. It is
 * asynchronous where `window.confirm` was not, so callers chain `.then`.
 * See `ConfirmProvider` for why the browser's dialog is not used.
 */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}
