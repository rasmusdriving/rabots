// A small headless Chromium driver over the DevTools protocol, for the checks and the icon maker.
// Uses chrome-headless-shell from the Playwright cache; CHROMIUM=/path/to/binary overrides.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const dir = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : undefined;
  const bin = dir ? join(cache, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell") : undefined;
  return bin && existsSync(bin) ? bin : undefined;
}

const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), "process-watchdog.mjs");

/**
 * Makes sure a child of a check never outlives the check (fix 0.26.1). `match` is text only its
 * processes carry in their command line (for a browser: its own temporary profile folder).
 * - The check ends in any way Node still sees (the end, process.exit, an uncaught error, a stop the
 *   check handles): the child is told to end at once.
 * - The check is killed outright (SIGKILL, a crash of Node itself): a small detached watchdog
 *   (process-watchdog.mjs) sees it gone and ends the child and its helpers.
 */
export function guardChild(child, match) {
  const end = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  process.once("exit", end);
  child.once("exit", () => process.off("exit", end));
  try {
    spawn(process.execPath, [WATCHDOG, String(process.pid), match], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No watchdog: the exit handler above still covers every end but a SIGKILL.
  }
}

/**
 * Starts Chromium and connects to its first page.
 * Returns { cmd, js, until, events, close }. `events` collects every protocol event by method.
 */
export async function launch({ profile, args = [], width = 1280, height = 820 }) {
  const bin = findChromium();
  if (!bin) throw new Error("No headless Chromium found. Set CHROMIUM to a chrome-headless-shell binary.");
  // Port 0: the browser picks a free port and writes it into its profile folder. A port picked here
  // by chance (9400 to 9799 until 14 Nov 2026) can be taken by another check's browser now that the
  // sections of a check run side by side, and the second check would then drive the first one's page.
  const child = spawn(bin, ["--headless", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, ...args, "about:blank"], {
    stdio: "ignore",
  });
  guardChild(child, `--user-data-dir=${profile}`);

  let ws;
  let debugPort;
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      debugPort ??= Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || undefined;
      if (!debugPort) throw new Error("no port yet");
      const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
      }
    } catch {
      ws = undefined;
    }
    if (!ws) await sleep(100);
  }
  if (!ws) {
    child.kill();
    throw new Error("The browser did not start.");
  }

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
    else if (msg.method) for (const l of listeners) l(msg);
  });
  const cmd = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression) => (await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const until = async (expression, ms = 90_000, every = 250) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await js(expression);
      if (v) return v;
      await sleep(every);
    }
    return undefined;
  };
  const on = (fn) => listeners.push(fn);
  const close = async () => {
    try {
      ws.close();
    } catch {}
    child.kill();
    // A browser that does not end within three seconds is ended for good, so close() never hangs.
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) return r();
      const hard = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => (clearTimeout(hard), r()));
    });
  };
  return { cmd, js, until, on, close };
}
