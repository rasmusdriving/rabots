// A bot's history: the git repository in its folder. Every change the person, the app or the bot
// makes is saved as one commit. Who made it is kept in a "Pobots-By:" trailer (and in the author
// name), so it survives a copy of the folder.
//
// Git runs with a fixed identity and without the person's own git settings (no global or system
// config, no hooks, no signing). Nothing is ever pushed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BotChange } from "../shared/protocol.js";

export type ChangeBy = BotChange["by"];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The longest diff `readChange` returns, in characters. */
export const MAX_DIFF = 200_000;
const MAX_FILES = 20;

const AUTHORS: Record<ChangeBy, { name: string; email: string }> = {
  you: { name: "You", email: "you@pobots.local" },
  bot: { name: "Bot", email: "bot@pobots.local" },
  app: { name: "Pobots", email: "app@pobots.local" },
};

let gitChecked: boolean | undefined;

export function gitAvailable(): boolean {
  if (gitChecked === undefined) {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 5000 });
      gitChecked = true;
    } catch {
      gitChecked = false;
    }
  }
  return gitChecked;
}

export class GitError extends Error {}

function gitEnv(by: ChangeBy = "app", botName?: string): NodeJS.ProcessEnv {
  const who = AUTHORS[by];
  const name = by === "bot" && botName ? botName : who.name;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: "Pobots",
    GIT_COMMITTER_EMAIL: AUTHORS.app.email,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  // Never let a variable from the caller's shell point git at another repository.
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"]) delete env[k];
  return env;
}

const FIXED = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.quotePath=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"];

export function git(dir: string, args: string[], opts: { by?: ChangeBy; botName?: string; input?: string } = {}): string {
  try {
    return execFileSync("git", [...FIXED, ...args], {
      cwd: dir,
      env: gitEnv(opts.by, opts.botName),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      input: opts.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(String(e.stderr || e.message || "git failed").trim());
  }
}

export function hasRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Makes sure the folder has a repository. Saves what is there as a first change when it is new. */
export function ensureRepo(dir: string, summary = "Started keeping history"): boolean {
  if (!gitAvailable()) return false;
  if (hasRepo(dir)) return true;
  git(dir, ["init", "-q"]);
  // The first change holds everything, the settings too, so the folder can be read back as it began.
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-verify", "--allow-empty", "-F", "-"], { by: "app", input: message(summary, "app") });
  return true;
}

/** True when the change is the first one in the folder. */
export function isFirstChange(dir: string, id: string): boolean {
  try {
    git(dir, ["rev-parse", "--verify", "-q", `${id}^`]);
    return false;
  } catch {
    return true;
  }
}

/** The paths a change touched, with what happened to each ("A" added, "M" changed, "D" removed). */
export function changeStatus(dir: string, id: string): { status: string; path: string }[] {
  const out = git(dir, ["diff", "--name-status", "-z", "--no-renames", parentOf(dir, id), id]).split("\0").filter(Boolean);
  const rows: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) rows.push({ status: out[i]!, path: out[i + 1]! });
  return rows;
}

function message(summary: string, by: ChangeBy): string {
  return `${summary}\n\nPobots-By: ${by}\n`;
}

/** Paths with changes that are not saved yet, relative to the folder. */
export function pendingPaths(dir: string): string[] {
  if (!hasRepo(dir)) return [];
  const out = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    paths.push(p.slice(3));
    if (code.includes("R") || code.includes("C")) i++; // the next entry is the old name
  }
  return paths;
}

/**
 * Never saved as part of a change: the settings (changed in the app's Settings, not as a file),
 * the harness's own local settings and half-written files.
 */
// Attachments (docs/build/step-files.md) are never saved, also in bots made before .gitignore named
// them. Every path that .gitignore also names is given in the glob form with a wildcard: git refuses
// a plain ":(exclude).attachments" or ":(exclude).claude/settings.local.json" (and even the glob form
// without a wildcard) with "The following paths are ignored" once .gitignore ignores the path and the
// file is there, and then the whole save fails. Tried with git 2.x on 13 Nov 2026.
const NOT_SAVED = [":(exclude)bot.json", ":(exclude,glob)**/bot.json.tmp", ":(exclude,glob)**/.claude/settings.local.json", ":(exclude,glob)**/*.pobots-tmp", ":(exclude,glob)**/.DS_Store", ":(exclude,glob)**/.attachments/**"];

/** Taken out of the index before a save, whoever staged it. */
const UNSTAGED = [":(glob)**/.attachments/**"];

/** Saves everything that changed in the folder as one change. Returns undefined when nothing changed. */
export function saveAll(dir: string, by: ChangeBy, summary: string | ((files: string[]) => string), botName?: string): BotChange | undefined {
  if (!hasRepo(dir)) return undefined;
  git(dir, ["add", "-A", "--", ".", ...NOT_SAVED]);
  const staged = () => git(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames"]).split("\0").filter(Boolean);
  let files = staged();
  // What the bot itself staged (a `git add -A` of its own in a folder whose .gitignore does not yet
  // name .attachments) is taken out again: attachments never go into the history. The file stays on
  // disk. Only when there is such a file, so an ordinary save runs no extra git.
  if (files.some((f) => /(^|\/)\.attachments\//.test(f))) {
    git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...UNSTAGED]);
    files = staged();
  }
  if (!files.length) return undefined;
  const text = typeof summary === "function" ? summary(files) : summary;
  git(dir, ["commit", "-q", "--no-verify", "-F", "-"], { by, botName, input: message(text, by) });
  return readHead(dir);
}

/** Saves only the given paths as one change, leaving any other unsaved changes alone. */
export function savePaths(dir: string, paths: string[], by: ChangeBy, summary: string): BotChange | undefined {
  if (!hasRepo(dir) || !paths.length) return undefined;
  git(dir, ["add", "-A", "--", ...paths]);
  const staged = git(dir, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...paths]).split("\0").filter(Boolean);
  if (!staged.length) return undefined;
  git(dir, ["commit", "-q", "--no-verify", "-F", "-", "--", ...paths], { by, input: message(summary, by) });
  return readHead(dir);
}

// The record separator comes first, so the file names that follow a commit stay with it.
const FORMAT = "%x1e%H%x1f%aI%x1f%ae%x1f%s%x1f%P%x1f%(trailers:key=Pobots-By,valueonly,separator=%x2c)";

/** Files a change may touch only when undo would always refuse it (see the engine's undo). */
function undoable(parents: string, rows: { status: string; path: string }[]): boolean {
  if (!parents.trim() || !rows.length) return false;
  return !rows.some((r) => r.path === "bot.json" || r.path === "CLAUDE.md" || (r.path === "AGENTS.md" && r.status.startsWith("A")));
}

function parseLog(out: string): BotChange[] {
  const changes: BotChange[] = [];
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [head, ...rest] = trimmed.split("\n");
    const [id, at, email, summary, parents, trailer] = (head ?? "").split("\x1f");
    if (!id || !at) continue;
    // --name-status lines: "M<tab>path".
    const rows = rest
      .map((l) => l.replace(/\s+$/, ""))
      .filter(Boolean)
      .map((l) => {
        const tab = l.indexOf("\t");
        return tab < 0 ? { status: "M", path: l.trim() } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1) };
      });
    const files = rows.map((r) => r.path);
    changes.push({
      id,
      at,
      by: whoFrom(trailer ?? "", email ?? ""),
      summary: summary || "Saved a change",
      files: files.slice(0, MAX_FILES),
      canUndo: undoable(parents ?? "", rows),
    });
  }
  return changes;
}

function whoFrom(trailer: string, email: string): ChangeBy {
  const t = trailer.trim().split(",")[0]?.trim();
  if (t === "you" || t === "bot" || t === "app") return t;
  if (email === AUTHORS.you.email) return "you";
  if (email === AUTHORS.bot.email) return "bot";
  return "app";
}

function readHead(dir: string): BotChange | undefined {
  return parseLog(git(dir, ["log", "-n", "1", "--name-status", "--no-renames", `--format=${FORMAT}`, "HEAD"]))[0];
}

function hasCommits(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Changes, newest first. `before` is a change id: the page starts after it. */
export function listChanges(dir: string, before: string | undefined, limit: number): { changes: BotChange[]; hasMore: boolean } {
  if (!hasRepo(dir) || !hasCommits(dir)) return { changes: [], hasMore: false };
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const args = ["log", "--name-status", "--no-renames", `--format=${FORMAT}`, "-n", String(n + 1)];
  if (before) {
    if (!isChangeId(before) || !commitExists(dir, before)) throw new GitError("unknown change");
    args.push("--skip=1", before);
  } else args.push("HEAD");
  const all = parseLog(git(dir, args));
  return { changes: all.slice(0, n), hasMore: all.length > n };
}

export function isChangeId(id: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(id);
}

export function commitExists(dir: string, id: string): boolean {
  if (!isChangeId(id)) return false;
  try {
    git(dir, ["cat-file", "-e", `${id}^{commit}`]);
    // Only changes on this folder's own line of history count.
    git(dir, ["merge-base", "--is-ancestor", id, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function parentOf(dir: string, id: string): string {
  try {
    return git(dir, ["rev-parse", "--verify", "-q", `${id}^`]).trim();
  } catch {
    return EMPTY_TREE;
  }
}

export function readChange(dir: string, id: string): { change: BotChange; diff: string } | undefined {
  if (!hasRepo(dir) || !commitExists(dir, id)) return undefined;
  const change = parseLog(git(dir, ["log", "-n", "1", "--name-status", "--no-renames", `--format=${FORMAT}`, id]))[0];
  if (!change) return undefined;
  let diff = git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-renames", parentOf(dir, id), id]);
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + "\n... (cut off, the change is too long to show in full)\n";
  return { change, diff };
}

export type UndoResult = { ok: true; change: BotChange } | { ok: false; reason: "busy" | "conflict" | "empty" };

/**
 * Reverses one change with a new change. Leaves the folder as it was when that cannot be done
 * cleanly: when a file it touches has unsaved changes, or the reverse does not apply.
 */
export function undoChange(dir: string, id: string, summary: string): UndoResult {
  const parent = parentOf(dir, id);
  const files = git(dir, ["diff", "--name-only", "-z", "--no-renames", parent, id]).split("\0").filter(Boolean);
  if (!files.length) return { ok: false, reason: "empty" };
  const pending = new Set(pendingPaths(dir));
  if (files.some((f) => pending.has(f))) return { ok: false, reason: "busy" };
  const patch = git(dir, ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-renames", "--full-index", parent, id]);
  try {
    git(dir, ["apply", "-R", "--check", "-"], { input: patch });
  } catch {
    return { ok: false, reason: "conflict" };
  }
  try {
    git(dir, ["apply", "-R", "-"], { input: patch });
  } catch {
    // Checked above, so this is unexpected. Put the files back as they were saved.
    try {
      git(dir, ["checkout", "HEAD", "--", ...files.filter((f) => existsInHead(dir, f))]);
    } catch {
      // nothing more to do
    }
    return { ok: false, reason: "conflict" };
  }
  const change = savePaths(dir, files, "app", summary);
  if (!change) return { ok: false, reason: "empty" };
  return { ok: true, change };
}

function existsInHead(dir: string, path: string): boolean {
  try {
    git(dir, ["cat-file", "-e", `HEAD:${path}`]);
    return true;
  } catch {
    return false;
  }
}
