// The test copy of Pobots on this Mac: a second background service with its own folders, port and
// address, where a new build is tried before it reaches the real one. See docs/testing.md.
//
//   node scripts/testbed.mjs install     build first; copies the build, makes the settings, starts it
//   node scripts/testbed.mjs status
//   node scripts/testbed.mjs reset       stop it, remove its bots and history, start it fresh (first run)
//   node scripts/testbed.mjs uninstall   stop it and remove its installed copy (folders are kept)
//
// It never touches the real service (app.pobots.engine), its data or its bots.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();

export const TESTBED = {
  label: "app.pobots.engine-test",
  port: 47700,
  dataDir: join(home, "Library", "Application Support", "Pobots-test"),
  botsDir: join(home, "Pobots-test", "bots"),
  installDir: join(home, ".local", "share", "pobots-test"),
  // The test copy's nightly backups go to a folder of its own, never the real Pobots' "Pobot" folder,
  // so it can never remove or replace the real one's files (docs/build/step-backup.md).
  backupFolder: join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Pobots Backup Test"),
};
const realConfig = join(home, "Library", "Application Support", "Pobots", "config.json");

const flags = [
  `--label=${TESTBED.label}`,
  `--port=${TESTBED.port}`,
  `--data-dir=${TESTBED.dataDir}`,
  `--bots-dir=${TESTBED.botsDir}`,
  `--install-dir=${TESTBED.installDir}`,
];
const connectionTestPeer = process.argv.find(a => a.startsWith("--connections-test-peer="));
if (connectionTestPeer) flags.push(connectionTestPeer);
const service = (command) => spawnSync(process.execPath, [join(repo, "scripts", "service.mjs"), command, ...flags], { stdio: "inherit" }).status ?? 1;

/** The test copy uses the same Claude setup and the same allowed Tailscale logins as the real one. Values are never printed. */
function writeConfig() {
  mkdirSync(TESTBED.dataDir, { recursive: true });
  let real = {};
  try {
    real = JSON.parse(readFileSync(realConfig, "utf8"));
  } catch {
    // No real install on this machine: the test copy runs with defaults and without remote access.
  }
  // Timings set on the test copy for a tester (config.json, "context") are kept across installs.
  let own = {};
  try {
    own = JSON.parse(readFileSync(join(TESTBED.dataDir, "config.json"), "utf8"));
  } catch {
    // First install, or after a reset.
  }
  // The backup: always the test copy's own folder. Do not take a reference from the real config.
  const ownKey = own.backup && typeof own.backup === "object" ? own.backup : {};
  const backup = {
    folder: TESTBED.backupFolder,
    ...(typeof ownKey.passwordRef === "string" ? { passwordRef: ownKey.passwordRef } : {}),
    ...(typeof ownKey.passwordRefSavedAt === "string" ? { passwordRefSavedAt: ownKey.passwordRefSavedAt } : {}),
  };
  // Notifications: every title says "Test copy: ", so a card a test bot raises here is never taken
  // for one of the real Pobots. The test copy's own switches and subject are kept; the real one's never taken.
  const ownNotify = own.notify && typeof own.notify === "object" && !Array.isArray(own.notify) ? own.notify : {};
  const notify = {
    ...Object.fromEntries(["needs", "note", "finished"].filter((k) => typeof ownNotify[k] === "boolean").map((k) => [k, ownNotify[k]])),
    ...(typeof ownNotify.subject === "string" ? { subject: ownNotify.subject } : {}),
    titlePrefix: "Test copy: ",
  };
  const config = { claude: real.claude ?? {}, ...(real.codex ? { codex: real.codex } : {}), remote: real.remote ?? { allowedLogins: [] }, ...(own.context ? { context: own.context } : {}), backup, notify };
  writeFileSync(join(TESTBED.dataDir, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function wipe() {
  for (const name of ["pobots.db", "pobots.db-wal", "pobots.db-shm", "engine.json"]) rmSync(join(TESTBED.dataDir, name), { force: true });
  rmSync(TESTBED.botsDir, { recursive: true, force: true });
}

const command = process.argv[2];
if (command === "install") {
  writeConfig();
  process.exit(service("install"));
} else if (command === "status") {
  process.exit(service("status"));
} else if (command === "reset") {
  if (!existsSync(join(TESTBED.installDir, "dist"))) {
    console.error("The test copy is not installed. Run: npm run testbed:install");
    process.exit(1);
  }
  service("uninstall");
  wipe();
  writeConfig();
  console.log("Removed the test copy's bots and history.");
  process.exit(service("install"));
} else if (command === "uninstall") {
  process.exit(service("uninstall"));
} else {
  console.error("Use: node scripts/testbed.mjs install | status | reset | uninstall");
  process.exit(1);
}
