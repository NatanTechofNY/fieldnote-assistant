import type { CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { BellRing, CornerDownRight, GitBranch, Repeat } from "lucide-react";
import type { Todo } from "../../../types";
import type { ScheduleChip as Chip } from "../../../lib/calendar";
import { friendlyDate, friendlyDueDate } from "../../../lib/timezone";
import type { AgentAttachment } from "../../../lib/agent-attachments";
import { type OpenOptions, openOptionsOf } from "../../../lib/task-open-mode";
import { AttachButton, EditButton } from "../../../components/ui";
import { chipMetaLabel, chipTone } from "./chip-visuals";

const kindWord: Record<Chip["kind"], string> = {
  due: "Due",
  reminder: "Reminder",
  extra: "Extra reminder",
};

export function ScheduleChip({
  chip, attachment, parentTitle, steps, timezone, chainId, chainColor, linked, dimmed, moving, compact, dense, describedBy,
  register, onOpen, onMoveStart, onChainHover,
}: {
  chip: Chip;
  /** The task as the agent is shown it, for the attach button. */
  attachment: AgentAttachment;
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
  onOpen: (todo: Todo, options?: OpenOptions) => void;
  onMoveStart: (chip: Chip) => void;
  onChainHover: (chainId: string | null) => void;
}) {
  // A repeating task's time comes from its rule, so dragging it to another slot
  // would be undone by the server; the rule is edited from the task itself.
  const repeats = Boolean(chip.todo.recurrence);
  const draggable = useDraggable({ id: chip.key, data: { chip }, disabled: repeats });
  const { setNodeRef, isDragging } = draggable;
  // A disabled draggable still hands back aria-disabled and "press space to
  // pick up" instructions. The chip stays a live button that opens the task, so
  // a repeating one is not announced as disabled, or as something to pick up.
  const attributes = repeats ? {} : draggable.attributes;
  const listeners = repeats ? {} : draggable.listeners;
  const dragDescribedBy = repeats ? undefined : draggable.attributes["aria-describedby"];
  const isSubtask = Boolean(parentTitle);
  const when = chip.at
    ? (chip.kind === "due" ? friendlyDueDate(chip.at, timezone) : friendlyDate(chip.at, timezone))
    : "no date yet";
  const label = [
    kindWord[chip.kind],
    parentTitle ? `${chip.todo.title}, step of ${parentTitle}` : chip.todo.title,
    when,
    ...(repeats ? ["repeats"] : []),
  ].join(" · ");
  /*
   * The chip is one button that drags and opens, and a button cannot hold
   * buttons, so the attach and edit controls are its siblings in a wrapper and
   * float over its corner. The chip stays the node that is dragged, measured,
   * and named, so none of that cares the wrapper is there.
   */
  return <div className={`cal-chip-wrap${isSubtask ? " subtask" : ""}`}>
  <button
    type="button"
    ref={node => { setNodeRef(node); register(chip.key, node); }}
    {...attributes}
    {...listeners}
    aria-describedby={[dragDescribedBy, describedBy].filter(Boolean).join(" ") || undefined}
    aria-label={label}
    className={`cal-chip kind-${chip.kind}${compact ? " compact" : ""}${dense ? " dense" : ""}`
      + `${isSubtask ? " subtask" : ""}${isDragging ? " dragging" : ""}${linked ? " linked" : ""}`
      + `${dimmed ? " dimmed" : ""}${moving ? " moving" : ""}`}
    style={{ "--chip-tone": chipTone(chip), "--chain-tone": chainColor } as CSSProperties}
    onClick={event => onOpen(chip.todo, openOptionsOf(event))}
    onPointerEnter={() => onChainHover(chainId)}
    onPointerLeave={() => onChainHover(null)}
    onFocus={() => onChainHover(chainId)}
    onBlur={() => onChainHover(null)}
    onKeyDown={event => {
      if (repeats || (event.key !== "m" && event.key !== "M")) return;
      event.preventDefault();
      onMoveStart(chip);
    }}
  >
    {/* The title runs first and in full: two tasks that share an opening are
        told apart by their ends, and a clipped one has to be opened to read. */}
    <span className="cal-chip-title">
      {isSubtask && <CornerDownRight className="cal-chip-sub" size={12} aria-hidden="true" />}
      {repeats && <Repeat className="cal-chip-sub" size={11} aria-hidden="true" />}
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
  </button>
  <span className="cal-chip-actions">
    <AttachButton item={attachment} size={11}/>
    <EditButton todo={chip.todo} onOpen={onOpen} size={11}/>
  </span>
  </div>;
}
