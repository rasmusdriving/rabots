// The temporary folders that Pobots' checks and tests make in the system temp folder ($TMPDIR), and
// how they go away again (docs/build/step-check-cleanup.md, 16 Nov 2026).
//
// - Each check removes its own folder at the end when it passed, and keeps only what is needed to
//   read a failure when it failed (its log and pictures).
// - A run that is stopped (Ctrl-C, SIGTERM, SIGHUP) cleans up on the way out: onStop below.
// - At start, each check removes leftovers older than a day (sweepOld below): folders named by one
//   of Pobots' own prefixes followed by the six letters mkdtemp adds, and nothing else.
// Deletion is real (fs.rm), not the Trash: these are throwaway copies made by the checks themselves.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every prefix this repository gives a temporary folder (mkdtemp in scripts/, engine/tests/). */
export const PREFIXES = [
  // The checks
  "pobots-app-check-", "pobots-ui-check-", "pobots-app-check-logs-", "pobots-ui-check-logs-",
  "pobots-remote-check-", "pobots-smoke-", "pobots-seal-check-", "pobots-browser-check-", "pobots-icons-",
  // The engine's tests (engine/tests/helpers.ts tempDir)
  "pobots-test-", "pobots-aside-", "pobots-backup-keys-", "pobots-bots-", "pobots-clock-", "pobots-clock-bots-",
  "pobots-clock-cloud-", "pobots-cloud-", "pobots-cloud-parent-", "pobots-codex-bot-", "pobots-config-",
  "pobots-data-", "pobots-fake-codex-", "pobots-half-", "pobots-outside-", "pobots-prune-", "pobots-restored-data-",
  "pobots-restored-home-", "pobots-rs-db-", "pobots-rs-file-", "pobots-rs-from-", "pobots-unlocked-",
  // A restore's unpacked copy (scripts/restore.mjs removes it itself; one left by a crash goes here)
  "pobots-restore-",
  // The trials in scripts/dev, run by hand
  "pobots-attach-engine-bots-", "pobots-attach-engine-data-", "pobots-attach-engine-files-", "pobots-attach-trial-",
  "pobots-backup-real-trial-", "pobots-backup-trial-", "pobots-codex-attach-", "pobots-codex-trial-",
  "pobots-layout-print-", "pobots-phone-chat-look-", "pobots-phone-look-", "pobots-plan-trial-",
  "pobots-steer-trial-", "pobots-tool-cost-", "pobots-wait-trial-",
];

const HOUR = 60 * 60 * 1000;
// What mkdtemp adds to the prefix. So "pobots-app-check-" never matches "pobots-app-check-logs-abc123".
const MKDTEMP_TAIL = /^[A-Za-z0-9]{6}$/;

/** The folders in the temp folder made with one of these prefixes, with their age in hours. */
export function ownTempFolders(prefixes = PREFIXES, dir = tmpdir()) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const prefix = prefixes.find((p) => name.startsWith(p) && MKDTEMP_TAIL.test(name.slice(p.length)));
    if (!prefix) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isDirectory()) out.push({ path: join(dir, name), prefix, hours: (Date.now() - st.mtimeMs) / HOUR });
    } catch {
      // Gone while we looked.
    }
  }
  return out;
}

/** Removes Pobots' own temporary folders older than `hours` (a day unless given). Returns how many. */
export function sweepOld({ hours = 24, prefixes = PREFIXES, dir = tmpdir() } = {}) {
  let removed = 0;
  for (const f of ownTempFolders(prefixes, dir)) {
    if (f.hours < hours) continue;
    try {
      rmSync(f.path, { recursive: true, force: true });
      removed++;
    } catch {
      // Another check removed it first, or it is not ours to remove: leave it.
    }
  }
  return removed;
}

/** Removes everything in `dir` except the names in `keep` (what a failed run keeps to be read). */
export function keepOnly(dir, keep) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * Runs `cleanup` when the process is stopped by a signal, then exits as a stopped process would
 * (128 + the signal's number). The cleanup may be async; it gets ten seconds unless `ms` says
 * otherwise. A second signal while it runs is ignored: a Ctrl-C reaches a section both from the
 * terminal and from check-all.mjs, and the second must not cut the first one's cleanup short.
 */
export function onStop(cleanup, { ms = 10_000 } = {}) {
  let stopping = false;
  for (const [signal, n] of Object.entries(SIGNALS)) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => process.exit(128 + n), ms);
      Promise.resolve()
        .then(() => cleanup(signal))
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          process.exit(128 + n);
        });
    });
  }
}

/**
 * The leftover browsers of earlier runs (fix 0.26.1): processes whose parent is gone (parent pid 1)
 * and whose command line names a browser profile in one of these temp-folder prefixes, as
 * `--user-data-dir=<tmp>/<prefix><six letters>/...`. Normally the watchdog (process-watchdog.mjs) ends
 * them; this catches what it could not, such as browsers of runs from before it. A browser of a run that still works has that run
 * as its parent, so it is never one of them. `ps` is the source; `list` stands in for it in tests.
 */
export function orphanBrowsers(prefixes, list = psList()) {
  const re = new RegExp(`--user-data-dir=\\S*/(?:${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[A-Za-z0-9]{6}(?:/|\\s|$)`);
  // A running check's watchdog (process-watchdog.mjs) has no parent either and names the same folder: never it.
  return list.filter((p) => p.ppid === 1 && re.test(p.command) && !p.command.includes("process-watchdog.mjs")).map((p) => p.pid);
}

function psList() {
  const out = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** Ends the leftover browsers of earlier runs with these prefixes (orphanBrowsers). Returns how many. */
export async function killOrphanBrowsers(prefixes) {
  const pids = orphanBrowsers(prefixes);
  if (!pids.length) return 0;
  const send = (list, sig) => {
    for (const pid of list) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  send(pids, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!orphanBrowsers(prefixes).some((p) => pids.includes(p))) break;
  }
  send(orphanBrowsers(prefixes).filter((p) => pids.includes(p)), "SIGKILL");
  console.log(`Ended ${pids.length} browser process${pids.length === 1 ? "" : "es"} left by an earlier run.`);
  return pids.length;
}

/**
 * Stops this run as a stop by SIGTERM would (onStop's cleanup) when the process that started it is
 * gone (fix 0.26.1): a section of check-all.mjs whose check-all was killed outright would otherwise
 * run on by itself, with its browser and engine. Looks once a second; never keeps the process alive.
 */
export function stopWithParent() {
  const first = process.ppid;
  if (first <= 1) return;
  const timer = setInterval(() => {
    if (process.ppid === first) return;
    clearInterval(timer);
    console.log("\nThe run that started this one is gone. Stopping.");
    process.kill(process.pid, "SIGTERM");
  }, 1000);
  timer.unref();
}
