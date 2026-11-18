// The checks' temp folder cleanup (scripts/temp-cleanup.mjs, docs/build/step-check-cleanup.md): only
// Pobots' own folders older than the limit go, and a failed run keeps what it names.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keepOnly, orphanBrowsers, ownTempFolders, sweepOld } from "../../scripts/temp-cleanup.mjs";
import { tempDir } from "./helpers.js";

const old = (path: string, hours: number) => {
  const t = (Date.now() - hours * 3600_000) / 1000;
  utimesSync(path, t, t);
};

describe("temp cleanup", () => {
  test("removes only Pobots' own folders older than the limit, by the exact prefix and mkdtemp's six letters", () => {
    const dir = tempDir();
    const made = (name: string, hours: number) => {
      const p = join(dir, name);
      mkdirSync(p);
      writeFileSync(join(p, "f"), "x");
      old(p, hours);
      return p;
    };
    const stale = made("pobots-app-check-aB3dE9", 30);
    const staleLogs = made("pobots-ui-check-logs-Zz09aa", 30);
    const fresh = made("pobots-app-check-Qw1234", 2);
    const otherProgram = made("someapp-check-aB3dE9", 30);
    const notMkdtemp = made("pobots-app-check-mine", 30);
    const handMade = made("pobots-2d-shots", 30);
    const plainFile = join(dir, "pobots-test-abcdef");
    writeFileSync(plainFile, "x");
    old(plainFile, 30);

    assert.deepEqual(ownTempFolders(undefined, dir).map((f) => f.path).sort(), [fresh, stale, staleLogs].sort());
    assert.equal(sweepOld({ dir }), 2);
    assert.ok(!existsSync(stale) && !existsSync(staleLogs), "the day-old ones are gone");
    for (const p of [fresh, otherProgram, notMkdtemp, handMade, plainFile]) assert.ok(existsSync(p), `${p} stays`);
    assert.equal(sweepOld({ dir, hours: 1 }), 1, "a shorter limit takes the fresher one too");
    assert.ok(!existsSync(fresh));
  });

  test("a failed run keeps only what it names", () => {
    const work = tempDir();
    for (const name of ["shots", "data", "bots", "browser", "files"]) mkdirSync(join(work, name));
    writeFileSync(join(work, "engine.log"), "x");
    keepOnly(work, ["shots", "data", "bots", "engine.log"]);
    for (const name of ["shots", "data", "bots", "engine.log"]) assert.ok(existsSync(join(work, name)), `${name} stays`);
    for (const name of ["browser", "files"]) assert.ok(!existsSync(join(work, name)), `${name} goes`);
    keepOnly(join(work, "missing"), []);
  });

  test("leftover browsers: only those with no parent whose profile is in the run's own prefix, never a watchdog (fix 0.26.1)", () => {
    const shell = "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell --headless";
    const list = [
      { pid: 11, ppid: 1, command: `${shell} --user-data-dir=/var/folders/ab/T/pobots-ui-check-a1B2c3/browser --remote-debugging-port=0 about:blank` },
      { pid: 12, ppid: 500, command: `${shell} --user-data-dir=/var/folders/ab/T/pobots-ui-check-d4E5f6/browser about:blank` },
      { pid: 13, ppid: 1, command: `${shell} --user-data-dir=/var/folders/ab/T/pobots-app-check-g7H8i9/browser about:blank` },
      { pid: 14, ppid: 1, command: `/opt/node scripts/process-watchdog.mjs 400 --user-data-dir=/var/folders/ab/T/pobots-ui-check-a1B2c3/browser` },
      { pid: 15, ppid: 1, command: `${shell} --user-data-dir=/var/folders/ab/T/pobots-ui-check-logs-a1B2c3/browser about:blank` },
      { pid: 16, ppid: 1, command: `${shell} --user-data-dir=/Users/x/Library/Application Support/Google/Chrome` },
      { pid: 17, ppid: 1, command: `${shell} --user-data-dir=/var/folders/ab/T/pobots-ui-check-j1K2l3` },
    ];
    assert.deepEqual(orphanBrowsers(["pobots-ui-check-"], list), [11, 17]);
    assert.deepEqual(orphanBrowsers(["pobots-ui-check-", "pobots-app-check-"], list), [11, 13, 17]);
  });
});
