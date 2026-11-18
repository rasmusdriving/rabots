// A whole check, its sections side by side. Each section of scripts/ui-check.mjs (the app window
// against its mock) or scripts/app-check.mjs (the real window, engine and models) runs in a
// process, a browser and, for the app check, an engine of its own, a few at a time. Measured on
// 14 Nov 2026 (docs/decisions.md): the window check 2 min 46 s instead of 13 min 49 s.
//
// Run: npm run check:ui    or    npm run check:app          (both build first)
//      node scripts/check-all.mjs <ui|app> [--jobs=N] [--only=a,b] [--logs=DIR] [anything for the check]
//   --jobs=N     how many sections run at the same time (ui: 8, app: 4 unless given)
//   --only=a,b   only these sections (one section alone: node scripts/ui-check.mjs --only=a)
//   --logs=DIR   where each section's full output goes (default: a temp folder, kept and named at the
//                end when a section failed, removed when all passed)
//   everything else (--shots=DIR, --keep, ...) is passed on to every section
//
// Only the lines that failed are printed, with one line per section and the totals at the end in
// the words the window check always used ("N passed, M failed"). A section that failed runs once
// more by itself: some checks time what the page does or wait for a model, and one of them can fail
// only because the Mac was busy with the other sections. The end says which those were. A section
// that fails alone too is a failure.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killOrphanBrowsers, onStop, sweepOld } from "./temp-cleanup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHECKS = {
  ui: { script: "ui-check.mjs", name: "The window check", jobs: 8 },
  app: { script: "app-check.mjs", name: "The app check", jobs: 4 },
};
const which = process.argv[2];
const kind = CHECKS[which];
if (!kind) {
  console.error("Usage: node scripts/check-all.mjs <ui|app> [--jobs=N] [--only=a,b] [--logs=DIR]");
  process.exit(2);
}
const script = join(here, kind.script);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const passOn = process.argv.slice(3).filter((a) => !/^--(jobs|only|logs)=/.test(a));

const listed = spawnSync(process.execPath, [script, "--sections"], { encoding: "utf8" });
if (listed.status !== 0) {
  process.stderr.write(listed.stdout + listed.stderr);
  process.exit(listed.status ?? 1);
}
const all = listed.stdout.split("\n").filter(Boolean);
const wanted = arg("only")?.split(",").filter(Boolean);
const unknown = (wanted ?? []).filter((s) => !all.includes(s));
if (unknown.length) {
  console.error(`No section "${unknown.join('", "')}". The sections: ${all.join(", ")}`);
  process.exit(2);
}
// The longest sections start first, by how long each took the last time on this machine, so a long
// one never ends up running alone at the end. A section never timed yet counts as long.
const timesFile = join(homedir(), ".cache", `pobots-${which}-check-times.json`);
let lastTimes = {};
try {
  lastTimes = JSON.parse(readFileSync(timesFile, "utf8"));
} catch {
  // No times yet: the listed order.
}
const sections = [...(wanted ?? all)].sort((a, b) => (lastTimes[b] ?? Infinity) - (lastTimes[a] ?? Infinity));
const jobs = Math.max(1, Math.min(sections.length, Number(arg("jobs") ?? kind.jobs) || kind.jobs));
// Leftovers of checks and tests that crashed or were stopped more than a day ago go first (temp-cleanup.mjs).
sweepOld();
// Browsers left running by earlier runs that were killed outright (fix 0.26.1). Each section also
// stops by itself when this run is killed (stopWithParent in its lib.mjs).
await killOrphanBrowsers([`pobots-${which}-check-`]);
const logs = arg("logs") ?? mkdtempSync(join(tmpdir(), `pobots-${which}-check-logs-`));
mkdirSync(logs, { recursive: true });

// Stopped (Ctrl-C, SIGTERM, SIGHUP): every running section is told, and gets time to clean up its
// own temp folder before this ends. The logs stay, to be read.
const running = new Set();
let stopped = false;
onStop(async (signal) => {
  stopped = true;
  console.log(`\nStopped. Waiting for ${running.size} running section${running.size === 1 ? "" : "s"} to clean up. Their output: ${logs}`);
  await Promise.all([...running].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill(signal);
  })));
}, { ms: 20_000 });

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

/** Runs one section and resolves with its counts, its failed lines and how long it took. */
function run(section, tag = "") {
  return new Promise((resolve) => {
    // Stopped: no new section starts; this waits for the end that onStop above brings.
    if (stopped) return;
    const started = Date.now();
    const file = join(logs, `${section}${tag}.log`);
    const out = createWriteStream(file);
    const child = spawn(process.execPath, [script, `--only=${section}`, ...passOn], { stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    let text = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (d) => {
        text += d;
        out.write(d);
      });
    }
    child.on("close", (code) => {
      running.delete(child);
      out.end();
      // Both checks print one line per check: "ok  ..." or "FAIL ...".
      const lines = text.split("\n");
      const passed = lines.filter((l) => l.startsWith("ok  ")).length;
      const fails = lines.filter((l) => l.startsWith("FAIL"));
      // Ended badly without a failed line (it crashed, or was stopped): that is one failure.
      if (code !== 0 && !fails.length) fails.push(`FAIL ${section}: the section ended with exit ${code} and no failed check; see ${file}`);
      resolve({ section, passed, failed: fails.length, fails, ms: Date.now() - started, file, ok: code === 0 && fails.length === 0 });
    });
  });
}

const started = Date.now();
console.log(`${kind.name}: ${sections.length} section${sections.length === 1 ? "" : "s"}, ${jobs} at a time.`);
const results = new Map();
const queue = [...sections];
async function worker() {
  for (let section = queue.shift(); section; section = queue.shift()) {
    const r = await run(section);
    results.set(section, r);
    console.log(`${r.ok ? "ok  " : "FAIL"} section ${section}: ${r.passed} passed, ${r.failed} failed (${seconds(r.ms)})`);
    if (!r.ok) for (const line of r.fails) console.log(`  ${line}`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

try {
  mkdirSync(dirname(timesFile), { recursive: true });
  writeFileSync(timesFile, JSON.stringify({ ...lastTimes, ...Object.fromEntries([...results].map(([name, r]) => [name, r.ms])) }));
} catch {
  // Only the order of the next run depends on it.
}

// A section that failed runs once more, alone.
const onlyBusy = [];
for (const section of sections) {
  const first = results.get(section);
  if (first.ok) continue;
  console.log(`Section ${section} again, by itself.`);
  const again = await run(section, "-alone");
  console.log(`${again.ok ? "ok  " : "FAIL"} section ${section}, by itself: ${again.passed} passed, ${again.failed} failed (${seconds(again.ms)})`);
  if (again.ok) onlyBusy.push({ section, fails: first.fails });
  else for (const line of again.fails) console.log(`  ${line}`);
  results.set(section, again);
}

let passed = 0;
const failed = [];
for (const section of sections) {
  const r = results.get(section);
  passed += r.passed;
  if (!r.ok) for (const line of r.fails) failed.push(`${section}: ${line.replace(/^FAIL\s*/, "")}`);
}
if (onlyBusy.length) {
  console.log("\nFailed side by side and passed alone (a check that times something, on a busy Mac):");
  for (const b of onlyBusy) for (const line of b.fails) console.log(`  - ${b.section}: ${line.replace(/^FAIL\s*/, "")}`);
}
// The logs are kept when something failed, also when it then passed alone; otherwise their temp folder goes.
const anyFail = failed.length > 0 || onlyBusy.length > 0;
if (anyFail || arg("logs")) console.log(`\nEach section's full output: ${logs}`);
else rmSync(logs, { recursive: true, force: true });
console.log(`Took ${seconds(Date.now() - started)}.`);
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
