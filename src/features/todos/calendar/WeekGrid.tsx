import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { ChevronRight, Plus } from "lucide-react";
import {
  DEFAULT_TIME, SLOT_MINUTES, type ScheduleChip, dayDropId, dayNumber, fullDayLabel, hourLabel, localOf,
  minutesOf, slotDropId, slotTimes, snapToSlot, todayKey, weekDays, weekdayShort,
} from "../../../lib/calendar";
import { zonedParts } from "../../../lib/timezone";

/** The first hour worth looking at, so a week does not open on the small hours. */
const OPENING_TIME = "07:00";

/** How many undated cards a day shows before the row offers to open. */
const DENSE_PER_DAY = 2;

/** Keeps the current-time line from going stale while the tab sits open. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
}

export function WeekGrid({
  cursor, timezone, chipsBySlot, allDayByDay, openAllDay, onToggleAllDay, renderChip, onCreate,
}: {
  cursor: string;
  timezone: string;
  chipsBySlot: Map<string, ScheduleChip[]>;
  allDayByDay: Map<string, ScheduleChip[]>;
  openAllDay: boolean;
  onToggleAllDay: () => void;
  renderChip: (chip: ScheduleChip, dense?: boolean) => ReactNode;
  onCreate: (local: string) => void;
}) {
  useMinuteTick();
  const days = weekDays(cursor);
  const today = todayKey(timezone);
  const times = slotTimes();
  const scroller = useRef<HTMLDivElement | null>(null);
  const opening = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scroller.current && opening.current) scroller.current.scrollTop = opening.current.offsetTop;
  }, []);
  const now = zonedParts(new Date(), timezone);
  const nowSlot = `${now.year}-${now.month}-${now.day}T${snapToSlot(`${now.hour}:${now.minute}`)}`;
  const nowOffset = (minutesOf(`${now.hour}:${now.minute}`) % SLOT_MINUTES) / SLOT_MINUTES;
  return <div className="cal-week">
    <div className="cal-week-head">
      <span className="cal-gutter" />
      {days.map(day => <div key={day} className={`cal-week-day${day === today ? " today" : ""}`}>
        <span className="cal-week-weekday">{weekdayShort(day)}</span>
        <span className="cal-week-number">{dayNumber(day)}</span>
        <button
          type="button"
          className="cal-day-add"
          aria-label={`Add a task on ${fullDayLabel(day)}`}
          onClick={() => onCreate(localOf(day, DEFAULT_TIME))}
        ><Plus size={12} /></button>
      </div>)}
    </div>
    {/* "All day" borrowed a meaning from meeting calendars it does not have
        here: these are due that day, with no hour ever chosen. Undated work
        piles up in this row, so it stays a band of one-line chips until asked
        to open rather than pushing the hours off the screen. */}
    <div className={`cal-allday${openAllDay ? "" : " dense"}`}>
      <button
        type="button"
        className="cal-gutter cal-allday-toggle"
        aria-expanded={openAllDay}
        aria-label={`${openAllDay ? "Collapse" : "Expand"} tasks due at any time`}
        onClick={onToggleAllDay}
      >
        <ChevronRight size={12} className="cal-allday-caret" aria-hidden="true" />
        <span>Any time</span>
      </button>
      {days.map(day => <AllDayCell
        key={day}
        day={day}
        chips={allDayByDay.get(day) || []}
        open={openAllDay}
        onExpand={onToggleAllDay}
        renderChip={renderChip}
      />)}
    </div>
    {/* Flagged as a clip, so a chip scrolled out of the week is not connected
        to across the header it is hiding behind. */}
    <div className="cal-week-scroll" data-clip ref={scroller}>
      <div className="cal-week-canvas">
        {times.map((time, index) => <Fragment key={time}>
          {index % 2 === 0 && <div className="cal-hour" ref={time === OPENING_TIME ? opening : undefined}>
            <span>{hourLabel(time)}</span>
          </div>}
          {days.map(day => <WeekSlot
            key={`${day}T${time}`}
            day={day}
            time={time}
            chips={chipsBySlot.get(localOf(day, time)) || []}
            now={localOf(day, time) === nowSlot ? nowOffset : null}
            renderChip={renderChip}
            onCreate={onCreate}
          />)}
        </Fragment>)}
      </div>
    </div>
  </div>;
}

function AllDayCell({ day, chips, open, onExpand, renderChip }: {
  day: string;
  chips: ScheduleChip[];
  open: boolean;
  onExpand: () => void;
  renderChip: (chip: ScheduleChip, dense?: boolean) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dayDropId(day) });
  const hidden = open ? 0 : Math.max(0, chips.length - DENSE_PER_DAY);
  const shown = hidden ? chips.slice(0, DENSE_PER_DAY) : chips;
  return <div ref={setNodeRef} className={`cal-allday-cell${isOver ? " over" : ""}`} aria-label={`Any time, ${fullDayLabel(day)}`}>
    {shown.map(chip => renderChip(chip, !open))}
    {hidden > 0 && <button type="button" className="cal-more" onClick={onExpand}>+{hidden} more</button>}
  </div>;
}

function WeekSlot({ day, time, chips, now, renderChip, onCreate }: {
  day: string;
  time: string;
  chips: ScheduleChip[];
  now: number | null;
  renderChip: (chip: ScheduleChip) => ReactNode;
  onCreate: (local: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: slotDropId(day, time) });
  const onHour = time.endsWith(":00");
  return <div
    ref={setNodeRef}
    className={`cal-slot${onHour ? " on-hour" : ""}${isOver ? " over" : ""}`}
    data-time={time}
    onClick={event => { if (event.target === event.currentTarget) onCreate(localOf(day, time)); }}
  >
    {now !== null && <span className="cal-now" style={{ top: `${now * 100}%` }} aria-hidden="true" />}
    {chips.map(chip => renderChip(chip))}
  </div>;
}
