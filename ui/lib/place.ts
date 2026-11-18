// Keeping the chat's place when its width changes (the panel beside it opens, closes or is made wider).
// Whoever is about to change the width calls notePlace() first; the chat then remembers the line at
// the top of what is in view and puts it back there once the new width has been laid out.
const keepers = new Set<(rows?: string) => void>();

/**
 * Called just before something changes the chat's width. With a selector for the rows of what is
 * being opened or closed (an artifact's rows, a browser workspace's rows), the chat keeps that row
 * in place when it is in view, because that is what the person is acting on; otherwise the line at
 * the top.
 */
export function notePlace(rows?: string): void {
  for (const keep of keepers) keep(rows);
}

/** The chat registers how it remembers its place. Returns the way to stop. */
export function onNotePlace(keep: (rows?: string) => void): () => void {
  keepers.add(keep);
  return () => keepers.delete(keep);
}

/** The rows that open the panel: an artifact's, a browser workspace's. */
export const PANEL_ROWS = ".pb-artifact, .pb-browser";

/**
 * The lines of a chat that can stand at the top of the view: a paragraph, an item of a list, a line
 * of work, a row, a message bubble, a picture or a file in a message, a notice. Fine enough that keeping one in place keeps what the
 * person was reading.
 */
export const LINES =
  ".pb-msg-body > :not(ul, ol), .pb-msg-body li, .pb-msg-body:not(.app-md), .pb-msg-head, .pb-step, .pb-worked, .pb-helper, .pb-artifact, .pb-browser, .pb-picture, .pb-msg-file, .pb-msg-you, .app-you-note, .app-notice, .pb-fold, .pb-fresh, .pb-pending, .app-thread-more";

/** The first line whose top is in view in this scroller, and where its top is. */
export function lineAtTop(scroller: HTMLElement): { el: Element; top: number } | null {
  const view = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll(LINES)) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.top >= view - 0.5) return { el, top: r.top };
  }
  return null;
}
