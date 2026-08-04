import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { type AgentAttachment, maxAttachments } from "./agent-attachments";

/**
 * The id is what makes the same sentence twice a second request: a chat that
 * already picked one up compares ids rather than text.
 */
export interface AgentDraft {
  id: number;
  text: string;
}

/** The panel is two things behind one surface: the live chat, and its archive. */
export type AgentPanelView = "chat" | "threads";

export interface AgentPanelState {
  isOpen: boolean;
  view: AgentPanelView;
  /**
   * Whether the overlay is at reading width rather than at the width of a
   * message column. It floats over the page either way, so this is only ever a
   * question of how much of the page it is worth covering.
   */
  isExpanded: boolean;
  /**
   * Whether the panel has been opened at least once. The chat is only mounted
   * after that, so a page that never asks for the agent pays nothing, and once
   * mounted it stays mounted so the conversation survives navigation.
   */
  hasOpened: boolean;
  /**
   * A question handed over by another surface, to be sent as soon as the chat is
   * ready. Cleared by whichever chat sends it.
   */
  pendingQuestion: string | null;
  /**
   * A sentence handed over by another surface to be left in the composer for the
   * user to finish. The counterpart to `pendingQuestion`, which is already
   * confirmed and gets sent.
   */
  pendingDraft: AgentDraft | null;
  /**
   * Records the user attached from a page, carried alongside the next message
   * rather than pasted into it. They belong to one turn: whichever chat sends
   * them clears them.
   */
  attachments: AgentAttachment[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  toggleExpanded: () => void;
  /** Opens the panel and asks the question, rather than only drafting it. */
  ask: (question: string) => void;
  /** Opens the panel with the sentence started but not sent. */
  draft: (sentence: string) => void;
  consumeQuestion: () => void;
  consumeDraft: () => void;
  /** Opens the panel with the record chipped above the composer. */
  attach: (item: AgentAttachment) => void;
  detach: (key: string) => void;
  clearAttachments: () => void;
  showChat: () => void;
  showThreads: () => void;
}

export const AgentPanelContext = createContext<AgentPanelState | null>(null);

/** Owns the panel's requested state; the panel itself syncs the chat to it. */
export function useAgentPanelState(): AgentPanelState {
  const [{ isOpen, hasOpened }, setOpenState] = useState({ isOpen: false, hasOpened: false });
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<AgentDraft | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [view, setView] = useState<AgentPanelView>("chat");
  const [isExpanded, setIsExpanded] = useState(false);
  const draftCount = useRef(0);
  const toggleExpanded = useCallback(() => setIsExpanded(expanded => !expanded), []);
  const open = useCallback(() => setOpenState({ isOpen: true, hasOpened: true }), []);
  // Reading the archive is a detour, so it ends when the panel does: opening the
  // agent again lands on the composer, which is what the shortcut promises.
  const close = useCallback(() => {
    setView("chat");
    setOpenState(current => ({ ...current, isOpen: false }));
  }, []);
  const toggle = useCallback(() => {
    setView("chat");
    setOpenState(current => ({ isOpen: !current.isOpen, hasOpened: true }));
  }, []);
  const ask = useCallback((question: string) => {
    setView("chat");
    setPendingQuestion(question);
    setOpenState({ isOpen: true, hasOpened: true });
  }, []);
  const draft = useCallback((sentence: string) => {
    draftCount.current += 1;
    setView("chat");
    setPendingDraft({ id: draftCount.current, text: sentence });
    setOpenState({ isOpen: true, hasOpened: true });
  }, []);
  const consumeQuestion = useCallback(() => setPendingQuestion(null), []);
  const consumeDraft = useCallback(() => setPendingDraft(null), []);
  // Attaching is how a page starts a message about the row under the cursor, so
  // it opens the panel the way `draft` does. Re-attaching the same record is a
  // no-op rather than a second chip, and the oldest is dropped once full.
  const attach = useCallback((item: AgentAttachment) => {
    setAttachments(current => current.some(existing => existing.key === item.key)
      ? current
      : [...current, item].slice(-maxAttachments));
    setView("chat");
    setOpenState({ isOpen: true, hasOpened: true });
  }, []);
  const detach = useCallback((key: string) =>
    setAttachments(current => current.filter(item => item.key !== key)), []);
  const clearAttachments = useCallback(() => setAttachments([]), []);
  const showChat = useCallback(() => setView("chat"), []);
  const showThreads = useCallback(() => setView("threads"), []);
  return useMemo(
    () => ({
      isOpen, hasOpened, view, isExpanded, pendingQuestion, pendingDraft, attachments,
      open, close, toggle, toggleExpanded, ask, draft, consumeQuestion, consumeDraft,
      attach, detach, clearAttachments, showChat, showThreads,
    }),
    [
      isOpen, hasOpened, view, isExpanded, pendingQuestion, pendingDraft, attachments,
      open, close, toggle, toggleExpanded, ask, draft, consumeQuestion, consumeDraft,
      attach, detach, clearAttachments, showChat, showThreads,
    ],
  );
}

export function useAgentPanel(): AgentPanelState {
  const value = useContext(AgentPanelContext);
  if (!value) throw new Error("useAgentPanel must be used inside the app shell");
  return value;
}
