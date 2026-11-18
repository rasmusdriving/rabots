// The width of the "Needs you" rail on the laptop (docs/build/step-rail-resize.md). The person drags
// the handle on its left edge to make it wider or narrower; a double-click puts it back to the
// default, which follows the window's width as app.css sets it. The chosen width is remembered in
// this browser only, in pixels: what suits a large monitor is too wide on the laptop. It is read
// when this file loads, before the window is first drawn, so a reload shows it with no jump.
// After T3 Code's thread sidebar (apps/web/src/components/threadSidebarWidth.ts, AppSidebarLayout.tsx).
import { useSyncExternalStore } from "react";
import { notePlace } from "./place";

const KEY = "pobots.railWidth";

/** Never narrower than this. */
export const RAIL_MIN = 280;
/** Never wider than this, however wide the window. */
export const RAIL_CAP = 720;
/** The chat keeps at least this much width beside a wider rail. */
export const CHAT_MIN = 480;
/** One press of an arrow key. */
export const RAIL_STEP = 16;

/** The roster's width at a window width, as app.css sets it. */
export const rosterWidth = (w: number) => (w > 1180 ? 264 : w > 900 ? 232 : 84);
/** The rail's default width at a window width, as app.css sets it. */
export const railDefault = (w: number) => (w > 1180 ? 344 : w > 900 ? 296 : 280);

export interface RailBounds {
  /** The default at this window width. */
  def: number;
  min: number;
  max: number;
  /** False when the window is too narrow for any choice: the rail keeps its default. */
  can: boolean;
}

/** How wide the rail may be at a window width. */
export function railBounds(w: number): RailBounds {
  const def = railDefault(w);
  const room = Math.min(RAIL_CAP, w - rosterWidth(w) - CHAT_MIN);
  const can = room > RAIL_MIN;
  // The default stays within reach, also where the chat's minimum would leave less.
  return { def, min: RAIL_MIN, max: can ? Math.max(def, room) : def, can };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The width shown: the chosen one within what the window allows, else the default. */
export function railShown(stored: number | null, w: number): number {
  const b = railBounds(w);
  return stored === null || !b.can ? b.def : clamp(stored, b.min, b.max);
}

function atStart(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    const n = Number(raw);
    return raw !== null && raw !== "" && Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_CAP ? Math.round(n) : null;
  } catch {
    return null;
  }
}

let stored: number | null = atStart();
const listeners = new Set<() => void>();

/** The width the person chose, or null for the default. */
export const railStored = (): number | null => stored;

/** Choose a width (null: back to the default). The chat keeps its place. */
export function setRailWidth(px: number | null): void {
  const next = px === null ? null : Math.round(clamp(px, RAIL_MIN, RAIL_CAP));
  if (next === stored) return;
  notePlace();
  stored = next;
  try {
    if (next === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {
    // Remembering the width is a convenience only.
  }
  for (const l of listeners) l();
}

function subscribeStored(change: () => void): () => void {
  listeners.add(change);
  return () => listeners.delete(change);
}

function subscribeWidth(change: () => void): () => void {
  window.addEventListener("resize", change);
  return () => window.removeEventListener("resize", change);
}

const windowWidth = () => window.innerWidth;

export interface RailWidth extends RailBounds {
  /** The width chosen, or null for the default. */
  stored: number | null;
  /** The width shown. */
  px: number;
}

/** The rail's width now, following the stored choice and the window's width. */
export function useRailWidth(): RailWidth {
  const s = useSyncExternalStore(subscribeStored, railStored, () => null);
  const w = useSyncExternalStore(subscribeWidth, windowWidth, () => 1280);
  return { ...railBounds(w), stored: s, px: railShown(s, w) };
}
