#!/usr/bin/env node
// Restores a Pobots backup (docs/build/step-backup.md). The private key comes on standard input only,
// never as a file path or an argument, and is kept in memory only:
//
//   op read "op://<vault>/<item>/private key" | node scripts/restore.mjs --check <file>
//   op read "op://<vault>/<item>/private key" | node scripts/restore.mjs --test-copy <file>
//   op read "op://<vault>/<item>/private key" | node scripts/restore.mjs --real <file>
//   op read "op://<vault>/<item>/private key" | node scripts/restore.mjs --folders --data-dir=<dir> --bots-dir=<dir> <file>
//
// --check      unlocks the whole file to nowhere: proves the key opens it and every part is whole.
// --test-copy  stops the test copy (app.pobots.engine-test), moves its database and bots aside, puts
//              the backup's in place, starts it and checks the bots and chats. Its own config.json
//              stays. Takes no folders: it only ever restores the test copy.
// --real       the same for the real Pobots (app.pobots.engine), with the backup's config.json. Only
//              after a typed confirmation (on the terminal, or --confirm="replace my Pobots").
// --folders    puts the backup into a stopped Pobots on other folders, without any service. Never the
//              real or the test copy's folders. For trials and checks.
//
// It refuses to run when standard input is a terminal, and refuses a backup made by a newer engine
// than the one that would run it. Nothing is deleted: what was there is moved aside, and the script
// says where. Before anything is unpacked the archive is listed and refused when it holds what a
// Pobots backup never does (checkEntries); links inside a bot's folder are put back as links, never
// followed. When putting the backup in place fails, half copies are removed, every move is undone and
// checked, and the script names the folders, what failed and whether a stopped service was started.
//
// For restic, pass the repository folder with --password-ref="op://<vault>/<item>/password"
// and optionally --snapshot=<id> (default latest). --check lists completed snapshots.
// Needs Node 22.18 or newer (it imports engine/backup-format.ts with Node's own type stripping).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { chooseSnapshot, openRepository, unpackSnapshot } from "./restore-restic.mjs";
import { BackupFormatError, fingerprintOfKey, MAX_HEADER, readHeader, readPrivateKey, unlockStream } from "../engine/backup-format.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const CONFIRM = "replace my Pobots";

export const TARGETS = {
  "test-copy": {
    what: "the test copy",
    label: "app.pobots.engine-test",
    port: 47700,
    dataDir: join(home, "Library", "Application Support", "Pobots-test"),
    botsDir: join(home, "Pobots-test", "bots"),
    installDir: join(home, ".local", "share", "pobots-test"),
  },
  real: {
    what: "the real Pobots",
    label: "app.pobots.engine",
    port: 47600,
    dataDir: join(home, "Library", "Application Support", "Pobots"),
    botsDir: join(home, "Pobots", "bots"),
    installDir: join(home, ".local", "share", "pobots"),
  },
};

const say = (line) => process.stdout.write(line + "\n");
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
class Refusal extends Error {}
const refuse = (sentence) => {
  throw new Refusal(sentence);
};
/** The backup could not be put in place. `whole`: what was there before is back exactly where it was. */
export class PutFailed extends Error {
  constructor(message, whole) {
    super(message);
    this.whole = whole;
  }
}
/** A failure already said in plain words (exit 1, no "Could not restore:" before it). */
class Failed extends Error {}
/** Whether something (a file, a folder or a link, even a broken one) is at `p`. Never follows a link. */
const there = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
/** A file system error in plain words. */
const plainFs = (err) => {
  switch (err?.code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "ENOSPC":
      return "the disk is full";
    case "ENOENT":
      return "something it needed was not there";
    case "EEXIST":
    case "ENOTEMPTY":
      return "something else is already in its place";
    case "EXDEV":
      return "it is on another disk";
    default:
      return err?.message ?? String(err);
  }
};

// ------------------------------------------------------------ the command line

function parseArgs(argv) {
  const modes = ["check", "test-copy", "real", "folders"].filter((m) => argv.includes(`--${m}`));
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const files = argv.filter((a) => !a.startsWith("--"));
  const known = new Set(["--check", "--test-copy", "--real", "--folders"]);
  for (const a of argv) {
    if (!a.startsWith("--") || known.has(a)) continue;
    const name = a.slice(2).split("=")[0];
    if (!["data-dir", "bots-dir", "label", "install-dir", "confirm", "password-ref", "snapshot", "restic"].includes(name)) refuse(`"${a}" is not something this script knows.`);
  }
  if (modes.length !== 1) refuse("Say what to do: --check, --test-copy, --real or --folders, and a backup file or repository folder.");
  if (files.length !== 1) refuse("Give exactly one backup file or repository folder.");
  return { mode: modes[0], file: resolve(files[0]), dataDir: value("data-dir"), botsDir: value("bots-dir"), label: value("label"), installDir: value("install-dir"), confirm: value("confirm"), passwordRef: value("password-ref"), snapshot: value("snapshot"), restic: value("restic") };
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? resolve(p) : join(real(parent), p.slice(parent.length).replace(/^\//, ""));
  }
};
const samePlace = (a, b) => resolve(a) === resolve(b) || real(a) === real(b);
/** Whether `inner` is `outer` or inside it. */
const within = (inner, outer) => {
  const i = real(inner) + "/";
  const o = real(outer) + "/";
  return i.startsWith(o);
};

/** Which Pobots to restore into. --test-copy and --real take no folders of their own: they are fixed. */
export function targetFor(args) {
  const given = ["dataDir", "botsDir", "label", "installDir"].filter((k) => args[k] !== undefined);
  if (args.mode === "check") {
    if (given.length) refuse("--check restores nothing and takes no folders.");
    return undefined;
  }
  if (args.mode === "test-copy" || args.mode === "real") {
    if (given.length) refuse(`--${args.mode} restores only ${TARGETS[args.mode].what}, on its own folders. It takes no --data-dir, --bots-dir, --label or --install-dir.`);
    return { ...TARGETS[args.mode], mode: args.mode };
  }
  // --folders
  if (args.label || args.installDir) refuse("--folders starts no service, so it takes no --label or --install-dir.");
  if (!args.dataDir || !args.botsDir) refuse("--folders needs --data-dir=<folder> and --bots-dir=<folder>.");
  const dataDir = resolve(args.dataDir.replace(/^~(?=\/)/, home));
  const botsDir = resolve(args.botsDir.replace(/^~(?=\/)/, home));
  for (const t of Object.values(TARGETS)) {
    for (const mine of [dataDir, botsDir]) {
      for (const theirs of [t.dataDir, t.botsDir]) {
        if (within(mine, theirs) || within(theirs, mine)) refuse(`--folders never restores into ${t.what}'s folders. Use --${t === TARGETS.real ? "real" : "test-copy"}.`);
      }
    }
  }
  if (within(dataDir, botsDir) || within(botsDir, dataDir)) refuse("The data folder and the bots folder must be apart.");
  return { what: "the given folders", mode: "folders", dataDir, botsDir };
}

// ------------------------------------------------------------ the key and the file

async function readKeyFromStdin() {
  if (process.stdin.isTTY) {
    refuse('Pipe the private key in, for example: op read "op://<vault>/<item>/private key" | node scripts/restore.mjs ... It is never typed or given as a file.');
  }
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    chunks.push(c);
    if (size > 1024 * 1024) {
      for (const b of chunks) b.fill(0);
      refuse("What came in on standard input is far too big to be a private key.");
    }
  }
  const buf = Buffer.concat(chunks);
  for (const b of chunks) b.fill(0);
  try {
    return readPrivateKey(buf.toString("utf8"));
  } finally {
    buf.fill(0);
  }
}

function headerOf(file) {
  if (!existsSync(file) || !statSync(file).isFile()) refuse("That backup file is not there.");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_HEADER + 64);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return readHeader(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

const whenText = (iso) => {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? "an unknown time" : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** "0.12.0" compared with "0.11.3": 1, 0 or -1. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** The engine version that would open the restored data: the installed build's, or this checkout's for --folders. */
function engineVersionFor(target) {
  const text = target.installDir ? readFileSafe(join(target.installDir, "dist", "engine", "main.mjs")) : readFileSafe(join(repo, "engine", "engine.ts"));
  const m = text && /ENGINE_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!m) refuse(target.installDir ? `${cap(target.what)} is not installed in ${target.installDir}, so its version cannot be checked.` : "The engine's version could not be read from this checkout.");
  return m[1];
}
const readFileSafe = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------ a small tar reader: the archive's entries, to nowhere

/** pax records ("<len> key=value\n", lengths in bytes) as an object. */
function paxRecords(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(i, sp).toString("latin1"), 10);
    if (!(len > 0) || i + len > buf.length) throw new Error("The archive inside the backup is damaged.");
    const rec = buf.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Reads a tar stream chunk by chunk and keeps only what it is asked to: every entry's name, type and
 * link target (as tar itself will see them, with pax and GNU long names), and the content of
 * manifest.json. Writes nothing anywhere.
 */
function tarReader() {
  let buf = Buffer.alloc(0);
  let body; // { name, link, type, size, left (with padding), got, keep }
  let pax = {};
  let longName;
  let longLink;
  let zeros = 0;
  const out = { entries: [], manifest: undefined, ended: false };
  const META = new Set(["x", "g", "L", "K"]);
  const finish = (e) => {
    const data = e.keep ? Buffer.concat(e.keep) : undefined;
    if (e.type === "x") pax = paxRecords(data);
    else if (e.type === "g") {
      // Global records that rename entries are never in a Pobots backup.
      const g = paxRecords(data);
      if (g.path !== undefined || g.linkpath !== undefined) out.entries.push({ name: "(a global name record)", link: "", type: "g" });
    } else if (e.type === "L") longName = data.toString("utf8").replace(/\0+$/, "");
    else if (e.type === "K") longLink = data.toString("utf8").replace(/\0+$/, "");
    else {
      out.entries.push({ name: e.name, link: e.link, type: e.type });
      if (e.name === "manifest.json" && data) out.manifest = data.toString("utf8");
    }
  };
  const push = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (body) {
        if (!buf.length) break;
        const take = Math.min(body.left, buf.length);
        const want = Math.max(0, Math.min(take, body.size - body.got));
        if (body.keep && want) body.keep.push(buf.subarray(0, want));
        body.got += take;
        body.left -= take;
        buf = buf.subarray(take);
        if (body.left === 0) {
          finish(body);
          body = undefined;
        }
        continue;
      }
      if (out.ended) {
        buf = Buffer.alloc(0);
        break;
      }
      if (buf.length < 512) break;
      const block = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (block.every((x) => x === 0)) {
        if (++zeros >= 2) out.ended = true;
        continue;
      }
      zeros = 0;
      const str = (from, to) => block.subarray(from, to).toString("utf8").replace(/\0[\s\S]*$/, "");
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
      if (parseInt(str(148, 156).trim(), 8) !== sum) throw new Error("The archive inside the backup is damaged.");
      const sizeField = block.subarray(124, 136);
      const size = sizeField[0] & 0x80 ? Number(sizeField.readBigUInt64BE(4)) : parseInt(str(124, 136).trim() || "0", 8);
      const type = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
      const prefix = str(345, 500);
      let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
      let link = str(157, 257);
      if (!META.has(type)) {
        name = pax.path ?? longName ?? name;
        link = pax.linkpath ?? longLink ?? link;
        pax = {};
        longName = longLink = undefined;
      }
      const keep = META.has(type) || name === "manifest.json";
      if (keep && size > 16 * 1024 * 1024) throw new Error("The archive inside the backup is damaged.");
      body = { name, link, type, size, left: Math.ceil(size / 512) * 512, got: 0, keep: keep ? [] : undefined };
      if (body.left === 0) {
        finish(body);
        body = undefined;
      }
    }
  };
  const end = () => {
    if (!out.ended || body) throw new Error("The archive inside the backup is cut short.");
  };
  return { push, end, out };
}

/** The reader as a stream that passes everything on unchanged (to tar while it unpacks). */
function readingAlong(reader) {
  return new Transform({
    transform(chunk, _enc, done) {
      try {
        reader.push(chunk);
        done(null, chunk);
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      try {
        reader.end();
        done();
      } catch (err) {
        done(err);
      }
    },
  });
}

/** The reader as a stream that ends there (--check, and the listing before anything is unpacked). */
function readingToNowhere(reader) {
  return new Writable({
    write(chunk, _enc, done) {
      try {
        reader.push(chunk);
        done();
      } catch (err) {
        done(err);
      }
    },
    final(done) {
      try {
        reader.end();
        done();
      } catch (err) {
        done(err);
      }
    },
  });
}

const TOP_FILES = { "pobots.db": "database", "config.json": "settings file", "manifest.json": "manifest" };
const kindOf = (type) => (type === "0" || type === "7" ? "file" : type === "5" ? "folder" : type === "2" ? "link" : type === "1" ? "hard link" : "other");

/**
 * Refuses an archive that a Pobots backup never is, before anything is unpacked: a name that starts
 * at the top of the disk or climbs out with "..", the same name twice, a link of any kind at the top
 * level or in place of a bot's folder, a database, settings file or manifest that is not a plain
 * file, a bots folder that is not a plain folder, anything inside a link, a hard link to anything but
 * a plain file in the bots folder, and anything that is not a file, folder or link. Links inside a
 * bot's folder are fine: they are put back as links and never followed.
 */
export function checkEntries(entries) {
  const show = (n) => JSON.stringify(String(n).slice(0, 200));
  const no = (why) => refuse(`${why} Nothing was restored.`);
  const seen = new Map();
  const links = new Set();
  const norm = (raw) => raw.split("/").filter((p) => p !== "" && p !== ".");
  for (const e of entries) {
    if (e.type === "g") no("The archive inside the backup renames its entries in a way a Pobots backup never does.");
    const raw = e.name;
    if (!raw) no("The archive inside the backup holds an entry without a name.");
    if (raw.startsWith("/")) no(`The backup holds an entry with a full path (${show(raw)}), which a Pobots backup never has.`);
    const parts = norm(raw);
    if (parts.includes("..")) no(`The backup holds an entry that points outside its own folder (${show(raw)}).`);
    const kind = kindOf(e.type);
    if (!parts.length) {
      if (kind === "folder") continue;
      no(`The backup holds an entry without a name (${show(raw)}).`);
    }
    const name = parts.join("/");
    const top = parts[0];
    if (TOP_FILES[top] && (parts.length > 1 || kind !== "file")) no(`The backup's ${TOP_FILES[top]} is not a plain file.`);
    if (top === "bots" && parts.length === 1 && kind !== "folder") no("The backup's bots folder is not a plain folder.");
    if (parts.length === 1 && (kind === "link" || kind === "hard link")) no(`The backup holds a link at its top level (${show(raw)}), which a Pobots backup never has.`);
    if (kind === "other") no(`The backup holds something that is not a file, folder or link (${show(raw)}).`);
    if (seen.has(name)) no(`The backup holds the same entry twice (${show(raw)}).`);
    for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join("/"))) no(`The backup holds an entry inside a link (${show(raw)}).`);
    if (kind === "link") {
      if (top !== "bots") no(`The backup holds a link outside the bots folder (${show(raw)}).`);
      if (parts.length === 2) no(`The backup holds a link in place of a bot's folder (${show(raw)}).`);
      links.add(name);
    }
    if (kind === "hard link") {
      const to = e.link ?? "";
      const toParts = norm(to);
      if (top !== "bots" || to.startsWith("/") || toParts.includes("..") || toParts[0] !== "bots" || seen.get(toParts.join("/")) !== "file") {
        no(`The backup holds a hard link to something outside its bots folder (${show(raw)}).`);
      }
    }
    seen.set(name, kind === "hard link" ? "file" : kind);
  }
}

/** Reads the archive inside the backup to nowhere: its entries and manifest. Proves every part is whole. */
async function listArchive(file, key) {
  const reader = tarReader();
  await pipeline(createReadStream(file), unlockStream(key), createGunzip(), readingToNowhere(reader));
  return reader.out;
}

async function check(file, key) {
  const out = await listArchive(file, key);
  checkEntries(out.entries);
  let manifest;
  try {
    manifest = JSON.parse(out.manifest ?? "");
  } catch {
    refuse("The backup opens, but its manifest is missing or damaged.");
  }
  if (!out.entries.some((e) => e.name === "pobots.db")) refuse("The backup opens, but the database is not in it.");
  return { manifest, names: out.entries.map((e) => e.name) };
}

// ------------------------------------------------------------ restoring

/**
 * Lists the archive and refuses it when it is not what Pobots makes, then unpacks it into `into`
 * (a new temporary folder). The second reading is listed again while tar unpacks it, and must be the
 * same, so what was checked is what was unpacked.
 */
async function unpack(file, key, into) {
  const first = await listArchive(file, key);
  checkEntries(first.entries);
  const reader = tarReader();
  const tar = spawn("tar", ["-xf", "-", "-C", into], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((res, rej) => {
    tar.on("error", rej);
    tar.on("close", res);
  });
  try {
    await pipeline(createReadStream(file), unlockStream(key), createGunzip(), readingAlong(reader), tar.stdin);
  } catch (err) {
    tar.kill();
    await exited.catch(() => undefined);
    throw err;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`The backup could not be unpacked: ${stderr.trim().split("\n")[0] ?? ""}`);
  if (JSON.stringify(reader.out.entries) !== JSON.stringify(first.entries)) refuse("The backup changed while it was being restored. Nothing was restored.");
}

/** After unpacking: the database, settings and manifest are plain files and bots a plain folder, never through a link. */
function checkUnpacked(dir) {
  const at = (name) => {
    try {
      return lstatSync(join(dir, name));
    } catch {
      return undefined;
    }
  };
  const db = at("pobots.db");
  if (!db) refuse("The database is not in the backup.");
  if (!db.isFile()) refuse("The backup's database is not a plain file. Nothing was restored.");
  for (const [name, what] of [["config.json", "settings file"], ["manifest.json", "manifest"]]) {
    const s = at(name);
    if (s && !s.isFile()) refuse(`The backup's ${what} is not a plain file. Nothing was restored.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    refuse("The backup's manifest is missing or damaged.");
  }
  if (manifest?.kind !== "pobots-backup-manifest") refuse("The backup's manifest is not a Pobots manifest.");
  const db2 = new DatabaseSync(join(dir, "pobots.db"), { readOnly: true });
  try {
    const ok = db2.prepare("PRAGMA integrity_check").get();
    if (Object.values(ok)[0] !== "ok") refuse("The database in the backup is damaged.");
  } finally {
    db2.close();
  }
  const bots = at("bots");
  if (bots && !bots.isDirectory()) refuse("The backup's bots folder is not a plain folder. Nothing was restored.");
  if (!bots) mkdirSync(join(dir, "bots"));
  return manifest;
}

const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });
const domain = () => `gui/${userInfo().uid}`;
const loaded = (label) => launchctl("print", `${domain()}/${label}`).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engineNote(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8"));
  } catch {
    return undefined;
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const engineRuns = (dataDir) => {
  const note = engineNote(dataDir);
  return !!note && typeof note.pid === "number" && alive(note.pid);
};

/** Stops the service. Returns whether it was running (loaded, or its engine alive) before. */
async function stopService(target) {
  const wasRunning = loaded(target.label) || engineRuns(target.dataDir);
  if (loaded(target.label)) {
    say(`Stopping ${target.what}...`);
    launchctl("bootout", `${domain()}/${target.label}`);
    for (let i = 0; i < 100 && loaded(target.label); i++) await sleep(100);
  }
  for (let i = 0; i < 300 && engineRuns(target.dataDir); i++) await sleep(100);
  if (engineRuns(target.dataDir)) refuse(`${cap(target.what)} is still running, so nothing was changed. Stop it and try again.`);
  return wasRunning;
}

async function startService(target) {
  const plist = join(home, "Library", "LaunchAgents", `${target.label}.plist`);
  if (!existsSync(plist)) throw new Error(`it is not installed as a service (${plist} is missing)`);
  launchctl("enable", `${domain()}/${target.label}`);
  let last;
  for (let i = 0; i < 10; i++) {
    last = launchctl("bootstrap", domain(), plist);
    if (last.status === 0) break;
    await sleep(300);
  }
  if (last?.status !== 0) throw new Error(`launchd would not start ${target.what}: ${(last?.stderr || "").trim()}`);
  for (let i = 0; i < 600; i++) {
    const note = engineNote(target.dataDir);
    if (note && alive(note.pid) && note.port === target.port) return note;
    await sleep(100);
  }
  throw new Error(`${cap(target.what)} did not come back within a minute. See its log in ${join(target.dataDir, "logs", "engine.log")}.`);
}

/** Asks the started engine over its socket: are the manifest's bots on the roster, and does each main chat hold at least its items? */
async function checkOverSocket(note, manifest) {
  const require = createRequire(join(repo, "package.json"));
  const WebSocket = require("ws");
  const protocol = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(repo, "shared", "protocol.ts"), "utf8"))[1]);
  const ws = new WebSocket(`ws://127.0.0.1:${note.port}/ws?token=${note.token}`);
  let n = 0;
  const waits = new Map();
  const req = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = `r${++n}`;
      waits.set(id, { res, rej });
      ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  ws.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.t !== "res") return;
    const w = waits.get(f.id);
    waits.delete(f.id);
    if (w) f.ok ? w.res(f.result) : w.rej(new Error(f.error.message));
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  try {
    await req("hello", { protocol, client: "restore" });
    const snap = await req("snapshot");
    const lines = [];
    let ok = true;
    for (const b of manifest.bots ?? []) {
      const bot = snap.bots.find((x) => x.id === b.id);
      if (!bot) {
        ok = false;
        lines.push(`  ${b.name}: not on the roster`);
        continue;
      }
      let count = 0;
      let before;
      for (;;) {
        const page = await req("thread.read", { threadId: bot.mainThreadId, limit: 500, ...(before !== undefined ? { before } : {}) });
        count += page.items.length;
        if (!page.hasMore || !page.items.length) break;
        before = Math.min(...page.items.map((i) => i.seq));
      }
      const fine = count >= (b.mainItems ?? 0);
      if (!fine) ok = false;
      lines.push(`  ${b.name}: on the roster, ${count} items in its chat (the backup had ${b.mainItems ?? 0})${fine ? "" : " (fewer than in the backup)"}`);
    }
    return { ok, lines, bots: snap.bots.length };
  } finally {
    ws.close();
  }
}

function askConfirmation(args) {
  if (args.confirm !== undefined) {
    if (args.confirm !== CONFIRM) refuse(`The confirmation must be exactly: --confirm="${CONFIRM}"`);
    return;
  }
  let fd;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    refuse(`There is no terminal to confirm on. Add --confirm="${CONFIRM}" to say you mean it.`);
  }
  try {
    writeSync(fd, `This replaces the chats, bots and settings of the real Pobots with the backup.\nWhat is there now is moved aside, not deleted.\nType "${CONFIRM}" to go on: `);
    let line = "";
    const b = Buffer.alloc(1);
    while (readSync(fd, b, 0, 1, null) === 1 && b[0] !== 10) line += String.fromCharCode(b[0]);
    if (line.trim() !== CONFIRM) refuse("Not confirmed, so nothing was changed.");
  } finally {
    closeSync(fd);
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

/**
 * Moves what is there aside and puts the unpacked backup in place. Each destination is noted before
 * anything is copied to it, so a copy that fails halfway is removed again. When something fails,
 * every move is undone and each step of that is checked: the error (PutFailed) names the exact
 * folders, what failed, and whether what was there is back where it was.
 */
export function putInPlace(target, from) {
  const at = stamp();
  const aside = join(target.dataDir, `restore-previous-${at}`);
  const botsAside = `${target.botsDir}.before-restore-${at}`;
  /** [where it was, where it is now] */
  const moved = [];
  /** Destinations a copy goes to, noted before the copy starts. */
  const placed = [];
  /** Files and folders this made that are not part of the result when it fails, newest last. */
  const made = [];
  let step = `making the folder ${target.dataDir}`;
  const makeDir = (dir) => {
    // Notes each folder it makes, so an undo removes it again (only when empty).
    const missing = [];
    for (let d = dir; !there(d); d = dirname(d)) missing.unshift(d);
    for (const d of missing) {
      mkdirSync(d, { mode: 0o700 });
      made.push(d);
    }
  };
  const move = (a, b, what) => {
    step = `moving ${what} ${a} aside to ${b}`;
    makeDir(dirname(b));
    renameSync(a, b);
    moved.push([a, b]);
  };
  const copy = (a, b, what) => {
    step = `copying the backup's ${what} into ${b}`;
    makeDir(dirname(b));
    placed.push(b);
    cpSync(a, b, { recursive: true, verbatimSymlinks: true, dereference: false, errorOnExist: true, force: false });
  };
  try {
    makeDir(target.dataDir);
    for (const name of ["pobots.db", "pobots.db-wal", "pobots.db-shm"]) if (there(join(target.dataDir, name))) move(join(target.dataDir, name), join(aside, name), "the database file");
    if (there(target.botsDir)) move(target.botsDir, botsAside, "the bots folder");
    if (target.mode === "real") {
      if (there(join(target.dataDir, "config.json"))) move(join(target.dataDir, "config.json"), join(aside, "config.json"), "the settings file");
      if (there(join(from, "config.json"))) copy(join(from, "config.json"), join(target.dataDir, "config.json"), "settings file");
    } else if (there(join(from, "config.json"))) {
      // The test copy (and other folders) keep their own settings: the backup's are kept aside to read.
      const kept = join(aside, "config.from-backup.json");
      step = `keeping the backup's settings in ${kept}`;
      makeDir(aside);
      made.push(kept);
      writeFileSync(kept, readFileSync(join(from, "config.json")), { mode: 0o600, flag: "wx" });
    }
    copy(join(from, "pobots.db"), join(target.dataDir, "pobots.db"), "database");
    copy(join(from, "bots"), target.botsDir, "bots");
  } catch (err) {
    const what = `${cap(step)} failed: ${plainFs(err)}.`;
    const problems = [];
    for (const p of placed.reverse()) {
      try {
        rmSync(p, { recursive: true, force: true });
        if (there(p)) throw new Error("it is still there");
      } catch (e) {
        problems.push(`the half-copied ${p} could not be removed (${plainFs(e)})`);
      }
    }
    for (const [a, b] of moved.reverse()) {
      try {
        if (there(a)) throw Object.assign(new Error("something else is in its place"), { code: "EEXIST" });
        renameSync(b, a);
      } catch (e) {
        problems.push(`${a} could not be put back, it is still in ${b} (${plainFs(e)})`);
      }
    }
    // What this made itself: the kept settings file and new, now empty folders. A folder that still
    // holds something (such as what could not be put back) stays.
    for (const p of made.reverse()) {
      try {
        if (!there(p)) continue;
        if (lstatSync(p).isDirectory()) {
          if (readdirSync(p).length === 0) rmdirSync(p);
        } else rmSync(p, { force: true });
      } catch {
        // Only tidying; nothing of what was there depends on it.
      }
    }
    if (!problems.length) {
      const back = moved.map(([a]) => a);
      throw new PutFailed(`The backup could not be put in place. ${what} ${back.length ? `What was there is back where it was: ${back.join(", ")}.` : "Nothing that was there had been moved."}`, true);
    }
    throw new PutFailed(`The backup could not be put in place. ${what} Putting back what was there did not fully work: ${problems.join("; ")}.`, false);
  }
  return { aside: moved.some(([, b]) => b.startsWith(aside)) ? aside : undefined, botsAside: there(botsAside) ? botsAside : undefined, backupConfig: there(join(aside, "config.from-backup.json")) ? join(aside, "config.from-backup.json") : undefined };
}

/**
 * After the backup could not be put in place in a service that was stopped for it: starts it again
 * on what was there when that is back whole, and says in one sentence whether it was started.
 */
export async function serviceAfterFailure(target, failure, wasRunning, start = startService) {
  if (!wasRunning) return `${cap(target.what)} was not running before, so it was not started again.`;
  if (!failure.whole) return `${cap(target.what)} was not started again, because what was there is not all back in place. Put the folders named above back first, then start it.`;
  try {
    await start(target);
    return `${cap(target.what)} was started again on what was there before.`;
  } catch (err) {
    return `${cap(target.what)} was not started again: ${err.message}`;
  }
}

// ------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = targetFor(args);
  if (existsSync(args.file) && statSync(args.file).isDirectory()) {
    const repo = await openRepository(args);
    if (args.mode === "check") {
      say(`This password opens the repository. ${repo.list.length} completed Pobots snapshots:`);
      for (const snapshot of repo.list) say(`${snapshot.id}  ${whenText(snapshot.time)}`);
      if (args.snapshot !== undefined) chooseSnapshot(repo.list, args.snapshot);
      return;
    }
    if ([target.dataDir, target.botsDir].some((dir) => within(dir, args.file) || within(args.file, dir))) {
      refuse("The repository and the restore folders must be separate.");
    }
    const snapshot = chooseSnapshot(repo.list, args.snapshot);
    say(`Restoring snapshot ${snapshot.id} made ${whenText(snapshot.time)}.`);
    return restoreInto(args, target, (tmp) => unpackSnapshot(repo, snapshot, tmp), 2);
  }
  if (args.passwordRef !== undefined || args.snapshot !== undefined || args.restic !== undefined) refuse("Restic options require a repository folder.");
  const header = headerOf(args.file);
  say(`Backup made ${whenText(header.createdAt)} by Pobots ${header.engineVersion ?? "(unknown version)"}, locked to the key ${header.keyFingerprint}.`);
  const key = await readKeyFromStdin();
  const given = fingerprintOfKey(key);
  if (given !== header.keyFingerprint) refuse(`This private key does not open this backup. The backup is locked to ${header.keyFingerprint}; the key given is ${given}.`);

  if (args.mode === "check") {
    const { manifest, names } = await check(args.file, key);
    const bots = (manifest.bots ?? []).map((b) => b.name).join(", ") || "no bots";
    say(`This key opens the backup of ${whenText(header.createdAt)}. Every part is whole: ${names.length} entries, ${manifest.counts?.items ?? "?"} chat items, bots: ${bots}.`);
    if (manifest.leftOut?.length) say(`Left out because they were too big: ${manifest.leftOut.join(", ")}`);
    return;
  }

  checkVersion(target, header.engineVersion);
  return restoreInto(args, target, async (tmp) => { await unpack(args.file, key, tmp); return tmp; }, 1);
}

function checkVersion(target, version) {
  const installed = engineVersionFor(target);
  if (version && compareVersions(version, installed) > 0) {
    refuse(`This backup was made by Pobots ${version}, which is newer than ${target.what}'s ${installed}. Update Pobots first, then restore.`);
  }
}

async function restoreInto(args, target, extract, format) {
  if (target.mode === "folders" && engineRuns(target.dataDir)) refuse("A Pobots is running on that data folder. Stop it first.");
  if (target.mode === "real") askConfirmation(args);

  const tmp = mkdtempSync(join(tmpdir(), "pobots-restore-"));
  try {
    say("Unlocking and unpacking...");
    const source = await extract(tmp);
    const manifest = checkUnpacked(source);
    if (manifest.format !== format) refuse("The backup's manifest has the wrong format.");
    checkVersion(target, manifest.engineVersion);
    if (format === 2) {
      for (const bot of manifest.bots ?? []) {
        if (typeof bot?.id !== "string" || !bot.id || /[\/]/.test(bot.id) || [".", ".."].includes(bot.id)
          || !lstatSync(join(source, "bots", bot.id), { throwIfNoEntry: false })?.isDirectory()) {
          refuse("A bot listed in the manifest is missing a plain folder. Nothing was restored.");
        }
      }
    }
    say(`The backup is whole: ${(manifest.bots ?? []).length} bots, ${manifest.counts?.items ?? "?"} chat items, the database checks out.`);
    const wasRunning = target.mode !== "folders" ? await stopService(target) : false;
    let result;
    try {
      result = putInPlace(target, source);
    } catch (err) {
      if (!(err instanceof PutFailed)) throw err;
      if (target.mode === "folders") throw new Failed(err.message);
      throw new Failed(`${err.message} ${await serviceAfterFailure(target, err, wasRunning)}`);
    }
    const { aside, botsAside, backupConfig } = result;
    if (aside || botsAside) say(`What was there is kept, not deleted:${aside ? ` the database${target.mode === "real" ? " and settings" : ""} in ${aside}` : ""}${aside && botsAside ? ";" : ""}${botsAside ? ` the bots in ${botsAside}` : ""}.`);
    if (backupConfig) say(`${cap(target.what)} keeps its own settings. The backup's settings are in ${backupConfig}, to read.`);
    if (target.mode === "folders") {
      say(`The backup is in place in ${target.dataDir} and ${target.botsDir}. Start Pobots on those folders to use it.`);
      return;
    }
    say(`Starting ${target.what}...`);
    let note;
    try {
      note = await startService(target);
    } catch (err) {
      throw new Failed(`The backup is in place in ${target.dataDir} and ${target.botsDir}, but ${target.what} was not started again: ${err.message}`);
    }
    const checked = await checkOverSocket(note, manifest);
    for (const line of checked.lines) say(line);
    say(checked.ok ? `Done. ${cap(target.what)} runs on the backup of ${whenText(header.createdAt)}, with ${checked.bots} bots.` : `${cap(target.what)} runs, but not everything from the backup is there (see above).`);
    if (target.mode === "real") say("Claude Code and Codex are not in the backup: sign in to them again if this is a new Mac. Every bot starts a fresh session.");
    if (!checked.ok) process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    const refused = err instanceof Refusal || err instanceof BackupFormatError;
    process.stderr.write(`${refused || err instanceof Failed ? "" : "Could not restore: "}${err.message}\n`);
    process.exit(refused ? 2 : 1);
  });
}
