// scripts/restore.mjs against hostile archives made by hand and copies that fail halfway, all in
// temporary folders. The archives are locked with a stand-in key (backup-keys.ts), never a real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { lockStream, parsePublicKeyLine } from "../backup-format.js";
import { Store } from "../store.js";
import { standInKeys } from "./backup-keys.js";
import { tempDir } from "./helpers.js";

const restoreScript = process.env.POBOTS_RESTORE_SCRIPT ?? fileURLToPath(new URL("../../scripts/restore.mjs", import.meta.url));
const keys = standInKeys();

interface Entry {
  name: string;
  /** "0" file (default), "1" hard link, "2" link, "5" folder, "6" fifo. */
  type?: string;
  mode?: number;
  link?: string;
  data?: string | Buffer;
}

/** One ustar header, written by hand so any name, type and link can be in it. */
function header(e: Entry, size: number): Buffer {
  const b = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => b.write(s, off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(e.name, 0, 100);
  put(oct(e.mode ?? (e.type === "5" ? 0o755 : 0o644), 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  b.fill(0x20, 148, 156);
  put(e.type ?? "0", 156, 1);
  put(e.link ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const x of b) sum += x;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return b;
}

function tarOf(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const isFile = (e.type ?? "0") === "0";
    parts.push(header(e, isFile ? data.length : 0));
    if (isFile && data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A small database that passes the integrity check. */
function dbBytes(): Buffer {
  const path = join(tempDir("pobots-rs-db-"), "pobots.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('from the backup');");
  db.close();
  return readFileSync(path);
}
const DB = dbBytes();
const MANIFEST = JSON.stringify({ kind: "pobots-backup-manifest", format: 1, bots: [], counts: { threads: 0, items: 0 } });

/** The top of a backup as the engine makes it. */
const base = (): Entry[] => [
  { name: "pobots.db", data: DB },
  { name: "config.json", data: "{}\n" },
  { name: "manifest.json", data: MANIFEST },
];

/** The entries as a locked backup file, the way the engine locks one. */
async function locked(entries: Entry[]): Promise<string> {
  const file = join(tempDir("pobots-rs-file-"), "pobots-backup-2026-11-14T0300.pobotsbackup");
  const info = parsePublicKeyLine(keys.publicLine);
  await pipeline(
    Readable.from([gzipSync(tarOf(entries))]),
    lockStream(info.key, info.fingerprint, { createdAt: "2026-11-14T02:00:00Z", engineVersion: "0.1.0", protocol: 12, contents: "tar+gzip", file: basename(file) }),
    createWriteStream(file),
  );
  return file;
}

const restore = (args: string[]) => spawnSync(process.execPath, [restoreScript, ...args], { input: keys.openssh, encoding: "utf8", timeout: 60_000 });

/** A stopped Pobots on temporary folders, with something of its own in both. */
function target() {
  const dataDir = tempDir("pobots-restored-data-");
  const home = tempDir("pobots-restored-home-");
  const botsDir = join(home, "bots");
  mkdirSync(join(botsDir, "old"), { recursive: true });
  writeFileSync(join(botsDir, "old", "AGENTS.md"), "was here before");
  writeFileSync(join(dataDir, "pobots.db"), "an old database");
  writeFileSync(join(dataDir, "config.json"), "{}");
  const look = () => ({ data: readdirSync(dataDir).sort(), home: readdirSync(home).sort(), bots: readdirSync(botsDir).sort(), db: readFileSync(join(dataDir, "pobots.db"), "utf8"), agents: readFileSync(join(botsDir, "old", "AGENTS.md"), "utf8") });
  return { dataDir, home, botsDir, look, args: ["--folders", `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`] };
}

describe("restore.mjs: what it unpacks", () => {
  const hostile: [string, Entry[], RegExp][] = [
    ["a full path", [...base(), { name: "/tmp/pobots-evil.txt", data: "x" }], /an entry with a full path/],
    ["a path that climbs out", [...base(), { name: "bots/kaja/../../evil.txt", data: "x" }], /points outside its own folder/],
    ["a path that starts with ..", [...base(), { name: "../evil.txt", data: "x" }], /points outside its own folder/],
    ["a link at the top level", [...base(), { name: "evil", type: "2", link: "/etc" }], /a link at its top level/],
    ["a hard link at the top level", [...base(), { name: "evil", type: "1", link: "pobots.db" }], /a link at its top level/],
    ["the database as a link", [{ name: "pobots.db", type: "2", link: "/etc/hosts" }, { name: "manifest.json", data: MANIFEST }], /database is not a plain file/],
    ["the database as a folder", [{ name: "pobots.db", type: "5" }, { name: "pobots.db/x", data: "x" }, { name: "manifest.json", data: MANIFEST }], /database is not a plain file/],
    ["the settings as a fifo", [{ name: "pobots.db", data: DB }, { name: "config.json", type: "6" }, { name: "manifest.json", data: MANIFEST }], /settings file is not a plain file/],
    ["the settings as a hard link", [{ name: "pobots.db", data: DB }, { name: "config.json", type: "1", link: "pobots.db" }, { name: "manifest.json", data: MANIFEST }], /settings file is not a plain file/],
    ["bots as a link", [...base(), { name: "bots", type: "2", link: "/tmp" }, { name: "bots/kaja/AGENTS.md", data: "x" }], /bots folder is not a plain folder/],
    ["a link in place of a bot's folder", [...base(), { name: "bots/kaja", type: "2", link: "/tmp" }], /a link in place of a bot's folder/],
    ["an entry inside a link", [...base(), { name: "bots/kaja/out", type: "2", link: "/tmp" }, { name: "bots/kaja/out/evil.txt", data: "x" }], /an entry inside a link/],
    ["a hard link out of the bots folder", [...base(), { name: "bots/kaja/h", type: "1", link: "pobots.db" }], /a hard link to something outside its bots folder/],
    ["a hard link that climbs out", [...base(), { name: "bots/kaja/h", type: "1", link: "bots/../../etc/passwd" }], /a hard link to something outside its bots folder/],
    ["a hard link to something not in the backup", [...base(), { name: "bots/kaja/h", type: "1", link: "bots/kaja/nothing" }], /a hard link to something outside its bots folder/],
    ["a device", [...base(), { name: "bots/kaja/dev", type: "3" }], /not a file, folder or link/],
    ["the same entry twice", [...base(), { name: "bots/kaja/a.md", data: "1" }, { name: "bots/kaja/a.md", data: "2" }], /the same entry twice/],
  ];
  for (const [what, entries, sentence] of hostile) {
    test(`refuses ${what}, and nothing is written`, async () => {
      const file = await locked(entries);
      const t = target();
      const before = t.look();
      const r = restore([...t.args, file]);
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, sentence);
      assert.match(r.stderr, /Nothing was restored\.\n$/);
      assert.deepEqual(t.look(), before, "the target folders are as they were");
      assert.ok(!existsSync("/tmp/pobots-evil.txt"));
      const c = restore(["--check", file]);
      assert.equal(c.status, 2, "--check refuses it too");
      assert.match(c.stderr, sentence);
    });
  }

  test("a link inside a bot's folder is put back as a link and never followed; a hard link inside the bots folder is fine", async () => {
    const outside = join(tempDir("pobots-outside-"), "secret.txt");
    writeFileSync(outside, "outside the backup");
    const file = await locked([
      ...base(),
      { name: "bots/kaja", type: "5" },
      { name: "bots/kaja/AGENTS.md", data: "the job" },
      { name: "bots/kaja/secret-link", type: "2", link: outside },
      { name: "bots/kaja/up", type: "2", link: "../../somewhere" },
      { name: "bots/kaja/AGENTS-copy.md", type: "1", link: "bots/kaja/AGENTS.md" },
    ]);
    assert.equal(restore(["--check", file]).status, 0);
    const t = target();
    const r = restore([...t.args, file]);
    assert.equal(r.status, 0, r.stderr);
    const link = join(t.botsDir, "kaja", "secret-link");
    assert.ok(lstatSync(link).isSymbolicLink(), "still a link");
    assert.equal(readlinkSync(link), outside, "its target unchanged");
    assert.equal(readlinkSync(join(t.botsDir, "kaja", "up")), "../../somewhere");
    assert.equal(readFileSync(outside, "utf8"), "outside the backup");
    assert.equal(readFileSync(join(t.botsDir, "kaja", "AGENTS-copy.md"), "utf8"), "the job");
    assert.ok(lstatSync(join(t.dataDir, "pobots.db")).isFile());
  });
  test("format 1 restores links inside a bot as links and never follows them", async () => {
    const outside = join(tempDir("pobots-outside-"), "fixture.txt");
    writeFileSync(outside, "outside the backup");
    const file = await locked([
      ...base(),
      { name: "bots/kaja/bot.json", data: "{}" },
      { name: "bots/kaja/notes/a.md", data: "a note" },
      { name: "bots/kaja/secret-link", type: "2", link: outside },
      { name: "bots/kaja/notes-link", type: "2", link: "notes" },
      { name: "bots/kaja/a-again.md", type: "1", link: "bots/kaja/notes/a.md" },
    ]);
    const c = restore(["--check", file]);
    assert.equal(c.status, 0, c.stderr);
    const t = target();
    const r = restore([...t.args, file]);
    assert.equal(r.status, 0, r.stderr);
    const back = join(t.botsDir, "kaja");
    assert.ok(lstatSync(join(back, "secret-link")).isSymbolicLink());
    assert.equal(readlinkSync(join(back, "secret-link")), outside);
    assert.ok(lstatSync(join(back, "notes-link")).isSymbolicLink());
    assert.equal(readlinkSync(join(back, "notes-link")), "notes");
    assert.equal(readFileSync(join(back, "a-again.md"), "utf8"), "a note");
    assert.ok(statSync(join(back, "notes", "a.md")).isFile());
  });
});

describe("restore.mjs: a copy that fails halfway", () => {
  test("a bots copy that fails partway: the half copy is removed, what was there is back, and the message names the folders", async () => {
    // A file the copy cannot read (mode 000) after many it can: the bots folder is half made when it fails.
    const many: Entry[] = Array.from({ length: 30 }, (_, i) => ({ name: `bots/kaja/aaa/${String(i).padStart(2, "0")}.md`, data: `note ${i}` }));
    const file = await locked([...base(), ...many, { name: "bots/kaja/zzz/locked.md", data: "cannot be read", mode: 0 }]);
    const t = target();
    const before = t.look();
    const r = restore([...t.args, file]);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^The backup could not be put in place\. Copying the backup's bots into .* failed: permission denied\./m);
    assert.ok(r.stderr.includes(t.botsDir), "names the bots folder");
    assert.match(r.stderr, /What was there is back where it was: /);
    assert.ok(r.stderr.includes(join(t.dataDir, "pobots.db")), "names the database it put back");
    assert.doesNotMatch(r.stderr, /Could not restore/);
    assert.deepEqual(t.look(), before, "the old database and bots are back, nothing else is left");
  });

  test("a destination that may not be written: the database already copied is taken out again and the old one put back", async () => {
    const file = await locked([...base(), { name: "bots/kaja/AGENTS.md", data: "the job" }]);
    const dataDir = tempDir("pobots-restored-data-");
    const home = tempDir("pobots-restored-home-");
    const botsDir = join(home, "bots");
    writeFileSync(join(dataDir, "pobots.db"), "an old database");
    chmodSync(home, 0o555);
    try {
      const r = restore(["--folders", `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`, file]);
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /permission denied/);
      assert.ok(r.stderr.includes(botsDir));
      assert.match(r.stderr, /What was there is back where it was: /);
      assert.equal(readFileSync(join(dataDir, "pobots.db"), "utf8"), "an old database");
      assert.deepEqual(readdirSync(dataDir), ["pobots.db"], "no folder of old things is left behind");
      assert.deepEqual(readdirSync(home), []);
    } finally {
      chmodSync(home, 0o755);
    }
  });

  test("putting back what was there that fails is said, folder by folder, and is not called whole", async () => {
    const mod = await import(pathToFileURL(restoreScript).href);
    const dataDir = tempDir("pobots-restored-data-");
    const home = tempDir("pobots-restored-home-");
    const from = tempDir("pobots-rs-from-");
    writeFileSync(join(from, "pobots.db"), "new");
    mkdirSync(join(from, "bots", "kaja"), { recursive: true });
    writeFileSync(join(from, "bots", "kaja", "locked.md"), "x");
    chmodSync(join(from, "bots", "kaja", "locked.md"), 0);
    writeFileSync(join(dataDir, "pobots.db"), "old");
    mkdirSync(join(home, "bots"));
    writeFileSync(join(home, "bots", "AGENTS.md"), "old bots");
    const botsDir = join(home, "bots");
    // The bots copy fails (a file it cannot read), and moving the old bots folder back fails too.
    const real = fs.renameSync;
    fs.renameSync = ((a: string, b: string) => {
      if (String(a).includes(".before-restore-")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return real(a, b);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => mod.putInPlace({ what: "the given folders", mode: "folders", dataDir, botsDir }, from),
        (err: Error & { whole?: boolean }) => {
          assert.equal(err.whole, false);
          assert.match(err.message, /^The backup could not be put in place\. Copying the backup's bots into .* failed: permission denied\. Putting back what was there did not fully work: /);
          assert.ok(err.message.includes(`${botsDir} could not be put back, it is still in ${botsDir}.before-restore-`), err.message);
          assert.ok(!err.message.includes(`${join(dataDir, "pobots.db")} could not`), "the database did go back");
          return true;
        },
      );
    } finally {
      fs.renameSync = real;
      syncBuiltinESMExports();
      chmodSync(join(from, "bots", "kaja", "locked.md"), 0o644);
    }
    assert.equal(readFileSync(join(dataDir, "pobots.db"), "utf8"), "old", "the database is back");
    assert.ok(!existsSync(botsDir), "the half copy is gone");
    const aside = readdirSync(home).find((n) => n.startsWith("bots.before-restore-"));
    assert.equal(readFileSync(join(home, aside!, "AGENTS.md"), "utf8"), "old bots", "the old bots are where the message says");
  });

  test("after a failure in a stopped service, it says whether the service was started again", async () => {
    const mod = await import(pathToFileURL(restoreScript).href);
    const t = { what: "the test copy" };
    const whole = new mod.PutFailed("x", true);
    const broken = new mod.PutFailed("x", false);
    let starts = 0;
    const start = async () => {
      starts++;
    };
    assert.equal(await mod.serviceAfterFailure(t, whole, true, start), "The test copy was started again on what was there before.");
    assert.equal(starts, 1);
    assert.match(await mod.serviceAfterFailure(t, broken, true, start), /^The test copy was not started again, because what was there is not all back in place\./);
    assert.equal(starts, 1, "never started on half the data");
    assert.equal(await mod.serviceAfterFailure(t, whole, false, start), "The test copy was not running before, so it was not started again.");
    assert.equal(
      await mod.serviceAfterFailure(t, whole, true, async () => {
        throw new Error("launchd would not start the test copy: no reason");
      }),
      "The test copy was not started again: launchd would not start the test copy: no reason",
    );
  });
});
