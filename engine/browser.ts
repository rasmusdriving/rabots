// The bots' browser, shown live in Pobots (docs/build/step-2g.md, Part A; what was found about the
// browser is in docs/build/notes-engine-2g.md).
//
// The browser is ego lite on the engine's machine, driven with `ego-browser nodejs`. The engine runs
// small helper scripts in it (engine/browser-script.ts) that connect back over a local link only
// they can use: one long-lived "lister" that only lists the workspaces and keeps the person's own
// workspace, one "watcher" per workspace someone watches, and short "peeks" that read a workspace's
// pages while no command of its bot runs there. A second live script in a bot's workspace makes the
// bot's wait for a popup miss it, so the engine attaches to a bot's workspace only for those two.
//
// The engine sees every command a bot or its helper runs. One that runs ego-browser is browser work:
// the workspace it names (or the one that appears while it runs) becomes the bot's, gets a row in
// the bot's chat once per turn, and is "busy" while the command runs.
//
// Pictures go only to the connection that watches (see BrowserConn); never to a file, a log line,
// the database or an item.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { BrowserInput, BrowserItem, BrowserPage, BrowserPrompt, BrowserSpace, BrowserState, Events, Item, Methods } from "../shared/protocol.js";
import { helperScript, type HelperRole } from "./browser-script.js";
import { toActions, type DialogState, type PointerState } from "./browser-input.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";
import type { BrowserSpaceRow, Store } from "./store.js";

// ---------------------------------------------------------------- words

export const BROWSER_WORDS = {
  missing: "The browser the bots use is not installed on this computer.",
  off: "The browser is switched off for Pobots in its settings.",
  unreachable: "The browser the bots use could not be reached. Open it on the computer, then try again.",
  unavailable: "The browser cannot be reached right now.",
  closedSpace: "That workspace is not open in the browser any more.",
  noPage: "That page is not open in the workspace any more.",
  handed: "This workspace was handed over in the browser itself, so Pobots cannot show it.",
  notYours: "Only your own page can be closed here. The bot closes its own workspace.",
  needControl: "Take control first.",
  badAddress: "Only web addresses that start with http or https can be opened.",
  nothingAsks: "Nothing on the page waits for an answer.",
  ownPagesOnly: "Pages can only be opened and closed in Your page.",
  lastPage: "This is the last page. Close Your page instead.",
  ownName: "Your page",
} as const;

// ---------------------------------------------------------------- the driver: how helper scripts are started

/** A started `ego-browser nodejs`. Its script lives on inside the browser until its link closes. */
export interface HelperChild {
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface BrowserDriver {
  /** Undefined when the browser can be used, else one plain sentence why not. */
  problem(): string | undefined;
  /** Whether the browser app runs now. Never starts it. */
  running(): Promise<boolean>;
  /** Starts `ego-browser nodejs` with this script on stdin. */
  spawn(script: string): HelperChild;
}

const APP_PROCESS = /\/ego lite\.app\/Contents\/MacOS\/ego lite(\s|$)/;

/** Where the ego-browser command is: the configured path, else the usual places (the service has a short PATH). */
export function findEgoBrowser(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d || !isAbsolute(d)) continue;
    const p = join(d, "ego-browser");
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function realDriver(opts: { enabled: boolean; executable?: string }): BrowserDriver {
  let exe: string | undefined;
  let looked = 0;
  const find = () => {
    // Looked for again now and then, so installing the browser later is noticed without a restart.
    if (!exe && Date.now() - looked > 60_000) {
      looked = Date.now();
      exe = findEgoBrowser(opts.executable);
    }
    return exe;
  };
  return {
    problem: () => (!opts.enabled ? BROWSER_WORDS.off : find() ? undefined : BROWSER_WORDS.missing),
    running: () =>
      new Promise((done) => {
        execFile("ps", ["-axo", "args="], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, stdout) => done(!err && stdout.split("\n").some((l) => APP_PROCESS.test(l))));
      }),
    spawn: (script) => {
      const child = spawn(find() ?? "ego-browser", ["nodejs"], { stdio: ["pipe", "ignore", "ignore"], detached: false });
      child.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(script);
      return {
        kill: () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // gone already
          }
        },
        onExit: (cb) => {
          child.once("exit", (code) => cb(code));
          child.once("error", () => cb(-1));
        },
      };
    },
  };
}

// ---------------------------------------------------------------- what the hub needs from the engine

export type NewBrowserItem = Omit<BrowserItem, "id" | "threadId" | "seq" | "turnId">;

export interface BrowserHost {
  /** Bot ids in roster order. */
  botOrder(): string[];
  /** Puts a new item in a thread (the engine adds the turn's id when it belongs to the running turn). */
  addItem(botId: string, threadId: string, item: NewBrowserItem): Item | undefined;
  /** Saves and sends a changed item. */
  putItem(item: Item): void;
  /** Sends the whole state to the app. */
  changed(state: BrowserState): void;
}

/** One connection of the app, as the hub sees it. Pictures and the end of a watch go to it alone. */
export interface BrowserConn {
  id: string;
  frame(data: Events["browser.frame"]): void;
  ended(data: Events["browser.ended"]): void;
  prompt(data: Events["browser.prompt"]): void;
}

export interface BrowserTimings {
  /** How often the lister looks while someone watches or a bot's browser command runs. */
  fastMs?: number;
  /** How often otherwise. */
  slowMs?: number;
  /** The lister stops when nothing is open, nobody watches and nothing ran for this long. */
  idleStopMs?: number;
  /** How long a helper may take to connect and report. */
  readyMs?: number;
  /** After the browser could not be reached, how long before it is tried again. */
  retryMs?: number;
  /** A watcher nobody needs any more is closed after this. */
  watcherGraceMs?: number;
  /** At most one peek per workspace in this time. */
  peekGapMs?: number;
  /** A workspace whose front page's title changed while nothing runs there is read again at most this often (a title that keeps changing, such as an inbox count, must not keep a helper busy). */
  titlePeekMs?: number;
  /** The row's line about now changes at most this often. */
  lastMs?: number;
  /** How long the end of a command waits for a fresh list. */
  endListMs?: number;
  /** The watcher script's own pace: pages, pictures while a page changes, pictures while it is still. */
  tabsMs?: number;
  fastShotMs?: number;
  slowShotMs?: number;
  /** How long a page stands still before its sharp picture. */
  stillMs?: number;
}

export interface BrowserHubOptions {
  /** Undefined: the browser is switched off. */
  driver: BrowserDriver | undefined;
  store: Store;
  host: BrowserHost;
  timings?: BrowserTimings;
}

// ---------------------------------------------------------------- internals

interface ListEntry {
  id: number;
  name: string;
  ownership: string;
  recent: string[];
}

type Msg = Record<string, unknown> & { t?: string };

class Run {
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("hex");
  sock?: Socket;
  child?: HelperChild;
  live = false;
  ended = false;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  onMessage: (m: Msg) => void = () => undefined;
  onEnd: () => void = () => undefined;

  readonly role: HelperRole;
  readonly spaceId?: number;

  constructor(role: HelperRole, spaceId?: number) {
    this.role = role;
    if (spaceId !== undefined) this.spaceId = spaceId;
  }

  call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (!this.live || this.ended || !this.sock) return Promise.reject(new Error("helper not live"));
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sock!.write(JSON.stringify({ t: "cmd", id, op, ...args }) + "\n");
    });
  }

  /** Resolves when the script has said hello. */
  ready(timeoutMs: number): Promise<void> {
    if (this.live) return Promise.resolve();
    if (this.ended) return Promise.reject(new Error("helper ended"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("helper did not connect")), timeoutMs);
      timer.unref?.();
      this.readyWaiters.push({ resolve, reject, timer });
    });
  }

  bind(sock: Socket): void {
    this.sock = sock;
    this.live = true;
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  receive(m: Msg): void {
    if (m.t === "res" && typeof m.id === "string") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(typeof m.error === "string" ? m.error : "failed"));
      return;
    }
    this.onMessage(m);
  }

  /** Ends the run: the link closes, and the script ends itself. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.live = false;
    if (this.sock) this.sock.destroy();
    else this.child?.kill();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("helper ended"));
    }
    this.pending.clear();
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("helper ended"));
    }
    this.onEnd();
  }
}

interface Watch {
  id: string;
  conn: BrowserConn;
  spaceId: number;
  /** "front" follows the workspace's front page; else a page id. */
  key: string;
  /** The page shown now. */
  pageId: string;
  controlled: boolean;
  seq: number;
  pointer: PointerState;
  /** How many screen pixels one page pixel covers where this watch draws it (see "browser.view"). */
  ratio: number;
}

interface Watcher {
  run: Run;
  spaceId: number;
  watches: Set<Watch>;
  pages: BrowserPage[];
  dialogs: Map<string, DialogState>;
  /** What each page shows outside its picture now (a page's question, the choices of a drop-down list). */
  prompts: Map<string, BrowserPrompt>;
  restarts: number;
  closeTimer?: NodeJS.Timeout;
  ready: Promise<void>;
  wanted: string;
}

interface Cmd {
  key: string;
  botId: string;
  threadId: string;
  turnKey: string;
  names: string[];
  ids: number[];
  /** Workspaces in the list when it started, when the list was known. */
  before?: Set<number>;
  spaces: Set<number>;
  startedAt: number;
  endedAt?: number;
}

interface OpenItem {
  item: BrowserItem;
  turnKey: string;
  sentAt: number;
  timer?: NodeJS.Timeout;
}

const TEMP_DIRS = () => [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map((d) => realOrSame(d)))];

function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inside(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** True when a command runs ego-browser. */
export function isBrowserCommand(command: unknown): command is string {
  return typeof command === "string" && /(?:^|[\s;&|(`'"/])ego-browser(?=\s|$|['"`;)|&])/.test(command);
}

/** The workspaces a script names: `taskSpace("name")`, `taskSpace(7)`, `takeOverTaskSpace(7)`, `claimTaskSpace(7)`. */
export function claimsOf(text: string): { names: string[]; ids: number[] } {
  const names = new Set<string>();
  const ids = new Set<number>();
  for (const m of text.matchAll(/\b(?:taskSpace|takeOverTaskSpace|claimTaskSpace)\(\s*(\d{1,9})\s*[,)]/g)) ids.add(Number(m[1]));
  for (const m of text.matchAll(/\btaskSpace\(\s*\\?(["'`])(.{1,200}?)\\?\1\s*[,)]/g)) {
    const n = m[2]!.replace(/\\(["'`\\])/g, "$1");
    if (n.trim() && !n.includes("${")) names.add(n);
  }
  return { names: [...names], ids: [...ids] };
}

/** Script files a command hands to ego-browser: `ego-browser nodejs < file`, `ego-browser nodejs file`, `cat file | ego-browser nodejs`. */
export function scriptFilesOf(command: string): string[] {
  const out = new Set<string>();
  const path = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s'"<>|;&()]+))`;
  for (const m of command.matchAll(new RegExp(String.raw`ego-browser(?:\s+--[\w.-]+(?:=\S+)?)*\s+nodejs\s*<\s*${path}`, "g"))) out.add(m[1] ?? m[2] ?? m[3]!);
  for (const m of command.matchAll(new RegExp(String.raw`ego-browser(?:\s+--[\w.-]+(?:=\S+)?)*\s+nodejs\s+(?!-)${path}`, "g"))) {
    const p = m[1] ?? m[2] ?? m[3]!;
    if (!p.startsWith("<")) out.add(p);
  }
  for (const m of command.matchAll(new RegExp(String.raw`\bcat\s+${path}\s*\|\s*(?:\S*/)?ego-browser\b`, "g"))) out.add(m[1] ?? m[2] ?? m[3]!);
  return [...out].filter((p) => /\.(m?js|cjs|ts|txt)$/i.test(p) || !p.includes("."));
}

/** The folders a command moves to with `cd` before it runs ego-browser, in order, from the bot's folder. */
export function cdDirsOf(command: string, botDir: string): string[] {
  const at = command.search(/(?:^|[\s;&|(`'"/])ego-browser(?=\s|$)/);
  const head = at >= 0 ? command.slice(0, at) : command;
  let cwd = botDir;
  const out = [botDir];
  for (const m of head.matchAll(/(?:^|[;&|(]\s*|&&\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g)) {
    const raw = m[1] ?? m[2] ?? m[3]!;
    const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    cwd = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    out.push(cwd);
  }
  return out;
}

/** Reads a script file a command names, when it is in the bot's folder or a temporary folder. */
function readScript(file: string, botDir: string, dirs: string[]): string | undefined {
  const expanded = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
  const allowed = [realOrSame(botDir), ...TEMP_DIRS()];
  const candidates = isAbsolute(expanded) ? [expanded] : [...dirs].reverse().map((d) => resolve(d, expanded));
  for (const c of candidates) {
    const full = realOrSame(c);
    if (!allowed.some((d) => inside(d, full))) continue;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      return readFileSync(full, "utf8");
    } catch {
      // not there
    }
  }
  return undefined;
}

/** "Title · host", on one line, at most 160 characters. */
export function lastLine(title: string, url: string): string {
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") host = u.host;
    // A new page with no address yet (the browser's own new page, a blank one): nothing to say.
    else return "";
  } catch {
    host = "";
  }
  const t = title.replace(/\s+/g, " ").trim();
  const line = t && host ? `${t} · ${host}` : t || host;
  return line.length > 160 ? line.slice(0, 159).trimEnd() + "…" : line;
}

/** The address `browser.go` and `browser.own` go to, or undefined when it is not allowed. A bare host gets https://. */
export function cleanAddress(raw: string): string | undefined {
  const text = raw.trim();
  if (!text || text.length > 4000 || /\s/.test(text)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(text);
  const withScheme = scheme ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!u.hostname) return undefined;
  return u.href;
}

const now = () => new Date().toISOString();

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- the hub

export class BrowserHub {
  private readonly driver: BrowserDriver | undefined;
  private readonly store: Store;
  private readonly host: BrowserHost;
  private readonly t: Required<BrowserTimings>;
  private server?: Server;
  private serverPort?: Promise<number>;
  private runs = new Map<string, Run>();
  private lister?: Run;
  private listerReady?: Promise<boolean>;
  private listerFailures = 0;
  private failedAt = 0;
  private problemText?: string;
  private list?: Map<number, ListEntry>;
  /** True once a list came from a live lister since it started: then a workspace missing from it is gone. */
  private listLive = false;
  private listWaiters: (() => void)[] = [];
  private pages = new Map<number, BrowserPage[]>();
  private owners = new Map<number, BrowserSpaceRow>();
  private watchers = new Map<number, Watcher>();
  private watches = new Map<string, Watch>();
  private byConn = new Map<string, Watch>();
  private peeks = new Map<number, Run>();
  private peekedAt = new Map<number, number>();
  private cmds = new Map<string, Cmd>();
  private recentCmds: Cmd[] = [];
  private itemKeys = new Map<string, string>();
  private openItems = new Map<string, OpenItem>();
  private newestItem = new Map<number, string>();
  private lastState = "";
  private state: BrowserState;
  private lastNeed = Date.now();
  private idleTimer?: NodeJS.Timeout;
  private stopping = false;
  private rate = 0;
  private readonly ownName: string;

  constructor(opts: BrowserHubOptions) {
    this.driver = opts.driver;
    this.store = opts.store;
    this.host = opts.host;
    this.t = {
      fastMs: 1000,
      slowMs: 5000,
      idleStopMs: 3 * 60_000,
      readyMs: 20_000,
      retryMs: 15_000,
      watcherGraceMs: 3000,
      peekGapMs: 3000,
      titlePeekMs: 30_000,
      lastMs: 1000,
      endListMs: 2000,
      tabsMs: 500,
      fastShotMs: 80,
      slowShotMs: 400,
      stillMs: 500,
      ...opts.timings,
    };
    let name = this.store.getValue("browser.ownName");
    if (!name) {
      // A name a bot cannot pick by chance, so a bot never resumes the person's own workspace.
      name = `Pobots: your page ${randomBytes(4).toString("hex")}`;
      this.store.setValue("browser.ownName", name);
    }
    this.ownName = name;
    for (const row of this.store.listBrowserSpaces()) this.owners.set(Number(row.spaceId), row);
    for (const item of this.store.openBrowserItems()) {
      this.openItems.set(item.id, { item, turnKey: "", sentAt: 0 });
      this.newestItem.set(Number(item.spaceId), item.id);
    }
    const problem = this.driver ? this.driver.problem() : BROWSER_WORDS.off;
    this.state = problem ? { available: false, problem, spaces: [] } : { available: true, spaces: [] };
    this.lastState = JSON.stringify(this.state);
  }

  /** The browser as the engine last knew it. Looking does not start anything. */
  snapshot(): BrowserState {
    return this.state;
  }

  /** The name of the person's own workspace in the browser's list (for tests and checks). */
  get ownSpaceName(): string {
    return this.ownName;
  }

  // ------------------------------------------------------------ availability and the lister

  private problemNow(): string | undefined {
    if (!this.driver) return BROWSER_WORDS.off;
    return this.driver.problem() ?? this.problemText;
  }

  private unavailable(): EngineError {
    return new EngineError("unavailable", this.problemNow() ?? BROWSER_WORDS.unavailable);
  }

  /** The local link the helpers connect back to: loopback only, a token per run. */
  private ensureServer(): Promise<number> {
    if (this.serverPort) return this.serverPort;
    this.serverPort = new Promise((resolvePort, reject) => {
      const server = createServer((sock) => this.onSocket(sock));
      server.on("error", (err) => {
        log.warn("The browser link could not listen", err.message);
        reject(err);
      });
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.server = server;
        const addr = server.address();
        resolvePort(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    this.serverPort.catch(() => (this.serverPort = undefined));
    return this.serverPort;
  }

  private stopServer(): void {
    if (this.runs.size) return;
    this.server?.close();
    this.server = undefined;
    this.serverPort = undefined;
  }

  private onSocket(sock: Socket): void {
    sock.setNoDelay(true);
    sock.setEncoding("utf8");
    let run: Run | undefined;
    let buf = "";
    const helloTimer = setTimeout(() => sock.destroy(), 5000);
    helloTimer.unref?.();
    sock.on("error", () => undefined);
    sock.on("close", () => {
      clearTimeout(helloTimer);
      if (run && !run.ended) run.close();
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 32 * 1024 * 1024) {
        sock.destroy();
        return;
      }
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: Msg;
        try {
          m = JSON.parse(line) as Msg;
        } catch {
          if (!run) return void sock.destroy();
          continue;
        }
        if (!run) {
          // The first line must be the hello of a run this engine started, with its token.
          const found = m.t === "hello" && typeof m.token === "string" ? [...this.runs.values()].find((r) => !r.live && !r.ended && sameText(r.token, m.token as string)) : undefined;
          if (!found) {
            log.warn("The browser link refused a connection that did not say who it is");
            return void sock.destroy();
          }
          clearTimeout(helloTimer);
          run = found;
          run.bind(sock);
          continue;
        }
        try {
          run.receive(m);
        } catch (err) {
          log.error("A message from a browser helper could not be handled", err);
        }
      }
    });
  }

  private async startRun(role: HelperRole, spaceId?: number): Promise<Run> {
    if (!this.driver || this.driver.problem()) throw this.unavailable();
    const port = await this.ensureServer();
    const run = new Run(role, spaceId);
    this.runs.set(run.id, run);
    const end = run.onEnd;
    run.onEnd = () => {
      this.runs.delete(run.id);
      end();
      if (!this.runs.size) setImmediate(() => this.stopServer());
    };
    const script = helperScript({
      port,
      token: run.token,
      role,
      tabsMs: this.t.tabsMs,
      fastShotMs: this.t.fastShotMs,
      slowShotMs: this.t.slowShotMs,
      stillMs: this.t.stillMs,
      ...(spaceId !== undefined ? { spaceId } : {}),
      ...(role === "lister" ? { ownName: this.ownName, rate: this.rate || this.t.slowMs } : {}),
    });
    const child = this.driver.spawn(script);
    run.child = child;
    child.onExit((code) => {
      // The client ending says nothing once the script has connected: the script lives in the browser.
      if (!run.live && !run.ended) {
        log.warn(`A browser helper ended before it connected (code ${code ?? "none"})`);
        run.close();
      }
    });
    return run;
  }

  /** Starts the lister when it is not running. `force`: also right after the browser could not be reached. Resolves false when the browser cannot be reached. */
  private ensureLister(force = false): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    if (!this.driver || this.driver.problem()) return Promise.resolve(false);
    if (this.lister && !this.lister.ended && this.listerReady) return this.listerReady;
    if (!force && this.failedAt && Date.now() - this.failedAt < this.t.retryMs) return Promise.resolve(false);
    this.listerReady = this.startLister();
    return this.listerReady;
  }

  private async startLister(): Promise<boolean> {
    let run: Run;
    try {
      run = await this.startRun("lister");
    } catch {
      this.failLister();
      return false;
    }
    this.lister = run;
    this.listLive = false;
    run.onMessage = (m) => this.onListerMessage(m);
    const end = run.onEnd;
    run.onEnd = () => {
      end();
      if (this.lister === run) this.listerEnded(run);
    };
    try {
      await run.ready(this.t.readyMs);
      await this.waitForList(this.t.readyMs);
      if (!this.listLive) throw new Error("no list");
    } catch {
      if (this.lister === run) {
        this.lister = undefined;
        this.listerReady = undefined;
        run.close();
      }
      this.failLister();
      return false;
    }
    this.listerFailures = 0;
    this.failedAt = 0;
    this.problemText = undefined;
    this.updateRate();
    this.planIdle();
    this.publish();
    return true;
  }

  private failLister(): void {
    this.listerFailures++;
    this.failedAt = Date.now();
    this.problemText = BROWSER_WORDS.unreachable;
    log.warn("The browser could not be reached");
    this.publish();
  }

  private listerEnded(_run: Run): void {
    this.lister = undefined;
    this.listerReady = undefined;
    this.listLive = false;
    if (this.stopping) return;
    const needed = this.watches.size > 0 || this.cmds.size > 0;
    if (!needed) {
      log.info("The browser helper stopped");
      this.publish();
      return;
    }
    // Brought back once at once, then with a pause; after that the browser counts as not reachable until the next call.
    log.warn("The browser helper ended while it was needed; starting it again");
    const delay = this.listerFailures === 0 ? 300 : 3000;
    this.listerFailures++;
    setTimeout(() => {
      if (this.stopping || this.lister) return;
      if (this.listerFailures > 3) {
        this.failLister();
        for (const w of [...this.watches.values()]) this.endWatch(w, "gone");
        return;
      }
      // The browser app was quit: starting a helper would open it again. The watches end.
      void (this.driver?.running() ?? Promise.resolve(false)).then((running) => {
        if (!running) {
          for (const w of [...this.watches.values()]) this.endWatch(w, "gone");
          this.publish();
          return;
        }
        void this.ensureLister(true).then((ok) => {
          if (!ok) for (const w of [...this.watches.values()]) this.endWatch(w, "gone");
        });
      });
    }, delay).unref?.();
  }

  private waitForList(timeoutMs: number): Promise<void> {
    if (this.listLive) return Promise.resolve();
    return new Promise((resolveWait) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      const self = this;
      function done() {
        clearTimeout(timer);
        self.listWaiters = self.listWaiters.filter((w) => w !== done);
        resolveWait();
      }
      this.listWaiters.push(done);
    });
  }

  private onListerMessage(m: Msg): void {
    if (m.t === "list" && Array.isArray(m.spaces)) {
      const list = new Map<number, ListEntry>();
      for (const raw of m.spaces as Record<string, unknown>[]) {
        const id = Number(raw.id);
        if (!Number.isInteger(id) || id === 0) continue;
        const ownership = String(raw.ownership ?? "");
        if (ownership === "user") continue;
        list.set(id, { id, name: String(raw.name ?? ""), ownership, recent: Array.isArray(raw.recent) ? (raw.recent as unknown[]).map(String).slice(0, 20) : [] });
      }
      this.list = list;
      this.listLive = true;
      for (const w of this.listWaiters.splice(0)) w();
      this.afterList();
      return;
    }
    if (m.t === "problem") log.debug("The browser lister had a problem", m.text);
  }

  /** How often the lister looks: about every second while someone watches or a bot's browser command runs. */
  private updateRate(): void {
    const want = this.watches.size > 0 || this.cmds.size > 0 ? this.t.fastMs : this.t.slowMs;
    if (want === this.rate) return;
    this.rate = want;
    if (this.lister?.live) void this.lister.call("rate", { ms: want }).catch(() => undefined);
  }

  private need(): void {
    this.lastNeed = Date.now();
    this.planIdle();
  }

  /** Stops the lister when nothing is open, nobody watches and nothing ran for a while. */
  private planIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.stopping || !this.lister) return;
    this.idleTimer = setTimeout(() => this.checkIdle(), Math.min(this.t.idleStopMs, 30_000));
    this.idleTimer.unref?.();
  }

  private checkIdle(): void {
    if (!this.lister) return;
    const ours = [...(this.list?.keys() ?? [])].some((id) => this.owners.has(id));
    const quiet = !this.watches.size && !this.cmds.size && !this.peeks.size && !ours;
    if (quiet && Date.now() - this.lastNeed >= this.t.idleStopMs) {
      log.info("Nothing is open in the browser and nobody watches: the browser helper stops");
      const run = this.lister;
      this.lister = undefined;
      this.listerReady = undefined;
      run.close();
      return;
    }
    this.planIdle();
  }

  // ------------------------------------------------------------ the list and the state

  private afterList(): void {
    const list = this.list;
    if (!list) return;
    // Workspaces named by a running command, now that they may be listed.
    for (const cmd of this.cmds.values()) {
      cmd.before ??= new Set(list.keys());
      this.resolveClaims(cmd);
    }
    // A workspace the browser no longer has is gone: its owner is dropped and its rows close.
    if (this.listLive) {
      for (const id of [...this.owners.keys()]) {
        if (!list.has(id)) {
          this.owners.delete(id);
          this.store.removeBrowserSpace(String(id));
          this.pages.delete(id);
        }
      }
      for (const open of [...this.openItems.values()]) if (!list.has(Number(open.item.spaceId))) this.closeItem(open);
      for (const id of [...this.pages.keys()]) if (!list.has(id)) this.pages.delete(id);
      for (const w of [...this.watchers.values()]) if (!list.has(w.spaceId)) for (const watch of [...w.watches]) this.endWatch(watch, "closed");
    }
    // Pages of a bot's workspace whose front page changed, while nothing of the bot runs there and nobody watches.
    for (const [id, entry] of list) {
      const row = this.owners.get(id);
      if (!row || this.watchers.has(id) || this.busy(id)) continue;
      const known = this.pages.get(id);
      const front = known?.find((p) => p.active)?.title;
      if (!known) this.peek(id);
      else if (entry.recent[0] !== undefined && entry.recent[0] !== front && Date.now() - (this.peekedAt.get(id) ?? 0) >= this.t.titlePeekMs) this.peek(id);
    }
    this.publish();
  }

  private busy(spaceId: number): boolean {
    for (const c of this.cmds.values()) if (c.spaces.has(spaceId)) return true;
    return false;
  }

  private pagesOf(id: number, entry: ListEntry): BrowserPage[] {
    const known = this.pages.get(id);
    if (known) return known;
    // Not attached: only the titles the list gives, the front one first.
    return entry.recent.map((title, i) => ({ id: `recent-${id}-${i}`, title, url: "", active: i === 0 }));
  }

  private computeState(): BrowserState {
    const problem = this.problemNow();
    if (problem && (!this.driver || this.driver.problem() || !this.lister)) return { available: false, problem, spaces: [] };
    const list = this.list;
    if (!list || !this.lister) return { available: true, spaces: [] };
    const order = this.host.botOrder();
    const controlled = new Set([...this.watches.values()].filter((w) => w.controlled).map((w) => w.spaceId));
    const spaces: (BrowserSpace & { rank: number })[] = [];
    for (const [id, entry] of list) {
      const row = this.owners.get(id);
      let owner: BrowserSpace["owner"] = "other";
      let botId: string | undefined;
      let rank = 1_000_000 + id;
      if (row?.kind === "you") {
        owner = "you";
        rank = 500_000;
      } else if (row?.kind === "bot" && row.botId && order.includes(row.botId)) {
        owner = "bot";
        botId = row.botId;
        rank = order.indexOf(row.botId) * 1000 + (id % 1000);
      }
      spaces.push({
        id: String(id),
        name: owner === "you" ? BROWSER_WORDS.ownName : entry.name,
        owner,
        ...(botId ? { botId } : {}),
        pages: this.pagesOf(id, entry),
        busy: this.busy(id),
        controlled: controlled.has(id),
        rank,
      });
    }
    spaces.sort((a, b) => a.rank - b.rank);
    return { available: true, spaces: spaces.map(({ rank: _rank, ...s }) => s) };
  }

  /** Sends the state when it changed, and the rows' lines about now. */
  private publish(): void {
    const state = this.computeState();
    const text = JSON.stringify(state);
    this.refreshLasts(state);
    if (text === this.lastState) return;
    this.state = state;
    this.lastState = text;
    this.host.changed(state);
  }

  // ------------------------------------------------------------ peeks: a workspace's pages, for a moment

  private peek(spaceId: number, force = false): void {
    if (this.stopping || this.peeks.has(spaceId) || this.watchers.has(spaceId) || this.busy(spaceId)) return;
    if (!force && Date.now() - (this.peekedAt.get(spaceId) ?? 0) < this.t.peekGapMs) return;
    const entry = this.list?.get(spaceId);
    if (!entry || entry.ownership !== "agent" || !this.owners.has(spaceId)) return;
    this.peekedAt.set(spaceId, Date.now());
    void this.startRun("peek", spaceId)
      .then((run) => {
        this.peeks.set(spaceId, run);
        const end = run.onEnd;
        run.onEnd = () => {
          end();
          if (this.peeks.get(spaceId) === run) this.peeks.delete(spaceId);
        };
        run.onMessage = (m) => {
          if (m.t === "tabs" && Array.isArray(m.pages)) {
            this.pages.set(spaceId, cleanPages(m.pages));
            this.publish();
            run.close();
          } else if (m.t === "gone") run.close();
        };
        const timer = setTimeout(() => run.close(), this.t.readyMs);
        timer.unref?.();
      })
      .catch(() => undefined);
  }

  private cancelPeeks(): void {
    for (const run of [...this.peeks.values()]) run.close();
    this.peeks.clear();
  }

  // ------------------------------------------------------------ bots' browser commands

  /**
   * A bot (or one of its helpers) started a command that runs ego-browser. `threadId` is where its
   * row goes: the turn's thread, or for a helper the thread where the helper's row stands.
   */
  commandStart(c: { key: string; botId: string; threadId: string; turnKey: string; command: string; botDir: string }): void {
    if (this.stopping || !this.driver || this.driver.problem()) return;
    let text = c.command;
    const dirs = cdDirsOf(c.command, c.botDir);
    for (const file of scriptFilesOf(c.command)) {
      const script = readScript(file, c.botDir, dirs);
      if (script) text += `\n${script}`;
    }
    const claims = claimsOf(text);
    // The person's own workspace is never tied to a bot, even if a script names it.
    const names = claims.names.filter((n) => n !== this.ownName);
    const cmd: Cmd = { key: c.key, botId: c.botId, threadId: c.threadId, turnKey: c.turnKey, names, ids: claims.ids, spaces: new Set(), startedAt: Date.now() };
    if (this.list && this.listLive) cmd.before = new Set(this.list.keys());
    this.cmds.set(c.key, cmd);
    // A peek in a workspace the bot is about to work in would make it miss a popup.
    this.cancelPeeks();
    this.need();
    this.updateRate();
    this.resolveClaims(cmd);
    this.publish();
    void this.ensureLister(true).then(() => this.updateRate());
  }

  /** The command ended. Workspaces it made without naming them are found by comparing the list before and after. */
  commandEnd(key: string): void {
    const cmd = this.cmds.get(key);
    if (!cmd) return;
    cmd.endedAt = Date.now();
    const finish = () => {
      this.resolveClaims(cmd);
      if (!cmd.names.length && !cmd.ids.length && cmd.before && this.list && this.listLive) {
        const fresh = [...this.list.keys()].filter((id) => !cmd.before!.has(id) && !this.owners.has(id) && this.list!.get(id)!.ownership !== "user");
        // Only when no other command without a name ran at the same time: no owner beats a wrong one.
        const overlapping = [...this.cmds.values(), ...this.recentCmds].some(
          (o) => o !== cmd && !o.names.length && !o.ids.length && o.startedAt <= (cmd.endedAt ?? Date.now()) && (o.endedAt ?? Infinity) >= cmd.startedAt,
        );
        if (!overlapping) for (const id of fresh) this.attach(cmd, id);
      }
      this.cmds.delete(key);
      this.recentCmds.push(cmd);
      const cutoff = Date.now() - 60_000;
      this.recentCmds = this.recentCmds.filter((o) => (o.endedAt ?? 0) >= cutoff).slice(-50);
      for (const id of cmd.spaces) this.peek(id, true);
      this.updateRate();
      this.need();
      this.publish();
    };
    this.publish();
    if (this.lister?.live) {
      void this.lister
        .call("list", {}, this.t.endListMs)
        .catch(() => undefined)
        .then(finish);
    } else finish();
  }

  private resolveClaims(cmd: Cmd): void {
    const list = this.list;
    if (!list) return;
    for (const id of cmd.ids) if (list.has(id) && !cmd.spaces.has(id)) this.attach(cmd, id);
    for (const name of cmd.names) {
      const matches = [...list.values()].filter((e) => e.name === name);
      if (!matches.length) continue;
      const pick = matches.length === 1 ? matches[0] : matches.find((e) => this.owners.get(e.id)?.botId === cmd.botId);
      if (pick && !cmd.spaces.has(pick.id)) this.attach(cmd, pick.id);
    }
  }

  private attach(cmd: Cmd, spaceId: number): void {
    const entry = this.list?.get(spaceId);
    if (!entry) return;
    const row = this.owners.get(spaceId);
    if (row?.kind === "you") return;
    if (!row) {
      const fresh: BrowserSpaceRow = { spaceId: String(spaceId), kind: "bot", botId: cmd.botId, name: entry.name, createdAt: now() };
      this.owners.set(spaceId, fresh);
      this.store.setBrowserSpace(fresh);
    }
    cmd.spaces.add(spaceId);
    this.cancelPeeks();
    const key = `${cmd.turnKey}|${spaceId}`;
    if (this.itemKeys.has(key)) return;
    const pages = this.pagesOf(spaceId, entry);
    const front = pages.find((p) => p.active) ?? pages[0];
    const item = this.host.addItem(cmd.botId, cmd.threadId, {
      kind: "browser",
      at: now(),
      botId: cmd.botId,
      spaceId: String(spaceId),
      name: entry.name,
      status: "open",
      ...(front ? { last: lastLine(front.title, front.url) } : {}),
    });
    if (!item || item.kind !== "browser") return;
    if (this.itemKeys.size > 5000) this.itemKeys.clear();
    this.itemKeys.set(key, item.id);
    this.openItems.set(item.id, { item, turnKey: cmd.turnKey, sentAt: Date.now() });
    this.newestItem.set(spaceId, item.id);
  }

  /** Every running command of a turn or a helper ends with it (an interrupted turn says nothing more). */
  endCommandsOf(keys: Iterable<string>): void {
    for (const k of keys) this.commandEnd(k);
  }

  // ------------------------------------------------------------ the rows' lines

  private refreshLasts(state: BrowserState): void {
    const running = new Set([...this.cmds.values()].map((c) => c.turnKey));
    for (const open of this.openItems.values()) {
      const spaceId = Number(open.item.spaceId);
      const isNewest = this.newestItem.get(spaceId) === open.item.id;
      if (!isNewest && !running.has(open.turnKey)) continue;
      const space = state.spaces.find((s) => s.id === open.item.spaceId);
      const front = space?.pages.find((p) => p.active) ?? space?.pages[0];
      if (!front) continue;
      const line = lastLine(front.title, front.url);
      if (!line || line === open.item.last) continue;
      this.sendLast(open, line);
    }
  }

  private sendLast(open: OpenItem, line: string): void {
    const wait = open.sentAt + this.t.lastMs - Date.now();
    if (wait > 0) {
      clearTimeout(open.timer);
      open.timer = setTimeout(() => {
        if (this.openItems.get(open.item.id) !== open) return;
        this.sendLast(open, line);
      }, wait);
      open.timer.unref?.();
      return;
    }
    open.sentAt = Date.now();
    open.item = { ...open.item, last: line };
    this.host.putItem(open.item);
  }

  private closeItem(open: OpenItem): void {
    clearTimeout(open.timer);
    this.openItems.delete(open.item.id);
    const spaceId = Number(open.item.spaceId);
    if (this.newestItem.get(spaceId) === open.item.id) this.newestItem.delete(spaceId);
    const closed: BrowserItem = { ...open.item, status: "closed", endedAt: now() };
    this.host.putItem(closed);
  }

  // ------------------------------------------------------------ the app's calls

  /** Looks at the browser now. Never opens the browser app when it is not running. */
  async stateFor(): Promise<BrowserState> {
    this.need();
    if (!this.driver || this.driver.problem()) {
      this.publish();
      return this.state;
    }
    if (!this.lister) {
      const running = await this.driver.running();
      if (!running) {
        this.publish();
        return this.state;
      }
      await this.ensureLister(false);
    } else if (this.listerReady) {
      await this.listerReady;
    }
    this.publish();
    return this.state;
  }

  private watchOf(conn: BrowserConn, watchId: string): Watch {
    const w = this.watches.get(watchId);
    if (!w || w.conn.id !== conn.id) throw new EngineError("not_found", "That watch is over.");
    return w;
  }

  private async available(force: boolean): Promise<void> {
    if (!this.driver || this.driver.problem()) throw this.unavailable();
    const ok = await this.ensureLister(force);
    if (!ok) throw this.unavailable();
  }

  async watch(conn: BrowserConn, p: { spaceId: string; pageId?: string; ratio?: number }): Promise<{ watchId: string; pageId: string; width: number; height: number }> {
    this.need();
    await this.available(false);
    const spaceId = Number(p.spaceId);
    const entry = Number.isInteger(spaceId) ? this.list?.get(spaceId) : undefined;
    if (!entry) throw new EngineError("not_found", BROWSER_WORDS.closedSpace);
    if (entry.ownership === "agentDelegatedToUser") throw new EngineError("unavailable", BROWSER_WORDS.handed);
    if (entry.ownership !== "agent") throw new EngineError("not_found", BROWSER_WORDS.closedSpace);
    let key = p.pageId && !p.pageId.startsWith("recent-") ? p.pageId : "front";
    const known = this.pages.get(spaceId);
    if (key !== "front" && known && !known.some((x) => x.id === key)) throw new EngineError("not_found", BROWSER_WORDS.noPage);

    const previous = this.byConn.get(conn.id);
    if (previous) this.endWatch(previous, "replaced");

    const watcher = await this.ensureWatcher(spaceId);
    const watch: Watch = { id: randomUUID(), conn, spaceId, key: "front", pageId: "", controlled: false, seq: 0, pointer: { buttons: 0 }, ratio: cleanRatio(p.ratio) };
    let first: { missing?: boolean; pageId?: string; width?: number; height?: number };
    try {
      await watcher.ready;
      // In this browser any look at a page (a picture, even reading its size) makes it the page in
      // front, so a watch that stayed on a page behind would pull it to the front at every picture
      // while the bot works in another: the two would fight over the front page. A page asked for is
      // brought to the front once, and the watch follows the front page from then on.
      if (key !== "front") {
        const shown = await watcher.run.call<{ active?: boolean }>("show", { pageId: key, front: true }).catch(() => ({ active: false }));
        if (shown?.active) key = "front";
      }
      first = await watcher.run.call("first", { key });
    } catch (err) {
      if (watcher.watches.size === 0) this.closeWatcherSoon(watcher);
      throw err instanceof EngineError ? err : this.unavailable();
    }
    if (first.missing || !first.pageId) {
      if (watcher.watches.size === 0) this.closeWatcherSoon(watcher);
      throw new EngineError("not_found", key === "front" ? BROWSER_WORDS.closedSpace : BROWSER_WORDS.noPage);
    }
    watch.pageId = first.pageId;
    watch.key = key;
    clearTimeout(watcher.closeTimer);
    watcher.watches.add(watch);
    this.watches.set(watch.id, watch);
    this.byConn.set(conn.id, watch);
    this.sendWanted(watcher);
    // The first picture at once, now that the watch is there to get it (a still page shows something too).
    void watcher.run.call("force", { pageId: watch.pageId }).catch(() => undefined);
    // What the page asks while it waits reaches a watch that starts meanwhile, right after the answer.
    const waiting = watcher.prompts.get(watch.pageId);
    if (waiting) setTimeout(() => this.watches.has(watch.id) && watcher.prompts.get(watch.pageId) === waiting && this.sendPrompt(watch, waiting), 0);
    this.updateRate();
    this.publish();
    return { watchId: watch.id, pageId: watch.pageId, width: first.width ?? 0, height: first.height ?? 0 };
  }

  unwatch(conn: BrowserConn, watchId: string): void {
    const w = this.watches.get(watchId);
    if (!w || w.conn.id !== conn.id) return;
    this.dropWatch(w);
  }

  /** The connection is gone: its watch ends quietly. */
  dropConn(conn: BrowserConn): void {
    const w = this.byConn.get(conn.id);
    if (w) this.dropWatch(w);
  }

  private dropWatch(w: Watch): void {
    this.watches.delete(w.id);
    if (this.byConn.get(w.conn.id) === w) this.byConn.delete(w.conn.id);
    const watcher = this.watchers.get(w.spaceId);
    if (watcher) {
      watcher.watches.delete(w);
      if (w.controlled) this.closeChoicesIfAlone(w.spaceId, w.pageId);
      if (watcher.watches.size === 0) this.closeWatcherSoon(watcher);
      else this.sendWanted(watcher);
    }
    this.updateRate();
    this.publish();
  }

  private endWatch(w: Watch, reason: Events["browser.ended"]["reason"]): void {
    if (!this.watches.has(w.id)) return;
    this.dropWatch(w);
    try {
      w.conn.ended({ watchId: w.id, reason });
    } catch {
      // the connection is gone
    }
  }

  control(conn: BrowserConn, watchId: string, take: boolean): { controlled: boolean } {
    const w = this.watchOf(conn, watchId);
    w.controlled = take;
    if (!take) {
      w.pointer.buttons = 0;
      this.closeChoicesIfAlone(w.spaceId, w.pageId);
    }
    this.publish();
    return { controlled: w.controlled };
  }

  async input(conn: BrowserConn, watchId: string, events: BrowserInput[]): Promise<void> {
    const w = this.watchOf(conn, watchId);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    const pageId = w.pageId;
    const dialog = watcher.dialogs.get(pageId);
    for (const action of toActions(events, w.pointer, dialog)) {
      try {
        if (action.kind === "steps") await watcher.run.call("input", { pageId, steps: action.steps });
        else {
          watcher.dialogs.delete(pageId);
          await watcher.run.call("dialog", { pageId, accept: action.accept, ...(action.text !== undefined ? { text: action.text } : {}) });
        }
      } catch (err) {
        log.debug("Input could not reach the page", err instanceof Error ? err.message : String(err));
        if (/page gone/.test(err instanceof Error ? err.message : "")) throw new EngineError("not_found", BROWSER_WORDS.noPage);
        throw this.unavailable();
      }
    }
  }

  async go(conn: BrowserConn, watchId: string, to: { url: string } | "back" | "forward" | "reload"): Promise<void> {
    const w = this.watchOf(conn, watchId);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    let args: Record<string, unknown>;
    if (typeof to === "object") {
      const url = cleanAddress(to.url);
      if (!url) throw new EngineError("bad_request", BROWSER_WORDS.badAddress);
      args = { url };
    } else args = { to };
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    try {
      await watcher.run.call("go", { pageId: w.pageId, ...args }, 30_000);
    } catch (err) {
      if (/page gone/.test(err instanceof Error ? err.message : "")) throw new EngineError("not_found", BROWSER_WORDS.noPage);
      throw new EngineError("unavailable", "The page could not be moved there.");
    }
  }

  async selection(conn: BrowserConn, watchId: string): Promise<{ text: string }> {
    const w = this.watchOf(conn, watchId);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    try {
      const r = await watcher.run.call<{ text?: unknown }>("selection", { pageId: w.pageId });
      return { text: typeof r?.text === "string" ? r.text.slice(0, 1_000_000) : "" };
    } catch {
      return { text: "" };
    }
  }

  /** Answers what the page shows outside its picture: its question, or the choices of a drop-down list. Needs control. */
  async answer(conn: BrowserConn, watchId: string, answer: Methods["browser.answer"]["params"]["answer"]): Promise<void> {
    const w = this.watchOf(conn, watchId);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    const pageId = w.pageId;
    const prompt = watcher.prompts.get(pageId);
    if (answer.kind === "dialog") {
      const dialog = watcher.dialogs.get(pageId);
      if (!dialog || prompt?.kind !== "dialog") throw new EngineError("conflict", BROWSER_WORDS.nothingAsks);
      watcher.dialogs.delete(pageId);
      const text = dialog.type === "prompt" && answer.accept ? (typeof answer.text === "string" ? answer.text.slice(0, 100_000) : dialog.defaultPrompt) : undefined;
      try {
        await watcher.run.call("dialog", { pageId, accept: !!answer.accept, ...(text !== undefined ? { text } : {}) });
      } catch (err) {
        if (/page gone/.test(err instanceof Error ? err.message : "")) throw new EngineError("not_found", BROWSER_WORDS.noPage);
        throw this.unavailable();
      }
      return;
    }
    if (prompt?.kind !== "choices") throw new EngineError("conflict", BROWSER_WORDS.nothingAsks);
    const index = typeof answer.index === "number" && Number.isInteger(answer.index) && answer.index >= 0 && answer.index < prompt.options.length ? answer.index : undefined;
    try {
      await watcher.run.call("choose", { pageId, ...(index !== undefined ? { index } : {}) });
    } catch (err) {
      if (/page gone/.test(err instanceof Error ? err.message : "")) throw new EngineError("not_found", BROWSER_WORDS.noPage);
      throw this.unavailable();
    }
    // The script says so too; the app hears it at once.
    this.setPrompt(watcher, pageId, undefined);
  }

  /** How sharp this watch's pictures need to be. The largest ratio of the watches on a page wins. */
  view(conn: BrowserConn, watchId: string, ratio: number): void {
    const w = this.watchOf(conn, watchId);
    w.ratio = cleanRatio(ratio);
    const watcher = this.watchers.get(w.spaceId);
    if (watcher) this.sendWanted(watcher);
  }

  /**
   * Shows another page of the watched workspace in this watch; control is kept. The page comes to
   * the front in the browser, as a click on its tab would, with or without control: in this browser
   * any look at a page (a picture of it, even reading its size) makes it the page in front, so it
   * cannot be shown and left behind. The watch then follows the front page, so a page that opens
   * from it is followed, and a bot that goes back to its own page is followed there instead of being
   * fought over the front page. No page: follow the front.
   */
  async pageShow(conn: BrowserConn, watchId: string, pageId: string | undefined): Promise<{ pageId: string; width: number; height: number }> {
    const w = this.watchOf(conn, watchId);
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    if (pageId !== undefined && !watcher.pages.some((x) => x.id === pageId)) throw new EngineError("not_found", BROWSER_WORDS.noPage);
    let key = "front";
    if (pageId !== undefined) {
      key = pageId;
      try {
        const r = await watcher.run.call<{ active?: boolean }>("show", { pageId, front: true });
        if (r?.active) key = "front";
      } catch (err) {
        throw this.pageError(err);
      }
    }
    if (!this.watches.has(w.id)) throw new EngineError("not_found", "That watch is over.");
    let first: { missing?: boolean; pageId?: string; width?: number; height?: number };
    try {
      first = await watcher.run.call("first", { key: pageId ?? "front" });
    } catch (err) {
      throw this.pageError(err);
    }
    if (first.missing || !first.pageId) throw new EngineError("not_found", BROWSER_WORDS.noPage);
    w.key = key;
    this.moveWatch(watcher, w, first.pageId);
    this.sendWanted(watcher);
    void watcher.run.call("force", { pageId: first.pageId }).catch(() => undefined);
    this.publish();
    return { pageId: first.pageId, width: first.width ?? 0, height: first.height ?? 0 };
  }

  /** A new page in the person's own workspace, in front, shown in this watch. Needs control. */
  async pageOpen(conn: BrowserConn, watchId: string, rawUrl: string | undefined): Promise<{ pageId: string }> {
    const w = this.watchOf(conn, watchId);
    if (this.owners.get(w.spaceId)?.kind !== "you") throw new EngineError("conflict", BROWSER_WORDS.ownPagesOnly);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    let url: string | undefined;
    if (rawUrl !== undefined && rawUrl.trim()) {
      url = cleanAddress(rawUrl);
      if (!url) throw new EngineError("bad_request", BROWSER_WORDS.badAddress);
    }
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    let r: { pageId?: string };
    try {
      r = await watcher.run.call<{ pageId?: string }>("open", url ? { url } : {}, 30_000);
    } catch {
      throw new EngineError("unavailable", "A new page could not be opened.");
    }
    const id = String(r?.pageId ?? "");
    if (!id) throw new EngineError("unavailable", "A new page could not be opened.");
    if (this.watches.has(w.id)) {
      w.key = "front";
      this.moveWatch(watcher, w, id);
      this.sendWanted(watcher);
      void watcher.run.call("force", { pageId: id }).catch(() => undefined);
    }
    this.publish();
    return { pageId: id };
  }

  /** Closes a page of the person's own workspace, never its last. Needs control. */
  async pageClose(conn: BrowserConn, watchId: string, pageId: string): Promise<void> {
    const w = this.watchOf(conn, watchId);
    if (this.owners.get(w.spaceId)?.kind !== "you") throw new EngineError("conflict", BROWSER_WORDS.ownPagesOnly);
    if (!w.controlled) throw new EngineError("conflict", BROWSER_WORDS.needControl);
    const watcher = this.watchers.get(w.spaceId);
    if (!watcher?.run.live) throw this.unavailable();
    if (!watcher.pages.some((x) => x.id === pageId)) throw new EngineError("not_found", BROWSER_WORDS.noPage);
    if (watcher.pages.length <= 1) throw new EngineError("conflict", BROWSER_WORDS.lastPage);
    // Every watch on that page goes on with the page the browser shows next.
    for (const x of watcher.watches) if (x.key === pageId) x.key = "front";
    this.sendWanted(watcher);
    try {
      await watcher.run.call("closePage", { pageId }, 20_000);
    } catch (err) {
      throw this.pageError(err);
    }
    watcher.dialogs.delete(pageId);
    watcher.prompts.delete(pageId);
    this.publish();
  }

  private pageError(err: unknown): EngineError {
    if (err instanceof EngineError) return err;
    if (/page gone/.test(err instanceof Error ? err.message : "")) return new EngineError("not_found", BROWSER_WORDS.noPage);
    return this.unavailable();
  }

  /** The watch now shows another page: what the page shows outside its picture belongs to its page. */
  private moveWatch(watcher: Watcher, w: Watch, pageId: string): void {
    if (w.pageId === pageId) return;
    const old = w.pageId;
    const had = watcher.prompts.has(old);
    w.pageId = pageId;
    w.pointer.buttons = 0;
    // Open choices of the page left behind close when nobody in control is left on it.
    if (w.controlled && old) this.closeChoicesIfAlone(w.spaceId, old);
    const now = watcher.prompts.get(pageId);
    if (now || had) this.sendPrompt(w, now);
  }

  async own(p: { url?: string }): Promise<{ space: BrowserSpace }> {
    this.need();
    let url: string | undefined;
    if (p.url !== undefined) {
      url = cleanAddress(p.url);
      if (!url) throw new EngineError("bad_request", BROWSER_WORDS.badAddress);
    }
    await this.available(true);
    let r: { spaceId?: number };
    try {
      r = await this.lister!.call<{ spaceId?: number }>("own", url ? { url } : {}, 30_000);
    } catch {
      throw new EngineError("unavailable", "Your page could not be opened in the browser.");
    }
    const spaceId = Number(r?.spaceId);
    if (!Number.isInteger(spaceId) || spaceId === 0) throw new EngineError("unavailable", "Your page could not be opened in the browser.");
    const row: BrowserSpaceRow = { spaceId: String(spaceId), kind: "you", name: BROWSER_WORDS.ownName, createdAt: this.owners.get(spaceId)?.createdAt ?? now() };
    this.owners.set(spaceId, row);
    this.store.setBrowserSpace(row);
    if (!this.list?.has(spaceId)) await this.lister?.call("list", {}, this.t.endListMs).catch(() => undefined);
    this.peek(spaceId, true);
    this.publish();
    const space = this.state.spaces.find((s) => s.id === String(spaceId));
    return { space: space ?? { id: String(spaceId), name: BROWSER_WORDS.ownName, owner: "you", pages: [], busy: false, controlled: false } };
  }

  async close(p: { spaceId: string }): Promise<void> {
    const spaceId = Number(p.spaceId);
    const row = this.owners.get(spaceId);
    if (!row || row.kind !== "you") throw new EngineError("conflict", BROWSER_WORDS.notYours);
    await this.available(false);
    const watcher = this.watchers.get(spaceId);
    if (watcher) {
      for (const w of [...watcher.watches]) this.endWatch(w, "closed");
      this.closeWatcher(watcher);
    }
    try {
      await this.lister!.call("close", { spaceId }, 30_000);
    } catch {
      throw new EngineError("unavailable", "Your page could not be closed.");
    }
    this.owners.delete(spaceId);
    this.store.removeBrowserSpace(String(spaceId));
    this.pages.delete(spaceId);
    this.publish();
  }

  // ------------------------------------------------------------ watchers

  private async ensureWatcher(spaceId: number): Promise<Watcher> {
    const existing = this.watchers.get(spaceId);
    if (existing && !existing.run.ended) {
      clearTimeout(existing.closeTimer);
      return existing;
    }
    const run = await this.startRun("watcher", spaceId).catch(() => {
      throw this.unavailable();
    });
    const watcher: Watcher = { run, spaceId, watches: existing?.watches ?? new Set(), pages: [], dialogs: new Map(), prompts: new Map(), restarts: existing?.restarts ?? 0, ready: Promise.resolve(), wanted: "" };
    this.watchers.set(spaceId, watcher);
    this.bindWatcher(watcher);
    return watcher;
  }

  private bindWatcher(watcher: Watcher): void {
    const run = watcher.run;
    let goneReason: string | undefined;
    watcher.ready = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectReady(this.unavailable());
        }
      }, this.t.readyMs);
      timer.unref?.();
      run.onMessage = (m) => {
        if (m.t === "ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolveReady();
        } else if (m.t === "gone") {
          goneReason = String(m.reason ?? "closed");
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            rejectReady(goneReason === "handed" ? new EngineError("unavailable", BROWSER_WORDS.handed) : new EngineError("not_found", BROWSER_WORDS.closedSpace));
          }
        }
        this.onWatcherMessage(watcher, m);
      };
      run.ready(this.t.readyMs).catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectReady(this.unavailable());
        }
      });
    });
    watcher.ready.catch(() => undefined);
    const end = run.onEnd;
    run.onEnd = () => {
      end();
      this.watcherEnded(watcher, goneReason);
    };
  }

  private onWatcherMessage(watcher: Watcher, m: Msg): void {
    if (this.watchers.get(watcher.spaceId) !== watcher) return;
    switch (m.t) {
      case "tabs": {
        if (!Array.isArray(m.pages)) return;
        watcher.pages = cleanPages(m.pages);
        this.pages.set(watcher.spaceId, watcher.pages);
        const front = watcher.pages.find((p) => p.active) ?? watcher.pages[0];
        let moved = false;
        for (const w of [...watcher.watches]) {
          // A page shown in a watch that closes: the watch goes on with the page in front (the row of
          // pages stays; nothing is "closed" while the workspace is open).
          if (w.key !== "front" && !watcher.pages.some((p) => p.id === w.key)) {
            if (!front) {
              this.endWatch(w, "closed");
              continue;
            }
            w.key = "front";
            moved = true;
          }
          if (w.key === "front" && front && front.id !== w.pageId) this.moveWatch(watcher, w, front.id);
        }
        if (moved) this.sendWanted(watcher);
        this.publish();
        return;
      }
      case "frame": {
        const pageId = String(m.pageId ?? "");
        if (!pageId || typeof m.data !== "string" || !m.data) return;
        this.sendFrame(watcher, pageId, m);
        return;
      }
      case "dialog": {
        const pageId = String(m.pageId ?? "");
        const d = m.dialog as { type?: unknown; defaultPrompt?: unknown; message?: unknown } | null;
        if (d && typeof d === "object") {
          const before = watcher.dialogs.get(pageId);
          const type = d.type === "confirm" || d.type === "prompt" ? d.type : "alert";
          const defaultText = String(d.defaultPrompt ?? "");
          watcher.dialogs.set(pageId, { type, defaultPrompt: defaultText, typed: before?.typed ?? "" });
          // A page's question is not part of the picture, and no new picture comes while it waits:
          // the app draws it over the picture.
          const prompt: BrowserPrompt = { kind: "dialog", type, message: String(d.message ?? "").slice(0, 2000), ...(type === "prompt" ? { defaultText } : {}) };
          this.setPrompt(watcher, pageId, prompt);
        } else {
          watcher.dialogs.delete(pageId);
          if (watcher.prompts.get(pageId)?.kind === "dialog") this.setPrompt(watcher, pageId, undefined);
        }
        return;
      }
      case "prompt": {
        const pageId = String(m.pageId ?? "");
        const p = m.prompt as Record<string, unknown> | null;
        if (!pageId) return;
        if (p && typeof p === "object" && p.kind === "choices" && Array.isArray(p.options)) {
          const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
          const options = (p.options as Record<string, unknown>[]).slice(0, 2000).map((o) => ({
            label: String(o?.label ?? "").slice(0, 300),
            selected: !!o?.selected,
            disabled: !!o?.disabled,
            ...(typeof o?.group === "string" ? { group: o.group.slice(0, 300) } : {}),
          }));
          this.setPrompt(watcher, pageId, { kind: "choices", x: num(p.x), y: num(p.y), width: num(p.width), height: num(p.height), options });
        } else if (watcher.prompts.get(pageId)?.kind === "choices") this.setPrompt(watcher, pageId, undefined);
        return;
      }
      case "gone": {
        const reason = m.reason === "handed" ? "gone" : "closed";
        for (const w of [...watcher.watches]) this.endWatch(w, reason);
        this.closeWatcher(watcher);
        return;
      }
    }
  }

  /** A page shows something outside its picture now, or no longer (undefined): every watch on that page hears it. */
  private setPrompt(watcher: Watcher, pageId: string, prompt: BrowserPrompt | undefined): void {
    const before = watcher.prompts.get(pageId);
    if (!prompt && !before) return;
    if (prompt && before && JSON.stringify(prompt) === JSON.stringify(before)) return;
    if (prompt) watcher.prompts.set(pageId, prompt);
    else watcher.prompts.delete(pageId);
    for (const w of watcher.watches) if (w.pageId === pageId) this.sendPrompt(w, prompt);
  }

  private sendPrompt(w: Watch, prompt: BrowserPrompt | undefined): void {
    try {
      w.conn.prompt({ watchId: w.id, ...(prompt ? { prompt } : {}) });
    } catch {
      // the connection is gone
    }
  }

  /** Open choices close when nobody in control is left to answer them. */
  private closeChoicesIfAlone(spaceId: number, pageId: string): void {
    const watcher = this.watchers.get(spaceId);
    if (!watcher || watcher.prompts.get(pageId)?.kind !== "choices") return;
    if ([...watcher.watches].some((x) => x.controlled && x.pageId === pageId)) return;
    if (watcher.run.live) void watcher.run.call("choose", { pageId }).catch(() => undefined);
    this.setPrompt(watcher, pageId, undefined);
  }

  private sendFrame(watcher: Watcher, pageId: string, m: Msg): void {
    for (const w of watcher.watches) {
      if (w.pageId !== pageId) continue;
      w.seq++;
      try {
        w.conn.frame({
          watchId: w.id,
          seq: w.seq,
          data: String(m.data),
          ...(typeof m.type === "string" && m.type !== "image/jpeg" && /^image\/(png|webp)$/.test(m.type) ? { type: m.type } : {}),
          width: Number(m.width) || 0,
          height: Number(m.height) || 0,
          pageId,
          url: String(m.url ?? ""),
          title: String(m.title ?? ""),
        });
      } catch {
        // the connection is gone
      }
    }
  }

  private sendWanted(watcher: Watcher): void {
    const keys = [...new Set([...watcher.watches].map((w) => w.key))];
    // Several watchers of one page with different ratios: the largest asked for.
    const ratios: Record<string, number> = {};
    for (const w of watcher.watches) ratios[w.key] = Math.max(ratios[w.key] ?? 0, w.ratio);
    const text = JSON.stringify([keys, ratios]);
    if (text === watcher.wanted || !watcher.run.live) return;
    watcher.wanted = text;
    void watcher.run.call("want", { keys, ratios }).catch(() => undefined);
  }

  private closeWatcherSoon(watcher: Watcher): void {
    clearTimeout(watcher.closeTimer);
    watcher.closeTimer = setTimeout(() => {
      if (watcher.watches.size === 0) this.closeWatcher(watcher);
    }, this.t.watcherGraceMs);
    watcher.closeTimer.unref?.();
  }

  private closeWatcher(watcher: Watcher): void {
    clearTimeout(watcher.closeTimer);
    if (this.watchers.get(watcher.spaceId) === watcher) this.watchers.delete(watcher.spaceId);
    watcher.run.close();
    // A bot's workspace that is no longer watched gets its pages from a peek again when needed.
    this.pages.delete(watcher.spaceId);
    this.peek(watcher.spaceId, true);
    this.publish();
  }

  private watcherEnded(watcher: Watcher, goneReason: string | undefined): void {
    if (this.watchers.get(watcher.spaceId) !== watcher) return;
    this.watchers.delete(watcher.spaceId);
    if (this.stopping || watcher.watches.size === 0 || goneReason) {
      for (const w of [...watcher.watches]) this.endWatch(w, goneReason === "handed" ? "gone" : "closed");
      this.publish();
      return;
    }
    // The helper died while someone watched: bring it back and carry on.
    if (watcher.restarts >= 2) {
      log.warn("A browser watcher ended again; the watch is over");
      for (const w of [...watcher.watches]) this.endWatch(w, "gone");
      return;
    }
    log.warn("A browser watcher ended while someone watched; starting it again");
    const delay = watcher.restarts === 0 ? 300 : 1500;
    setTimeout(() => {
      if (this.stopping) return;
      void (this.driver?.running() ?? Promise.resolve(false))
        .then((running) => (running ? this.ensureLister(true) : false))
        .then(async (ok) => {
          if (!ok) throw new Error("no browser");
          const run = await this.startRun("watcher", watcher.spaceId);
          const next: Watcher = { run, spaceId: watcher.spaceId, watches: watcher.watches, pages: watcher.pages, dialogs: new Map(), prompts: new Map(), restarts: watcher.restarts + 1, ready: Promise.resolve(), wanted: "" };
          this.watchers.set(watcher.spaceId, next);
          this.bindWatcher(next);
          await next.ready;
          this.sendWanted(next);
          for (const pageId of new Set([...next.watches].map((w) => w.pageId))) await run.call("force", { pageId }).catch(() => undefined);
          next.restarts = 0;
        })
        .catch(() => {
          const cur = this.watchers.get(watcher.spaceId);
          for (const w of [...(cur?.watches ?? watcher.watches)]) this.endWatch(w, "gone");
          if (cur) this.closeWatcher(cur);
        });
    }, delay).unref?.();
  }

  // ------------------------------------------------------------ stopping

  shutdown(): void {
    this.stopping = true;
    clearTimeout(this.idleTimer);
    for (const open of this.openItems.values()) clearTimeout(open.timer);
    for (const w of this.watchers.values()) clearTimeout(w.closeTimer);
    for (const run of [...this.runs.values()]) run.close();
    this.runs.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** For tests: helper runs that are connected now, by role. */
  liveRuns(): { role: HelperRole; spaceId?: number }[] {
    return [...this.runs.values()].filter((r) => r.live).map((r) => ({ role: r.role, ...(r.spaceId !== undefined ? { spaceId: r.spaceId } : {}) }));
  }
}

/** A viewer's ratio, kept to sensible bounds (the script takes pictures between 0.25 and 2). */
function cleanRatio(r: unknown): number {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.1, n));
}

function cleanPages(raw: unknown[]): BrowserPage[] {
  const out: BrowserPage[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const id = String(p?.id ?? "");
    if (!id) continue;
    out.push({ id, title: String(p.title ?? "").slice(0, 500), url: String(p.url ?? "").slice(0, 4000), active: !!p.active });
  }
  if (out.length && !out.some((p) => p.active)) out[0]!.active = true;
  return out;
}

