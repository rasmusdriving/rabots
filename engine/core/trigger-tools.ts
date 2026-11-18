// Triggers: the bots' own tools (list, set and remove schedules and webhooks, and a webhook's address).
// The main bot works on any bot's triggers at once and the person gets a quiet line
// (docs/build/step-main-bot-tools.md); a bot that is not the main bot keeps its cards for making,
// changing and removing its own webhooks. A webhook's address goes to the bot that made it or asks for
// it again, so it can set up the sender (decision of 12 Nov 2026), in the tool's answer and nowhere
// else: the person's line says who got which address, never the address itself.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { describeSchedule, nowWords, whenWords } from "../schedule.js";
import type { Methods, Schedule, Trigger, TriggerRun } from "../../shared/protocol.js";
import { clip, refused } from "./words.js";
import { ok, problem, type SetScheduleArgs, type SetWebhookArgs } from "../team.js";
import type { ToolResult } from "../claude/session.js";
import type { TriggerRow } from "../store.js";
import { cleanPrompt, cleanSchedule, cleanTriggerName, hookPath, MAX_TRIGGERS } from "../triggers.js";
import { EngineError } from "../errors.js";
import { approval } from "./cards.js";
import { changedTitle, noteChange, quoted } from "./notes.js";

/** The bot a schedule tool works on: the bot itself, or (for the main bot) another bot it names. A string is a refusal. */
export function toolTarget(eng: Engine, rt: BotRuntime, ref: string | undefined): BotRuntime | string {
  if (ref === undefined || !ref.trim()) return rt;
  const t = eng.findBot(ref);
  if (!t) return `There is no bot called ${ref}. Use list_bots to see the others.`;
  if (t !== rt && rt.folder.file.role !== "main") return "Only the main bot can work on another bot's schedules and webhooks.";
  return t;
}

const isMain = (rt: BotRuntime) => rt.folder.file.role === "main";

/** The key and title of the person's line about webhook addresses a bot was given. Never holds an address. */
function addressNote(eng: Engine, rt: BotRuntime, line: string): void {
  noteChange(eng, rt, `address:${rt.folder.id}`, "", [line]);
}

const STATUS_WORDS: Record<TriggerRun["status"], string> = { running: "running", done: "done", silent: "nothing to report", skipped: "skipped", failed: "failed" };

export function listTriggersFor(eng: Engine, rt: BotRuntime, args: { bot?: string; runs?: string } = {}): string {
  const target = toolTarget(eng, rt, args.bot);
  if (typeof target === "string") return target;
  const own = target === rt;
  const name = target.folder.file.name;
  const at = eng.clock();
  const head = `It is now ${nowWords(at, eng.tz)} (time zone ${eng.tz}).${own ? "" : ` These are the triggers of ${name}.`}`;
  if (args.runs !== undefined && args.runs.trim()) return runsWords(eng, target, args.runs.trim(), head);
  const rows = eng.store.listTriggers(target.folder.id);
  if (!rows.length) return own ? `${head} You have no triggers yet.` : `${head} ${name} has no triggers yet.`;
  const lines = rows.map((row) => {
    const when = row.kind === "schedule" && row.schedule ? describeSchedule(row.schedule, eng.tz) : "When its webhook is called by another system";
    const next = row.kind === "schedule" && row.enabled && row.nextAt ? ` Next run ${whenWords(Date.parse(row.nextAt), at, eng.tz)}.` : "";
    const last = eng.store.lastRun(row.id);
    const lastWords = last ? `${STATUS_WORDS[last.status]} ${whenWords(Date.parse(last.at), at, eng.tz)}${last.note ? `: ${last.note}` : ""}` : "none yet";
    const where = row.where === "main" ? (own ? "in your main chat" : "in its main chat") : "as a fresh run";
    const by = row.createdBy === "bot" ? (own ? "you" : "a bot") : "the person";
    return [
      `- ${row.name} (id ${row.id}, ${row.kind}). ${when}.`,
      `Runs ${where}. ${row.enabled ? "On" : "Off"}.${next}`,
      `Made by ${by}.`,
      `Told: "${clip(row.prompt, 300)}"`,
      `Last run: ${lastWords}.`,
    ].join(" ");
  });
  return [head, ...lines].join("\n");
}

/** list_triggers runs: one trigger's last ten runs (the main bot). */
function runsWords(eng: Engine, target: BotRuntime, id: string, head: string): string {
  const row = eng.store.getTrigger(id);
  if (!row || row.botId !== target.folder.id) return `${target.folder.file.name} has no trigger with that id. Use list_triggers to see its triggers.`;
  const { runs } = eng.triggerRuns({ triggerId: row.id, limit: 10 });
  if (!runs.length) return `${head} ${row.name} has not run yet.`;
  const at = eng.clock();
  return [`${head} The last runs of ${row.name}, newest first:`, ...runs.map((r) => `- ${STATUS_WORDS[r.status]} ${whenWords(Date.parse(r.at), at, eng.tz)}${r.note ? `: ${clip(r.note, 200)}` : ""}`)].join("\n");
}

function noTrigger(own: boolean, name: string): ToolResult {
  return problem(own ? "You have no trigger with that id. Use list_triggers to see yours." : `${name} has no trigger with that id. Use list_triggers with bot ${name} to see its triggers.`);
}

/** What changed between a trigger as it was and as it is now, for the person's line. */
function triggerChanges(eng: Engine, before: TriggerRow, after: Trigger): string[] {
  const kind = before.kind === "schedule" ? "schedule" : "webhook";
  const out: string[] = [];
  if (before.name !== after.name) out.push(`the ${kind} ${before.name} renamed to ${after.name}`);
  const label = `the ${kind} ${after.name}`;
  if (before.kind === "schedule" && JSON.stringify(before.schedule ?? null) !== JSON.stringify(after.schedule ?? null)) {
    const w = (s: Schedule | undefined) => (s ? describeSchedule(s, eng.tz).replace(/^./, (c) => c.toLowerCase()) : "never");
    out.push(`${label} runs ${w(after.schedule)} (was ${before.schedule ? w(before.schedule) : "not set"})`);
  }
  if (before.prompt !== after.prompt) out.push(`${label} is told ${quoted(after.prompt, 60)} (was ${quoted(before.prompt, 60)})`);
  if (before.where !== after.where) out.push(`${label} runs ${after.where === "main" ? "in its main chat" : "as a fresh run"} (was ${before.where === "main" ? "in its main chat" : "as a fresh run"})`);
  if (before.enabled !== after.enabled) out.push(`${label} switched ${after.enabled ? "on" : "off"}`);
  return out;
}

/** Runs a trigger now for the main bot's run_now. The run shows in that bot's chat. */
function runNow(eng: Engine, t: Trigger): string {
  try {
    eng.runTrigger(t.id);
    return " It runs now.";
  } catch (err) {
    return ` It could not run now: ${err instanceof EngineError ? err.message : "something went wrong"}`;
  }
}

export async function setScheduleFor(eng: Engine, rt: BotRuntime, args: SetScheduleArgs, signal?: AbortSignal): Promise<ToolResult> {
  void signal;
  const target = toolTarget(eng, rt, args.bot);
  if (typeof target === "string") return problem(target);
  const own = target === rt;
  const name = target.folder.file.name;
  let existing: TriggerRow | undefined;
  if (args.id) {
    existing = eng.store.getTrigger(args.id);
    if (!existing || existing.botId !== target.folder.id) return noTrigger(own, name);
    if (existing.kind !== "schedule") return problem("That one is a webhook. Change it with set_webhook.");
  }
  const n = args.name ?? existing?.name;
  const prompt = args.prompt ?? existing?.prompt;
  const schedule: Schedule | undefined = args.schedule ?? existing?.schedule;
  if (!n || !prompt || !schedule) return problem("A new schedule needs a name, a prompt and a schedule.");
  const where = args.where ?? existing?.where ?? "main";
  const enabled = args.enabled ?? existing?.enabled ?? true;
  const changes = !existing || args.name !== undefined || args.prompt !== undefined || args.schedule !== undefined || args.where !== undefined || args.enabled !== undefined;
  if (existing && !changes && !args.run_now) return problem("Nothing to change: give what should change, or run_now.");
  let t: Trigger;
  try {
    if (!existing) {
      cleanTriggerName(n);
      cleanPrompt(prompt);
      cleanSchedule(schedule, eng.clock(), enabled);
      if (eng.store.listTriggers(target.folder.id).length >= MAX_TRIGGERS) throw new EngineError("bad_request", `A bot can have at most ${MAX_TRIGGERS} triggers. Remove one first.`);
    }
    const params: Methods["trigger.save"]["params"] = { botId: target.folder.id, trigger: { ...(existing ? { id: existing.id } : {}), kind: "schedule", name: n, prompt, where, enabled, schedule } };
    t = changes ? eng.saveTrigger(params, "bot", rt.folder.id) : eng.listTriggers(target.folder.id).find((x) => x.id === existing!.id)!;
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The schedule could not be saved.");
  }
  // The main bot's change to another bot's schedule happens at once; the person gets a quiet line (rule 2).
  if (!own && changes) {
    const lines = existing ? triggerChanges(eng, existing, t) : [`a new schedule ${t.name}, ${t.schedule ? describeSchedule(t.schedule, eng.tz).replace(/^./, (c) => c.toLowerCase()) : ""}, ${t.where === "main" ? "in its main chat" : "as a fresh run"}, ${t.enabled ? "on" : "off"}`];
    noteChange(eng, rt, `bot:${target.folder.id}`, changedTitle(target), lines);
  }
  const at = eng.clock();
  const when = t.schedule ? describeSchedule(t.schedule, eng.tz) : "";
  const state = !t.enabled ? "It is switched off." : t.nextAt ? `Next run ${whenWords(Date.parse(t.nextAt), at, eng.tz)}.` : "";
  const whereWords = t.where === "main" ? (own ? "in your main chat" : `in the main chat of ${name}`) : "as a fresh run";
  const ran = args.run_now && isMain(rt) ? runNow(eng, t) : "";
  return ok(`${changes ? "Saved" : "Kept"} ${t.name} (id ${t.id})${own ? "" : ` for ${name}`}: ${when}, ${whereWords}. ${state}${ran}`.trim());
}

export async function removeTriggerFor(eng: Engine, rt: BotRuntime, args: { id: string; bot?: string }, signal?: AbortSignal): Promise<ToolResult> {
  const target = toolTarget(eng, rt, args.bot);
  if (typeof target === "string") return problem(target);
  const own = target === rt;
  const name = target.folder.file.name;
  const row = eng.store.getTrigger(args.id);
  if (!row || row.botId !== target.folder.id) return noTrigger(own, name);
  // The main bot removes at once; another bot's trigger, or a webhook, leaves a quiet line (rule 2).
  if (isMain(rt)) {
    eng.removeTrigger(row.id);
    if (!own || row.kind === "webhook") {
      const what = row.kind === "webhook" ? `removed the webhook ${row.name}, its address stopped working` : `removed the schedule ${row.name}`;
      noteChange(eng, rt, `bot:${target.folder.id}`, changedTitle(target), [what]);
    }
    return ok(own ? `Removed ${row.name}.` : `Removed ${row.name} from ${name}.`);
  }
  // A bot that is not the main bot: its own webhook on a card, as before.
  if (row.kind === "webhook") {
    const detail = [`Bot: ${name}`, `Name: ${row.name}`, `Told: ${clip(row.prompt, 1500)}`, `Runs: ${row.where === "main" ? "in its main chat" : "as a fresh run"}`, "", "Its address stops working."].join("\n");
    const decision = await approval(eng, rt, { title: `Remove the webhook ${row.name}?`, detail, caption: "Webhook" }, signal);
    if (decision !== "allow") return refused(decision, "nothing was removed");
    if (!eng.store.getTrigger(row.id)) return ok(`${row.name} was already gone.`);
    eng.removeTrigger(row.id);
    return ok(`Removed the webhook ${row.name}.`);
  }
  eng.removeTrigger(row.id);
  return ok(`Removed ${row.name}.`);
}

/**
 * set_webhook: makes a webhook for the bot (or, for the main bot, for another bot), or changes one.
 * The main bot's change happens at once with a quiet line; a bot that is not the main bot asks on a card
 * first, whatever its access level, with no "Always allow". A new webhook's address, or a new address,
 * goes back to the bot in the tool's answer and nowhere else (docs/build/step-2g.md, A6).
 */
export async function setWebhookFor(eng: Engine, rt: BotRuntime, args: SetWebhookArgs, signal?: AbortSignal): Promise<ToolResult> {
  const target = toolTarget(eng, rt, args.bot);
  if (typeof target === "string") return problem(target);
  const own = target === rt;
  const main = isMain(rt);
  const name = target.folder.file.name;
  let existing: TriggerRow | undefined;
  if (args.id) {
    existing = eng.store.getTrigger(args.id);
    if (!existing || existing.botId !== target.folder.id) return noTrigger(own, name);
    if (existing.kind !== "webhook") return problem("That one is a schedule. Change it with set_schedule.");
  }
  if (!main && (args.new_address || args.run_now)) return problem("Only the main bot can do that.");
  if (args.new_address && !existing) return problem("Pass the id of the webhook that should get a new address.");
  const where = args.where ?? existing?.where ?? "main";
  const enabled = args.enabled ?? existing?.enabled ?? true;
  const changes = !existing || args.name !== undefined || args.prompt !== undefined || args.where !== undefined || args.enabled !== undefined;
  if (existing && !changes && !args.new_address && !args.run_now) return problem("Nothing to change: give what should change.");
  let n: string;
  let prompt: string;
  try {
    const rawName = args.name ?? existing?.name;
    const rawPrompt = args.prompt ?? existing?.prompt;
    if (!rawName || !rawPrompt) return problem("A new webhook needs a name and a prompt.");
    n = cleanTriggerName(rawName);
    prompt = cleanPrompt(rawPrompt);
    if (!existing && eng.store.listTriggers(target.folder.id).length >= MAX_TRIGGERS) {
      throw new EngineError("bad_request", `A bot can have at most ${MAX_TRIGGERS} triggers. Remove one first.`);
    }
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The webhook could not be saved.");
  }
  if (!main) {
    // Checked before the card, so the person is never asked about something that cannot be saved.
    const describe = (s: { name: string; where: TriggerRow["where"]; enabled: boolean; prompt: string }) => [
      `Name: ${s.name}`,
      `Told: ${clip(s.prompt, 1500)}`,
      `Runs: ${s.where === "main" ? "in its main chat" : "as a fresh run"}, ${s.enabled ? "switched on" : "switched off"}`,
    ];
    const after = describe({ name: n, where, enabled, prompt });
    const detail = existing
      ? [`Bot: ${name}`, "", "Now:", ...describe(existing), "", "After the change:", ...after].join("\n")
      : [`Bot: ${name}`, ...after, "", `${rt.folder.file.name} gets its address, to set up the sender for you.`].join("\n");
    const title = existing ? `Change the webhook ${existing.name}?` : `Make a webhook for ${name}?`;
    const decision = await approval(eng, rt, { title, detail, caption: "Webhook" }, signal);
    if (decision !== "allow") return refused(decision, existing ? "nothing was changed" : "no webhook was made");
    if (!eng.bots.has(target.folder.id)) return problem(`${name} was retired in the meantime, so nothing was changed.`);
    if (existing && !eng.store.getTrigger(existing.id)) return problem(`The webhook ${existing.name} was removed in the meantime, so nothing was changed.`);
  }
  let t: Trigger;
  try {
    t = changes
      ? eng.saveTrigger({ botId: target.folder.id, trigger: { ...(existing ? { id: existing.id } : {}), kind: "webhook", name: n, prompt, where, enabled } }, "bot", rt.folder.id)
      : eng.listTriggers(target.folder.id).find((x) => x.id === existing!.id)!;
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The webhook could not be saved.");
  }
  const asker = rt.folder.file.name;
  const notes: string[] = [];
  if (main && changes) notes.push(...(existing ? triggerChanges(eng, existing, t) : [`a new webhook ${t.name}, runs ${t.where === "main" ? "in its main chat" : "as a fresh run"}, ${t.enabled ? "on" : "off"}`, `${asker} has its address, to set up the sender`]));
  let renewed = "";
  let newOne = false;
  if (args.new_address) {
    try {
      eng.newAddress(t.id); // the new address goes only into this answer, below
      newOne = true;
      notes.push(`the webhook ${t.name} has a new address and the old one no longer works, ${asker} has the new one to change the sender`);
      renewed = " It has a new address now; the old one no longer works. Change the sender to the new address.";
    } catch (err) {
      renewed = ` A new address could not be made: ${err instanceof EngineError ? err.message : "something went wrong"}`;
    }
  }
  if (notes.length) noteChange(eng, rt, `bot:${target.folder.id}`, changedTitle(target), notes);
  const ran = args.run_now ? runNow(eng, t) : "";
  const whereWords = t.where === "main" ? (own ? "in your main chat" : `in the main chat of ${name}`) : "as a fresh run";
  const head = existing
    ? `Changed the webhook ${t.name} (id ${t.id})${own ? "" : ` of ${name}`}: runs ${whereWords}, ${t.enabled ? "switched on" : "switched off"}.${renewed || " Its address stays the same."}${ran}`
    : `Made the webhook ${t.name} (id ${t.id})${own ? "" : ` for ${name}`}: runs ${whereWords}, ${t.enabled ? "switched on" : "switched off"}.${ran}`;
  // A new webhook's address, or a new address, goes back to the bot in this answer and nowhere else.
  return ok(!existing || newOne ? [head, "", addressWords(eng, t.id)].join("\n") : head);
}

/**
 * webhook_address: the address of an existing webhook again, to set up its sender. At once, with no
 * card (decision of 15 Nov 2026); the person gets a quiet line that says which bot got the address of which
 * webhook, never the address. The main bot can ask for another bot's webhook.
 */
export async function webhookAddressFor(eng: Engine, rt: BotRuntime, args: { id: string; bot?: string }): Promise<ToolResult> {
  const target = toolTarget(eng, rt, args.bot);
  if (typeof target === "string") return problem(target);
  const own = target === rt;
  const name = target.folder.file.name;
  const row = eng.store.getTrigger(args.id);
  if (!row || row.botId !== target.folder.id) return noTrigger(own, name);
  if (row.kind !== "webhook") return problem("That one is a schedule, and a schedule has no address.");
  addressNote(eng, rt, `${rt.folder.file.name} got the address of the webhook ${row.name}${own ? "" : ` of ${name}`} again, to set up its sender`);
  return ok(addressWords(eng, row.id));
}

/** The address of a webhook for its bot, with what to do and not do with it. Never logged, never in an item or a line. */
export function addressWords(eng: Engine, triggerId: string): string {
  const row = eng.store.getTrigger(triggerId);
  if (!row?.secret) return "The address could not be read.";
  const path = hookPath(row.id, row.secret);
  const base = eng.opts.config.publicBase;
  const full = base ? `${base}${path}` : `${eng.localBase ?? "http://127.0.0.1"}${path}`;
  const which = base
    ? "This is its public address: it works from outside this computer."
    : "This is its local address: it only works on this computer, because Pobots has no public address set. Tell the person if the sender runs elsewhere.";
  return [
    `Address: ${full}`,
    which,
    "The address is a secret: anyone who has it can wake the bot. Use it only to set up the sender. Never write it in a chat message, a file, your memory, an artifact or a message to another bot.",
    "Senders POST JSON to it, with Content-Type: application/json.",
  ].join("\n");
}
