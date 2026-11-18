// change_what_i_see for a bot on a GPT model (docs/sees.md, docs/build/step-gpt-change-sees.md).
//
// Its own Codex session follows its choice by the names Codex has (engine/codex/sees.ts): a server
// of `codex mcp list` for the bot's folder by its name, Codex's plugins as a whole (the rest of
// plugins), Codex's apps as the service codex_apps. So here the names are Codex's, the ones its
// instructions list as off. What does not apply on Codex is said plainly and nothing is changed:
// skills, a single plugin, a service only its Claude setup has. Pure: nothing is saved here.
import type { BotSees, SeesInventory } from "../../shared/protocol.js";
import type { SeesMoves } from "../team.js";
import { cleanSees, pluginName, pluginOn, serviceLabel, seesIsEverything } from "../claude/sees.js";
import { CODEX_APPS, type CodexMcpServer } from "../codex/sees.js";
import type { SeesChange } from "./sees-words.js";

/** The names a GPT bot uses for Codex's plugins and apps, as its instructions say them. */
export const CODEX_PLUGINS_LABEL = "Codex's plugins";
export const CODEX_APPS_LABEL = "Codex's apps";

type Part = { rest: string; except: string[] };
/** A server Codex lists for the bot's folder; `fromPlugin`: one a Codex plugin brings, which follows Codex's plugins. */
export type GptServer = CodexMcpServer & { fromPlugin?: boolean };
type GptThing = { kind: "server"; name: string; label: string } | { kind: "apps" } | { kind: "plugins" };

const low = (s: string) => s.trim().toLowerCase();
const PLUGIN_WORDS = ["codex's plugins", "codexs plugins", "codex plugins", "plugins", "the plugins"];
const APPS_WORDS = ["codex's apps", "codexs apps", "codex apps", "apps", "the apps", CODEX_APPS];

/** The names Codex has for this bot, for an answer: its servers, then Codex's plugins and apps. */
function codexNames(servers: GptServer[]): string {
  return [...servers.filter((s) => s.enabled && !s.fromPlugin && s.name !== CODEX_APPS).map((s) => serviceLabel(s.name)), CODEX_PLUGINS_LABEL, CODEX_APPS_LABEL].join(", ");
}

function gptThing(raw: string, servers: GptServer[], inv: SeesInventory | undefined): GptThing | string {
  const name = raw.trim();
  if (!name) return "A name is empty.";
  const n = low(name);
  if (APPS_WORDS.includes(n)) return { kind: "apps" };
  if (PLUGIN_WORDS.includes(n)) return { kind: "plugins" };
  const svc = servers.find((s) => s.name === name) ?? servers.find((s) => low(s.name) === n || low(serviceLabel(s.name)) === n);
  if (svc) {
    if (svc.fromPlugin) return `${serviceLabel(svc.name)} comes with Codex's plugins, so it goes on and off with "${CODEX_PLUGINS_LABEL}". Nothing changed.`;
    if (!svc.enabled) return `${serviceLabel(svc.name)} is switched off in your Codex setup itself, so Pobots cannot switch it on for you. Nothing changed.`;
    return { kind: "server", name: svc.name, label: serviceLabel(svc.name) };
  }
  const plug = inv?.plugins.find((p) => low(p.id) === n || low(p.name) === n || low(pluginName(p.id)) === n || `the ${low(p.name)} plugin` === n);
  if (plug || name.includes("@") || / plugin$/i.test(name))
    return `On a GPT model a single plugin cannot be switched: Codex's plugins go on or off as a whole, as "${CODEX_PLUGINS_LABEL}". Nothing changed.`;
  const claudeOnly = inv?.services.find((s) => low(s.name) === n || low(s.label) === n);
  if (claudeOnly) return `${claudeOnly.label} is not in your Codex setup, so switching it changes nothing on a GPT model. Nothing changed. Names Codex has for you: ${codexNames(servers)}.`;
  if (!servers.length) return `Codex's list of services for your folder could not be read just now, so ${name} was not found. Nothing changed. Try again in a minute.`;
  return `There is no Codex service called ${name}. Nothing changed. Names Codex has for you: ${codexNames(servers)}.`;
}

/** Puts one name on the wanted side of a part, "the rest and the exceptions". True when it moved. */
function setSide(part: Part, name: string, wantOn: boolean): boolean {
  const on = (part.rest === "on") !== part.except.includes(name);
  if (on === wantOn) return false;
  part.except = part.except.includes(name) ? part.except.filter((x) => x !== name) : [...part.except, name];
  return true;
}

/**
 * Codex's plugins on or off: the rest of plugins (codex/sees.ts turns "the rest: off" into
 * `features.plugins = false`). The single plugins of its Claude setup keep what they were where the
 * last read knows them (they become the exceptions); without a read they follow the rest.
 */
function setPlugins(sees: BotSees, wantOn: boolean, inv: SeesInventory | undefined): boolean {
  const rest = sees.plugins?.rest ?? "on";
  if ((rest === "on") === wantOn) return false;
  const except = (inv?.plugins ?? []).filter((p) => pluginOn(sees, p.id) !== wantOn).map((p) => p.id);
  sees.plugins = { rest: wantOn ? "on" : "off", except };
  return true;
}

/**
 * Applies a GPT bot's moves to its choice, in Codex's names. Returns the new choice (undefined:
 * everything), each change, the names switched on, or a refusal (nothing changed).
 */
export function applyGptSeesMoves(
  current: BotSees | undefined,
  moves: SeesMoves,
  servers: GptServer[],
  inv: SeesInventory | undefined,
): { sees: BotSees | undefined; lines: string[]; changes: SeesChange[]; on: string[] } | string {
  if (moves.skills_in_full?.length || moves.skills_by_name?.length)
    return "Skills are not changed on a GPT model: Codex shows each skill by its name and description until it is opened. Nothing changed.";
  const sees: BotSees = current ? structuredClone(current) : {};
  const changes: SeesChange[] = [];
  const on: string[] = [];
  const toggles: [string[] | undefined, boolean][] = [
    [moves.switch_on, true],
    [moves.switch_off, false],
  ];
  for (const [list, want] of toggles) {
    for (const raw of list ?? []) {
      const t = gptThing(raw, servers, inv);
      if (typeof t === "string") return t;
      let moved: boolean;
      let label: string;
      if (t.kind === "plugins") {
        moved = setPlugins(sees, want, inv);
        label = CODEX_PLUGINS_LABEL;
      } else {
        const part: Part = sees.services ? { ...sees.services } : { rest: "on", except: [] };
        moved = setSide(part, t.kind === "apps" ? CODEX_APPS : t.name, want);
        sees.services = part as BotSees["services"];
        label = t.kind === "apps" ? CODEX_APPS_LABEL : t.label;
      }
      if (!moved) continue;
      const kind = t.kind === "plugins" ? "plugin" : "service";
      changes.push({ kind, to: want ? "on" : "off", name: label, label, words: `${label} ${want ? "on" : "off"} (was ${want ? "off" : "on"})` });
      if (want) on.push(label);
    }
  }
  const cleaned = cleanSees(sees);
  return { sees: cleaned && !seesIsEverything(cleaned) ? cleaned : undefined, lines: changes.map((c) => c.words), changes, on };
}
