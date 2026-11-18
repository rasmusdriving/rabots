// What a bot sees (docs/sees.md), the window's side: whether a row is on under a choice, what a
// switch changes in the choice, and the calm summary with what the choice saves. The engine has the
// same rules in engine/claude/sees.ts; the two only meet in the protocol.
import type { BotSees, SeesFrom, SeesInventory } from "../../shared/protocol";

export type SeesPart = "services" | "plugins" | "skills";
const ON_WORD: Record<SeesPart, string> = { services: "on", plugins: "on", skills: "full" };
const OFF_WORD: Record<SeesPart, string> = { services: "off", plugins: "off", skills: "name" };

/** Whether a row is on (in full, for a skill) under the choice. */
export function isOn(sees: BotSees | undefined, part: SeesPart, name: string): boolean {
  const p = sees?.[part];
  if (!p) return true;
  return (p.rest === ON_WORD[part]) !== p.except.includes(name);
}

/** Whether "the rest" of a part is on (in full). */
export function restOn(sees: BotSees | undefined, part: SeesPart): boolean {
  return !sees?.[part] || sees[part]!.rest === ON_WORD[part];
}

/** A part that changes nothing is left out; a choice with no parts is null (everything). */
function tidy(next: BotSees): BotSees | null {
  for (const part of ["services", "plugins", "skills"] as const) {
    const p = next[part];
    if (p && p.rest === ON_WORD[part] && !p.except.length) delete next[part];
  }
  return Object.keys(next).length ? next : null;
}

/** The choice with one row switched. */
export function withRow(sees: BotSees | undefined, part: SeesPart, name: string, on: boolean): BotSees | null {
  const next: BotSees = structuredClone(sees ?? {});
  const p = (next[part] ?? { rest: ON_WORD[part], except: [] }) as { rest: string; except: string[] };
  const restIsOn = p.rest === ON_WORD[part];
  const except = p.except.filter((n) => n !== name);
  if (on !== restIsOn) except.push(name);
  (next as Record<string, unknown>)[part] = { rest: p.rest, except };
  return tidy(next);
}

/** The choice with "the rest" of a part switched. Every row then follows it until switched again. */
export function withRest(sees: BotSees | undefined, part: SeesPart, on: boolean): BotSees | null {
  const next: BotSees = structuredClone(sees ?? {});
  (next as Record<string, unknown>)[part] = { rest: on ? ON_WORD[part] : OFF_WORD[part], except: [] };
  return tidy(next);
}

/** Whether two choices are the same (order of names aside). */
export function sameSees(a: BotSees | null | undefined, b: BotSees | null | undefined): boolean {
  const norm = (s: BotSees | null | undefined) => {
    const t = tidy(structuredClone(s ?? {}));
    if (!t) return "null";
    return JSON.stringify(["services", "plugins", "skills"].map((k) => {
      const p = t[k as SeesPart];
      return p ? [p.rest, [...p.except].sort()] : null;
    }));
  };
  return norm(a) === norm(b);
}

export interface SeesCounts {
  servicesOff: number;
  pluginsOff: number;
  skillsNameOnly: number;
  /** About how many tokens the choice saves on every step. */
  saves: number;
}

/** What the choice leaves out of what exists, and what that saves. */
export function seesCounts(sees: BotSees | undefined, inv: SeesInventory): SeesCounts {
  const offPlugins = new Set(inv.plugins.filter((p) => !isOn(sees, "plugins", p.id)).map((p) => p.id));
  let saves = 0;
  let servicesOff = 0;
  for (const s of inv.services) {
    const off = !isOn(sees, "services", s.name) || (!!s.plugin && offPlugins.has(s.plugin));
    if (!off || s.state !== "connected") continue;
    servicesOff += 1;
    // A plugin's service is counted with its plugin.
    if (!(s.plugin && offPlugins.has(s.plugin))) saves += s.tokens;
  }
  for (const p of inv.plugins) if (offPlugins.has(p.id)) saves += p.tokens;
  let skillsNameOnly = 0;
  for (const k of inv.skills) {
    if (isOn(sees, "skills", k.name)) continue;
    skillsNameOnly += 1;
    saves += Math.max(0, k.tokens - k.nameTokens);
  }
  return { servicesOff, pluginsOff: offPlugins.size, skillsNameOnly, saves };
}

/** "about 9,800 tokens", rounded to a hundred. */
export function tokensWord(n: number): string {
  const r = n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n / 10) * 10;
  return `about ${r.toLocaleString("en-US")} tokens`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The calm line when the part is closed. `tokens: false` (a GPT bot) leaves out what it saves: the figures are Claude's. */
export function seesSummary(sees: BotSees | undefined, inv: SeesInventory | null, o: { tokens?: boolean } = {}): string {
  if (!sees) return "Sees everything";
  if (!inv) {
    const bits: string[] = [];
    // Only when nothing could be read: said from the choice alone, in words that hold either way.
    const but = (n: number) => (n ? ` but ${n}` : "");
    if (sees.services) bits.push(sees.services.rest === "off" ? `all services off${but(sees.services.except.length)}` : count(sees.services.except.length, "service off", "services off"));
    if (sees.plugins) bits.push(sees.plugins.rest === "off" ? `all plugins off${but(sees.plugins.except.length)}` : count(sees.plugins.except.length, "plugin off", "plugins off"));
    if (sees.skills) bits.push(sees.skills.rest === "name" ? `all skills by name only${but(sees.skills.except.length)}` : count(sees.skills.except.length, "skill by name only", "skills by name only"));
    return bits.length ? cap(bits.join(" · ")) : "Sees everything";
  }
  const c = seesCounts(sees, inv);
  const bits: string[] = [];
  if (c.servicesOff) bits.push(count(c.servicesOff, "service off", "services off"));
  if (c.pluginsOff) bits.push(count(c.pluginsOff, "plugin off", "plugins off"));
  if (c.skillsNameOnly) bits.push(count(c.skillsNameOnly, "skill by name only", "skills by name only"));
  if (!bits.length) return "Sees everything on this Mac";
  // Exactly a ready-made set: said in a word first ("Coding set: 10 services off ...").
  const set = inv.sets.find((x) => x.sees && sameSees(x.sees, sees));
  const saves = o.tokens === false ? "" : ` · saves ${tokensWord(c.saves)} on every step`;
  return `${set ? `${set.name} set: ` : ""}${set ? bits.join(" · ") : cap(bits.join(" · "))}${saves}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The closed line as this browser last read it for a bot and a choice (fix 0.26.3). Right after a
 * reload nothing is read yet, and the line built from the choice alone read wrong for a moment
 * ("Services off but 1") and then changed to the real one. Now the line the bot had before the
 * reload stands at once, and the real one, the same words as a rule, takes its place in silence. A
 * convenience only: kept in this browser, and an unreadable store just means no kept line.
 */
const LINE_KEY = "pobots.seesLine.";
const lineFor = (sees: BotSees, tokens: boolean): string => JSON.stringify([sees, tokens]);

export function keptSeesLine(botId: string, sees: BotSees, tokens: boolean): string | undefined {
  try {
    const kept = JSON.parse(localStorage.getItem(LINE_KEY + botId) ?? "null") as { for?: string; line?: string } | null;
    return kept?.for === lineFor(sees, tokens) && typeof kept.line === "string" ? kept.line : undefined;
  } catch {
    return undefined;
  }
}

export function keepSeesLine(botId: string, sees: BotSees, tokens: boolean, line: string): void {
  try {
    localStorage.setItem(LINE_KEY + botId, JSON.stringify({ for: lineFor(sees, tokens), line }));
  } catch {
    // Keeping the line is a convenience only.
  }
}

export const FROM_WORD: Record<SeesFrom, string> = {
  "claude.ai": "claude.ai",
  mac: "This Mac",
  plugin: "Plugin",
  "built-in": "Built in",
  bot: "The bot's folder",
  other: "Other",
};

/** When a read was made, in a few words. */
export function readWhen(iso: string, now = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "Read just now";
  if (min < 60) return `Read ${min} min ago`;
  return `Read ${Math.round(min / 60)} h ago`;
}
