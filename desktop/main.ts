// The Electron main process: one window, and the engine as a child process.
//
// The window is only a client of the engine. All bot work happens in the engine, which is the
// same program that runs on its own as a background service (scripts/service.mjs).
//
// If an engine already runs on the data folder (its <dataDir>/engine.json names a live engine,
// for example the background service), the window connects to that one and leaves it running on
// quit. Otherwise the shell starts its own engine and stops it on quit.
//
// Flags, for development and checks:
//   --data-dir=PATH --bots-dir=PATH                         run the engine on other folders than the real ones
//   --engine-url=ws://127.0.0.1:PORT --engine-token=TOKEN   use an engine that is already running
//   --mock                                                  let the UI run on its built-in sample data
//   --screenshot=PATH [--screenshot-delay=MS]               save a picture of the window, then quit
//   --theme=dark|light                                      force a theme
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EngineAnnouncement, EngineEndpoint } from "../shared/protocol";
import { runningEngine } from "../engine/lock";

const flag = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

// The window's own browser data lives in an "app" folder inside the engine's data folder, so
// everything Pobots keeps is in one place and a check on temporary folders never touches the real one.
// The data folder is the engine's default on macOS and Windows (see engine/config.ts).
app.setName("Pobots");
const dataDir = flag("data-dir") ?? join(app.getPath("appData"), "Pobots");
app.setPath("userData", join(dataDir, "app"));

let engine: ChildProcess | undefined;
let endpoint: EngineEndpoint | undefined;
let window: BrowserWindow | undefined;

function startEngine(): Promise<EngineEndpoint> {
  return new Promise((resolve, reject) => {
    const logDir = join(app.getPath("userData"), "logs");
    mkdirSync(logDir, { recursive: true });
    const log = createWriteStream(join(logDir, "engine.log"), { flags: "a" });

    // Electron's own binary doubles as Node, so the engine needs no separate runtime.
    // --data-dir and --bots-dir are passed on, so a check can run the app on temporary folders.
    // --shell tells the engine the window started it, so a public install can open the window again after an update.
    const passOn = ["data-dir", "bots-dir"].flatMap((name) => (flag(name) ? [`--${name}=${flag(name)}`] : []));
    const child = spawn(process.execPath, [join(__dirname, "..", "engine", "main.mjs"), "--port=0", "--shell", ...passOn], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    engine = child;
    child.stderr?.pipe(log);

    let announced = false;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (announced) return void log.write(line + "\n");
      try {
        const parsed = JSON.parse(line) as Partial<EngineAnnouncement>;
        if (parsed.pobotsEngine) {
          announced = true;
          const { port, token } = parsed.pobotsEngine;
          resolve({ url: `ws://127.0.0.1:${port}/`, token });
          return;
        }
      } catch {
        // not the announcement line
      }
      log.write(line + "\n");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!announced) reject(new Error(`The engine stopped before it was ready (exit code ${code}).`));
      else if (!quitting) app.quit();
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    title: "Pobots",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#08080a" : "#f2f2f3",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => {
    if (!flag("screenshot")) win.show();
  });
  // Links in messages open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  const query: Record<string, string> = {};
  if (has("mock")) query.mock = "1";
  const theme = flag("theme");
  if (theme) query.theme = theme;
  void win.loadFile(join(__dirname, "..", "ui", "index.html"), { query });
  return win;
}

async function takeScreenshot(win: BrowserWindow, path: string): Promise<void> {
  const delay = Number(flag("screenshot-delay") ?? 2500);
  await new Promise((r) => setTimeout(r, delay));
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());
}

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  engine?.kill();
});

if (!app.requestSingleInstanceLock() && !flag("screenshot")) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  ipcMain.handle("pobots:engine", () => endpoint ?? null);

  void app.whenReady().then(async () => {
    const theme = flag("theme");
    if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;

    const url = flag("engine-url");
    if (url) endpoint = { url, token: flag("engine-token") ?? "" };
    else if (!has("mock")) {
      const running = await runningEngine(dataDir);
      // An engine we did not start is never stopped by us: `engine` stays unset.
      endpoint = running ? { url: `ws://127.0.0.1:${running.port}/ws`, token: running.token } : await startEngine();
    }

    window = createWindow();
    const shot = flag("screenshot");
    if (shot) {
      window.webContents.once("did-finish-load", () => {
        void takeScreenshot(window!, shot).then(() => app.quit());
      });
    }
  });

  app.on("window-all-closed", () => app.quit());
}
