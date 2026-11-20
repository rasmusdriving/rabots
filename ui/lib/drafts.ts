// The chat boxes' drafts, one per bot, kept in memory while the page lives (Composer.tsx). Before the
// page reloads itself for a new build (pobots-update.ts) they are put in sessionStorage, and taken back
// once when the page loads again, so a reload never loses what the person typed (engine 0.41.0).
const KEY = "pobots.drafts";

function restore(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (v && typeof v === "object") for (const [k, t] of Object.entries(v)) if (typeof t === "string" && t) map.set(k, t);
  } catch {
    // No storage (a private window, a blocked site): drafts live in memory only, as before.
  }
  return map;
}

export const drafts = restore();

/** Puts the drafts aside for the next load of this page. False when there is no storage. */
export function keepDraftsForReload(): boolean {
  try {
    const kept = Object.fromEntries([...drafts].filter(([, t]) => t.trim()));
    if (Object.keys(kept).length) sessionStorage.setItem(KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}
