import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface UploadState {
  exists?: boolean;
  ubiquitous?: boolean | null;
  uploaded?: boolean | null;
  uploading?: boolean | null;
  uploadError?: string | null;
}

export type UploadReader = (paths: string[], signal: AbortSignal) => Promise<UploadState[] | undefined>;
export interface BackupTimings { pollMs: number; holdMs: number; limitMs: number; staleMs: number; stopMs: number }
export const BACKUP_TIMINGS: BackupTimings = { pollMs: 5000, holdMs: 5000, limitMs: 120_000, staleMs: 48 * 3600_000, stopMs: 12_000 };
export const UPLOAD_UNKNOWN = "macOS did not report the upload of these files.";
export const UPLOAD_PENDING = "iCloud Drive did not confirm the upload in time.";
export const UPLOAD_ERROR = "macOS reported an iCloud upload error. Check iCloud Drive on the Mac.";

const polling: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> } = {
  now: () => performance.now(),
  wait: (ms: number, signal: AbortSignal) => setTimeout(ms, undefined, { signal }),
};

export function readMacUpload(paths: string[], signal: AbortSignal): Promise<UploadState[] | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  const script = fileURLToPath(new URL("./upload-state.js", import.meta.url));
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", script, ...paths],
      { signal, timeout: 15_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
        if (err) return resolve(undefined);
        try {
          const parsed = JSON.parse(stdout);
          resolve(paths.length === 1 && parsed && !Array.isArray(parsed) ? [parsed] : Array.isArray(parsed) && parsed.length === paths.length ? parsed : undefined);
        } catch {
          resolve(undefined);
        }
      });
  });
}

export async function confirmUpload(
  root: string, paths: string[], read: UploadReader, timing: BackupTimings, signal: AbortSignal,
  clock = polling,
): Promise<string | undefined> {
  if (!paths.length) return UPLOAD_UNKNOWN;
  const deadline = clock.now() + timing.limitMs;
  let readySince: number | undefined;
  // Keep only each batch's latest report, including if time runs out partway through a sweep.
  const erroredBatches = new Set<number>();
  const timedOut = () => erroredBatches.size ? UPLOAD_ERROR : UPLOAD_PENDING;
  while (clock.now() <= deadline) {
    signal.throwIfAborted();
    let all = true;
    for (let i = 0; i < paths.length; i += 96) {
      const batch = paths.slice(i, i + 96).map((p) => join(root, p));
      const readings = await read(batch, signal);
      signal.throwIfAborted();
      if (!readings) return UPLOAD_UNKNOWN;
      const hasError = readings.some((r) => r.uploadError);
      if (hasError) erroredBatches.add(i);
      else erroredBatches.delete(i);
      if (readings.some((r) => !r.uploadError && (!r.exists || r.ubiquitous !== true || typeof r.uploaded !== "boolean"))) return UPLOAD_UNKNOWN;
      if (hasError || readings.some((r) => !r.uploaded || r.uploading)) all = false;
      if (clock.now() > deadline) return timedOut();
    }
    const now = clock.now();
    readySince = all ? readySince ?? now : undefined;
    if (readySince !== undefined && now - readySince >= timing.holdMs) return;
    if (now >= deadline) break;
    await clock.wait(Math.min(timing.pollMs, deadline - now), signal);
  }
  return timedOut();
}
