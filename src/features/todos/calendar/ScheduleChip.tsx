import type { CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { BellRing, CornerDownRight, GitBranch } from "lucide-react";
import type { Todo } from "../../../types";
import type { ScheduleChip as Chip } from "../../../lib/calendar";
import { friendlyDate, friendlyDueDate } from "../../../lib/timezone";
import { chipMetaLabel, chipTone } from "./chip-visuals";

const kindWord: Record<Chip["kind"], string> = {
  due: "Due",
  reminder: "Reminder",
  extra: "Extra reminder",
};

export function ScheduleChip({
  chip, parentTitle, steps, timezone, chainId, chainColor, linked, dimmed, moving, compact, dense, describedBy,
  register, onOpen, onMoveStart, onChainHover,
}: {
  chip: Chip;
  parentTitle?: string | null;
  steps: number;
  timezone: string;
  chainId: string | null;
  chainColor: string;
  linked: boolean;
  dimmed: boolean;
  moving: boolean;
  compact?: boolean;
  dense?: boolean;
  describedBy?: string;
  register: (key: string, node: HTMLElement | null) => void;
  onOpen: (todo: Todo) => void;
  onMoveStart: (chip: Chip) => void;
  onChainHover: (chainId: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: chip.key, data: { chip } });
  const isSubtask = Boolean(parentTitle);
  const when = chip.at
    ? (chip.kind === "due" ? friendlyDueDate(chip.at, timezone) : friendlyDate(chip.at, timezone))
    : "no date yet";
  const label = [
    kindWord[chip.kind],
    parentTitle ? `${chip.todo.title}, step of ${parentTitle}` : chip.todo.title,
    when,
  ].join(" · ");
  return <button
    type="button"
    ref={node => { setNodeRef(node); register(chip.key, node); }}
    {...attributes}
    {...listeners}
    aria-describedby={[attributes["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined}
    aria-label={label}
    className={`cal-chip kind-${chip.kind}${compact ? " compact" : ""}${dense ? " dense" : ""}`
      + `${isSubtask ? " subtask" : ""}${isDragging ? " dragging" : ""}${linked ? " linked" : ""}`
      + `${dimmed ? " dimmed" : ""}${moving ? " moving" : ""}`}
    style={{ "--chip-tone": chipTone(chip), "--chain-tone": chainColor } as CSSProperties}
    onClick={() => onOpen(chip.todo)}
    onPointerEnter={() => onChainHover(chainId)}
    onPointerLeave={() => onChainHover(null)}
    onFocus={() => onChainHover(chainId)}
    onBlur={() => onChainHover(null)}
    onKeyDown={event => {
      if (event.key !== "m" && event.key !== "M") return;
      event.preventDefault();
      onMoveStart(chip);
    }}
  >
    {/* The title runs first and in full: two tasks that share an opening are
        told apart by their ends, and a clipped one has to be opened to read. */}
    <span className="cal-chip-title">
      {isSubtask && <CornerDownRight className="cal-chip-sub" size={12} aria-hidden="true" />}
      {chip.todo.title}
    </span>
    {/* Folded down to the title alone: the accessible label still carries the
        date, so nothing is lost by leaving the second line out. */}
    {!dense && <span className="cal-chip-meta">
      {chip.kind === "due"
        ? <i className="cal-chip-dot" aria-hidden="true" />
        : <BellRing className="cal-chip-glyph" size={11} aria-hidden="true" />}
      <span className="cal-chip-when">{chipMetaLabel(chip, timezone)}</span>
      {/* A count on the task itself is what says a chain exists before anything
          is hovered; the lines only answer where it goes. */}
      {steps > 0 && <span className="cal-chip-chain" aria-hidden="true">
        <GitBranch size={10} />{steps}
      </span>}
    </span>}
  </button>;
}
