// A bot follows and controls its helpers (15 Nov 2026, docs/build/step-bot-reach.md): read_helper,
// steer_helper and stop_helper find a helper by its id (the start of its row's id), list a bot's
// helpers, stop one the way the person's stop does, and steer a message into one's running turn the
// way the person's steer reaches a bot. After T3 Code's delegate_task / task_status / task_cancel
// (apps/server/src/mcp/toolkits/orchestrator/tools.ts, MIT): an id at once, and tools that take it.
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine.js";
import type { BotRuntime, Helper } from "./runtime.js";
import type { HelperItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem } from "../tool-names.js";
import { stopHelper } from "./helpers.js";
import { helperHead, hideSecrets, READ_MAX, readHelperView, type ReadArgs, shortHelperId } from "./helper-read.js";
import { clip, localWhen, now } from "./words.js";
import { log } from "../log.js";
import { findManager, managerState, sendFromBot, stopManager, type TaskManager } from "./task-managers.js";
import { workersOf } from "./task-manager-workers.js";

/** One of the bot's task managers by id; for the main bot with `bot`, another bot's. */
function managerFor(eng: Engine, asker: BotRuntime, id: string, bot: string | undefined): { rt: BotRuntime; tm: TaskManager } | undefined {
  const owner = bot?.trim() ? eng.findBot(bot.trim()) : asker;
  if (!owner || (owner !== asker && !isMain(asker))) return undefined;
  const tm = findManager(owner, id);
  return tm ? { rt: owner, tm } : undefined;
}

/** How many of a bot's helpers read_helper lists without an id. */
const LISTED = 20;

export type HelperRef = { owner: BotRuntime; item: HelperItem; live?: Helper };

const isMain = (rt: BotRuntime) => rt.folder.file.role === "main";

/** The live helper of a row, while it works. */
function liveOf(owner: BotRuntime, itemId: string): Helper | undefined {
  return [...owner.helpers.values()].find((h) => h.base.id === itemId);
}

/**
 * The bot whose helpers a call reaches: its own, or with `bot` another one's, which only the main
 * bot may (and for steering not even it: a bot steers its own helpers only).
 */
function ownerFor(eng: Engine, asker: BotRuntime, bot: string | undefined, others: boolean): BotRuntime | string {
  const ref = bot?.trim();
  if (!ref) return asker;
  const b = eng.findBot(ref);
  if (!b) return `There is no bot called ${ref}. Use list_bots to see the others.`;
  if (b === asker) return asker;
  if (!others) return "You can only steer your own helpers.";
  if (!isMain(asker)) return "Only the main bot can reach another bot's helpers. Leave bot out for your own.";
  return b;
}

/** Finds a helper by its id (the short one or the whole), among one bot's helpers, or for the main bot without `bot` its own first and then every bot's. */
export function findHelper(eng: Engine, asker: BotRuntime, id: string, bot: string | undefined, others: boolean): HelperRef | string {
  const want = id.trim().toLowerCase();
  if (!want) return "Give the helper's id, from start_helper or read_helper without an id.";
  // A few letters could match the wrong helper (for the main bot, another bot's): the id is 8 characters.
  if (want.length < 6) return `"${id.trim()}" is too short to be sure which helper you mean. Give its whole id (8 characters), from start_helper or read_helper without an id.`;
  const owner = ownerFor(eng, asker, bot, others);
  if (typeof owner === "string") return owner;
  const search = [owner, ...(!bot && others && isMain(asker) ? [...eng.bots.values()].filter((b) => b !== owner) : [])];
  for (const rt of search) {
    const live = [...rt.helpers.values()].find((h) => h.base.id.toLowerCase().startsWith(want));
    if (live) return { owner: rt, item: live.base, live };
    const item = eng.store.helperItems(rt.folder.id, 500).find((i) => i.id.toLowerCase().startsWith(want)) as HelperItem | undefined;
    if (item) return { owner: rt, item, ...(liveOf(rt, item.id) ? { live: liveOf(rt, item.id)! } : {}) };
  }
  return `There is no helper ${id.trim()}${owner === asker ? " of yours" : ` of ${owner.folder.file.name}`}. read_helper without an id lists them.`;
}

/** read_helper without an id: a bot's helpers, newest first, one line each. */
export function listHelpersFor(eng: Engine, asker: BotRuntime, bot?: string): ToolResult {
  const owner = ownerFor(eng, asker, bot, true);
  if (typeof owner === "string") return problem(owner);
  const items = eng.store.helperItems(owner.folder.id, LISTED + 1) as HelperItem[];
  const whose = owner === asker ? "You have" : `${owner.folder.file.name} has`;
  if (!items.length) return ok(`${whose} no helpers yet.`);
  const lines = items.slice(0, LISTED).map((item) => `- ${helperHead(eng, item, liveOf(owner, item.id))}`);
  const more = items.length > LISTED ? `\n(Older helpers are left out.)` : "";
  const working = [...owner.helpers.values()].filter((h) => h.status === "running").length;
  const text = `${whose} ${working ? `${working} helper${working === 1 ? "" : "s"} working now` : "no helper working now"}. Newest first:\n${lines.join("\n")}${more}\n\nread_helper with an id shows a helper's latest steps (view overview: its whole thread).`;
  return ok(hideSecrets(eng, text.length > READ_MAX ? `${text.slice(0, READ_MAX - 3)}...` : text));
}

/** read_helper. */
export function readHelperFor(eng: Engine, asker: BotRuntime, args: ReadArgs & { id?: string; bot?: string }): ToolResult {
  if (!args.id?.trim()) return listHelpersFor(eng, asker, args.bot);
  // A task manager's id (engine 0.26.0): its state and its thread.
  const tm = managerFor(eng, asker, args.id, args.bot);
  if (tm) {
    const state = managerState(eng, tm.rt, tm.tm);
    const head = `Task manager ${shortHelperId(tm.tm.id)} "${tm.tm.title}": ${state}, ${workersOf(tm.rt, tm.tm.id).length} of at most ${tm.tm.maxWorkers} workers working now.`;
    return ok(`${head}\n${readHelperView(eng, tm.rt, tm.tm.row, undefined, args)}`);
  }
  const found = findHelper(eng, asker, args.id, args.bot, true);
  if (typeof found === "string") return problem(found);
  return ok(readHelperView(eng, found.owner, found.item, found.live, args));
}

/** What a helper did last, for stop_helper's answer. */
function lastState(eng: Engine, h: Helper): string {
  const said = h.lastText ? `\nWhat it said last:\n${clip(h.lastText, 1_500)}` : "";
  return hideSecrets(eng, `${h.steps} step${h.steps === 1 ? "" : "s"} of work. Its last line: ${h.last ?? "(none)"}.${said}`);
}

/** stop_helper: stops one running helper as the person's stop on its row does, and says its last state. */
export async function stopHelperFor(eng: Engine, asker: BotRuntime, args: { id?: string; bot?: string }): Promise<ToolResult> {
  const tm = managerFor(eng, asker, args.id ?? "", args.bot);
  if (tm) {
    stopManager(eng, tm.rt, tm.tm);
    return ok(`Stopped what task manager ${shortHelperId(tm.tm.id)} "${tm.tm.title}" was doing, and its workers. It stays, resting: steer_helper sends it more, end_task_manager ends it.`);
  }
  const found = findHelper(eng, asker, args.id ?? "", args.bot, true);
  if (typeof found === "string") return problem(found);
  const { owner, item } = found;
  const live = liveOf(owner, item.id);
  const id = shortHelperId(item.id);
  if (!live || live.status !== "running") {
    return ok(hideSecrets(eng, `Helper ${id} "${item.title}" is not working, so there is nothing to stop. ${helperHead(eng, item)}`));
  }
  const state = lastState(eng, live);
  try {
    await stopHelper(eng, { botId: owner.folder.id, itemId: item.id });
  } catch (err) {
    log.warn(`Bot ${asker.folder.id}: could not stop a helper`, err);
    return problem("The helper could not be stopped. The details are in the engine log.");
  }
  if (owner !== asker) {
    // The person sees who stopped it, in the chat where its row stands; its own bot is told at its next turn.
    const name = asker.folder.file.name;
    eng.addItem(owner, { kind: "notice", at: now(), text: `${name} stopped the helper "${item.title}"`, tone: "info" }, item.threadId);
    eng.store.addNews(owner.folder.id, owner.threadId, `Note from Pobots: ${name} stopped your helper ${id} "${item.title}" ${localWhen(eng, now())}.`);
  }
  log.info(`Bot ${asker.folder.id}: stopped a helper${owner !== asker ? ` of ${owner.folder.id}` : ""}`);
  const done = live.status !== "running" ? "Stopped" : "Asked to stop (its row says stopped once its harness confirms)";
  return ok(`${done}: helper ${id} "${item.title}"${owner !== asker ? ` of ${owner.folder.file.name}, who is told` : ""}. ${state}`);
}

/** steer_helper: a message into the running turn of one of the bot's own start_helper helpers. */
export async function steerHelperFor(eng: Engine, asker: BotRuntime, args: { id?: string; text?: string }): Promise<ToolResult> {
  const text = args.text?.trim() ?? "";
  if (!text) return problem("Give the text to send to the helper.");
  // One of the bot's own task managers: the message starts or joins its work (engine 0.26.0).
  const tm = managerFor(eng, asker, args.id ?? "", undefined);
  if (tm) return sendFromBot(eng, asker, tm.tm, text);
  const found = findHelper(eng, asker, args.id ?? "", undefined, false);
  if (typeof found === "string") return problem(found);
  const { item } = found;
  const id = shortHelperId(item.id);
  const live = liveOf(asker, item.id);
  if (!live || live.status !== "running" || live.stopAsked) {
    return problem(`Helper ${id} "${item.title}" is not working any more (${live?.stopAsked ? "it is stopping" : item.status}), so the message was not sent and it was not started again. Start a new helper with start_helper if more is needed.`);
  }
  if (!live.pobots) {
    return problem(`Helper ${id} "${item.title}" was started with your harness's own helper tool, which Pobots cannot steer. Give it more with SendMessage, or use start_helper for helpers you want to steer.`);
  }
  const session = live.pobots.session;
  const framed = `Message from the bot ${asker.folder.file.name}, who gave you your task, sent while you work. Take it into account and carry on:\n\n${text}`;
  const itemId = randomUUID();
  let took = false;
  try {
    took = !!session && !session.closed && !!session.steer && (await session.steer(framed, { id: itemId }));
  } catch (err) {
    log.warn(`Bot ${asker.folder.id}: could not steer a helper`, err);
  }
  if (!took) return problem(`Helper ${id} "${item.title}" could not take a message just now (it is between two steps of its own, or ending). Try again in a moment, or stop it and start a new one.`);
  if (live.status === "running") {
    eng.addItem(asker, { id: itemId, kind: "user", at: now(), text, from: { type: "bot", botId: asker.folder.id, expectsReply: false }, queued: false, steered: true }, item.helperThreadId);
  }
  log.info(`Bot ${asker.folder.id}: steered a message into a helper`);
  return ok(`Sent into helper ${id} "${item.title}" while it works. It reads it at its next step. Its last line: ${live.last ?? "(none)"}.`);
}
