// Helpers: their rows, events and tasks, how they end and are stopped, and the turn the harness begins when they report back (docs/build/step-2e.md).
import type { Engine, HarnessSession } from "../engine.js";
import { type BotRuntime, type Helper, type HelperEnd, type HelperStart, helperWork, inBackground, type LiveTask, ownBackgroundTasks, type PobotsHelper, type Purpose, purposeOf, type RunningTool, type Turn, waitWords } from "./runtime.js";
import { randomUUID } from "node:crypto";
import { helperLine, helperTitle, now } from "./words.js";
import type { Effort, HelperItem, Methods } from "../../shared/protocol.js";
import { log } from "../log.js";
import { HANDBACK_POINTER, HANDBACK_TOOL, type HarnessEvent, HELPER_TOOLS, type LiveTaskInfo } from "../claude/session.js";
import { browserStart } from "./bot-tools.js";
import { failWords, toolKind } from "../claude/labels.js";
import { finishActivity } from "./harness-events.js";
import { afterClaudeCall, scheduleArtifactCheck } from "./artifacts.js";
import { epochOfTask, noteReport, oldHelper, oldTask, oldTaskEnded, renewHelper, stopTask, swallowTurn } from "./stop.js";
import { removeCard } from "./cards.js";
import { keepShortResult, shortHelperId } from "./helper-read.js";
import { helperEndResult, wake } from "./start-helper.js";
import { finishRun } from "./triggers.js";
import type { RestOutcome } from "../notify.js";
import { afterTurn } from "./turn-end.js";
import { MAX_HOPS } from "../team.js";
import { asideOf, asidePurpose, checkAsides } from "./aside.js";
import { EngineError } from "../errors.js";
import { workerEnded } from "./task-manager-workers.js";

/** Task statuses that mean the task has ended (the harness's task_updated). */
export const TASK_END_STATUSES = new Set(["completed", "failed", "killed", "stopped", "cancelled"]);

/** How many ended helpers of a bot are remembered, so one given more to do gets its own row back (step 3b). */
export const ENDED_HELPERS_KEPT = 50;

/** The thread where a helper's top row stands (a helper started by a helper has its row in that helper's thread). */
export function helperHome(eng: Engine, rt: BotRuntime, h: Helper): string {
  let top = h;
  for (let i = 0; i < 20 && top.parent; i++) {
    const up = rt.helpers.get(top.parent);
    if (!up) break;
    top = up;
  }
  return top.base.threadId;
}

/** What the bot is doing now, for a helper it starts; for work in a session set aside, what that session's work is for. */
export function currentPurpose(eng: Engine, rt: BotRuntime, session?: HarnessSession): Purpose {
  const aside = session && session !== rt.session ? asideOf(rt, session) : undefined;
  if (aside) return asidePurpose(rt, aside);
  if (rt.busy && rt.turn) return purposeOf(rt.turn);
  const threadId = rt.sessionThread ?? rt.threadId;
  if (rt.lastPurpose && rt.lastPurpose.threadId === threadId) return rt.lastPurpose;
  return { startedBy: "you", threadId, fresh: threadId !== rt.threadId, hops: 0 };
}

/**
 * The bot (or a helper, `parent`) called the helper tool: a helper row where it works now, and a
 * thread of its own that starts with the task.
 */
export function startHelper(eng: Engine, rt: BotRuntime, session: HarnessSession, toolUseId: string, start: HelperStart, parent?: Helper, pobots?: PobotsHelper): Helper {
  const { title, prompt } = start;
  const threadId = start.home ?? (parent ? parent.base.helperThreadId : eng.liveThread(rt));
  const itemId = randomUUID();
  const thread = eng.store.createThread(rt.folder.id, "helper", itemId);
  const base = eng.addItem(
    rt,
    {
      id: itemId,
      kind: "helper",
      at: now(),
      botId: rt.folder.id,
      title,
      helperThreadId: thread.id,
      status: "running",
      background: start.background,
      steps: 0,
      ...(start.model ? { model: start.model } : {}),
      ...(start.effort ? { effort: start.effort } : {}),
      ...(start.fast ? { fast: true } : {}),
      // For the provider's mark on its row (step 7a).
      harness: start.model ? eng.harnessOf(start.model) : (rt.sessionHarness ?? rt.folder.file.harness),
    },
    threadId,
  ) as HelperItem;
  eng.addItem(rt, { kind: "user", at: now(), text: prompt || title, from: { type: "bot", botId: rt.folder.id, expectsReply: true }, queued: false }, thread.id);
  const h: Helper = {
    toolUseId,
    base,
    status: "running",
    background: base.background,
    steps: 0,
    lastText: "",
    ...(parent ? { parent: parent.toolUseId } : {}),
    purpose: start.purpose ?? (parent ? parent.purpose : currentPurpose(eng, rt)),
    session,
    tools: new Map(),
    sentAt: Date.now(),
    stopAsked: false,
    ...(pobots ? { pobots, taskId: `pobots:${toolUseId}` } : {}),
    epoch: parent ? parent.epoch : rt.epoch,
    ...(start.manager ? { manager: start.manager } : {}),
  };
  rt.helpers.set(toolUseId, h);
  cancelSettle(eng, rt);
  log.info(`Bot ${rt.folder.id}: started a helper${parent ? " from a helper" : ""}`);
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  return h;
}

/**
 * The harness's own helper tool as a row: its title, task and whether it runs in the background,
 * and the model and effort when the call names them ("opus" and the other short names are the
 * newest model of that family).
 */
export function harnessHelperStart(eng: Engine, input: Record<string, unknown>): HelperStart {
  const raw = typeof input.model === "string" ? input.model.trim() : "";
  const family = /^(fable|opus|sonnet|haiku)$/i.test(raw) ? raw.toLowerCase() : undefined;
  const model = family ? eng.models.find((m) => m.id.startsWith(`claude-${family}-`))?.id ?? raw : raw || undefined;
  const effort = typeof input.effort === "string" && (["low", "medium", "high", "xhigh", "max"] as string[]).includes(input.effort) ? (input.effort as Effort) : undefined;
  return {
    title: helperTitle(input.description),
    prompt: typeof input.prompt === "string" ? input.prompt.trim() : "",
    background: input.run_in_background === true,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Something a helper said or did: into its own thread, and its row's line. */
export function onHelperEvent(eng: Engine, rt: BotRuntime, e: Extract<HarnessEvent, { type: "text-full" | "tool-start" | "tool-end" }>): void {
  let h = e.parent ? rt.helpers.get(rt.helperAlias.get(e.parent) ?? e.parent) : undefined;
  if (!h && e.parent && ![...rt.endedHelpers.values()].some((x) => x.toolUseId === e.parent)) {
    // A helper from before, given more to do, speaks under the call that first started it.
    const taken = new Set(rt.helperAlias.values());
    const orphans = [...rt.helpers.values()].filter((x) => x.orphan && !taken.has(x.toolUseId));
    if (orphans.length === 1) {
      rt.helperAlias.set(e.parent, orphans[0]!.toolUseId);
      h = orphans[0];
    }
  }
  if (!h) {
    // A late message from a helper that has ended: never drawn into the bot's own thread.
    log.debug(`Bot ${rt.folder.id}: a message from a helper that is no longer working was left out`);
    return;
  }
  const threadId = h.base.helperThreadId;
  if (e.type === "text-full") {
    eng.addItem(rt, { kind: "bot", at: now(), botId: rt.folder.id, text: e.text, streaming: false }, threadId);
    h.lastText = e.text.trim();
    const line = helperLine(e.text);
    if (line) h.last = line;
    sendHelperRow(eng, h);
    return;
  }
  if (e.type === "tool-start") {
    // Some helpers hand their result back with a tool of the harness instead of plain text. That is
    // the helper's answer, not a step of work: it reads as its message, once.
    if (HANDBACK_TOOL.test(e.name)) {
      const said = typeof e.input.message === "string" ? e.input.message.trim() : "";
      if (said && said !== h.lastText) {
        eng.addItem(rt, { kind: "bot", at: now(), botId: rt.folder.id, text: said, streaming: false }, threadId);
        h.lastText = said;
        const line = helperLine(said);
        if (line) h.last = line;
        sendHelperRow(eng, h);
      }
      return;
    }
    h.steps++;
    const words = eng.toolWords(e.name, e.input);
    if (HELPER_TOOLS.has(e.name)) {
      const inner = startHelper(eng, rt, h.session, e.toolUseId, harnessHelperStart(eng, e.input), h);
      h.tools.set(e.toolUseId, { itemId: inner.base.id, started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done, helper: true });
    } else {
      const home = helperHome(eng, rt, h);
      browserStart(eng, rt, e.toolUseId, e.name, e.input, home, `helper:${home}`);
      const item = eng.addItem(rt, { kind: "activity", at: now(), botId: rt.folder.id, label: words.running, ...(words.detail ? { detail: words.detail } : {}), status: "running", tool: toolKind(e.name, e.input) }, threadId);
      h.tools.set(e.toolUseId, { itemId: item.id, started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done, ...failWords(words) });
    }
    h.last = helperLine(words.running);
    sendHelperRow(eng, h);
    return;
  }
  const tool = h.tools.get(e.toolUseId);
  if (!tool) return;
  h.tools.delete(e.toolUseId);
  eng.browser.commandEnd(e.toolUseId);
  if (tool.helper) helperCallReturned(eng, rt, e.toolUseId, e.isError, e.text);
  else {
    finishActivity(eng, tool, e.isError ? "failed" : "done", e.text);
    keepShortResult(rt, tool.itemId, e.text);
  }
  if (!e.isError && !tool.helper) afterClaudeCall(eng, rt, tool, e, h);
  scheduleArtifactCheck(eng, rt);
  const next = [...h.tools.values()].at(-1);
  h.last = helperLine(next ? next.running : tool.done);
  sendHelperRow(eng, h);
}

/**
 * The tool call that started a helper came back. For a helper the caller waited for, that is its
 * end (when the harness has not said so already). One in the background answers at once and works on.
 */
export function helperCallReturned(eng: Engine, rt: BotRuntime, toolUseId: string, isError: boolean, text?: string): void {
  const h = rt.helpers.get(toolUseId);
  if (!h) return;
  if (h.pobots) {
    // A start_helper call whose helper never started (refused, or the call failed before its handler) ends its row.
    if (!h.pobots.session) endHelper(eng, rt, h, "failed", text || "The helper did not start.");
    // Otherwise the helper's own session ends the row; the call returning says nothing about it.
    return;
  }
  if (h.background || /async agent launched|async_launched|running in the background/i.test(text ?? "")) {
    if (!h.background) {
      h.background = true;
      sendHelperRow(eng, h, true);
    }
    return;
  }
  endHelper(eng, rt, h, isError ? "failed" : "done");
}

/**
 * The harness's own word on its tasks: helpers, the commands they run, and the bot's own commands
 * in the background. Seen on the real harness (step 3b, notes-engine-3b-waiting.md):
 * - a helper that starts a command in the background and stops to wait for it is reported
 *   "completed" while that command (its child in the list of live tasks) still runs; when the
 *   command ends, the same task starts again (a new run) and reports once more;
 * - a helper given more to do with SendMessage starts again under the same task id, with the
 *   SendMessage call as its tool use; its messages still name the call that first started it;
 * - the bot's own command in the background is a task of its own with no parent.
 * Shells, monitors and quiet tasks keep their activity lines as they had.
 */
export function onTaskEvent(eng: Engine, rt: BotRuntime, e: Extract<HarnessEvent, { type: "task-started" | "task-updated" | "task-ended" | "tasks-live" }>, session: HarnessSession | undefined = rt.session): void {
  const byTask = (taskId: string) => [...rt.helpers.values()].find((h) => h.taskId === taskId);
  switch (e.type) {
    case "task-started": {
      const prev = rt.tasks.get(e.taskId);
      rt.tasks.set(e.taskId, {
        ...(e.taskType ?? prev?.type ? { type: e.taskType ?? prev?.type } : {}),
        ...(e.parentTaskId ?? prev?.parent ? { parent: e.parentTaskId ?? prev?.parent } : {}),
        quiet: e.quiet || (prev?.quiet ?? false),
        background: e.background ?? prev?.background ?? false,
        ...(prev?.purpose ? { purpose: prev.purpose } : !e.parentTaskId && !prev?.parent ? { purpose: currentPurpose(eng, rt, session) } : {}),
        epoch: prev?.epoch ?? (e.toolUseId ? rt.helpers.get(e.toolUseId)?.epoch : undefined) ?? epochOfTask(eng, rt, e.parentTaskId ?? prev?.parent) ?? rt.epoch,
        ...(session ?? prev?.session ? { session: session ?? prev?.session } : {}),
      });
      // Started by work from before the Stop: it may report back too.
      if (rt.hold && !e.quiet && rt.tasks.get(e.taskId)!.epoch < rt.epoch) rt.hold.old.add(e.taskId);
      if (e.quiet || (e.taskType && e.taskType !== "local_agent") || !e.toolUseId) {
        backgroundChanged(eng, rt);
        return;
      }
      let h = rt.helpers.get(e.toolUseId) ?? byTask(e.taskId);
      if (!h) h = helperAgain(eng, rt, e.taskId, e.toolUseId, e.background, session);
      else if (h.toolUseId !== e.toolUseId) {
        // A running helper (one waiting for its own work) was given more to do: the task goes into its thread.
        const given = sendMessageGiven(eng, rt, e.toolUseId);
        if (given) eng.addItem(rt, { kind: "user", at: now(), text: given, from: { type: "bot", botId: rt.folder.id, expectsReply: true }, queued: false }, h.base.helperThreadId);
        // Given more to do by a turn of now: work of now (step 3b, third part).
        if (given) renewHelper(eng, rt, h, e.taskId);
      }
      if (!h) return;
      h.taskId = e.taskId;
      if (h.paused) {
        // It comes back after waiting for its own work: it was running all along.
        h.paused = false;
        log.info(`Bot ${rt.folder.id}: a helper came back to its work`);
      }
      if (e.background !== undefined && e.background !== h.background) {
        h.background = e.background;
        sendHelperRow(eng, h, true);
      }
      checkLive(eng, rt);
      return;
    }
    case "task-updated": {
      if (e.status && TASK_END_STATUSES.has(e.status)) oldTaskEnded(eng, rt, e.taskId);
      const t = rt.tasks.get(e.taskId);
      if (t && e.background === true && !t.background) {
        t.background = true;
        backgroundChanged(eng, rt);
      }
      const h = byTask(e.taskId);
      if (h && e.background === true && !h.background) {
        h.background = true;
        sendHelperRow(eng, h, true);
      }
      return;
    }
    case "task-ended": {
      const t = rt.tasks.get(e.taskId);
      rt.tasks.delete(e.taskId);
      const h = (e.toolUseId ? rt.helpers.get(e.toolUseId) : undefined) ?? byTask(e.taskId);
      if (!h) {
        // The bot's own command ended: the turn the harness may begin carries on what it was for.
        if (t?.purpose && t.type !== "local_agent" && !t.quiet) rt.wakePurpose = t.purpose;
        // While a Stop holds: from before it or after it. One the engine let go is still in the old set.
        if (rt.hold?.old.has(e.taskId)) oldTaskEnded(eng, rt, e.taskId);
        else if (t && !t.quiet) noteReport(eng, rt, oldTask(eng, rt, e.taskId, t));
        backgroundChanged(eng, rt);
        checkLive(eng, rt);
        return;
      }
      if (e.status === "completed" && !h.stopAsked && helperWork(rt, h).length) {
        // Not the end: it waits for commands of its own and comes back when they end.
        h.paused = true;
        const line = helperLine(e.summary && !HANDBACK_POINTER.test(e.summary) ? e.summary : "");
        if (line) h.last = line;
        sendHelperRow(eng, h, true);
        // The harness tells the bot in a turn of its own; that turn carries on what the helper was for.
        rt.wakePurpose = h.purpose;
        noteReport(eng, rt, oldHelper(eng, rt, h));
        log.info(`Bot ${rt.folder.id}: a helper waits for work of its own in the background; it is still running`);
        return;
      }
      endHelper(eng, rt, h, h.stopAsked ? "stopped" : e.status === "completed" ? "done" : e.status === "failed" ? "failed" : "stopped", e.summary);
      backgroundChanged(eng, rt);
      checkLive(eng, rt);
      return;
    }
    case "tasks-live": {
      // The harness's list of what runs in the background is the truth: it replaces what the
      // engine knew of this session. Tasks the caller waits for are not in it and stay, and so do
      // the tasks of the bot's other sessions (core/aside.ts).
      const next = new Map<string, LiveTask>();
      const listed = e.tasks ?? e.taskIds.map((taskId) => ({ taskId, quiet: false }) as LiveTaskInfo);
      for (const info of listed) {
        const prev = rt.tasks.get(info.taskId);
        const parent = info.parentTaskId ?? prev?.parent;
        next.set(info.taskId, {
          ...(info.taskType ?? prev?.type ? { type: info.taskType ?? prev?.type } : {}),
          ...(parent ? { parent } : {}),
          quiet: info.quiet || (prev?.quiet ?? false),
          background: true,
          ...(prev?.purpose ? { purpose: prev.purpose } : !parent ? { purpose: currentPurpose(eng, rt, session) } : {}),
          epoch: prev?.epoch ?? epochOfTask(eng, rt, parent) ?? rt.epoch,
          ...(session ? { session } : {}),
        });
        if (rt.hold && !info.quiet && next.get(info.taskId)!.epoch < rt.epoch) rt.hold.old.add(info.taskId);
      }
      for (const [id, t] of rt.tasks) if ((!t.background || (t.session && t.session !== session)) && !next.has(id)) next.set(id, t);
      // Old work that leaves the harness's list has ended: the harness can no longer report it back.
      if (rt.hold) for (const id of [...rt.hold.old]) if (!next.has(id) && (rt.tasks.get(id)?.background || rt.hold.letGo.has(id))) oldTaskEnded(eng, rt, id);
      rt.tasks = next;
      backgroundChanged(eng, rt);
      checkLive(eng, rt);
      return;
    }
  }
}

/**
 * A helper in the background (or one waiting for its own work) that the harness no longer lists,
 * with nothing of its own still running, has ended after a moment, even if its notice never came.
 */
export function checkLive(eng: Engine, rt: BotRuntime): void {
  // Each missing helper keeps the moment it went missing, so other tasks that change often cannot put its end off.
  const at = Date.now();
  for (const h of rt.helpers.values()) {
    const missing = (h.background || h.paused) && !!h.taskId && !h.pobots && !rt.tasks.get(h.taskId)?.background && !helperWork(rt, h).length;
    if (!missing) h.missingSince = undefined;
    else h.missingSince ??= at;
  }
  clearTimeout(rt.liveTimer);
  rt.liveTimer = undefined;
  const since = [...rt.helpers.values()].map((h) => h.missingSince).filter((x): x is number => x !== undefined);
  if (!since.length) return;
  const due = Math.max(0, Math.min(...since) + eng.liveCheckMs - at);
  rt.liveTimer = setTimeout(() => {
    rt.liveTimer = undefined;
    const now2 = Date.now();
    for (const h of [...rt.helpers.values()]) {
      if (h.missingSince === undefined || now2 - h.missingSince < eng.liveCheckMs) continue;
      if (!h.paused) log.warn(`Bot ${rt.folder.id}: a helper in the background ended without a notice from the harness`);
      else log.info(`Bot ${rt.folder.id}: a helper's own work ended and it did not come back; it is done`);
      endHelper(eng, rt, h, h.stopAsked ? "stopped" : h.lastText ? "done" : "stopped");
    }
    backgroundChanged(eng, rt);
    checkLive(eng, rt);
  }, due);
  rt.liveTimer.unref?.();
}

/**
 * The harness's tasks changed. Whether the bot waits or rests is worked out from what runs now, not
 * from a count kept from before: the waiting line when something runs, and rest when nothing does
 * while the bot still reads as waiting for it.
 */
export function backgroundChanged(eng: Engine, rt: BotRuntime): void {
  const own = ownBackgroundTasks(rt).length;
  if (own !== rt.ownBackground) {
    log.info(`Bot ${rt.folder.id}: ${own ? `${own} command${own === 1 ? "" : "s"} of its own run${own === 1 ? "s" : ""} in the background` : "its commands in the background have ended"}`);
    rt.ownBackground = own;
  }
  if (rt.aside.length && !eng.stopping) checkAsides(eng, rt);
  if (rt.busy || eng.stopping || !eng.bots.has(rt.folder.id) || rt.state === "waiting") return;
  const n = inBackground(rt);
  if (n) {
    // While stopping, the line stays "Stopping"; no rest while something still runs.
    if (rt.state === "working" && rt.activity === "Stopping") {
      cancelSettle(eng, rt);
      return;
    }
    // Shown already, and no rest on its way: nothing to do.
    if (rt.state === "working" && rt.activity === waitWords(rt) && !rt.settleTimer) return;
    afterHelpersChanged(eng, rt);
    return;
  }
  // Nothing runs, the bot still reads as working without a turn, and no rest is on its way: rest now.
  if (rt.state === "working" && !rt.settleTimer) afterHelpersChanged(eng, rt);
}

/** Cancels a rest that was on its way. */
export function cancelSettle(eng: Engine, rt: BotRuntime): void {
  clearTimeout(rt.settleTimer);
  rt.settleTimer = undefined;
}

/**
 * A helper task starts again that has no running row: one that had ended and is given more to do
 * (SendMessage), or comes back by itself. Its row goes back to running, in its place. A helper
 * stopped on request does not come back by itself. With no row to go back to (one from before a
 * restart), a continuation given with SendMessage gets a new row.
 */
export function helperAgain(eng: Engine, rt: BotRuntime, taskId: string, toolUseId: string, background?: boolean, session: HarnessSession | undefined = rt.session): Helper | undefined {
  if (!session) return undefined;
  const call = callOf(eng, rt, toolUseId);
  const given = sendMessageGiven(eng, rt, toolUseId);
  const old = rt.endedHelpers.get(taskId);
  if (old && !(old.stopAsked && old.toolUseId === toolUseId)) {
    rt.endedHelpers.delete(taskId);
    clearTimeout(old.stopTimer);
    old.status = "running";
    old.endedAt = undefined;
    old.paused = false;
    old.missingSince = undefined;
    old.stopAsked = false;
    old.session = session;
    old.tools = new Map();
    old.purpose = currentPurpose(eng, rt, session);
    // Given more to do now, it is work of now; one that comes back by itself stays as old as it was.
    if (given) renewHelper(eng, rt, old, taskId);
    // A helper that comes back runs in the background (the harness registers it so).
    old.background = old.background || background !== false;
    // Its messages still name the call that first started it, so it keeps that key.
    rt.helpers.set(old.toolUseId, old);
    if (given) eng.addItem(rt, { kind: "user", at: now(), text: given, from: { type: "bot", botId: rt.folder.id, expectsReply: true }, queued: false }, old.base.helperThreadId);
    cancelSettle(eng, rt);
    sendHelperRow(eng, old, true);
    log.info(`Bot ${rt.folder.id}: a helper that had ended is working again${given ? " on more it was given" : ""}`);
    eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
    if (!rt.busy) afterHelpersChanged(eng, rt);
    return old;
  }
  if (old || !given || !call) return undefined;
  const title = typeof call.input.summary === "string" && call.input.summary.trim() ? call.input.summary : "Helper";
  const h = startHelper(eng, rt, session, toolUseId, { title: helperTitle(title), prompt: given, background: true });
  h.taskId = taskId;
  h.orphan = true;
  log.info(`Bot ${rt.folder.id}: a helper from before was given more to do; it gets a new row`);
  if (!rt.busy) afterHelpersChanged(eng, rt);
  return h;
}

/** A tool call that is running now, of the bot or of one of its helpers. */
export function callOf(eng: Engine, rt: BotRuntime, toolUseId: string): RunningTool | undefined {
  return rt.tools.get(toolUseId) ?? [...rt.helpers.values()].map((x) => x.tools.get(toolUseId)).find(Boolean);
}

/** What a SendMessage call gave a helper to do, when that call is the one named. */
export function sendMessageGiven(eng: Engine, rt: BotRuntime, toolUseId: string): string | undefined {
  const call = callOf(eng, rt, toolUseId);
  if (!call || call.name !== "SendMessage") return undefined;
  const v = typeof call.input.message === "string" ? call.input.message : typeof call.input.content === "string" ? call.input.content : "";
  return v.trim() || undefined;
}

/** A helper ended. Its row says how, at once, and the bot may now be calm. */
export function endHelper(eng: Engine, rt: BotRuntime, h: Helper, status: Exclude<HelperItem["status"], "running">, summary?: string, settle = true): void {
  if (h.status !== "running") return;
  clearTimeout(h.stopTimer);
  h.status = status;
  h.endedAt = now();
  for (const t of h.tools.values()) {
    if (t.helper) {
      const inner = [...rt.helpers.values()].find((x) => x.base.id === t.itemId);
      if (inner) endHelper(eng, rt, inner, status === "done" ? "done" : "stopped", undefined, false);
    } else finishActivity(eng, t, status === "done" ? "done" : "failed");
  }
  eng.browser.endCommandsOf(h.tools.keys());
  h.tools.clear();
  if (status === "done" || status === "failed") {
    // After a hand-back by tool the harness's summary only points at that call; the result is what the helper said.
    const line = helperLine((summary && !HANDBACK_POINTER.test(summary) ? summary : "") || h.lastText);
    if (line) h.last = line;
  }
  sendHelperRow(eng, h, true);
  rt.helpers.delete(h.toolUseId);
  h.paused = false;
  h.missingSince = undefined;
  // Kept for a while: the bot may give it more to do, and then the same row works again (step 3b).
  if (!h.pobots && h.taskId) {
    rt.endedHelpers.delete(h.taskId);
    rt.endedHelpers.set(h.taskId, h);
    while (rt.endedHelpers.size > ENDED_HELPERS_KEPT) rt.endedHelpers.delete(rt.endedHelpers.keys().next().value!);
  }
  for (const [id, p] of [...eng.cards]) if (p.helper === h.toolUseId) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
  // A task manager's worker reports to its manager, never to the bot (engine 0.26.0).
  if (!h.manager) {
    rt.wakePurpose = h.purpose;
    noteReport(eng, rt, oldHelper(eng, rt, h));
  }
  if (h.taskId) oldTaskEnded(eng, rt, h.taskId);
  log.info(`Bot ${rt.folder.id}: a helper ended (${status})`);
  // Step 7b: the helper's thread gets its title.
  eng.titles.add({ threadId: h.base.helperThreadId, botId: rt.folder.id, kind: "helper", fromSeq: 0 });
  if (h.pobots) {
    const pobots = h.pobots;
    pobots.shortener?.dispose();
    const session = pobots.session;
    if (session && !session.closed) session.close();
    const end: HelperEnd = { status: status === "done" ? "done" : status === "failed" ? "failed" : "stopped", text: status === "done" ? h.lastText : summary ?? "" };
    pobots.finish(end);
    if (h.manager) workerEnded(eng, rt, h, end);
    // A helper the bot did not wait for is told in a turn of its own, as a harness helper in the background is.
    else if (!pobots.wait && pobots.tell && pobots.session) wake(eng, rt, { text: helperEndResult(eng, pobots.title, end, shortHelperId(h.base.id)).content[0]!.text, purpose: h.purpose });
  }
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  if (settle && !h.manager) afterHelpersChanged(eng, rt);
}

/** Sends a helper's row: at once when urgent or quiet for a second, else once the second is over. */
export function sendHelperRow(eng: Engine, h: Helper, urgent = false): void {
  if (!eng.store.isOpen) return;
  const item: HelperItem = {
    ...h.base,
    status: h.status,
    background: h.background,
    steps: h.steps,
    ...(h.last ? { last: h.last } : {}),
    ...(h.endedAt ? { endedAt: h.endedAt } : {}),
  };
  const at = Date.now();
  if (urgent || at - h.sentAt >= eng.helperRowMs) {
    clearTimeout(h.rowTimer);
    h.rowTimer = undefined;
    h.sentAt = at;
    eng.putItem(item);
    return;
  }
  if (h.rowTimer) return;
  h.rowTimer = setTimeout(() => {
    h.rowTimer = undefined;
    sendHelperRow(eng, h, true);
  }, h.sentAt + eng.helperRowMs - at);
  h.rowTimer.unref?.();
}

/**
 * After a helper or a command in the background ended or started with no turn running: the waiting
 * line, or, once nothing is left, rest.
 */
export function afterHelpersChanged(eng: Engine, rt: BotRuntime): void {
  if (rt.aside.length && !eng.stopping) checkAsides(eng, rt);
  if (eng.stopping || rt.busy || !eng.bots.has(rt.folder.id)) return;
  const n = inBackground(rt);
  cancelSettle(eng, rt);
  if (n) {
    // The bot may have read done before (a helper given more to do): it is working again, and how it reads afterwards stays.
    if (!rt.afterHelpers && (rt.state === "done" || rt.state === "blocked")) rt.afterHelpers = { state: rt.state, activity: rt.activity };
    else if (!rt.afterHelpers && rt.state === "idle") rt.afterHelpers = { state: "done", activity: "Finished" };
    if (rt.state !== "waiting") eng.setState(rt, "working", waitWords(rt));
    return;
  }
  // The harness usually wakes the bot when a helper ends. Wait a moment for that before resting.
  rt.settleTimer = setTimeout(() => settleAfterHelpers(eng, rt), eng.wakeGraceMs);
  rt.settleTimer.unref?.();
}

/** The last helper has ended and no turn followed: what waited for that happens now, and the bot rests. */
export function settleAfterHelpers(eng: Engine, rt: BotRuntime): void {
  rt.settleTimer = undefined;
  if (eng.stopping || rt.busy || inBackground(rt) || !eng.bots.has(rt.folder.id)) return;
  rt.wakePurpose = undefined;
  const run = rt.pendingRun;
  rt.pendingRun = undefined;
  if (run) finishPendingRun(eng, rt, run, false);
  if (rt.closeWhenCalm || rt.restartAfterTurn || (rt.session && rt.sessionThread !== rt.threadId)) eng.closeSession(rt);
  const back = rt.afterHelpers ?? { state: "done" as const, activity: "Finished" };
  rt.afterHelpers = undefined;
  const rest = rt.restNotice;
  rt.restNotice = undefined;
  eng.setState(rt, back.state, back.activity);
  // The turn the person asked for is done now that its helpers are. Never after a stop.
  if (rest && back.activity !== "Stopped" && (back.state === "done" || back.state === "blocked")) {
    const outcome: RestOutcome = back.state === "blocked" ? "failed" : "finished";
    eng.notifier.cameToRest(rt.folder.id, outcome, rest.startedBy);
  }
  afterTurn(eng, rt, rt.sessionThread === rt.threadId && back.state === "done" && back.activity === "Finished");
}

/** A trigger run whose turn ended while its helpers worked ends now, with the last message it had. */
export function finishPendingRun(eng: Engine, rt: BotRuntime, run: NonNullable<BotRuntime["pendingRun"]>, interrupted: boolean, failed = false): void {
  const turn: Turn = { id: randomUUID(), threadId: run.threadId, fresh: run.fresh, runId: run.runId, hops: 0, startedBy: "trigger", lastText: run.lastText, tidy: false, ...(run.label ? { runLabel: run.label } : {}) };
  finishRun(eng, rt, turn, interrupted, failed);
}

/**
 * The harness began a turn by itself, as when a helper in the background reports back. It is a
 * turn like any other: an id, busy for its length, the queue waits, and its end follows the usual
 * rules. It carries on what the helper's turn was for.
 */
export function beginHarnessTurn(eng: Engine, rt: BotRuntime, session: HarnessSession): void {
  if (rt.busy || eng.stopping || rt.session !== session) return;
  // While a Stop holds, only work started after it may report back in a turn (step 3b, third part).
  // When old and new work both reported, the old wins: the turn is ended, and the new result stays
  // in the session for the next turn. When nothing can be placed, the turn is ended only while
  // work from before the Stop may still report back.
  if (rt.hold && (rt.wake ? rt.wake.old : rt.hold.old.size > 0)) {
    swallowTurn(eng, rt, session);
    return;
  }
  rt.wake = undefined;
  const threadId = rt.sessionThread ?? rt.threadId;
  const fresh = threadId !== rt.threadId;
  const p0 = rt.wakePurpose ?? rt.lastPurpose;
  const p = p0 && p0.threadId === threadId ? p0 : undefined;
  rt.wakePurpose = undefined;
  cancelSettle(eng, rt);
  clearTimeout(rt.doneTimer);
  clearTimeout(rt.sleepTimer);
  rt.afterHelpers = undefined;
  // This turn carries on the work; its own end tells "finished".
  rt.restNotice = undefined;
  rt.busy = true;
  rt.current = undefined;
  rt.interruptRequested = false;
  rt.retriedFresh = true;
  rt.turnError = undefined;
  rt.turn = {
    id: randomUUID(),
    threadId,
    fresh,
    hops: p?.hops ?? 0,
    startedBy: p?.startedBy ?? "you",
    lastText: "",
    tidy: false,
    harness: true,
    begun: true,
    ...(p?.runId ? { runId: p.runId } : {}),
    ...(p?.runLabel ? { runLabel: p.runLabel } : {}),
    ...(p?.channelRid ? { channelRid: p.channelRid } : {}),
    ...(p?.askFrom ? { askFrom: p.askFrom } : {}),
  };
  log.info(`Bot ${rt.folder.id}: the harness began a turn by itself`);
  eng.setState(rt, "thinking", "Thinking");
}

/** After a turn the harness began, a bot that waited for this bot's answer is told the last message. */
export function tellAfterHelper(eng: Engine, rt: BotRuntime, to: string, text: string, hops: number): void {
  const asker = eng.bots.get(to);
  if (!asker || eng.stopping || !eng.harnessReady(asker) || hops + 1 > MAX_HOPS) return;
  eng.enqueue(asker, text, { type: "bot", botId: rt.folder.id, expectsReply: false }, { hops: hops + 1 });
}

/** helper.stop: stops one helper through the harness. Its row says "stopped" once the harness confirms. */
export async function stopHelper(eng: Engine, params: Methods["helper.stop"]["params"]): Promise<void> {
  const rt = eng.bot(params.botId);
  const h = [...rt.helpers.values()].find((x) => x.base.id === params.itemId);
  if (!h) {
    const item = eng.store.getItem(params.itemId);
    if (item?.kind === "helper" && item.botId === rt.folder.id) return;
    throw new EngineError("not_found", "There is no such helper.");
  }
  if (h.stopAsked) return;
  expectStop(eng, rt, h);
  if (h.pobots) {
    // Its own session: stopped at once. The bot is told, as with a harness helper.
    endHelper(eng, rt, h, "stopped");
    return;
  }
  if (h.paused && !h.session.closed && helperWork(rt, h).length) {
    // It waits for commands of its own: those are what still runs. Its row says stopped when they
    // have (or after the usual grace, see expectStop).
    for (const id of helperWork(rt, h)) stopTask(eng, rt, id);
  } else if (h.taskId && !h.session.closed) {
    try {
      await h.session.stopTask(h.taskId);
    } catch (err) {
      log.warn(`Bot ${rt.folder.id}: could not stop a helper`, err);
    }
  } else {
    endHelper(eng, rt, h, "stopped");
  }
}

/** A helper is to stop: its cards go, and if the harness never confirms, it is marked stopped anyway. */
export function expectStop(eng: Engine, rt: BotRuntime, h: Helper): void {
  if (h.stopAsked) return;
  h.stopAsked = true;
  for (const [id, p] of [...eng.cards]) if (p.helper === h.toolUseId) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
  h.stopTimer = setTimeout(() => {
    if (h.status === "running") {
      log.warn(`Bot ${rt.folder.id}: a helper did not confirm that it stopped`);
      endHelper(eng, rt, h, "stopped");
    }
  }, eng.helperStopMs);
  h.stopTimer.unref?.();
}

/**
 * Every helper still working is stopped because its harness went away: on a restart and when the
 * process ended (with a notice in each thread and a word for the bot at its next turn), or quietly.
 */
export function stopHelpers(eng: Engine, rt: BotRuntime, why: "restart" | "exit" | "quiet", only?: (h: Helper) => boolean): void {
  const running = [...rt.helpers.values()].filter((h) => !only || only(h));
  if (!running.length) return;
  const byThread = new Map<string, string[]>();
  for (const h of running) {
    if (h.status !== "running") continue;
    if (h.pobots) h.pobots.tell = false;
    // A helper started by another helper is stopped with it, and named in its thread.
    byThread.set(h.base.threadId, [...(byThread.get(h.base.threadId) ?? []), h.base.title]);
    endHelper(eng, rt, h, "stopped", undefined, false);
  }
  if (why !== "quiet") for (const [threadId, titles] of byThread) helpersStoppedNotice(eng, rt.folder.id, threadId, titles, why, true);
  // After a planned close the caller sets how the bot reads. After the process went away, the bot rests once nothing follows.
  if (why === "exit" && !rt.busy) afterHelpersChanged(eng, rt);
}

/** One notice in a thread whose helpers were stopped, and news for the bot when it is its main chat. */
export function helpersStoppedNotice(eng: Engine, botId: string, threadId: string, titles: string[], why: "restart" | "exit", live: boolean): void {
  const n = titles.length;
  const which = n === 1 ? "a helper was" : `${n} helpers were`;
  const text = why === "restart" ? `Pobots restarted, so ${which} stopped` : `The bot stopped unexpectedly, so ${which} stopped`;
  const item = eng.store.addItem(threadId, { kind: "notice", at: now(), text, tone: "info" });
  if (live) eng.opts.emit("item.upsert", { item });
  if (eng.store.getThread(threadId)?.kind !== "main") return;
  const names = titles.map((t) => `"${t}"`).join(", ");
  const cause = why === "restart" ? "Pobots restarted" : "your harness process stopped unexpectedly";
  eng.store.addNews(
    botId,
    threadId,
    n === 1
      ? `Note from Pobots: a helper you started was stopped before it reported back, because ${cause}: ${names}. Its result is lost. Start it again if you still need it.`
      : `Note from Pobots: ${n} helpers you started were stopped before they reported back, because ${cause}: ${names}. Their results are lost. Start them again if you still need them.`,
  );
}
