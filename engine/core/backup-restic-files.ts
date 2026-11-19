import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import { defaultBackupFolder, insidePath, legacyOneDrive, resolvedPath, samePath } from "../config.js";
import { STAGE_NAME } from "./restic-cli.js";

export const OWNER_FILE = ".pobots-backup-owner.json";
export const OTHER_OWNER = "Another Pobots keeps its backups in this folder. Set a folder of its own for this Pobots.";
const BAD_OWNER = "The backup folder's owner note cannot be read. Pobots will not use that folder.";
export const CANNOT_WRITE = "Pobots cannot write to the backup folder. Check that the folder is available on the Mac.";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const EXCLUDES = ["node_modules", ".DS_Store", "*.pobots-tmp", "bot.json.tmp"];

export class BackupProblem extends Error {}

const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
const excluded = (name: string) => EXCLUDES.includes(name) || name.endsWith(".pobots-tmp");

export function ownerProblem(folder: string, dataDir: string, required = false): string | undefined {
  const path = join(folder, OWNER_FILE);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 16_384) return BAD_OWNER;
    const note = JSON.parse(readFileSync(path, "utf8"));
    if (note?.kind !== "pobots-backup-owner" || note.version !== 2 || typeof note.dataDir !== "string" || !note.dataDir) return BAD_OWNER;
    return samePath(note.dataDir, dataDir) ? undefined : OTHER_OWNER;
  } catch (err) {
    return gone(err) && !required ? undefined : BAD_OWNER;
  }
}

export function folderProblem(folder: string, dataDir: string, botsDir: string): string | undefined {
  if (!folder) return "No backup folder is set for this Pobots.";
  if (insidePath(folder, legacyOneDrive()) || insidePath(legacyOneDrive(), folder)) return "Choose a backup folder outside OneDrive.";
  // A re-pointed link must pass the same rules at use time as when settings were loaded.
  if (!samePath(folder, defaultBackupFolder()) && insidePath(defaultBackupFolder(), folder)) return "Choose a separate folder for backups.";
  if ([dataDir, botsDir].some((own) => insidePath(folder, own) || insidePath(own, folder))) {
    return "The backup folder must be separate from Pobots' own folders.";
  }
  try {
    if (!existsSync(folder)) {
      accessSync(dirname(folder), constants.W_OK);
      return;
    }
    if (!lstatSync(folder).isDirectory()) return "The backup folder is not a folder.";
    accessSync(folder, constants.W_OK);
    return ownerProblem(folder, dataDir);
  } catch {
    return CANNOT_WRITE;
  }
}

export async function claimFolder(folder: string, dataDir: string): Promise<void> {
  await mkdir(folder, { mode: 0o700 }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new BackupProblem(CANNOT_WRITE);
  });
  const note = join(folder, OWNER_FILE);
  if (!existsSync(note)) {
    const existing = await readdir(folder).catch(() => { throw new BackupProblem(CANNOT_WRITE); });
    // Never adopt someone else's existing repository, or add restic's files into an unrelated folder.
    if (existing.some((name) => name !== ".DS_Store" && name !== OWNER_FILE)) {
      throw new BackupProblem("The backup folder already contains files and has no Pobots owner note. Choose an empty folder.");
    }
    await writeFile(note, JSON.stringify({ kind: "pobots-backup-owner", version: 2, dataDir: resolvedPath(dataDir) }) + "\n",
      { flag: "wx", mode: 0o600 }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new BackupProblem(CANNOT_WRITE);
    });
  }
  const problem = ownerProblem(folder, dataDir, true);
  if (problem) throw new BackupProblem(problem);
}

export async function largeFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const leftOut: string[] = [];
  async function scan(rel = "") {
    signal.throwIfAborted();
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch((err) => {
      if (rel && gone(err)) return [];
      throw new BackupProblem("Some bot files could not be read.");
    });
    for (const e of entries) {
      signal.throwIfAborted();
      if (excluded(e.name)) continue;
      const path = join(rel, e.name);
      if (e.isDirectory()) await scan(path);
      else if (e.isFile()) {
        const st = await lstat(join(root, path)).catch((err) => {
          if (gone(err)) return undefined;
          throw new BackupProblem("Some bot files could not be read.");
        });
        if (st?.isFile() && st.size > MAX_FILE_BYTES) leftOut.push(path);
      }
    }
  }
  await scan();
  return leftOut.sort();
}

export interface BackupSources {
  dataDir: string;
  botsDir: string;
  engineVersion: string;
  bots: () => { id: string; name: string }[];
  snapshotDb: (path: string) => Promise<unknown>;
}

export async function stageBackup(o: BackupSources, at: string, signal: AbortSignal) {
  const stage = join(o.dataDir, STAGE_NAME);
  const root = await lstat(o.botsDir).catch(() => undefined);
  if (!root?.isDirectory()) throw new BackupProblem("The bots folder is missing, unreadable or a link.");
  const bots = o.bots();
  for (const bot of bots) {
    const st = await lstat(join(o.botsDir, bot.id)).catch(() => undefined);
    if (!st?.isDirectory()) throw new BackupProblem(`The folder of the bot ${bot.name} is missing or a link, so no backup was made.`);
  }
  const leftOut = await largeFiles(o.botsDir, signal);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { mode: 0o700 });
  const dbPath = join(stage, "pobots.db");
  try {
    await o.snapshotDb(dbPath);
  } catch {
    throw new BackupProblem("The chats could not be copied from the database.");
  }
  signal.throwIfAborted();
  const config = join(o.dataDir, "config.json");
  if (existsSync(config)) await copyFile(config, join(stage, "config.json"));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table: "threads" | "items") => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    const rows = db.prepare("SELECT t.bot_id AS botId, t.id AS threadId, (SELECT count(*) FROM items i WHERE i.thread_id = t.id) AS n FROM threads t WHERE t.kind = 'main' AND t.retired_at IS NULL").all();
    const main = new Map(rows.map((r) => [r.botId, r]));
    const manifest = {
      kind: "pobots-backup-manifest", format: 2, createdAt: at, engineVersion: o.engineVersion, protocol: PROTOCOL_VERSION,
      database: "pobots.db", config: "config.json", botsFolder: "bots", counts: { threads: count("threads"), items: count("items") },
      bots: bots.map((b) => ({ ...b, mainThreadId: main.get(b.id)?.threadId, mainItems: Number(main.get(b.id)?.n ?? 0) })),
      leftOut,
    };
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  } finally {
    db.close();
  }
  return { stage, leftOut };
}

const object = /^[a-f0-9]{64}$/;
const prefix = /^[a-f0-9]{2}$/;

/** Inventory repository objects only. Restic's transient locks are deliberately left out. */
export async function repositoryFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const entries = (rel: string) => readdir(join(root, rel), { withFileTypes: true }).catch((err) => {
    if (gone(err)) return [];
    throw err;
  });
  const add = async (path: string) => {
    const st = await lstat(join(root, path)).catch((err) => {
      if (gone(err)) return undefined;
      throw err;
    });
    if (!st) return;
    if (!st.isFile()) throw new BackupProblem("The backup repository contains unexpected files. Check the backup folder.");
    files.set(path, st.size);
  };
  const invalid = () => new BackupProblem("The backup repository contains unexpected files. Check for iCloud copies with a different name.");
  for (const e of await entries("")) {
    if (["config", OWNER_FILE].includes(e.name)) await add(e.name);
    else if (["data", "index", "keys", "locks", "snapshots"].includes(e.name)) {
      if (!e.isDirectory()) throw invalid();
    } else if (e.name !== ".DS_Store") throw invalid();
  }
  for (const dir of ["index", "keys", "snapshots", "locks"]) {
    for (const e of await entries(dir)) {
      if (e.name === ".DS_Store") continue;
      if (!object.test(e.name) || !e.isFile()) throw invalid();
      if (dir !== "locks") await add(join(dir, e.name));
    }
  }
  for (const e of await entries("data")) {
    if (e.name === ".DS_Store") continue;
    if (!e.isDirectory() || !prefix.test(e.name)) throw invalid();
    for (const pack of await entries(join("data", e.name))) {
      if (pack.name === ".DS_Store") continue;
      if (!object.test(pack.name) || !pack.name.startsWith(e.name)) throw invalid();
      await add(join("data", e.name, pack.name));
    }
  }
  return files;
}
