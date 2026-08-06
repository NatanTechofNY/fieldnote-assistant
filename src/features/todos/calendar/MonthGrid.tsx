import { type ReactNode, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import {
  DEFAULT_TIME, type ScheduleChip, dayDropId, dayNumber, fullDayLabel, isSameMonth, localOf, monthGrid,
  todayKey, weekdayShort,
} from "../../../lib/calendar";

/* Cards carry a whole title now, so two fill a cell where three used to. The
   rest are a click away rather than a squeeze. */
const VISIBLE_PER_CELL = 2;

export function MonthGrid({ cursor, timezone, chipsByDay, renderChip, onCreate }: {
  cursor: string;
  timezone: string;
  chipsByDay: Map<string, ScheduleChip[]>;
  renderChip: (chip: ScheduleChip) => ReactNode;
  onCreate: (local: string) => void;
}) {
  const days = monthGrid(cursor);
  const today = todayKey(timezone);
  return <div className="cal-month">
    <div className="cal-weekdays" aria-hidden="true">
      {days.slice(0, 7).map(day => <span key={day}>{weekdayShort(day)}</span>)}
    </div>
    <div className="cal-month-grid">
      {days.map(day => <MonthCell
        key={day}
        day={day}
        chips={chipsByDay.get(day) || []}
        outside={!isSameMonth(day, cursor)}
        today={day === today}
        renderChip={renderChip}
        onCreate={onCreate}
      />)}
    </div>
  </div>;
}

function MonthCell({ day, chips, outside, today, renderChip, onCreate }: {
  day: string;
  chips: ScheduleChip[];
  outside: boolean;
  today: boolean;
  renderChip: (chip: ScheduleChip) => ReactNode;
  onCreate: (local: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dayDropId(day) });
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, chips.length - VISIBLE_PER_CELL);
  const shown = hidden ? chips.slice(0, VISIBLE_PER_CELL) : chips;
  return <div
    ref={setNodeRef}
    className={`cal-day${outside ? " outside" : ""}${today ? " today" : ""}${isOver ? " over" : ""}`}
    aria-label={fullDayLabel(day)}
  >
    <div className="cal-day-head">
      <span className="cal-day-number">{dayNumber(day)}</span>
      <button
        type="button"
        className="cal-day-add"
        aria-label={`Add a task on ${fullDayLabel(day)}`}
        onClick={() => onCreate(localOf(day, DEFAULT_TIME))}
      ><Plus size={12} /></button>
    </div>
    {/* Clicking the empty part of a day captures a task there, the way an empty
        slot does in the week grid. Chips sit on top and answer their own click. */}
    <div
      className="cal-day-body"
      onClick={event => { if (event.target === event.currentTarget) onCreate(localOf(day, DEFAULT_TIME)); }}
    >
      {shown.map(chip => renderChip(chip))}
      {hidden > 0 && <button type="button" className="cal-more" onClick={() => setExpanded(true)}>
        +{hidden} more
      </button>}
      {expanded && chips.length > VISIBLE_PER_CELL && <button
        type="button"
        className="cal-more"
        onClick={() => setExpanded(false)}
      >Show less</button>}
    </div>
  </div>;
}
