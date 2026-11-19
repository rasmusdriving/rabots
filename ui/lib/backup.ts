import type { BackupRun, BackupState } from "../../shared/protocol";
import { PASSWORD_MISSING, RESTIC_MISSING } from "../../shared/backup-settings";
import { clockTime, fileSize } from "./words";

export const runWords: Record<BackupRun["status"], string> = {
  made: "Made, checking upload",
  saved: "Saved to iCloud",
  unconfirmed: "Made, upload not confirmed",
  failed: "Backup failed",
};

export function backupLine(state: BackupState, now: Date) {
  const last = state.history[0];
  if (!state.resticInstalled) return RESTIC_MISSING;
  if (!state.passwordRef) return PASSWORD_MISSING;
  if (state.running && last?.status !== "made") return "Backing up now.";
  if (!last) return "No backups yet.";
  return `${runWords[last.status]} · ${clockTime(last.at, now)}`;
}

export function runNote(run: BackupRun): string {
  const parts = [run.by === "you" ? "By you" : "Nightly"];
  if (run.bytes !== undefined) parts.push(`${fileSize(run.bytes)} added`);
  if (run.leftOut?.length) parts.push(`${run.leftOut.length} large ${run.leftOut.length === 1 ? "file" : "files"} left out`);
  return parts.join(" · ");
}
