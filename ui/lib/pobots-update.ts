// Pobots's own update on a public install (engine 0.34.0, docs/build/step-self-update.md): what the
// update button, the round arrow and its dialog list, and the one reload of a page after the restart.
// `providers.pobots` is there only on such an install; everywhere else these give what they gave before.
import type { ProvidersState, Snapshot } from "../../shared/protocol";
import { inShell } from "./env";

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

/**
 * A page in a browser on a public install reloads once when the engine came back with another
 * version after its own update, so the page is the new build's too (the protocol number may not have
 * changed). Never in the desktop window, never without `providers.pobots`, once per version.
 */
export function reloadForNewVersion(before: { version?: string; pobots: boolean }, next: Snapshot): boolean {
  if (inShell || !before.pobots || !before.version || !next.providers?.pobots) return false;
  const version = next.status.engineVersion;
  if (!version || version === before.version) return false;
  try {
    if (sessionStorage.getItem(KEY) === version) return false;
    sessionStorage.setItem(KEY, version);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
