// What a bot sees, through the bots' tools (docs/sees.md, docs/main-bot.md): simple moves a model gets
// right (switch a service or plugin on or off, a skill in full or by name only, a ready-made set) are
// resolved against what exists for the bot and turned into its BotSees. The main bot does it for any
// bot with update_bot; a bot that is not the main bot, on either model, for itself with
// change_what_i_see (on a GPT model in Codex's names, core/gpt-sees-moves.ts). Both happen at once: the bot's access level still decides what a service may do.
import type { BotSees, SeesInventory } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem, type SeesMoves } from "../team.js";
import { cleanSees, nameTokens, pluginName, pluginOn, SEES_SETS, serviceLabel, serviceOn, seesIsEverything, skillInFull } from "../claude/sees.js";
import { EngineError } from "../errors.js";
import { localWhen } from "./words.js";
import { noteChange } from "./notes.js";
import type { SeesChange } from "./sees-words.js";
import { currentPurpose } from "./helpers.js";
import { wake } from "./start-helper.js";
import { applyGptSeesMoves } from "./gpt-sees-moves.js";
import { codexServers } from "./helper-sees.js";
import { isUnnamable } from "../codex/sees.js";

/** `short` is the name in a counted list ("design" for the plugin "the design plugin"). */
type Thing = { kind: "service" | "plugin" | "skill"; name: string; label: string; short: string };

const low = (s: string) => s.trim().toLowerCase();

/** Close names for a refusal: names that hold the word, or start like it. */
function closeTo(word: string, candidates: string[]): string[] {
  const w = low(word);
  const hits = candidates.filter((c) => low(c).includes(w) || w.includes(low(c)) || low(c).slice(0, 3) === w.slice(0, 3));
  return [...new Set(hits)].slice(0, 6);
}

/** A service or plugin by its name, label, id or plugin name; a string is a refusal. */
function toggleThing(inv: SeesInventory | undefined, raw: string): Thing | string {
  const name = raw.trim();
  if (!name) return "A name is empty.";
  if (!inv) return name.includes("@") ? { kind: "plugin", name, label: `the ${pluginName(name)} plugin`, short: pluginName(name) } : { kind: "service", name, label: serviceLabel(name), short: serviceLabel(name) };
  const svc = inv.services.find((s) => s.name === name) ?? inv.services.find((s) => low(s.name) === low(name) || low(s.label) === low(name));
  if (svc) return { kind: "service", name: svc.name, label: svc.label, short: svc.label };
  const plug = inv.plugins.find((p) => p.id === name) ?? inv.plugins.find((p) => low(p.id) === low(name) || low(p.name) === low(name) || low(pluginName(p.id)) === low(name) || `the ${low(p.name)} plugin` === low(name));
  if (plug) return { kind: "plugin", name: plug.id, label: `the ${plug.name} plugin`, short: plug.name };
  const close = closeTo(name, [...inv.services.map((s) => s.label), ...inv.plugins.map((p) => p.name)]);
  return `There is no connected service or plugin called ${name}.${close.length ? ` Close: ${close.join(", ")}.` : ""} get_bot with parts sees lists them.`;
}

function skillThing(inv: SeesInventory | undefined, raw: string): Thing | string {
  const name = raw.trim();
  if (!name) return "A name is empty.";
  if (!inv) return { kind: "skill", name, label: name, short: name };
  const sk = inv.skills.find((s) => s.name === name) ?? inv.skills.find((s) => low(s.name) === low(name));
  if (sk) return { kind: "skill", name: sk.name, label: sk.name, short: sk.name };
  const close = closeTo(name, inv.skills.map((s) => s.name));
  return `There is no skill called ${name} (a plugin's skills go with their plugin).${close.length ? ` Close: ${close.join(", ")}.` : ""}`;
}

type Part = { rest: string; except: string[] };

/** Puts one name on the wanted side of a part, "the rest and the exceptions". True when it moved. */
function setSide(part: Part, name: string, wantOn: boolean, onWord: string): boolean {
  const on = (part.rest === onWord) !== part.except.includes(name);
  if (on === wantOn) return false;
  if (part.except.includes(name)) part.except = part.except.filter((n) => n !== name);
  else part.except = [...part.except, name];
  return true;
}

/**
 * Applies the moves to a bot's choice. Returns the new choice (undefined: everything), every change one
 * by one (`lines`, for the tool's answer; `changes`, which the person's line says in a few words when
 * there are many, core/sees-words.ts), or a refusal. Nothing is saved here.
 */
export function applySeesMoves(
  current: BotSees | undefined,
  moves: SeesMoves,
  inv: SeesInventory | undefined,
): { sees: BotSees | undefined; lines: string[]; changes: SeesChange[]; on: string[] } | string {
  let base: BotSees = current ? structuredClone(current) : {};
  const changes: SeesChange[] = [];
  const on: string[] = [];
  if (moves.start_from !== undefined && moves.start_from.trim()) {
    const set = SEES_SETS.find((s) => low(s.id) === low(moves.start_from!) || low(s.name) === low(moves.start_from!));
    if (!set) return `There is no ready-made set called ${moves.start_from}. Sets: ${SEES_SETS.map((s) => s.id).join(", ")}.`;
    base = set.sees ? structuredClone(set.sees) : {};
    changes.push({ kind: "set", words: set.sees ? `started from the ${set.name} set` : "back to everything" });
  }
  const toggles: [string[] | undefined, boolean][] = [
    [moves.switch_on, true],
    [moves.switch_off, false],
  ];
  for (const [list, want] of toggles) {
    for (const raw of list ?? []) {
      const t = toggleThing(inv, raw);
      if (typeof t === "string") return t;
      const key = t.kind === "service" ? "services" : "plugins";
      const part: Part = (base[key] as Part | undefined) ?? { rest: "on", except: [] };
      if (setSide(part, t.name, want, "on")) {
        changes.push({ kind: t.kind as "service" | "plugin", to: want ? "on" : "off", name: t.short, label: t.label, words: `${t.label} ${want ? "on" : "off"} (was ${want ? "off" : "on"})` });
        if (want) on.push(t.label);
      }
      base[key] = part as BotSees["services"];
    }
  }
  const skills: [string[] | undefined, boolean][] = [
    [moves.skills_in_full, true],
    [moves.skills_by_name, false],
  ];
  for (const [list, full] of skills) {
    for (const raw of list ?? []) {
      const t = skillThing(inv, raw);
      if (typeof t === "string") return t;
      const part: Part = (base.skills as Part | undefined) ?? { rest: "full", except: [] };
      if (setSide(part, t.name, full, "full")) changes.push({ kind: "skill", to: full ? "full" : "name", name: t.name, words: `the skill ${t.name} ${full ? "in full" : "by name only"} (was ${full ? "by name only" : "in full"})` });
      base.skills = part as BotSees["skills"];
    }
  }
  const cleaned = cleanSees(base);
  return { sees: cleaned && !seesIsEverything(cleaned) ? cleaned : undefined, lines: changes.map((c) => c.words), changes, on };
}

/** What exists for the bot: the last read, or a new one (a few seconds, no model call). */
export async function inventoryFor(eng: Engine, target: BotRuntime): Promise<{ inventory?: SeesInventory; problem?: string }> {
  const known = eng.seesHub.known(target.folder.id);
  if (known) return { inventory: known };
  const r = await eng.seesInventory({ botId: target.folder.id });
  return { ...(r.inventory ? { inventory: r.inventory } : {}), ...(r.problem ? { problem: r.problem } : {}) };
}

/** A bot's choice in plain words, with what exists and what each thing costs (get_bot). */
export function seesWords(eng: Engine, target: BotRuntime, inv: SeesInventory | undefined, why?: string): string {
  const f = target.folder.file;
  const sees = f.sees;
  const head = f.harness === "codex" ? `${f.name} runs on a GPT model: its Codex servers follow this choice by name (any other follows the rest of services), Codex's apps count as the service codex_apps, Codex's plugins are off when the rest of plugins is off, and skills are not changed.\n` : "";
  const part = (label: string, p: { rest: string; except: string[] } | undefined, restWords: Record<string, string>, exceptWord: string) =>
    p ? `${label}: the rest ${restWords[p.rest] ?? p.rest}${p.except.length ? `, ${exceptWord}: ${p.except.join(", ")}` : ""}.` : `${label}: all.`;
  const choice = seesIsEverything(sees)
    ? `${f.name} sees everything.`
    : [
        part("Services", sees?.services, { on: "on", off: "off" }, sees?.services?.rest === "on" ? "off" : "on"),
        part("Plugins", sees?.plugins, { on: "on", off: "off" }, sees?.plugins?.rest === "on" ? "off" : "on"),
        part("Skills", sees?.skills, { full: "in full", name: "by name only" }, sees?.skills?.rest === "full" ? "by name only" : "in full"),
      ].join(" ");
  if (!inv) return `${head}${choice}\nWhat exists could not be read${why ? `: ${why}` : ""}.`;
  let saves = 0;
  const svc = inv.services.map((s) => {
    const isOn = serviceOn(sees, s.name);
    if (!isOn && s.state === "connected") saves += s.tokens;
    return `- ${s.label} (${s.name}): ${isOn ? "on" : "off"}, ${s.state}${s.plugin ? `, from the plugin ${s.plugin}` : ""}, ${s.tokens} tokens`;
  });
  const plug = inv.plugins.map((p) => {
    const isOn = pluginOn(sees, p.id);
    if (!isOn) saves += p.tokens;
    return `- ${p.name} (${p.id}): ${isOn ? "on" : "off"}, ${p.skills} skills, ${p.services} services, ${p.tokens} tokens`;
  });
  const skills = inv.skills.map((s) => {
    const full = skillInFull(sees, s.name);
    if (!full) saves += Math.max(0, s.tokens - (s.nameTokens || nameTokens(s.name)));
    return `- ${s.name}: ${full ? "in full" : "by name only"}, ${s.tokens} tokens (by name ${s.nameTokens})`;
  });
  return [
    `${head}${choice}${saves ? ` Saves about ${saves} tokens on every step.` : ""}`,
    `Connected services (tokens on every step):\n${svc.join("\n") || "none"}`,
    `Plugins:\n${plug.join("\n") || "none"}`,
    `Skills that are not a plugin's:\n${skills.join("\n") || "none"}`,
    `Ready-made sets for start_from: ${SEES_SETS.map((s) => `${s.id} (${s.hint})`).join("; ")}`,
    `Read ${localWhen(eng, inv.readAt)} (${eng.tz}).`,
  ].join("\n\n");
}

/**
 * change_what_i_see: a bot that is not the main bot changes what it sees itself. On a GPT model the
 * names are Codex's (core/gpt-sees-moves.ts), and the change holds from its next turn on the same
 * Codex thread, which is resumed with the new config (docs/build/step-gpt-change-sees.md).
 * At once both ways, and both ways leave a quiet line in its own chat saying what changed, from what to
 * what. Switching a service or plugin on also gives the bot a turn of its own after this one, in a
 * session that has it (no cards inside Pobots; the bot only gets what the person's
 * own setup already has).
 */
export async function changeWhatISeeFor(eng: Engine, rt: BotRuntime, moves: SeesMoves): Promise<ToolResult> {
  if (rt.folder.file.role === "main") return problem("Use update_bot with your own name and sees.");
  const gpt = rt.folder.file.harness === "codex";
  const r = gpt ? await gptMoves(eng, rt, moves) : applySeesMoves(rt.folder.file.sees, { ...moves, start_from: undefined }, (await inventoryFor(eng, rt)).inventory);
  if (typeof r === "string") return problem(r);
  if (!r.lines.length) return ok("Nothing changed: it was like that already.");
  try {
    await eng.updateBot({ botId: rt.folder.id, patch: { sees: r.sees ?? null } });
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The change could not be saved.");
  }
  // A quiet line in its own chat, both ways, when its turn ends (core/notes.ts).
  noteChange(eng, rt, `sees:${rt.folder.id}`, `${rt.folder.file.name} changed what it sees`, [{ sees: r.changes, prefix: "" }]);
  if (r.on.length) {
    // The session takes the change when it starts again after this turn; this turn of its own carries on.
    if (rt.busy) wake(eng, rt, { text: `Note from Pobots: ${r.on.join(", ")} ${r.on.length === 1 ? "is" : "are"} switched on for you now, as you asked. Carry on with what you needed ${r.on.length === 1 ? "it" : "them"} for.`, purpose: currentPurpose(eng, rt) });
  }
  return ok(
    `Changed what you see: ${r.lines.join("; ")}. It holds from your next turn${r.on.length ? "; Pobots starts your session again after this turn and gives you a turn of your own to carry on, so end this turn now" : ""}.`,
  );
}

/** A GPT bot's moves, against the servers Codex lists for its folder and the last read of its Claude setup (for plain refusals). */
async function gptMoves(eng: Engine, rt: BotRuntime, moves: SeesMoves): Promise<ReturnType<typeof applyGptSeesMoves>> {
  const servers = (await codexServers(eng, rt.folder.dir)).map((s) => ({ ...s, fromPlugin: isUnnamable(s.name) }));
  return applyGptSeesMoves(rt.folder.file.sees, { ...moves, start_from: undefined }, servers, eng.seesHub.known(rt.folder.id));
}
