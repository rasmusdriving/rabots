#!/usr/bin/env node
// Groundwork for the nightly backup (job 5, docs/build/notes-backup-groundwork.md). One whole night
// on harmless ground: copies the TEST copy's database and bot folders to a temporary folder (reads
// them only), takes a consistent database snapshot, packs and locks it to a stand-in RSA key made
// here with ssh-keygen, unlocks it with the private key on stdin, compares, and tries the ways a
// file can be damaged. Deletes its temporary folder, keys included, at the end.
//
//   node scripts/dev/backup-trial.mjs            (Homebrew Node)
//   ELECTRON_RUN_AS_NODE=1 <Electron> scripts/dev/backup-trial.mjs   (the engine's own Node)
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { lockStream, parsePublicKeyLine, readHeader, readPrivateKey } from "./backup-lock.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const testData = join(homedir(), "Library", "Application Support", "Pobots-test");
const testBots = join(homedir(), "Pobots-test", "bots");
const tmp = mkdtempSync(join(tmpdir(), "pobots-backup-trial-"));
const ms = (t) => `${Date.now() - t} ms`;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const node = process.execPath;
const env = { ...process.env };

console.log(`node ${process.versions.node}, openssl ${process.versions.openssl}, tmp ${tmp}`);
try {
  // 1. Copies of the test copy's files (read only from the test copy).
  const src = join(tmp, "src");
  mkdirSync(join(src, "data"), { recursive: true });
  for (const f of ["pobots.db", "pobots.db-wal", "pobots.db-shm", "config.json"]) if (existsSync(join(testData, f))) copyFileSync(join(testData, f), join(src, "data", f));
  cpSync(testBots, join(src, "bots"), { recursive: true });

  // 2. A consistent snapshot of the database, two ways.
  const db = new DatabaseSync(join(src, "data", "pobots.db"));
  db.exec("PRAGMA journal_mode = WAL");
  const stage = join(tmp, "stage");
  mkdirSync(stage);
  let t = Date.now();
  db.exec(`VACUUM INTO '${join(tmp, "vacuum.db").replaceAll("'", "''")}'`);
  console.log(`VACUUM INTO: ${ms(t)}, ${statSync(join(tmp, "vacuum.db")).size} bytes`);
  t = Date.now();
  const pages = await backup(db, join(stage, "pobots.db"));
  console.log(`sqlite backup(): ${ms(t)}, ${pages} pages, ${statSync(join(stage, "pobots.db")).size} bytes (db+wal were ${statSync(join(src, "data", "pobots.db")).size}+${existsSync(join(src, "data", "pobots.db-wal")) ? statSync(join(src, "data", "pobots.db-wal")).size : 0})`);
  const count = (path) => {
    const d = new DatabaseSync(path, { readOnly: true });
    const r = { threads: d.prepare("SELECT count(*) n FROM threads").get().n, items: d.prepare("SELECT count(*) n FROM items").get().n, integrity: d.prepare("PRAGMA integrity_check").get().integrity_check };
    d.close();
    return r;
  };
  db.close();
  const before = count(join(stage, "pobots.db"));
  console.log(`snapshot: ${JSON.stringify(before)}; vacuum copy: ${JSON.stringify(count(join(tmp, "vacuum.db")))}`);
  copyFileSync(join(src, "data", "config.json"), join(stage, "config.json"));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ kind: "pobots-backup", createdAt: new Date().toISOString(), bots: "bots/" }, null, 2));

  // 3. Stand-in keys, as the person would make in 1Password (RSA 4096) and the kind refused (Ed25519).
  const keys = join(tmp, "keys");
  mkdirSync(keys, { mode: 0o700 });
  sh("ssh-keygen", ["-q", "-t", "rsa", "-b", "4096", "-m", "PKCS8", "-N", "", "-C", "stand-in", "-f", join(keys, "rsa")]);
  sh("ssh-keygen", ["-q", "-t", "rsa", "-b", "4096", "-N", "", "-C", "stand-in-openssh", "-f", join(keys, "rsa-openssh")]);
  sh("ssh-keygen", ["-q", "-t", "rsa", "-b", "2048", "-m", "PKCS8", "-N", "", "-f", join(keys, "rsa2048")]);
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keys, "ed")]);
  const pubLine = readFileSync(join(keys, "rsa.pub"), "utf8");
  const parsed = parsePublicKeyLine(pubLine);
  const sshFp = sh("ssh-keygen", ["-l", "-E", "sha256", "-f", join(keys, "rsa.pub")]).split(" ")[1];
  console.log(`public key: ${parsed.type} ${parsed.bits} bits, fingerprint ${parsed.fingerprint}; ssh-keygen says ${sshFp}: ${parsed.fingerprint === sshFp ? "same" : "DIFFERENT"}`);
  for (const [what, line] of [
    ["ed25519", readFileSync(join(keys, "ed.pub"), "utf8")],
    ["rsa 2048", readFileSync(join(keys, "rsa2048.pub"), "utf8")],
    ["cut short", pubLine.slice(0, 300)],
    ["private key pasted", "-----BEGIN PRIVATE KEY----- MIIE..."],
    ["one character changed at the start", pubLine.replace(/AAAA(.)/, (m, c) => "AAAA" + (c === "B" ? "C" : "B"))],
    ["one character changed in the middle", pubLine.slice(0, 400) + (pubLine[400] === "A" ? "B" : "A") + pubLine.slice(401)],
    ["line breaks and spaces", "  " + pubLine.replace(/(.{60})/g, "$1\n") + "  "],
  ]) {
    try {
      const p = parsePublicKeyLine(line);
      console.log(`  paste "${what}": accepted, ${p.fingerprint === parsed.fingerprint ? "same key" : "other key " + p.fingerprint}`);
    } catch (e) {
      console.log(`  paste "${what}": refused: ${e.message}`);
    }
  }
  // Which private key formats node:crypto reads (the openssh one through the small parser).
  for (const f of ["rsa", "rsa-openssh"]) {
    const k = readPrivateKey(readFileSync(join(keys, f), "utf8"));
    const same = createPublicKey(k).export({ format: "jwk" }).n === parsePublicKeyLine(readFileSync(join(keys, f + ".pub"), "utf8")).key.export({ format: "jwk" }).n;
    console.log(`  private key ${f} (${readFileSync(join(keys, f), "utf8").split("\n")[0]}): read, matches its public key: ${same}`);
  }
  try {
    // macOS's ssh-keygen cannot write an Ed25519 key as PKCS#8, so node:crypto makes one.
    const k = (await import("node:crypto")).generateKeyPairSync("ed25519").privateKey;
    console.log(`  ed25519 PKCS8 private key reads as ${k.asymmetricKeyType}; publicEncrypt with it:`);
    (await import("node:crypto")).publicEncrypt(createPublicKey(k), Buffer.alloc(32));
    console.log("  ... worked (unexpected)");
  } catch (e) {
    console.log(`  ... refused: ${e.message.split("\n")[0]}`);
  }

  // 4. Pack and lock, streaming: tar | gzip | lock -> file.
  const out = join(tmp, "out");
  mkdirSync(out);
  const file = join(out, `pobots-backup-${new Date().toISOString().slice(0, 10)}.pobotsbackup`);
  t = Date.now();
  const tar = spawn("tar", ["-czf", "-", "--exclude", "node_modules", "--exclude", ".DS_Store", "--exclude", "*.pobots-tmp", "-C", stage, "pobots.db", "config.json", "manifest.json", "-C", src, "bots"], { stdio: ["ignore", "pipe", "inherit"] });
  await pipeline(tar.stdout, lockStream(parsed.key, parsed.fingerprint, { createdAt: new Date().toISOString(), engineVersion: "trial", contents: "tar+gzip" }), createWriteStream(file));
  console.log(`locked: ${ms(t)}, ${statSync(file).size} bytes; header: ${JSON.stringify({ ...readHeader(readFileSync(file)), wrappedKey: "(" + readHeader(readFileSync(file)).wrappedKey.length + " chars)" })}`);

  // 5. Unlock with the private key on stdin, as the restore script will.
  const unlock = (f, keyFile, to) => {
    try {
      return { ok: true, err: sh("sh", ["-c", `"$0" "$1" "$2" "$3" < "$4" 2>&1`, node, join(here, "backup-unlock.mjs"), f, to, keyFile], { env }) };
    } catch (e) {
      return { ok: false, err: String(e.stdout || e.message).trim() };
    }
  };
  t = Date.now();
  const back = join(tmp, "back");
  const r = unlock(file, join(keys, "rsa"), back);
  console.log(`unlocked: ${r.ok} in ${ms(t)}: ${r.err.trim().replace(/\n/g, " | ")}`);
  const diff = (() => {
    try {
      sh("diff", ["-r", join(src, "bots"), join(back, "bots")]);
      return "bots folders identical";
    } catch (e) {
      return "bots DIFFER: " + String(e.stdout).slice(0, 300);
    }
  })();
  console.log(`compare: db ${sha(join(stage, "pobots.db")) === sha(join(back, "pobots.db")) ? "identical" : "DIFFERENT"}, config ${sha(join(stage, "config.json")) === sha(join(back, "config.json")) ? "identical" : "DIFFERENT"}, ${diff}`);
  console.log(`restored db: ${JSON.stringify(count(join(back, "pobots.db")))}`);
  const r2 = unlock(file, join(keys, "rsa-openssh"), join(tmp, "back2"));
  console.log(`unlock with the OpenSSH-format key of another pair: ${r2.ok ? "opened (WRONG)" : "refused: " + r2.err.split("\n").pop()}`);

  // 6. Damage: one byte changed in the middle, cut off at the end, a whole frame dropped.
  const whole = readFileSync(file);
  const variants = {
    "one byte changed": (() => {
      const b = Buffer.from(whole);
      b[Math.floor(b.length / 2)] ^= 1;
      return b;
    })(),
    "last 100 bytes cut off": whole.subarray(0, whole.length - 100),
    "header edited": Buffer.from(whole.toString("latin1").replace('"engineVersion":"trial"', '"engineVersion":"trail"'), "latin1"),
  };
  for (const [what, buf] of Object.entries(variants)) {
    const f = join(out, "damaged");
    writeFileSync(f, buf);
    const d = unlock(f, join(keys, "rsa"), join(tmp, "damaged-out"));
    console.log(`  ${what}: ${d.ok ? "OPENED (WRONG)" : "refused: " + d.err.split("\n").pop()}`);
    rmSync(join(tmp, "damaged-out"), { recursive: true, force: true });
  }

  // 7. Speed on a bigger made-up load (40 MB of mixed text and random bytes), to scale up from.
  const big = join(tmp, "big");
  mkdirSync(big);
  for (let i = 0; i < 40; i++) writeFileSync(join(big, `f${i}.txt`), Buffer.concat([Buffer.from("chat text ".repeat(50_000)), (await import("node:crypto")).randomBytes(500_000)]));
  t = Date.now();
  const tar2 = spawn("tar", ["-czf", "-", "-C", tmp, "big"], { stdio: ["ignore", "pipe", "inherit"] });
  await pipeline(tar2.stdout, lockStream(parsed.key, parsed.fingerprint, {}), createWriteStream(join(out, "big.pobotsbackup")));
  console.log(`40 MB made-up load: packed and locked in ${ms(t)}, ${statSync(join(out, "big.pobotsbackup")).size} bytes`);
  // A file of many frames cut exactly after a whole frame: only the "last frame" mark can tell.
  const bigBuf = readFileSync(join(out, "big.pobotsbackup"));
  const hlen = bigBuf.readUInt32BE(9);
  let at = 13 + hlen;
  for (let i = 0; i < 3; i++) at += 4 + bigBuf.readUInt32BE(at) + 16;
  writeFileSync(join(out, "cut"), bigBuf.subarray(0, at));
  t = Date.now();
  const full = unlock(join(out, "big.pobotsbackup"), join(keys, "rsa"), join(tmp, "big-back"));
  console.log(`  40 MB file unlocked: ${full.ok} in ${ms(t)}; same files: ${(() => { try { sh("diff", ["-r", big, join(tmp, "big-back", "big")]); return true; } catch { return false; } })()}`);
  const cut = unlock(join(out, "cut"), join(keys, "rsa"), join(tmp, "cut-back"));
  console.log(`  cut right after frame 3 of ${Math.ceil(bigBuf.length / (1024 * 1024))}: ${cut.ok ? "OPENED (WRONG)" : "refused: " + cut.err.split("\n").pop()}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`removed ${tmp}: ${existsSync(tmp) ? "STILL THERE" : "gone"}`);
}
