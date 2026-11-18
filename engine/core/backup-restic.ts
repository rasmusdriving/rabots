import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackupRun, BackupState } from "../../shared/protocol.js";
import { BACKUP_TIME, defaultBackupFolder, defaultDataDir, iCloudDriveFolder, insidePath, samePath, writeBackupSettings, type BackupConfig } from "../config.js";
import { EngineError } from "../errors.js";
import { log } from "../log.js";
import { opRead } from "../op-read.js";
import { instantFor, nextAfter, parseHm, wallOf } from "../schedule.js";
import { BackupProblem, claimFolder, EXCLUDES, folderProblem, ownerProblem, repositoryFiles, stageBackup, type BackupSources } from "./backup-restic-files.js";
import { BACKUP_TIMINGS, confirmUpload, readMacUpload, type UploadReader, type BackupTimings } from "./backup-restic-upload.js";
import { cleanPasswordRef, PASSWORD_MISSING, REF_PROBLEM, RESTIC_MISSING } from "../../shared/backup-settings.js";
import { findRestic, KEEP, parseSnapshots, restic, ResticError, STAGE_NAME } from "./restic-cli.js";

export interface BackupOptions {
  readUploadState?: UploadReader;
  readPassword?: typeof opRead;
  timings?: Partial<BackupTimings>;
}

interface Options extends BackupOptions {
  dataDir: string;
  botsDir: string;
  config: BackupConfig;
  engineVersion: string;
  clock: () => number;
  tz: string;
  host: Pick<BackupSources, "snapshotDb" | "bots"> & {
    changed: (state: BackupState) => void;
    showCard: (title: string, text: string) => void;
    clearCard: () => void;
  };
}

interface Pending { id: string; at: string; by: BackupRun["by"]; nightly: boolean; leftOut?: string[]; prunePending?: boolean }
interface RecordFile {
  version: 2;
  folder: string;
  history: BackupRun[];
  pending?: Pending;
  uploads?: string[];
  checkedAt?: string;
  staleFor?: string;
  repositoryBytes?: number;
  snapshots?: number;
}

const iso = (t: number) => new Date(t).toISOString();
const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const dayMs = 24 * 3600_000;
const within = (value: string | undefined, start: number, end: number) => !!value && Date.parse(value) >= start && Date.parse(value) <= end;
const good = (run: BackupRun) => run.status !== "failed" && !!run.snapshot;
const pattern = (path: string) => path.replace(/[\\*?[\]]/g, "\\$&");
const testRef = "op://Pobots-test/Throwaway/password";

export function slotAtOrBefore(now: number, time: string, tz: string): number {
  const m = parseHm(time) ?? parseHm(BACKUP_TIME)!;
  const w = wallOf(now, tz);
  const today = instantFor(w.y, w.mo, w.d, Math.floor(m / 60), m % 60, tz);
  if (today <= now) return today;
  const y = new Date(Date.UTC(w.y, w.mo - 1, w.d - 1));
  return instantFor(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), Math.floor(m / 60), m % 60, tz);
}

export class Backup {
  private readonly timing: BackupTimings;
  private readonly recordPath: string;
  private readonly stage: string;
  private record: RecordFile;
  private passwordRef?: string;
  private savedAt?: string;
  private task?: Promise<void>;
  private abort?: AbortController;
  private current?: BackupRun;
  private stopping = false;
  private sentNextAt?: string;

  private readonly o: Options;
  constructor(o: Options) {
    this.o = o;
    this.timing = { ...BACKUP_TIMINGS, ...o.timings };
    this.recordPath = join(o.dataDir, "backup.json");
    this.stage = join(o.dataDir, STAGE_NAME);
    this.record = this.load();
    this.passwordRef = o.config.passwordRef && cleanPasswordRef(o.config.passwordRef);
    this.savedAt = this.passwordRef ? o.config.passwordRefSavedAt ?? iso(o.clock()) : undefined;
  }

  private get folder() { return this.o.config.folder; }
  private get time() { return this.o.config.time; }
  private get executable() { return findRestic(this.o.config.executable); }
  private get iCloud() { return !!this.folder && insidePath(this.folder, iCloudDriveFolder()); }
  private folderProblem() {
    if (this.o.config.folderProblem) return this.o.config.folderProblem;
    if (this.folder && !samePath(this.o.dataDir, defaultDataDir()) && insidePath(this.folder, defaultBackupFolder())) {
      return "This Pobots may not use the backup folder of the main Pobots.";
    }
    return folderProblem(this.folder, this.o.dataDir, this.o.botsDir);
  }

  state(): BackupState {
    const problem = this.folderProblem();
    const resticInstalled = !!this.executable;
    const history = this.current ? [this.current, ...this.record.history].slice(0, KEEP) : this.record.history;
    return {
      passwordRef: this.passwordRef, resticInstalled, running: !!this.task || !!this.abort, time: this.time, keep: KEEP,
      folder: { path: this.folder, iCloud: this.iCloud, ok: !problem, problem },
      nextAt: resticInstalled && this.passwordRef ? iso(this.nextSlot(this.o.clock())) : undefined,
      lastGood: history.find(good), history, repositoryBytes: this.record.repositoryBytes, snapshots: this.record.snapshots,
    };
  }

  setPasswordRef(value: string): BackupState {
    if (this.task) throw new EngineError("conflict", "Wait for the backup to finish before changing the reference.");
    const ref = value.trim() ? cleanPasswordRef(value) : undefined;
    if (value.trim() && !ref) throw new EngineError("bad_request", REF_PROBLEM);
    if (ref !== this.passwordRef) {
      const savedAt = ref ? iso(this.o.clock()) : undefined;
      try {
        writeBackupSettings(this.o.dataDir, {
          passwordRef: ref, passwordRefSavedAt: savedAt,
          // Removing the old override also lets a rolled-back engine use its own OneDrive default.
          ...(this.o.config.migrated ? { folder: undefined } : {}),
        });
      } catch {
        throw new EngineError("conflict", "Pobots could not save the backup settings.");
      }
      this.passwordRef = ref;
      this.savedAt = savedAt;
      if (!ref) this.o.host.clearCard();
      return this.changed();
    }
    return this.state();
  }

  private nextSlot(now: number): number {
    return nextAfter({ type: "daily", time: this.time, days: [...days] }, now, this.o.tz) ?? now + dayMs;
  }

  nextLook(now: number): number | undefined {
    return this.passwordRef && this.executable ? this.nextSlot(now) : undefined;
  }

  private changed(): BackupState {
    const state = this.state();
    this.sentNextAt = state.nextAt;
    this.o.host.changed(state);
    return state;
  }

  private triedSince(slot: number, now: number) {
    return this.record.history.some((r) => within(r.at, slot, now) && (r.by === "night" || !!r.snapshot));
  }

  due(now: number): boolean {
    if (!this.passwordRef || !this.executable || this.task || this.stopping) return false;
    if (this.record.pending) return true;
    const slot = slotAtOrBefore(now, this.time, this.o.tz);
    return !within(this.savedAt, slot, now) && !this.triedSince(slot, now);
  }

  tick(now: number): void {
    if (this.stopping || this.task) return;
    const next = this.nextLook(now);
    if ((next === undefined ? undefined : iso(next)) !== this.sentNextAt) this.changed();
    if (this.due(now)) this.start("night");
    else this.checkStale(now);
  }

  private checkStale(now: number) {
    if (!this.passwordRef || !this.executable || !this.savedAt) return;
    const made = this.record.history.find(good)?.at;
    const since = made && made > this.savedAt ? made : this.savedAt;
    if (now - Date.parse(since) < this.timing.staleMs || this.record.staleFor === since) return;
    this.record.staleFor = since;
    this.save();
    this.o.host.showCard("No backup for two days", "Pobots has not completed a backup in two days. Open Backup settings to see what happened.");
  }

  runNow(): BackupState {
    if (this.stopping) throw new EngineError("conflict", "Pobots is stopping, so no backup was started.");
    if (this.task) throw new EngineError("conflict", "A backup is already running.");
    if (!this.executable) throw new EngineError("conflict", RESTIC_MISSING);
    if (!this.passwordRef) throw new EngineError("conflict", PASSWORD_MISSING);
    this.start("you");
    return this.state();
  }

  private start(by: BackupRun["by"]): void {
    const executable = this.executable;
    if (!executable || !this.passwordRef) return;
    const now = this.o.clock();
    const slot = slotAtOrBefore(now, this.time, this.o.tz);
    const pending = this.record.pending ?? {
      id: randomUUID(), at: iso(now), by, nightly: !this.triedSince(slot, now) && (by === "night" || !within(this.savedAt, slot, now)),
    };
    const resumed = !!this.record.pending;
    const controller = new AbortController();
    this.abort = controller;
    this.task = this.run(pending, resumed, executable, this.passwordRef, controller.signal).finally(() => {
      this.current = undefined;
      this.task = undefined;
      this.abort = undefined;
      this.changed();
    });
    this.changed();
  }

  async idle(): Promise<void> { await this.task; }

  async stop(): Promise<boolean> {
    this.stopping = true;
    this.abort?.abort();
    if (!this.task) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.task.then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.timing.stopMs);
        timer.unref();
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(pending: Pending, resumed: boolean, executable: string, ref: string, signal: AbortSignal) {
    let run: BackupRun = { at: pending.at, by: pending.by, status: "failed" };
    const folder = this.folder;
    const requireOwner = () => {
      const problem = ownerProblem(folder, this.o.dataDir, true);
      if (problem) throw new BackupProblem(problem);
    };
    try {
      const problem = this.folderProblem();
      if (problem) throw new BackupProblem(problem);
      const injected = ref === testRef && !samePath(this.o.dataDir, defaultDataDir()) && !insidePath(folder, defaultBackupFolder())
        ? process.env.POBOTS_TEST_RESTIC_PASSWORD : undefined;
      const readPassword = this.o.readPassword ?? opRead;
      const password = injected || await readPassword(ref, signal);
      signal.throwIfAborted();
      if (!password) throw new BackupProblem("Pobots could not read the backup password in 1Password. Check the reference and the Mac's access.");
      await claimFolder(folder, this.o.dataDir);
      const call = (args: string[]) => {
        signal.throwIfAborted();
        requireOwner();
        return restic({ executable, folder, password, args, signal, cacheDir: join(this.o.dataDir, "restic-cache") });
      };
      const before = await repositoryFiles(folder);
      if (!before.has("config")) {
        if ([...before.keys()].some((p) => p.startsWith("snapshots/") || p.startsWith("data/") || p.startsWith("index/"))) {
          throw new BackupProblem("The backup repository is missing its config file. Pobots will not replace it.");
        }
        await call(["init"]);
      }
      // Restic decides whether a lock is stale. Never use unlock --remove-all.
      await call(["unlock"]);
      const tag = `run-${pending.id}`;
      const list = async () => parseSnapshots(await call(["snapshots", "--no-lock", "--json"]));
      const old = await list();
      let snapshot = resumed ? old.find((s) => s.tags?.includes(tag) && s.tags.includes("pobots")) : undefined;
      // An engine killed before promotion may have left an unpublished candidate.
      const candidates = old.filter((s) => !s.tags?.includes("pobots") && s.tags?.includes("candidate") && s.tags.some((t) => /^run-[a-f0-9-]{36}$/.test(t)));
      if (candidates.length) await call(["forget", ...candidates.map((s) => s.id)]);
      let snapshots = old.filter((s) => s.tags?.includes("pobots"));
      if (!snapshot) {
        this.record.pending = pending;
        this.saveOrThrow();
        const { stage, leftOut } = await stageBackup({ ...this.o, ...this.o.host }, run.at, signal);
        pending.leftOut = leftOut;
        this.saveOrThrow();
        const exclude = [...EXCLUDES, ...leftOut.map((p) => pattern(join(this.o.botsDir, p)))];
        // Keep the stable source paths so restic can use its previous file metadata.
        const text = await call(["backup", "--json", "--quiet", "--time", run.at.slice(0, 23).replace("T", " "),
          "--tag", `candidate,${tag},${pending.nightly ? "nightly" : "manual"}`,
          "--exclude", pattern(join(stage, "pobots.db-wal")), "--exclude", pattern(join(stage, "pobots.db-shm")),
          ...exclude.map((rule) => `--exclude=${rule}`), "--", stage, this.o.botsDir]);
        const summary = text.trim().split("\n").map((line) => JSON.parse(line)).find((line) => line.message_type === "summary");
        if (typeof summary?.snapshot_id !== "string" || !/^[a-f0-9]{8,64}$/.test(summary.snapshot_id)) throw new BackupProblem("Restic did not report a completed snapshot.");
        await call(["tag", "--remove", "candidate", "--add", "pobots", summary.snapshot_id]);
        snapshots = (await list()).filter((s) => s.tags?.includes("pobots"));
        snapshot = snapshots.find((s) => s.tags?.includes(tag));
        if (!snapshot) throw new BackupProblem("Pobots could not find the completed snapshot.");
      }
      run = { ...run, status: "made", snapshot: snapshot.id, bytes: snapshot.summary?.data_added_packed, leftOut: pending.leftOut };
      this.current = run;
      this.changed();
      // Retain 14 nightly slots and up to three additional restore points made by hand.
      let pruned = false;
      for (const [type, keep] of [["nightly", KEEP], ["manual", 3]] as const) {
        if (snapshots.filter((s) => s.tags?.includes(type)).length <= keep) continue;
        pending.prunePending = true;
        this.saveOrThrow();
        await call(["forget", "--tag", `pobots,${type}`, "--group-by", "", "--keep-last", String(keep), "--prune"]);
        pruned = true;
      }
      if (!pruned && (candidates.length || pending.prunePending)) await call(["prune"]);
      pending.prunePending = undefined;
      if (pruned) snapshots = (await list()).filter((s) => s.tags?.includes("pobots"));
      const after = await repositoryFiles(folder);
      this.record.repositoryBytes = [...after.values()].reduce((a, b) => a + b, 0);
      this.record.snapshots = snapshots.length;
      if (!this.record.checkedAt || this.o.clock() - Date.parse(this.record.checkedAt) >= 7 * dayMs) {
        await call(["check"]);
        this.record.checkedAt = iso(this.o.clock());
      }
      const uploads = [...new Set([
        ...(this.record.uploads ?? []).filter((p) => after.has(p)),
        ...[...after.keys()].filter((p) => resumed || !before.has(p) || before.get(p) !== after.get(p)),
      ])];
      this.record.uploads = this.iCloud ? uploads : undefined;
      this.save();
      const uploadProblem = this.iCloud
        ? await confirmUpload(folder, uploads, this.o.readUploadState ?? readMacUpload, this.timing, signal)
        : "This folder is local. Pobots cannot confirm an iCloud upload.";
      if (!uploadProblem) this.record.uploads = undefined;
      this.finish({ ...run, status: uploadProblem ? "unconfirmed" : "saved", problem: uploadProblem });
    } catch (err) {
      if (!signal.aborted) {
        const problem = err instanceof BackupProblem || err instanceof ResticError ? err.message : "Something went wrong while making the backup.";
        // A failed candidate is never presented as a restore point; the next run cleans it up.
        this.finish({ ...run, status: "failed", problem });
      }
    } finally {
      await rm(this.stage, { recursive: true, force: true }).catch(() => log.warn("Could not clear the temporary backup files."));
    }
  }

  private finish(run: BackupRun) {
    this.record.pending = undefined;
    this.record.history = [run, ...this.record.history].slice(0, KEEP);
    this.current = undefined;
    this.save();
    if (run.status === "saved" || (run.status === "unconfirmed" && !this.iCloud)) this.o.host.clearCard();
    else if (run.by === "night") this.o.host.showCard(run.status === "failed" ? "Last night's backup failed" : "Last night's upload was not confirmed", run.problem ?? "Open Backup settings for details.");
    log.info(`Backup ${run.status}${run.bytes === undefined ? "" : ` (${run.bytes} bytes added)`}`);
  }

  private load(): RecordFile {
    const empty: RecordFile = { version: 2, folder: this.folder, history: [] };
    try {
      const record = JSON.parse(readFileSync(this.recordPath, "utf8")) as RecordFile;
      return record.version === 2 && record.folder === this.folder && Array.isArray(record.history) ? record : empty;
    } catch {
      return empty;
    }
  }

  private saveOrThrow() {
    const temp = `${this.recordPath}.${randomUUID()}.pobots-tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.record) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temp, this.recordPath);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private save() {
    try { this.saveOrThrow(); } catch { log.warn("Could not save the backup run record."); }
  }
}
