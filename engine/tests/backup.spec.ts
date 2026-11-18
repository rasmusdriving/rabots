// The nightly backup against temporary folders: a plain local folder stands in for the OneDrive
// folder and a stand-in replaces the Mac's upload state reader. No model, no OneDrive.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { link as fsLink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Card, Events, SystemCard } from "../../shared/protocol.js";
import { fingerprintOfKey, parsePublicKeyLine, readHeader, readPrivateKey, unlockStream } from "../backup-format.js";
import { Backup, backupFileName, BACKUP_NAME, KEEP, MOMENT_AGO, namesToPrune, OTHER_OWNER, OWNER_FILE, pruneFolder, slotAtOrBefore, UNCONFIRMED, type UploadState } from "../backup.js";
import { BAD_FOLDER_SETTING, backupConfig, loadConfigFile, writeBackupSettings } from "../config.js";
import { ENGINE_VERSION } from "../engine.js";
import { EngineError } from "../errors.js";
import { parseParams } from "../schemas.js";
import { Store } from "../store.js";
import { wallOf } from "../schedule.js";
import { keyBodyPieces, standInKeys } from "./backup-keys.js";
import { settle, setup, type Ev } from "./fake.js";
import { tempDir } from "./helpers.js";

const TZ = "Europe/Stockholm";
const restoreScript = fileURLToPath(new URL("../../scripts/restore.mjs", import.meta.url));
const keys = standInKeys();

/** An engine with a bot or two, a "cloud" folder and a stand-in for the upload state. */
function world(
  o: {
    at?: string;
    dirs?: { dataDir: string; botsDir: string };
    cloud?: string;
    maxFileBytes?: number;
    link?: (a: string, b: string) => Promise<void>;
    copy?: (a: string, b: string, signal: AbortSignal) => Promise<void>;
    limitMs?: number;
    holdMs?: number;
    stopMs?: number;
    /** Replaces the stand-in reader (the reads are still counted). */
    reader?: (path: string) => Promise<UploadState | undefined>;
  } = {},
) {
  const clock = { now: Date.parse(o.at ?? "2026-11-14T09:00:00Z") };
  const cloud = o.cloud ?? tempDir("pobots-cloud-");
  /** By file name: what the Mac says. Uploaded unless told otherwise. */
  const uploads = new Map<string, UploadState>();
  const reads: string[] = [];
  const w = setup(o.dirs, undefined, undefined, {
    clock: () => clock.now,
    timeZone: TZ,
    backupConfig: { folder: cloud, time: "03:00" },
    backup: {
      readUploadState: async (path) => {
        reads.push(path);
        if (o.reader) return o.reader(path);
        if (!existsSync(path)) return { exists: false };
        return uploads.get(basename(path)) ?? { exists: true, ubiquitous: true, uploaded: true, uploading: false, uploadError: null };
      },
      timings: { pollMs: 5, holdMs: o.holdMs ?? 20, limitMs: o.limitMs ?? 300, ...(o.stopMs ? { stopMs: o.stopMs } : {}) },
      ...(o.link ? { link: o.link } : {}),
      ...(o.copy ? { copy: o.copy } : {}),
      ...(o.maxFileBytes ? { maxFileBytes: o.maxFileBytes } : {}),
    },
  });
  return { ...w, clock, cloud, uploads, reads };
}

const backupEvents = (events: Ev[]) => events.filter((e) => e.event === "backup.changed").map((e) => (e.data as Events["backup.changed"]).backup);
const systemCards = (cards: Card[]) => cards.filter((c): c is SystemCard => c.kind === "system");
/** What is in the "cloud" folder, without this Pobots' own owner note. */
const cloudFiles = (dir: string) => readdirSync(dir).filter((n) => n !== OWNER_FILE).sort();

async function unlockInto(file: string, privatePem: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const tar = spawn("tar", ["-xzf", "-", "-C", into], { stdio: ["pipe", "ignore", "inherit"] });
  const done = new Promise<number | null>((r) => tar.on("close", r));
  await pipeline(createReadStream(file), unlockStream(readPrivateKey(privatePem)), tar.stdin);
  assert.equal(await done, 0);
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function waitFor(check: () => boolean, ms = 5000, what = "the condition"): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function stopAll(w: { engine: { shutdown(): void; backupStopped(): Promise<unknown> }; store: { close(): void } }) {
  w.engine.shutdown();
  await w.engine.backupStopped();
  w.store.close();
}

describe("nightly backup: settings and the key", () => {
  test("the default folder is only for the real Pobots' own data folder; others must name their own, never the default", () => {
    const defaults = { dataDir: "/Users/x/Library/Application Support/Pobots", folder: "/Users/x/Library/CloudStorage/OneDrive-Personal/Pobot" };
    assert.deepEqual(backupConfig(defaults.dataDir, undefined, defaults), { folder: defaults.folder, time: "03:00" });
    const other = backupConfig("/tmp/some-data", undefined, defaults);
    assert.equal(other.folder, "");
    assert.equal(other.folderProblem, "No backup folder is set for this Pobots.");
    const sneaky = backupConfig("/tmp/some-data", { folder: defaults.folder }, defaults);
    assert.match(sneaky.folderProblem ?? "", /may not use the backup folder of the main Pobots/);
    assert.deepEqual(backupConfig("/tmp/some-data", { folder: "/tmp/own", time: "04:15" }, defaults), { folder: "/tmp/own", time: "04:15" });
  });

  test("no key: no backups, the state says so, and Back up now is refused", async () => {
    const w = world();
    const s = w.engine.snapshot().backup;
    assert.equal(s.key, undefined);
    assert.equal(s.nextAt, undefined);
    assert.equal(s.running, false);
    assert.deepEqual(s.history, []);
    assert.equal(s.keep, 14);
    assert.equal(s.time, "03:00");
    assert.deepEqual(s.folder, { path: w.cloud, ok: true });
    assert.throws(() => w.engine.runBackup(), (e: unknown) => e instanceof EngineError && e.code === "conflict" && /Add a key first/.test(e.message));
    w.clock.now = Date.parse("2026-11-15T02:30:00Z");
    w.engine.checkSchedules();
    await w.engine.backupIdle();
    assert.deepEqual(cloudFiles(w.cloud), []);
    await stopAll(w);
  });

  test("a pasted private key is refused, and appears in no log line, no file and no error text", async () => {
    const w = world();
    writeFileSync(join(w.dirs.dataDir, "config.json"), JSON.stringify({ claude: {} }), { mode: 0o600 });
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.env.POBOTS_LOG = "info";
    process.stderr.write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const messages: string[] = [];
    try {
      for (const priv of [keys.openssh, keys.pkcs8, keys.pkcs1, `Here it is:\n${keys.pkcs8}`]) {
        try {
          w.engine.setBackupKey(priv);
          assert.fail("accepted a private key");
        } catch (err) {
          assert.ok(err instanceof EngineError);
          assert.equal(err.code, "bad_request");
          messages.push(err.message);
        }
      }
    } finally {
      process.stderr.write = write;
      process.env.POBOTS_LOG = "warn";
    }
    assert.ok(messages.every((m) => m === "That is a private key. Paste the public key instead, and keep the private key in 1Password."));
    const pieces = [...keyBodyPieces(keys.openssh), ...keyBodyPieces(keys.pkcs8), ...keyBodyPieces(keys.pkcs1)];
    for (const piece of pieces) {
      assert.ok(!lines.some((l) => l.includes(piece)), "a log line holds part of the private key");
      assert.ok(!messages.some((m) => m.includes(piece)));
    }
    assert.equal(w.engine.snapshot().backup.key, undefined);
    w.engine.shutdown();
    await w.engine.backupStopped();
    w.store.close();
    for (const file of [...allFiles(w.dirs.dataDir), ...allFiles(w.dirs.botsDir), ...allFiles(w.cloud)]) {
      const text = readFileSync(file).toString("latin1");
      for (const piece of pieces) assert.ok(!text.includes(piece), `${file} holds part of the private key`);
    }
    assert.equal(JSON.parse(readFileSync(join(w.dirs.dataDir, "config.json"), "utf8")).backup, undefined);
  });

  test("saving a key: config.json keeps its other keys and its mode; the key comes back after a restart", async () => {
    const w = world();
    const config = join(w.dirs.dataDir, "config.json");
    const before = { claude: { envFile: "/x/y.env" }, remote: { allowedLogins: ["someone@example.com"] }, context: { minTokens: 5 }, future: { a: [1, 2, { b: true }] }, backup: { folder: w.cloud } };
    writeFileSync(config, JSON.stringify(before, null, 2), { mode: 0o600 });
    chmodSync(config, 0o600);
    const res = w.engine.setBackupKey(keys.publicLine);
    const fromKeygen = spawnSync("ssh-keygen", ["-l", "-E", "sha256", "-f", keys.publicFile], { encoding: "utf8" }).stdout.split(" ")[1];
    assert.equal(res.backup.key?.fingerprint, fromKeygen);
    assert.equal(res.backup.key?.bits, 4096);
    assert.equal(res.backup.key?.savedAt, new Date(w.clock.now).toISOString());
    assert.ok(res.backup.nextAt);
    assert.equal(wallOf(Date.parse(res.backup.nextAt!), TZ).h, 3);
    const after = JSON.parse(readFileSync(config, "utf8"));
    for (const k of ["claude", "remote", "context", "future"] as const) assert.deepEqual(after[k], before[k]);
    assert.equal(after.backup.folder, w.cloud);
    assert.match(after.backup.publicKey, /^ssh-rsa [A-Za-z0-9+/]+=*$/);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(w.dirs.dataDir).filter((n) => n.includes("pobots-tmp")), []);
    // Saving a key starts no backup by itself.
    await settle();
    assert.equal(w.engine.snapshot().backup.running, false);
    assert.ok(backupEvents(w.events).at(-1)?.key);
    // A config.json that cannot be read is left alone.
    writeFileSync(config, "{ not json");
    assert.throws(() => writeBackupSettings(w.dirs.dataDir, { publicKey: "x" }), /could not be read/);
    assert.equal(readFileSync(config, "utf8"), "{ not json");
    writeFileSync(config, JSON.stringify(after, null, 2));
    await stopAll(w);
    const again = setup(w.dirs, undefined, undefined, { clock: () => w.clock.now, timeZone: TZ, backupConfig: { folder: w.cloud, time: "03:00", publicKey: after.backup.publicKey, publicKeySavedAt: after.backup.publicKeySavedAt } });
    assert.equal(again.engine.snapshot().backup.key?.fingerprint, fromKeygen);
    await stopAll(again);
  });

  test("the methods' shapes", () => {
    assert.deepEqual(parseParams("backup.setKey", { publicKey: "ssh-rsa AAAA" }), { publicKey: "ssh-rsa AAAA" });
    assert.equal(parseParams("backup.setKey", {}), undefined);
    assert.deepEqual(parseParams("backup.run", undefined), {});
    assert.deepEqual(parseParams("backup.run", {}), {});
  });
});

describe("nightly backup: a run", () => {
  test("one whole run: one file with the right name, saved, everything in it, the leave-outs left out", async () => {
    // Small, so a file of the test is "too big"; bigger than the sample files git puts in .git/hooks.
    const w = world({ maxFileBytes: 8000 });
    writeFileSync(join(w.dirs.dataDir, "config.json"), JSON.stringify({ claude: {} }, null, 2), { mode: 0o600 });
    const bot = w.engine.createBot("Kaja");
    w.engine.createBot("Otto");
    w.engine.sendMessage({ botId: bot.id, text: "Hi" });
    await settle();
    w.sessions[0]!.reply("Hello there");
    await settle();
    const dir = join(w.dirs.botsDir, bot.id);
    writeFileSync(join(dir, "notes.md"), "my notes\n");
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    writeFileSync(join(dir, "sub", "deep", "a.txt"), "deep");
    writeFileSync(join(dir, "naïve file — 1.txt"), "odd name");
    writeFileSync(join(dir, "big.bin"), randomBytes(20_000));
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "draft.pobots-tmp"), "x");
    writeFileSync(join(dir, "bot.json.tmp"), "x");
    symlinkSync("notes.md", join(dir, "link-to-notes"));
    mkdirSync(join(w.dirs.botsDir, ".archive", "old-bot"), { recursive: true });
    writeFileSync(join(w.dirs.botsDir, ".archive", "old-bot", "AGENTS.md"), "retired");

    w.engine.setBackupKey(keys.publicLine);
    const started = w.engine.runBackup();
    assert.equal(started.backup.running, true);
    assert.throws(() => w.engine.runBackup(), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    await w.engine.backupIdle();

    const name = "pobots-backup-2026-11-14T1000.pobotsbackup";
    assert.equal(backupFileName(w.clock.now, TZ), name);
    assert.deepEqual(cloudFiles(w.cloud), [name]);
    const state = w.engine.snapshot().backup;
    assert.equal(state.running, false);
    assert.equal(state.history.length, 1);
    const run = state.history[0]!;
    assert.equal(run.status, "saved");
    assert.equal(run.by, "you");
    assert.equal(run.file, name);
    assert.equal(run.bytes, statSync(join(w.cloud, name)).size);
    assert.deepEqual(run.leftOut, [`${bot.id}/big.bin`]);
    assert.deepEqual(state.lastGood, run);
    const evs = backupEvents(w.events);
    assert.ok(evs.some((s) => s.running));
    assert.equal(evs.at(-1)?.running, false);
    assert.ok(!existsSync(join(w.dirs.dataDir, "backups", ".work")), "the work folder is gone");
    assert.ok(existsSync(join(dir, "notes.md")), "the bots' folder is untouched");
    assert.ok(w.reads.some((p) => p.endsWith(name)), "the upload state was read");

    // What is in it.
    const header = readHeader(readFileSync(join(w.cloud, name)));
    assert.equal(header.engineVersion, ENGINE_VERSION);
    assert.equal(header.keyFingerprint, state.key?.fingerprint);
    const out = tempDir("pobots-unlocked-");
    await unlockInto(join(w.cloud, name), keys.pkcs8, out);
    const top = readdirSync(out).sort();
    assert.deepEqual(top, ["bots", "config.json", "manifest.json", "pobots.db"]);
    assert.equal(readFileSync(join(out, "config.json"), "utf8"), readFileSync(join(w.dirs.dataDir, "config.json"), "utf8"));
    const b = join(out, "bots", bot.id);
    assert.equal(readFileSync(join(b, "notes.md"), "utf8"), "my notes\n");
    assert.equal(readFileSync(join(b, "sub", "deep", "a.txt"), "utf8"), "deep");
    assert.equal(readFileSync(join(b, "naïve file — 1.txt"), "utf8"), "odd name");
    assert.ok(existsSync(join(b, "AGENTS.md")));
    assert.ok(existsSync(join(b, ".git", "HEAD")), "the bot's history is in it");
    assert.ok(lstatSync(join(b, "link-to-notes")).isSymbolicLink());
    assert.equal(readlinkSync(join(b, "link-to-notes")), "notes.md");
    for (const gone of ["big.bin", "node_modules", ".DS_Store", "draft.pobots-tmp", "bot.json.tmp"]) assert.ok(!existsSync(join(b, gone)), `${gone} is left out`);
    assert.equal(readFileSync(join(out, "bots", ".archive", "old-bot", "AGENTS.md"), "utf8"), "retired");
    assert.ok(existsSync(join(out, "bots", "otto", "AGENTS.md")));
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "pobots-backup-manifest");
    assert.equal(manifest.engineVersion, ENGINE_VERSION);
    assert.deepEqual(manifest.leftOut, [`${bot.id}/big.bin`]);
    assert.deepEqual(manifest.bots.map((x: { id: string }) => x.id), [bot.id, "otto"]);
    const kaja = manifest.bots[0];
    assert.equal(kaja.mainThreadId, bot.mainThreadId);
    assert.equal(kaja.mainItems, w.engine.readThread({ threadId: bot.mainThreadId }).items.length);
    assert.ok(kaja.mainItems >= 2);
    assert.ok(!existsSync(join(out, "pobots.db-wal")) && !existsSync(join(out, "pobots.db-shm")), "one whole database file, no write-ahead log");
    const db = new DatabaseSync(join(out, "pobots.db"), { readOnly: true });
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal((db.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n, manifest.counts.items);
    db.close();

    // The same minute again: refused, nothing replaced.
    const size = statSync(join(w.cloud, name)).size;
    w.engine.runBackup();
    await w.engine.backupIdle();
    const second = w.engine.snapshot().backup.history[0]!;
    assert.equal(second.status, "failed");
    assert.equal(second.problem, "A backup was made a moment ago. Try again in a minute.");
    assert.deepEqual(cloudFiles(w.cloud), [name]);
    assert.equal(statSync(join(w.cloud, name)).size, size);
    // A manual failure puts up no card.
    assert.deepEqual(systemCards(w.engine.snapshot().cards), []);
    await stopAll(w);
  });

  test("across volumes the file is copied to a hidden name in the folder and linked there; nothing hidden is left", async () => {
    const calls: string[] = [];
    const w = world({
      link: async (from, to) => {
        calls.push(`${basename(from)} -> ${basename(to)}`);
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      },
    });
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "saved", run.problem);
    assert.equal(calls.length, 2, "the work copy, then the hidden copy in the folder");
    assert.deepEqual(cloudFiles(w.cloud), [run.file]);
    await unlockInto(join(w.cloud, run.file!), keys.openssh, tempDir("pobots-unlocked-"));
    await stopAll(w);
  });

  test("a stop while the file is being made leaves no half-made file anywhere, and no record", async () => {
    const w = world();
    const bot = w.engine.createBot("Kaja");
    // Big enough that packing takes a moment.
    writeFileSync(join(w.dirs.botsDir, bot.id, "large.bin"), randomBytes(40 * 1024 * 1024));
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    const work = join(w.dirs.dataDir, "backups", ".work");
    await waitFor(() => existsSync(work) && readdirSync(work).some((n) => n.endsWith(".partial")), 10_000, "the half-made file");
    w.engine.shutdown();
    await w.engine.backupStopped();
    assert.deepEqual(cloudFiles(w.cloud), [], "nothing in the folder, not even a hidden file");
    assert.ok(!existsSync(work));
    assert.deepEqual(w.engine.snapshot().backup.history, []);
    assert.equal(w.engine.snapshot().backup.running, false);
    assert.ok(existsSync(join(w.dirs.botsDir, bot.id, "large.bin")));
    assert.throws(() => w.engine.runBackup(), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    w.store.close();
  });

  test("a stop while the arrival is checked keeps the whole file and the run as unconfirmed; after the start it is looked at again", async () => {
    const w = world({ limitMs: 60_000 });
    w.engine.setBackupKey(keys.publicLine);
    const name = backupFileName(w.clock.now, TZ);
    w.uploads.set(name, { exists: true, uploaded: false, uploading: true, uploadError: null });
    w.engine.runBackup();
    await waitFor(() => existsSync(join(w.cloud, name)), 10_000, "the file in the folder");
    await waitFor(() => w.reads.length > 2, 5000, "a few looks at the upload state");
    w.engine.shutdown();
    await w.engine.backupStopped();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "unconfirmed");
    assert.equal(run.problem, "Pobots stopped before OneDrive confirmed the file.");
    assert.deepEqual(cloudFiles(w.cloud), [name]);
    assert.deepEqual(systemCards(w.engine.snapshot().cards), []);
    w.store.close();
    // OneDrive has it by the next start.
    const again = world({ dirs: w.dirs, cloud: w.cloud });
    await again.engine.backupIdle();
    await waitFor(() => again.engine.snapshot().backup.history[0]?.status === "saved", 5000, "the earlier run marked saved");
    await stopAll(again);
  });
});

describe("nightly backup: keeping 14", () => {
  const name = (d: number, hm = "0300") => `pobots-backup-2026-11-${String(d).padStart(2, "0")}T${hm}.pobotsbackup`;

  test("which names are pruned: only whole backup names, all but the newest 14, never tonight's", () => {
    const others = [
      "notes.txt",
      "pobots-backup-2026-11-01T0300.pobotsbackup.partial",
      ".pobots-backup-2026-11-01T0300.pobotsbackup.abcd.pobots-partial",
      "Pobots-backup-2026-11-01T0300.pobotsbackup",
      "pobots-backup-2026-11-1T0300.pobotsbackup",
      "xpobots-backup-2026-11-01T0300.pobotsbackup",
      "pobots-backup-2026-11-01T0300.pobotsbackup.txt",
      "pobots-backup-2026-11-01T03:00.pobotsbackup",
      "pobots-backup-2026-11-01 0300.pobotsbackup",
      "pobots-backup-2026-11-01T0300.pobotsbackup ",
      "pobots-backup-2026-11-01T0300.pobotsbackup\n",
      "pobots-backup-２０２６-11-01T0300.pobotsbackup",
      "test-copy",
    ];
    for (const o of others) assert.ok(!BACKUP_NAME.test(o), `"${o}" must not match`);
    const own = (n: number) => Array.from({ length: n }, (_, i) => name(i + 1));
    assert.deepEqual(namesToPrune([...others, ...own(13)], name(13)), []);
    assert.deepEqual(namesToPrune([...others, ...own(14)], name(14)), []);
    assert.deepEqual(namesToPrune([...others, ...own(15)], name(15)), [name(1)]);
    assert.deepEqual(namesToPrune([...others, ...own(20)], name(20)), [name(6), name(5), name(4), name(3), name(2), name(1)]);
    // Sorted by the date in the name, not by the order given.
    assert.deepEqual(namesToPrune([name(15), name(3), name(9), name(1), ...own(15)], name(15)), [name(1)]);
    // Tonight's file is never pruned, even when 14 newer-named files exist (a clock set wrong).
    const future = Array.from({ length: 14 }, (_, i) => `pobots-backup-2030-01-${String(i + 1).padStart(2, "0")}T0300.pobotsbackup`);
    assert.deepEqual(namesToPrune([...future, name(14), name(13)], name(14)), [name(13)]);
    // A tonight that is not a backup name prunes nothing.
    assert.deepEqual(namesToPrune(own(20), "notes.txt"), []);
  });

  test("in a real folder: other files, folders and links are never touched; with 13, 14 and 15 of our own", async () => {
    for (const count of [13, 14, 15]) {
      const folder = tempDir("pobots-prune-");
      // (Another date for the capital P: the Mac's disk does not tell names apart by case.)
      const others = ["notes.txt", "pobots-backup-2026-11-01T0300.pobotsbackup.partial", "Pobots-backup-2026-10-05T0300.pobotsbackup", "pobots-backup-2026-11-01T0300.pobotsbackup.txt"];
      for (const o of others) writeFileSync(join(folder, o), "keep me");
      // A folder and a link that carry backup names: never deleted.
      mkdirSync(join(folder, "pobots-backup-2026-10-01T0300.pobotsbackup"));
      writeFileSync(join(folder, "pobots-backup-2026-10-01T0300.pobotsbackup", "inside.txt"), "keep me");
      const outside = tempDir("pobots-outside-");
      writeFileSync(join(outside, "precious.txt"), "keep me");
      symlinkSync(join(outside, "precious.txt"), join(folder, "pobots-backup-2026-10-02T0300.pobotsbackup"));
      mkdirSync(join(folder, "test-copy"));
      writeFileSync(join(folder, "test-copy", name(1)), "the test copy's own");
      for (let d = 1; d <= count; d++) writeFileSync(join(folder, name(d)), `night ${d}`);
      const removed = await pruneFolder(folder, name(count));
      const left = readdirSync(folder).filter((n) => BACKUP_NAME.test(n) && statSync(join(folder, n)).isFile() && !lstatSync(join(folder, n)).isSymbolicLink());
      assert.equal(left.length, Math.min(count, KEEP));
      assert.deepEqual(removed, count > KEEP ? [name(1)] : []);
      for (const o of others) assert.equal(readFileSync(join(folder, o), "utf8"), "keep me");
      assert.equal(readFileSync(join(folder, "pobots-backup-2026-10-01T0300.pobotsbackup", "inside.txt"), "utf8"), "keep me");
      assert.ok(lstatSync(join(folder, "pobots-backup-2026-10-02T0300.pobotsbackup")).isSymbolicLink());
      assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
      assert.equal(readFileSync(join(folder, "test-copy", name(1)), "utf8"), "the test copy's own");
    }
  });

  test("nothing is deleted before tonight's file exists", async () => {
    const folder = tempDir("pobots-prune-");
    for (let d = 1; d <= 20; d++) writeFileSync(join(folder, name(d)), "x");
    assert.deepEqual(await pruneFolder(folder, name(21)), []);
    assert.equal(readdirSync(folder).length, 20);
    // Tonight's "file" is a folder: still nothing.
    mkdirSync(join(folder, name(21)));
    assert.deepEqual(await pruneFolder(folder, name(21)), []);
    assert.equal(readdirSync(folder).length, 21);
  });

  test("an engine run keeps the newest 14 in its folder and leaves everything else", async () => {
    const w = world({ at: "2026-11-30T09:00:00Z" });
    writeFileSync(join(w.cloud, "notes.txt"), "mine");
    for (let d = 1; d <= 15; d++) writeFileSync(join(w.cloud, name(d)), "old");
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    const files = cloudFiles(w.cloud);
    assert.ok(files.includes("notes.txt"));
    assert.ok(files.includes("pobots-backup-2026-11-30T1000.pobotsbackup"));
    assert.equal(files.filter((n) => BACKUP_NAME.test(n)).length, 14);
    assert.ok(!files.includes(name(1)) && !files.includes(name(2)));
    await stopAll(w);
  });
});

describe("nightly backup: the clock", () => {
  /** A Backup on its own, with the given runs already made. */
  const shared = { botsDir: tempDir("pobots-clock-bots-"), folder: tempDir("pobots-clock-cloud-") };
  function backupWith(o: { history?: { at: string; status: "saved" | "unconfirmed" | "failed"; by: "night" | "you" }[]; savedAt: string; time?: string; tz?: string; lastSavedAt?: string; dataDir?: string }) {
    const dataDir = o.dataDir ?? tempDir("pobots-clock-");
    writeFileSync(join(dataDir, "backup.json"), JSON.stringify({ version: 1, history: o.history ?? [], ...(o.lastSavedAt ? { lastSavedAt: o.lastSavedAt } : {}) }));
    const cards: string[] = [];
    const b = new Backup({
      dataDir,
      botsDir: shared.botsDir,
      config: { folder: shared.folder, time: o.time ?? "03:00", publicKey: keys.publicLine, publicKeySavedAt: o.savedAt },
      engineVersion: "test",
      clock: () => 0,
      tz: o.tz ?? TZ,
      readUploadState: async () => undefined,
      host: { snapshotDb: async () => undefined, bots: () => [], changed: () => undefined, showCard: (title) => cards.push(title), clearCard: () => cards.push("(cleared)") },
    });
    return { b, cards };
  }
  const T = (s: string) => Date.parse(s);
  // Stockholm in November is UTC+1: 03:00 local is 02:00Z.
  const saved = "2026-11-01T09:00:00Z";

  test("past 03:00 and nothing since: now, once; a run since then: not again until the next night", () => {
    assert.equal(backupWith({ savedAt: saved }).b.due(T("2026-11-14T01:59:00Z")), true, "before 03:00, yesterday's 03:00 was missed");
    const ran = [{ at: "2026-11-13T02:00:10.000Z", status: "saved" as const, by: "night" as const }];
    assert.equal(backupWith({ savedAt: saved, history: ran }).b.due(T("2026-11-14T01:59:59Z")), false, "02:59:59 local: the last 03:00 is covered");
    assert.equal(backupWith({ savedAt: saved, history: ran }).b.due(T("2026-11-14T02:00:00Z")), true, "03:00 local");
    assert.equal(backupWith({ savedAt: saved, history: ran }).b.due(T("2026-11-14T22:00:00Z")), true, "late, still due once");
    const tonight = [{ at: "2026-11-14T02:00:10.000Z", status: "saved" as const, by: "night" as const }, ...ran];
    for (const t of ["2026-11-14T02:01:00Z", "2026-11-14T12:00:00Z", "2026-11-14T22:59:00Z", "2026-11-15T01:59:00Z"]) assert.equal(backupWith({ savedAt: saved, history: tonight }).b.due(T(t)), false, t);
    assert.equal(backupWith({ savedAt: saved, history: tonight }).b.due(T("2026-11-15T02:00:00Z")), true, "the next night");
  });

  test("a failed nightly run is not tried again in a loop: the next try is the next night", () => {
    const failed = [{ at: "2026-11-14T02:00:05.000Z", status: "failed" as const, by: "night" as const }];
    for (const t of ["2026-11-14T02:00:35Z", "2026-11-14T02:30:00Z", "2026-11-14T20:00:00Z"]) assert.equal(backupWith({ savedAt: saved, history: failed }).b.due(T(t)), false, t);
    assert.equal(backupWith({ savedAt: saved, history: failed }).b.due(T("2026-11-15T02:00:00Z")), true);
  });

  test("by hand: a file made after 03:00 counts; a failed one does not stop the night's run", () => {
    const byHand = [{ at: "2026-11-14T09:00:00.000Z", status: "unconfirmed" as const, by: "you" as const }];
    assert.equal(backupWith({ savedAt: saved, history: byHand }).b.due(T("2026-11-14T10:00:00Z")), false);
    const failedByHand = [{ at: "2026-11-14T09:00:00.000Z", status: "failed" as const, by: "you" as const }];
    assert.equal(backupWith({ savedAt: saved, history: failedByHand }).b.due(T("2026-11-14T10:00:00Z")), true);
  });

  test("a clock set back or jumping ahead: runs and key times later than now do not count", () => {
    // The clock was ahead (a run and the key are dated next week) and has been set back.
    const ahead = [{ at: "2026-11-20T02:00:10.000Z", status: "saved" as const, by: "night" as const }];
    assert.equal(backupWith({ savedAt: saved, history: ahead }).b.due(T("2026-11-14T02:30:00Z")), true, "a run dated after now is not tonight's");
    assert.equal(backupWith({ savedAt: "2026-11-20T09:00:00Z" }).b.due(T("2026-11-14T02:30:00Z")), true, "a key dated after now does not hold the night up");
    assert.equal(backupWith({ savedAt: "2026-11-20T09:00:00Z", history: ahead }).b.due(T("2026-11-14T02:30:00Z")), true, "both");
    // Once it has run at the clock's new time, that run counts: not again until the next night.
    const ranNow = [{ at: "2026-11-14T02:30:05.000Z", status: "saved" as const, by: "night" as const }, ...ahead];
    assert.equal(backupWith({ savedAt: saved, history: ranNow }).b.due(T("2026-11-14T03:00:00Z")), false);
    assert.equal(backupWith({ savedAt: saved, history: ranNow }).b.due(T("2026-11-15T02:00:00Z")), true);
    // The clock jumps days ahead: one run now, then not again that night.
    const longAgo = [{ at: "2026-11-13T02:00:10.000Z", status: "saved" as const, by: "night" as const }];
    assert.equal(backupWith({ savedAt: saved, history: longAgo }).b.due(T("2026-11-17T12:00:00Z")), true);
    const caughtUp = [{ at: "2026-11-17T12:00:05.000Z", status: "saved" as const, by: "night" as const }, ...longAgo];
    assert.equal(backupWith({ savedAt: saved, history: caughtUp }).b.due(T("2026-11-17T12:30:00Z")), false);
    // And then set back again behind that run: it no longer counts.
    assert.equal(backupWith({ savedAt: saved, history: caughtUp }).b.due(T("2026-11-16T02:30:00Z")), true);
  });

  test("a key saved after 03:00 waits for the next night", () => {
    assert.equal(backupWith({ savedAt: "2026-11-14T09:00:00Z" }).b.due(T("2026-11-14T10:00:00Z")), false);
    assert.equal(backupWith({ savedAt: "2026-11-14T09:00:00Z" }).b.due(T("2026-11-15T02:00:00Z")), true);
  });

  test("across a day change and both daylight saving changes: exactly one run a night, at 03:00 local", () => {
    for (const [from, to, time] of [
      ["2027-03-26T12:00:00Z", "2027-03-31T12:00:00Z", "03:00"], // clocks go forward on 28 Mar 2027 (02:00 to 03:00)
      ["2026-10-23T12:00:00Z", "2026-10-28T12:00:00Z", "03:00"], // clocks go back on 25 Oct 2026 (03:00 to 02:00)
      ["2027-03-26T12:00:00Z", "2027-03-31T12:00:00Z", "02:30"], // a time the clocks jump over: 03:00 that day
      ["2026-10-23T12:00:00Z", "2026-10-28T12:00:00Z", "02:30"], // a time that happens twice: the first
    ] as const) {
      const history: { at: string; status: "saved"; by: "night" }[] = [];
      const dataDir = tempDir("pobots-clock-");
      let b = backupWith({ savedAt: "2026-01-01T00:00:00Z", history, time, dataDir }).b;
      for (let t = T(from); t <= T(to); t += 15 * 60_000) {
        if (b.due(t)) {
          history.unshift({ at: new Date(t).toISOString(), status: "saved", by: "night" });
          b = backupWith({ savedAt: "2026-01-01T00:00:00Z", history, time, dataDir }).b;
        }
      }
      const runs = history.map((r) => Date.parse(r.at)).reverse();
      // The first run catches up on the morning before the window; after that one per night.
      const nights = runs.slice(1);
      assert.equal(nights.length, 5, `${from} ${time}: ${runs.map((r) => new Date(r).toISOString()).join(", ")}`);
      const days = nights.map((r) => {
        const w = wallOf(r, TZ);
        return `${w.y}-${w.mo + 1}-${w.d}`;
      });
      assert.equal(new Set(days).size, 5, "one per day");
      for (const r of nights) {
        const w = wallOf(r, TZ);
        const hm = w.h * 60 + w.mi;
        if (time === "03:00") assert.equal(hm, 180, new Date(r).toISOString());
        else assert.ok(hm === 150 || hm === 180, new Date(r).toISOString());
      }
    }
    // The slot itself on those days.
    assert.equal(new Date(slotAtOrBefore(T("2027-03-28T12:00:00Z"), "03:00", TZ)).toISOString(), "2027-03-28T01:00:00.000Z");
    assert.equal(new Date(slotAtOrBefore(T("2026-10-25T12:00:00Z"), "03:00", TZ)).toISOString(), "2026-10-25T02:00:00.000Z");
    assert.equal(new Date(slotAtOrBefore(T("2027-03-28T12:00:00Z"), "02:30", TZ)).toISOString(), "2027-03-28T01:00:00.000Z");
    assert.equal(new Date(slotAtOrBefore(T("2026-10-25T12:00:00Z"), "02:30", TZ)).toISOString(), "2026-10-25T00:30:00.000Z");
  });

  test("the nightly run starts from the engine's clock, by itself, once", async () => {
    const w = world({ at: "2026-11-13T09:00:00Z" });
    w.engine.setBackupKey(keys.publicLine);
    w.clock.now = Date.parse("2026-11-14T01:59:00Z");
    w.engine.checkSchedules();
    assert.equal(w.engine.snapshot().backup.running, false);
    w.clock.now = Date.parse("2026-11-14T02:00:20Z");
    w.engine.checkSchedules();
    assert.equal(w.engine.snapshot().backup.running, true);
    await w.engine.backupIdle();
    w.clock.now += 60_000;
    w.engine.checkSchedules();
    await w.engine.backupIdle();
    const s = w.engine.snapshot().backup;
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0]!.by, "night");
    assert.deepEqual(cloudFiles(w.cloud), ["pobots-backup-2026-11-14T0300.pobotsbackup"]);
    assert.equal(s.nextAt, "2026-11-15T02:00:00.000Z");
    await stopAll(w);
  });
});

describe("nightly backup: telling the person", () => {
  const night = (w: ReturnType<typeof world>, iso: string) => {
    w.clock.now = Date.parse(iso);
    w.engine.checkSchedules();
    return w.engine.backupIdle();
  };

  test("an unconfirmed nightly run puts up a card; a later run sees OneDrive took it after all, marks it saved and takes the card down", async () => {
    const w = world({ at: "2026-11-13T09:00:00Z", limitMs: 100 });
    w.engine.setBackupKey(keys.publicLine);
    const first = "pobots-backup-2026-11-14T0300.pobotsbackup";
    w.uploads.set(first, { exists: true, uploaded: false, uploading: false, uploadError: null });
    await night(w, "2026-11-14T02:00:10Z");
    let s = w.engine.snapshot();
    assert.equal(s.backup.history[0]!.status, "unconfirmed");
    assert.equal(s.backup.history[0]!.problem, UNCONFIRMED);
    assert.deepEqual(s.backup.lastGood?.file, first);
    const cards = systemCards(s.cards);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.topic, "backup");
    assert.equal(cards[0]!.title, "Last night's backup did not reach OneDrive");
    assert.equal(cards[0]!.text, UNCONFIRMED);
    // OneDrive takes it later.
    w.uploads.delete(first);
    w.clock.now = Date.parse("2026-11-14T09:00:00Z");
    w.engine.runBackup();
    await w.engine.backupIdle();
    s = w.engine.snapshot();
    assert.deepEqual(s.backup.history.map((r) => [r.status, r.file]), [
      ["saved", "pobots-backup-2026-11-14T1000.pobotsbackup"],
      ["saved", first],
    ]);
    assert.equal(s.backup.history[1]!.problem, undefined);
    assert.deepEqual(systemCards(s.cards), []);
    assert.ok(w.events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).cardId === cards[0]!.id));
    await stopAll(w);
  });

  test("the card: appears on a failed night, is replaced not stacked, is dismissed, survives a restart, is removed after a saved run", async () => {
    const w = world({ at: "2026-11-13T09:00:00Z" });
    w.engine.setBackupKey(keys.publicLine);
    chmodSync(w.cloud, 0o500);
    try {
      await night(w, "2026-11-14T02:00:10Z");
      let s = w.engine.snapshot();
      assert.equal(s.backup.history[0]!.status, "failed");
      assert.equal(s.backup.history[0]!.problem, "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.");
      assert.equal(s.backup.folder.ok, false);
      const a = systemCards(s.cards);
      assert.equal(a.length, 1);
      assert.equal(a[0]!.title, "Last night's backup failed");
      assert.equal(a[0]!.text, "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.");
      assert.ok(!("botId" in a[0]!) && !("threadId" in a[0]!));
      // Not again in a loop.
      await night(w, "2026-11-14T02:30:00Z");
      assert.equal(w.engine.snapshot().backup.history.length, 1);
      // The next night fails too: the card is replaced.
      await night(w, "2026-11-15T02:00:10Z");
      s = w.engine.snapshot();
      const b = systemCards(s.cards);
      assert.equal(b.length, 1);
      assert.notEqual(b[0]!.id, a[0]!.id);
      assert.ok(w.events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).cardId === a[0]!.id && (e.data as Events["card.removed"]).reason === "withdrawn"));
      // Put away by the person.
      assert.throws(() => w.engine.resolveCard(b[0]!.id, { type: "deny" }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
      w.engine.resolveCard(b[0]!.id, { type: "dismiss" });
      assert.deepEqual(systemCards(w.engine.snapshot().cards), []);
      // A third night: a new card, kept across a restart.
      await night(w, "2026-11-16T02:00:10Z");
      const c = systemCards(w.engine.snapshot().cards);
      assert.equal(c.length, 1);
      await stopAll(w);
      const again = world({ at: "2026-11-16T09:00:00Z", dirs: w.dirs, cloud: w.cloud });
      assert.deepEqual(systemCards(again.engine.snapshot().cards).map((x) => x.id), [c[0]!.id]);
      again.engine.setBackupKey(keys.publicLine);
      chmodSync(w.cloud, 0o700);
      // A failure by hand puts up no card of its own; a saved run takes the card down.
      again.engine.runBackup();
      await again.engine.backupIdle();
      assert.equal(again.engine.snapshot().backup.history[0]!.status, "saved");
      assert.deepEqual(systemCards(again.engine.snapshot().cards), []);
      await stopAll(again);
    } finally {
      chmodSync(w.cloud, 0o700);
    }
  });

  test("an earlier run found saved later takes the card down only when nothing failed after it", async () => {
    const w = world({ at: "2026-11-13T09:00:00Z", limitMs: 60 });
    w.engine.setBackupKey(keys.publicLine);
    const first = "pobots-backup-2026-11-14T0300.pobotsbackup";
    w.uploads.set(first, { exists: true, uploaded: false });
    await night(w, "2026-11-14T02:00:10Z");
    chmodSync(w.cloud, 0o500);
    try {
      await night(w, "2026-11-15T02:00:10Z");
    } finally {
      chmodSync(w.cloud, 0o700);
    }
    const failedCard = systemCards(w.engine.snapshot().cards);
    assert.equal(failedCard[0]?.title, "Last night's backup failed");
    await stopAll(w);
    // After a start OneDrive says it has the first file: that run is saved, but the failure after it still stands.
    const again = world({ at: "2026-11-15T09:00:00Z", dirs: w.dirs, cloud: w.cloud });
    await again.engine.backupIdle();
    const s = again.engine.snapshot();
    assert.deepEqual(s.backup.history.map((r) => r.status), ["failed", "saved"]);
    assert.deepEqual(systemCards(s.cards).map((c) => c.id), [failedCard[0]!.id]);
    await stopAll(again);
  });

  test("a backup folder inside Pobots' own folders is refused", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    mkdirSync(join(dirs.botsDir, "cloud"));
    const w = setup(dirs, undefined, undefined, { timeZone: TZ, backupConfig: { folder: join(dirs.botsDir, "cloud"), time: "03:00" }, backup: { readUploadState: async () => undefined } });
    assert.deepEqual(w.engine.snapshot().backup.folder, { path: join(dirs.botsDir, "cloud"), ok: false, problem: "The backup folder may not be inside Pobots' own folders." });
    await stopAll(w);
  });

  test("a missing backup folder says what to check, in the folder's state and on the failed run", async () => {
    const parent = tempDir("pobots-cloud-parent-");
    const w = world({ cloud: join(parent, "Pobot") });
    w.engine.setBackupKey(keys.publicLine);
    const want = "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.";
    assert.deepEqual(w.engine.snapshot().backup.folder, { path: join(parent, "Pobot"), ok: false, problem: want });
    w.engine.runBackup();
    await w.engine.backupIdle();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.problem, want);
    await stopAll(w);
  });

  test("no backup saved for two days while a key is set: one card, not again after it is dismissed", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const cloud = tempDir("pobots-cloud-");
    writeFileSync(join(dirs.dataDir, "backup.json"), JSON.stringify({ version: 1, history: [{ at: "2026-11-12T02:00:05.000Z", status: "failed", by: "night", problem: "The Mac's disk is full." }] }));
    const w = setup(dirs, undefined, undefined, {
      clock: () => Date.parse("2026-11-12T12:00:00Z"),
      timeZone: TZ,
      backupConfig: { folder: cloud, time: "03:00", publicKey: keys.publicLine, publicKeySavedAt: "2026-11-10T09:00:00.000Z" },
      backup: { readUploadState: async () => undefined },
    });
    w.engine.checkSchedules();
    let cards = systemCards(w.engine.snapshot().cards);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.title, "No backup for two days");
    assert.equal(cards[0]!.text, "No backup has reached OneDrive since the key was saved.");
    assert.equal(w.engine.snapshot().backup.running, false, "no run: the night's run was tried");
    w.engine.resolveCard(cards[0]!.id, { type: "dismiss" });
    w.engine.checkSchedules();
    cards = systemCards(w.engine.snapshot().cards);
    assert.deepEqual(cards, []);
    await stopAll(w);
  });

  test("a SystemCard does not touch the bots: their states and counts stay as they were", async () => {
    const w = world({ at: "2026-11-13T09:00:00Z" });
    const bot = w.engine.createBot("Kaja");
    w.engine.setBackupKey(keys.publicLine);
    chmodSync(w.cloud, 0o500);
    try {
      await night(w, "2026-11-14T02:00:10Z");
    } finally {
      chmodSync(w.cloud, 0o700);
    }
    const s = w.engine.snapshot();
    assert.equal(systemCards(s.cards).length, 1);
    assert.equal(s.bots.find((b) => b.id === bot.id)?.state, "idle");
    // The bot still works and its own cards still work beside the system card.
    w.engine.sendMessage({ botId: bot.id, text: "Do it" });
    await settle();
    const pending = w.sessions[0]!.ask("Bash", { command: "ls" });
    const own = w.engine.snapshot().cards.filter((c) => c.kind === "approval");
    assert.equal(own.length, 1);
    w.engine.resolveCard(own[0]!.id, { type: "allow-once" });
    await pending;
    assert.equal(systemCards(w.engine.snapshot().cards).length, 1);
    // Retiring the bot withdraws its cards, not Pobots' own.
    w.engine.retireBot(bot.id);
    assert.equal(systemCards(w.engine.snapshot().cards).length, 1);
    await stopAll(w);
  });
});

describe("nightly backup: the review's fixes", () => {
  const old15 = Array.from({ length: 15 }, (_, i) => `pobots-backup-2026-10-${String(i + 1).padStart(2, "0")}T0300.pobotsbackup`);

  test("a missing or unreadable bots folder, or a bot without a folder: the run fails plainly and nothing is pruned", async () => {
    const w = world();
    const bot = w.engine.createBot("Kaja");
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    assert.equal(w.engine.snapshot().backup.history[0]!.status, "saved");
    for (const n of old15) writeFileSync(join(w.cloud, n), "an older night");
    const before = cloudFiles(w.cloud);
    assert.equal(before.length, 16);
    const attempt = async (expected: string) => {
      w.clock.now += 60_000;
      w.engine.runBackup();
      await w.engine.backupIdle();
      const run = w.engine.snapshot().backup.history[0]!;
      assert.equal(run.status, "failed");
      assert.equal(run.problem, expected);
      assert.equal(run.file, undefined);
      assert.deepEqual(cloudFiles(w.cloud), before, "nothing made, nothing pruned");
    };
    const botDir = join(w.dirs.botsDir, bot.id);
    const aside = join(tempDir("pobots-aside-"), "x");
    renameSync(botDir, aside);
    await attempt("The folder of the bot Kaja is missing, so no backup was made.");
    renameSync(aside, botDir);
    const botsAside = join(tempDir("pobots-aside-"), "bots");
    renameSync(w.dirs.botsDir, botsAside);
    await attempt("The bots folder is not there, so no backup was made.");
    renameSync(botsAside, w.dirs.botsDir);
    chmodSync(w.dirs.botsDir, 0o000);
    try {
      await attempt("Pobots may not read the bots folder, so no backup was made.");
    } finally {
      chmodSync(w.dirs.botsDir, 0o755);
    }
    // All back: a run is saved again, and only then are the oldest pruned.
    w.clock.now += 60_000;
    w.engine.runBackup();
    await w.engine.backupIdle();
    assert.equal(w.engine.snapshot().backup.history[0]!.status, "saved");
    assert.equal(cloudFiles(w.cloud).filter((n) => BACKUP_NAME.test(n)).length, KEEP);
    await stopAll(w);
  });

  test("two Pobots pointed at one folder: the owner note keeps the second out, it never runs or prunes there", async () => {
    const a = world();
    const b = world({ cloud: a.cloud });
    a.engine.setBackupKey(keys.publicLine);
    b.engine.setBackupKey(keys.publicLine);
    a.engine.runBackup();
    await a.engine.backupIdle();
    const aRun = a.engine.snapshot().backup.history[0]!;
    assert.equal(aRun.status, "saved");
    // The note: hidden, never a backup name, names A's data folder, holds no key.
    assert.ok(!BACKUP_NAME.test(OWNER_FILE));
    const noteText = readFileSync(join(a.cloud, OWNER_FILE), "utf8");
    const note = JSON.parse(noteText) as { kind: string; dataDir: string };
    assert.equal(note.kind, "pobots-backup-owner");
    assert.equal(note.dataDir, realpathSync(a.dirs.dataDir));
    assert.ok(!noteText.includes(keys.publicLine.split(/\s+/)[1]!.slice(20, 60)), "no key in the note");
    for (const n of old15) writeFileSync(join(a.cloud, n), "an older night");
    const before = cloudFiles(a.cloud);
    const size = statSync(join(a.cloud, aRun.file!)).size;
    // B sees why on its page, and its runs fail in plain words: no file, nothing pruned.
    assert.deepEqual(b.engine.snapshot().backup.folder, { path: a.cloud, ok: false, problem: OTHER_OWNER });
    b.clock.now += 60_000;
    b.engine.runBackup();
    await b.engine.backupIdle();
    const bRun = b.engine.snapshot().backup.history[0]!;
    assert.equal(bRun.status, "failed");
    assert.equal(bRun.problem, OTHER_OWNER);
    b.clock.now = Date.parse("2026-11-15T02:00:30Z");
    b.engine.checkSchedules();
    await b.engine.backupIdle();
    assert.equal(b.engine.snapshot().backup.history[0]!.problem, OTHER_OWNER);
    assert.deepEqual(cloudFiles(a.cloud), before);
    assert.equal(statSync(join(a.cloud, aRun.file!)).size, size);
    // A note that cannot be read keeps everyone out too.
    writeFileSync(join(a.cloud, OWNER_FILE), "not a note");
    assert.match(a.engine.snapshot().backup.folder.problem ?? "", /cannot be read/);
    await stopAll(a);
    await stopAll(b);
  });

  test("the file gets its name without ever replacing one: a file that appears under that name at the last moment is kept", async () => {
    const w = world({
      link: async (from, to) => {
        if (BACKUP_NAME.test(basename(to))) writeFileSync(to, "made by someone else a moment ago");
        return fsLink(from, to);
      },
    });
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.problem, MOMENT_AGO);
    const name = backupFileName(w.clock.now, TZ);
    assert.deepEqual(cloudFiles(w.cloud), [name]);
    assert.equal(readFileSync(join(w.cloud, name), "utf8"), "made by someone else a moment ago");
    assert.ok(!existsSync(join(w.dirs.dataDir, "backups", ".work")));
    await stopAll(w);
  });

  test("a stop during a slow copy into the folder ends it and removes its half-made files before the store closes", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hidden = "";
    const w = world({
      stopMs: 300,
      link: async () => {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      },
      // Writes half and then hangs, deaf to the stop.
      copy: async (_from, to) => {
        hidden = to;
        writeFileSync(to, "half a backup", { flag: "wx" });
        await held;
      },
    });
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await waitFor(() => hidden !== "" && existsSync(hidden), 10_000, "the half-made copy in the folder");
    assert.equal(basename(hidden).startsWith("."), true);
    const began = Date.now();
    w.engine.shutdown();
    const clean = await w.engine.backupStopped();
    const took = Date.now() - began;
    assert.equal(clean, true, "the clean-up is proven done");
    assert.ok(took >= 300 && took < 4000, `bounded: ${took} ms`);
    assert.ok(!existsSync(hidden), "the half-made copy in the folder is removed");
    assert.deepEqual(cloudFiles(w.cloud), []);
    assert.ok(!existsSync(join(w.dirs.dataDir, "backups", ".work")), "the work folder in the data folder is removed");
    w.store.close();
    release();
    await w.engine.backupIdle();
    assert.deepEqual(cloudFiles(w.cloud), [], "nothing appears later either");
    const record = join(w.dirs.dataDir, "backup.json");
    assert.ok(!existsSync(record) || (JSON.parse(readFileSync(record, "utf8")) as { history: unknown[] }).history.length === 0, "no run recorded");
  });

  test("a stop during a slow copy that listens ends at once, clean", async () => {
    let hidden = "";
    const w = world({
      stopMs: 10_000,
      link: async () => {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      },
      copy: async (_from, to, signal) => {
        hidden = to;
        writeFileSync(to, "half a backup", { flag: "wx" });
        await new Promise<void>((_r, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
      },
    });
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await waitFor(() => hidden !== "" && existsSync(hidden), 10_000, "the half-made copy in the folder");
    const began = Date.now();
    w.engine.shutdown();
    assert.equal(await w.engine.backupStopped(), true);
    assert.ok(Date.now() - began < 2000);
    assert.ok(!existsSync(hidden));
    assert.deepEqual(cloudFiles(w.cloud), []);
    assert.deepEqual(w.engine.snapshot().backup.history, []);
    w.store.close();
  });

  test("an earlier unconfirmed file is marked saved only when uploaded holds for the minute, not after one reading", async () => {
    const first = "pobots-backup-2026-11-14T0300.pobotsbackup";
    let mode: "not" | "once" | "always" = "not";
    let firstReads = 0;
    const up: UploadState = { exists: true, ubiquitous: true, uploaded: true, uploading: false, uploadError: null };
    const w = world({
      at: "2026-11-13T09:00:00Z",
      limitMs: 1000,
      holdMs: 150,
      reader: async (path) => {
        if (!existsSync(path)) return { exists: false };
        if (basename(path) !== first) return up;
        firstReads++;
        if (mode === "always" || (mode === "once" && firstReads === 1)) return up;
        return { ...up, uploaded: false, uploading: true };
      },
    });
    w.engine.setBackupKey(keys.publicLine);
    w.clock.now = Date.parse("2026-11-14T02:00:10Z");
    w.engine.checkSchedules();
    await w.engine.backupIdle();
    assert.equal(w.engine.snapshot().backup.history[0]!.status, "unconfirmed");
    // Uploaded once, then not: it stays unconfirmed.
    mode = "once";
    firstReads = 0;
    w.clock.now = Date.parse("2026-11-14T09:00:00Z");
    w.engine.runBackup();
    await w.engine.backupIdle();
    let s = w.engine.snapshot().backup;
    assert.deepEqual(s.history.map((r) => [r.status, r.file]), [
      ["saved", "pobots-backup-2026-11-14T1000.pobotsbackup"],
      ["unconfirmed", first],
    ]);
    assert.ok(firstReads >= 2, "it was looked at again within the minute");
    // Uploaded and still so after the hold: saved.
    mode = "always";
    w.clock.now = Date.parse("2026-11-14T10:00:00Z");
    w.engine.runBackup();
    await w.engine.backupIdle();
    s = w.engine.snapshot().backup;
    assert.equal(s.history.find((r) => r.file === first)?.status, "saved");
    await stopAll(w);
  });

  test("backup.folder: absent uses the default (the real copy only); present but empty or not a full path refuses plainly", () => {
    const defaults = { dataDir: "/Users/x/Library/Application Support/Pobots", folder: "/Users/x/Library/CloudStorage/OneDrive-Personal/Pobot" };
    assert.equal(backupConfig(defaults.dataDir, undefined, defaults).folder, defaults.folder);
    assert.equal(backupConfig(defaults.dataDir, {}, defaults).folder, defaults.folder);
    for (const folder of ["", "   ", "relative/folder", "~nobody/Pobot"]) {
      const c = backupConfig(defaults.dataDir, { folder }, defaults);
      assert.equal(c.folder, "", JSON.stringify(folder));
      assert.equal(c.folderProblem, BAD_FOLDER_SETTING, JSON.stringify(folder));
    }
    // config.json: a present but wrong value stays present (never read as absent).
    const dir = tempDir("pobots-config-");
    for (const [value, expected] of [[{ folder: "" }, ""], [{ folder: "  " }, ""], [{ folder: 42 }, ""], [{ folder: null }, ""], [{}, undefined], [{ folder: "~/Backups" }, "~/Backups"]] as const) {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ backup: value }));
      assert.equal(loadConfigFile(dir).backup?.folder, expected, JSON.stringify(value));
    }
  });

  test("an empty folder setting: the state says why and a run fails with it", async () => {
    const dirs = { dataDir: tempDir("pobots-data-"), botsDir: tempDir("pobots-bots-") };
    const w = setup(dirs, undefined, undefined, { clock: () => Date.parse("2026-11-14T09:00:00Z"), timeZone: TZ, backupConfig: backupConfig(dirs.dataDir, { folder: "" }) });
    w.engine.setBackupKey(keys.publicLine);
    assert.deepEqual(w.engine.snapshot().backup.folder, { path: "", ok: false, problem: BAD_FOLDER_SETTING });
    w.engine.runBackup();
    await w.engine.backupIdle();
    assert.equal(w.engine.snapshot().backup.history[0]!.problem, BAD_FOLDER_SETTING);
    await stopAll(w);
  });

  test("the next run's time is worked out whenever the state is read or sent, also while a run is going", async () => {
    const w = world({ at: "2026-11-14T09:00:00Z", limitMs: 60_000 });
    w.engine.setBackupKey(keys.publicLine);
    assert.equal(w.engine.snapshot().backup.nextAt, "2026-11-15T02:00:00.000Z");
    // Read: worked out from the clock now.
    w.clock.now = Date.parse("2026-11-15T01:59:00Z");
    assert.equal(w.engine.snapshot().backup.nextAt, "2026-11-15T02:00:00.000Z");
    // A run by hand at 02:59 local that is still checking its file when 03:00 passes.
    const name = backupFileName(w.clock.now, TZ);
    w.uploads.set(name, { exists: true, uploaded: false, uploading: true, uploadError: null });
    w.engine.runBackup();
    await waitFor(() => existsSync(join(w.cloud, name)), 10_000, "the file in the folder");
    w.clock.now = Date.parse("2026-11-15T02:00:30Z");
    assert.equal(w.engine.snapshot().backup.nextAt, "2026-11-16T02:00:00.000Z");
    const sent = backupEvents(w.events).length;
    w.engine.checkSchedules();
    const after = backupEvents(w.events);
    assert.ok(after.length > sent, "the clock sends the new time");
    assert.equal(after.at(-1)!.nextAt, "2026-11-16T02:00:00.000Z");
    assert.equal(after.at(-1)!.running, true);
    // Not sent again while it stays the same.
    w.engine.checkSchedules();
    assert.equal(backupEvents(w.events).length, after.length);
    w.engine.shutdown();
    await w.engine.backupStopped();
    w.store.close();
  });

  test("every accepted key: the fingerprint Pobots shows is the private key's own, through a whole backup and restore --check", async () => {
    const pairs = [
      { line: keys.publicLine, privateFile: keys.privateFile, privateText: keys.openssh },
      { line: keys.otherPublicLine, privateFile: join(keys.dir, "other"), privateText: keys.otherPrivate },
    ];
    for (const p of pairs) {
      const fromPrivate = fingerprintOfKey(readPrivateKey(p.privateText));
      // ssh-keygen's own: the public half of the private key, then its fingerprint.
      const half = execFileSync("ssh-keygen", ["-y", "-f", p.privateFile], { encoding: "utf8" });
      const halfFile = join(tempDir("pobots-half-"), "half.pub");
      writeFileSync(halfFile, half);
      const fromKeygen = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", halfFile], { encoding: "utf8" }).split(" ")[1];
      assert.equal(fromPrivate, fromKeygen);
      const body = p.line.split(/\s+/)[1]!;
      for (const pasted of [p.line, `  ${p.line.trim()}  `, `ssh-rsa ${body.slice(0, 300)}\n${body.slice(300)} stand-in@example.com`]) {
        assert.equal(parsePublicKeyLine(pasted).fingerprint, fromPrivate);
      }
      const w = world();
      w.engine.createBot("Kaja");
      w.engine.setBackupKey(p.line);
      assert.equal(w.engine.snapshot().backup.key?.fingerprint, fromPrivate);
      w.engine.runBackup();
      await w.engine.backupIdle();
      const run = w.engine.snapshot().backup.history[0]!;
      assert.equal(run.status, "saved", run.problem);
      const file = join(w.cloud, run.file!);
      assert.equal(readHeader(readFileSync(file)).keyFingerprint, fromPrivate);
      const r = spawnSync(process.execPath, [restoreScript, "--check", file], { input: p.privateText, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      await stopAll(w);
    }
  });
});

describe("restore.mjs", () => {
  /** A real backup file made by the engine, and its folders. */
  async function made() {
    const w = world();
    const bot = w.engine.createBot("Kaja");
    w.engine.sendMessage({ botId: bot.id, text: "Remember this" });
    await settle();
    w.sessions[0]!.reply("I will");
    await settle();
    writeFileSync(join(w.dirs.botsDir, bot.id, "notes.md"), "restored notes\n");
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "saved");
    const items = w.engine.readThread({ threadId: bot.mainThreadId }).items.length;
    await stopAll(w);
    return { file: join(w.cloud, run.file!), bot, items };
  }
  const restore = (args: string[], key: string) => spawnSync(process.execPath, [restoreScript, ...args], { input: key, encoding: "utf8", timeout: 60_000 });

  test("--check with the right key opens every part; with a wrong key it refuses plainly", async () => {
    const { file } = await made();
    const right = restore(["--check", file], keys.openssh);
    assert.equal(right.status, 0, right.stderr);
    assert.match(right.stdout, /This key opens the backup of /);
    assert.match(right.stdout, /bots: Kaja/);
    for (const k of [keys.pkcs8, keys.pkcs1]) assert.equal(restore(["--check", file], k).status, 0);
    const wrong = restore(["--check", file], keys.otherPrivate);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /This private key does not open this backup\./);
    const nothing = restore(["--check", file], "");
    assert.equal(nothing.status, 2);
    assert.match(nothing.stderr, /No private key came in/);
    // A damaged file.
    const damaged = join(tempDir(), "damaged.pobotsbackup");
    const buf = readFileSync(file);
    buf[buf.length - 50]! ^= 1;
    writeFileSync(damaged, buf);
    const bad = restore(["--check", damaged], keys.openssh);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /damaged or was changed/);
    // Neither the key nor its parts in what the script printed.
    for (const piece of keyBodyPieces(keys.openssh)) assert.ok(!(right.stdout + right.stderr + wrong.stderr).includes(piece));
  });

  test("--test-copy and --real take no folders; --folders never takes the real or the test copy's folders", async () => {
    const { file } = await made();
    for (const args of [
      ["--test-copy", "--data-dir=/tmp/x", file],
      ["--test-copy", "--bots-dir=/tmp/x", file],
      ["--real", "--label=app.pobots.engine-test", file],
      ["--folders", "--data-dir=~/Library/Application Support/Pobots", "--bots-dir=/tmp/pobots-nowhere-bots", file],
      ["--folders", "--data-dir=/tmp/pobots-nowhere-data", "--bots-dir=~/Pobots-test/bots", file],
      ["--folders", "--data-dir=/tmp/pobots-nowhere-data", "--bots-dir=~/Pobots/bots/sub", file],
      ["--folders", "--data-dir=/tmp/pobots-nowhere-data", file],
      ["--check", "--test-copy", file],
      ["--check"],
    ]) {
      const r = restore(args, keys.openssh);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.trim().length > 0);
    }
    assert.ok(!existsSync("/tmp/pobots-nowhere-data") && !existsSync("/tmp/pobots-nowhere-bots"));
  });

  test("--folders puts a backup into a stopped Pobots on temporary folders; what was there is moved aside; an engine there has the bots and chats", async () => {
    const { file, bot, items } = await made();
    const dataDir = tempDir("pobots-restored-data-");
    const botsDir = join(tempDir("pobots-restored-home-"), "bots");
    mkdirSync(join(botsDir, "someone-else"), { recursive: true });
    writeFileSync(join(botsDir, "someone-else", "AGENTS.md"), "was here before");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claude: {}, backup: { folder: "/tmp/own" } }));
    writeFileSync(join(dataDir, "pobots.db"), "an old database");
    const r = restore(["--folders", `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`, file], keys.pkcs8);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /The backup is in place/);
    const aside = readdirSync(dataDir).find((n) => n.startsWith("restore-previous-"));
    assert.ok(aside);
    assert.equal(readFileSync(join(dataDir, aside!, "pobots.db"), "utf8"), "an old database");
    assert.ok(existsSync(join(dataDir, aside!, "config.from-backup.json")));
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).backup.folder, "/tmp/own", "its own settings stay");
    const botsAside = readdirSync(join(botsDir, "..")).find((n) => n.startsWith("bots.before-restore-"));
    assert.ok(botsAside);
    assert.equal(readFileSync(join(botsDir, "..", botsAside!, "someone-else", "AGENTS.md"), "utf8"), "was here before");
    assert.equal(readFileSync(join(botsDir, bot.id, "notes.md"), "utf8"), "restored notes\n");
    assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith("pobots-restore-") && statSync(join(tmpdir(), n)).mtimeMs > Date.now() - 60_000), [], "the unpacked copy is removed");
    // An engine on the restored folders.
    const w = setup({ dataDir, botsDir });
    const back = w.engine.snapshot().bots.find((b) => b.id === bot.id);
    assert.ok(back);
    const thread = w.engine.readThread({ threadId: back.mainThreadId }).items;
    assert.ok(thread.length >= items);
    assert.ok(thread.some((i) => i.kind === "user" && i.text === "Remember this"));
    assert.ok(thread.some((i) => i.kind === "bot" && i.text === "I will"));
    await stopAll(w);
  });

  test("a file sent in the chat (in the bot's hidden .attachments folder) is in the backup and comes back with --folders", async () => {
    const w = world();
    const bot = w.engine.createBot("Kaja");
    const bytes = Buffer.from("The code word is lantern.\n");
    const { id, part } = w.engine.beginUpload(bot.id);
    writeFileSync(part, bytes);
    const sent = await w.engine.finishUpload(id, bot.id, "notes.txt");
    const item = w.engine.sendMessage({ botId: bot.id, text: "Read this", attachments: [sent.id] });
    await settle();
    w.sessions[0]!.reply("Read it");
    await settle();
    const stored = (item.kind === "user" ? item.attachments : undefined)?.[0];
    assert.ok(stored?.path.startsWith(".attachments/"), `the file is in the bot's .attachments folder: ${stored?.path}`);
    assert.deepEqual(readFileSync(join(w.dirs.botsDir, bot.id, stored!.path)), bytes);
    w.engine.setBackupKey(keys.publicLine);
    w.engine.runBackup();
    await w.engine.backupIdle();
    const run = w.engine.snapshot().backup.history[0]!;
    assert.equal(run.status, "saved");
    assert.deepEqual(run.leftOut ?? [], []);
    await stopAll(w);
    // In the backup itself.
    const out = tempDir("pobots-unlocked-");
    await unlockInto(join(w.cloud, run.file!), keys.pkcs8, out);
    assert.deepEqual(readFileSync(join(out, "bots", bot.id, stored!.path)), bytes, "the attached file is in the backup");
    // Back with restore.mjs --folders, and an engine there finds it (not missing).
    const dataDir = tempDir("pobots-restored-data-");
    const botsDir = join(tempDir("pobots-restored-home-"), "bots");
    const r = restore(["--folders", `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`, join(w.cloud, run.file!)], keys.openssh);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(join(botsDir, bot.id, stored!.path)), bytes, "the attached file is back");
    const back = setup({ dataDir, botsDir });
    const thread = back.engine.readThread({ threadId: bot.mainThreadId }).items;
    const again = thread.find((i) => i.kind === "user" && i.text === "Read this");
    assert.ok(again?.kind === "user" && again.attachments?.length === 1 && !again.attachments[0]!.missing, "the restored message has its file");
    await stopAll(back);
  });

  test("refuses a backup made by a newer engine", async () => {
    // A file made by an engine that says it is 99.0.0.
    const dataDir = tempDir();
    const cloud = tempDir("pobots-cloud-");
    const b = new Backup({
      dataDir,
      botsDir: tempDir(),
      config: { folder: cloud, time: "03:00", publicKey: keys.publicLine, publicKeySavedAt: "2026-11-01T00:00:00Z" },
      engineVersion: "99.0.0",
      clock: () => Date.parse("2026-11-14T09:00:00Z"),
      tz: TZ,
      readUploadState: async () => ({ exists: true, uploaded: true }),
      timings: { pollMs: 5, holdMs: 10, limitMs: 200 },
      host: { snapshotDb: async (p) => new Store(p).close(), bots: () => [], changed: () => undefined, showCard: () => undefined, clearCard: () => undefined },
    });
    b.runNow();
    await b.idle();
    const newer = join(cloud, "pobots-backup-2026-11-14T1000.pobotsbackup");
    assert.equal(readHeader(readFileSync(newer)).engineVersion, "99.0.0");
    assert.equal(restore(["--check", newer], keys.openssh).status, 0, "checking it is fine");
    const target = { dataDir: tempDir("pobots-restored-data-"), botsDir: join(tempDir(), "bots") };
    const r = restore(["--folders", `--data-dir=${target.dataDir}`, `--bots-dir=${target.botsDir}`, newer], keys.openssh);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /made by Pobots 99\.0\.0, which is newer than/);
    assert.deepEqual(readdirSync(target.dataDir), [], "nothing was changed");
    // The format's own number from the future is refused before any key is used.
    const { file } = await made();
    const buf = readFileSync(file);
    buf[8] = 9;
    const future = join(tempDir(), "future.pobotsbackup");
    writeFileSync(future, buf);
    const f = restore(["--check", future], keys.openssh);
    assert.equal(f.status, 2);
    assert.match(f.stderr, /made by a newer Pobots/);
  });
});

