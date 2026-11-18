// The handle on the "Needs you" rail's left edge (docs/build/step-rail-resize.md). Dragged left it
// makes the rail wider, right narrower; a double-click puts it back to the default. The arrow keys,
// Home and End move it too, as the artifact panel's divider. Laptop and wider only.
// After T3 Code's SidebarRail (apps/web/src/components/ui/sidebar.tsx) and its drag
// (apps/web/src/hooks/useResizeDrag.ts): pointer capture, the width written once a frame, and a
// move under 2 px is no drag, so a double-click never nudges the width.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { RAIL_STEP, setRailWidth, type RailWidth } from "../lib/rail-width";

/** A move shorter than this is a click, not a drag. */
const DRAG_PX = 2;

export function RailHandle({ rail }: { rail: RailWidth }) {
  const drag = useRef<{ x: number; px: number; moved: boolean; frame: number; to: number } | null>(null);
  // Gone in the middle of a drag (the artifact panel opened): nothing stays marked as dragging.
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.frame) cancelAnimationFrame(d.frame);
      if (d?.moved) delete document.documentElement.dataset.dragging;
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, px: rail.px, moved: false, frame: 0, to: rail.px };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = d.x - e.clientX;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_PX) return;
      d.moved = true;
      // Frames and text would take the pointer as it passes over them.
      document.documentElement.dataset.dragging = "rail";
    }
    d.to = Math.min(rail.max, Math.max(rail.min, d.px + dx));
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      setRailWidth(d.to);
    });
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.frame) {
      cancelAnimationFrame(d.frame);
      setRailWidth(d.to);
    }
    if (d.moved) delete document.documentElement.dataset.dragging;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const now = rail.px;
    const to = e.key === "ArrowLeft" ? now + RAIL_STEP : e.key === "ArrowRight" ? now - RAIL_STEP : e.key === "Home" ? rail.max : e.key === "End" ? rail.min : null;
    if (to === null) return;
    e.preventDefault();
    setRailWidth(Math.min(rail.max, Math.max(rail.min, to)));
  };

  return (
    <div
      className="pb-rail-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of Needs you. Left arrow makes it wider, right arrow narrower, double-click resets"
      aria-valuemin={rail.min}
      aria-valuemax={rail.max}
      aria-valuenow={rail.px}
      tabIndex={0}
      title="Drag to change the width. Double-click for the default"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setRailWidth(null)}
      onKeyDown={onKeyDown}
    >
      <span className="pb-rail-grip" aria-hidden="true" />
    </div>
  );
}
