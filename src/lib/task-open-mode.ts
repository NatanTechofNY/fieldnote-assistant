import { createContext, useContext } from "react";
import { usePreference } from "./preference";

/**
 * What pressing a task, or an empty day, does. `chat` hands the task to the
 * agent (or starts a "new task" sentence for it) so the next thing typed is the
 * change; `editor` opens the form. A browser-local habit like the theme, so it
 * lives with the other preferences rather than on the server.
 */
export type TaskOpenMode = "chat" | "editor";

export const TASK_OPEN_MODES: readonly TaskOpenMode[] = ["chat", "editor"];

export const TASK_OPEN_KEY = "todos:open-in";

export function useTaskOpenMode(): [TaskOpenMode, (next: TaskOpenMode) => void] {
  return usePreference<TaskOpenMode>(TASK_OPEN_KEY, "chat", TASK_OPEN_MODES);
}

/**
 * The mode the page is working in, for the controls deep in a row that only
 * make sense in one of them (the pencil is pointless when a click already
 * opens the editor). Outside the page it reads as `editor`, so nothing extra
 * is drawn.
 */
export const TaskOpenModeContext = createContext<TaskOpenMode>("editor");

export const useTaskOpenModeValue = () => useContext(TaskOpenModeContext);

/** How a click asks to open a task: `manual` forces the editor whatever the setting. */
export type OpenOptions = { manual?: boolean };

/** The option a pointer event implies: holding Alt/Option is the way round the setting. */
export const openOptionsOf = (event: { altKey: boolean }): OpenOptions => ({ manual: event.altKey });
