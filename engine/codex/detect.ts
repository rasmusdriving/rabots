// Finds the installed Codex, checks that it starts and is signed in, and reads its model list.
//
// The engine runs as a background service with a bare environment, so the shell's path is not
// there: `codex.executable` in config.json wins, then what a login shell finds (`whence -p codex`),
// then `codex` on the engine's own path, then the usual install places. The same login shell gives
// the path the app-server and the bots' commands run with, as for Claude (claude/detect.ts).
//
// Ready means: found, `codex app-server` answers `initialize`, and `account/read` shows an account.
// Nothing here writes in ~/.codex or reads its files.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ModelInfo } from "../../shared/protocol.js";
import { log } from "../log.js";
import { codexNoPictures, mapAllCodexModels, mapCodexModels } from "./models.js";
import { CodexRpc } from "./rpc.js";

export interface CodexSetup {
  ready: boolean;
  executable?: string;
  /** Arguments before "app-server": empty for the real program. Tests run a fake script with node. */
  args?: string[];
  version?: string;
  /** One plain sentence for the person when not ready. */
  problem?: string;
  /** The environment the app-server runs in. Never logged. */
  env: Record<string, string | undefined>;
  /** The GPT models Pobots offers (newest of each family), empty when not ready. */
  models: ModelInfo[];
  /**
   * Every model Codex listed, before the list was cut to the newest of each family (step 3b): an
   * older model a bot still uses keeps its efforts and its fast mode. Absent: the same as `models`.
   */
  allModels?: ModelInfo[];
  /**
   * Ids of the models whose `inputModalities` in Codex's model list leave out "image": a picture is
   * kept and its path named, but not shown to such a model (docs/build/step-files.md, decided 6).
   */
  noPictures?: string[];
}

export const CODEX_NOT_INSTALLED = "Codex is not installed on this Mac.";
export const CODEX_NOT_SIGNED_IN = "Codex is not signed in. Run codex login in a terminal on the Mac.";
export const CODEX_DID_NOT_START = "Codex is installed but did not start. Check that it works in a terminal on the Mac.";
const CODEX_BAD_PATH = "The Codex program set in the engine settings could not be found. Check the path in config.json.";

/** Variables that mark "this process runs inside a Claude or Codex session"; never passed on to a bot's Codex. */
const SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ARTIFACT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "ELECTRON_RUN_AS_NODE",
];

const MARK = "__POBOTS__";

function run(file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeout, env: options.env, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where a login shell finds `codex`, and its PATH. */
async function askLoginShell(): Promise<{ path?: string; shellPath?: string }> {
  if (process.platform === "win32") return {};
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const find = /zsh$/.test(shell) ? "whence -p codex" : "type -P codex";
  const script = `printf '${MARK}%s${MARK}%s${MARK}\\n' "$(${find} 2>/dev/null)" "$PATH"`;
  const out = await run(shell, ["-l", "-c", script], { timeout: 15000 });
  const m = out ? new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`).exec(out) : null;
  if (!m) return {};
  const path = m[1]!.trim();
  return { ...(path && isExecutableFile(path) ? { path } : {}), ...(m[2] ? { shellPath: m[2] } : {}) };
}

function onPath(pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
    if (isExecutableFile(p)) return p;
  }
  return undefined;
}

function knownPlaces(): string[] {
  return [join(homedir(), ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
}

function mergePath(...parts: (string | undefined)[]): string {
  const out: string[] = [];
  for (const part of parts) for (const p of (part ?? "").split(delimiter)) if (p && !out.includes(p)) out.push(p);
  return out.join(delimiter);
}

/** The environment a bot's Codex runs in: the engine's own, without session markers, with a full path. */
export function codexEnv(base: NodeJS.ProcessEnv, executable: string | undefined, shellPath?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of SESSION_MARKERS) delete env[name];
  const exeDir = executable ? executable.slice(0, Math.max(executable.lastIndexOf("/"), 0)) : undefined;
  env.PATH = mergePath(env.PATH, shellPath, exeDir, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  env.HOME ??= homedir();
  return env;
}

/** Starts the app-server once, asks who is signed in and which models there are, and stops it. */
export async function probeCodex(executable: string, env: Record<string, string | undefined>, args: string[] = []): Promise<{ ok: boolean; signedIn: boolean; version?: string; models: ModelInfo[]; allModels: ModelInfo[]; noPictures: string[] }> {
  const rpc = new CodexRpc({ executable, args, env });
  try {
    rpc.start();
    const init = await rpc.initialize(30_000);
    const ua = typeof init.userAgent === "string" ? init.userAgent : "";
    const version = /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(ua)?.[1];
    const account = await rpc.request<Record<string, unknown>>("account/read", {}, 20_000).catch(() => undefined);
    const signedIn = !!(account && account.account && typeof account.account === "object");
    let models: ModelInfo[] = [];
    let allModels: ModelInfo[] = [];
    let noPictures: string[] = [];
    if (signedIn) {
      const rows: unknown[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await rpc.request<Record<string, unknown>>("model/list", cursor ? { cursor } : {}, 20_000).catch(() => undefined);
        if (!r) break;
        if (Array.isArray(r.data)) rows.push(...r.data);
        cursor = typeof r.nextCursor === "string" ? r.nextCursor : null;
        if (!cursor) break;
      }
      allModels = mapAllCodexModels(rows);
      models = mapCodexModels(rows);
      noPictures = codexNoPictures(rows);
    }
    return { ok: true, signedIn, ...(version ? { version } : {}), models, allModels, noPictures };
  } catch (err) {
    log.warn(`Codex did not answer: ${err instanceof Error ? err.message : String(err)}`);
    if (rpc.stderr.length) log.debug(`Codex said:\n  ${rpc.stderr.join("\n  ")}`);
    return { ok: false, signedIn: false, models: [], allModels: [], noPictures: [] };
  } finally {
    rpc.stop();
  }
}

export async function detectCodex(options: { executable?: string } = {}): Promise<CodexSetup> {
  let executable: string | undefined;
  let shellPath: string | undefined;
  if (options.executable) {
    if (!isExecutableFile(options.executable)) return { ready: false, problem: CODEX_BAD_PATH, env: codexEnv(process.env, undefined), models: [] };
    executable = options.executable;
  } else {
    const shell = await askLoginShell();
    shellPath = shell.shellPath;
    executable = shell.path ?? onPath(process.env.PATH) ?? knownPlaces().find(isExecutableFile);
  }
  const env = codexEnv(process.env, executable, shellPath);
  if (!executable) return { ready: false, problem: CODEX_NOT_INSTALLED, env, models: [] };
  const probe = await probeCodex(executable, env);
  if (!probe.ok) return { ready: false, executable, problem: CODEX_DID_NOT_START, env, models: [] };
  if (!probe.signedIn) return { ready: false, executable, ...(probe.version ? { version: probe.version } : {}), problem: CODEX_NOT_SIGNED_IN, env, models: [] };
  return { ready: true, executable, ...(probe.version ? { version: probe.version } : {}), env, models: probe.models, allModels: probe.allModels, noPictures: probe.noPictures };
}

/** Asks a short-lived app-server whether a saved thread exists (thread/read). False when it cannot say. */
export async function codexThreadExists(setup: CodexSetup, threadId: string): Promise<boolean> {
  if (!setup.executable) return false;
  const rpc = new CodexRpc({ executable: setup.executable, args: setup.args ?? [], env: setup.env });
  try {
    rpc.start();
    await rpc.initialize(30_000);
    await rpc.request("thread/read", { threadId }, 20_000);
    return true;
  } catch {
    return false;
  } finally {
    rpc.stop();
  }
}

/** Archives a saved thread so Codex's own history does not fill up with dead Pobots threads. Best effort. */
export async function codexArchiveThread(setup: CodexSetup, threadId: string): Promise<void> {
  if (!setup.executable) return;
  const rpc = new CodexRpc({ executable: setup.executable, args: setup.args ?? [], env: setup.env });
  try {
    rpc.start();
    await rpc.initialize(30_000);
    await rpc.request("thread/archive", { threadId }, 20_000);
    log.info("Archived an old Codex thread of a bot");
  } catch (err) {
    log.debug(`Could not archive an old Codex thread: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rpc.stop();
  }
}
