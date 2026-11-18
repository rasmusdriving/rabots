// The engine as a background service on macOS (a launchd agent for the logged-in user).
//
//   node scripts/service.mjs install     copy the built app to the internal drive, write the agent, start it
//   node scripts/service.mjs status      say whether it runs, on which port, and since when
//   node scripts/service.mjs restart     stop and start it again (for example after an install by hand)
//   node scripts/service.mjs uninstall   stop it and remove the agent and the installed copy
//
// The agent runs the engine in serve mode (the app window as a web page next to its socket, on
// 127.0.0.1 only) with Electron's own binary as Node, from the copy on the internal drive, never
// from the external drive. launchd starts it at login, and again after a crash.
//
// Options, for checks (the defaults are the real ones):
//   --label=NAME         the agent's name (default app.pobots.engine)
//   --data-dir=PATH      the engine's data folder (default ~/Library/Application Support/Pobots)
//   --bots-dir=PATH      the bots' folders (default ~/Pobots/bots, or `botsDir` in config.json)
//   --port=N             the engine's port (default: the engine's own, 47600 or `port` in config.json)
//   --install-dir=PATH   where the built app is copied (default: next to the dependencies)
//   --plist-dir=PATH     where the agent file is written (default ~/Library/LaunchAgents)
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("The background service is for macOS. On other systems start the engine with: node dist/engine/main.mjs --serve");
  process.exit(1);
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const expand = (p) => resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const label = arg("label") ?? "app.pobots.engine";
if (!/^[A-Za-z0-9.-]+$/.test(label)) {
  console.error(`"${label}" is not a usable agent name.`);
  process.exit(1);
}
const customDataDir = arg("data-dir") ? expand(arg("data-dir")) : undefined;
const dataDir = customDataDir ?? join(homedir(), "Library", "Application Support", "Pobots");
const customBotsDir = arg("bots-dir") ? expand(arg("bots-dir")) : undefined;
const port = arg("port");
if (port !== undefined && !/^\d{1,5}$/.test(port)) {
  console.error(`"${port}" is not a port number.`);
  process.exit(1);
}
const plistDir = arg("plist-dir") ? expand(arg("plist-dir")) : join(homedir(), "Library", "LaunchAgents");
const plistPath = join(plistDir, `${label}.plist`);
const logPath = join(dataDir, "logs", "engine.log");
const domain = `gui/${userInfo().uid}`;
const target = `${domain}/${label}`;

/** The folder that holds the installed dependencies (see scripts/install.mjs). */
function depsHome() {
  const link = join(repo, "node_modules");
  if (!existsSync(link)) {
    console.error("The dependencies are not installed. Run: node scripts/install.mjs");
    process.exit(1);
  }
  return dirname(realpathSync(link));
}

const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// ProcessType Interactive: without it macOS treats the engine as a background service and slows down
// everything it starts, so also every command, build and check a bot runs. Measured on 12 Nov 2026:
// a hidden browser drew 26 to 72 frames in two seconds under the plain service and 120 with this
// setting, and the app window check failed about six timing checks on every run a bot made.
const plist = (programArguments) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;

/** What launchd knows about the agent: loaded, and the pid when it runs. */
function agentState() {
  const out = launchctl("print", target);
  if (out.status !== 0) return { loaded: false };
  const text = out.stdout;
  const pid = /^\s*pid = (\d+)/m.exec(text)?.[1];
  const state = /^\s*state = (\w+)/m.exec(text)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(text)?.[1];
  return { loaded: true, running: state === "running" && !!pid, pid: pid ? Number(pid) : undefined, lastExit };
}

/** The engine's own note of its port and start time. The token in the same file is never read out. */
function engineNote() {
  try {
    const { pid, port, startedAt } = JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8"));
    return { pid, port, startedAt };
  } catch {
    return undefined;
  }
}

async function bootout() {
  if (!agentState().loaded) return;
  launchctl("bootout", target);
  for (let i = 0; i < 50 && agentState().loaded; i++) await sleep(100);
}

async function bootstrap() {
  launchctl("enable", target);
  let last;
  for (let i = 0; i < 10; i++) {
    last = launchctl("bootstrap", domain, plistPath);
    if (last.status === 0) return;
    await sleep(300);
  }
  console.error(`launchd would not start the agent: ${(last?.stderr || last?.stdout || "").trim()}`);
  process.exit(1);
}

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an unknown time" : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

async function status({ waitForPort = false } = {}) {
  let agent = agentState();
  if (!agent.loaded) {
    console.log(existsSync(plistPath) ? `The background service is installed but not loaded. Start it with: npm run service:restart` : "Pobots is not installed as a background service. Install it with: npm run service:install");
    return false;
  }
  let note = engineNote();
  // Right after a start the engine needs a moment before it listens.
  for (let i = 0; waitForPort && i < 60 && !(agent.running && note?.pid === agent.pid); i++) {
    await sleep(250);
    agent = agentState();
    note = engineNote();
  }
  if (!agent.running) {
    console.log(`The background service is installed but not running${agent.lastExit ? ` (it last stopped with code ${agent.lastExit})` : ""}. See the log: ${logPath}`);
    return false;
  }
  if (note && note.pid === agent.pid) {
    console.log(`Pobots runs in the background on port ${note.port}, since ${when(note.startedAt)} (process ${agent.pid}).`);
    console.log(`On this Mac: http://127.0.0.1:${note.port}/`);
  } else {
    console.log(`Pobots is starting in the background (process ${agent.pid}). Its port is not known yet; see the log: ${logPath}`);
  }
  console.log(`Log: ${logPath}`);
  return true;
}

async function install() {
  if (!existsSync(join(repo, "dist", "engine", "main.mjs")) || !existsSync(join(repo, "dist", "ui", "index.html"))) {
    console.error("Nothing is built yet. Run: npm run build");
    process.exit(1);
  }
  const deps = depsHome();
  const electron = join(deps, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (!existsSync(electron)) {
    console.error("Electron is not installed. Run: node scripts/install.mjs");
    process.exit(1);
  }

  // Copy the built app next to the dependencies on the internal drive. The repo is on an external
  // drive that a background program may not be allowed to read.
  const installDir = arg("install-dir") ? expand(arg("install-dir")) : deps;
  mkdirSync(installDir, { recursive: true });
  rmSync(join(installDir, "dist"), { recursive: true, force: true });
  cpSync(join(repo, "dist"), join(installDir, "dist"), { recursive: true });
  copyFileSync(join(repo, "package.json"), join(installDir, "package.json"));
  if (installDir !== deps) {
    const link = join(installDir, "node_modules");
    if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(join(deps, "node_modules"), link);
  }

  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(plistDir, { recursive: true });
  const programArguments = [electron, join(installDir, "dist", "engine", "main.mjs"), "--serve"];
  if (customDataDir) programArguments.push(`--data-dir=${customDataDir}`);
  if (customBotsDir) programArguments.push(`--bots-dir=${customBotsDir}`);
  if (port) programArguments.push(`--port=${port}`);

  await bootout();
  writeFileSync(plistPath, plist(programArguments));
  await bootstrap();
  console.log(`Installed the engine in ${installDir} and the agent ${label}.`);
  const ok = await status({ waitForPort: true });
  if (!ok) process.exit(1);
}

async function restart() {
  if (!agentState().loaded) {
    if (!existsSync(plistPath)) return void (await status());
    await bootstrap();
  } else {
    launchctl("kickstart", "-k", target);
  }
  await sleep(500);
  await status({ waitForPort: true });
}

async function uninstall() {
  await bootout();
  rmSync(plistPath, { force: true });
  const installDir = arg("install-dir") ? expand(arg("install-dir")) : depsHome();
  rmSync(join(installDir, "dist"), { recursive: true, force: true });
  console.log(`Stopped and removed the background service ${label}. The data in ${dataDir} is kept.`);
}

const command = process.argv[2];
const commands = { install, status, restart, uninstall };
if (!commands[command]) {
  console.error("Use: node scripts/service.mjs install | status | restart | uninstall");
  process.exit(1);
}
await commands[command]();
