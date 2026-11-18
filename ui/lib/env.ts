// Where the window runs: URL flags, platform, theme.
import type { EngineEndpoint } from "../../shared/protocol";
import type { PobotsBridge } from "../../desktop/preload";

declare global {
  interface Window {
    /** Set by the desktop shell's preload. Missing in a plain browser. */
    pobots?: PobotsBridge;
  }
}

export const params = new URLSearchParams(window.location.search);

/** ?platform= wins, for pictures made in a plain browser. */
export const platform: string = params.get("platform") ?? window.pobots?.platform ?? (/Mac/.test(navigator.platform) ? "darwin" : "other");
export const isMac = platform === "darwin";

/** True inside the desktop shell, false in a plain browser. ?shell=desktop|browser wins, for pictures. */
export const inShell: boolean = params.has("shell") ? params.get("shell") === "desktop" : !!window.pobots;

/**
 * The theme follows the system; ?theme=dark|light wins. Sets data-theme on <html>, and
 * data-platform and data-shell, so the room for the macOS window buttons is only made in the shell.
 */
export function applyTheme(): void {
  const forced = params.get("theme");
  const root = document.documentElement;
  // Keyboard or pointer: a text box that fills a surface (the composer, the editor) rings the
  // whole surface only for keyboard use, the way :focus-visible does for buttons.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key.startsWith("Arrow") || e.key === "Escape") root.dataset.input = "keyboard";
  }, true);
  window.addEventListener("pointerdown", () => (root.dataset.input = "pointer"), true);
  root.dataset.platform = platform;
  root.dataset.shell = inShell ? "desktop" : "browser";
  if (forced === "dark" || forced === "light") {
    root.dataset.theme = forced;
    return;
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const set = () => (root.dataset.theme = media.matches ? "dark" : "light");
  set();
  media.addEventListener("change", set);
}

/**
 * Whether this window runs on the engine's own machine, as far as can be told at start: the desktop
 * shell, a file page, or a page on localhost. A page opened from another device says "connected"
 * for the engine's machine instead of "this one". ?device=remote|local wins, for pictures and checks.
 * A page in a browser also asks the engine (/api/whoami) and corrects this.
 */
export function engineHereAtStart(): boolean {
  const forced = params.get("device");
  if (forced === "remote") return false;
  if (forced === "local") return true;
  if (inShell) return true;
  const { protocol, hostname } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return true;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Where the mock pretends the engine is, for a webhook's address on a file page. */
const MOCK_ORIGIN = "http://127.0.0.1:47600";

/**
 * The engine's own web address, for a webhook's full address: the page's origin in a browser (the
 * engine served it), the engine the shell connects to in the desktop app, and a stand-in for the
 * mock on a file page.
 */
export async function engineOrigin(): Promise<string> {
  if (window.pobots) {
    const endpoint = await window.pobots.engine();
    if (endpoint) return httpOriginOf(endpoint);
  }
  const { protocol, origin } = window.location;
  return protocol === "http:" || protocol === "https:" ? origin : MOCK_ORIGIN;
}

/** The engine's HTTP origin from the socket address the window connects to: ws://host/ws gives http://host. */
export function httpOriginOf(endpoint: EngineEndpoint): string {
  const u = new URL(endpoint.url);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}

/**
 * The address of a stored attachment on the engine: its preview or the file itself. The local token
 * is added only in the desktop window (an endpoint with a token); a page in a browser is let in by
 * its Tailscale login, and never puts a token in an address.
 */
/** Step 7c: the address of a file in a to-do's window, by the same rule as an attachment. */
export function todoFileAddress(endpoint: EngineEndpoint, todoId: string, index: number, version: string): string {
  const u = new URL(`/api/todos/${encodeURIComponent(todoId)}/files/${index}`, httpOriginOf(endpoint));
  u.searchParams.set("v", version);
  if (endpoint.token) u.searchParams.set("token", endpoint.token);
  return u.toString();
}

export function attachmentAddress(endpoint: EngineEndpoint, id: string, which: "preview" | "full"): string {
  const u = new URL(`/api/attachments/${encodeURIComponent(id)}/${which}`, httpOriginOf(endpoint));
  if (endpoint.token) u.searchParams.set("token", endpoint.token);
  return u.toString();
}
