// What a bot sees of the person's own Claude Code setup (docs/sees.md, docs/build/step-sees.md).
//
// A bot's choice (BotSees) holds only what differs from "everything, as Claude Code has it", as "the
// rest, and the exceptions". This file cleans a choice, holds the ready-made sets, turns a choice and
// the names last seen on the Mac into the settings for one session (passed through the session's own
// `settings` option, never written to ~/.claude), writes the bot's one paragraph about what is off,
// and builds the inventory from what a short session reported. Everything here is pure.
import type { BotSees, SeesFrom, SeesInventory, SeesPlugin, SeesService, SeesSet, SeesSkill } from "../../shared/protocol.js";

/** Pobots' own tools: never off, and never listed as a service. */
export const POBOTS_SERVER = "pobots";
/** At most this many names in one list, each at most this long. */
export const SEES_NAMES_MAX = 300;
export const SEES_NAME_LEN = 200;

// ------------------------------------------------------------ cleaning a choice

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const name = x.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!name || name.length > SEES_NAME_LEN || out.includes(name)) continue;
    out.push(name);
    if (out.length >= SEES_NAMES_MAX) break;
  }
  return out;
}

const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * A choice as it may be kept: strings trimmed, no doubles, capped. A part with an unknown "rest" is
 * dropped (that part: everything). Nothing left, or not an object: undefined, the same as no choice.
 */
export function cleanSees(raw: unknown): BotSees | undefined {
  const r = asObj(raw);
  if (!r) return undefined;
  const out: BotSees = {};
  const svc = asObj(r.services);
  if (svc && (svc.rest === "on" || svc.rest === "off")) out.services = { rest: svc.rest, except: cleanList(svc.except).filter((n) => n !== POBOTS_SERVER) };
  const plug = asObj(r.plugins);
  if (plug && (plug.rest === "on" || plug.rest === "off")) out.plugins = { rest: plug.rest, except: cleanList(plug.except) };
  const sk = asObj(r.skills);
  if (sk && (sk.rest === "full" || sk.rest === "name")) out.skills = { rest: sk.rest, except: cleanList(sk.except) };
  return Object.keys(out).length ? out : undefined;
}

/** Whether a choice has no effect at all: every part absent, or "the rest" as Claude Code has it and no exceptions. */
export function seesIsEverything(sees: BotSees | undefined): boolean {
  if (!sees) return true;
  return (
    (!sees.services || (sees.services.rest === "on" && !sees.services.except.length)) &&
    (!sees.plugins || (sees.plugins.rest === "on" && !sees.plugins.except.length)) &&
    (!sees.skills || (sees.skills.rest === "full" && !sees.skills.except.length))
  );
}

/** Whether applying the choice needs the names of everything that exists (rule 6): some "rest" is off or by name only. */
export function seesNeedsNames(sees: BotSees | undefined): boolean {
  return !!sees && (sees.services?.rest === "off" || sees.plugins?.rest === "off" || sees.skills?.rest === "name");
}

/** Whether one service, plugin or skill is on (in full) under one part of a choice. */
function onIn(part: { rest: string; except: string[] } | undefined, name: string, onWord: string): boolean {
  if (!part) return true;
  return (part.rest === onWord) !== part.except.includes(name);
}

export const serviceOn = (sees: BotSees | undefined, name: string): boolean => name === POBOTS_SERVER || onIn(sees?.services, name, "on");
export const pluginOn = (sees: BotSees | undefined, id: string): boolean => onIn(sees?.plugins, id, "on");
export const skillInFull = (sees: BotSees | undefined, name: string): boolean => onIn(sees?.skills, name, "full");

// ------------------------------------------------------------ the ready-made sets

/** Named starting points. After one is picked the choice is the bot's own. */
export const SEES_SETS: SeesSet[] = [
  { id: "everything", name: "Everything", hint: "Every service, plugin and skill on this Mac, in full.", sees: null },
  {
    id: "coding",
    name: "Coding",
    hint: "For a bot that writes code: the services and plugins for work are off, and most skills are listed by name only.",
    sees: {
      services: { rest: "off", except: ["plugin:1password:1password"] },
      plugins: { rest: "off", except: ["design@synced", "1password@synced"] },
      skills: {
        rest: "name",
        except: ["code-review", "run", "simplify", "security-review", "claude-api", "browser-use", "screenshot", "security-best-practices", "gh-address-comments", "docs", "pptx", "docx"],
      },
    },
  },
];

// ------------------------------------------------------------ a choice into a session's settings

/** What this feature adds to a Claude session's own `settings` option. */
export interface SeesSessionSettings {
  deniedMcpServers?: { serverName: string }[];
  enabledPlugins?: Record<string, false>;
  skillOverrides?: Record<string, "name-only">;
}

export interface SeesApplied {
  /** Undefined when the choice changes nothing: the session gets nothing from this feature. */
  settings?: SeesSessionSettings;
  /** One short paragraph for the bot's instructions about what is off for it, or "". */
  paragraph: string;
  /** The choice needed the names of everything that exists and none were known: only the exceptions were applied. */
  partial: boolean;
}

/** A readable name: "claude.ai Notion" reads "Notion", "plugin:1password:1password" reads "1password". */
export function serviceLabel(name: string): string {
  if (name.startsWith("claude.ai ")) return name.slice("claude.ai ".length).trim() || name;
  const m = /^plugin:([^:]+):(.+)$/.exec(name);
  if (m) return m[1] === m[2] ? m[1]! : `${m[1]} ${m[2]}`;
  return name;
}

/** The plugin's name from its id: "design@synced" is "design". */
export const pluginName = (id: string): string => id.split("@")[0] || id;

const PARAGRAPH_NAMES = 12;

/** How a bot switches something on again, by role (docs/main-bot.md). */
export const SEES_ON_WORDS = {
  bot: "When you need one, switch it on yourself with change_what_i_see and tell the person you did.",
  main: "When you need one, switch it on with update_bot, your own name and sees, and tell the person you did.",
  /** A GPT bot whose Codex thread began before it had change_what_i_see (team.ts LATE_CODEX_TOOLS). */
  ask: "When you need one, ask the person with ask_human to switch it on for you in your settings in Pobots.",
} as const;

function paragraphFor(services: string[], plugins: string[], how: string): string {
  return seesParagraph([...services.map(serviceLabel), ...plugins.map((p) => `the ${pluginName(p)} plugin`)], how);
}

/** The paragraph about what is off for a bot, from readable names, or "" when nothing is named. */
export function seesParagraph(names: string[], how: string): string {
  if (!names.length) return "";
  const shown = names.slice(0, PARAGRAPH_NAMES).join(", ");
  const more = names.length > PARAGRAPH_NAMES ? ` and ${names.length - PARAGRAPH_NAMES} more` : "";
  return `Switched off for you in Pobots by the person (not broken): ${shown}${more}. ${how}`;
}

/**
 * The settings for one Claude session from a bot's choice and the inventory last read for it (the
 * names of everything that exists). No choice, or one that changes nothing: no settings and no
 * paragraph. Without an inventory only the exceptions that switch something off can be applied.
 */
export function seesSettings(sees: BotSees | undefined, known: SeesInventory | undefined, how: string = SEES_ON_WORDS.bot): SeesApplied {
  if (!sees || seesIsEverything(sees)) return { paragraph: "", partial: false };
  const partial = !known && seesNeedsNames(sees);
  const denied = new Set<string>();
  const plugins = new Set<string>();
  const nameOnly = new Set<string>();
  if (sees.services) {
    const names = sees.services.rest === "on" ? sees.services.except : (known?.services ?? []).map((s) => s.name).filter((n) => !sees.services!.except.includes(n));
    for (const n of names) if (n !== POBOTS_SERVER) denied.add(n);
  }
  if (sees.plugins) {
    const ids = sees.plugins.rest === "on" ? sees.plugins.except : (known?.plugins ?? []).map((p) => p.id).filter((id) => !sees.plugins!.except.includes(id));
    for (const id of ids) plugins.add(id);
  }
  if (sees.skills) {
    const names = sees.skills.rest === "full" ? sees.skills.except : (known?.skills ?? []).map((s) => s.name).filter((n) => !sees.skills!.except.includes(n));
    for (const n of names) nameOnly.add(n);
  }
  const settings: SeesSessionSettings = {};
  if (denied.size) settings.deniedMcpServers = [...denied].map((serverName) => ({ serverName }));
  if (plugins.size) settings.enabledPlugins = Object.fromEntries([...plugins].map((id) => [id, false] as const));
  if (nameOnly.size) settings.skillOverrides = Object.fromEntries([...nameOnly].map((n) => [n, "name-only"] as const));

  // The paragraph names only what the bot would otherwise have had: services that were connected at
  // the last read (or, unread, the ones named as off) and plugins that are off. A plugin's own
  // services go with the plugin and are not named twice.
  const state = new Map((known?.services ?? []).map((s) => [s.name, s] as const));
  const offPlugins = [...plugins].filter((id) => !known || known.plugins.some((p) => p.id === id));
  const offPluginNames = new Set(offPlugins.map(pluginName));
  const offServices = [...denied].filter((n) => {
    const s = state.get(n);
    if (known && (!s || s.state !== "connected")) return false;
    const m = /^plugin:([^:]+):/.exec(n);
    return !(m && offPluginNames.has(m[1]!));
  });
  return { ...(Object.keys(settings).length ? { settings } : {}), paragraph: paragraphFor(offServices, offPlugins, how), partial };
}

// ------------------------------------------------------------ the inventory from a short session

/** What the short session reported: `mcpServerStatus()` and `getContextUsage()`, as loose data. */
export interface RawSees {
  servers: unknown;
  usage: unknown;
}

type Loose = Record<string, unknown>;
const loose = (v: unknown): Loose => asObj(v) ?? {};
const list = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(loose) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
/** A safe name from the Mac: one line, not too long. A name that is not a string is skipped. */
const safeName = (v: unknown): string => str(v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, SEES_NAME_LEN);

/** A server's name as Claude Code writes it inside a tool's name: "claude.ai Notion" is "claude_ai_Notion". */
export const toolServerKey = (server: string): string => server.replace(/[^a-zA-Z0-9_-]/g, "_");

/** About how many tokens a name costs when only the name is sent (a held-back tool, a skill by name only). */
export function nameTokens(name: string): number {
  return Math.ceil(name.length / 2.5) + 2;
}

const SKILL_FROM: Record<string, SeesFrom> = { "built-in": "built-in", bundled: "built-in", userSettings: "mac", syncedSkills: "claude.ai", projectSettings: "bot", localSettings: "bot" };
const STATE: Record<string, SeesService["state"]> = { connected: "connected", "needs-auth": "needs-sign-in", failed: "failed", pending: "failed", disabled: "off" };

/** Builds the inventory from what a short session reported. Odd or missing parts are skipped, never thrown on. */
export function buildInventory(raw: RawSees, readAt: string): SeesInventory {
  const usage = loose(raw.usage);
  const skillsRaw = list(loose(usage.skills).skillFrontmatter);

  // Skills: a plugin's go with the plugin; the rest are listed by name.
  const pluginSkills = new Map<string, { name: string; skills: number; tokens: number }>();
  const skills: SeesSkill[] = [];
  for (const s of skillsRaw) {
    const name = safeName(s.name);
    if (!name) continue;
    const pid = safeName(s.pluginId);
    if (pid || str(s.source) === "plugin") {
      const id = pid || safeName(s.pluginName) || "plugin";
      const p = pluginSkills.get(id) ?? { name: safeName(s.pluginName) || pluginName(id), skills: 0, tokens: 0 };
      p.skills += 1;
      p.tokens += num(s.tokens);
      pluginSkills.set(id, p);
      continue;
    }
    if (skills.some((k) => k.name === name)) continue;
    skills.push({ name, from: SKILL_FROM[str(s.source)] ?? "other", tokens: num(s.tokens), nameTokens: nameTokens(name) });
  }

  // A plugin's id from its name: the id one of its skills gave, else the marketplace most plugins share.
  const markets = new Map<string, number>();
  for (const id of pluginSkills.keys()) {
    const m = id.split("@")[1];
    if (m) markets.set(m, (markets.get(m) ?? 0) + 1);
  }
  const market = [...markets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const idOf = (name: string): string => [...pluginSkills.entries()].find(([, p]) => p.name === name)?.[0] ?? (market ? `${name}@${market}` : name);

  // What each service costs on every step: a held-back tool's name, a loaded tool in full, its
  // instructions. Claude Code names a tool's server as in the tool's name ("claude_ai_Notion") and
  // an instruction's server as configured ("claude.ai Notion"): both are keyed the tool way here.
  const toolTokens = new Map<string, number>();
  const add = (server: string, n: number) => toolTokens.set(toolServerKey(server), (toolTokens.get(toolServerKey(server)) ?? 0) + n);
  for (const t of list(usage.mcpTools)) add(str(t.serverName), t.isLoaded === true ? num(t.tokens) : nameTokens(str(t.name)));
  for (const i of list(usage.mcpInstructions)) add(str(i.serverName), num(i.tokens));

  const services: SeesService[] = [];
  const pluginServices = new Map<string, { services: number; tokens: number }>();
  for (const s of list(raw.servers)) {
    const name = safeName(s.name);
    const source = str(s.source);
    if (!name || name === POBOTS_SERVER || source === "sdk" || services.some((x) => x.name === name)) continue;
    const state = STATE[str(s.status)] ?? "failed";
    const tools = Array.isArray(s.tools) ? s.tools.length : 0;
    const tokens = state === "connected" ? toolTokens.get(toolServerKey(name)) ?? 0 : 0;
    const pm = /^plugin:([^:]+):/.exec(name);
    let from: SeesFrom;
    let plugin: string | undefined;
    if (source === "plugin" || pm) {
      from = "plugin";
      plugin = pm ? idOf(pm[1]!) : undefined;
    } else if (source === "claudeai" || str(s.scope) === "claudeai" || name.startsWith("claude.ai ")) from = "claude.ai";
    else if (source === "user" || source === "local" || source === "project" || source === "dynamic") from = "mac";
    else from = "other";
    services.push({ name, label: serviceLabel(name), from, ...(plugin ? { plugin } : {}), state, tools, tokens });
    if (plugin) {
      const p = pluginServices.get(plugin) ?? { services: 0, tokens: 0 };
      p.services += 1;
      p.tokens += tokens;
      pluginServices.set(plugin, p);
    }
  }

  const plugins: SeesPlugin[] = [];
  for (const id of new Set([...pluginSkills.keys(), ...pluginServices.keys()])) {
    const sk = pluginSkills.get(id);
    const sv = pluginServices.get(id);
    plugins.push({ id, name: sk?.name ?? pluginName(id), skills: sk?.skills ?? 0, services: sv?.services ?? 0, tokens: (sk?.tokens ?? 0) + (sv?.tokens ?? 0) });
  }

  const order = { connected: 0, "needs-sign-in": 1, failed: 2, off: 3 } as const;
  services.sort((a, b) => order[a.state] - order[b.state] || b.tokens - a.tokens || a.label.localeCompare(b.label));
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { services, plugins, skills, sets: SEES_SETS, readAt };
}
