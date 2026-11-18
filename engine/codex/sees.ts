// What a helper on a GPT model sees of the person's own Codex setup (docs/sees.md, docs/build/step-helper-sees.md).
//
// A bot's choice (BotSees) is written in the names of its Claude setup. A helper it starts on a GPT
// model runs in `codex app-server`, which starts every MCP server of ~/.codex/config.toml and of the
// Codex plugins for each thread, as processes of their own (measured 16 Nov 2026: about 380 MB a
// helper). This file turns the bot's choice into per-thread config overrides for `thread/start`
// (never written to ~/.codex), the way T3 Code's CodexTextGeneration.ts switches servers off:
//
// - a server of the person's Codex config is off when the choice has it off (by its name, the same
//   name as in his Claude setup where it is in both; a name only Codex has falls on "the rest");
// - Codex's plugins (each may bring servers and skills) are off as a whole when the choice's plugins
//   are "the rest: off": `features.plugins = false`. Plugin ids differ between the two setups, so a
//   single Codex plugin is never named;
// - Codex's apps (the ChatGPT connectors, one server "codex_apps") count as one service of that name;
// - skills are left alone: Codex shows a skill by its name and description until it is opened.
//
// Codex refuses a whole thread that names a server it does not have, so only names it listed are
// switched off. It also refuses one that names a server a Codex plugin brings, which its list shows
// like any other (16 Nov 2026: "messages"); the session then drops that name, remembers it here
// (`unnamable`) and tries again. Everything here but `listCodexMcp` and that memory is pure.
import { spawn } from "node:child_process";
import type { BotSees } from "../../shared/protocol.js";
import { serviceLabel, serviceOn, seesIsEverything, seesParagraph } from "../claude/sees.js";

/** Codex's apps as one service. */
export const CODEX_APPS = "codex_apps";

/** A Codex MCP server as `codex mcp list --json` lists it: only its name and whether it is on. */
export interface CodexMcpServer {
  name: string;
  enabled: boolean;
}

/** The names and switches from `codex mcp list --json`; anything else in it (commands, env) is never kept. */
export function parseMcpList(json: string): CodexMcpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CodexMcpServer[] = [];
  for (const x of raw) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || out.some((s) => s.name === name)) continue;
    out.push({ name, enabled: o.enabled !== false });
  }
  return out;
}

export interface CodexSees {
  /** Overrides for `thread/start`'s `config`. Empty: the thread gets everything, as before. */
  config: Record<string, boolean>;
  /** What was switched off, for the log: server names, "plugins", "apps". */
  off: string[];
}

/** A Codex config key splits on dots; a name with a dot (or none of these characters) cannot be named in one. */
const keyable = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);

/**
 * The thread config for a helper from its bot's choice and the servers Codex listed for its folder.
 * `alsoOn`: services switched on for this one helper (start_helper's `services`).
 */
export function codexSeesConfig(sees: BotSees | undefined, servers: CodexMcpServer[], alsoOn: string[] = []): CodexSees {
  if (!sees || seesIsEverything(sees)) return { config: {}, off: [] };
  const also = new Set(alsoOn.map((n) => n.toLowerCase()));
  const on = (name: string) => also.has(name.toLowerCase()) || serviceOn(sees, name);
  const config: Record<string, boolean> = {};
  const off: string[] = [];
  for (const s of servers) {
    if (!s.enabled || on(s.name) || !keyable(s.name)) continue;
    config[`mcp_servers.${s.name}.enabled`] = false;
    off.push(s.name);
  }
  if (sees.plugins?.rest === "off") {
    config["features.plugins"] = false;
    off.push("plugins");
  }
  if (!on(CODEX_APPS)) {
    config["features.apps"] = false;
    off.push("apps");
  }
  return { config, off };
}

/** The paragraph for a GPT bot's instructions about what its choice switched off in Codex, or "". */
export function codexSeesParagraph(off: string[], how: string): string {
  return seesParagraph(off.map((n) => (n === "plugins" ? "Codex's plugins" : n === "apps" ? "Codex's apps" : serviceLabel(n))), how);
}

/** Servers Codex refused to have named in a thread (a plugin's), for as long as the engine runs. */
const unnamable = new Set<string>();
export const markUnnamable = (name: string): void => void unnamable.add(name);
export const isUnnamable = (name: string): boolean => unnamable.has(name);

/** The server a refused thread named, from Codex's message ("invalid transport in `mcp_servers.x`"), if any. */
export function refusedServer(err: unknown): string | undefined {
  const m = /mcp_servers\.([A-Za-z0-9_-]+)`/.exec(err instanceof Error ? err.message : String(err));
  return m?.[1];
}

/** Lists Codex's MCP servers for a folder with the same program and environment as a helper. Fails to an empty list, never throws. */
export function listCodexMcp(o: { executable: string; args?: string[]; env?: Record<string, string | undefined>; cwd: string; timeoutMs?: number }): Promise<CodexMcpServer[]> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (list: CodexMcpServer[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(list);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.executable, [...(o.args ?? []), "mcp", "list", "--json"], { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, o.timeoutMs ?? 10_000);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString("utf8");
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => finish(code === 0 ? parseMcpList(out) : []));
  });
}
