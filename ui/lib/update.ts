// A page in a browser that the engine refuses for a protocol mismatch has almost always just missed
// a new build: the engine was updated and serves a newer page. Reload once by itself before
// showing the "update" words. The desktop shell never reloads; it ships its own page.
import { inShell } from "./env";

const KEY = "pobots.reloadedForUpdate";
/** A second mismatch within this time shows the words instead of reloading again. */
const AGAIN_MS = 60_000;

/** Reloads the page once, when it runs in a browser. Returns true when a reload was started. */
export function reloadOnceForUpdate(): boolean {
  if (inShell) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < AGAIN_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** After a good connection, a later mismatch may reload again. */
export function forgetUpdateReload(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Only a convenience.
  }
}
