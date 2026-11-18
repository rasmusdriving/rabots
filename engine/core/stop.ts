// Stop: the person's Stop, and the holds that keep a stopped bot's old work from starting turns (docs/build/step-3b-stop.md).
import type { Engine, HarnessSession } from "../engine.js";
import { type BotRuntime, type Helper, helperWork, type LiveTask, ownBackgroundTasks, unmatchedHelperTasks } from "./runtime.js";
import { log } from "../log.js";
import { now } from "./words.js";
import type { UserItem } from "../../shared/protocol.js";
import type { HarnessEvent } from "../claude/session.js";
import { withdrawCards } from "./cards.js";
import { startTurn } from "./turn-start.js";
import { finishTurn, noteUsage } from "./turn-end.js";
import { afterHelpersChanged, backgroundChanged, endHelper, expectStop } from "./helpers.js";
import { closeAsides } from "./aside.js";
import { stopTaskManagers } from "./task-managers.js";

/** How long to wait for a turn to wind down after an interrupt before forcing it. */
export const INTERRUPT_GRACE_MS = 15 * 1000;

/** In a hold's set of old work: the Codex turn that was stopped, which may still send for its thread. */
export const CODEX_STOPPED_TURN = "codex:stopped-turn";

export function holdKey(eng: Engine, rt: BotRuntime): string {
  return `stop.hold:${rt.folder.id}`;
}

/** A hold from before the restart, with the held messages that still wait. */
export function loadHold(eng: Engine, rt: BotRuntime): void {
  const raw = eng.store.getValue(holdKey(eng, rt));
  if (!raw) return;
  try {
    const v = JSON.parse(raw) as { at?: unknown; held?: unknown };
    if (typeof v.at !== "string") return;
    const held = Array.isArray(v.held) ? v.held.filter((x): x is string => typeof x === "string" && rt.queue.includes(x)) : [];
    // The person wrote after the Stop, and Pobots stopped before the hold was taken off: it has ended.
    const at = v.at;
    const wrote = eng.store.readThread(rt.threadId, undefined, 100).items.some((i) => i.kind === "user" && i.from.type === "you" && i.at > at);
    if (wrote) {
      eng.store.deleteValue(holdKey(eng, rt));
      log.info(`Bot ${rt.folder.id}: the person wrote after the Stop, so it no longer holds`);
      return;
    }
    rt.hold = { at: v.at, held: new Set(held), old: new Set(), letGo: new Set() };
    log.info(`Bot ${rt.folder.id}: a Stop from before the restart still holds${held.length ? ` (${held.length} message${held.length === 1 ? "" : "s"} waiting)` : ""}`);
  } catch {
    log.warn(`Bot ${rt.folder.id}: could not read the saved Stop`);
  }
}

/** Keeps the hold in the database, with the held messages that still wait, or forgets it. */
export function saveHold(eng: Engine, rt: BotRuntime): void {
  if (!eng.store.isOpen) return;
  if (!rt.hold) {
    eng.store.deleteValue(holdKey(eng, rt));
    return;
  }
  for (const id of [...rt.hold.held]) if (!rt.queue.includes(id)) rt.hold.held.delete(id);
  eng.store.setValue(holdKey(eng, rt), JSON.stringify({ at: rt.hold.at, held: [...rt.hold.held] }));
}

/** Stop did something: from now on nothing from before it starts a turn, until the person writes. */
export function beginHold(eng: Engine, rt: BotRuntime): void {
  rt.epoch++;
  const held = new Set([...(rt.hold?.held ?? []), ...rt.queue]);
  // Everything that runs now is work from before this Stop, with what an earlier hold still waited for.
  const old = new Set([...(rt.hold?.old ?? []), ...[...rt.tasks].filter(([, t]) => !t.quiet).map(([id]) => id), ...[...rt.helpers.values()].map((h) => h.taskId).filter((x): x is string => !!x)]);
  // Codex lists no tasks, and what it may still send for the turn that was stopped cannot be placed:
  // that turn counts as old work until its process goes away (step 3b, third part, review).
  if ((rt.session ? rt.sessionHarness : rt.folder.file.harness) === "codex") old.add(CODEX_STOPPED_TURN);
  // The time is the latest Stop's: everything that existed then is from before it (review 2). A
  // message from the person after an earlier Stop would have ended that hold, so loadHold reads the same.
  rt.hold = { at: now(), held, old, letGo: new Set(rt.hold?.letGo ?? []) };
  rt.wake = undefined;
  saveHold(eng, rt);
  log.info(`Bot ${rt.folder.id}: Stop holds until the person writes${held.size ? ` (${held.size} message${held.size === 1 ? "" : "s"} waiting)` : ""}`);
}

/** The person wrote to the bot: the hold ends, and the held messages go first, in their order. True when there was one. */
export function endHold(eng: Engine, rt: BotRuntime): boolean {
  if (!rt.hold) return false;
  rt.hold = undefined;
  saveHold(eng, rt);
  log.info(`Bot ${rt.folder.id}: the person wrote, so the Stop no longer holds`);
  return true;
}

/** How many messages wait because a Stop holds them. */
export function heldCount(eng: Engine, rt: BotRuntime): number {
  const held = rt.hold?.held;
  return held ? rt.queue.filter((id) => held.has(id)).length : 0;
}

/** Messages in line that are not held by a Stop. */
export function liveQueue(eng: Engine, rt: BotRuntime): number {
  const held = rt.hold?.held;
  return held ? rt.queue.filter((id) => !held.has(id)).length : rt.queue.length;
}

/** The roster's line for a bot at rest while a Stop holds messages, or undefined. */
export function heldWords(eng: Engine, rt: BotRuntime): string | undefined {
  const n = heldCount(eng, rt);
  return n ? (n === 1 ? "Stopped, 1 message waiting" : `Stopped, ${n} messages waiting`) : undefined;
}

/** The first message in line that a Stop does not hold. Ids whose item is gone are dropped. */
export function nextInLine(eng: Engine, rt: BotRuntime): UserItem | undefined {
  for (let i = 0; i < rt.queue.length; ) {
    const id = rt.queue[i]!;
    const item = eng.store.getItem(id);
    if (!item || item.kind !== "user") {
      rt.queue.splice(i, 1);
      continue;
    }
    if (rt.hold?.held.has(id)) {
      i++;
      continue;
    }
    return item;
  }
  return undefined;
}

/** Starts the next message in line when the bot is free and it may start now. True when a turn started. */
export function startNextInLine(eng: Engine, rt: BotRuntime): boolean {
  if (rt.busy || eng.stopping) return false;
  const next = nextInLine(eng, rt);
  // Never held for helpers of another thread: their session is set aside and goes on (core/aside.ts).
  if (!next) return false;
  rt.queue.splice(rt.queue.indexOf(next.id), 1);
  void startTurn(eng, rt, next);
  return true;
}

/** While a hold is on: whether this task is work from before the Stop. */
export function oldTask(eng: Engine, rt: BotRuntime, taskId: string, t: LiveTask | undefined): boolean {
  return !!rt.hold && (rt.hold.old.has(taskId) || (!!t && t.epoch < rt.epoch));
}

/** While a hold is on: whether this helper is work from before the Stop. */
export function oldHelper(eng: Engine, rt: BotRuntime, h: Helper): boolean {
  return !!rt.hold && ((!!h.taskId && rt.hold.old.has(h.taskId)) || h.epoch < rt.epoch);
}

/** A helper given more to do by a turn of now is work of now, and so is its task. */
export function renewHelper(eng: Engine, rt: BotRuntime, h: Helper, taskId: string | undefined): void {
  h.epoch = rt.epoch;
  // A Stop asked it to stop; the turn of now wants it to go on.
  if (h.stopAsked) {
    h.stopAsked = false;
    clearTimeout(h.stopTimer);
  }
  if (!taskId) return;
  rt.hold?.old.delete(taskId);
  const t = rt.tasks.get(taskId);
  if (t) t.epoch = rt.epoch;
}

/**
 * Old work ended, in whichever way the harness says it: its notification, a task update with an end
 * status, or leaving its list of live tasks. It leaves the set and counts as old work reported back,
 * so the order of those messages cannot let the turn that follows run (review 2).
 */
export function oldTaskEnded(eng: Engine, rt: BotRuntime, taskId: string): void {
  if (!rt.hold?.old.has(taskId)) return;
  rt.hold.old.delete(taskId);
  rt.hold.letGo.delete(taskId);
  noteReport(eng, rt, true);
}

/** While a hold is on, something reported back: from before the Stop or from after it. */
export function noteReport(eng: Engine, rt: BotRuntime, old: boolean): void {
  if (!rt.hold) return;
  rt.wake = { old: !!rt.wake?.old || old, fresh: !!rt.wake?.fresh || !old };
}

/** The epoch of the helper or task with this task id, for work it starts. */
export function epochOfTask(eng: Engine, rt: BotRuntime, taskId: string | undefined): number | undefined {
  if (!taskId) return undefined;
  return [...rt.helpers.values()].find((h) => h.taskId === taskId)?.epoch ?? rt.tasks.get(taskId)?.epoch ?? rt.endedHelpers.get(taskId)?.epoch;
}

/**
 * The harness began a turn by itself while a Stop holds, out of work from before the Stop (or work
 * it let go): it is ended at once. Nothing of it reaches the chat and the bot's state does not
 * change. Interrupting at the turn's start stops it before its request goes out (tried on the real
 * harness, notes-engine-3b-stop.md).
 */
export function swallowTurn(eng: Engine, rt: BotRuntime, session: HarnessSession): void {
  rt.swallow = session;
  rt.wakePurpose = undefined;
  rt.wake = undefined;
  log.info(`Bot ${rt.folder.id}: the harness began a turn by itself while a Stop holds; it is ended at once`);
  void session.interrupt().catch((err) => log.warn(`Bot ${rt.folder.id}: could not end the harness's own turn`, err));
}

/**
 * What the harness sends while a turn it began by itself is being ended (see swallowTurn). True
 * when the event is dropped. Its end clears it; so does a turn of ours beginning (Codex sends no
 * end for a turn it did not start through Pobots).
 */
export function swallowed(eng: Engine, rt: BotRuntime, session: HarnessSession, e: HarnessEvent): boolean {
  switch (e.type) {
    case "thinking":
    case "thought":
    case "plan":
    case "text-start":
    case "text-delta":
    case "text-full":
    case "text-end":
    case "tool-start":
    case "tool-end":
    case "api-error":
    case "compacted":
      return true;
    case "turn-start":
      if (e.own) {
        rt.swallow = undefined;
        return false;
      }
      // Another turn of its own before the first ended: ended the same way.
      void session.interrupt().catch(() => undefined);
      return true;
    case "turn-end": {
      if (e.own === true && rt.busy && rt.turn?.begun) {
        rt.swallow = undefined;
        return false;
      }
      rt.swallow = undefined;
      if (e.sessionId) eng.store.setSessionId(rt.sessionThread ?? rt.threadId, e.sessionId);
      if (e.usage) noteUsage(eng, rt, e.usage);
      // The one line in the log is swallowTurn's; this one says what it cost, for checks.
      log.debug(`Bot ${rt.folder.id}: the harness's own turn was ended (${e.subtype}, ${e.usage?.requests ?? 0} request${e.usage?.requests === 1 ? "" : "s"} to the model)`);
      return true;
    }
    case "exit":
      rt.swallow = undefined;
      return false;
    default:
      return false;
  }
}

/**
 * Stops the bot's turn, if one runs, and every helper of the bot that still works. The harness's own
 * interrupt ends helpers in the background too (seen in step 2e); any that still run a moment later
 * are stopped one by one, and any that never confirm are marked stopped.
 */
export async function interrupt(eng: Engine, botId: string): Promise<void> {
  const rt = eng.bot(botId);
  // Its task managers stop what they do, with their workers, and stay (engine 0.26.0).
  stopTaskManagers(eng, rt);
  const helpers = [...rt.helpers.values()].filter((h) => !h.manager);
  // What runs in the background now, taken at this moment: work started after Stop is not touched.
  const own = ownBackgroundTasks(rt);
  const unmatched = unmatchedHelperTasks(rt);
  const helperTasks = new Set([...helpers.map((h) => h.taskId).filter((x): x is string => !!x), ...unmatched]);
  if (!rt.busy && !helpers.length && !own.length && !unmatched.length) return;
  // Stop holds until the person writes again (step 3b, third part).
  beginHold(eng, rt);
  withdrawCards(eng, rt, true);
  const session = rt.session;
  // The bot's own commands are asked to stop at once: the harness's interrupt does not end them,
  // and one that ends by itself would wake the model. Helpers keep the nudge below.
  if (session && !session.closed) for (const id of own) stopTask(eng, rt, id);
  if (rt.busy) {
    rt.interruptRequested = true;
    eng.setState(rt, "thinking", "Stopping");
    clearTimeout(rt.interruptTimer);
    rt.interruptTimer = setTimeout(() => {
      // The harness did not end the turn in time. Stop its process; the next message starts a new one.
      if (rt.busy && rt.interruptRequested) {
        log.warn(`Bot ${rt.folder.id}: the turn did not stop in time, closing the harness`);
        eng.closeSession(rt);
        finishTurn(eng, rt, { ok: true, errors: [], subtype: "interrupted" });
      }
    }, INTERRUPT_GRACE_MS);
    rt.interruptTimer.unref();
  } else {
    rt.afterHelpers = { state: "done", activity: "Stopped" };
    eng.setState(rt, "working", "Stopping");
    // The bot has usually said that it will pass the result on. Say in the chat that none is coming.
    const top = (helpers.filter((h) => !h.parent).length || helpers.length) + unmatched.length;
    // Commands are only asked to stop here; whether they did is not known yet.
    if (!top) eng.notice(rt, "Stopped.", "info");
    else eng.notice(rt, top === 1 ? "Stopped. The helper was stopped before it reported back." : `Stopped. ${top} helpers were stopped before they reported back.`, "info");
  }
  for (const h of helpers) expectStop(eng, rt, h);
  // Helpers on their own session (start_helper) stop at once, and the bot is not woken for them.
  for (const h of helpers) {
    if (!h.pobots) continue;
    h.pobots.tell = false;
    endHelper(eng, rt, h, "stopped", undefined, false);
  }
  // Sessions set aside end with their helpers (core/aside.ts); their rows say stopped at once.
  closeAsides(eng, rt, "stopped");
  for (const ac of rt.lateCalls) ac.abort();
  rt.lateCalls.clear();
  rt.wakes = [];
  if (!rt.busy && helpers.length && ![...rt.helpers.values()].some((h) => !h.manager)) afterHelpersChanged(eng, rt);
  if (session && !session.closed) {
    try {
      await session.interrupt();
    } catch (err) {
      log.warn(`Bot ${rt.folder.id}: the interrupt failed`, err);
    }
    // The interrupt spares helpers in the background (bot sessions declare perTaskStopAffordance, so a
    // turn there can be ended without ending them, core/aside.ts): each is asked to stop at once. One
    // that never confirms is marked stopped after the grace (expectStop).
    // Only what ran when Stop was pressed, and only in that same session.
    if (rt.session === session && !session.closed) {
      for (const h of helpers) {
        if (h.pobots || !h.taskId || rt.helpers.get(h.toolUseId) !== h || h.status !== "running" || h.session !== session) continue;
        // One that waits for its own commands is stopped by stopping them.
        if (h.paused) for (const id of helperWork(rt, h)) stopTask(eng, rt, id);
        else void session.stopTask(h.taskId).catch((err) => log.warn(`Bot ${rt.folder.id}: could not stop a helper`, err));
      }
      // Listed helpers with no row (step 3b). The bot's own commands were asked at once.
      for (const id of unmatched) if (rt.tasks.has(id)) stopTask(eng, rt, id);
    }
  }
  if (own.length || unmatched.length || helpers.some((h) => !h.pobots)) {
    // A task the harness never confirms as stopped is let go, so the bot does not wait for it for ever.
    // That covers what the stopped helpers started too. The chat says it may still run.
    const giveUp = setTimeout(() => {
      if (rt.session !== session) return;
      const left = [...rt.tasks].filter(([id, t]) => own.includes(id) || unmatched.includes(id) || (!!t.parent && helperTasks.has(t.parent) && !helperRowRunning(eng, rt, t.parent))).map(([id]) => id);
      if (!left.length) return;
      log.warn(`Bot ${rt.folder.id}: ${left.length === 1 ? "a task in the background did not confirm that it stopped" : `${left.length} tasks in the background did not confirm that they stopped`}`);
      for (const id of left) {
        rt.tasks.delete(id);
        rt.hold?.letGo.add(id);
      }
      eng.notice(rt, left.length === 1 ? "A command in the background may still be running." : "Some work in the background may still be running.", "info");
      backgroundChanged(eng, rt);
    }, eng.helperStopMs);
    giveUp.unref?.();
  }
}

/** A helper row runs for this task id. */
export function helperRowRunning(eng: Engine, rt: BotRuntime, taskId: string): boolean {
  return [...rt.helpers.values()].some((h) => h.taskId === taskId);
}

/** Asks the harness to stop one of its tasks, in the session it runs in. The harness confirms with a task notification. */
export function stopTask(eng: Engine, rt: BotRuntime, taskId: string): void {
  const s = rt.tasks.get(taskId)?.session ?? rt.session;
  if (!s || s.closed) return;
  void s.stopTask(taskId).catch((err) => log.warn(`Bot ${rt.folder.id}: could not stop a task in the background`, err));
}
