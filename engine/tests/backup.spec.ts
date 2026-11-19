import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupConfig, defaultBackupFolder, defaultDataDir, legacyOneDrive } from "../config.js";
import { Backup, slotAtOrBefore } from "../core/backup-restic.js";
import { claimFolder, MAX_FILE_BYTES, OTHER_OWNER, OWNER_FILE, repositoryFiles } from "../core/backup-restic-files.js";
import { findRestic, parseSnapshots, restic, STAGE_NAME } from "../core/restic-cli.js";
import { Store } from "../store.js";
import { tempDir } from "./helpers.js";

const ref = "op://Example/Pobots test/password";
const executable = findRestic();
const start = Date.parse("2026-11-18T02:00:04Z");
const day = 86_400_000;
const restoreScript = process.env.POBOTS_RESTORE_SCRIPT ?? fileURLToPath(new URL("../../scripts/restore.mjs", import.meta.url));

function fixture(opts: { installed?: boolean; reference?: boolean } = {}) {
  const root = tempDir("pobots-restic-");
  const dataDir = join(root, "data");
  const botsDir = join(root, "bots");
  const folder = join(root, "restic");
  mkdirSync(dataDir);
  mkdirSync(join(botsDir, "example"), { recursive: true });
  const store = new Store(join(dataDir, "pobots.db"));
  const password = randomBytes(24).toString("hex");
  const clock = { now: start };
  const cards: string[] = [];
  const make = (snapshotDb = (p: string): Promise<unknown> => store.snapshotTo(p)) => new Backup({
    dataDir, botsDir, engineVersion: "0.36.0",
    config: { folder, time: "03:00", passwordRef: opts.reference === false ? undefined : ref,
      passwordRefSavedAt: new Date(start - day).toISOString(),
      executable: opts.installed === false ? join(root, "not-installed") : executable },
    clock: () => clock.now, tz: "Europe/Stockholm", readPassword: async (wanted) => wanted === ref ? password : undefined,
    host: { snapshotDb, bots: () => [{ id: "example", name: "Example" }], changed: () => {}, showCard: (title) => cards.push(title), clearCard: () => { cards.length = 0; } },
  });
  const list = async () => parseSnapshots(await restic({ executable: executable!, folder, password, args: ["snapshots", "--json", "--tag", "pobots"] }));
  return { root, dataDir, botsDir, folder, store, password, clock, cards, make, list };
}

describe("restic backup", () => {
  test("the 03:00 slot follows Stockholm time around both daylight saving transitions", () => {
    const slot = (now: string) => new Date(slotAtOrBefore(Date.parse(now), "03:00", "Europe/Stockholm")).toISOString();
    assert.equal(slot("2026-11-18T01:59:59.999Z"), "2026-11-17T02:00:00.000Z");
    assert.equal(slot("2027-03-28T01:00:00Z"), "2027-03-28T01:00:00.000Z");
    assert.equal(slot("2026-10-25T02:00:00Z"), "2026-10-25T02:00:00.000Z");
  });

  test("migration keeps the legacy key readable, clears the reference and refuses the real folder for other copies", () => {
    const legacy = { folder: join(legacyOneDrive(), "Pobot"), publicKey: "old public key", passwordRef: ref, time: "04:00" };
    assert.deepEqual(backupConfig(defaultDataDir(), legacy), {
      folder: defaultBackupFolder(), publicKey: "old public key", passwordRef: undefined, passwordRefSavedAt: undefined, time: "04:00", migrated: true,
    });
    const other = tempDir();
    assert.ok(backupConfig(other, { folder: defaultBackupFolder() }).folderProblem);
    assert.ok(backupConfig(other, { folder: join(defaultBackupFolder(), "test") }).folderProblem);
    assert.notEqual(backupConfig(other, legacy).folder, defaultBackupFolder());
    const alias = join(other, "alias");
    symlinkSync(defaultBackupFolder(), alias);
    assert.ok(backupConfig(other, { folder: alias }).folderProblem || !existsSync(defaultBackupFolder()));
  });

  test("no restic or reference means no scheduled run, no card and no repository", () => {
    const w = fixture({ installed: false, reference: false });
    try {
      const b = w.make();
      assert.throws(() => b.setPasswordRef("not-a-reference"), /Use a 1Password reference/);
      assert.equal(b.state().passwordRef, undefined);
      assert.equal(b.setPasswordRef(ref).passwordRef, ref);
      assert.throws(() => b.runNow(), /Install restic/);
      for (const t of [start, start + 3 * day]) b.tick(t);
      assert.deepEqual(w.cards, []);
      assert.equal(existsSync(w.folder), false);
      assert.equal(b.setPasswordRef("").passwordRef, undefined);
      assert.ok(!readFileSync(join(w.dataDir, "config.json"), "utf8").includes(w.password));
    } finally { w.store.close(); }
  });

  test("owner notes refuse another Pobots and do not adopt a nonempty folder", async () => {
    const w = fixture();
    try {
      await claimFolder(w.folder, w.dataDir);
      await assert.rejects(claimFolder(w.folder, w.botsDir), { message: OTHER_OWNER });
      assert.ok(existsSync(join(w.folder, OWNER_FILE)));
      const notOurs = join(w.root, "other");
      mkdirSync(notOurs);
      writeFileSync(join(notOurs, "config"), "not ours");
      await assert.rejects(claimFolder(notOurs, w.dataDir), /already contains files/);
      assert.equal(readFileSync(join(notOurs, "config"), "utf8"), "not ours");
    } finally { w.store.close(); }
  });

  test("incremental snapshots restore SQLite, hidden bot files and links while leaving out large and partial files", { skip: !executable && "restic not installed" }, async () => {
    const w = fixture();
    const bot = join(w.botsDir, "example");
    for (const name of [".git", ".archive", ".attachments", "node_modules"]) {
      mkdirSync(join(bot, name));
      writeFileSync(join(bot, name, "note"), name);
    }
    writeFileSync(join(bot, "note"), "before");
    writeFileSync(join(bot, "large[1]"), "");
    truncateSync(join(bot, "large[1]"), MAX_FILE_BYTES + 1);
    writeFileSync(join(bot, "half.pobots-tmp"), "exclude");
    symlinkSync("note", join(bot, "link"));
    try {
      const b = w.make();
      b.tick(w.clock.now);
      await b.idle();
      const first = b.state().history[0];
      assert.equal(first?.status, "unconfirmed", first?.problem);
      assert.ok(first.snapshot && first.bytes);
      assert.deepEqual(first.leftOut, ["example/large[1]"]);
      assert.equal(b.due(w.clock.now), false);
      writeFileSync(join(bot, "note"), "after");
      w.clock.now += day;
      b.tick(w.clock.now);
      await b.idle();
      const second = b.state().history[0];
      assert.equal(second?.status, "unconfirmed", second?.problem);
      assert.ok(second.bytes && second.bytes < first.bytes);
      assert.equal(b.state().snapshots, 2);
      assert.equal(existsSync(join(w.dataDir, STAGE_NAME)), false);
      assert.equal((await w.list()).length, 2);

      const restoreTo = join(w.root, "restore");
      const restored = spawnSync(process.execPath, [restoreScript, "--folders", `--data-dir=${join(restoreTo, "data")}`, `--bots-dir=${join(restoreTo, "bots")}`, `--snapshot=${first.snapshot}`, w.folder],
        { env: { ...process.env, RESTIC_PASSWORD: w.password }, encoding: "utf8" });
      assert.equal(restored.status, 0, restored.stderr);
      const oldBot = join(restoreTo, "bots", "example");
      assert.ok(lstatSync(join(oldBot, "link")).isSymbolicLink());
      assert.equal(readlinkSync(join(oldBot, "link")), "note");
      assert.equal(readFileSync(join(oldBot, "link"), "utf8"), "before");
      for (const name of [".git", ".archive", ".attachments"]) assert.equal(readFileSync(join(oldBot, name, "note"), "utf8"), name);
      for (const name of ["node_modules", "large[1]", "half.pobots-tmp"]) assert.equal(existsSync(join(oldBot, name)), false, name);
      assert.ok(existsSync(join(restoreTo, "data", "pobots.db")));
      assert.ok(!readFileSync(join(w.dataDir, "backup.json"), "utf8").includes(w.password));
    } finally { w.store.close(); }
  });

  test("retention prunes old nightly snapshots without counting manual snapshots against the 14 nights", { skip: !executable ? "restic not installed" : process.env.POBOTS_RESTIC_RETENTION_TEST !== "1" && "standalone real restic retention test" }, async () => {
    const w = fixture();
    try {
      const b = w.make();
      b.tick(w.clock.now);
      await b.idle();
      assert.equal(b.state().snapshots, 1, b.state().history[0]?.problem);
      const seed = join(w.root, "seed.txt");
      writeFileSync(seed, "unchanged seed");
      for (let i = 15; i > 0; i--) {
        const when = new Date(start - i * day).toISOString().slice(0, 19).replace("T", " ");
        await restic({ executable: executable!, folder: w.folder, password: w.password,
          args: ["backup", "--quiet", "--time", when, "--tag", `pobots,${i === 1 ? "manual" : "nightly"}`, seed] });
      }
      w.clock.now += day;
      b.tick(w.clock.now);
      await b.idle();
      const after = await w.list();
      assert.equal(after.filter((s) => s.tags?.includes("nightly")).length, 14, b.state().history[0]?.problem);
      assert.equal(after.filter((s) => s.tags?.includes("manual")).length, 1);
      assert.equal(b.state().snapshots, 15);
    } finally { w.store.close(); }
  });

  test("an interrupted SQLite stage is resumed once; an iCloud conflict is reported without writing to it", { skip: !executable && "restic not installed" }, async () => {
    const w = fixture();
    try {
      let entered!: () => void;
      let resume!: () => void;
      const staging = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { resume = resolve; });
      const before = w.make(async () => { entered(); await blocked; });
      before.tick(w.clock.now);
      await staging;
      const stopped = before.stop();
      resume();
      assert.ok(await stopped);
      const after = w.make();
      after.tick(w.clock.now);
      await after.idle();
      assert.equal(after.state().snapshots, 1, after.state().history[0]?.problem);
      assert.equal(after.due(w.clock.now), false);
      assert.equal((await w.list()).length, 1);
      const copy = join(w.folder, "config 2");
      writeFileSync(copy, "conflicting copy");
      await assert.rejects(repositoryFiles(w.folder), /iCloud copies/);
      w.clock.now += day;
      after.tick(w.clock.now);
      await after.idle();
      assert.match(after.state().history[0]?.problem ?? "", /iCloud copies/);
      assert.equal(w.cards[0], "Last night's backup failed");
      assert.equal(readFileSync(copy, "utf8"), "conflicting copy");
    } finally { w.store.close(); }
  });
});
