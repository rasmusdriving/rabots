// Small process boundary shared with the restore CLI. Never return a child's raw error or stderr.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const KEEP = 14;
export const STAGE_NAME = ".backup-restic-stage";

export function findRestic(executable?: string): string | undefined {
  const candidates = executable !== undefined
    ? [executable]
    : [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(isAbsolute).map((dir) => join(dir, "restic"));
  return candidates.find((path) => {
    if (!isAbsolute(path)) return false;
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export interface Snapshot {
  id: string;
  time: string;
  paths: string[];
  tags?: string[];
  summary?: { data_added?: number; data_added_packed?: number };
}

export class ResticError extends Error {
  readonly code: number | string | null | undefined;
  constructor(message: string, code: number | string | null | undefined) {
    super(message);
    this.code = code;
  }
}

export function restic(options: {
  executable: string;
  folder: string;
  password: string;
  args: string[];
  signal?: AbortSignal;
  cacheDir?: string;
}): Promise<string> {
  const { executable, folder, password, args, signal, cacheDir } = options;
  const operation = args[0] ?? "command";
  // Keep credentials and RESTIC_* overrides from the engine's environment away from restic.
  // The password is only in this child's environment, never in argv, stderr or a file.
  const env = { HOME: homedir(), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, RESTIC_PASSWORD: password, GOMAXPROCS: "2", TZ: "UTC" };
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, ["--repo", folder, ...(cacheDir ? ["--cache-dir", cacheDir] : ["--no-cache"]), ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    const max = 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stopped = false;
    let failedToStart = false;
    let killAfter: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      killAfter = setTimeout(() => child.kill("SIGKILL"), 2000);
      killAfter.unref();
    };
    const timeout = setTimeout(stop, 55 * 60_000);
    timeout.unref();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      if (stdout.length + s.length <= max) stdout += s;
      else stop();
    });
    child.stderr.setEncoding("utf8").on("data", (s: string) => {
      if (stderr.length + s.length <= max) stderr += s;
      else stop();
    });
    child.on("error", () => { failedToStart = true; });
    // Wait for the process and its output pipes to close even when the engine is stopping.
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killAfter);
      signal?.removeEventListener("abort", stop);
      if (code === 0 && !stopped && !failedToStart) return resolve(stdout);
      const message = code === 12 || /wrong password or no key found/i.test(stderr)
        ? "The password did not open the backup repository. Check the 1Password reference."
        : code === 11 || /repository is already locked|unable to create lock/i.test(stderr)
          ? "The backup repository is locked. It may be in use by another backup or restore."
          : operation === "check"
            ? "Restic could not verify the backup repository."
            : `Restic could not complete the backup (${operation}).`;
      reject(new ResticError(message, code));
    });
  });
}

export function parseSnapshots(text: string): Snapshot[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Restic did not list the snapshots in the expected format."); }
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s?.id !== "string" || !/^[a-f0-9]{64}$/.test(s.id) || typeof s.time !== "string" || !Array.isArray(s.paths))) {
    throw new Error("Restic did not list the snapshots in the expected format.");
  }
  return value as Snapshot[];
}
