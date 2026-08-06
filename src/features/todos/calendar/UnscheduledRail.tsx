import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { CalendarOff, CornerDownRight } from "lucide-react";
import type { Todo } from "../../../types";
import { UNSCHEDULE_DROP_ID, type ScheduleChip, unscheduledChip } from "../../../lib/calendar";
import { BOOLEAN, usePreference } from "../../../lib/preference";

/**
 * Everything with no due date on it, kept beside the grid so scheduling is a
 * drag rather than a form. It is a drop target too: pulling a card back out of
 * the calendar is how a date is taken off.
 */
export function UnscheduledRail({ todos, parentTitles, renderChip }: {
  todos: Todo[];
  parentTitles: Map<string, string>;
  renderChip: (chip: ScheduleChip) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULE_DROP_ID });
  /*
   * Steps outnumber the tasks they belong to and are usually undated on
   * purpose, being the checklist under something already scheduled. Folding
   * them away leaves the rail listing only work that genuinely has no home.
   */
  const [showSteps, setShowSteps] = usePreference("calendar:rail-steps", true, BOOLEAN);
  const loose = todos.filter(todo => !todo.parent_id);
  const steps = new Map<string, Todo[]>();
  for (const todo of todos) {
    if (todo.parent_id) steps.set(todo.parent_id, [...(steps.get(todo.parent_id) || []), todo]);
  }
  const stepCount = todos.length - loose.length;
  return <aside ref={setNodeRef} className={`cal-rail${isOver ? " over" : ""}`} aria-label="Unscheduled tasks">
    {/* Named for the field it is actually about. "No date" left it open whether
        a deadline or a reminder was the thing missing. */}
    <div className="cal-rail-head">
      <span className="eyebrow">No due date</span>
      <span className="badge">{showSteps ? todos.length : loose.length}</span>
    </div>
    {stepCount > 0 && <button
      type="button"
      className="cal-rail-steps-toggle"
      aria-pressed={showSteps}
      onClick={() => setShowSteps(!showSteps)}
    >
      <CornerDownRight size={12} aria-hidden="true" />
      {showSteps ? `Hide ${stepCount} undated step${stepCount === 1 ? "" : "s"}` : `Show ${stepCount} undated step${stepCount === 1 ? "" : "s"}`}
    </button>}
    <div className="cal-rail-body" data-clip>
      {loose.map(todo => renderChip(unscheduledChip(todo)))}
      {/* A step with no date still belongs to something, so it is filed under
          the task it came from rather than loose among unrelated work. */}
      {showSteps && [...steps].map(([parentId, children]) => <div key={parentId} className="cal-rail-group">
        <span className="cal-rail-parent">Steps of {parentTitles.get(parentId) || "another task"}</span>
        {children.map(todo => renderChip(unscheduledChip(todo)))}
      </div>)}
      {!loose.length && (!showSteps || !stepCount) && <p className="cal-rail-empty">
        <CalendarOff size={14} aria-hidden="true" />
        {stepCount ? "Only steps are undated." : "Everything has a due date. Drag a card here to take one off."}
      </p>}
    </div>
  </aside>;
}
