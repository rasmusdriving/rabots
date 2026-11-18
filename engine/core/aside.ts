// Sessions set aside (engine 0.24.1, docs/build/step-no-wait-for-helpers.md). A bot answers a new
// message at once while its helpers work: when a turn for another thread needs a session and the
// live one still has work of its own in the background, the live one is set aside instead of closed.
// It keeps running, its helpers keep working and report back to the thread that started them, and
// it sleeps once nothing of it runs and nothing waits for it. Following T3 Code, which never replaces
// a session while its background work runs (ClaudeAdapterV2.ts, ClaudeBackgroundWorkBlocksQueryReplacementError)
// and routes a wake to the thread that started the work (lastTurnRouteByNativeThread, offerWakeContinuation).
import type { Engine, HarnessSession } from "../engine.js";
import type { HarnessEvent } from "../claude/session.js";
import type { Harness } from "../../shared/protocol.js";
import { type AsideSession, type BotRuntime, type Helper, inBackground, ownBackgroundTasks, type Purpose } from "./runtime.js";
import { checkLive, finishPendingRun, onHelperEvent, onTaskEvent, stopHelpers } from "./helpers.js";
import { handleHarnessEvent } from "./harness-events.js";
import { wake } from "./start-helper.js";
import { log } from "../log.js";

/** What the bot is told when a helper's result waited while it answered something else. */
export const REPORT_WAITED =
  "Note from Pobots: while you were answering a message in another conversation, a helper you started here reported back. Its result is above in this conversation. Carry on with what it was for.";

/** The set-aside session this is, if it is one. */
export function asideOf(rt: BotRuntime, session: HarnessSession): AsideSession | undefined {
  return rt.aside.find((a) => a.session === session);
}

/** Whether a helper is work of this session: one of its own, or a start_helper helper its call started. */
export function workOf(h: Helper, session: HarnessSession): boolean {
  return h.session === session || h.pobots?.from === session;
}

/** Work of its own that runs in one session: the helpers it started and its tasks in the background. */
export function sessionWork(rt: BotRuntime, session: HarnessSession | undefined): number {
  if (!session || session.closed) return 0;
  let n = 0;
  for (const h of rt.helpers.values()) if (workOf(h, session)) n++;
  for (const t of rt.tasks.values()) if (t.session === session && t.background && !t.quiet) n++;
  return n;
}

/** Whether a helper or task belongs to a session set aside. */
function setAside(rt: BotRuntime): Set<HarnessSession> {
  return new Set(rt.aside.map((a) => a.session));
}

/** The purpose a set-aside session's result carries on. */
export function asidePurpose(rt: BotRuntime, a: AsideSession): Purpose {
  return a.purpose ?? { startedBy: "you", threadId: a.threadId, fresh: a.threadId !== rt.threadId, hops: 0 };
}

/** Whether a turn in this thread can go to a session that is live or set aside (for a result that waited). */
export function sessionFor(rt: BotRuntime, threadId: string): boolean {
  return (rt.sessionThread === threadId && !!rt.session && !rt.session.closed) || rt.aside.some((a) => a.threadId === threadId && !a.session.closed);
}

/** The live session goes aside: it keeps running beside the next one. */
export function putAside(eng: Engine, rt: BotRuntime): void {
  const session = rt.session;
  if (!session) return;
  const threadId = rt.sessionThread ?? rt.threadId;
  const a: AsideSession = {
    session,
    threadId,
    ...(rt.sessionHarness ? { harness: rt.sessionHarness } : {}),
    ...(rt.sessionTools ? { tools: rt.sessionTools } : {}),
    ...(rt.lastPurpose?.threadId === threadId ? { purpose: rt.lastPurpose } : {}),
    ...(rt.pendingRun?.threadId === threadId ? { pendingRun: rt.pendingRun } : {}),
    swallowing: rt.swallow === session,
    waiting: false,
    stale: rt.restartAfterTurn,
  };
  if (a.pendingRun) rt.pendingRun = undefined;
  if (rt.swallow === session) rt.swallow = undefined;
  rt.aside.push(a);
  rt.session = undefined;
  rt.sessionThread = undefined;
  rt.closeWhenCalm = false;
  rt.restartAfterTurn = false;
  log.info(`Bot ${rt.folder.id}: its session was set aside while its work in the background goes on`);
  checkAsides(eng, rt);
}

/** The live session makes room for another: aside while its own work runs, else it sleeps. */
export function leaveLive(eng: Engine, rt: BotRuntime): void {
  if (!rt.session) return;
  if (sessionWork(rt, rt.session) > 0 || rt.swallow === rt.session) {
    putAside(eng, rt);
    return;
  }
  const run = rt.pendingRun;
  rt.pendingRun = undefined;
  if (run) finishPendingRun(eng, rt, run, false);
  eng.closeSession(rt);
}

/** A set-aside session becomes the live one again; the live one makes room. */
export function bringBack(eng: Engine, rt: BotRuntime, a: AsideSession): void {
  // The live one makes room first, while this one still counts as set aside: its helpers and tasks are kept.
  if (rt.session && rt.session !== a.session) leaveLive(eng, rt);
  rt.aside = rt.aside.filter((x) => x !== a);
  clearTimeout(a.calmTimer);
  a.calmTimer = undefined;
  rt.session = a.session;
  rt.sessionThread = a.threadId;
  rt.sessionHarness = a.harness;
  rt.sessionTools = a.tools;
  rt.closeWhenCalm = false;
  rt.restartAfterTurn = a.stale;
  rt.resumedFrom = undefined;
  rt.newMainSession = false;
  rt.switchHanded = false;
  if (a.pendingRun) rt.pendingRun = a.pendingRun;
  // The rest of a turn being ended there is dropped as before (see swallowed).
  if (a.swallowing) rt.swallow = a.session;
  // A result that waited for it is not told again: this turn is in its conversation.
  rt.wakes = rt.wakes.filter((w) => w.aside !== a.session);
  rt.wakePurpose = asidePurpose(rt, a);
  log.info(`Bot ${rt.folder.id}: a session that was set aside is live again`);
}

/** The session set aside for this thread on this harness, taken for a turn there. */
export function takeAside(eng: Engine, rt: BotRuntime, threadId: string, harness: Harness): AsideSession | undefined {
  const a = rt.aside.find((x) => x.threadId === threadId && !x.session.closed && (x.harness ?? "claude") === harness);
  if (a) bringBack(eng, rt, a);
  return a;
}

/** Something a set-aside session reported. */
export function onAsideEvent(eng: Engine, rt: BotRuntime, a: AsideSession, e: HarnessEvent): void {
  // A helper that ends there sets what the bot's next turn carries on; that belongs to this session.
  const before = rt.wakePurpose;
  try {
    handleAsideEvent(eng, rt, a, e);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not handle an event of a session set aside`, err);
  } finally {
    if (rt.session !== a.session && rt.wakePurpose !== before) {
      if (rt.wakePurpose?.threadId === a.threadId) a.purpose = rt.wakePurpose;
      rt.wakePurpose = before;
    }
  }
}

function handleAsideEvent(eng: Engine, rt: BotRuntime, a: AsideSession, e: HarnessEvent): void {
  const session = a.session;
  // What a helper said or did goes to its own thread, as from the live session.
  if ((e.type === "text-full" || e.type === "tool-start" || e.type === "tool-end") && e.parent) {
    onHelperEvent(eng, rt, e);
    return;
  }
  switch (e.type) {
    case "task-started":
    case "task-updated":
    case "task-ended":
    case "tasks-live":
      onTaskEvent(eng, rt, e, session);
      checkAsides(eng, rt);
      return;
    case "session":
      eng.store.setSessionId(a.threadId, e.sessionId);
      return;
    case "turn-end":
      if (e.sessionId) eng.store.setSessionId(a.threadId, e.sessionId);
      if (a.swallowing) {
        a.swallowing = false;
        log.debug(`Bot ${rt.folder.id}: the harness's own turn in a session set aside was ended (${e.subtype}, ${e.usage?.requests ?? 0} request${e.usage?.requests === 1 ? "" : "s"} to the model)`);
      }
      checkAsides(eng, rt);
      return;
    case "exit":
      asideExited(eng, rt, a);
      return;
  }
  if (a.swallowing) return;
  const report = (e.type === "turn-start" && !e.own) || e.type === "thinking" || e.type === "thought" || e.type === "text-start" || e.type === "text-delta" || e.type === "text-full" || e.type === "tool-start";
  if (!report) return;
  // A helper reported back and the harness began a turn by itself there.
  if (!rt.busy && !eng.stopping && !rt.ahead?.length) {
    // The bot is free: that session is live again and the turn runs in its own thread, as before.
    bringBack(eng, rt, a);
    handleHarnessEvent(eng, rt, session, e);
    return;
  }
  // The bot answers something else: the turn is ended at its start, before its request goes out, and
  // the result waits in that conversation. Other helpers there go on (perTaskStopAffordance).
  a.swallowing = true;
  log.info(`Bot ${rt.folder.id}: a helper reported back in a session set aside while the bot is busy; it is told after`);
  void session.interrupt().catch((err) => log.warn(`Bot ${rt.folder.id}: could not end the harness's own turn in a session set aside`, err));
  if (!a.waiting) {
    a.waiting = true;
    wake(eng, rt, { text: REPORT_WAITED, purpose: asidePurpose(rt, a), aside: session });
  }
}

/** A set-aside session's process went away: its helpers are stopped with a notice, its run ends. */
function asideExited(eng: Engine, rt: BotRuntime, a: AsideSession): void {
  if (eng.stopping || !rt.aside.includes(a)) return;
  log.warn(`Bot ${rt.folder.id}: a session set aside stopped unexpectedly`);
  closeAside(eng, rt, a, "exit");
}

/**
 * A set-aside session ends. "calm": nothing of it runs any more. "stopped": the person pressed Stop.
 * "quiet": the bot is closed down (a restart, a change of harness, the bot removed). "exit": its
 * process went away.
 */
export function closeAside(eng: Engine, rt: BotRuntime, a: AsideSession, how: "calm" | "stopped" | "quiet" | "exit"): void {
  rt.aside = rt.aside.filter((x) => x !== a);
  clearTimeout(a.calmTimer);
  const session = a.session;
  // Its tasks first, so the helper count the rows send no longer has them.
  for (const [id, t] of rt.tasks) if (t.session === session) rt.tasks.delete(id);
  rt.ownBackground = ownBackgroundTasks(rt).length;
  stopHelpers(eng, rt, how === "exit" ? "exit" : "quiet", (h: Helper) => workOf(h, session));
  rt.wakes = rt.wakes.filter((w) => w.aside !== session);
  if (a.pendingRun && !eng.stopping) finishPendingRun(eng, rt, a.pendingRun, how === "stopped", how === "exit");
  if (!session.closed) session.close();
  log.info(`Bot ${rt.folder.id}: a session set aside is asleep${how === "calm" ? "; its work has ended" : ""}`);
  if (!eng.stopping && eng.bots.has(rt.folder.id)) eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}

/** Every set-aside session ends (Stop, a restart, a change of harness, the bot removed). */
export function closeAsides(eng: Engine, rt: BotRuntime, how: "stopped" | "quiet"): void {
  for (const a of [...rt.aside]) closeAside(eng, rt, a, how);
}

/** The live session and every set-aside one end. */
export function closeAllSessions(eng: Engine, rt: BotRuntime): void {
  closeAsides(eng, rt, "quiet");
  eng.closeSession(rt);
}

/**
 * The live session closes. Only its own helpers and tasks end with it; those of sessions set aside go
 * on. (Before engine 0.24.1 every helper of the bot was stopped here.)
 */
export function closeLive(eng: Engine, rt: BotRuntime): void {
  const kept = setAside(rt);
  // Closing the harness ends its helpers. Callers that can wait for them do; the rest stop them here.
  // A task manager's workers live in its session, not the bot's (engine 0.26.0).
  stopHelpers(eng, rt, "quiet", (h) => !h.manager && ![...kept].some((s) => workOf(h, s)));
  // Its commands in the background end with it; the harness's list is per process.
  for (const [id, t] of rt.tasks) if (!t.session || !kept.has(t.session)) rt.tasks.delete(id);
  rt.ownBackground = ownBackgroundTasks(rt).length;
  clearTimeout(rt.liveTimer);
  rt.liveTimer = undefined;
  clearTimeout(rt.liveCalmTimer);
  rt.liveCalmTimer = undefined;
  if (kept.size) checkLive(eng, rt);
  rt.closeWhenCalm = false;
  rt.swallow = undefined;
  // Nothing of the old process can report back any more; work of sessions set aside still can.
  if (rt.hold) {
    const alive = new Set([...rt.tasks.keys(), ...[...rt.helpers.values()].map((h) => h.taskId).filter((x): x is string => !!x)]);
    for (const id of [...rt.hold.old]) if (!alive.has(id)) rt.hold.old.delete(id);
  }
  rt.wake = undefined;
  const s = rt.session;
  rt.session = undefined;
  rt.sessionThread = undefined;
  if (s) {
    s.close();
    log.info(`Bot ${rt.folder.id}: the harness is asleep`);
  }
}

/** The bot's settings changed: the live session starts again between turns, and every set-aside one after its next turn. */
export function refreshSessions(eng: Engine, rt: BotRuntime): void {
  for (const a of rt.aside) a.stale = true;
  if (!rt.session) return;
  // Never while its helpers or commands work in the background: closing the session would end them.
  if (rt.busy || sessionWork(rt, rt.session)) rt.restartAfterTurn = true;
  else eng.closeSession(rt);
}

/**
 * After the bot's work in the background changed: each set-aside session with nothing left of it
 * sleeps after a moment (the harness may still report back), and the live session's run ends while
 * set-aside sessions still work (when nothing works at all, settleAfterHelpers does this).
 */
export function checkAsides(eng: Engine, rt: BotRuntime): void {
  for (const a of rt.aside) {
    const calm = !sessionWork(rt, a.session) && !a.swallowing && !a.waiting;
    if (!calm) {
      clearTimeout(a.calmTimer);
      a.calmTimer = undefined;
      continue;
    }
    if (a.calmTimer) continue;
    a.calmTimer = setTimeout(() => {
      a.calmTimer = undefined;
      if (rt.aside.includes(a) && !sessionWork(rt, a.session) && !a.swallowing && !a.waiting) closeAside(eng, rt, a, "calm");
      if (eng.bots.has(rt.folder.id)) checkAsides(eng, rt);
    }, eng.wakeGraceMs);
    a.calmTimer.unref?.();
  }
  const liveDone = () => !rt.busy && !eng.stopping && rt.aside.length > 0 && !!rt.session && inBackground(rt) > 0 && !sessionWork(rt, rt.session) && (!!rt.pendingRun || rt.closeWhenCalm);
  if (!liveDone()) {
    clearTimeout(rt.liveCalmTimer);
    rt.liveCalmTimer = undefined;
    return;
  }
  if (rt.liveCalmTimer) return;
  rt.liveCalmTimer = setTimeout(() => {
    rt.liveCalmTimer = undefined;
    if (!liveDone()) return;
    const run = rt.pendingRun;
    rt.pendingRun = undefined;
    if (run) finishPendingRun(eng, rt, run, false);
    if (rt.closeWhenCalm || rt.sessionThread !== rt.threadId) eng.closeSession(rt);
  }, eng.wakeGraceMs);
  rt.liveCalmTimer.unref?.();
}
