import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reads an op:// reference with 1Password's command line. Never logs or returns anything but the value. */
export function opRead(ref: string, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    // The service's own path is bare: look where the command line tools usually are too.
    const PATH = [process.env.PATH, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    execFile("op", ["read", "--no-newline", ref], { signal, timeout: 20_000, maxBuffer: 64 * 1024, env: { ...process.env, PATH } }, (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
  });
}
