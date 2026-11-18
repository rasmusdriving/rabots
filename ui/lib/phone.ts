// The phone layout (docs/build/step-phone.md). One media query decides whether the window is a
// phone: it is written here and, word for word, around every rule in phone-shell.css and
// phone-chat.css. A window 700 px or wider with a fine pointer never matches, so nothing changes on
// the laptop.
import { useSyncExternalStore } from "react";

/** A phone upright, or a phone on its side. Keep it the same as in phone-shell.css and phone-chat.css. */
export const PHONE_QUERY = "(max-width: 699.98px), (pointer: coarse) and (max-height: 499.98px)";

const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : undefined;

/** True when the window is a phone right now. */
export function isPhone(): boolean {
  return media?.matches ?? false;
}

function subscribe(change: () => void): () => void {
  media?.addEventListener("change", change);
  return () => media?.removeEventListener("change", change);
}

/** True while the window is a phone. Follows a turn of the phone and a resized window. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

// ------------------------------------------------------------ the visible height and the keyboard
// On a phone the on-screen keyboard covers the bottom of the page. Chrome for Android shrinks the page
// itself (the viewport line says interactive-widget=resizes-content); iOS Safari only shrinks the
// visual viewport and pans the page. So the shell follows window.visualViewport itself, through three
// things on the root, written only while the window is a phone:
//   --vvh            the visible height in whole pixels; the shell is that tall
//   --vvtop          how far iOS has panned the visible part down; the shell moves with it
//   data-keyboard    present while the keyboard is open (the visible height is more than
//                    KEYBOARD_PX under the tallest seen at this width)
// Each is written at most once per animation frame, and only when it changed by a whole pixel, so
// the keyboard opening is one change, not a run of them. On the laptop none of them is ever set.

/** How much shorter than the tallest seen the visible part must be to count as the keyboard. */
const KEYBOARD_PX = 120;

let frame = 0;
let written: { raw: number; h: number; top: number; keyboard: boolean } | null = null;
/** The tallest visible height seen at the current width: the height without the keyboard. */
let tallest = { width: 0, height: 0 };

function measure(): void {
  frame = 0;
  const root = document.documentElement;
  if (!isPhone()) {
    if (written) {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvtop");
      delete root.dataset.keyboard;
      written = null;
    }
    tallest = { width: 0, height: 0 };
    return;
  }
  const vv = window.visualViewport;
  const height = vv?.height ?? window.innerHeight;
  const top = Math.max(0, vv?.offsetTop ?? 0);
  const width = Math.round(vv?.width ?? window.innerWidth);
  // A turn of the phone, or a new width, starts over: the tallest is the height now.
  if (width !== tallest.width) tallest = { width, height: Math.max(height, window.innerHeight) };
  else tallest.height = Math.max(tallest.height, height, window.innerHeight);
  const keyboard = tallest.height - height > KEYBOARD_PX;
  // Less than a whole pixel of change is not a change: the height stays as written.
  const moved = !written || Math.abs(height - written.raw) >= 1;
  const raw = moved ? height : written!.raw;
  const h = moved ? Math.round(height) : written!.h;
  const t = Math.round(top);
  if (!written || written.h !== h) root.style.setProperty("--vvh", `${h}px`);
  if (!written || written.top !== t) root.style.setProperty("--vvtop", `${t}px`);
  if (!written || written.keyboard !== keyboard) {
    if (keyboard) root.dataset.keyboard = "";
    else delete root.dataset.keyboard;
  }
  written = { raw, h, top: t, keyboard };
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure);
}

/** Starts following the visible height. Called once when the window starts; does nothing on the laptop but look. */
export function followViewport(): void {
  if (typeof window === "undefined") return;
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  media?.addEventListener("change", schedule);
  // The first value at once, so the shell has its height before the first picture is drawn.
  measure();
}
