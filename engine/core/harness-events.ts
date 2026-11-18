// What a bot's session reports: the harness's events during a turn, the streamed items, and the bot's own to-do list (step 7a).
import { botSaid } from "./card-questions.js";
import { asideOf, onAsideEvent, workOf } from "./aside.js";
import type { Engine, HarnessSession } from "../engine.js";
import type { BotRuntime, RunningTool } from "./runtime.js";
import { applyTaskTool, type KeptPlan, planDone, readKept, todoWriteSteps } from "../plan.js";
import { apiErrorSentence, clip, now } from "./words.js";
import { type HarnessEvent, HELPER_TOOLS, TOOL_SERVER, toolId } from "../claude/session.js";
import { log } from "../log.js";
import { swallowed } from "./stop.js";
import type { BotItem, Item } from "../../shared/protocol.js";
import { TOOL_NAMES } from "../team.js";
import { browserStart } from "./bot-tools.js";
import { failWords, toolKind } from "../claude/labels.js";
import { afterClaudeCall, scheduleArtifactCheck } from "./artifacts.js";
import { backInLine } from "./steering.js";
import { ensureSession } from "./turn-start.js";
import { afterTurn, finishTurn, noteUsage } from "./turn-end.js";
import { startHelperProblem, startPobotsRow } from "./start-helper.js";
import { backgroundChanged, beginHarnessTurn, harnessHelperStart, helperCallReturned, onHelperEvent, onTaskEvent, startHelper, stopHelpers } from "./helpers.js";

export function keptPlan(eng: Engine, rt: BotRuntime): KeptPlan | undefined {
  if (rt.plan === undefined) rt.plan = readKept(eng.store.getValue(`plan:${rt.folder.id}`)) ?? null;
  return rt.plan ?? undefined;
}

/** Saves a new state of the bot's to-do list (undefined: none) and tells the window. */
export function setPlan(eng: Engine, rt: BotRuntime, next: KeptPlan | undefined): void {
  const key = `plan:${rt.folder.id}`;
  if (!next) {
    if (!keptPlan(eng, rt)) return;
    rt.plan = null;
    eng.store.deleteValue(key);
  } else {
    const kept: KeptPlan = { plan: { ...next.plan, updatedAt: now(), ...(rt.busy && rt.turn ? { turnId: rt.turn.id } : {}) }, keys: next.keys };
    if (!next.plan.explanation) delete kept.plan.explanation;
    rt.plan = kept;
    eng.store.setValue(key, JSON.stringify(kept));
  }
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}

/** Claude's to-do tools: TodoWrite gives the whole list when called; the task tools when they come back. */
export function planFromTool(eng: Engine, rt: BotRuntime, name: string, input: Record<string, unknown>, end?: { isError: boolean; result?: unknown; text?: string }): void {
  if (name === "TodoWrite") {
    if (end) return;
    const steps = todoWriteSteps(input);
    if (steps) setPlan(eng, rt, steps.length ? { plan: { steps, updatedAt: "" }, keys: steps.map(() => "") } : undefined);
    return;
  }
  if (!end || end.isError || !/^Task(Create|Update|List)$/.test(name)) return;
  const kept = keptPlan(eng, rt);
  // A new list once the old one is all done and from an earlier turn.
  const fresh = !!kept && planDone(kept.plan) && kept.plan.turnId !== rt.turn?.id;
  const next = applyTaskTool(kept, name, input, end.result, end.text, fresh);
  if (next) setPlan(eng, rt, next.plan.steps.length ? next : undefined);
}

export function onHarnessEvent(eng: Engine, rt: BotRuntime, session: HarnessSession, e: HarnessEvent): void {
  if (rt.session !== session) {
    // A session set aside while its helpers work (core/aside.ts); any other is gone.
    const aside = asideOf(rt, session);
    if (aside) onAsideEvent(eng, rt, aside, e);
    return;
  }
  try {
    handleHarnessEvent(eng, rt, session, e);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not handle a harness event`, err);
  }
}

export function handleHarnessEvent(eng: Engine, rt: BotRuntime, session: HarnessSession, e: HarnessEvent): void {
  // What a helper said or did goes to its own thread, never to the bot's.
  if ((e.type === "text-full" || e.type === "tool-start" || e.type === "tool-end") && e.parent) {
    onHelperEvent(eng, rt, e);
    return;
  }
  // A turn the harness began by itself while a Stop holds is being ended: nothing of it shows.
  if (rt.swallow) {
    if (rt.swallow !== session) rt.swallow = undefined;
    else if (swallowed(eng, rt, session, e)) return;
  }
  // The model is at work with no turn of ours running: the harness began a turn by itself.
  if (!rt.busy && (e.type === "thinking" || e.type === "thought" || e.type === "text-start" || e.type === "text-delta" || e.type === "text-full" || e.type === "tool-start")) {
    beginHarnessTurn(eng, rt, session);
    if (rt.swallow === session) return;
  }
  switch (e.type) {
    case "turn-start": {
      if (e.own) {
        if (rt.busy && rt.turn && !rt.turn.harness) rt.turn.begun = true;
      } else if (!rt.busy) {
        beginHarnessTurn(eng, rt, session);
      } else if (rt.turn && !rt.turn.harness && !rt.turn.begun) {
        // Our message waits behind a turn the harness began by itself; what it says goes with this turn.
        log.info(`Bot ${rt.folder.id}: the harness began a turn of its own before taking up the message`);
      }
      return;
    }
    case "task-started":
    case "task-updated":
    case "task-ended":
    case "tasks-live":
      onTaskEvent(eng, rt, e, session);
      return;
    case "session": {
      const thread = rt.sessionThread ?? rt.threadId;
      eng.store.setSessionId(thread, e.sessionId);
      eng.store.setSessionMeta(thread, { harness: rt.sessionHarness ?? "claude", ...(rt.sessionTools ? { tools: rt.sessionTools } : {}) });
      if (rt.switchHanded) {
        rt.switchHanded = false;
        eng.store.setHarnessSwitch(thread, null);
        eng.store.setContext(thread, { notePending: false });
      }
      rt.resumedFrom = undefined;
      if (rt.sessionThread === rt.threadId && rt.newMainSession) {
        // A new session behind the main chat: it starts empty, and the note has reached it.
        rt.newMainSession = false;
        // Its harness starts a new to-do list too (step 7a).
        setPlan(eng, rt, undefined);
        eng.store.setContext(rt.threadId, { since: now(), tokens: 0, ...(rt.noteHanded ? { notePending: false } : {}) });
        rt.noteHanded = false;
      }
      if (!eng.modelsFromHarness && (rt.sessionHarness ?? "claude") === "claude") void eng.refreshModels(session);
      return;
    }
    case "thinking":
      if (rt.busy && rt.state !== "waiting" && rt.tools.size === 0) eng.setState(rt, "thinking", "Thinking");
      return;
    case "thought": {
      // A thinking summary is a line of work of its own, in its order (step 7a): its first line as the
      // label, the whole summary behind it.
      for (const key of [...rt.textItems.keys()]) closeBotItem(eng, rt, key);
      const first = e.text.split("\n").find((l) => l.trim()) ?? e.text;
      const label = first.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
      eng.addItem(rt, { kind: "activity", at: now(), botId: rt.folder.id, label: label || "Thought", ...(e.text.trim() !== first.trim() || label !== first.trim() ? { detail: e.text } : {}), status: "done", tool: "think" });
      return;
    }
    case "plan":
      // Codex's plan, whole (step 7a).
      setPlan(eng, rt, e.steps.length ? { plan: { steps: e.steps, updatedAt: "", ...(e.explanation ? { explanation: e.explanation } : {}) }, keys: e.steps.map(() => "") } : undefined);
      return;
    case "text-start": {
      rt.streamedKeys.add(e.key);
      const id = rt.textItems.get(e.key);
      if (!id) openBotItem(eng, rt, e.key, "");
      else {
        const item = eng.live.get(id) as BotItem | undefined;
        if (item && item.text) appendText(eng, rt, item, "\n\n");
      }
      if (rt.state !== "waiting") eng.setState(rt, "thinking", "Writing a reply");
      return;
    }
    case "text-delta": {
      const id = rt.textItems.get(e.key) ?? openBotItem(eng, rt, e.key, "").id;
      const item = eng.live.get(id) as BotItem | undefined;
      if (item) appendText(eng, rt, item, e.text);
      return;
    }
    case "text-full": {
      if (rt.streamedKeys.has(e.key)) return;
      const id = rt.textItems.get(e.key);
      if (!id) openBotItem(eng, rt, e.key, e.text);
      else {
        const item = eng.live.get(id) as BotItem | undefined;
        if (item) appendText(eng, rt, item, (item.text ? "\n\n" : "") + e.text);
      }
      return;
    }
    case "text-end":
      closeBotItem(eng, rt, e.key);
      return;
    case "tool-start": {
      for (const key of [...rt.textItems.keys()]) closeBotItem(eng, rt, key);
      const words = eng.toolWords(e.name, e.input);
      const pobotsHelper = e.name === toolId(TOOL_NAMES.startHelper) && !startHelperProblem(eng, rt, e.input);
      if (HELPER_TOOLS.has(e.name) || pobotsHelper) {
        // A helper: one row and a thread of its own, in place of an activity line.
        const h = pobotsHelper ? startPobotsRow(eng, rt, session, e.toolUseId, e.input) : startHelper(eng, rt, session, e.toolUseId, harnessHelperStart(eng, e.input));
        rt.tools.set(e.toolUseId, { itemId: h.base.id, started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done, helper: true });
        if (rt.state !== "waiting") eng.setState(rt, "working", words.running);
        return;
      }
      browserStart(eng, rt, e.toolUseId, e.name, e.input, eng.liveThread(rt), rt.turn?.id ?? `rest:${rt.folder.id}`);
      const item = eng.addItem(rt, {
        kind: "activity",
        at: now(),
        botId: rt.folder.id,
        label: words.running,
        ...(words.detail ? { detail: words.detail } : {}),
        status: "running",
        tool: toolKind(e.name, e.input),
      });
      rt.tools.set(e.toolUseId, { itemId: item.id, started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done, ...failWords(words) });
      if (rt.state !== "waiting") eng.setState(rt, "working", words.running);
      planFromTool(eng, rt, e.name, e.input);
      return;
    }
    case "tool-end": {
      const tool = rt.tools.get(e.toolUseId);
      if (!tool) return;
      rt.tools.delete(e.toolUseId);
      if (!tool.helper) planFromTool(eng, rt, tool.name, tool.input, { isError: e.isError, result: e.result, text: e.full ?? e.text });
      if (tool.helper) helperCallReturned(eng, rt, e.toolUseId, e.isError, e.text);
      else finishActivity(eng, tool, e.isError ? "failed" : "done", e.text);
      if (!e.isError && !tool.helper) afterClaudeCall(eng, rt, tool, e);
      eng.browser.commandEnd(e.toolUseId);
      scheduleArtifactCheck(eng, rt);
      if (rt.state !== "waiting") {
        const next = [...rt.tools.values()].at(-1);
        if (next) eng.setState(rt, "working", next.running);
        else eng.setState(rt, "thinking", "Thinking");
      }
      return;
    }
    case "api-error": {
      const sentence = apiErrorSentence(e.code);
      rt.turnError = e.code;
      eng.notice(rt, sentence, "error");
      return;
    }
    case "compacted": {
      log.info(`Bot ${rt.folder.id}: the harness shortened the session by itself (${e.trigger}${e.preTokens ? `, ${e.preTokens} tokens before` : ""})`);
      if (rt.sessionThread === rt.threadId) {
        eng.addItem(rt, { kind: "notice", at: now(), text: "The session was nearly full, so it was shortened in the middle of this task", tone: "info", mark: "compacted" }, rt.threadId);
      }
      return;
    }
    case "steer-returned":
      backInLine(eng, rt, e.ids, "it was given back unread");
      return;
    case "turn-end": {
      if (e.sessionId) eng.store.setSessionId(rt.sessionThread ?? rt.threadId, e.sessionId);
      if (e.usage) noteUsage(eng, rt, e.usage);
      // Steered messages this turn ended before taking up: the harness runs them next by itself.
      if (e.ahead?.length) rt.ahead = [...(rt.ahead ?? []), ...e.ahead];
      if (!rt.busy) {
        if (rt.ahead?.length) afterTurn(eng, rt, false);
        return;
      }
      // The end of a turn the harness ran by itself before taking up our message: ours goes on.
      if (e.own === false && rt.turn && !rt.turn.harness && !rt.turn.begun && e.ok) {
        log.info(`Bot ${rt.folder.id}: a turn the harness began by itself ended; the message's own turn follows`);
        return;
      }
      finishTurn(eng, rt, { ok: e.ok, errors: e.errors, subtype: e.subtype });
      return;
    }
    case "exit": {
      rt.session = undefined;
      if (eng.stopping) return;
      // What ran in the background went with the process, and nothing of it can report back. Work of
      // sessions set aside goes on (core/aside.ts).
      for (const [id, t] of rt.tasks) if (!t.session || t.session === session) rt.tasks.delete(id);
      rt.hold?.old.clear();
      rt.wake = undefined;
      clearTimeout(rt.liveTimer);
      stopHelpers(eng, rt, "exit", (h) => !h.manager && !rt.aside.some((a) => workOf(h, a.session)));
      backgroundChanged(eng, rt);
      if (!rt.busy) {
        if (e.error) log.warn(`Bot ${rt.folder.id}: the harness stopped while the bot was resting`);
        return;
      }
      // A resume that failed before the session even started: start fresh with a handoff. Not for a
      // tidy turn: a new session has nothing to tidy.
      if (rt.resumedFrom && e.beforeInit && !rt.retriedFresh && rt.current && !rt.interruptRequested && !rt.turn?.tidy) {
        log.warn(`Bot ${rt.folder.id}: could not resume session, starting a fresh one`);
        rt.retriedFresh = true;
        eng.store.setSessionId(rt.turn?.threadId ?? rt.threadId, null);
        const item = rt.current;
        void ensureSession(eng, rt, true)
          .then(({ session: fresh, handoff }) => {
            if (rt.current === item) fresh.send(item.text, handoff ?? []);
          })
          .catch((err) => {
            log.error(`Bot ${rt.folder.id}: could not start a fresh session`, err);
            eng.notice(rt, "The bot could not start. The details are in the engine log.", "error");
            rt.turnError = "start";
            finishTurn(eng, rt, { ok: false, errors: [], subtype: "start_failed" });
          });
        return;
      }
      if (rt.interruptRequested) {
        finishTurn(eng, rt, { ok: true, errors: [], subtype: "interrupted" });
        return;
      }
      if (e.error && rt.sessionHarness === "codex" && /ENOENT|spawn/i.test(e.error) && e.beforeInit) {
        eng.codex = { ...eng.codex, ready: false, problem: "Codex could not be started on this computer. Check that it works in a terminal on the Mac." };
        eng.opts.emit("status.updated", { status: eng.status(), models: eng.modelList() });
      } else if (e.error && rt.sessionHarness !== "codex" && /ENOENT|not found|spawn/i.test(e.error) && e.beforeInit) {
        eng.opts.claude.ready = false;
        eng.opts.claude.problem = "Claude could not be started on this computer. Check that it works in a terminal, then restart Pobots.";
        eng.opts.emit("status.updated", { status: eng.status(), models: eng.modelList() });
      }
      eng.notice(rt, "The bot stopped unexpectedly. Send a message to start it again.", "error");
      rt.turnError = "exit";
      finishTurn(eng, rt, { ok: false, errors: [], subtype: "exit" });
      return;
    }
  }
}

export function openBotItem(eng: Engine, rt: BotRuntime, key: string, text: string): Item {
  const item = eng.addItem(rt, { kind: "bot", at: now(), botId: rt.folder.id, text, streaming: true });
  rt.textItems.set(key, item.id);
  eng.live.set(item.id, item);
  return item;
}

export function appendText(eng: Engine, rt: BotRuntime, item: BotItem, text: string): void {
  if (!text) return;
  item.text += text;
  eng.dirty.add(item.id);
  eng.scheduleFlush();
  eng.opts.emit("item.delta", { threadId: item.threadId, itemId: item.id, textDelta: text });
}

export function closeBotItem(eng: Engine, rt: BotRuntime, key: string): void {
  const id = rt.textItems.get(key);
  if (!id) return;
  rt.textItems.delete(key);
  const item = (eng.live.get(id) ?? eng.store.getItem(id)) as BotItem | undefined;
  if (!item) return;
  item.streaming = false;
  if (rt.turn && item.text.trim()) rt.turn.lastText = item.text.trim();
  if (item.text.trim()) botSaid(eng, rt, item.id, item.text);
  eng.putItem(item);
}

/** Ends a call's line. `answer` is the tool's answer: for a call whose words say so, a failed
 *  call shows it as the line's detail, the way T3 Code shows a failed call's message. */
/**
 * How a call that a restart cut short ends. A question whose card stays open (WAITED_NOTICE) was
 * asked: its line stays "Asked you a question", not "Could not ask you a question". Every other
 * call cut short is failed, in its failed words.
 */
export function cutShortStatus(tool: RunningTool, cardStays: boolean): "done" | "failed" {
  return cardStays && tool.name === `mcp__${TOOL_SERVER}__${TOOL_NAMES.askHuman}` ? "done" : "failed";
}

export function finishActivity(eng: Engine, tool: RunningTool, status: "done" | "failed", answer?: string): void {
  const item = eng.store.getItem(tool.itemId);
  if (!item || item.kind !== "activity") return;
  const why = status === "failed" && tool.whyOnFail ? answer?.trim() : undefined;
  const detail = why ? clip(why, 400) : tool.detail;
  eng.putItem({
    ...item,
    label: status === "failed" && tool.failed ? tool.failed : tool.done,
    status,
    durationMs: Date.now() - tool.started,
    ...(detail !== undefined ? { detail } : {}),
  });
}
