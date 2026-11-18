// The window's stand-in for the nightly backup. Use ?backup=none|missing|key|made|saved|unconfirmed|failed|stale|running|nofolder.
import type { BackupRun, BackupState, Events, Methods, SystemCard } from "../../shared/protocol";
import { cleanPasswordRef, PASSWORD_MISSING, REF_PROBLEM, RESTIC_MISSING } from "../../shared/backup-settings";
import { EngineError } from "./types";

const FOLDER = "~/Library/Mobile Documents/com~apple~CloudDocs/Pobots Backup";
const NOT_CONFIRMED = "macOS did not report the upload of these files.";
const FAILED = "Restic could not verify the backup repository.";
export const NO_FOLDER = "Pobots cannot write to the backup folder. Check that the folder is available on the Mac.";
const KEEP = 14;
export type BackupOutcome = "saved" | "unconfirmed" | "failed";

export interface BackupHost {
  emit(e: { event: "backup.changed"; data: Events["backup.changed"] }): void;
  putCard(card: SystemCard): void;
  removeCard(topic: SystemCard["topic"]): void;
  cardOf(topic: SystemCard["topic"]): string | null;
  newId(): string;
}

const nextNight = () => {
  const date = new Date();
  date.setHours(3, 0, 0, 0);
  if (date <= new Date()) date.setDate(date.getDate() + 1);
  return date.toISOString();
};

export class MockBackup {
  private readonly s: BackupState = { folder: { path: FOLDER, iCloud: true, ok: true }, resticInstalled: true, time: "03:00", keep: KEEP, running: false, history: [] };
  private runMs = 1200;
  private next: { outcome: BackupOutcome; problem?: string }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  readonly referenceTexts: string[] = [];

  constructor(private readonly host: BackupHost, seed: string | null) {
    if (seed === "missing") {
      this.s.resticInstalled = false;
      return;
    }
    if (seed === "none") return;
    this.s.passwordRef = "op://Example/Pobots backup/password";
    this.s.nextAt = nextNight();
    if (seed === "key") return;
    const at = (days: number) => {
      const d = new Date();
      d.setDate(d.getDate() - days);
      d.setHours(3, 0, 0, 0);
      return d.toISOString();
    };
    const good: BackupRun = { at: at(3), status: "saved", by: "night", bytes: 3_310_000 };
    this.s.history = [good];
    this.s.lastGood = good;
    this.s.snapshots = 1;
    this.s.repositoryBytes = 3_350_000;
    if (seed === "stale") { this.stale(); return; }
    if (seed === "running" || seed === "made") { this.start("you", seed === "made"); return; }
    if (seed === "nofolder") { this.setFolder(false); return; }
    const outcome = seed === "failed" || seed === "unconfirmed" ? seed : "saved";
    this.finish(at(1), "night", outcome);
  }

  state(): BackupState { return structuredClone(this.s); }
  private changed() { this.host.emit({ event: "backup.changed", data: { backup: this.state() } }); }

  readonly handlers: { [M in "backup.setPasswordRef" | "backup.run"]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "backup.setPasswordRef": ({ passwordRef }) => {
      const ref = passwordRef.trim() ? cleanPasswordRef(passwordRef) : undefined;
      if (passwordRef.trim() && !ref) throw new EngineError({ code: "bad_request", message: REF_PROBLEM });
      this.referenceTexts.push(passwordRef);
      this.s.passwordRef = ref;
      this.s.nextAt = ref && this.s.resticInstalled ? nextNight() : undefined;
      this.changed();
      return { backup: this.state() };
    },
    "backup.run": () => { this.start("you"); return { backup: this.state() }; },
  };

  start(by: BackupRun["by"], alreadyMade = false): void {
    if (!this.s.resticInstalled) throw new EngineError({ code: "conflict", message: RESTIC_MISSING });
    if (!this.s.passwordRef) throw new EngineError({ code: "conflict", message: PASSWORD_MISSING });
    if (this.s.running) throw new EngineError({ code: "conflict", message: "A backup is already running." });
    const at = new Date().toISOString();
    this.s.running = true;
    this.changed();
    const { outcome, problem } = this.next.shift() ?? { outcome: this.s.folder.ok ? "saved" : "failed" };
    const made = () => {
      if (outcome !== "failed") {
        this.s.history = [{ at, by, status: "made" as const, bytes: 102_000 }, ...this.s.history].slice(0, KEEP);
        this.changed();
      }
      this.timer = setTimeout(() => this.finish(at, by, outcome, problem), this.runMs);
    };
    if (alreadyMade) made();
    else this.timer = setTimeout(made, this.runMs);
  }

  private finish(at: string, by: BackupRun["by"], status: BackupOutcome, problem?: string) {
    const run: BackupRun = {
      at, by, status,
      ...(status === "failed" ? { problem: problem ?? FAILED }
        : { bytes: 102_000, snapshot: "abcdef108", ...(status === "unconfirmed" ? { problem: problem ?? NOT_CONFIRMED } : {}) }),
    };
    this.s.running = false;
    this.s.history = [run, ...this.s.history.filter((r) => r.at !== at)].slice(0, KEEP);
    if (status !== "failed") {
      this.s.lastGood = run;
      this.s.snapshots = (this.s.snapshots ?? 0) + 1;
      this.s.repositoryBytes = (this.s.repositoryBytes ?? 0) + (run.bytes ?? 0);
    }
    this.changed();
    if (status === "saved") this.host.removeCard("backup");
    else if (by === "night") this.card(status === "failed" ? "Last night's backup failed" : "Last night's upload was not confirmed", run.problem!);
  }

  private card(title: string, text: string) {
    this.host.putCard({ id: this.host.newId(), kind: "system", topic: "backup", at: new Date().toISOString(), title, text });
  }

  setNext(outcome: BackupOutcome, problem?: string) { this.next.push({ outcome, problem }); }
  setRunMs(ms: number) { this.runMs = ms; }
  night() { this.start("night"); }
  stale() { this.card("No backup for two days", "Pobots has not completed a backup in two days."); }
  setFolder(ok: boolean, problem?: string) { this.s.folder = { ...this.s.folder, ok, problem: ok ? undefined : problem ?? NO_FOLDER }; this.changed(); }
  stop() { clearTimeout(this.timer); }
}
