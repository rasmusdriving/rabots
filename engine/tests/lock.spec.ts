// One engine per data folder: engine.json and the check for a running engine. No model.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import type { Engine } from "../engine.js";
import { lockPath, pidAlive, readLock, removeLock, runningEngine, writeLock } from "../lock.js";
import { EngineServer } from "../server.js";
import { tempDir } from "./helpers.js";

/** A live process that is not this one, to stand in for another engine's pid. */
function otherProcess(): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    child.once("spawn", () => resolve(child));
  });
}

const deadPid = (): number => {
  // A pid far above what is in use. Checked, in case.
  for (let pid = 4_000_000; pid > 3_000_000; pid -= 7919) if (!pidAlive(pid)) return pid;
  throw new Error("no free pid found");
};

describe("lock", () => {
  test("engine.json is written with mode 0600, read back, and removed only by its owner", () => {
    const dir = tempDir();
    const lock = { pid: process.pid, port: 47601, token: "t", serve: true, startedAt: "2026-11-11T10:00:00.000Z" };
    writeLock(dir, lock);
    assert.equal(statSync(lockPath(dir)).mode & 0o777, 0o600);
    assert.deepEqual(readLock(dir), lock);

    // Another engine's file stays.
    writeLock(dir, { ...lock, pid: process.pid + 1 });
    removeLock(dir);
    assert.ok(existsSync(lockPath(dir)));
    removeLock(dir, process.pid + 1);
    assert.ok(!existsSync(lockPath(dir)));
    assert.equal(readLock(dir), undefined);

    writeFileSync(lockPath(dir), "{ broken");
    assert.equal(readLock(dir), undefined);
  });

  test("a stale file (dead process) does not count as a running engine", async () => {
    const dir = tempDir();
    writeLock(dir, { pid: deadPid(), port: 1, token: "t", serve: false, startedAt: "" });
    assert.equal(await runningEngine(dir), undefined);
  });

  test("a live process whose port is not a Pobots engine does not count", async () => {
    const dir = tempDir();
    const child = await otherProcess();
    const plain: Server = createServer((_req, res) => res.end("hello"));
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    try {
      writeLock(dir, { pid: child.pid!, port: (plain.address() as AddressInfo).port, token: "t", serve: false, startedAt: "" });
      assert.equal(await runningEngine(dir), undefined);
    } finally {
      child.kill();
      plain.close();
    }
  });

  test("a live process with an engine on its port counts", async () => {
    const dir = tempDir();
    const child = await otherProcess();
    const server = new EngineServer("t");
    server.attach({} as Engine);
    const port = await server.listen(0);
    try {
      writeLock(dir, { pid: child.pid!, port, token: "t", serve: true, startedAt: "now" });
      const found = await runningEngine(dir);
      assert.equal(found?.port, port);
      assert.equal(found?.pid, child.pid);
      // This process's own file never counts as another engine.
      writeLock(dir, { pid: process.pid, port, token: "t", serve: true, startedAt: "now" });
      assert.equal(await runningEngine(dir), undefined);
    } finally {
      child.kill();
      await server.close();
    }
  });
});
