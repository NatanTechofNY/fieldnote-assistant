import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ChipRect { x: number; y: number; width: number; height: number }

function same(a: Map<string, ChipRect>, b: Map<string, ChipRect>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, rect] of a) {
    const other = b.get(key);
    if (!other) return false;
    if (other.x !== rect.x || other.y !== rect.y || other.width !== rect.width || other.height !== rect.height) {
      return false;
    }
  }
  return true;
}

/**
 * Where each chip sits inside the scrolling grid, so the connector overlay can
 * draw between two of them.
 *
 * The positions are measured rather than derived from the date each chip holds:
 * a chip's place depends on how its cell wrapped, how far the week grid is
 * scrolled and how wide the window is, none of which the calendar model knows.
 * The cost is that a layout with no layout — jsdom, or a hidden view — reports
 * zeroes, so a rect with no area is dropped and the chain it belonged to simply
 * goes undrawn.
 */
export function useChipGeometry(active: boolean, signature: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [rects, setRects] = useState<Map<string, ChipRect>>(new Map());

  const register = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    const host = containerRef.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    const next = new Map<string, ChipRect>();
    for (const [key, node] of nodes.current) {
      if (!node.isConnected) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      // A chip scrolled out of its own pane still reports a position, and a
      // line drawn to it would cross whatever is covering it.
      const clip = node.closest("[data-clip]")?.getBoundingClientRect();
      if (clip && (rect.bottom <= clip.top || rect.top >= clip.bottom
        || rect.right <= clip.left || rect.left >= clip.right)) continue;
      next.set(key, {
        x: rect.left - base.left + host.scrollLeft,
        y: rect.top - base.top + host.scrollTop,
        width: rect.width,
        height: rect.height,
      });
    }
    setRects(current => same(current, next) ? current : next);
  }, []);

  // Positions left over from the last time links were drawn are harmless: with
  // nothing to connect, nothing reads them, and the next measure replaces them.
  useLayoutEffect(() => {
    if (active) measure();
  }, [active, signature, measure]);

  useEffect(() => {
    if (!active) return;
    const host = containerRef.current;
    const observer = new ResizeObserver(() => measure());
    if (host) observer.observe(host);
    // Captured, because the week grid's scroller is a descendant and a scroll
    // event does not bubble up to the box the positions are measured against.
    host?.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      host?.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [active, measure]);

  return { containerRef, register, rects, measure };
}
