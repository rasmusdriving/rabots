// Start-up settings: command line flags, the data dir's config.json and the platform defaults.
// Flags win over the file, the file wins over the defaults.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChatSettings, FollowUp } from "../shared/protocol.js";
import { cleanPublicBase } from "./channels.js";
import { cleanPasswordRef } from "../shared/backup-settings.js";
import { log } from "./log.js";
import { readSettingsFile, type SettingsFile } from "./settings.js";

/** The fixed port of serve mode, unless --port or `port` in config.json says otherwise. */
export const SERVE_PORT = 47600;

export interface Flags {
  port?: number;
  dataDir?: string;
  botsDir?: string;
  /** --serve: serve the app window as a web page next to the socket, on a fixed port. */
  serve?: boolean;
  /** --ui-dir=PATH: where the built app window is, for serve mode. */
  uiDir?: string;
  /**
   * --push-relay=http://127.0.0.1:<port>: notifications go to this test relay instead of the push
   * services (docs/build/step-push.md, 17). Only that exact form; never from config.json or the
   * protocol, and no service file passes it.
   */
  pushRelay?: string;
  connectionTestBase?: string;
  connectionTestPeer?: string;
  /**
   * --shell: started by the desktop window (desktop/main.ts), so the window closes with the engine
   * and can be opened again. Lets a public install restart itself after an update (engine 0.34.0).
   */
  shell?: boolean;
}

/** The shape of config.json. Every field is optional. */
export interface ConfigFile {
  botsDir?: string;
  machineName?: string;
  claude?: { executable?: string; envFile?: string };
  /** The installed Codex, for bots on GPT models (step 3a). Looked for in the usual places unless named. */
  codex?: { executable?: string };
  /** Serve mode on (see Flags.serve). */
  serve?: boolean;
  /** The port in serve mode. Ignored without serve mode, where the port is picked at random. */
  port?: number;
  /** Who may open the engine from another device. */
  remote?: { allowedLogins?: string[] };
  /** The engine's address from outside, such as "https://host:10000" (https, no path), shown with hook addresses. */
  publicBase?: string;
  /** When a bot's working session is replaced by a fresh one (docs/build/step-2d.md). */
  context?: Partial<ContextSettings>;
  /** The bots' browser shown in Pobots (docs/build/step-2g.md): off, or where its command is. */
  browser?: { enabled?: boolean; executable?: string };
  /** Only the reference is saved. The former public key is preserved for older versions. */
  backup?: { publicKey?: string; publicKeySavedAt?: string; folder?: string; time?: string; passwordRef?: string; passwordRefSavedAt?: string; executable?: string };
  /**
   * Notifications when the page is not open (docs/build/step-push.md). The three switches, written
   * by the engine when the person changes them; `subject` the VAPID subject (only to be set when a
   * push service refuses the default); `titlePrefix` put in front of every title (the test copy's
   * "Test copy: ").
   */
  notify?: { needs?: boolean; note?: boolean; finished?: boolean; yourTime?: boolean; dayReady?: boolean; subject?: string; titlePrefix?: string };
  /**
   * The chat as a whole (protocol 14). `followUp`: what a message sent while a bot works does by
   * default, "steer" or "queue". Written by the engine when the person changes it in Pobots settings.
   */
  chat?: { followUp?: FollowUp };
  /** Step 7b: the settings window's settings, read from "context" (per provider), "providers", "titles" and "usage" (engine/settings.ts). */
  settings?: SettingsFile;
  /**
   * A public install's own updates (engine 0.34.0, docs/build/step-self-update.md). `repo`: the public
   * repository (the default in engine/self-update.ts); `source`: the clone Pobots runs from, when it
   * cannot be found by itself; `checkHours`: how often to look (0 is off); `branch`: "main".
   */
  updates?: { repo?: string; source?: string; checkHours?: number; branch?: string };
}

/** What a message sent while a bot works does when config.json says nothing: it steers (T3 Code's default too). */
export const FOLLOW_UP_DEFAULT: FollowUp = "steer";

/** The chat settings from what config.json held. */
export function chatConfig(file: ConfigFile["chat"]): ChatSettings {
  return { followUp: file?.followUp ?? FOLLOW_UP_DEFAULT };
}

/** Notifications as the engine uses them. */
export interface NotifyConfig {
  kinds: { needs: boolean; note: boolean; finished: boolean; yourTime: boolean; dayReady: boolean };
  /** The VAPID subject from config.json, when one is set. */
  subject?: string;
  /** In front of every title. "" on the real Pobots. */
  titlePrefix: string;
}

/** The switches when config.json says nothing: needs and note on, finished and Ahead's two off. */
export const NOTIFY_DEFAULTS: NotifyConfig["kinds"] = { needs: true, note: true, finished: false, yourTime: false, dayReady: false };

/** The notifications' settings from what config.json held. */
export function notifyConfig(file: ConfigFile["notify"]): NotifyConfig {
  return {
    kinds: {
      needs: file?.needs ?? NOTIFY_DEFAULTS.needs,
      note: file?.note ?? NOTIFY_DEFAULTS.note,
      finished: file?.finished ?? NOTIFY_DEFAULTS.finished,
      yourTime: file?.yourTime ?? NOTIFY_DEFAULTS.yourTime,
      dayReady: file?.dayReady ?? NOTIFY_DEFAULTS.dayReady,
    },
    ...(file?.subject ? { subject: file.subject } : {}),
    titlePrefix: file?.titlePrefix ?? "",
  };
}

/** The only form --push-relay takes: http, loopback, a port. Returns the address, or undefined. */
export function cleanRelay(value: string): string | undefined {
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value);
  if (!m) return undefined;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://127.0.0.1:${port}`;
}

/** The nightly backup's settings as the engine uses them. */
export interface BackupConfig {
  /** Where the files go, absolute. Empty when none may be used; `folderProblem` then says why. */
  folder: string;
  folderProblem?: string;
  /** "03:00". */
  time: string;
  passwordRef?: string;
  passwordRefSavedAt?: string;
  executable?: string;
  migrated?: boolean;
  /** The former public key is readable for compatibility. */
  publicKey?: string;
  publicKeySavedAt?: string;
}

/** Where the real Pobots puts its backups unless config.json says otherwise. */
export function defaultBackupFolder(): string {
  return join(iCloudDriveFolder(), "Pobots Backup");
}

export function iCloudDriveFolder(): string {
  return join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
}

export const legacyOneDrive = (): string => join(homedir(), "Library", "CloudStorage", "OneDrive-Personal");

/** Resolve existing ancestors too, so aliases cannot bypass the backup destination checks. */
export function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? resolve(path) : join(resolvedPath(parent), basename(path));
  }
}

export function insidePath(path: string, root: string): boolean {
  const comparable = (value: string) => process.platform === "darwin" ? resolvedPath(value).normalize("NFC").toLowerCase() : resolvedPath(value);
  const rel = relative(comparable(root), comparable(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The daily time of the backup unless config.json says otherwise. */
export const BACKUP_TIME = "03:00";

/** When a bot's working session behind its main chat is replaced by a fresh one. */
export interface ContextSettings {
  /** Fresh starts on or off. */
  enabled: boolean;
  /** A session smaller than this is not worth a tidy turn before the cache goes cold or after a long quiet. */
  minTokens: number;
  /** Right after a turn, a session that holds at least this share of the window is tidied at once. */
  fullFraction: number;
  /**
   * The same in tokens, whichever comes first. Some models hold a million tokens; a session is slow
   * and costly to read long before that, so the share of the window alone would come far too late.
   */
  fullTokens: number;
  /** How long before the cache goes cold the tidy turn begins, in minutes. */
  warmMarginMinutes: number;
  /** A session not sent to the model for this many hours is tidied, cache or not. */
  coldHours: number;
  /**
   * The size at which the harness itself summarises a conversation in the middle of work (Claude
   * Code's auto-compact window, Codex's model_auto_compact_token_limit). A helper works under it,
   * and a bot itself in one very long turn. Not a fresh start: the same session carries on.
   */
  compactTokens: number;
  /** When set, the cache's life in minutes, instead of what the requests report. For tests. */
  cacheMinutes?: number;
}

// minTokens: a fresh session already holds about 45 000 tokens (system prompt, tools, job, memory),
// so below about 50 000 a fresh start costs more than it saves; 100 000 leaves a clear gain.
export const CONTEXT_DEFAULTS: ContextSettings = { enabled: true, minTokens: 100000, fullFraction: 0.75, fullTokens: 300000, warmMarginMinutes: 8, coldHours: 4, compactTokens: 300000 };

/**
 * The smallest and largest size the setting takes. Claude Code itself takes 100,000 to 1,000,000,
 * but a fresh helper already holds about 54,000 tokens (its instructions and tools) and about
 * 76,000 right after a summary: tried on the test copy on 14 Nov 2026, at 100,000 a helper that
 * read files was summarised three times in a row and Claude Code stopped it ("Autocompact is
 * thrashing"); at 150,000 the same helper was summarised twice, at about 126,000, and finished.
 */
export const COMPACT_MIN = 150_000;
export const COMPACT_MAX = 1_000_000;

/**
 * The built-in size at which each provider summarises by itself, when config.json does not set one
 * for all providers (15 Nov 2026, docs/decisions.md): 500,000 for Claude ("i don't think having
 * compaction at 300k is the best if we can only set one limit lets do that at 500k"), 300,000 for
 * Codex (the GPT model tried holds 258,400). CONTEXT_DEFAULTS.compactTokens is Codex's, used only as
 * the value a config.json without the key reads as.
 */
export const COMPACT_DEFAULTS: Record<"claude" | "codex", number> = { claude: 500_000, codex: 300_000 };

/** The size at which a session is tidied right after a turn: the share of the window or the token limit, whichever is smaller. */
export function fullAt(cfg: ContextSettings, window: number): number {
  return Math.min(cfg.fullFraction * window, cfg.fullTokens);
}

/**
 * The "context" part of config.json. Every field is optional; a bad value falls back to its default
 * with a warning in the log, so a typo never stops the engine.
 */
export function cleanContext(raw: unknown, where = "config.json", warn: (message: string) => void = (m) => log.warn(m)): ContextSettings {
  const out: ContextSettings = { ...CONTEXT_DEFAULTS };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`"context" in ${where} must hold an object. Using the defaults.`);
    return out;
  }
  const obj = raw as Record<string, unknown>;
  const num = (key: keyof ContextSettings, ok: (n: number) => boolean, rule: string) => {
    const v = obj[key];
    if (v === undefined) return;
    if (typeof v === "number" && Number.isFinite(v) && ok(v)) (out as unknown as Record<string, unknown>)[key] = v;
    else warn(`"context.${key}" in ${where} must be ${rule}. Using ${String((CONTEXT_DEFAULTS as unknown as Record<string, unknown>)[key] ?? "what the requests report")}.`);
  };
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
    else warn(`"context.enabled" in ${where} must be true or false. Using true.`);
  }
  num("minTokens", (n) => Number.isInteger(n) && n >= 0 && n <= 10_000_000, "a whole number of tokens, 0 or more");
  num("fullFraction", (n) => n > 0 && n <= 1, "a share of the window above 0 and at most 1, such as 0.75");
  num("fullTokens", (n) => Number.isInteger(n) && n >= 1000 && n <= 10_000_000, "a whole number of tokens, 1000 or more");
  num("warmMarginMinutes", (n) => n >= 0 && n <= 120, "a number of minutes from 0 to 120");
  num("coldHours", (n) => n > 0 && n <= 24 * 30, "a number of hours above 0, at most 720");
  num("compactTokens", (n) => Number.isInteger(n) && n >= COMPACT_MIN && n <= COMPACT_MAX, "a whole number of tokens from 150000 to 1000000");
  num("cacheMinutes", (n) => n > 0 && n <= 24 * 60, "a number of minutes above 0, at most 1440");
  return out;
}

export interface EngineConfig {
  /** 0 means any free port. */
  port: number;
  dataDir: string;
  botsDir: string;
  machineName: string;
  claude: { executable?: string; envFile?: string };
  /** The installed Codex. Optional so older callers and tests need not name it. */
  codex?: { executable?: string };
  serve: boolean;
  /** Set from --ui-dir only; main.ts falls back to the folder next to the engine bundle. */
  uiDir?: string;
  /** Tailscale logins allowed in, trimmed. Empty means remote access is off. */
  remote: { allowedLogins: string[] };
  /** The engine's address from outside, when config.json sets one. */
  publicBase?: string;
  /** Fresh starts of the bots' sessions. The defaults when left out. */
  context?: ContextSettings;
  /** The bots' browser. On unless switched off; the command is looked for in the usual places unless named. */
  browser?: { enabled: boolean; executable?: string };
  /** The nightly backup. Left out (as in tests), no folder is set and no backup can run. */
  backup?: BackupConfig;
  /** Notifications. Left out (as in tests): the defaults, no prefix. */
  notify?: NotifyConfig;
  /** The chat settings (protocol 14). Left out (as in tests): the defaults. */
  chat?: ChatSettings;
  /** Step 7b: the settings window's settings. Left out (as in tests): the defaults, with `context` for all providers. */
  settings?: SettingsFile;
  /** --shell (Flags.shell). */
  shell?: boolean;
  /** config.json's "updates", as read. Left out (as in tests): the defaults. */
  updates?: ConfigFile["updates"];
}

const validPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535;

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const name = m[1]!;
    let value = m[2];
    if (name === "push-relay") {
      // Only "--push-relay=http://127.0.0.1:<port>": never the next argument, never another host.
      const relay = m[2] === undefined ? undefined : cleanRelay(m[2]);
      if (!relay) throw new Error('"--push-relay" takes only the form --push-relay=http://127.0.0.1:<port>.');
      flags.pushRelay = relay;
      continue;
    }
    if (name === "connections-test-base" || name === "connections-test-peer") {
      const port = /^http:\/\/127\.0\.0\.1:(\d{5})$/.exec(m[2] ?? "")?.[1];
      if (!port || Number(port) < 10240 || Number(port) > 65535 || port === "47600") {
        throw new Error("Connection test addresses must be loopback ports reserved for this test.");
      }
      if (name === "connections-test-base") flags.connectionTestBase = m[2];
      else flags.connectionTestPeer = m[2];
      continue;
    }
    if (name === "shell") {
      // A switch, like --serve without a value.
      flags.shell = m[2] === undefined || /^(true|1)$/i.test(m[2]);
      continue;
    }
    if (name === "serve") {
      // A switch: it never takes the next argument as its value.
      if (m[2] === undefined) {
        flags.serve = true;
        continue;
      }
      if (!/^(true|false|1|0)$/i.test(m[2])) throw new Error(`"--serve=${m[2]}" must be true or false.`);
      flags.serve = /^(true|1)$/i.test(m[2]);
      continue;
    }
    if (value === undefined && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) value = argv[++i];
    if (value === undefined) continue;
    if (name === "port") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`The port "${value}" is not a valid port number.`);
      flags.port = n;
    } else if (name === "data-dir") flags.dataDir = resolve(expandHome(value));
    else if (name === "bots-dir") flags.botsDir = resolve(expandHome(value));
    else if (name === "ui-dir") flags.uiDir = resolve(expandHome(value));
  }
  return flags;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "Pobots");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Pobots");
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "pobots-engine");
}

export function defaultBotsDir(): string {
  return join(homedir(), "Pobots", "bots");
}

/** Reads config.json in the data dir, creating it with defaults when it is missing. */
export function loadConfigFile(dataDir: string): ConfigFile {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) {
    const initial: ConfigFile = { claude: {} };
    writeFileSync(path, JSON.stringify(initial, null, 2) + "\n");
    return initial;
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The settings file ${path} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`The settings file ${path} must hold an object.`);
  const obj = parsed as Record<string, unknown>;
  const out: ConfigFile = {};
  if (typeof obj.botsDir === "string" && obj.botsDir) out.botsDir = obj.botsDir;
  if (typeof obj.machineName === "string" && obj.machineName.trim()) out.machineName = obj.machineName.trim();
  const claude = obj.claude && typeof obj.claude === "object" ? (obj.claude as Record<string, unknown>) : {};
  out.claude = {};
  if (typeof claude.executable === "string" && claude.executable) out.claude.executable = claude.executable;
  if (typeof claude.envFile === "string" && claude.envFile) out.claude.envFile = claude.envFile;
  if (obj.codex !== undefined) {
    if (!obj.codex || typeof obj.codex !== "object" || Array.isArray(obj.codex)) throw new Error(`"codex" in ${path} must hold an object.`);
    const exe = (obj.codex as Record<string, unknown>).executable;
    if (exe !== undefined && (typeof exe !== "string" || !exe)) throw new Error(`"codex.executable" in ${path} must be the path of the codex command.`);
    out.codex = typeof exe === "string" ? { executable: exe } : {};
  }

  if (obj.serve !== undefined) {
    if (typeof obj.serve !== "boolean") throw new Error(`"serve" in ${path} must be true or false.`);
    out.serve = obj.serve;
  }
  if (obj.port !== undefined) {
    if (!validPort(obj.port)) throw new Error(`"port" in ${path} is not a valid port number.`);
    out.port = obj.port;
  }
  if (obj.remote !== undefined) {
    if (!obj.remote || typeof obj.remote !== "object" || Array.isArray(obj.remote)) throw new Error(`"remote" in ${path} must hold an object.`);
    const logins = (obj.remote as Record<string, unknown>).allowedLogins;
    if (logins !== undefined && (!Array.isArray(logins) || !logins.every((l) => typeof l === "string"))) {
      throw new Error(`"remote.allowedLogins" in ${path} must be a list of Tailscale logins.`);
    }
    out.remote = { allowedLogins: ((logins as string[] | undefined) ?? []).map((l) => l.trim()).filter(Boolean) };
  }
  if (obj.publicBase !== undefined) {
    const base = typeof obj.publicBase === "string" ? cleanPublicBase(obj.publicBase) : undefined;
    if (!base) throw new Error(`"publicBase" in ${path} must be an https:// address with no path, such as https://host:10000.`);
    out.publicBase = base;
  }
  if (obj.context !== undefined) out.context = cleanContext(obj.context, path);
  if (obj.browser !== undefined) {
    if (!obj.browser || typeof obj.browser !== "object" || Array.isArray(obj.browser)) throw new Error(`"browser" in ${path} must hold an object.`);
    const b = obj.browser as Record<string, unknown>;
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new Error(`"browser.enabled" in ${path} must be true or false.`);
    if (b.executable !== undefined && (typeof b.executable !== "string" || !b.executable)) throw new Error(`"browser.executable" in ${path} must be the path of the ego-browser command.`);
    out.browser = { ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}), ...(typeof b.executable === "string" ? { executable: b.executable } : {}) };
  }
  // A bad value here never stops the engine: the backup then says what is wrong. Values are never logged.
  if (obj.backup !== undefined) {
    if (!obj.backup || typeof obj.backup !== "object" || Array.isArray(obj.backup)) log.warn(`"backup" in ${path} must hold an object. Ignoring it.`);
    else {
      const b = obj.backup as Record<string, unknown>;
      const keep: NonNullable<ConfigFile["backup"]> = {};
      if (typeof b.publicKey === "string" && b.publicKey.trim()) keep.publicKey = b.publicKey.trim();
      else if (b.publicKey !== undefined) log.warn(`"backup.publicKey" in ${path} is not a key line. Ignoring it.`);
      if (typeof b.publicKeySavedAt === "string" && Number.isFinite(Date.parse(b.publicKeySavedAt))) keep.publicKeySavedAt = b.publicKeySavedAt;
      const passwordRef = typeof b.passwordRef === "string" && cleanPasswordRef(b.passwordRef);
      if (passwordRef) keep.passwordRef = passwordRef;
      if (typeof b.passwordRefSavedAt === "string" && Number.isFinite(Date.parse(b.passwordRefSavedAt))) keep.passwordRefSavedAt = b.passwordRefSavedAt;
      if (typeof b.executable === "string") keep.executable = expandHome(b.executable.trim());
      // A folder that is set but empty or not a path is kept as "" (never the default folder): the
      // backup then refuses to run and says why, instead of quietly using the real Pobots' folder.
      if (typeof b.folder === "string" && b.folder.trim()) keep.folder = b.folder.trim();
      else if (b.folder !== undefined) {
        keep.folder = "";
        log.warn(`"backup.folder" in ${path} must be the full path of a folder. No backup runs until it is.`);
      }
      if (typeof b.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time.trim())) keep.time = b.time.trim();
      else if (b.time !== undefined) log.warn(`"backup.time" in ${path} must be a time such as 03:00. Using ${BACKUP_TIME}.`);
      out.backup = keep;
    }
  }
  // Notifications: a bad value never stops the engine; it falls back to the default with a warning.
  if (obj.notify !== undefined) {
    if (!obj.notify || typeof obj.notify !== "object" || Array.isArray(obj.notify)) log.warn(`"notify" in ${path} must hold an object. Using the defaults.`);
    else {
      const n = obj.notify as Record<string, unknown>;
      const keep: NonNullable<ConfigFile["notify"]> = {};
      for (const k of ["needs", "note", "finished", "yourTime", "dayReady"] as const) {
        if (typeof n[k] === "boolean") keep[k] = n[k];
        else if (n[k] !== undefined) log.warn(`"notify.${k}" in ${path} must be true or false. Using ${String(NOTIFY_DEFAULTS[k])}.`);
      }
      if (typeof n.subject === "string" && /^(mailto:[^@\s]+@[^@\s]+|https:\/\/[^\s]+)$/.test(n.subject.trim())) keep.subject = n.subject.trim();
      else if (n.subject !== undefined) log.warn(`"notify.subject" in ${path} must be a "mailto:" or "https:" address. Using the default.`);
      if (typeof n.titlePrefix === "string" && n.titlePrefix.length <= 40 && !/[\r\n]/.test(n.titlePrefix)) keep.titlePrefix = n.titlePrefix;
      else if (n.titlePrefix !== undefined) log.warn(`"notify.titlePrefix" in ${path} must be a short line of text. Using none.`);
      out.notify = keep;
    }
  }
  // The chat settings: a bad value never stops the engine; it falls back to the default with a warning.
  if (obj.chat !== undefined) {
    if (!obj.chat || typeof obj.chat !== "object" || Array.isArray(obj.chat)) log.warn(`"chat" in ${path} must hold an object. Using the defaults.`);
    else {
      const c = obj.chat as Record<string, unknown>;
      const keep: NonNullable<ConfigFile["chat"]> = {};
      if (c.followUp === "steer" || c.followUp === "queue") keep.followUp = c.followUp;
      else if (c.followUp !== undefined) log.warn(`"chat.followUp" in ${path} must be "steer" or "queue". Using ${FOLLOW_UP_DEFAULT}.`);
      out.chat = keep;
    }
  }
  // A public install's updates: a bad value never stops the engine; it falls back with a warning.
  if (obj.updates !== undefined) {
    if (!obj.updates || typeof obj.updates !== "object" || Array.isArray(obj.updates)) log.warn(`"updates" in ${path} must hold an object. Using the defaults.`);
    else {
      const u = obj.updates as Record<string, unknown>;
      const keep: NonNullable<ConfigFile["updates"]> = {};
      if (typeof u.repo === "string" && u.repo.trim()) keep.repo = u.repo.trim();
      else if (u.repo !== undefined) log.warn(`"updates.repo" in ${path} must be the address of a git repository. Using the default.`);
      if (typeof u.source === "string" && u.source.trim()) keep.source = u.source.trim();
      else if (u.source !== undefined) log.warn(`"updates.source" in ${path} must be the full path of a folder. Ignoring it.`);
      if (typeof u.checkHours === "number" && Number.isFinite(u.checkHours) && u.checkHours >= 0 && u.checkHours <= 24 * 7) keep.checkHours = u.checkHours;
      else if (u.checkHours !== undefined) log.warn(`"updates.checkHours" in ${path} must be a number of hours from 0 to 168. Using the default.`);
      if (typeof u.branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(u.branch) && !u.branch.includes("..")) keep.branch = u.branch;
      else if (u.branch !== undefined) log.warn(`"updates.branch" in ${path} must be a branch name. Using main.`);
      out.updates = keep;
    }
  }
  out.settings = readSettingsFile(obj, out.context as ContextSettings | undefined, path);
  return out;
}

/**
 * The backup's settings. The default folder is only for the real Pobots on its own data folder:
 * any other data folder (the test copy, a trial, a test) must name a folder of its own in
 * config.json, and may never name the default one, so it can never remove or replace the real
 * Pobots' files.
 */
export function backupConfig(dataDir: string, file: ConfigFile["backup"], defaults: { dataDir: string; folder: string } = { dataDir: defaultDataDir(), folder: defaultBackupFolder() }): BackupConfig {
  const time = file?.time ?? BACKUP_TIME;
  const { folder: _folder, time: _time, ...key } = file ?? {};
  const isDefaultData = samePath(dataDir, defaults.dataDir);
  const old = file?.folder && resolve(expandHome(file.folder));
  if (old && insidePath(old, legacyOneDrive())) {
    if (isDefaultData) return { ...key, folder: defaults.folder, time, migrated: true, passwordRef: undefined, passwordRefSavedAt: undefined };
    return { ...key, folder: "", folderProblem: "Set a separate backup folder for this Pobots.", time };
  }
  // Absent: the default folder, for the real Pobots only.
  if (file?.folder === undefined) {
    if (isDefaultData) return { folder: defaults.folder, time, ...key };
    return { folder: "", folderProblem: "No backup folder is set for this Pobots.", time, ...key };
  }
  // Present but empty or not a full path: never the default, no backup runs.
  const expanded = expandHome(file.folder.trim());
  if (!expanded || !isAbsolute(expanded)) return { folder: "", folderProblem: BAD_FOLDER_SETTING, time, ...key };
  const folder = resolve(expanded);
  if (!isDefaultData && (insidePath(folder, defaults.folder) || insidePath(defaults.folder, folder))) {
    return { folder, folderProblem: "This Pobots may not use the backup folder of the main Pobots. Set a folder of its own.", time, ...key };
  }
  return { folder, time, ...key };
}

export const BAD_FOLDER_SETTING = "The backup folder in config.json is empty or not a full path, so no backup runs. Set the full path of a folder there.";

/** Whether two paths name the same place, through links where they exist. */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return resolve(a) === resolve(b) || real(a) === real(b);
}

/**
 * Changes one part of config.json ("backup", "notify" or "chat") and nothing else, safely: the file is read
 * as it is now, every other key is kept as it was, the new text goes to a temporary file in the same
 * folder that is flushed to disk and then renamed over config.json. The file keeps its mode, without
 * any bits for others (600 when it is new). A key set to undefined in `patch` is removed. Throws a
 * plain sentence when the file cannot be read or written; config.json is then untouched.
 */
export function writeConfigPart<K extends "backup" | "notify" | "chat" | "context" | "providers" | "titles" | "usage">(dataDir: string, part: K, patch: Record<string, unknown>): void {
  const path = join(dataDir, "config.json");
  let obj: Record<string, unknown> = {};
  let mode = 0o600;
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
      mode = statSync(path).mode & 0o700;
    } catch {
      throw new Error("The settings file could not be read, so nothing was saved.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The settings file could not be read, so nothing was saved.");
    obj = parsed as Record<string, unknown>;
  }
  if (!(mode & 0o600)) mode = 0o600;
  const current = obj[part];
  const before = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const next: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  obj[part] = next;
  const tmp = join(dataDir, `config.json.${randomBytes(6).toString("hex")}.pobots-tmp`);
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, JSON.stringify(obj, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    throw new Error("The settings file could not be written, so nothing was saved.");
  }
}

/** Changes the "backup" part of config.json and nothing else (see writeConfigPart). */
export function writeBackupSettings(dataDir: string, patch: Partial<NonNullable<ConfigFile["backup"]>>): void {
  writeConfigPart(dataDir, "backup", patch);
}

export function resolveConfig(flags: Flags): EngineConfig {
  const dataDir = flags.dataDir ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const file = loadConfigFile(dataDir);
  const botsDir = flags.botsDir ?? (file.botsDir ? resolve(expandHome(file.botsDir)) : defaultBotsDir());
  mkdirSync(botsDir, { recursive: true });
  const serve = flags.serve ?? file.serve ?? false;
  return {
    // Without serve mode the port is picked at random, exactly as before; config.json's port is for serve mode.
    port: flags.port ?? (serve ? (file.port ?? SERVE_PORT) : 0),
    dataDir,
    botsDir,
    machineName: file.machineName ?? defaultMachineName(),
    claude: {
      executable: file.claude?.executable ? resolve(expandHome(file.claude.executable)) : undefined,
      envFile: file.claude?.envFile ? resolve(expandHome(file.claude.envFile)) : undefined,
    },
    codex: file.codex?.executable ? { executable: resolve(expandHome(file.codex.executable)) } : {},
    serve,
    uiDir: flags.uiDir,
    remote: { allowedLogins: file.remote?.allowedLogins ?? [] },
    ...(file.publicBase ? { publicBase: file.publicBase } : {}),
    context: cleanContext(file.context),
    browser: {
      enabled: file.browser?.enabled ?? true,
      ...(file.browser?.executable ? { executable: resolve(expandHome(file.browser.executable)) } : {}),
    },
    backup: backupConfig(dataDir, file.backup),
    notify: notifyConfig(file.notify),
    chat: chatConfig(file.chat),
    ...(file.settings ? { settings: file.settings } : {}),
    ...(flags.shell ? { shell: true } : {}),
    ...(file.updates ? { updates: { ...file.updates, ...(file.updates.source ? { source: resolve(expandHome(file.updates.source)) } : {}) } } : {}),
  };
}

/** The name the person gave the computer where the system has one, else the host name without its network ending. */
function defaultMachineName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall through to the host name
    }
  }
  return hostname().replace(/\.(local|localdomain|lan|home)$/i, "") || "This computer";
}
