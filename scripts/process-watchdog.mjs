// The watchdog of a check's child process (fix 0.26.1, docs/build/step-fix-0.26.1.md). A check starts
// one per headless browser (and the app check one per engine), detached, so it lives on when the check
// is killed outright (SIGKILL, a crash, a closed terminal). On 16 Nov 2026 nine browsers of killed
// window checks were left running with no parent, about 850 MB.
//
//   node scripts/process-watchdog.mjs <the check's pid> <text in the child's command line>
//
// While the check lives it only looks, once a second. When the check is gone it ends every process
// whose command line holds the text (the browser and its helpers: all of them carry the browser's own
// temporary profile folder), first politely, then for good after three seconds, and ends itself. It
// also ends itself once the child is gone while the check still runs (the check closed it).
import { spawnSync } from "node:child_process";

const [parent, match] = [Number(process.argv[2]), process.argv[3]];
if (!parent || !match || match.length < 12) process.exit(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
/** The processes whose command line holds the text, never this one. */
function matching() {
  const out = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  const pids = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    if (m[2].includes(match) && !m[2].includes("process-watchdog.mjs")) pids.push(Number(m[1]));
  }
  return pids;
}
function signal(pids, sig) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

let seen = false;
for (;;) {
  const now = matching();
  if (now.length) seen = true;
  if (!alive(parent)) {
    if (now.length) {
      signal(now, "SIGTERM");
      for (let i = 0; i < 30 && matching().length; i++) await sleep(100);
      signal(matching(), "SIGKILL");
    }
    process.exit(0);
  }
  // Closed by the check itself: nothing left to watch.
  if (seen && !now.length) process.exit(0);
  await sleep(1000);
}
