// The nightly backup (docs/build/step-backup.md; groundwork in docs/build/notes-backup-groundwork.md).
//
// Every night at 03:00 (and by hand, "Back up now") the engine packs a consistent copy of the
// database, config.json, a manifest and every bot's folder into one file, locks it to the person's
// RSA public key (engine/backup-format.ts) and puts it into the backup folder, which a cloud drive
// (OneDrive) syncs. Then it reads the Mac's upload state for the file until the cloud drive has
// taken it, and keeps the newest 14 files of its own in that folder.
//
// What never happens here:
// - The engine never holds a private key. A pasted private key is refused and never kept or logged.
// - Nothing in the folder is deleted except files whose whole name is a backup name, and only after
//   tonight's file is there; never a folder, never a link, never anything elsewhere.
// - The engine's thread is never held: the database copy is SQLite's online backup, the packing is
//   `tar` in a child process, the rest is streams.
// - A stop never leaves half a file: the file is made in the data folder and renamed into place.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, link as fsLink, lstat, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { BackupRun, BackupState } from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { BackupFormatError, lockStream, parsePublicKeyLine, type PublicKeyInfo } from "./backup-format.js";
import { BACKUP_TIME, samePath, writeBackupSettings, type BackupConfig } from "./config.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";
import { atWords, instantFor, nextAfter, parseHm, wallOf } from "./schedule.js";

/** The whole name of a backup file. Only files whose whole name matches are ever deleted. */
export const BACKUP_NAME = /^pobots-backup-\d{4}-\d{2}-\d{2}T\d{4}\.pobotsbackup$/;
/** How many nights are kept. */
export const KEEP = 14;
/** A single file in a bot's folder bigger than this is left out (and named in the run). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Names left out wherever they are in the bots' folder. */
const LEFT_OUT = new Set(["node_modules", ".DS_Store", "bot.json.tmp"]);

export const UNCONFIRMED = "OneDrive did not take the file. Is OneDrive running and signed in on the Mac?";
/** The folder is missing or cannot be written: what to check, in his words. */
export const CANNOT_WRITE = "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.";
/**
 * The hidden note in a backup folder that names the data folder of the Pobots that owns it. Its name
 * never matches BACKUP_NAME. It holds no secret: a kind, the data folder's path and when it was made.
 */
export const OWNER_FILE = ".pobots-backup-owner.json";
export const OTHER_OWNER = "Another Pobots keeps its backups in this folder. Set a folder of its own for this Pobots.";
const BAD_OWNER = "The backup folder's note of which Pobots it belongs to cannot be read, so Pobots will not use that folder.";
export const MOMENT_AGO = "A backup was made a moment ago. Try again in a minute.";
const STOPPED_CHECKING = "Pobots stopped before OneDrive confirmed the file.";
const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The upload state of one file as macOS reports it (engine/upload-state.js). */
export interface UploadState {
  exists: boolean;
  ubiquitous?: boolean | null;
  uploaded?: boolean | null;
  uploading?: boolean | null;
  uploadError?: string | null;
}
/** Reads the upload state of a file; undefined when it cannot be read. */
export type UploadReader = (path: string) => Promise<UploadState | undefined>;

export interface BackupTimings {
  /** How often the upload state is read while a file's arrival is checked. */
  pollMs: number;
  /** "Uploaded" must still be so this long later. */
  holdMs: number;
  /** After this long without that, the run is unconfirmed. */
  limitMs: number;
  /** No saved backup for this long while a key is set: a card. */
  staleMs: number;
  /**
   * How long a stop waits for a run to end by itself before its child processes are killed and its
   * half-made files removed by force. Under launchd's 20 seconds before it kills the service.
   */
  stopMs: number;
}
export const BACKUP_TIMINGS: BackupTimings = { pollMs: 5000, holdMs: 60_000, limitMs: 10 * 60_000, staleMs: 48 * 3600_000, stopMs: 12_000 };

/** What the backup needs from the engine. */
export interface BackupHost {
  /** A consistent copy of the database into `path`, on the engine's own handle. */
  snapshotDb(path: string): Promise<unknown>;
  /** The bots on the roster, for the manifest. */
  bots(): { id: string; name: string }[];
  /** The state changed: a key was saved, a run began or ended. */
  changed(state: BackupState): void;
  /** Puts the one backup card on the rail, replacing one that is there. */
  showCard(title: string, text: string): void;
  /** Takes the backup card off the rail, when one is there. */
  clearCard(): void;
}

export interface BackupOptions {
  dataDir: string;
  botsDir: string;
  config: BackupConfig;
  engineVersion: string;
  /** The clock the 03:00 rule and the file names go by. */
  clock: () => number;
  tz: string;
  host: BackupHost;
  /** Defaults to engine/upload-state.js through osascript. Tests pass a stand-in. */
  readUploadState?: UploadReader;
  timings?: Partial<BackupTimings>;
  /** How the finished file gets its name in the folder without ever replacing a file (a hard link). Tests pass one that fails across volumes. */
  link?: (from: string, to: string) => Promise<void>;
  /** How the file is copied to a hidden name in the folder when it cannot be linked there. Tests pass a slow one. */
  copy?: (from: string, to: string, signal: AbortSignal) => Promise<void>;
  maxFileBytes?: number;
}

/** What the engine keeps in <dataDir>/backup.json: outside the database and outside the backup. */
interface BackupRecord {
  version: 1;
  /** Newest first, at most KEEP. */
  history: BackupRun[];
  /** A run whose file is in the folder while its arrival is checked. Survives a stop or a crash. */
  checking?: BackupRun;
  /** When the newest saved backup was made (kept apart from the history, which only holds 14 runs). */
  lastSavedAt?: string;
  /** The saved backup (or the key's saving) the "No backup for two days" card was shown for. */
  staleFor?: string;
}

/** A refusal or failure in plain words for the person. */
class Plain extends Error {}
/** The run was ended by a stop. */
class Stopped extends Error {}

const iso = (t: number) => new Date(t).toISOString();
const pad = (n: number) => String(n).padStart(2, "0");

/** "pobots-backup-2026-11-14T0300.pobotsbackup": the local date and time the run began. */
export function backupFileName(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `pobots-backup-${w.y}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}${pad(w.mi)}.pobotsbackup`;
}

/** The latest daily slot (such as 03:00 local time) at or before `now`. */
export function slotAtOrBefore(now: number, time: string, tz: string): number {
  const m = parseHm(time) ?? parseHm(BACKUP_TIME)!;
  const w = wallOf(now, tz);
  const today = instantFor(w.y, w.mo, w.d, Math.floor(m / 60), m % 60, tz);
  if (today <= now) return today;
  const y = new Date(Date.UTC(w.y, w.mo, w.d - 1));
  return instantFor(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), Math.floor(m / 60), m % 60, tz);
}

/**
 * Which of the names in a folder are to be deleted after tonight's file `tonight` was made: of the
 * names that are whole backup names, all but the newest `keep` by the date in the name. Tonight's
 * file is never among them. Pure, so it can be tested on its own.
 */
export function namesToPrune(names: string[], tonight: string, keep = KEEP): string[] {
  if (!BACKUP_NAME.test(tonight)) return [];
  const ours = [...new Set(names.filter((n) => BACKUP_NAME.test(n)))].sort().reverse();
  const kept = new Set(ours.slice(0, keep));
  kept.add(tonight);
  return ours.filter((n) => !kept.has(n));
}

/**
 * Deletes old backups in `folder` once tonight's file is there: only regular files (not folders,
 * not links) whose whole name is a backup name, all but the newest `keep`. Returns the names it
 * deleted. Never looks into any other folder.
 */
export async function pruneFolder(folder: string, tonight: string, keep = KEEP): Promise<string[]> {
  if (!BACKUP_NAME.test(tonight)) return [];
  const made = await lstat(join(folder, tonight)).catch(() => undefined);
  if (!made?.isFile()) return [];
  const files: string[] = [];
  for (const name of await readdir(folder)) {
    if (!BACKUP_NAME.test(name)) continue;
    const s = await lstat(join(folder, name)).catch(() => undefined);
    if (s?.isFile()) files.push(name);
  }
  const removed: string[] = [];
  for (const name of namesToPrune(files, tonight, keep)) {
    try {
      await unlink(join(folder, name));
      removed.push(name);
    } catch (err) {
      log.warn(`Could not remove the old backup ${name}`, (err as Error).message);
    }
  }
  return removed;
}

/**
 * Everything in the bots' folder that goes into the backup, as "./<path>" names for tar, in order:
 * folders, files and links. Left out: node_modules, .DS_Store, *.pobots-tmp, bot.json.tmp, and any
 * file bigger than `maxBytes` (named in `leftOut`, by its path inside the bots' folder).
 */
export async function listBotFiles(root: string, maxBytes = MAX_FILE_BYTES): Promise<{ names: string[]; leftOut: string[] }> {
  const names: string[] = [];
  const leftOut: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch (err) {
      // A folder removed while it is read is simply not there.
      if (rel && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (LEFT_OUT.has(e.name) || e.name.endsWith(".pobots-tmp")) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        names.push(`./${path}`);
        await visit(path);
      } else if (e.isFile()) {
        const s = await lstat(join(root, path)).catch(() => undefined);
        if (!s) continue;
        if (s.size > maxBytes) leftOut.push(path);
        else names.push(`./${path}`);
      } else if (e.isSymbolicLink()) names.push(`./${path}`);
    }
  };
  // The bots' folder itself must be there: a missing one is never an empty backup.
  await visit("");
  return { names, leftOut };
}

/** The real upload state reader: engine/upload-state.js beside the engine, through osascript, never a shell. */
export function osascriptReader(script = fileURLToPath(new URL("./upload-state.js", import.meta.url))): UploadReader {
  let warned = false;
  return (path) =>
    new Promise((resolve) => {
      if (process.platform !== "darwin" || !existsSync(script)) {
        if (!warned) log.warn(`The backup cannot read upload states here (${process.platform !== "darwin" ? "not a Mac" : "the reader is missing beside the engine"}).`);
        warned = true;
        return resolve(undefined);
      }
      execFile("osascript", ["-l", "JavaScript", script, path], { timeout: 15_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err) {
          log.debug("The upload state could not be read", err.message);
          return resolve(undefined);
        }
        try {
          const parsed = JSON.parse(String(stdout).trim()) as UploadState;
          resolve(parsed && typeof parsed === "object" ? parsed : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
}

/** The promise's value, or undefined as soon as the signal is aborted (a stop never waits for a slow read). */
function unlessStopped<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const stop = () => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      () => {
        signal.removeEventListener("abort", stop);
        resolve(undefined);
      },
    );
  });
}

/** Waits, ending early when the signal is aborted. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** tar's own complaint about a file that went away between the listing and the packing. Harmless. */
const VANISHED = /^tar: \.\/.*: (Cannot stat|Couldn't open|Can't open): No such file or directory$|^tar: Error exit delayed from previous errors\.$/;

export class Backup {
  private readonly o: BackupOptions;
  private readonly t: BackupTimings;
  private readonly read: UploadReader;
  private readonly recordPath: string;
  private record: BackupRecord;
  private key?: PublicKeyInfo & { savedAt: string };
  private running = false;
  private stopping = false;
  private abort?: AbortController;
  /** Aborted by stop(): ends the looks at earlier files too. */
  private readonly stopped = new AbortController();
  private current?: Promise<void>;
  private relooking?: Promise<void>;
  private stopping$?: Promise<boolean>;
  /** The run's child processes (tar) and its half-made files, so a stop can end and remove them. */
  private readonly children = new Set<ChildProcess>();
  private readonly halfMade = new Set<string>();
  /** The nextAt last sent, so the clock can send a fresh one when the slot has passed. */
  private sentNextAt?: string;

  constructor(o: BackupOptions) {
    this.o = o;
    this.t = { ...BACKUP_TIMINGS, ...o.timings };
    this.read = o.readUploadState ?? osascriptReader();
    this.recordPath = join(o.dataDir, "backup.json");
    this.record = this.loadRecord();
    if (o.config.publicKey) {
      try {
        const info = parsePublicKeyLine(o.config.publicKey);
        this.key = { ...info, savedAt: o.config.publicKeySavedAt ?? iso(o.clock()) };
      } catch {
        // The value is never logged: it is the person's own, and could be something pasted by mistake.
        log.warn('"backup.publicKey" in config.json is not a usable public key. No backups run until a key is saved in Pobots settings.');
      }
    }
  }

  /** After the start: a run that was checking its file when Pobots stopped is kept as unconfirmed and looked at again. */
  init(): void {
    const left = this.record.checking;
    if (left) {
      this.record.checking = undefined;
      this.pushRun({ ...left, status: "unconfirmed", problem: STOPPED_CHECKING });
      this.saveRecord();
    }
    if (this.record.history.some((r) => r.status === "unconfirmed" && r.file)) {
      this.relooking = this.relook(this.stopped.signal).finally(() => (this.relooking = undefined));
    }
  }

  // ------------------------------------------------------------ the state

  state(now = this.o.clock()): BackupState {
    // While the arrival of tonight's file is checked, that file is the newest one that exists: it is
    // "unconfirmed" without a problem, so the app can say the file is made and only its arrival is
    // being checked (docs/build/notes-backup-join.md).
    const lastGood = this.record.checking ?? this.record.history.find((r) => (r.status === "saved" || r.status === "unconfirmed") && r.file);
    return {
      ...(this.key ? { key: { fingerprint: this.key.fingerprint, bits: this.key.bits, savedAt: this.key.savedAt } } : {}),
      folder: this.folderState(),
      time: this.time,
      keep: KEEP,
      ...(this.key ? { nextAt: iso(this.nextSlot(now)) } : {}),
      running: this.running,
      ...(lastGood ? { lastGood: { ...lastGood } } : {}),
      history: this.record.history.slice(0, KEEP).map((r) => ({ ...r })),
    };
  }

  private get time(): string {
    return parseHm(this.o.config.time) !== undefined ? this.o.config.time : BACKUP_TIME;
  }

  /** Whether the folder is there and may be written. Cheap: a stat and an access check. */
  private folderState(): BackupState["folder"] {
    const path = this.o.config.folder;
    const problem = this.folderProblem();
    return problem ? { path, ok: false, problem } : { path, ok: true };
  }

  private folderProblem(): string | undefined {
    const c = this.o.config;
    if (c.folderProblem) return c.folderProblem;
    if (!c.folder) return "No backup folder is set for this Pobots.";
    let s;
    try {
      s = statSync(c.folder);
    } catch {
      return CANNOT_WRITE;
    }
    if (!s.isDirectory()) return "The backup folder is not a folder.";
    // Inside the bots' folder or the data folder, every backup would be packed into the next one.
    for (const own of [this.o.botsDir, this.o.dataDir]) {
      const inner = resolve(c.folder) + "/";
      if (own && inner.startsWith(resolve(own) + "/")) return "The backup folder may not be inside Pobots' own folders.";
    }
    try {
      accessSync(c.folder, fsConstants.W_OK);
    } catch {
      return CANNOT_WRITE;
    }
    return this.ownerProblem(c.folder);
  }

  /** Whether the folder's owner note names another data folder (or cannot be read). No note: no problem, the run writes one. */
  private ownerProblem(folder: string): string | undefined {
    const path = join(folder, OWNER_FILE);
    let text: string;
    try {
      const s = lstatSync(path);
      if (!s.isFile()) return BAD_OWNER;
      text = readFileSync(path, "utf8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : BAD_OWNER;
    }
    try {
      const owner = JSON.parse(text) as { kind?: unknown; dataDir?: unknown };
      if (owner?.kind !== "pobots-backup-owner" || typeof owner.dataDir !== "string" || !owner.dataDir) return BAD_OWNER;
      return samePath(owner.dataDir, this.o.dataDir) ? undefined : OTHER_OWNER;
    } catch {
      return BAD_OWNER;
    }
  }

  /** Makes this Pobots the folder's owner when no note is there yet (an exclusive create, so two can never both claim it). */
  private async claimFolder(folder: string): Promise<void> {
    const path = join(folder, OWNER_FILE);
    let dataDir = resolve(this.o.dataDir);
    try {
      dataDir = realpathSync(dataDir);
    } catch {
      // the resolved path will do
    }
    const note = JSON.stringify({ kind: "pobots-backup-owner", version: 1, dataDir, since: iso(this.o.clock()) }, null, 2) + "\n";
    try {
      await writeFile(path, note, { flag: "wx", mode: 0o644 });
      log.info(`This Pobots now owns the backup folder (${OWNER_FILE} written)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const problem = this.ownerProblem(folder);
    if (problem) throw new Plain(problem);
  }

  /** The bots' folder must be a readable folder holding a folder for every bot on the roster; otherwise no backup is made. */
  private async checkBotsFolder(): Promise<void> {
    const root = this.o.botsDir;
    let s;
    try {
      s = await stat(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Plain("The bots folder is not there, so no backup was made.");
      throw new Plain("Pobots may not read the bots folder, so no backup was made.");
    }
    if (!s.isDirectory()) throw new Plain("The bots folder is not a folder, so no backup was made.");
    try {
      await readdir(root);
    } catch {
      throw new Plain("Pobots may not read the bots folder, so no backup was made.");
    }
    const missing: string[] = [];
    const linked: string[] = [];
    for (const bot of this.o.host.bots()) {
      const st = await lstat(join(root, bot.id)).catch(() => undefined);
      if (st?.isSymbolicLink()) linked.push(bot.name);
      else if (!st?.isDirectory()) missing.push(bot.name);
    }
    if (missing.length === 1) throw new Plain(`The folder of the bot ${missing[0]} is missing, so no backup was made.`);
    if (missing.length) throw new Plain(`The folders of ${missing.length} bots are missing, so no backup was made.`);
    if (linked.length === 1) throw new Plain(`The folder of the bot ${linked[0]} is a link, which backups do not follow, so no backup was made.`);
    if (linked.length) throw new Plain(`The folders of ${linked.length} bots are links, which backups do not follow, so no backup was made.`);
  }

  /** The next daily slot strictly after `now`. */
  private nextSlot(now: number): number {
    return nextAfter({ type: "daily", time: this.time, days: [...ALL_DAYS] }, now, this.o.tz) ?? now + 24 * 3600_000;
  }

  /** When the engine should look next for the backup's sake: the next slot, while a key is set. */
  nextLook(now: number): number | undefined {
    return this.key ? this.nextSlot(now) : undefined;
  }

  private changed(): void {
    const state = this.state();
    this.sentNextAt = state.nextAt;
    this.o.host.changed(state);
  }

  // ------------------------------------------------------------ the key

  /** Checks and saves the public key. Refuses with one plain sentence; what was pasted is never kept, logged or repeated. */
  setKey(line: string): BackupState {
    let info: PublicKeyInfo;
    try {
      info = parsePublicKeyLine(line);
    } catch (err) {
      throw new EngineError("bad_request", err instanceof BackupFormatError ? err.message : "The key is damaged. Copy the whole public key again.");
    }
    const savedAt = iso(this.o.clock());
    try {
      writeBackupSettings(this.o.dataDir, { publicKey: info.line, publicKeySavedAt: savedAt });
    } catch (err) {
      throw new EngineError("internal", (err as Error).message);
    }
    this.key = { ...info, savedAt };
    log.info(`Saved the backup key (${info.bits} bits, ${info.fingerprint})`);
    this.changed();
    return this.state();
  }

  // ------------------------------------------------------------ when

  /**
   * The clock rule: past today's 03:00 (or yesterday's, before 03:00 today) and nothing made since
   * then means a run now, once. A nightly run that failed counts as tried: the next try is the next
   * night or "Back up now". A key saved after the slot waits for the next one.
   */
  due(now: number): boolean {
    if (!this.key || this.running || this.stopping) return false;
    const slot = slotAtOrBefore(now, this.time, this.o.tz);
    // Only what happened between the slot and now counts. A key time or a run dated later than now
    // is from a clock that was ahead (or has been set back) and never holds the nightly run up.
    const between = (t: number) => t >= slot && t <= now;
    if (between(Date.parse(this.key.savedAt))) return false;
    const runs = [...(this.record.checking ? [this.record.checking] : []), ...this.record.history];
    return !runs.some((r) => between(Date.parse(r.at)) && (r.by === "night" || r.status !== "failed"));
  }

  /** Called from the engine's schedule clock (at least every 30 seconds). */
  tick(now: number): void {
    if (this.stopping) return;
    // The next run's time moves on when its slot passes: send it, so the app never shows a stale one.
    if (this.key && iso(this.nextSlot(now)) !== this.sentNextAt) this.changed();
    if (this.running) return;
    if (this.due(now)) {
      this.start("night");
      return;
    }
    this.checkStale(now);
  }

  /** No saved backup for two days while a key is set: one card, once for each newest saved backup. */
  private checkStale(now: number): void {
    if (!this.key) return;
    const ref = this.record.lastSavedAt && Date.parse(this.record.lastSavedAt) > Date.parse(this.key.savedAt) ? this.record.lastSavedAt : undefined;
    const since = ref ?? this.key.savedAt;
    if (now - Date.parse(since) < this.t.staleMs || this.record.staleFor === since) return;
    this.record.staleFor = since;
    this.saveRecord();
    this.o.host.showCard(
      "No backup for two days",
      ref ? `The last backup that reached OneDrive was made ${atWords(Date.parse(ref), now, this.o.tz)}.` : "No backup has reached OneDrive since the key was saved.",
    );
  }

  /** "Back up now". Refused while one runs, without a key, or while the engine is stopping. */
  runNow(): BackupState {
    if (this.stopping) throw new EngineError("conflict", "Pobots is stopping, so no backup was started.");
    if (this.running) throw new EngineError("conflict", "A backup is being made right now.");
    if (!this.key) throw new EngineError("conflict", "Add a key first. No backups are made without one.");
    this.start("you");
    return this.state();
  }

  private start(by: BackupRun["by"]): void {
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    if (this.stopped.signal.aborted) abort.abort();
    this.changed();
    this.current = this.run(by, abort.signal)
      .catch((err) => log.error("The backup ended badly", err))
      .finally(() => {
        this.running = false;
        this.abort = undefined;
        this.current = undefined;
        this.changed();
      });
  }

  /** For tests and the engine's stop: resolves when no run is going. */
  async idle(): Promise<void> {
    while (this.current || this.relooking) await (this.current ?? this.relooking);
  }

  /** The engine is stopping: no new run; a run being made is ended and its half-made file removed; a check of arrival ends with the run kept as unconfirmed. Resolves when all is settled. */
  stop(): Promise<boolean> {
    return (this.stopping$ ??= this.stopNow());
  }

  /**
   * Ends a run and proves its clean-up is done: true when no child process is left and no half-made
   * file is in the data folder or the backup folder. A run that has not ended within `stopMs` has its
   * children killed and its half-made files removed by force. Bounded: never much over `stopMs`.
   */
  private async stopNow(): Promise<boolean> {
    this.stopping = true;
    this.stopped.abort();
    this.abort?.abort();
    const ended = await Promise.race([this.idle().then(() => true), delay(this.t.stopMs).then(() => false)]);
    if (!ended) {
      log.warn(`The backup did not end within ${Math.round(this.t.stopMs / 1000)} seconds of the stop; ending its work by force`);
      this.forceCleanup();
      await Promise.race([this.idle(), delay(2000)]);
    }
    const left = this.leftovers();
    if (left.length) {
      this.forceCleanup();
      const still = this.leftovers();
      if (still.length) {
        log.error(`The backup's clean-up is not done: ${still.join(", ")}`);
        return false;
      }
    }
    log.info(ended ? "The backup is stopped; nothing was left behind" : "The backup was ended by force; nothing was left behind");
    return true;
  }

  private get workDir(): string {
    return join(this.o.dataDir, "backups", ".work");
  }

  /** Child processes still alive and half-made files still there. */
  private leftovers(): string[] {
    const out: string[] = [];
    for (const c of this.children) if (c.exitCode === null && c.signalCode === null) out.push(`tar (process ${c.pid})`);
    if (existsSync(this.workDir)) out.push(this.workDir);
    for (const f of this.halfMade) if (existsSync(f)) out.push(f);
    return out;
  }

  private forceCleanup(): void {
    for (const c of this.children) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const f of [this.workDir, ...this.halfMade]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch (err) {
        log.warn(`Could not remove ${f}`, (err as Error).message);
      }
    }
  }

  // ------------------------------------------------------------ one run

  private async run(by: BackupRun["by"], signal: AbortSignal): Promise<void> {
    const startedAt = this.o.clock();
    const name = backupFileName(startedAt, this.o.tz);
    const run: BackupRun = { at: iso(startedAt), status: "failed", by };
    log.info(`Backup ${by === "night" ? "of the night" : "by hand"} started`);
    // Earlier unconfirmed files are looked at beside the run (their minute's hold never delays it).
    const earlier = this.relook(signal).catch((err) => log.warn("Could not look again at earlier backups", (err as Error).message));
    try {
      await this.runOnce(signal, name, run);
    } finally {
      await earlier;
    }
  }

  private async runOnce(signal: AbortSignal, name: string, run: BackupRun): Promise<void> {
    let made: { path: string; bytes: number; leftOut: string[] };
    try {
      made = await this.make(name, run.at, signal);
    } catch (err) {
      // A stop ends the run without a record: the clock tries again after the start.
      if (signal.aborted || err instanceof Stopped) {
        log.info("Backup ended by the stop; nothing was left behind");
        return;
      }
      run.problem = this.plain(err);
      this.finish(run);
      return;
    }
    run.file = name;
    run.bytes = made.bytes;
    if (made.leftOut.length) run.leftOut = made.leftOut;
    run.status = "unconfirmed";
    this.record.checking = { ...run };
    this.saveRecord();
    // The file is made: the app shows that only its arrival is being checked now.
    this.changed();
    log.info(`Backup ${name} made (${made.bytes} bytes)${made.leftOut.length ? `, ${made.leftOut.length} big file(s) left out` : ""}`);
    try {
      // Only in a folder this Pobots owns, as its note says right now.
      const owner = this.ownerProblem(this.o.config.folder);
      if (owner || !existsSync(join(this.o.config.folder, OWNER_FILE))) log.warn(`Old backups were not tidied: ${owner ?? "the folder's owner note is gone"}`);
      else {
        const removed = await pruneFolder(this.o.config.folder, name);
        if (removed.length) log.info(`Removed ${removed.length} old backup(s): ${removed.join(", ")}`);
      }
    } catch (err) {
      log.warn("Old backups could not be tidied", (err as Error).message);
    }
    const arrival = await this.confirm(made.path, signal);
    this.record.checking = undefined;
    if (arrival === "stopped") {
      this.finish({ ...run, status: "unconfirmed", problem: STOPPED_CHECKING }, false);
      return;
    }
    if (arrival.saved) this.finish({ ...run, status: "saved" });
    else this.finish({ ...run, status: "unconfirmed", problem: arrival.problem });
  }

  /** Makes tonight's file and puts it into the folder. Throws Plain, Stopped or a system error. */
  private async make(name: string, at: string, signal: AbortSignal): Promise<{ path: string; bytes: number; leftOut: string[] }> {
    const problem = this.folderProblem();
    if (problem) throw new Plain(problem);
    const key = this.key;
    if (!key) throw new Plain("No key is saved.");
    const folder = this.o.config.folder;
    const check = () => {
      if (signal.aborted) throw new Stopped();
    };
    await this.claimFolder(folder);
    await this.checkBotsFolder();
    check();
    const work = this.workDir;
    await rm(work, { recursive: true, force: true });
    const stage = join(work, "stage");
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      const db = join(stage, "pobots.db");
      try {
        await this.o.host.snapshotDb(db);
      } catch (err) {
        log.error("The database could not be copied for the backup", err);
        throw new Plain("The chats could not be copied from the database.");
      }
      check();
      const parts = [db];
      const config = join(this.o.dataDir, "config.json");
      if (existsSync(config)) {
        await copyFile(config, join(stage, "config.json"));
        parts.push(join(stage, "config.json"));
      }
      let listed: { names: string[]; leftOut: string[] };
      try {
        listed = await listBotFiles(this.o.botsDir, this.o.maxFileBytes ?? MAX_FILE_BYTES);
      } catch (err) {
        log.error("The bots' folder could not be read for the backup", err);
        throw new Plain("Some of the bots' files could not be read, so no backup was made.");
      }
      const { names, leftOut } = listed;
      check();
      const manifest = join(stage, "manifest.json");
      await writeFile(manifest, JSON.stringify(this.manifest(db, at, key.fingerprint, leftOut), null, 2) + "\n", { mode: 0o600 });
      parts.push(manifest);
      const partial = join(work, `${name}.partial`);
      await this.pack(parts, names, partial, { createdAt: at, engineVersion: this.o.engineVersion, protocol: PROTOCOL_VERSION, contents: "tar+gzip", file: name }, key, signal);
      check();
      const target = join(folder, name);
      if (existsSync(target)) throw new Plain(MOMENT_AGO);
      await this.place(partial, target, name, signal);
      const bytes = (await stat(target)).size;
      return { path: target, bytes, leftOut };
    } finally {
      await rm(work, { recursive: true, force: true }).catch((err) => log.warn("Could not tidy the backup's work folder", (err as Error).message));
    }
  }

  /** What is in the file, for the restore: who made it, the bots and how many items each main chat holds. */
  private manifest(dbPath: string, createdAt: string, keyFingerprint: string, leftOut: string[]): Record<string, unknown> {
    const counts = new Map<string, { threadId: string; items: number }>();
    let threads = 0;
    let items = 0;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      threads = (db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n;
      items = (db.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n;
      const rows = db
        .prepare("SELECT t.bot_id AS botId, t.id AS threadId, (SELECT count(*) FROM items i WHERE i.thread_id = t.id) AS n FROM threads t WHERE t.kind = 'main' AND t.retired_at IS NULL")
        .all() as { botId: string; threadId: string; n: number }[];
      for (const r of rows) counts.set(r.botId, { threadId: r.threadId, items: Number(r.n) });
    } finally {
      db.close();
    }
    return {
      kind: "pobots-backup-manifest",
      format: 1,
      createdAt,
      engineVersion: this.o.engineVersion,
      protocol: PROTOCOL_VERSION,
      keyFingerprint,
      database: "pobots.db",
      config: "config.json",
      botsFolder: "bots",
      counts: { threads: Number(threads), items: Number(items) },
      bots: this.o.host.bots().map((b) => ({ id: b.id, name: b.name, mainThreadId: counts.get(b.id)?.threadId, mainItems: counts.get(b.id)?.items ?? 0 })),
      leftOut,
    };
  }

  /**
   * tar (a child process, with its own gzip) packs the staged files at the top and the bots' folder
   * under "bots/"; the lock stream seals what it writes, frame by frame, into `out`.
   */
  private async pack(parts: string[], botNames: string[], out: string, meta: Record<string, unknown>, key: PublicKeyInfo, signal: AbortSignal): Promise<void> {
    const cwd = this.o.botsDir;
    // Names: the staged files by their whole path (shortened to their own name), the bots' files as
    // "./<path>" (put under "bots/"). Links' targets are left as they are. -n: no recursion, the
    // list is complete. --null: any character in a name is safe.
    const tar = spawn("tar", ["-czf", "-", "--no-mac-metadata", "-s", ",^\\./,bots/,S", "-s", ",^/.*/,,S", "--null", "-n", "-T", "-"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(tar);
    tar.once("close", () => this.children.delete(tar));
    let stderr = "";
    tar.stderr.setEncoding("utf8");
    tar.stderr.on("data", (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      tar.on("error", reject);
      tar.on("close", (code) => resolve(code));
    });
    const kill = () => tar.kill("SIGTERM");
    signal.addEventListener("abort", kill, { once: true });
    tar.stdin.on("error", () => undefined);
    tar.stdin.end(Buffer.from([...parts, ...botNames].map((n) => `${n}\0`).join(""), "utf8"));
    try {
      await Promise.all([pipeline(tar.stdout, lockStream(key.key, key.fingerprint, meta), createWriteStream(out, { mode: 0o600, flush: true }), { signal }), exited]);
    } catch (err) {
      kill();
      await exited.catch(() => undefined);
      if (signal.aborted) throw new Stopped();
      log.error("The backup could not be packed", err);
      throw new Plain("The bot folders could not be packed.");
    } finally {
      signal.removeEventListener("abort", kill);
    }
    const code = await exited;
    if (code === 0) return;
    const lines = stderr.split("\n").filter(Boolean);
    if (code === 1 && lines.length && lines.every((l) => VANISHED.test(l))) {
      log.info(`${lines.length - 1} file(s) went away while the backup was packed; the rest is in it`);
      return;
    }
    if (signal.aborted) throw new Stopped();
    log.error(`tar ended with ${code}: ${stderr.slice(0, 2000)}`);
    throw new Plain("The bot folders could not be packed.");
  }

  /**
   * Gives the finished file its name in the folder in one step that never replaces a file: a hard
   * link (which fails when the name is taken), then the work copy's name is removed. So the cloud
   * drive only ever sees a whole file, and two runs can never replace each other's file.
   */
  private async place(partial: string, target: string, name: string, signal: AbortSignal): Promise<void> {
    const link = this.o.link ?? fsLink;
    const noLink = (err: unknown) => ["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].includes((err as NodeJS.ErrnoException).code ?? "");
    try {
      await link(partial, target);
      await rm(partial, { force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Plain(MOMENT_AGO);
      if (!noLink(err)) throw err;
    }
    // Another volume, or a folder that takes no hard links: copied to a hidden name in the folder
    // first (an exclusive create), then given its name there.
    const hidden = join(this.o.config.folder, `.${name}.${randomBytes(4).toString("hex")}.pobots-partial`);
    this.halfMade.add(hidden);
    try {
      await (this.o.copy ?? copyExclusive)(partial, hidden, signal);
      if (signal.aborted) throw new Stopped();
      try {
        await link(hidden, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Plain(MOMENT_AGO);
        if (!noLink(err)) throw err;
        // The folder takes no hard links at all: renamed, after a last look that the name is free.
        // The folder's owner note keeps every other Pobots out, and this Pobots makes one run at a time.
        if (existsSync(target)) throw new Plain(MOMENT_AGO);
        await rename(hidden, target);
      }
    } catch (err) {
      if (signal.aborted && !(err instanceof Plain)) throw new Stopped();
      throw err;
    } finally {
      await rm(hidden, { force: true });
      this.halfMade.delete(hidden);
      await rm(partial, { force: true });
    }
  }

  /** Reads the upload state until "uploaded" has held for a minute, or ten minutes have gone. */
  private async confirm(path: string, signal: AbortSignal): Promise<{ saved: true } | { saved: false; problem: string } | "stopped"> {
    const began = Date.now();
    let since: number | undefined;
    for (;;) {
      if (signal.aborted) return "stopped";
      const s = await unlessStopped(this.read(path), signal);
      if (signal.aborted) return "stopped";
      if (s && s.exists === false) return { saved: false, problem: "The backup file went away from the folder before OneDrive confirmed it." };
      if (s?.uploaded === true && !s.uploadError) {
        since ??= Date.now();
        if (Date.now() - since >= this.t.holdMs) return { saved: true };
      } else since = undefined;
      if (Date.now() - began >= this.t.limitMs) return { saved: false, problem: UNCONFIRMED };
      await wait(this.t.pollMs, signal);
    }
  }

  /**
   * Looks again at the files of earlier unconfirmed runs, and marks them saved when the Mac says
   * "uploaded" with no upload error and still says so a minute later (the same hold as a new file).
   */
  private async relook(signal: AbortSignal): Promise<void> {
    const folder = this.o.config.folder;
    if (!folder) return;
    const uploaded = (s: UploadState | undefined) => !!s?.exists && s.uploaded === true && !s.uploadError;
    const stillUploaded = async (list: BackupRun[]): Promise<BackupRun[]> => {
      const out: BackupRun[] = [];
      for (const r of list) {
        if (signal.aborted) return [];
        if (uploaded(await unlessStopped(this.read(join(folder, r.file!)), signal))) out.push(r);
      }
      return out;
    };
    let holding = await stillUploaded(this.record.history.filter((r) => r.status === "unconfirmed" && r.file));
    const since = Date.now();
    while (holding.length && !signal.aborted) {
      const left = this.t.holdMs - (Date.now() - since);
      if (left <= 0) break;
      await wait(Math.min(this.t.pollMs, left), signal);
      if (signal.aborted) return;
      holding = await stillUploaded(holding);
    }
    if (signal.aborted) return;
    let any = false;
    let newest = false;
    for (const r of holding) {
      if (r.status !== "unconfirmed") continue;
      r.status = "saved";
      delete r.problem;
      if (!this.record.lastSavedAt || r.at > this.record.lastSavedAt) this.record.lastSavedAt = r.at;
      any = true;
      if (r === this.record.history[0]) newest = true;
      log.info(`OneDrive has the earlier backup ${r.file} now`);
    }
    if (!any) return;
    this.saveRecord();
    // The card comes down only when nothing went wrong after the run that is now saved.
    if (newest) this.o.host.clearCard();
    this.changed();
  }

  /** Keeps a finished run, and puts up or takes down the card. */
  private finish(run: BackupRun, card = true): void {
    this.pushRun(run);
    if (run.status === "saved") this.record.lastSavedAt = run.at;
    this.saveRecord();
    if (run.status === "saved") {
      log.info(`Backup ${run.file} saved: OneDrive has it`);
      this.o.host.clearCard();
      return;
    }
    log.warn(`Backup ${run.status}: ${run.problem ?? ""}`);
    if (!card || run.by !== "night") return;
    if (run.status === "failed") this.o.host.showCard("Last night's backup failed", run.problem ?? "");
    else this.o.host.showCard("Last night's backup did not reach OneDrive", run.problem ?? UNCONFIRMED);
  }

  private pushRun(run: BackupRun): void {
    this.record.history.unshift(run);
    this.record.history.length = Math.min(this.record.history.length, KEEP);
  }

  /** A failure in one plain sentence. Anything unexpected goes to the log with its details. */
  private plain(err: unknown): string {
    if (err instanceof Plain) return err.message;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOSPC") return "The Mac's disk is full.";
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return CANNOT_WRITE;
    log.error("The backup could not be made", err);
    return "Something went wrong while making the backup. The details are in the engine's log.";
  }

  // ------------------------------------------------------------ backup.json

  private loadRecord(): BackupRecord {
    const empty: BackupRecord = { version: 1, history: [] };
    if (!existsSync(this.recordPath)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.recordPath, "utf8")) as Partial<BackupRecord>;
      const okRun = (r: unknown): r is BackupRun =>
        !!r && typeof r === "object" && typeof (r as BackupRun).at === "string" && ["saved", "unconfirmed", "failed"].includes((r as BackupRun).status) && ((r as BackupRun).by === "night" || (r as BackupRun).by === "you");
      return {
        version: 1,
        history: Array.isArray(raw.history) ? raw.history.filter(okRun).slice(0, KEEP) : [],
        ...(okRun(raw.checking) ? { checking: raw.checking } : {}),
        ...(typeof raw.lastSavedAt === "string" ? { lastSavedAt: raw.lastSavedAt } : {}),
        ...(typeof raw.staleFor === "string" ? { staleFor: raw.staleFor } : {}),
      };
    } catch {
      log.warn("backup.json could not be read; starting a fresh record of backups");
      return empty;
    }
  }

  /** Written whole to a temporary file and renamed, so a stop never leaves half a record. */
  private saveRecord(): void {
    const tmp = `${this.recordPath}.${randomBytes(4).toString("hex")}.pobots-tmp`;
    try {
      writeFileSyncAtomic(tmp, this.recordPath, JSON.stringify(this.record, null, 2) + "\n");
    } catch (err) {
      log.warn("Could not save backup.json", (err as Error).message);
    }
  }
}

/** Written whole to a temporary file and renamed. backup.json is a few KB. */
function writeFileSyncAtomic(tmp: string, path: string, text: string): void {
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Copies `from` to a new file `to` (never replacing one), ending early when the signal is aborted. */
async function copyExclusive(from: string, to: string, signal: AbortSignal): Promise<void> {
  await pipeline(createReadStream(from), createWriteStream(to, { flags: "wx", mode: 0o600, flush: true }), { signal });
}
