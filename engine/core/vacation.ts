// A vacation leaves the bot and its data in place; only delivery and the person's rail are paused.
import { randomUUID } from "node:crypto";
import type { Methods } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { writeBotFile } from "../bots.js";
import { log } from "../log.js";
import { EngineError } from "../errors.js";
import { nextAfter } from "../schedule.js";
import { endAllTaskManagers } from "./task-managers.js";
import { stopBot } from "./bot-admin.js";
import { beginHold, interrupt } from "./stop.js";
import { inBackground, type BotRuntime } from "./runtime.js";
import { finishPendingRun } from "./helpers.js";
import { restoreBotCard } from "./restored-cards.js";
import { restWaitChanged } from "./restored-waiting.js";
import { afterTriggersMoved, emitRun, idleActivity, toTrigger } from "./triggers.js";
import { questionTurnEnds } from "./card-questions.js";

export const away = (rt: BotRuntime | undefined): boolean => !!rt?.folder.file.vacationSince;

export function vacationRefusal(rt: BotRuntime): string {
  return `${rt.folder.file.name} is on vacation. Only the person or the main bot can bring it back.`;
}

export function requirePresent(rt: BotRuntime): void {
  if (away(rt)) throw new EngineError("conflict", vacationRefusal(rt));
}

export function vacationNeedsStop(eng: Engine, rt: BotRuntime): boolean {
  return !!(rt.busy || inBackground(rt) || rt.queue.length || rt.ahead?.length || rt.wakes.length || rt.lateCalls.size ||
    [...rt.managers.values()].some((tm) => tm.busy || tm.inbox.length) ||
    [...eng.cards.values()].some((p) => p.rt === rt && !p.restored && p.card.kind !== "note"));
}

/** Park the records before Stop can withdraw them. An interrupted call cannot be resumed; as
 * after a restart, answering its card when the bot returns delivers the answer as a new message. */
function parkCards(eng: Engine, rt: BotRuntime): void {
  for (const [id, p] of eng.cards) {
    if (p.rt !== rt) continue;
    clearTimeout(p.timer);
    eng.cards.delete(id);
    eng.opts.emit("card.removed", { cardId: id, reason: "withdrawn" });
    if (p.card.kind !== "note") p.resolve({ type: "withdrawn" });
  }
}

function persist(rt: BotRuntime, since: string | undefined): void {
  const folder = rt.folder;
  const file = { ...folder.file };
  if (since) file.vacationSince = since;
  else delete file.vacationSince;
  try {
    writeBotFile(folder.dir, file);
  } catch (err) {
    log.warn(`Could not save the vacation setting of bot ${folder.id}`, err);
    throw new EngineError("internal", "The bot’s vacation setting could not be saved. Try again.");
  }
  if (since) folder.file.vacationSince = since;
  else delete folder.file.vacationSince;
}

function leave(eng: Engine, rt: BotRuntime, since: string, stop: boolean): void {
  persist(rt, since);
  eng.notifier.quietBot(rt.folder.id);
  questionTurnEnds(eng, rt, rt.turn?.id, "");
  parkCards(eng, rt);
  if (stop) void interrupt(eng, rt.folder.id);
  if (rt.queue.length || !rt.hold) beginHold(eng, rt);
  else rt.epoch++;
  // Messages from the person that were waiting stay held, just as after Stop.
  const pending = rt.pendingRun;
  rt.pendingRun = undefined;
  if (pending) finishPendingRun(eng, rt, pending, true);
  endAllTaskManagers(eng, rt, "vacation");
  stopBot(eng, rt, vacationRefusal(rt), true);
  eng.setState(rt, "idle", "On vacation");
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  for (const todo of eng.store.openTodos(rt.folder.id)) eng.opts.emit("todo.removed", { todoId: todo.id, reason: "vacation" });
  eng.notice(rt, "Sent on vacation.", "info");
}

/** If the engine fell between saving the setting and stopping, keep the saved gate and finish
 * stopping the work left over at boot. Normally there is only an already held queue here. */
export function recoverVacation(eng: Engine, rt: BotRuntime): void {
  if (!away(rt)) return;
  if (rt.queue.some((id) => !rt.hold?.held.has(id))) beginHold(eng, rt);
  if (rt.managers.size) endAllTaskManagers(eng, rt, "vacation");
  if (rt.queue.some((id) => {
    const item = eng.store.getItem(id);
    return item?.kind === "user" && item.from.type !== "you";
  })) stopBot(eng, rt, vacationRefusal(rt), true);
}

function bringBack(eng: Engine, rt: BotRuntime, at: number): number {
  const since = rt.folder.file.vacationSince!;
  let missed = 0;
  // Set the next due times before lifting the delivery gate; an old due time never catches up.
  for (const row of eng.store.listTriggers(rt.folder.id)) {
    if (!row.enabled || row.kind !== "schedule" || !row.schedule) continue;
    const next = nextAfter(row.schedule, at, eng.tz);
    if (next !== undefined) row.nextAt = new Date(next).toISOString();
    else {
      delete row.nextAt;
      if (row.schedule.type === "once") {
        row.enabled = false;
        missed++;
        const run = { id: randomUUID(), triggerId: row.id, botId: row.botId, at: new Date(at).toISOString(), status: "skipped" as const, note: "Its time passed while the bot was on vacation" };
        eng.store.addRun(run);
        emitRun(eng, run);
      }
    }
    eng.store.updateTrigger(row);
  }
  persist(rt, undefined);
  eng.setState(rt, "idle", idleActivity(eng, rt));
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  for (const stored of eng.store.listCards()) {
    if (stored.kind === "system" || stored.botId !== rt.folder.id) continue;
    const elapsed = Math.max(0, at - Date.parse(since));
    const expiry = stored.kind === "approval" && stored.expiresAt ? Date.parse(stored.expiresAt) : NaN;
    const card = stored.kind === "approval" && Number.isFinite(expiry) ? { ...stored, expiresAt: new Date(expiry + elapsed).toISOString() } : stored;
    if (card !== stored) eng.store.addCard(card);
    restoreBotCard(eng, rt, card);
    // Upsert the old card without sending it as a new notification.
    eng.opts.emit("card.changed", { card });
  }
  restWaitChanged(eng, rt);
  for (const todo of eng.store.openTodos(rt.folder.id)) eng.opts.emit("todo.changed", { todo });
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: eng.tz }).format(new Date(since));
  const detail = missed === 1 ? " 1 schedule's time passed while it was away." : missed > 1 ? ` ${missed} schedules' times passed while it was away.` : "";
  eng.notice(rt, `Back from vacation. Away since ${date}.${detail}`, "info");
  return missed;
}

export function setVacation(eng: Engine, params: Methods["bot.vacation"]["params"]): Methods["bot.vacation"]["result"] {
  const rt = eng.bot(params.botId);
  if (rt.folder.file.role === "main") throw new EngineError("bad_request", "The main bot stays available to bring other bots back.");
  if (eng.stopping) throw new EngineError("unavailable", "Pobots is stopping. Try again in a moment.");
  if (params.vacation === away(rt)) return { bot: eng.toBot(rt), missedOnce: 0 };
  const stop = vacationNeedsStop(eng, rt);
  if (params.vacation && stop && !params.stop) throw new EngineError("conflict", "The bot is working or has waiting messages. Stop it and send it on vacation from its settings.");
  const at = eng.clock();
  let missedOnce = 0;
  if (params.vacation) leave(eng, rt, new Date(at).toISOString(), stop);
  else missedOnce = bringBack(eng, rt, at);
  // Messages that waited on its connections go to it now (engine 0.44.0).
  if (!params.vacation) eng.links.flush();
  for (const row of eng.store.listTriggers(rt.folder.id)) eng.opts.emit("trigger.changed", { botId: row.botId, trigger: toTrigger(eng, row) });
  afterTriggersMoved(eng);
  return { bot: eng.toBot(rt), missedOnce };
}
