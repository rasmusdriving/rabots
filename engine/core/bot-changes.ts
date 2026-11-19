// The main bot makes, changes and retires bots (docs/build/step-main-bot-tools.md, docs/main-bot.md).
// Everything happens at once and the person gets one quiet line per bot per turn saying what changed, from
// what to what. One thing stays on a card: giving a bot more access, because the access level decides
// whether that bot asks before it acts outside Pobots (decided 15 Nov 2026).
import { away, vacationNeedsStop } from "./vacation.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { ACCESS_LEVELS, type AccessLevel, type Methods } from "../../shared/protocol.js";
import { accessLabel, cleanName, cleanPurpose, refused } from "./words.js";
import { type CreateBotArgs, ok, problem, type UpdateBotArgs } from "../team.js";
import type { ToolResult } from "../claude/session.js";
import { DEFAULT_ACCESS, DEFAULT_EFFORT, DEFAULT_MODEL, jobSection, pickLook, replaceJobSection } from "../bots.js";
import { EngineError } from "../errors.js";
import { approval } from "./cards.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedTitle, noteChange, type NotePart, quoted, wordCount } from "./notes.js";
import { resolveBotRefs } from "./main-bot-tools.js";
import { applySeesMoves, inventoryFor } from "./sees-tools.js";

const rank = (a: AccessLevel) => ACCESS_LEVELS.findIndex((x) => x.id === a);
/** True when `to` lets the bot do more without asking than `from`. */
export const raisesAccess = (from: AccessLevel, to: AccessLevel): boolean => rank(to) > rank(from);

const errText = (err: unknown, fallback: string) => (err instanceof EngineError || err instanceof Error ? err.message : fallback);

/** The one card: more access for a bot. On yes the access is set; the person's line says so. */
async function askMoreAccess(eng: Engine, rt: BotRuntime, target: BotRuntime, to: AccessLevel, signal?: AbortSignal): Promise<string> {
  const f = target.folder.file;
  const from = f.access;
  const detail = [
    `${f.name}: from ${accessLabel(from)} to ${accessLabel(to)}.`,
    "",
    ACCESS_LEVELS.find((a) => a.id === to)?.hint ?? "",
    "",
    `Asked by ${rt.folder.file.name}. The access level decides whether ${f.name} asks you before it acts outside Pobots, such as sending an email.`,
  ].join("\n");
  const decision = await approval(eng, rt, { title: `Give ${f.name} more access?`, detail, caption: "More access" }, signal);
  if (decision !== "allow") return refused(decision, "the access was not raised").content[0]!.text;
  if (!eng.bots.has(target.folder.id)) return `${f.name} was retired in the meantime.`;
  try {
    await eng.updateBot({ botId: target.folder.id, patch: { access: to } });
  } catch (err) {
    return `The access could not be raised: ${errText(err, "something went wrong")}`;
  }
  noteChange(eng, rt, `bot:${target.folder.id}`, changedTitle(target), [`access from ${accessLabel(from)} to ${accessLabel(to)}, as you allowed`]);
  return `The person allowed it: ${f.name} is on ${accessLabel(to)} now.`;
}

/** create_bot: at once with a quiet line. Access above "Asks first" starts on "Asks first" and is asked on a card. */
export async function createBotFor(eng: Engine, rt: BotRuntime, args: CreateBotArgs, signal?: AbortSignal): Promise<ToolResult> {
  let name: string;
  let purpose: string;
  let may: string[];
  try {
    name = cleanName(args.name);
    purpose = cleanPurpose(args.purpose);
    may = resolveBotRefs(eng, args.may_message ?? []);
  } catch (err) {
    return problem(errText(err, "The bot could not be made."));
  }
  const job = args.job.trim();
  if (!job) return problem("The new bot needs a job: a few plain sentences about what it does.");
  const model = args.model?.trim() || DEFAULT_MODEL;
  const effort = args.effort ?? DEFAULT_EFFORT;
  const wanted = args.access ?? DEFAULT_ACCESS;
  // Fast mode (step 3b): refused for a model without one; false there is taken without a word and changes nothing.
  const fastModel = eng.hasFast(model);
  if (args.fast === true && !fastModel) return problem(`${eng.modelLabel(model)} has no fast mode. Leave fast out.`);
  const fast = fastModel ? args.fast !== false : true;
  const raise = raisesAccess(DEFAULT_ACCESS, wanted);
  let bot: ReturnType<Engine["createBot"]>;
  try {
    const look = args.color ? { ...pickLook([...eng.bots.values()].map((b) => b.folder.file.look)), color: args.color } : undefined;
    bot = eng.createBot({ name, purpose, job, model, effort, fast, access: raise ? DEFAULT_ACCESS : wanted, ...(look ? { look } : {}), mayMessage: may.filter((id) => eng.bots.has(id)) });
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The bot could not be created.");
  }
  const lines = [
    `purpose ${quoted(purpose)}`,
    `${eng.modelLabel(model)}, ${effort} effort${fastModel ? `, fast ${fast ? "on" : "off"}` : ""}`,
    `access ${accessLabel(bot.access)}`,
    `may message ${may.length ? may.map((id) => eng.nameOf(id)).join(", ") : "only the main bot"}`,
    `job written (${wordCount(job)})`,
  ];
  noteChange(eng, rt, `bot:${bot.id}`, `New bot ${bot.name}`, lines, true);
  let more = "";
  if (raise) {
    const target = eng.bots.get(bot.id);
    more = target ? ` It starts on ${accessLabel(DEFAULT_ACCESS)}; ${accessLabel(wanted)} was asked on a card. ${await askMoreAccess(eng, rt, target, wanted, signal)}` : "";
  }
  return ok(`Created ${bot.name} (id ${bot.id}). It is on the roster now, and the person has a note about it.${more}`);
}

/** update_bot: every part at once with one note; raising access alone waits for its card. */
export async function updateBotFor(eng: Engine, rt: BotRuntime, args: UpdateBotArgs, signal?: AbortSignal): Promise<ToolResult> {
  const target = eng.findBot(args.bot);
  if (!target) return problem(`There is no bot called ${args.bot}. Use list_bots to see the others.`);
  const self = target === rt;
  if (args.vacation !== undefined) {
    if (target.folder.file.role === "main" || rt.folder.file.role !== "main") return problem("Only the main bot can change another bot’s vacation.");
    if (args.start_fresh) return problem("Change vacation and ask for a fresh session in separate calls.");
    if (args.vacation && !away(target) && vacationNeedsStop(eng, target)) {
      return problem(`${target.folder.file.name} is working or has messages waiting. Stop its helper with stop_helper or ask the person to press Stop. If messages still wait, the person can stop it and send it on vacation from its settings.`);
    }
  }
  if (self && args.may_message !== undefined) return problem("You may message every bot already, so you have no list of bots to change. Leave out may_message.");
  if (self && args.may_steer !== undefined) return problem("As the main bot you may always steer other bots, so there is nothing to change. Leave out may_steer.");
  const f = target.folder.file;
  const name = f.name;
  // Named as it was before a rename in this call.
  const title = changedTitle(target);
  const patch: Methods["bot.update"]["params"]["patch"] = {};
  const lines: string[] = [];
  /** The person's shorter part for a line of the tool's answer (what it sees). */
  const shortFor = new Map<string, NotePart>();
  const forPerson = (parts: string[]) => parts.map((p) => shortFor.get(p) ?? p);
  let raiseTo: AccessLevel | undefined;
  try {
    if (args.name !== undefined) {
      const n = cleanName(args.name);
      if (n !== f.name) {
        patch.name = n;
        lines.push(`name from ${f.name} to ${n}`);
      }
    }
    if (args.purpose !== undefined) {
      const purpose = cleanPurpose(args.purpose);
      if (purpose !== f.purpose) {
        patch.purpose = purpose;
        lines.push(`purpose from ${quoted(f.purpose)} to ${quoted(purpose)}`);
      }
    }
    const nextModel = args.model !== undefined && args.model.trim() ? args.model.trim() : f.model;
    // Fast mode (step 3b): refused for a model (after the change) without one; false there changes nothing.
    const fastModel = eng.hasFast(nextModel);
    if (args.fast === true && !fastModel) return problem(`${eng.modelLabel(nextModel)} has no fast mode. Leave fast out.`);
    const nextFast = fastModel && args.fast !== undefined ? args.fast : f.fast;
    if (nextModel !== f.model) {
      patch.model = nextModel;
      const gains = fastModel && !eng.hasFast(f.model);
      if (gains) patch.fast = nextFast;
      lines.push(`model from ${eng.modelLabel(f.model)} to ${eng.modelLabel(nextModel)}${gains ? `, fast ${nextFast ? "on" : "off"}` : ""}`);
    }
    if (args.effort !== undefined && args.effort !== f.effort) {
      patch.effort = args.effort;
      lines.push(`effort from ${f.effort} to ${args.effort}`);
    }
    if (nextFast !== f.fast) {
      patch.fast = nextFast;
      if (fastModel && eng.hasFast(f.model)) lines.push(`fast from ${f.fast ? "on" : "off"} to ${nextFast ? "on" : "off"}`);
    }
    if (args.access !== undefined && args.access !== f.access) {
      if (raisesAccess(f.access, args.access)) raiseTo = args.access;
      else {
        patch.access = args.access;
        lines.push(`access from ${accessLabel(f.access)} to ${accessLabel(args.access)}`);
      }
    }
    const color = args.color ?? f.look.color;
    const eyes = args.eyes ?? f.look.eyes;
    const gap = args.eye_gap ?? f.look.gap;
    if (color !== f.look.color || eyes !== f.look.eyes || gap !== f.look.gap) {
      patch.look = { eyes, gap, ...(color ? { color } : {}) };
      if (color !== f.look.color) lines.push(`colour from ${f.look.color ?? "grey"} to ${color}`);
      if (eyes !== f.look.eyes) lines.push(`eyes from ${f.look.eyes} to ${eyes}`);
      if (gap !== f.look.gap) lines.push(`gap between the eyes from ${f.look.gap} to ${gap}`);
    }
    if (args.may_message !== undefined) {
      const may = resolveBotRefs(eng, args.may_message).filter((id) => id !== target.folder.id);
      if (may.join(",") !== f.mayMessage.join(",")) {
        patch.mayMessage = may;
        const names = (ids: string[]) => (ids.length ? ids.map((id) => eng.nameOf(id)).join(", ") : "only the main bot");
        lines.push(`may message from ${names(f.mayMessage)} to ${names(may)}`);
      }
    }
    const calendarNow = f.calendar ?? f.role === "main";
    if (args.calendar !== undefined && args.calendar !== calendarNow) {
      patch.calendar = args.calendar;
      lines.push(`calendar from ${calendarNow ? "on" : "off"} to ${args.calendar ? "on" : "off"}`);
    }
    if (args.may_steer !== undefined && args.may_steer !== (f.maySteer === true)) {
      patch.maySteer = args.may_steer;
      lines.push(`may steer other bots from ${f.maySteer ? "on" : "off"} to ${args.may_steer ? "on" : "off"}`);
    }
  } catch (err) {
    return problem(errText(err, "The change could not be made."));
  }
  if (args.sees) {
    const { inventory, problem: why } = await inventoryFor(eng, target);
    const r = applySeesMoves(f.sees, args.sees, inventory);
    if (typeof r === "string") return problem(r);
    if (r.lines.length || JSON.stringify(r.sees ?? null) !== JSON.stringify(f.sees ?? null)) {
      patch.sees = r.sees ?? null;
      // The tool's answer names every switch; the person's line says many in a few words (core/sees-words.ts).
      const full = `what it sees: ${r.lines.join(", ") || "tidied"}`;
      lines.push(full);
      shortFor.set(full, { sees: r.changes, prefix: "what it sees" });
    }
    if (!inventory && why) lines.push("names were taken as given, because what exists could not be read");
  }
  // Rules to forget: checked before anything changes.
  const rules = eng.listRules(target.folder.id);
  const forget = args.forget_rules?.some((r) => r.trim().toLowerCase() === "all") ? rules : rules.filter((r) => args.forget_rules?.includes(r.id));
  const unknown = (args.forget_rules ?? []).filter((id) => id.trim().toLowerCase() !== "all" && !rules.some((r) => r.id === id));
  if (unknown.length) return problem(`${name} has no rule with the id ${unknown.join(", ")}. get_bot with parts rules lists them.`);
  if (args.start_fresh && self && rt.busy) return problem("You cannot start yourself fresh while you work. The person can, or it happens by itself when your session is full.");
  const job = args.job?.trim();
  let current = "";
  try {
    current = readFileSync(join(target.folder.dir, "AGENTS.md"), "utf8");
  } catch {
    current = "";
  }
  const jobChanges = job !== undefined && job !== "" && job !== (jobSection(current) ?? "");
  const vacationChanges = args.vacation !== undefined && args.vacation !== away(target);
  if (!lines.length && !jobChanges && !forget.length && !args.start_fresh && !raiseTo && !vacationChanges) return problem("Nothing would change.");

  // At once: the settings, the job, the rules, a fresh start. A failure stops what follows it.
  const done: string[] = [];
  try {
    if (Object.keys(patch).length) {
      await eng.updateBot({ botId: target.folder.id, patch });
      done.push(...lines);
    }
    if (jobChanges) {
      const text = current || `# ${f.name}\n`;
      eng.writeFile({ botId: target.folder.id, path: "AGENTS.md", text: replaceJobSection(text, job!) }, "app", `${rt.folder.file.name} rewrote the job`);
      done.push(`job rewritten (${wordCount(job!)})`);
    }
    for (const r of forget) {
      eng.removeRule(r.id);
      done.push(`forgot the Always allowed rule ${quoted(r.label, 60)}`);
    }
    if (vacationChanges && args.vacation !== undefined) {
      eng.setVacation({ botId: target.folder.id, vacation: args.vacation });
      done.push(args.vacation ? "sent on vacation" : "back from vacation");
    }
    if (args.start_fresh) {
      const { started } = eng.startFresh(target.folder.id);
      done.push(started ? "started a fresh session" : "a fresh start was asked, but it has no session yet");
    }
  } catch (err) {
    noteChange(eng, rt, `bot:${target.folder.id}`, title, forPerson(done));
    const why = errText(err, "The change could not be made.");
    return problem(done.length ? `${why} These changed before that: ${done.join("; ")}.` : why);
  }
  noteChange(eng, rt, `bot:${target.folder.id}`, title, forPerson(done));
  const parts = [done.length ? `Changed ${patch.name ?? name}, and the person has a note about it:\n- ${done.join("\n- ")}` : ""];
  if (raiseTo) parts.push(`More access (${accessLabel(raiseTo)}) was asked on a card. ${await askMoreAccess(eng, rt, target, raiseTo, signal)}`);
  return ok(parts.filter(Boolean).join("\n\n"));
}

/** retire_bot: at once with a quiet line. Its folder is archived and its chat kept. */
export function retireBotFor(eng: Engine, rt: BotRuntime, args: { bot: string }): ToolResult {
  const target = eng.findBot(args.bot);
  if (!target) return problem(`There is no bot called ${args.bot}. Use list_bots to see the others.`);
  if (target.folder.file.role === "main") return problem("The main bot cannot be retired this way.");
  const f = target.folder.file;
  try {
    eng.retireBot(target.folder.id);
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The bot could not be retired.");
  }
  noteChange(eng, rt, `bot:${target.folder.id}`, `Retired ${f.name}`, [`purpose was ${quoted(f.purpose)}`, "its folder is in the archive and its chat is kept"], true);
  return ok(`Retired ${f.name}. Its folder is in the archive, and the person has a note about it.`);
}
