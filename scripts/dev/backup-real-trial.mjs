#!/usr/bin/env node
// One whole nightly backup for real, on harmless ground (docs/build/step-backup.md, "Try for real"):
// the engine's own backup code (engine/backup.ts, engine/store.ts) on a COPY of the test copy's
// database and bot folders, locked to a stand-in key made here with ssh-keygen, written into
// OneDrive's Pobot/test-copy folder (made if missing; nothing else in OneDrive is touched), with the
// Mac's real upload state read by engine/upload-state.js. Then the file is opened with
// scripts/restore.mjs --check and restored with --folders into temporary folders. At the end it
// removes the one backup file it made and its temporary folder, keys included.
//
//   node scripts/dev/backup-real-trial.mjs                  (Node 22.18 or newer)
//   ELECTRON_RUN_AS_NODE=1 <Electron> scripts/dev/backup-real-trial.mjs   (the engine's own Node)
//
// Reads from the test copy only (its database files and bots folder, copied); never its config.json,
// never the real Pobots. Prints no key and no settings value.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine's sources import each other as "./x.js"; find "./x.ts" (as engine/tests/all.test.ts does).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if ((specifier.startsWith(".") || specifier.startsWith("/")) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);
      throw err;
    }
  },
});
process.env.POBOTS_LOG = "info";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const home = homedir();
const testData = join(home, "Library", "Application Support", "Pobots-test");
const testBots = join(home, "Pobots-test", "bots");
const pobotFolder = join(home, "Library", "CloudStorage", "OneDrive-Personal", "Pobot");
const folder = join(pobotFolder, "test-copy");

const { Store } = await import(join(repo, "engine", "store.ts"));
const { Backup, osascriptReader } = await import(join(repo, "engine", "backup.ts"));

if (!existsSync(pobotFolder)) {
  console.error(`No OneDrive Pobot folder at ${pobotFolder}. Nothing done.`);
  process.exit(2);
}
if (!existsSync(folder)) {
  mkdirSync(folder);
  console.log(`made ${folder}`);
}
const before = new Set(readdirSync(folder));
const tmp = mkdtempSync(join(tmpdir(), "pobots-backup-real-trial-"));
let made;
const t0 = Date.now();
const since = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
try {
  // 1. A copy of the test copy's database and bots (read only from the test copy).
  const data = join(tmp, "data");
  const bots = join(tmp, "bots");
  mkdirSync(data);
  for (const f of ["pobots.db", "pobots.db-wal", "pobots.db-shm"]) if (existsSync(join(testData, f))) copyFileSync(join(testData, f), join(data, f));
  cpSync(testBots, bots, { recursive: true, verbatimSymlinks: true });
  // A stand-in settings file: the test copy's own is not copied.
  writeFileSync(join(data, "config.json"), JSON.stringify({ claude: {}, backup: { folder } }, null, 2) + "\n", { mode: 0o600 });

  // 2. A stand-in key pair, as the person would make in 1Password.
  const keys = join(tmp, "keys");
  mkdirSync(keys, { mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "rsa", "-b", "4096", "-N", "", "-C", "trial@example.com", "-f", join(keys, "rsa")]);
  const publicKey = readFileSync(join(keys, "rsa.pub"), "utf8");

  // 3. One run, with the real upload state reader and the real timings (a minute of "uploaded").
  const store = new Store(join(data, "pobots.db"));
  const read = osascriptReader(join(repo, "engine", "upload-state.js"));
  const seen = [];
  const reader = async (path) => {
    const s = await read(path);
    const line = JSON.stringify(s);
    if (seen.at(-1)?.line !== line) {
      seen.push({ at: since(), line });
      console.log(`${since()} upload state: ${line}`);
    }
    return s;
  };
  const botIds = readdirSync(bots).filter((n) => !n.startsWith(".") && statSync(join(bots, n)).isDirectory());
  const backup = new Backup({
    dataDir: data,
    botsDir: bots,
    config: { folder, time: "03:00", publicKey, publicKeySavedAt: new Date(Date.now() - 86_400_000).toISOString() },
    engineVersion: /ENGINE_VERSION = "([^"]+)"/.exec(readFileSync(join(repo, "engine", "engine.ts"), "utf8"))[1],
    clock: Date.now,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    readUploadState: reader,
    host: {
      snapshotDb: (p) => store.snapshotTo(p),
      bots: () => botIds.map((id) => ({ id, name: id })),
      changed: (s) => console.log(`${since()} state: running ${s.running}${s.history[0] ? `, last ${s.history[0].status}` : ""}`),
      showCard: (title, text) => console.log(`${since()} card: ${title}: ${text}`),
      clearCard: () => console.log(`${since()} card cleared`),
    },
  });
  backup.init();
  backup.runNow();
  await backup.idle();
  store.close();
  const run = backup.state().history[0];
  made = run?.file;
  console.log(`${since()} run: ${JSON.stringify(run)}`);
  if (!made) throw new Error("no file was made");
  console.log(`folder now holds (names only): ${readdirSync(folder).join(", ")}`);

  // 4. The file opens with the private key on standard input, and restores into temporary folders.
  const key = readFileSync(join(keys, "rsa"));
  const check = spawnSync(process.execPath, [join(repo, "scripts", "restore.mjs"), "--check", join(folder, made)], { input: key, encoding: "utf8" });
  console.log(`restore --check: exit ${check.status}\n${check.stdout}${check.stderr}`);
  const into = { data: join(tmp, "restored-data"), bots: join(tmp, "restored-home", "bots") };
  const restore = spawnSync(process.execPath, [join(repo, "scripts", "restore.mjs"), "--folders", `--data-dir=${into.data}`, `--bots-dir=${into.bots}`, join(folder, made)], { input: key, encoding: "utf8" });
  console.log(`restore --folders: exit ${restore.status}\n${restore.stdout}${restore.stderr}`);
  const diff = spawnSync("diff", ["-rq", "-x", "node_modules", "-x", ".DS_Store", bots, into.bots], { encoding: "utf8" });
  console.log(`bots restored vs copied: ${diff.status === 0 ? "identical" : diff.stdout.split("\n").slice(0, 10).join(" | ")}`);
} finally {
  // 5. Remove the one file this trial made, never anything else in the folder.
  if (made && /^pobots-backup-\d{4}-\d{2}-\d{2}T\d{4}\.pobotsbackup$/.test(made) && !before.has(made) && existsSync(join(folder, made))) {
    unlinkSync(join(folder, made));
    console.log(`removed ${made} from the test copy's folder: ${existsSync(join(folder, made)) ? "STILL THERE" : "gone"}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`removed ${tmp}, keys included: ${existsSync(tmp) ? "STILL THERE" : "gone"}`);
  console.log(`folder now holds: ${readdirSync(folder).length ? readdirSync(folder).join(", ") : "nothing"}`);
}
