// Updates a running Pobots safely, also when the one who asks is a bot inside that Pobots.
//
//   node scripts/live-update.mjs request [--note="what is new"] [--wait=30]
//       Stages what is built (dist/) on the internal drive and hands the update to a small job of
//       its own under launchd, then returns at once. The job waits until every bot is idle, stops
//       the engine, backs up the database, swaps the build in, starts the engine and checks that it
//       came back with the same bots. If it did not, the job puts the old build and the database
//       back and starts that. The result is written to <data dir>/updates/last.json.
//   node scripts/live-update.mjs status
//       Says what the last update did, and whether one is waiting.
//
// Why a job of its own: an update restarts the engine, and a bot's commands die with the engine.
// So a bot asks for the update, ends its turn, and reads the result afterwards.
//
// Flags: --test-copy works on the test copy (app.pobots.engine-test) instead of the real Pobots.
//        --break (only with --test-copy) stages a build that cannot start, to try the way back.
//        --allow-dirty stages a build from a working tree with uncommitted changes.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();
const domain = `gui/${userInfo().uid}`;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
const loaded = (label) => launchctl("print", `${domain}/${label}`).status === 0;
const now = () => new Date().toISOString();

/** Where things are for the real Pobots, or for the test copy. */
function places(testCopy) {
  const label = testCopy ? "app.pobots.engine-test" : "app.pobots.engine";
  return {
    testCopy,
    label,
    jobLabel: testCopy ? "app.pobots.update-test" : "app.pobots.update",
    dataDir: join(home, "Library", "Application Support", testCopy ? "Pobots-test" : "Pobots"),
    stageDir: join(home, ".local", "share", "pobots-update", label),
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
  };
}

const command = process.argv[2];

// ------------------------------------------------------------ request (run from the repo)
if (command === "request") {
  const repo = dirname(here);
  const p = places(has("test-copy"));
  if (has("break") && !p.testCopy) fail("--break is only for the test copy.");
  if (!existsSync(join(repo, "dist", "engine", "main.mjs")) || !existsSync(join(repo, "dist", "ui", "index.html"))) fail("Nothing is built yet. Run: npm run build");
  if (!existsSync(p.plistPath)) fail(`${p.testCopy ? "The test copy" : "Pobots"} is not installed as a background service yet. Install it first.`);
  if (loaded(p.jobLabel)) fail("An update is already waiting or running. See: node scripts/live-update.mjs status");

  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" }).stdout.trim();
  const dirty = git("status", "--porcelain");
  if (dirty && !has("allow-dirty")) fail("There are changes that are not committed. Commit first, so the result can name what was installed.");
  const commit = git("rev-parse", "--short", "HEAD") + (dirty ? " plus uncommitted changes" : "");

  const deps = dirname(realpathSync(join(repo, "node_modules")));
  const electron = join(deps, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (!existsSync(electron)) fail("Electron is not installed. Run: node scripts/install.mjs");
  const installDir = p.testCopy ? join(home, ".local", "share", "pobots-test") : deps;
  if (!existsSync(join(installDir, "dist", "engine", "main.mjs"))) fail(`There is no installed build in ${installDir} to update.`);

  const protocol = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(repo, "shared", "protocol.ts"), "utf8"))?.[1]);
  const version = /export const ENGINE_VERSION = "([^"]+)"/.exec(readFileSync(join(repo, "engine", "engine.ts"), "utf8"))?.[1];
  if (!protocol || !version) fail("Could not read the protocol number or the engine's version from the source.");

  rmSync(p.stageDir, { recursive: true, force: true });
  mkdirSync(p.stageDir, { recursive: true });
  cpSync(join(repo, "dist"), join(p.stageDir, "dist"), { recursive: true });
  copyFileSync(join(repo, "package.json"), join(p.stageDir, "package.json"));
  copyFileSync(fileURLToPath(import.meta.url), join(p.stageDir, "runner.mjs"));
  if (has("break")) writeFileSync(join(p.stageDir, "dist", "engine", "main.mjs"), 'throw new Error("This build is broken on purpose, to try the way back.");\n');
  const stage = { ...p, installDir, electron, protocol, version, commit, note: arg("note") ?? "", waitMinutes: Number(arg("wait") ?? 30), requestedAt: now() };
  writeFileSync(join(p.stageDir, "stage.json"), JSON.stringify(stage, null, 2) + "\n");

  const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const jobPlist = join(p.stageDir, "job.plist");
  writeFileSync(
    jobPlist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(p.jobLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(electron)}</string>
    <string>${xml(join(p.stageDir, "runner.mjs"))}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(p.stageDir, "run.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(p.stageDir, "run.log"))}</string>
</dict>
</plist>
`,
  );
  const started = launchctl("bootstrap", domain, jobPlist);
  if (started.status !== 0) fail(`launchd would not start the update: ${(started.stderr || started.stdout).trim()}`);
  console.log(`The update of ${p.testCopy ? "the test copy" : "Pobots"} to ${version} (${commit}) is handed over.`);
  console.log(`It starts when every bot is idle, and gives up after ${stage.waitMinutes} ${stage.waitMinutes === 1 ? "minute" : "minutes"} of waiting.`);
  console.log(`Result: ${join(p.dataDir, "updates", "last.json")}  (or: node scripts/live-update.mjs status${p.testCopy ? " --test-copy" : ""})`);
  process.exit(0);
}

// ------------------------------------------------------------ status
if (command === "status") {
  const p = places(has("test-copy"));
  if (loaded(p.jobLabel)) console.log("An update is waiting or running right now.");
  try {
    const r = JSON.parse(readFileSync(join(p.dataDir, "updates", "last.json"), "utf8"));
    console.log(`Last update, ${r.at}: ${r.summary}`);
  } catch {
    console.log("No update has been run with this command yet.");
  }
  process.exit(0);
}

// ------------------------------------------------------------ run (the job itself, from the staged copy)
if (command !== "run") fail("Use: node scripts/live-update.mjs request | status");

const s = JSON.parse(readFileSync(join(here, "stage.json"), "utf8"));
const target = `${domain}/${s.label}`;
const dist = join(s.installDir, "dist");
const previous = join(s.installDir, "dist.previous");
const db = join(s.dataDir, "pobots.db");
const updatesDir = join(s.dataDir, "updates");
const log = (line) => console.log(`${now()} ${line}`);
const WebSocket = createRequire(join(s.installDir, "package.json"))("ws");

/** One short look at the running engine: its version and its bots. Undefined when it cannot be reached. */
async function look(protocol) {
  let note;
  try {
    note = JSON.parse(readFileSync(join(s.dataDir, "engine.json"), "utf8"));
  } catch {
    return undefined;
  }
  return await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${note.port}/ws?token=${note.token}`);
    const done = (v) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), 8000);
    let hello;
    ws.on("error", () => done(undefined));
    ws.on("open", () => ws.send(JSON.stringify({ t: "req", id: "h", method: "hello", params: { protocol, client: "live-update" } })));
    ws.on("message", (raw) => {
      // Nothing may throw out of here: this runs while the engine may be stopped, and a job that dies leaves it so.
      try {
        const f = JSON.parse(String(raw));
        if (f.t !== "res") return;
        if (!f.ok) {
          // An engine on another protocol number says its own: "(app 12, engine 10)". Any other refusal
          // (the engine is still starting) is not about the number.
          const message = String(f.error?.message ?? "refused");
          const mismatch = f.error?.code === "protocol_mismatch";
          return done({ refused: message, mismatch, speaks: mismatch ? Number(/\bengine (\d+)\)/.exec(message)?.[1]) || undefined : undefined });
        }
        if (f.id === "h") {
          hello = f.result;
          ws.send(JSON.stringify({ t: "req", id: "s", method: "snapshot", params: {} }));
        } else if (f.id === "s") {
          const bots = f.result?.bots;
          const readable = typeof hello?.engineVersion === "string" && Array.isArray(bots) && bots.every((b) => typeof b?.id === "string" && typeof b?.state === "string");
          if (!readable) return done({ refused: "its answer was not in a form the update can read", mismatch: false });
          // The open approvals and questions, to say which come back after the restart (engine 0.29.0).
          const cards = (Array.isArray(f.result?.cards) ? f.result.cards : []).filter((c) => c?.kind === "approval" || c?.kind === "question").map((c) => ({ botId: String(c.botId ?? ""), title: String(c.title ?? "") }));
          done({ pid: note.pid, version: hello.engineVersion, cards, bots: bots.map((b) => ({ id: b.id, name: b.name, state: b.state, helpers: b.helpers ?? 0, managers: (b.taskManagers ?? []).filter((m) => m.state !== "resting").length, managersWaiting: (b.taskManagers ?? []).filter((m) => m.state === "waiting").length })) });
        }
      } catch {
        done(undefined);
      }
    });
  });
}

/** What the engine last said when it answered but refused the hello. Empty when it answered well or not at all. */
let lastRefusal = "";

/**
 * The engine speaks one protocol number; the old build and the new one may differ, and by more than
 * one: on 13 Nov 2026 the real Pobots spoke 10 and the new build 12, and an update that only tried
 * the numbers next to its own never got an answer. An engine that refuses says its own number, so
 * that one is tried next (once); the numbers around the new build's are tried too, for an engine that
 * does not. Undefined means: no usable answer this time, look again later.
 */
async function lookAny() {
  const queue = [s.protocol, s.protocol - 1, s.protocol + 1, s.protocol - 2, s.protocol + 2, s.protocol - 3, s.protocol + 3];
  const tried = new Set();
  let referred = false;
  lastRefusal = "";
  while (queue.length) {
    const protocol = queue.shift();
    if (!(protocol >= 1) || tried.has(protocol)) continue;
    tried.add(protocol);
    const v = await look(protocol);
    if (!v) return undefined; // no answer at all: another number will not help
    if (!v.refused) return { ...v, protocol };
    lastRefusal = v.refused;
    // Still starting, or an answer that cannot be read: that is not about the number. Going on through
    // the numbers could miss the engine getting ready on one already tried.
    if (!v.mismatch) return undefined;
    if (v.speaks && !referred) {
      referred = true;
      queue.unshift(v.speaks);
    }
  }
  return undefined;
}


// A task manager that works (or waits for the person) holds the update too (engine 0.26.0). A bot or
// a task manager that only waits for the person on a card holds it only when the running engine is
// older than 0.29.0: such an engine withdraws every open card when it stops, so updating under one
// would lose the question. From 0.29.0 the open cards are kept and come back after the restart
// (engine/core/restored-cards.ts), and the update says which. When the update gives up, the summary
// names the bots that were only waiting on a card (fix 0.26.3).
// These stay in this file: the job runs a copy of this one file (runner.mjs), nothing beside it.
const QUIET = ["idle", "done", "blocked"];
const KEEPS_CARDS = [0, 29, 0];
const keepsCards = (version) => {
  const parts = String(version ?? "").split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const a = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (a !== KEEPS_CARDS[i]) return a > KEEPS_CARDS[i];
  }
  return true;
};
const busy = (v) => v.bots.filter((b) => (!QUIET.includes(b.state) || b.helpers > 0 || b.managers > 0) && !(keepsCards(v.version) && onlyCard(b)));
/** "Kaja: Which customer first?; Developer: Run npm test?", the open cards that come back after the restart. */
const cardsBack = (v) => (v.cards ?? []).map((c) => `${v.bots.find((b) => b.id === c.botId)?.name ?? "a bot"}: ${c.title.length > 80 ? `${c.title.slice(0, 79)}…` : c.title}`).join("; ");
const onlyCard = (b) => {
  const waiting = b.managersWaiting ?? 0;
  const selfWaits = b.state === "waiting";
  if (!selfWaits && !QUIET.includes(b.state)) return false;
  if (b.helpers > 0 || b.managers > waiting) return false;
  return selfWaits || waiting > 0;
};
function gaveUp(working, minutes) {
  const names = (bots) => bots.map((b) => b.name).join(", ");
  const was = (bots) => (bots.length === 1 ? "was" : "were");
  const cards = working.filter(onlyCard);
  const work = working.filter((b) => !onlyCard(b));
  // A card of a bot's task manager is named as that: "Kaja's task manager".
  const asked = cards.map((b) => ({ name: b.state === "waiting" ? b.name : `${b.name}'s task manager` }));
  const parts = [];
  if (work.length) parts.push(`${names(work)} ${was(work)} still working`);
  if (cards.length) parts.push(`${names(asked)} ${was(asked)} waiting on a card`);
  const next = cards.length ? "Answer the card, then ask again." : "Ask again when it is quiet.";
  return `Not installed: after ${minutes} ${minutes === 1 ? "minute" : "minutes"} ${parts.join(" and ")}. Nothing was changed. ${next}`;
}

async function waitUp(ms, differentFrom) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await lookAny();
    if (v && v.pid !== differentFrom) return v;
    await sleep(1000);
  }
  return undefined;
}

async function stopEngine() {
  if (!loaded(s.label)) return;
  launchctl("bootout", target);
  for (let i = 0; i < 100 && loaded(s.label); i++) await sleep(100);
}

/**
 * A service installed before 12 Nov 2026 lacks ProcessType Interactive, and macOS then slows down
 * everything the engine starts (see scripts/service.mjs). An update adds it to the installed file.
 */
function ensureInteractive() {
  try {
    const text = readFileSync(s.plistPath, "utf8");
    if (text.includes("<key>ProcessType</key>")) return;
    const fixed = text.replace(/<\/dict>\s*<\/plist>\s*$/, "  <key>ProcessType</key>\n  <string>Interactive</string>\n</dict>\n</plist>\n");
    if (fixed !== text) {
      writeFileSync(s.plistPath, fixed);
      log("Added ProcessType Interactive to the service, so what the bots run is no longer slowed down.");
    }
  } catch (err) {
    log(`The service's file could not be read for ProcessType: ${err.message}`);
  }
}

async function startEngine() {
  ensureInteractive();
  launchctl("enable", target);
  for (let i = 0; i < 10; i++) {
    if (launchctl("bootstrap", domain, s.plistPath).status === 0) return true;
    await sleep(300);
  }
  return false;
}

function finish(result) {
  mkdirSync(updatesDir, { recursive: true });
  const record = { at: now(), requestedAt: s.requestedAt, commit: s.commit, note: s.note, ...result };
  writeFileSync(join(updatesDir, "last.json"), JSON.stringify(record, null, 2) + "\n");
  appendFileSync(join(updatesDir, "history.jsonl"), JSON.stringify(record) + "\n");
  log(result.summary);
  // The job is done: take it out of launchd (this ends the process).
  launchctl("bootout", `${domain}/${s.jobLabel}`);
  process.exit(0);
}

/** How far the swap of the build has come: "", "begun", "package saved" or "done". */
let swap = "";

try {
  // 1. Wait until every bot is idle, twice in a row.
  log(`Update to ${s.version} (${s.commit}) asked for. Waiting until every bot is idle.`);
  const started = Date.now();
  let before;
  let calm = 0;
  let lostSince = 0;
  while (true) {
    const v = await lookAny();
    if (!v) {
      // A look that failed breaks the row of calm looks, and gives up only after a full minute without contact.
      calm = 0;
      lostSince ||= Date.now();
      if (Date.now() - lostSince > 60_000) {
        const summary = lastRefusal
          ? `Not installed: the running Pobots answered but would not talk to the update (${lastRefusal.slice(0, 200)}), so its bots could not be checked. Nothing was changed.`
          : "Not installed: the running Pobots could not be reached, so its bots could not be checked. Nothing was changed.";
        finish({ ok: false, installed: false, summary });
      }
    } else {
      lostSince = 0;
      const working = busy(v);
      calm = working.length ? 0 : calm + 1;
      before = v;
      if (calm >= 2) break;
      if (Date.now() - started > s.waitMinutes * 60_000) {
        finish({ ok: false, installed: false, summary: gaveUp(working, s.waitMinutes) });
      }
    }
    await sleep(5000);
  }
  const waited = Math.round((Date.now() - started) / 1000);
  log(`Every bot is idle after ${waited} s. Stopping the engine (${before.version}).`);
  const comeBack = keepsCards(before.version) ? cardsBack(before) : "";
  if (comeBack) {
    const one = before.cards.length === 1;
    log(`${one ? "This open card comes back after the restart, where it was" : `These ${before.cards.length} open cards come back after the restart, where they were`}: ${comeBack}${/[.?!…]$/.test(comeBack) ? "" : "."}`);
  }

  // 2. Stop, back up, swap.
  await stopEngine();
  mkdirSync(updatesDir, { recursive: true });
  const stamp = now().replace(/[-:]/g, "").slice(0, 15);
  const backup = join(updatesDir, `pobots.before-${stamp}.db`);
  const copied = spawnSync("/usr/bin/sqlite3", [db, `.backup '${backup.replaceAll("'", "''")}'`], { encoding: "utf8" });
  if (copied.status !== 0 || !existsSync(backup)) {
    await startEngine();
    finish({ ok: false, installed: false, summary: `Not installed: the database could not be backed up (${(copied.stderr || "").trim().slice(0, 200)}). The old build was started again.` });
  }
  // Keep the five newest backups of this kind.
  const old = readdirSync(updatesDir).filter((n) => /^pobots\.before-.*\.db$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 5))) rmSync(join(updatesDir, n), { force: true });

  rmSync(previous, { recursive: true, force: true });
  swap = "begun"; // from here until "done", a failure must put the old build back (see the catch below)
  renameSync(dist, previous);
  copyFileSync(join(s.installDir, "package.json"), join(s.installDir, "package.previous.json"));
  swap = "package saved";
  cpSync(join(here, "dist"), dist, { recursive: true });
  copyFileSync(join(here, "package.json"), join(s.installDir, "package.json"));
  swap = "done";

  // 3. Start the new build and check it.
  await startEngine();
  const after = await waitUp(90_000, before.pid);
  const sameBots = after && before.bots.every((b) => after.bots.some((a) => a.id === b.id)) && after.bots.length >= before.bots.length;
  if (after && sameBots && after.version === s.version) {
    finish({
      ok: true,
      installed: true,
      from: before.version,
      to: after.version,
      waitedSeconds: waited,
      backup,
      summary: `Installed ${after.version} (${s.commit}); it was ${before.version}. All ${after.bots.length} bots are there. The database from before is at ${backup}.`,
    });
  }

  // 4. It did not come back right: put the old build and the database back.
  const why = !after ? "the new build did not start" : !sameBots ? "bots were missing after the start" : `the engine says version ${after.version}, not ${s.version}`;
  log(`The new build is not right (${why}). Putting the old one back.`);
  await stopEngine();
  rmSync(dist, { recursive: true, force: true });
  renameSync(previous, dist);
  copyFileSync(join(s.installDir, "package.previous.json"), join(s.installDir, "package.json"));
  for (const tail of ["-wal", "-shm"]) rmSync(db + tail, { force: true });
  copyFileSync(backup, db);
  await startEngine();
  const back = await waitUp(90_000, after?.pid);
  const backOk = back && back.version === before.version && before.bots.every((b) => back.bots.some((a) => a.id === b.id));
  finish({
    ok: false,
    installed: false,
    rolledBack: !!backOk,
    from: before.version,
    summary: backOk
      ? `Not installed: ${why}. The old build (${before.version}) and the database from before are back and running. See the engine's log for why the new one failed.`
      : `Not installed, and the old build did not come back either: ${why}. Pobots is down. The old build is in ${dist}, the database from before at ${backup}. Start it with: launchctl bootstrap ${domain} "${s.plistPath}"`,
  });
} catch (err) {
  // The swap broke off halfway (a full disk, a file that could not be copied): the old build is in
  // dist.previous and what is in dist is missing or half there. Put the old one back first.
  let restored = false;
  let halfBuild = false; // dist may hold half a build, which must never be started
  if ((swap === "begun" || swap === "package saved") && existsSync(join(previous, "engine", "main.mjs"))) {
    halfBuild = true;
    try {
      await stopEngine();
      rmSync(dist, { recursive: true, force: true });
      renameSync(previous, dist);
      halfBuild = false;
      // A rename, not a copy: it also works on a full disk.
      if (swap === "package saved") renameSync(join(s.installDir, "package.previous.json"), join(s.installDir, "package.json"));
      restored = true;
    } catch (again) {
      log(`The old build could not be put back: ${again instanceof Error ? again.message : String(again)}`);
    }
  }
  // Never leave the engine stopped: start whatever build is in place.
  let up = loaded(s.label);
  if (!up && !halfBuild && existsSync(join(dist, "engine", "main.mjs"))) up = await startEngine();
  const state = halfBuild
    ? `Pobots is down: the old build could not be put back. It is in ${previous}; move it to ${dist}, then start it with: launchctl bootstrap ${domain} "${s.plistPath}"`
    : up
      ? restored
        ? "Nothing was installed: the old build was put back and started again."
        : "The engine was started again; check which version runs."
      : "Pobots is down.";
  finish({ ok: false, installed: false, summary: `The update stopped on an error: ${err instanceof Error ? err.message : String(err)}. ${state}` });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
