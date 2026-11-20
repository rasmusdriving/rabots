// Dragging in the Week grid (docs/build/step-ahead-redesign.md): an open item or a "your time" slot
// goes to another day and time, snapped to 15 minutes; a plain item dropped on a day's top strip
// gets that day with no time. A pointer drag as T3 Code's sidebar does it: it starts only once the
// pointer has travelled a few pixels, so a plain click still opens the sheet. Mouse and pen only;
// on a touch screen the sheet moves things. Escape lets go. Nothing is measured until a drag starts.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { AheadItemRow, AheadRow } from "../../../../shared/protocol";
import { MIN_BOT, minutesOf, snapTime, type GridRange } from "./grid-layout";

/** How far the pointer travels before a press becomes a drag. */
const START_PX = 5;

export interface DropTarget {
  day: string;
  /** Null: the day with no time (the strip on top). */
  time: string | null;
}

export interface GridDragState {
  /** The dragged row and the day it stands on. */
  row: AheadItemRow;
  minutes: number;
  target?: DropTarget;
}

interface Press {
  row: AheadItemRow;
  kind: "any" | "timed";
  x: number;
  y: number;
  /** From the pointer up to the top of the block, so the block does not jump under the pointer. */
  grab: number;
  minutes: number;
  active: boolean;
  /** The outline has been drawn at least once. */
  shown: boolean;
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

export function useGridDrag(root: RefObject<HTMLElement | null>, range: GridRange, enabled: boolean, onDrop: (row: AheadItemRow, to: DropTarget) => void) {
  const [drag, setDrag] = useState<GridDragState>();
  const press = useRef<Press | undefined>(undefined);
  const target = useRef<DropTarget | undefined>(undefined);
  const swallowed = useRef(false);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const now = useRef(range);
  now.current = range;

  const find = useCallback((p: Press, x: number, y: number): DropTarget | undefined => {
    const el = root.current;
    if (!el) return undefined;
    // In a low window the hours scroll inside their frame: only what shows of a column takes a drop.
    const frame = el.querySelector<HTMLElement>("[data-ahead-grid-body]")?.getBoundingClientRect();
    for (const col of el.querySelectorAll<HTMLElement>("[data-ahead-week-day]")) {
      const r = col.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top - 4 || y > r.bottom + 4 || r.height <= 0) continue;
      if (frame && (y < frame.top - 4 || y > frame.bottom + 4)) continue;
      return { day: col.dataset.aheadWeekDay!, time: snapTime((y - p.grab - r.top) / r.height, now.current, p.minutes) };
    }
    if (p.kind !== "any") return undefined;
    for (const cell of el.querySelectorAll<HTMLElement>("[data-ahead-strip-day]")) {
      if (inside(cell.getBoundingClientRect(), x, y)) return { day: cell.dataset.aheadStripDay!, time: null };
    }
    return undefined;
  }, [root]);

  useEffect(() => {
    if (!enabled) return;
    const end = () => {
      press.current = undefined;
      target.current = undefined;
      setDrag(undefined);
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.active) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < START_PX) return;
        p.active = true;
        swallowed.current = true;
      }
      e.preventDefault();
      const to = find(p, e.clientX, e.clientY);
      const was = target.current;
      if (p.shown && was?.day === to?.day && was?.time === to?.time) return;
      p.shown = true;
      target.current = to;
      setDrag({ row: p.row, minutes: p.minutes, target: to });
    };
    // The click that ends a drag has reached its block (or landed between blocks) by the time it
    // gets here, so from here on a click opens again.
    const calm = () => {
      swallowed.current = false;
    };
    const up = () => {
      const p = press.current;
      const to = target.current;
      end();
      // The click that ends a drag comes right after this, when it comes at all (not when the
      // pointer was let go outside the window). After it the next click is a plain click again.
      setTimeout(calm, 0);
      if (!p?.active || !to) return;
      const item = p.row.item;
      if (to.day === item.day && (to.time ?? "") === (item.time ?? "")) return;
      drop.current(p.row, to);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && press.current?.active) {
        e.preventDefault();
        e.stopPropagation();
        end();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("click", calm);
    return () => {
      window.removeEventListener("click", calm);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
    };
  }, [enabled, find]);

  const start = useCallback((e: ReactPointerEvent, row: AheadRow, kind: "any" | "timed") => {
    swallowed.current = false;
    if (!enabled || row.source !== "item" || e.button !== 0 || e.pointerType === "touch") return;
    const block = (e.currentTarget as HTMLElement).closest<HTMLElement>(".pb-ahead-blk");
    const timed = !!row.time && !block?.hasAttribute("data-line");
    const minutes = row.item.kind === "your-time" ? (row.item.minutes ?? 30) : MIN_BOT;
    press.current = { row, kind, x: e.clientX, y: e.clientY, grab: timed && block ? e.clientY - block.getBoundingClientRect().top : 8, minutes, active: false, shown: false };
  }, [enabled]);

  const swallow = useCallback(() => {
    const was = swallowed.current;
    swallowed.current = false;
    return was;
  }, []);

  return { drag, start, swallow };
}

/** Where the outline of a drag stands in its column, as fractions of the grid. */
export function ghostPlace(time: string, minutes: number, range: GridRange): { top: number; height: number } {
  const span = range.end - range.start;
  return { top: (minutesOf(time) - range.start) / span, height: Math.max(minutes, MIN_BOT) / span };
}
