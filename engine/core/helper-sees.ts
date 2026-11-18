// What a helper sees (docs/sees.md, docs/build/step-helper-sees.md): a start_helper helper, a task
// manager's worker and a task manager itself get the same services, plugins and skills as the bot
// that started it, on a Claude model and on a GPT model. start_helper's `services` switches named
// services on for that one helper only; the bot's own choice is not changed.
import type { BotSees, Harness } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { SessionSettings } from "../claude/session.js";
import { cleanSees, POBOTS_SERVER, SEES_NAME_LEN, seesIsEverything, seesSettings } from "../claude/sees.js";
import { type CodexMcpServer, type CodexSees, codexSeesConfig, isUnnamable, listCodexMcp } from "../codex/sees.js";
import { log } from "../log.js";

/** At most this many names in start_helper's `services`. */
export const ALSO_ON_MAX = 20;

/** How long Codex's list of servers for a folder is kept. */
const CODEX_LIST_TTL_MS = 5 * 60_000;

/** Lists Codex's MCP servers for a folder (EngineOptions.listCodexMcp; tests pass their own). */
export type CodexMcpLister = (o: { executable: string; args?: string[]; env?: Record<string, string | undefined>; cwd: string }) => Promise<CodexMcpServer[]>;

/** The choice with these services on as well. Names already on, and Pobots' own, change nothing. */
export function withAlsoOn(sees: BotSees | undefined, names: string[]): BotSees | undefined {
  if (!sees?.services || !names.length) return sees;
  const want = names.filter((n) => n !== POBOTS_SERVER);
  const { rest, except } = sees.services;
  const next = rest === "on" ? except.filter((n) => !want.includes(n)) : [...new Set([...except, ...want])];
  return cleanSees({ ...sees, services: { rest, except: next } });
}

/**
 * start_helper's `services`, cleaned and matched to the names the bot's setup uses: a label
 * ("Notion") becomes its name ("claude.ai Notion") when the last read knows it. Others are kept as
 * given: a name only Codex has is matched there.
 */
export function alsoOnNames(eng: Engine, rt: BotRuntime, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const known = eng.seesHub.known(rt.folder.id);
  const low = (s: string) => s.trim().toLowerCase();
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const name = x.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!name || name.length > SEES_NAME_LEN) continue;
    const svc = known?.services.find((s) => s.name === name) ?? known?.services.find((s) => low(s.name) === low(name) || low(s.label) === low(name));
    const got = svc?.name ?? name;
    if (!out.includes(got)) out.push(got);
    if (out.length >= ALSO_ON_MAX) break;
  }
  return out;
}

/** Codex's list for a folder, kept a few minutes per engine; one listing shared by calls that come at once. */
const codexLists = new WeakMap<Engine, Map<string, { at: number; list: Promise<CodexMcpServer[]> }>>();

export function codexServers(eng: Engine, cwd: string): Promise<CodexMcpServer[]> {
  // With stand-in sessions and no lister given, the real Codex is never asked (as with readSees).
  const lister: CodexMcpLister | undefined = eng.opts.listCodexMcp ?? (eng.opts.createSession ? undefined : listCodexMcp);
  if (!lister) return Promise.resolve([]);
  let kept = codexLists.get(eng);
  if (!kept) codexLists.set(eng, (kept = new Map()));
  const now = Date.now();
  const k = kept.get(cwd);
  if (k && now - k.at < CODEX_LIST_TTL_MS) return k.list;
  const list = lister({ executable: eng.codex.executable ?? "codex", args: eng.codex.args ?? [], env: eng.codex.env, cwd }).catch(() => []);
  kept.set(cwd, { at: now, list });
  // An empty answer (Codex busy, or it failed) is asked again next time.
  void list.then((l) => {
    if (!l.length && kept.get(cwd)?.list === list) kept.delete(cwd);
  });
  return list;
}

/**
 * The Codex thread config from a bot's choice (with `alsoOn` switched on as well) and the servers
 * Codex lists for `dir`, and what it switches off. Shared by helpers and the bot's own session
 * (docs/build/step-gpt-bot-sees.md). No choice, or one that changes nothing: empty.
 */
export async function codexSeesFor(eng: Engine, rt: BotRuntime, dir: string, alsoOn: string[] = [], what = "a helper"): Promise<CodexSees> {
  const sees = withAlsoOn(rt.folder.file.sees, alsoOn);
  if (!sees || seesIsEverything(sees)) return { config: {}, off: [] };
  const servers = (await codexServers(eng, dir)).filter((x) => !isUnnamable(x.name));
  const r = codexSeesConfig(sees, servers, alsoOn);
  if (r.off.length) log.info(`Bot ${rt.folder.id}: ${what} on a GPT model follows the bot's choice; off for it: ${r.off.join(", ")}`);
  return r;
}

/**
 * What a helper's session gets of its bot's choice: for Claude the settings (with the names last read
 * for the bot), for Codex the thread config, worked out when the session boots. No choice, or one that
 * changes nothing: nothing, exactly as before.
 */
export function helperSees(eng: Engine, rt: BotRuntime, harness: Harness, dir: string, alsoOn: string[] = [], what = "a helper"): Pick<SessionSettings, "sees" | "codexConfig"> {
  const sees = withAlsoOn(rt.folder.file.sees, alsoOn);
  if (!sees || seesIsEverything(sees)) return {};
  if (harness === "claude") {
    const s = seesSettings(sees, eng.seesHub.known(rt.folder.id)).settings;
    return s ? { sees: s } : {};
  }
  return { codexConfig: async () => (await codexSeesFor(eng, rt, dir, alsoOn, what)).config };
}
