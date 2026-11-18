// Pages that live outside Pobots. Claude's own pages refuse to be shown inside another page, so an
// artifact on Claude opens in a window of its own placed beside Pobots: the same named window each
// time, so it is reused. In the desktop window, outside links open in the system's browser.
import { inShell } from "./env";

/** The one window Claude's pages open in, so a second link reuses it. */
export const CLAUDE_WINDOW = "pobots-claude";

/**
 * Opens a page on Claude beside Pobots. Returns false when the browser blocked the window; then the
 * caller shows the link as a plain link the person can click.
 */
export function openOutside(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return true;
  // The desktop shell sends every new window to the system's browser and opens none of its own.
  if (inShell) {
    window.open(url, "_blank");
    return true;
  }
  const sw = screen.availWidth || window.outerWidth;
  const sh = screen.availHeight || window.outerHeight;
  const w = Math.round(Math.min(Math.max(sw * 0.42, 480), 1040));
  const h = Math.round(sh * 0.92);
  const sx = (screen as Screen & { availLeft?: number }).availLeft ?? 0;
  const sy = (screen as Screen & { availTop?: number }).availTop ?? 0;
  const left = sx + sw - w;
  const top = sy + Math.round((sh - h) / 2);
  let win: Window | null = null;
  try {
    win = window.open(url, CLAUDE_WINDOW, `popup,width=${w},height=${h},left=${left},top=${top}`);
  } catch {
    win = null;
  }
  if (!win) return false;
  // The page on Claude gets no hold on Pobots.
  try {
    win.opener = null;
  } catch {
    // Already cut off.
  }
  try {
    win.focus();
  } catch {
    // A window that cannot be brought forward is still open.
  }
  return true;
}
