// One engine per data folder. A running engine writes <dataDir>/engine.json (mode 0600) with its
// pid, port and token, and removes it on a clean stop. A new engine, and the desktop shell, read it
// to find an engine that already runs. The file holds the token: never log its contents.
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { EngineLock } from "../shared/protocol.js";

export const LOCK_FILE = "engine.json";
/** Every HTTP answer from an engine carries this header, so a probe can tell it is one. */
export const ENGINE_HEADER = "x-pobots-engine";

export const lockPath = (dataDir: string): string => join(dataDir, LOCK_FILE);

/** The lock file's contents, or undefined when it is missing or not readable. */
export function readLock(dataDir: string): EngineLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath(dataDir), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pid !== "number" || typeof o.port !== "number" || typeof o.token !== "string") return undefined;
  return {
    pid: o.pid,
    port: o.port,
    token: o.token,
    serve: o.serve === true,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
  };
}

export function writeLock(dataDir: string, lock: EngineLock): void {
  const path = lockPath(dataDir);
  // Remove first: writeFileSync keeps the mode of a file that is already there.
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Removes the lock file, but only if it is still this process's own. */
export function removeLock(dataDir: string, pid: number = process.pid): void {
  const lock = readLock(dataDir);
  if (lock && lock.pid !== pid) return;
  rmSync(lockPath(dataDir), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when something on 127.0.0.1:<port> answers as a Pobots engine. */
export function answersAsEngine(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);
    const req = request({ host: "127.0.0.1", port, path: "/api/whoami", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(typeof res.headers[ENGINE_HEADER] === "string");
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** The engine that runs on this data folder right now, if any. A stale lock file gives undefined. */
export async function runningEngine(dataDir: string): Promise<EngineLock | undefined> {
  const lock = readLock(dataDir);
  if (!lock || lock.pid === process.pid || !pidAlive(lock.pid)) return undefined;
  return (await answersAsEngine(lock.port)) ? lock : undefined;
}
