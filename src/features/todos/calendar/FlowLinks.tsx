import type { ChipRect } from "./use-chip-geometry";

export interface FlowLink {
  id: string;
  parentKey: string;
  childKey: string;
  color: string;
}

const BEND = 22;
const HEAD = 4;

function shift(rect: ChipRect, delta: { x: number; y: number } | null): ChipRect {
  return delta ? { ...rect, x: rect.x + delta.x, y: rect.y + delta.y } : rect;
}

/**
 * A curve between two chips, leaving and entering on whichever axis separates
 * them further. A step three rows down wants a line off the bottom edge; a step
 * later the same afternoon wants one off the side. Both end axis-aligned, so
 * the arrowhead only ever points one of four ways.
 */
function connector(from: ChipRect, to: ChipRect) {
  const fromMid = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toMid = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toMid.x - fromMid.x;
  const dy = toMid.y - fromMid.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const down = dy >= 0;
    const start = { x: fromMid.x, y: down ? from.y + from.height : from.y };
    const end = { x: toMid.x, y: down ? to.y : to.y + to.height };
    const bend = Math.max(BEND, Math.abs(end.y - start.y) / 2) * (down ? 1 : -1);
    return {
      path: `M${start.x},${start.y} C${start.x},${start.y + bend} ${end.x},${end.y - bend} ${end.x},${end.y}`,
      head: down
        ? `M${end.x},${end.y} L${end.x - HEAD},${end.y - HEAD * 1.6} L${end.x + HEAD},${end.y - HEAD * 1.6} Z`
        : `M${end.x},${end.y} L${end.x - HEAD},${end.y + HEAD * 1.6} L${end.x + HEAD},${end.y + HEAD * 1.6} Z`,
    };
  }
  const right = dx >= 0;
  const start = { x: right ? from.x + from.width : from.x, y: fromMid.y };
  const end = { x: right ? to.x : to.x + to.width, y: toMid.y };
  const bend = Math.max(BEND, Math.abs(end.x - start.x) / 2) * (right ? 1 : -1);
  return {
    path: `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`,
    head: right
      ? `M${end.x},${end.y} L${end.x - HEAD * 1.6},${end.y - HEAD} L${end.x - HEAD * 1.6},${end.y + HEAD} Z`
      : `M${end.x},${end.y} L${end.x + HEAD * 1.6},${end.y - HEAD} L${end.x + HEAD * 1.6},${end.y + HEAD} Z`,
  };
}

/**
 * The lines tying a task to its steps. Purely decorative — the same
 * relationship is in each chip's label — so the layer takes no pointer events
 * and is hidden from assistive technology.
 */
export function FlowLinks({ links, rects, activeKey, delta }: {
  links: FlowLink[];
  rects: Map<string, ChipRect>;
  activeKey: string | null;
  delta: { x: number; y: number } | null;
}) {
  const drawn = links.flatMap(link => {
    const from = rects.get(link.parentKey);
    const to = rects.get(link.childKey);
    if (!from || !to) return [];
    const shape = connector(
      shift(from, link.parentKey === activeKey ? delta : null),
      shift(to, link.childKey === activeKey ? delta : null),
    );
    return [{ ...link, ...shape }];
  });
  if (!drawn.length) return null;
  return <svg className="cal-links" aria-hidden="true" focusable="false">
    {drawn.map(link => <g key={link.id} style={{ color: link.color }}>
      <path d={link.path} className="cal-link-path" />
      <path d={link.head} className="cal-link-head" />
    </g>)}
  </svg>;
}
