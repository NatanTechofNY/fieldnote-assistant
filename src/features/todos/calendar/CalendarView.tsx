import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type DragEndEvent, type DragMoveEvent, type DragStartEvent,
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import { CalendarDays, ChevronLeft, ChevronRight, Columns3, PanelRight, Share2, TriangleAlert } from "lucide-react";
import { api } from "../../../api";
import type { LifeArea, Todo } from "../../../types";
import {
  DEFAULT_TIME, type ScheduleChip as Chip, UNSCHEDULE_DROP_ID, addDays, addMonths, chipsFor, dayOf,
  dropTargetToLocal, fullDayLabel, humanTimeOfDay, localOf, localOfChip, minutesOf, monthGrid, monthLabel,
  snapToSlot, sortChips, timeFromMinutes, timeOf, todayKey, weekDays, weekLabel,
} from "../../../lib/calendar";
import { useTimezone, zonedDateTimeLocalToIso } from "../../../lib/timezone";
import { BOOLEAN, usePreference } from "../../../lib/preference";
import { FlowLinks, type FlowLink } from "./FlowLinks";
import { MonthGrid } from "./MonthGrid";
import { ScheduleChip } from "./ScheduleChip";
import { chipMetaLabel, chipTone } from "./chip-visuals";
import { UnscheduledRail } from "./UnscheduledRail";
import { WeekGrid } from "./WeekGrid";
import { useChipGeometry } from "./use-chip-geometry";

type CalendarMode = "month" | "week";
type Update = { id: string; input: Partial<Todo> };

const CALENDAR_MODES: readonly CalendarMode[] = ["month", "week"];

/** What a chip write turns into, given the kind of time the chip stands for. */
function inputFor(chip: Chip, iso: string | null): Partial<Todo> {
  if (chip.kind === "due") return { due_at: iso };
  if (chip.kind === "reminder") return { reminder_at: iso };
  const extras = [...(chip.todo.extra_reminders || [])];
  if (iso === null) extras.splice(chip.index ?? 0, 1);
  else extras[chip.index ?? 0] = iso;
  return { extra_reminders: extras };
}

export function CalendarView({ todos, lifeAreas, onOpen, onCreate }: {
  todos: Todo[];
  lifeAreas: LifeArea[];
  onOpen: (todo: Todo) => void;
  onCreate: (defaultDueAt: string) => void;
}) {
  const timezone = useTimezone();
  const queryClient = useQueryClient();
  const [mode, setMode] = usePreference<CalendarMode>("calendar:mode", "month", CALENDAR_MODES);
  const [showRail, setShowRail] = usePreference("calendar:rail", true, BOOLEAN);
  const [openAllDay, setOpenAllDay] = usePreference("calendar:all-day-open", false, BOOLEAN);
  const [showLinks, setShowLinks] = usePreference("calendar:links", false, BOOLEAN);
  const [cursor, setCursor] = useState(() => todayKey(timezone));
  const [hoveredChain, setHoveredChain] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ chip: Chip; local: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<Chip | null>(null);
  const [delta, setDelta] = useState<{ x: number; y: number } | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const shiftRef = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));

  const children = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const todo of todos) {
      if (todo.parent_id) map.set(todo.parent_id, [...(map.get(todo.parent_id) || []), todo]);
    }
    return map;
  }, [todos]);
  const titles = useMemo(() => new Map(todos.map(todo => [todo.id, todo.title])), [todos]);
  const areaColors = useMemo(() => new Map(lifeAreas.map(area => [area.id, area.color])), [lifeAreas]);
  /*
   * A chip belongs to a chain when the task it stands for has steps, or is one.
   * The parent's id names the chain, so a step and its parent agree on it
   * without either having to look the other up.
   */
  const chainOf = (todo: Todo): string | null => {
    if (todo.parent_id && titles.has(todo.parent_id)) return todo.parent_id;
    return children.has(todo.id) ? todo.id : null;
  };
  const chainColor = (chainId: string | null): string => {
    const parent = chainId ? todos.find(todo => todo.id === chainId) : undefined;
    return (parent?.life_area_id && areaColors.get(parent.life_area_id)) || "var(--accent)";
  };

  const chips = useMemo(() => sortChips(todos.flatMap(chipsFor)), [todos]);
  const unscheduled = useMemo(
    () => todos.filter(todo => !todo.due_at && todo.status !== "done" && todo.status !== "cancelled"),
    [todos],
  );

  /*
   * While a chip is being moved from the keyboard it is filed where it would
   * land rather than where it still is, so arrow keys read as movement instead
   * of as an invisible cursor. The placement doubles as the signature the
   * connector layer remeasures on, since a chip that changed cells has moved.
   */
  const { byDay, bySlot, allDayByDay, dayByKey, placement } = useMemo(() => {
    const push = (map: Map<string, Chip[]>, key: string, chip: Chip) =>
      map.set(key, [...(map.get(key) || []), chip]);
    const day = new Map<string, Chip[]>();
    const slot = new Map<string, Chip[]>();
    const allDay = new Map<string, Chip[]>();
    const dayOfKey = new Map<string, string>();
    const placed: string[] = [];
    for (const chip of chips) {
      const local = moving?.chip.key === chip.key ? moving.local : localOfChip(chip, timezone);
      if (!local) continue;
      placed.push(`${chip.key}@${local}`);
      dayOfKey.set(chip.key, dayOf(local));
      push(day, dayOf(local), chip);
      if (chip.kind === "due" && timeOf(local) === "00:00") push(allDay, dayOf(local), chip);
      else push(slot, localOf(dayOf(local), snapToSlot(timeOf(local))), chip);
    }
    return { byDay: day, bySlot: slot, allDayByDay: allDay, dayByKey: dayOfKey, placement: placed.join(",") };
  }, [chips, moving, timezone]);

  /*
   * Only ever between two dated cards on the range in front of you. A line out
   * to the rail would say nothing about when the step happens, and one to a day
   * you cannot see has nowhere to land — counting them is also what lets the
   * toggle admit when it has nothing to show rather than looking broken.
   */
  const drawable = useMemo<FlowLink[]>(() => {
    const inView = new Set(mode === "month" ? monthGrid(cursor) : weekDays(cursor));
    const onScreen = (id: string) => {
      const day = dayByKey.get(`${id}:due`);
      return day !== undefined && inView.has(day);
    };
    const pairs: FlowLink[] = [];
    for (const [parentId, steps] of children) {
      if (!onScreen(parentId)) continue;
      const color = chainColor(parentId);
      for (const step of steps) {
        if (!onScreen(step.id)) continue;
        pairs.push({ id: `${parentId}-${step.id}`, parentKey: `${parentId}:due`, childKey: `${step.id}:due`, color });
      }
    }
    return pairs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, dayByKey, mode, cursor, todos, areaColors]);

  const links = useMemo(() => {
    if (showLinks) return drawable;
    return hoveredChain ? drawable.filter(link => link.parentKey === `${hoveredChain}:due`) : [];
  }, [drawable, showLinks, hoveredChain]);

  const { containerRef, register, rects } = useChipGeometry(links.length > 0, `${mode}:${cursor}:${placement}`);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["todos"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };
  const reschedule = useMutation({
    mutationFn: async (updates: Update[]) => {
      for (const update of updates) await api.updateTodo(update.id, update.input);
    },
    // The chip has to land where it was dropped rather than snap back for the
    // length of a round trip, so the cache moves first and is put back if the
    // write is refused.
    onMutate: async (updates: Update[]) => {
      await queryClient.cancelQueries({ queryKey: ["todos"] });
      const previous = queryClient.getQueriesData<Todo[]>({ queryKey: ["todos"] });
      const patches = new Map(updates.map(update => [update.id, update.input]));
      queryClient.setQueriesData<Todo[]>({ queryKey: ["todos"] }, list =>
        list?.map(todo => patches.has(todo.id) ? { ...todo, ...patches.get(todo.id) } : todo));
      return { previous };
    },
    onError: (failure: Error, _updates, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
      setError(failure.message);
    },
    onSettled: invalidate,
  });

  function commit(chip: Chip, local: string | null, withSteps: boolean) {
    setError("");
    if (local === null) {
      reschedule.mutate([{ id: chip.todo.id, input: inputFor(chip, null) }]);
      setAnnouncement(`${chip.todo.title} moved off the calendar.`);
      return;
    }
    const iso = zonedDateTimeLocalToIso(local, timezone);
    /*
     * A reminder in the past would be delivered the moment the worker next
     * looks, so the drop is refused here the way the API refuses the write. A
     * due date carries no such rule: overdue is a real state.
     */
    if (chip.kind !== "due" && new Date(iso).getTime() <= Date.now()) {
      setError("A reminder has to be in the future.");
      return;
    }
    const updates: Update[] = [{ id: chip.todo.id, input: inputFor(chip, iso) }];
    if (withSteps && chip.kind === "due" && chip.at) {
      const shift = new Date(iso).getTime() - new Date(chip.at).getTime();
      for (const step of children.get(chip.todo.id) || []) {
        if (!step.due_at) continue;
        updates.push({ id: step.id, input: { due_at: new Date(new Date(step.due_at).getTime() + shift).toISOString() } });
      }
    }
    reschedule.mutate(updates);
    const steps = updates.length - 1;
    setAnnouncement(`${chip.todo.title} moved to ${fullDayLabel(dayOf(local))} at ${humanTimeOfDay(timeOf(local))}${
      steps ? `, with ${steps} step${steps === 1 ? "" : "s"}` : ""}.`);
  }

  const stepsUnder = (chip: Chip | null) => chip && chip.kind === "due"
    ? (children.get(chip.todo.id) || []).filter(step => step.due_at).length
    : 0;

  /*
   * Shift is read from the window for as long as the drag lasts. dnd-kit only
   * reports the modifiers held when the pointer went down, and the decision to
   * bring the steps along is usually made after the chip is already moving.
   */
  useEffect(() => {
    if (!dragging) return;
    const track = (event: KeyboardEvent) => {
      shiftRef.current = event.shiftKey;
      setShiftHeld(event.shiftKey);
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
    };
  }, [dragging]);

  /*
   * Dragging is a pointer gesture, so moving a chip from the keyboard is its
   * own mode rather than a simulated drag: arrows step through days and slots
   * by date arithmetic, which does not depend on anything having been laid out.
   */
  useEffect(() => {
    if (!moving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const step = (days: number, minutes: number) => {
        event.preventDefault();
        setMoving(current => {
          if (!current) return current;
          const total = minutesOf(timeOf(current.local)) + minutes;
          const local = localOf(
            addDays(dayOf(current.local), days + Math.floor(total / 1440)),
            timeFromMinutes(total),
          );
          setAnnouncement(`${fullDayLabel(dayOf(local))} at ${humanTimeOfDay(timeOf(local))}`);
          return { ...current, local };
        });
      };
      switch (event.key) {
        case "ArrowLeft": return step(-1, 0);
        case "ArrowRight": return step(1, 0);
        case "ArrowUp": return mode === "month" ? step(-7, 0) : step(0, -30);
        case "ArrowDown": return mode === "month" ? step(7, 0) : step(0, 30);
        case "Enter": {
          event.preventDefault();
          commit(moving.chip, moving.local, event.shiftKey);
          setMoving(null);
          return;
        }
        case "Escape": {
          event.preventDefault();
          setMoving(null);
          setAnnouncement("Move cancelled.");
          return;
        }
        default: return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, mode]);

  function startMove(chip: Chip) {
    const local = chip.at ? localOfChip(chip, timezone) : localOf(todayKey(timezone), DEFAULT_TIME);
    setMoving({ chip, local });
    setAnnouncement(`Moving ${chip.todo.title}. Arrow keys to change the time, Enter to confirm, Escape to cancel.`);
  }

  function onDragStart(event: DragStartEvent) {
    const chip = event.active.data.current?.chip as Chip | undefined;
    const held = Boolean((event.activatorEvent as Partial<PointerEvent>)?.shiftKey);
    shiftRef.current = held;
    setShiftHeld(held);
    setDragging(chip ?? null);
    setError("");
  }

  function onDragEnd(event: DragEndEvent) {
    const chip = event.active.data.current?.chip as Chip | undefined;
    const over = event.over ? String(event.over.id) : null;
    const withSteps = shiftRef.current;
    setDragging(null);
    setDelta(null);
    setShiftHeld(false);
    shiftRef.current = false;
    if (!chip || !over) return;
    if (over === UNSCHEDULE_DROP_ID) {
      if (chip.at) commit(chip, null, false);
      return;
    }
    const local = dropTargetToLocal(over, chip.at ? timeOf(localOfChip(chip, timezone)) : DEFAULT_TIME);
    if (local) commit(chip, local, withSteps);
  }

  const renderChip = (chip: Chip, dense = false) => {
    const chainId = chainOf(chip.todo);
    return <ScheduleChip
      key={chip.key}
      chip={chip}
      dense={dense}
      parentTitle={chip.todo.parent_id ? titles.get(chip.todo.parent_id) : null}
      steps={chip.kind === "due" ? (children.get(chip.todo.id) || []).length : 0}
      timezone={timezone}
      chainId={chainId}
      chainColor={chainColor(chainId)}
      linked={Boolean(chainId) && hoveredChain === chainId}
      // Everything outside the chain being read fades back, which is what makes
      // one chain legible on a month with a dozen of them.
      dimmed={Boolean(hoveredChain) && chainId !== hoveredChain}
      moving={moving?.chip.key === chip.key}
      compact={mode === "month"}
      describedBy={chainId ? `cal-chain-${chainId}` : undefined}
      register={register}
      onOpen={onOpen}
      onMoveStart={startMove}
      onChainHover={setHoveredChain}
    />;
  };
  const stepsComing = shiftHeld ? stepsUnder(dragging) : 0;

  return <div className="cal">
    <div className="cal-head">
      <div className="cal-nav">
        <button
          type="button"
          className="button icon ghost"
          aria-label={mode === "month" ? "Previous month" : "Previous week"}
          onClick={() => setCursor(mode === "month" ? addMonths(cursor, -1) : addDays(cursor, -7))}
        ><ChevronLeft size={15} /></button>
        <button type="button" className="button ghost" onClick={() => setCursor(todayKey(timezone))}>Today</button>
        <button
          type="button"
          className="button icon ghost"
          aria-label={mode === "month" ? "Next month" : "Next week"}
          onClick={() => setCursor(mode === "month" ? addMonths(cursor, 1) : addDays(cursor, 7))}
        ><ChevronRight size={15} /></button>
        <h3 className="cal-title">{mode === "month" ? monthLabel(cursor) : weekLabel(cursor)}</h3>
      </div>
      <div className="cal-head-actions">
        {/* Disabled rather than silently inert: with nothing on the range to
            join up, a toggle that does nothing reads as a broken one. */}
        <button
          type="button"
          className={`button ghost${showLinks && drawable.length ? " active" : ""}`}
          aria-pressed={showLinks}
          disabled={!drawable.length}
          title={drawable.length
            ? "Keep the lines between a task and its dated steps drawn"
            : "No task on this range has a step with a date of its own"}
          onClick={() => setShowLinks(!showLinks)}
        ><Share2 size={14} />Links{drawable.length ? ` (${drawable.length})` : ""}</button>
        <button
          type="button"
          className={`button ghost${showRail ? " active" : ""}`}
          aria-pressed={showRail}
          onClick={() => setShowRail(!showRail)}
        ><PanelRight size={14} />No due date</button>
        <div className="view-toggle" role="group" aria-label="Calendar range">
          <button
            type="button"
            className={mode === "month" ? "active" : ""}
            aria-pressed={mode === "month"}
            onClick={() => setMode("month")}
          ><CalendarDays size={13} />Month</button>
          <button
            type="button"
            className={mode === "week" ? "active" : ""}
            aria-pressed={mode === "week"}
            onClick={() => setMode("week")}
          ><Columns3 size={13} />Week</button>
        </div>
      </div>
    </div>
    {moving && <p className="cal-hint">
      Moving <strong>{moving.chip.todo.title}</strong> to {fullDayLabel(dayOf(moving.local))} at {humanTimeOfDay(timeOf(moving.local))}.
      Arrow keys adjust, Enter confirms{stepsUnder(moving.chip) ? " (hold Shift to bring its steps)" : ""}, Escape cancels.
    </p>}
    {error && <div className="inline-error"><TriangleAlert size={14} /><span>{error}</span></div>}
    <p className="visually-hidden" role="status">{announcement}</p>
    {/* Named for the screen readers that cannot see the lines. */}
    {[...children].map(([parentId, steps]) => <span key={parentId} id={`cal-chain-${parentId}`} className="visually-hidden">
      Part of {titles.get(parentId)}, which has {steps.length} step{steps.length === 1 ? "" : "s"}.
    </span>)}
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={(event: DragMoveEvent) => setDelta(event.delta)} onDragEnd={onDragEnd} onDragCancel={() => { setDragging(null); setDelta(null); }}>
      {/* Grid and rail share one box so a chain can be drawn across both: a
          task is often dated while the steps under it are not. */}
      <div className={`cal-body${showRail ? "" : " no-rail"}`} ref={containerRef}>
        {mode === "month"
          ? <MonthGrid cursor={cursor} timezone={timezone} chipsByDay={byDay} renderChip={renderChip} onCreate={onCreate} />
          : <WeekGrid
            cursor={cursor}
            timezone={timezone}
            chipsBySlot={bySlot}
            allDayByDay={allDayByDay}
            openAllDay={openAllDay}
            onToggleAllDay={() => setOpenAllDay(!openAllDay)}
            renderChip={renderChip}
            onCreate={onCreate}
          />}
        {showRail && <UnscheduledRail todos={unscheduled} parentTitles={titles} renderChip={renderChip} />}
        <FlowLinks links={links} rects={rects} activeKey={dragging?.key ?? null} delta={delta} />
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <div className="cal-chip drag-preview" style={{ "--chip-tone": chipTone(dragging) } as CSSProperties}>
          <span className="cal-chip-title">{dragging.todo.title}</span>
          <span className="cal-chip-meta">
            <i className="cal-chip-dot" aria-hidden="true" />
            <span className="cal-chip-when">{chipMetaLabel(dragging, timezone)}</span>
            {stepsComing > 0 && <span className="cal-chip-steps">+{stepsComing} steps</span>}
          </span>
        </div>}
      </DragOverlay>
    </DndContext>
  </div>;
}
