// The providers (step 7b): the programs that drive the bots' models on this machine, how each was
// installed, its newest version, and how to update it. Today Claude Code and Codex; another harness
// is one more entry in PROVIDERS. Another machine would run its own engine with the same list.
//
// Copied from T3 Code's approach (MIT, github.com/pingdotgg/t3code):
// apps/server/src/provider/Drivers/ClaudeMaintenance.ts, Drivers/CodexDriver.ts and
// packages/provider-core/src/server/maintenanceResolver.ts. The install is told apart by the real
// path of the command: Claude's native installer keeps its versions in ~/.local/share/claude/versions
// and updates with `claude update`; Codex's standalone install lives in <home>/packages/standalone
// and updates with `codex update` and CODEX_HOME set to <home>; an npm install updates with
// `npm i -g <package>@latest`; Homebrew with `brew upgrade <formula>`.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId, ProviderState } from "../shared/protocol.js";

export type InstallMethod = ProviderState["installedBy"];

/** How one provider is updated: the command and its environment. Never logged with its environment. */
export interface UpdatePlan {
  method: InstallMethod;
  command: string;
  args: string[];
  /** Added to the provider's own environment. */
  env?: Record<string, string>;
  /** Where its newest version is read. */
  latest?: { kind: "text" | "codex-release" | "npm" | "none"; url?: string };
}

interface ProviderDef {
  id: ProviderId;
  label: string;
  npmPackage: string;
  brewFormula: string;
  /** The native installer's update, when the real path says it is one. */
  native: (realPath: string) => UpdatePlan | undefined;
}

const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const CODEX_CHANNEL = "https://releases.openai.com/codex/channels/latest";

/** The channel Claude Code updates from: "latest" unless its own settings say "stable". Only read, never changed. */
export function claudeChannel(home = homedir()): "latest" | "stable" {
  for (const p of ["/Library/Application Support/ClaudeCode/managed-settings.json", join(home, ".claude", "settings.json")]) {
    try {
      const v = (JSON.parse(readFileSync(p, "utf8")) as { autoUpdatesChannel?: unknown }).autoUpdatesChannel;
      if (v === "stable" || v === "latest") return v;
    } catch {
      // Not there or not readable: the default.
    }
  }
  return "latest";
}

/** Where Codex's standalone install keeps its home, from the command's real path; undefined for another kind of install. */
export function codexStandaloneHome(realPath: string): string | undefined {
  const m = /^(.*)\/packages\/standalone\//.exec(realPath.replaceAll("\\", "/"));
  return m ? m[1] || "/" : undefined;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    npmPackage: "@anthropic-ai/claude-code",
    brewFormula: "claude-code",
    native: (real) =>
      real.includes("/.local/share/claude/") || real.includes("/claude/versions/")
        ? { method: "native", command: "", args: ["update"], latest: { kind: "text", url: `${CLAUDE_RELEASES}/${claudeChannel()}` } }
        : undefined,
  },
  {
    id: "codex",
    label: "Codex",
    npmPackage: "@openai/codex",
    brewFormula: "codex",
    native: (real) => {
      const home = codexStandaloneHome(real);
      return home ? { method: "native", command: "", args: ["update"], env: { CODEX_HOME: home }, latest: { kind: "codex-release", url: CODEX_CHANNEL } } : undefined;
    },
  },
];

export function providerDef(id: ProviderId): ProviderDef {
  return PROVIDERS.find((p) => p.id === id)!;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * How a provider at `executable` was installed and how to update it. The command is the program
 * itself for a native install, npm or brew next to it otherwise. "other": no update from Pobots.
 */
export function updatePlan(id: ProviderId, executable: string | undefined): UpdatePlan {
  if (!executable) return { method: "none", command: "", args: [] };
  const def = providerDef(id);
  const real = realPath(executable);
  const native = def.native(real);
  if (native) return { ...native, command: executable };
  if (/\/node_modules\//.test(real) && real.includes(def.npmPackage.replace("/", "/"))) {
    // npm next to the node that runs it, else the one on the path.
    const npm = join(dirname(executable), "npm");
    return { method: "npm", command: npm, args: ["i", "-g", `${def.npmPackage}@latest`], latest: { kind: "npm", url: `https://registry.npmjs.org/${def.npmPackage}/latest` } };
  }
  if (/\/(Cellar|Caskroom)\//.test(real) || real.startsWith("/opt/homebrew/") || real.startsWith("/usr/local/Homebrew/")) {
    return { method: "homebrew", command: existsBrew(), args: ["upgrade", def.brewFormula], latest: { kind: "none" } };
  }
  return { method: "other", command: "", args: [] };
}

function existsBrew(): string {
  return process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
}

/** Reads a version like "2.1.325" out of text. */
export function versionIn(text: string | undefined): string | undefined {
  return text ? /(\d+\.\d+\.\d+)/.exec(text)?.[1] : undefined;
}

/** True when `a` is a newer version than `b` (both "x.y.z"). */
export function newer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The newest version the provider's install channel offers. Undefined when it cannot be read within a few seconds. Never throws. */
export async function latestVersion(plan: UpdatePlan, fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = 5000): Promise<string | undefined> {
  const l = plan.latest;
  if (!l?.url || l.kind === "none") return undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetcher(l.url, { signal: abort.signal });
    if (!res.ok) return undefined;
    const body = await res.text();
    if (l.kind === "text") return /^\d+\.\d+\.\d+$/.test(body.trim()) ? body.trim() : undefined;
    const json = JSON.parse(body) as Record<string, unknown>;
    if (l.kind === "codex-release") return /^rust-v(\d+\.\d+\.\d+)$/.exec(String(json.tag_name ?? ""))?.[1];
    if (l.kind === "npm") return typeof json.version === "string" ? versionIn(json.version) : undefined;
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a command and gives back what it said and whether it worked. Never throws. */
export type Runner = (command: string, args: string[], o: { env: Record<string, string | undefined>; timeoutMs: number }) => Promise<{ ok: boolean; out: string }>;

export const realRunner: Runner = (command, args, o) =>
  new Promise((resolve) => {
    execFile(command, args, { env: o.env as NodeJS.ProcessEnv, timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${String(stdout)}\n${String(stderr)}` });
    });
  });

/** The version a provider's program says it is now (`<program> --version`). */
export async function installedVersion(executable: string, env: Record<string, string | undefined>, run: Runner = realRunner): Promise<string | undefined> {
  const r = await run(executable, ["--version"], { env, timeoutMs: 20_000 });
  return r.ok ? versionIn(r.out) : undefined;
}

/** One plain sentence about what an update said when it failed: its last line that says something, cut short, with no paths of the home folder. */
export function failureLine(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !/^[\s\-=*#.]+$/.test(l));
  const last = lines.filter((l) => /error|fail|denied|permission|not found|unable|could not|cannot/i.test(l)).pop() ?? lines.pop() ?? "";
  const clean = last.split(homedir()).join("~").slice(0, 200);
  return clean ? `It said: ${clean}` : "It gave no reason.";
}
