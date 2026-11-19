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
): Promise<string | undefined> {
  if (!paths.length) return UPLOAD_UNKNOWN;
  const start = performance.now();
  let readySince: number | undefined;
  const remaining = [...paths];
  while (performance.now() - start <= timing.limitMs) {
    signal.throwIfAborted();
    let all = true;
    for (let i = 0; i < remaining.length; i += 96) {
      const batch = remaining.slice(i, i + 96).map((p) => join(root, p));
      const readings = await read(batch, signal);
      signal.throwIfAborted();
      if (!readings) return UPLOAD_UNKNOWN;
      if (readings.some((r) => r.uploadError)) return UPLOAD_ERROR;
      if (readings.some((r) => !r.exists || r.ubiquitous !== true || typeof r.uploaded !== "boolean")) return UPLOAD_UNKNOWN;
      if (readings.some((r) => !r.uploaded || r.uploading)) all = false;
      if (performance.now() - start > timing.limitMs) return UPLOAD_PENDING;
    }
    const now = performance.now();
    readySince = all ? readySince ?? now : undefined;
    if (readySince !== undefined && now - readySince >= timing.holdMs) return;
    await setTimeout(timing.pollMs, undefined, { signal });
  }
  return UPLOAD_PENDING;
}
