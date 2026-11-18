// Finds the installed Claude command line program and builds the environment it runs in.
//
// On some Macs `claude` is a shell function that sources an env file and then runs the real
// binary, so `which` from the engine's own environment is not enough. We ask a login shell for the
// real path (`whence -p` in zsh, `type -P` in bash), then fall back to the usual install places.
// `claude.executable` in config.json wins over all of that.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { readEnvFile } from "../envfile.js";
import { log } from "../log.js";

export interface ClaudeSetup {
  ready: boolean;
  executable?: string;
  version?: string;
  problem?: string;
  /** The full environment for the harness process. Holds env file values: never log it. */
  env: Record<string, string | undefined>;
}

/**
 * Variables that mark "this process runs inside a Claude session". When the engine itself is
 * started from such a session they must not leak into the bots' own sessions.
 */
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
  // Set by the desktop shell so Electron runs the engine as plain Node. Not for the harness.
  "ELECTRON_RUN_AS_NODE",
];

const MARK = "__POBOTS__";

function run(file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeout, env: options.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : String(stdout));
    });
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

/** Asks the person's login shell where the real `claude` binary is, and for its PATH. */
async function askLoginShell(): Promise<{ path?: string; shellPath?: string }> {
  if (process.platform === "win32") {
    const out = await run("where", ["claude"], { timeout: 10000 });
    const first = out?.split(/\r?\n/).find((l) => l.trim());
    return { path: first?.trim() };
  }
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const isZsh = /zsh$/.test(shell);
  const find = isZsh ? "whence -p claude" : "type -P claude";
  const script = `printf '${MARK}%s${MARK}%s${MARK}\\n' "$(${find} 2>/dev/null)" "$PATH"`;
  for (const flags of [["-l", "-c"], ["-i", "-l", "-c"]]) {
    const out = await run(shell, [...flags, script], { timeout: 15000 });
    const m = out ? new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`).exec(out) : null;
    if (m) {
      const path = m[1]!.trim();
      if (path && isExecutableFile(path)) return { path, shellPath: m[2] };
      if (flags.length === 3) return { shellPath: m[2] };
    }
  }
  return {};
}

function knownPlaces(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [join(home, ".local", "bin", "claude.exe"), join(process.env.APPDATA ?? "", "npm", "claude.cmd")];
  }
  return [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function mergePath(current: string | undefined, extra: string | undefined): string | undefined {
  if (!extra) return current;
  const parts = (current ?? "").split(delimiter).filter(Boolean);
  for (const p of extra.split(delimiter)) if (p && !parts.includes(p)) parts.push(p);
  return parts.join(delimiter);
}

export function harnessEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> | undefined, shellPath?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of SESSION_MARKERS) delete env[name];
  env.PATH = mergePath(env.PATH, shellPath);
  // The harness offers its tool for publishing an artifact to Claude only when this is set (seen in
  // step 2f: without it the tool is not in the list at all, with it a bot on Opus has it; the
  // smallest model never has it). Pobots shows artifacts, so its bots get the tool. The value the
  // engine's own parent session had was dropped above; the env file may still set it to "0".
  env.CLAUDE_CODE_ARTIFACT = "1";
  if (extra) Object.assign(env, extra);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "pobots/0.1.0";
  return env;
}

export async function detectClaude(options: { executable?: string; envFile?: string }): Promise<ClaudeSetup> {
  let extra: Record<string, string> | undefined;
  if (options.envFile) {
    extra = readEnvFile(options.envFile);
    if (!extra) log.warn(`The env file set in config.json could not be read: ${options.envFile}`);
    else log.info(`Loaded ${Object.keys(extra).length} variables from the env file.`);
  }

  let executable: string | undefined;
  let shellPath: string | undefined;
  if (options.executable) {
    if (!isExecutableFile(options.executable)) {
      return {
        ready: false,
        problem: "The Claude program set in the engine settings could not be found. Check the path in config.json.",
        env: harnessEnv(process.env, extra),
      };
    }
    executable = options.executable;
  } else {
    const fromShell = await askLoginShell();
    shellPath = fromShell.shellPath;
    executable = fromShell.path ?? knownPlaces().find(isExecutableFile);
  }

  const env = harnessEnv(process.env, extra, shellPath);
  if (!executable) {
    return {
      ready: false,
      problem: "Pobots could not find Claude on this computer. Install the Claude command line tool, then restart Pobots.",
      env,
    };
  }

  const out = await run(executable, ["--version"], { timeout: 20000, env: env as NodeJS.ProcessEnv });
  const version = out ? /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] : undefined;
  if (!out) {
    return {
      ready: false,
      executable,
      problem: "Claude was found but did not start. Check that it works in a terminal, then restart Pobots.",
      env,
    };
  }
  return { ready: true, executable, version, env };
}
