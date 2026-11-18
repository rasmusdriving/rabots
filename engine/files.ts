// The text files in a bot's folder, as the app shows and edits them. Only files inside the folder,
// never bot.json, CLAUDE.md, .git or any other hidden file, never through a link that leaves the
// folder, and never over 1 MB. Every refusal says why in plain words.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { BotFile, BotFileKind } from "../shared/protocol.js";
import { EngineError } from "./errors.js";

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED = 2000;
const MAX_DEPTH = 8;

const KIND_ORDER: Record<BotFileKind, number> = { job: 0, memory: 1, skill: 2, other: 3 };

/** A name for content: the first 16 hex characters of its SHA-256. */
export function revOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function fileKind(path: string): BotFileKind {
  if (path === "AGENTS.md") return "job";
  if (path.startsWith("memory/")) return "memory";
  if (path.startsWith("skills/")) return "skill";
  return "other";
}

export function fileTitle(path: string): string {
  if (path === "AGENTS.md") return "Job";
  if (path === "memory/MEMORY.md") return "Memory index";
  const parts = path.split("/");
  const name = parts.at(-1)!;
  if (parts[0] === "skills" && name === "SKILL.md" && parts.length >= 3) return parts.at(-2)!;
  return name.replace(/\.md$/i, "") || name;
}

/**
 * Checks a path from the app and returns it cleaned up (forward slashes, no leading "./").
 * Throws a bad_request with a plain sentence when the path is not one the app may touch.
 */
export function checkPath(raw: string): string {
  const outside = () => new EngineError("bad_request", "Only files inside the bot's folder can be opened here.");
  if (typeof raw !== "string") throw outside();
  const p = raw.trim();
  if (!p) throw new EngineError("bad_request", "The file needs a name.");
  if (p.length > 400) throw new EngineError("bad_request", "That file name is too long.");
  if (/[\0-\x1f]/.test(p)) throw new EngineError("bad_request", "That file name has characters that cannot be used.");
  if (p.includes("\\")) throw new EngineError("bad_request", "Use forward slashes in file names.");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith("~")) throw outside();
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length) throw new EngineError("bad_request", "The file needs a name.");
  if (parts.some((s) => s === "..")) throw outside();
  if (parts[0] === ".git") throw new EngineError("bad_request", "The history folder is kept by Pobots and cannot be changed here.");
  if (parts.some((s) => s.startsWith("."))) throw new EngineError("bad_request", "Hidden files are kept by Pobots and cannot be changed here.");
  const clean = parts.join("/");
  if (clean === "bot.json") throw new EngineError("bad_request", "The bot's settings are changed in Settings, not as a file.");
  if (clean === "CLAUDE.md") throw new EngineError("bad_request", "CLAUDE.md is kept by Pobots. It only points to the job.");
  return clean;
}

function inside(root: string, full: string): boolean {
  return full === root || full.startsWith(root + sep);
}

/** The real path of `rel` in `dir`, or of its nearest existing parent, must stay inside the folder. */
function checkStaysInside(dir: string, rel: string): void {
  const root = realpathSync(dir);
  let probe = join(dir, rel);
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(probe);
    } catch {
      real = undefined;
    }
    if (real !== undefined) {
      if (!inside(root, real)) throw new EngineError("bad_request", "That file leads to a place outside the bot's folder, so it cannot be opened here.");
      return;
    }
    const up = dirname(probe);
    if (up === probe || !inside(dir, up)) return;
    probe = up;
  }
}

function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function toBotFile(path: string, st: Stats): BotFile {
  return { path, kind: fileKind(path), title: fileTitle(path), size: st.size, modifiedAt: st.mtime.toISOString() };
}

/** The text files in the folder: job first, then memory, skills and the rest, each by path. */
export function listFiles(dir: string): BotFile[] {
  const root = realpathSync(dir);
  const out: BotFile[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= MAX_LISTED || depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(join(dir, rel)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (!rel && (name === "bot.json" || name === "CLAUDE.md" || name.startsWith("bot.json"))) continue;
      const full = join(dir, path);
      let st: Stats;
      try {
        const l = lstatSync(full);
        if (l.isSymbolicLink()) {
          if (!inside(root, realpathSync(full))) continue;
          st = statSync(full);
        } else st = l;
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      try {
        if (!looksLikeText(readFileSync(full))) continue;
      } catch {
        continue;
      }
      out.push(toBotFile(path, st));
      if (out.length >= MAX_LISTED) return;
    }
  };
  walk("", 0);
  return out.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k) return k;
    if (a.path === "memory/MEMORY.md") return -1;
    if (b.path === "memory/MEMORY.md") return 1;
    return a.path.localeCompare(b.path);
  });
}

export function readTextFile(dir: string, raw: string): { file: BotFile; text: string; rev: string } {
  const path = checkPath(raw);
  checkStaysInside(dir, path);
  const full = join(dir, path);
  let st: Stats;
  try {
    st = statSync(full);
  } catch {
    throw new EngineError("not_found", "That file does not exist.");
  }
  if (st.isDirectory()) throw new EngineError("bad_request", "That is a folder, not a file.");
  if (!st.isFile()) throw new EngineError("bad_request", "That is not a file that can be opened here.");
  if (st.size > MAX_FILE_BYTES) throw new EngineError("bad_request", "That file is larger than 1 MB, which is too big to open here.");
  const buf = readFileSync(full);
  if (!looksLikeText(buf)) throw new EngineError("bad_request", "That file is not a text file, so it cannot be opened here.");
  return { file: toBotFile(path, st), text: buf.toString("utf8"), rev: revOf(buf) };
}

/** The current rev of a file, or undefined when it does not exist. */
export function currentRev(dir: string, path: string): string | undefined {
  try {
    const full = join(dir, path);
    if (!statSync(full).isFile()) return undefined;
    return revOf(readFileSync(full));
  } catch {
    return undefined;
  }
}

export function writeTextFile(dir: string, raw: string, text: string, baseRev?: string): { file: BotFile; rev: string; path: string; created: boolean } {
  const path = checkPath(raw);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_FILE_BYTES) throw new EngineError("bad_request", "That text is larger than 1 MB, which is too big to save here.");
  checkStaysInside(dir, path);
  const full = join(dir, path);
  let exists = false;
  try {
    const st = statSync(full);
    if (st.isDirectory()) throw new EngineError("bad_request", "There is a folder with that name.");
    if (!st.isFile()) throw new EngineError("bad_request", "That is not a file that can be saved here.");
    if (st.size > MAX_FILE_BYTES) throw new EngineError("bad_request", "That file is larger than 1 MB, which is too big to change here.");
    exists = true;
  } catch (err) {
    if (err instanceof EngineError) throw err;
  }
  if (baseRev !== undefined) {
    const now = currentRev(dir, path);
    if (now !== baseRev) {
      throw new EngineError(
        "conflict",
        now === undefined ? "This file was removed after you opened it." : "This file changed after you opened it. Load the new version or keep your text and save again.",
      );
    }
  }
  try {
    mkdirSync(dirname(full), { recursive: true });
  } catch {
    throw new EngineError("bad_request", "The folder for that file could not be made.");
  }
  checkStaysInside(dir, path);
  const tmp = join(dirname(full), `.${basename(full)}.pobots-tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, full);
  const st = statSync(full);
  return { file: toBotFile(path, st), rev: revOf(bytes), path, created: !exists };
}

export function deleteTextFile(dir: string, raw: string): string {
  const path = checkPath(raw);
  if (path === "AGENTS.md") throw new EngineError("bad_request", "The job cannot be removed. Change its text instead.");
  checkStaysInside(dir, path);
  const full = join(dir, path);
  let st: Stats;
  try {
    st = lstatSync(full);
  } catch {
    throw new EngineError("not_found", "That file does not exist.");
  }
  if (st.isDirectory()) throw new EngineError("bad_request", "That is a folder, not a file.");
  rmSync(full);
  // Remove folders the delete left empty, up to the bot's folder, so the list stays tidy.
  let up = dirname(full);
  while (up !== dir && inside(dir, up)) {
    try {
      if (readdirSync(up).length) break;
      rmdirSync(up);
    } catch {
      break;
    }
    up = dirname(up);
  }
  return path;
}
