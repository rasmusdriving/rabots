// Pobots's own update on a public install (engine 0.34.0, docs/build/step-self-update.md): what the
// update button, the round arrow and its dialog list. `providers.pobots` is there only on such an
// install; everywhere else these give what they gave before. The one reload of a page after the
// engine comes back with a new version is on every install (engine 0.41.0).
import type { ProvidersState, Snapshot } from "../../shared/protocol";
import { inShell } from "./env";
import { keepDraftsForReload } from "./drafts";

export interface UpdateItem {
  id: string;
  label: string;
  from?: string;
  to?: string;
}

/** What the button would update now: Claude Code and Codex first, then Pobots. */
export function updateTodo(p: ProvidersState | null | undefined): UpdateItem[] {
  if (!p) return [];
  const out: UpdateItem[] = p.providers.filter((x) => x.updateAvailable).map((x) => ({ id: x.id, label: x.label, ...(x.version ? { from: x.version } : {}), ...(x.latest ? { to: x.latest } : {}) }));
  const s = p.pobots;
  if (s && s.available && s.canRestart && s.latest) out.push({ id: "pobots", label: "Pobots", from: s.current, to: s.latest });
  return out;
}

/** True while either update runs. */
export function anyUpdateRunning(p: ProvidersState | null | undefined): boolean {
  return (!!p?.update && !p.update.endedAt) || (!!p?.pobots?.run && !p.pobots.run.endedAt);
}

/** "Claude Code", "Claude Code and Pobots", "Claude Code, Codex and Pobots". */
export function labelsWords(items: { label: string }[]): string {
  const names = items.map((i) => i.label);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const KEY = "pobots.reloadedForVersion";
/** How often a reload put off for the person's typing or an open dialog is tried again. */
const RETRY_MS = 3000;
let waiting: string | undefined;

/**
 * True while the reload would get in the person's way: a text field they are in holds text, or a
 * dialog is open (a to-do, a card, a sheet).
 */
function busyHere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.trim()) return true;
    if (el.isContentEditable && el.textContent?.trim()) return true;
  }
  return !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}

/** Reloads once for this version, keeping the chat drafts. False when it was done before or cannot be kept to once. */
function reloadOnce(version: string): boolean {
  try {
    if (sessionStorage.getItem(KEY) === version) return false;
    sessionStorage.setItem(KEY, version);
  } catch {
    // Without storage the page could not tell it already reloaded: no reload, so never a loop.
    return false;
  }
  keepDraftsForReload();
  window.location.reload();
  return true;
}

/**
 * A page in a browser reloads once when the engine came back with another version, so the page is
 * the new build's too (the protocol number may not have changed). On every kind of install (engine
 * 0.41.0; before, only with `providers.pobots`). Never in the desktop window, once per version
 * (sessionStorage), and never while the person types or has a dialog open: then it waits, tries
 * again every few seconds, and the page goes on meanwhile. True when it reloads now.
 */
export function reloadForNewVersion(before: { version?: string }, next: Snapshot): boolean {
  if (inShell || !before.version) return false;
  const version = next.status.engineVersion;
  if (!version || version === before.version) return false;
  try {
    if (sessionStorage.getItem(KEY) === version) return false;
  } catch {
    return false;
  }
  if (!busyHere()) return reloadOnce(version);
  if (waiting === version) return false;
  waiting = version;
  const retry = () => {
    if (waiting !== version) return;
    if (busyHere()) return void window.setTimeout(retry, RETRY_MS);
    waiting = undefined;
    reloadOnce(version);
  };
  window.setTimeout(retry, RETRY_MS);
  return false;
}
