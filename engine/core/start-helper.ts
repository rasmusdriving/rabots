// start_helper: a helper on any model, its own session and row (step 3a and the workers step); results that wait for a turn of their own, and a GPT bot's slow tool calls.
import { sessionFor } from "./aside.js";
import type { Engine, HarnessSession } from "../engine.js";
import { type BotRuntime, type CallContext, callScope, HarnessUnavailable, type Helper, type HelperEnd, type HelperStart, type PobotsHelper, TIDY_REFUSAL, type Wake } from "./runtime.js";
import { chooseWorker, readKind, SHORTEN_TOOL, type WorkerChoice, workerInstructions, type WorkerKind } from "../workers.js";
import type { Effort, Harness, ModelInfo } from "../../shared/protocol.js";
import { COMPACT_MAX, COMPACT_MIN } from "../config.js";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { apiErrorSentence, clip, helperLine, helperTitle, insideDir, now, realPath } from "./words.js";
import { MAX_HELPERS_ALL_BOTS, MAX_POBOTS_HELPERS, ok, problem, type StartHelperArgs, TOOL_NAMES } from "../team.js";
import { type BotTool, ClaudeSession, type HarnessEvent, HELPER_TOOLS, type SessionSettings, type ToolResult } from "../claude/session.js";
import { log } from "../log.js";
import { randomUUID } from "node:crypto";
import { Shortener } from "../shorten.js";
import { alsoOnNames, helperSees } from "./helper-sees.js";
import { canUseTool } from "./cards.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { CodexSession } from "../codex/session.js";
import { ensureSession } from "./turn-start.js";
import { finishTurn } from "./turn-end.js";
import { goLate } from "./asks.js";
import { shortHelperId } from "./helper-read.js";
import { cancelSettle, currentPurpose, endHelper, onHelperEvent, sendHelperRow, startHelper } from "./helpers.js";
import { workingManagers } from "./task-managers.js";

/** A helper's result handed back to the bot is cut at this length. */
export const HELPER_RESULT_MAX = 20_000;

/**
 * What a start_helper call asks for once its kind (workers/<kind>.md, read now) and the defaults
 * are added (step workers): the call wins over the kind, the kind over the defaults.
 */
export function workerChoice(eng: Engine, rt: BotRuntime, input: Record<string, unknown>): { choice: WorkerChoice; kind?: WorkerKind; model?: ModelInfo } | { problem: string } {
  let kind: WorkerKind | undefined;
  if (typeof input.kind === "string" && input.kind.trim()) {
    const k = readKind(rt.folder.dir, input.kind);
    if ("problem" in k) return k;
    kind = k;
  }
  const effort = typeof input.effort === "string" ? (input.effort as Effort) : undefined;
  const shortenAt = typeof input.shortenAt === "number" ? input.shortenAt : undefined;
  const choice = chooseWorker(
    {
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(effort ? { effort } : {}),
      ...(shortenAt !== undefined ? { shortenAt } : {}),
      ...(typeof input.shorten === "boolean" ? { shorten: input.shorten } : {}),
    },
    kind,
    (m) => eng.modelList().find((x) => x.id === m)?.harness ?? eng.harnessOf(m),
    (h) => eng.hub.context(h).compactTokens,
  );
  if ("problem" in choice) return choice;
  const model = eng.modelList().find((m) => m.id === choice.model);
  return { choice, ...(kind ? { kind } : {}), ...(model ? { model } : {}) };
}

/** Helpers with a session of their own that work now, across all bots (step workers). */
export function workingPobotsHelpers(eng: Engine, self?: Helper): { rt: BotRuntime; h: Helper }[] {
  return [...eng.bots.values()].flatMap((rt) => [...rt.helpers.values()].filter((h) => h.pobots && h !== self && h.status === "running").map((h) => ({ rt, h })));
}

/** Why a start_helper call cannot go ahead, in a sentence for the bot; undefined when it can. */
/** `forManager`: a task manager's worker, which the bot's tidy turn does not concern (engine 0.26.0). */
export function startHelperProblem(eng: Engine, rt: BotRuntime, input: Record<string, unknown>, self?: Helper, forManager = false): string | undefined {
  if (!forManager && rt.busy && rt.turn?.tidy) return TIDY_REFUSAL;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!title || !task) return "A helper needs a title and a task.";
  if (typeof input.shortenAt === "number" && (!Number.isInteger(input.shortenAt) || input.shortenAt < COMPACT_MIN || input.shortenAt > COMPACT_MAX)) return "shortenAt must be a whole number of tokens from 150000 to 1000000.";
  const chosen = workerChoice(eng, rt, input);
  if ("problem" in chosen) return chosen.problem;
  const id = chosen.choice.model;
  const model = chosen.model;
  const offered = eng.modelList().map((m) => m.id).join(", ");
  if (!model) return `There is no model called ${id || "(none)"}. Pick one of: ${offered}.`;
  if (model.harness === "codex" && !eng.codex.ready) return `GPT models cannot be used right now: ${eng.codex.problem ?? "Codex is not ready on this computer."}`;
  if (model.harness === "claude" && !eng.opts.claude.ready) return `Claude models cannot be used right now: ${eng.opts.claude.problem ?? "Claude is not ready on this computer."}`;
  if (chosen.choice.effort !== undefined && !model.efforts.includes(chosen.choice.effort)) return `${model.label} does not offer ${String(chosen.choice.effort)} effort. It offers ${model.efforts.join(", ")}.`;
  if (input.fast === true && !eng.hasFast(model.id)) return `${model.label} has no fast mode. Leave fast out.`;
  if (input.folder !== undefined && input.folder !== "") {
    const folder = typeof input.folder === "string" ? input.folder.trim() : "";
    if (!isAbsolute(folder)) return "The folder must be an absolute path.";
    let dir = false;
    try {
      dir = statSync(folder).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) return `There is no folder ${folder}.`;
    const inOwn = realPath(resolve(folder)) === realPath(resolve(rt.folder.dir)) || insideDir(rt.folder.dir, folder, rt.folder.dir);
    if (!inOwn && rt.folder.file.access !== "full-access") return "A folder outside your own is only allowed for a bot with full access.";
  }
  // A task manager's workers have a cap of their own (engine 0.26.0).
  const working = [...rt.helpers.values()].filter((h) => h.pobots && !h.manager && h !== self && h.status === "running").length;
  if (working >= MAX_POBOTS_HELPERS) return `You already have ${MAX_POBOTS_HELPERS} helpers working, which is the most at once. Wait until one of them is done.`;
  // Step workers: a cap across all bots, so the Mac keeps room (see MAX_HELPERS_ALL_BOTS).
  const all = workingPobotsHelpers(eng, self);
  const managers = workingManagers(eng);
  if (all.length + managers.length >= MAX_HELPERS_ALL_BOTS) {
    const names = [...all.map(({ rt: b, h }) => `"${h.base.title}" (${b === rt ? "yours" : b.folder.file.name})`), ...managers.map(({ rt: b, tm }) => `the task manager "${tm.title}" (${b === rt ? "yours" : b.folder.file.name})`)].join(", ");
    return `${MAX_HELPERS_ALL_BOTS} helpers are already working across all bots, the most at once on this computer: ${names}. Start this one when one of them is done, or do the work yourself.`;
  }
  return undefined;
}

/** The row of a start_helper call, made when the call shows (its tool-start). The handler starts its session. */
/** `extra`: where a task manager's worker stands and what it works for (engine 0.26.0). */
export function startPobotsRow(eng: Engine, rt: BotRuntime, session: HarnessSession, toolUseId: string, input: Record<string, unknown>, extra: Pick<HelperStart, "home" | "purpose" | "manager"> = {}): Helper {
  const chosen = workerChoice(eng, rt, input) as { choice: WorkerChoice; kind?: WorkerKind; model: ModelInfo };
  const model = chosen.model;
  const effort = chosen.choice.effort ?? model.defaultEffort;
  const wait = input.wait !== false;
  let finish: (end: HelperEnd) => void = () => undefined;
  const done = new Promise<HelperEnd>((resolve) => (finish = resolve));
  const pobots: PobotsHelper = {
    harness: model.harness,
    ...(session ? { from: session } : {}),
    done,
    finish,
    detached: !wait,
    texts: new Map(),
    tell: true,
    wait,
    title: String(input.title).trim(),
    task: String(input.task).trim(),
    linked: false,
    choice: chosen.choice,
    ...(chosen.kind ? { kind: chosen.kind } : {}),
  };
  // Left out, a helper on a model with a fast mode runs fast (step 3b, A4).
  const fast = input.fast !== false && eng.hasFast(model.id);
  return startHelper(eng, rt, session, toolUseId, { title: helperTitle(input.title), prompt: pobots.task, background: !wait, model: model.id, effort, ...(fast ? { fast } : {}), ...extra }, undefined, pobots);
}

/** start_helper: links the call to its row (or makes one), starts the helper's own session, and waits or returns at once. */
export async function startHelperFor(eng: Engine, rt: BotRuntime, args: StartHelperArgs, signal?: AbortSignal): Promise<ToolResult> {
  const call = callScope.getStore();
  const title = args.title?.trim() ?? "";
  const task = args.task?.trim() ?? "";
  // The row was made when the call showed; the handler can run a moment before or after that.
  const find = () => [...rt.helpers.values()].find((x) => x.pobots && !x.manager && !x.pobots.linked && x.status === "running" && x.pobots.title === title && x.pobots.task === task);
  let h: Helper | undefined = find();
  if (!h) {
    const early = startHelperProblem(eng, rt, args as unknown as Record<string, unknown>);
    if (early) return problem(early);
  }
  for (let i = 0; i < 50 && !h; i++) {
    await new Promise((r) => setTimeout(r, 20));
    h = find();
  }
  const why = startHelperProblem(eng, rt, args as unknown as Record<string, unknown>, h);
  if (why) return problem(why);
  if (!h) {
    log.warn(`Bot ${rt.folder.id}: a start_helper call came without its tool call showing; making its row now`);
    h = startPobotsRow(eng, rt, rt.session ?? (undefined as unknown as HarnessSession), `pobots-${randomUUID()}`, args as unknown as Record<string, unknown>);
  }
  const helper = h;
  const pobots = helper.pobots!;
  pobots.linked = true;
  try {
    launchPobotsHelper(eng, rt, helper, args);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not start a helper`, err);
    endHelper(eng, rt, helper, "failed", "The helper could not start.");
    return problem("The helper could not start. The details are in the engine log.");
  }
  const id = shortHelperId(helper.base.id);
  if (!pobots.wait) return ok(`Started helper ${id} "${pobots.title}". You get the result in a new message when it is done. Meanwhile read_helper id ${id} shows its steps, steer_helper sends it more, stop_helper stops it.`);
  // A GPT bot's call that takes long is answered early (lateCall); the row then goes on in the background.
  if (call) {
    call.onDetach = () => {
      pobots.detached = true;
      if (!helper.background) {
        helper.background = true;
        sendHelperRow(eng, helper, true);
      }
    };
  }
  const end = await new Promise<HelperEnd>((resolve) => {
    void pobots.done.then(resolve);
    signal?.addEventListener("abort", () => resolve({ status: "stopped", text: "" }), { once: true });
  });
  return helperEndResult(eng, pobots.title, end, id);
}

/** What the bot gets when a start_helper helper ended: its last message, or what went wrong. */
export function helperEndResult(eng: Engine, title: string, end: HelperEnd, id?: string): ToolResult {
  const name = id ? `helper ${id} "${title}"` : `helper "${title}"`;
  if (end.status === "done") {
    const text = end.text.trim() || "(The helper ended without a message.)";
    const cut = text.length > HELPER_RESULT_MAX ? `${text.slice(0, HELPER_RESULT_MAX)}\n\n(The result was cut here; it was ${text.length} characters long.)` : text;
    return ok(`Your ${name} is done. Its result:\n\n${cut}`);
  }
  if (end.status === "failed") return problem(`Your ${name} failed${end.text.trim() ? `: ${clip(end.text, 600)}` : "."}`);
  return problem(`Your ${name} was stopped before it finished.`);
}

/** Starts the own session of a start_helper helper: one task, no resume, none of the bot's tools, the bot's access and cards. */
export function launchPobotsHelper(eng: Engine, rt: BotRuntime, h: Helper, args: StartHelperArgs): void {
  const pobots = h.pobots!;
  const f = rt.folder.file;
  const model = h.base.model ?? pobots.choice.model;
  const codex = pobots.harness === "codex";
  const browser = eng.opts.config.browser?.enabled ?? true;
  // Step workers: a Claude helper may ask to be shortened between two jobs (engine/shorten.ts).
  let session: HarnessSession | undefined;
  if (!codex && pobots.choice.shorten) {
    pobots.shortener = new Shortener(
      {
        send: (text, carryOn) => {
          if (!session || session.closed || h.status !== "running") return;
          // The result is the last turn's: what it said before the shortening is not.
          if (carryOn) h.lastText = "";
          session.send(text);
        },
        interrupt: () => void session?.interrupt().catch((err) => log.warn(`Bot ${rt.folder.id}: could not stop a helper's summary`, err)),
        line: (text) => eng.addItem(rt, { kind: "notice", at: now(), text, tone: "info", mark: "compacted" }, h.base.helperThreadId),
        status: (text) => {
          h.last = helperLine(text);
          sendHelperRow(eng, h, true);
        },
        fail: (why) => endHelper(eng, rt, h, "failed", why),
      },
      pobots.task,
      eng.shortenTimings.waitMs,
      eng.shortenTimings.stuckMs,
    );
  }
  const settings: SessionSettings = {
    botId: rt.folder.id,
    botName: f.name,
    botDir: args.folder?.trim() || rt.folder.dir,
    model,
    effort: h.base.effort ?? "medium",
    access: f.access,
    fast: h.base.fast === true,
    compactTokens: pobots.choice.shortenAt,
    // A helper follows its bot's choice, on Claude with the names last read, on Codex as thread config
    // (docs/sees.md, docs/build/step-helper-sees.md); `services` switches more on for it alone.
    ...helperSees(eng, rt, pobots.harness, args.folder?.trim() || rt.folder.dir, alsoOnNames(eng, rt, args.services), h.manager ? "a task manager's worker" : "a helper"),
    executable: codex ? eng.codex.executable ?? "codex" : eng.opts.claude.executable ?? "claude",
    env: codex ? eng.codex.env : eng.opts.claude.env,
    tools: pobots.shortener ? [pobots.shortener.tool()] : [],
    rules: codex ? [] : eng.store.listRules(rt.folder.id).map((r) => r.rule),
    team: "",
    // Step workers: Pobots' own lines, the bot's WORKERS.md, and the kind's text.
    systemAppend: workerInstructions({ botName: f.name, browser, botDir: rt.folder.dir, ...(pobots.kind ? { kind: pobots.kind } : {}), shortenTool: !!pobots.shortener }),
    // Its cards stand in its thread and go when it stops, as a harness helper's do.
    canUseTool: (name, input, o) => canUseTool(eng, rt, name, input, { ...o, agentID: h.taskId } as Parameters<CanUseTool>[2]),
    onEvent: () => undefined,
    ...(codex ? { args: eng.codex.args ?? [], ephemeral: true } : { disallowedTools: [...HELPER_TOOLS], persist: false }),
  };
  const make = eng.opts.createSession ?? ((s: SessionSettings, kind: Harness) => (kind === "codex" ? new CodexSession(s) : new ClaudeSession(s)));
  settings.onEvent = (e) => {
    try {
      onPobotsHelperEvent(eng, rt, h, session!, e);
    } catch (err) {
      log.error(`Bot ${rt.folder.id}: could not handle a helper's event`, err);
    }
  };
  const live = make(settings, pobots.harness);
  session = live;
  pobots.session = live;
  h.session = live;
  live.start();
  live.send(pobots.task);
  log.info(`Bot ${rt.folder.id}: started a helper on ${model}${pobots.wait ? "" : " in the background"}${pobots.kind ? `, kind ${pobots.kind.name}` : ""}, summarised at ${pobots.choice.shortenAt} tokens${pobots.shortener ? ", may ask to be shortened" : ""}`);
}

/** What a start_helper helper's own session says, fed into the helper machinery with `parent` set to its call. */
export function onPobotsHelperEvent(eng: Engine, rt: BotRuntime, h: Helper, session: HarnessSession, e: HarnessEvent): void {
  const pobots = h.pobots!;
  if (pobots.session !== session || h.status !== "running") return;
  const parent = h.toolUseId;
  switch (e.type) {
    case "text-start":
      pobots.texts.set(e.key, pobots.texts.get(e.key) ?? "");
      return;
    case "text-delta":
      pobots.texts.set(e.key, (pobots.texts.get(e.key) ?? "") + e.text);
      return;
    case "text-full":
      // Its own helpers (a Claude helper may not start any) are left out.
      if (e.parent) return;
      if (pobots.texts.has(e.key)) return;
      if (e.text.trim()) onHelperEvent(eng, rt, { type: "text-full", key: e.key, text: e.text, parent });
      return;
    case "text-end": {
      const text = pobots.texts.get(e.key);
      pobots.texts.delete(e.key);
      if (text?.trim()) onHelperEvent(eng, rt, { type: "text-full", key: e.key, text, parent });
      return;
    }
    case "tool-start":
      if (e.parent) return;
      if (!e.name.endsWith(`__${SHORTEN_TOOL}`)) pobots.shortener?.step();
      onHelperEvent(eng, rt, { ...e, parent });
      return;
    case "tool-end":
      if (e.parent) return;
      onHelperEvent(eng, rt, { ...e, parent });
      return;
    case "api-error":
      pobots.why = apiErrorSentence(e.code);
      return;
    case "compacted": {
      // Step workers: a quiet line with the sizes, so the person can tune them.
      if (pobots.shortener?.compacted(e)) return;
      const at = e.preTokens ? ` at ${e.preTokens.toLocaleString("en-US")} tokens` : "";
      const to = e.postTokens ? `, to ${e.postTokens.toLocaleString("en-US")}` : "";
      eng.addItem(rt, { kind: "notice", at: now(), text: `Shortened by itself${at}${to} (set to ${pobots.choice.shortenAt.toLocaleString("en-US")})`, tone: "info", mark: "compacted" }, h.base.helperThreadId);
      return;
    }
    case "turn-end":
      if (e.usage) {
        pobots.size = e.usage.last.input + e.usage.last.cacheRead + e.usage.last.cacheWrite + e.usage.last.output;
        log.info(`Bot ${rt.folder.id}: a helper's turn ended. Session ${pobots.size} tokens, cache read ${e.usage.turn.cacheRead}, cache written ${e.usage.turn.cacheWrite}, ${e.usage.requests} request${e.usage.requests === 1 ? "" : "s"}`);
      }
      // Step workers: a turn that asked to be shortened, or the summary's own turn, is not the result.
      // A summary stopped for taking too long ends "interrupted" too; the person's Stop always wins.
      if (!h.stopAsked && pobots.shortener && (pobots.shortener.busy || e.subtype !== "interrupted") && pobots.shortener.turnEnd(e)) return;
      // A message steered in that the turn ended before reading: the harness runs it next, so the helper works on (steer_helper).
      if (!h.stopAsked && e.subtype !== "interrupted" && e.ahead?.length) {
        h.lastText = "";
        return;
      }
      if (e.subtype === "interrupted" || h.stopAsked) endHelper(eng, rt, h, "stopped");
      else if (e.ok) endHelper(eng, rt, h, "done");
      else endHelper(eng, rt, h, "failed", pobots.why ?? (e.errors[0] ? `The helper stopped because of an error: ${clip(e.errors[0], 200)}` : "The helper stopped because of an error."));
      return;
    case "exit":
      if (h.status === "running") endHelper(eng, rt, h, h.stopAsked ? "stopped" : "failed", h.stopAsked ? undefined : pobots.why ?? "The helper stopped unexpectedly.");
      return;
    default:
      return;
  }
}

/** A result for the bot, told in a turn of its own: now when it is free, else after what it is doing. */
export function wake(eng: Engine, rt: BotRuntime, w: Wake): void {
  if (eng.stopping || !eng.bots.has(rt.folder.id)) return;
  rt.wakes.push(w);
  pumpWakes(eng, rt);
}

/** Starts the next waiting result's turn when the bot is free. Like a turn the harness begins by itself: no message in the chat, the purpose of the call it answers. */
export function pumpWakes(eng: Engine, rt: BotRuntime): void {
  if (rt.busy || !rt.wakes.length || eng.stopping || !eng.bots.has(rt.folder.id)) return;
  const w = rt.wakes[0]!;
  // A fresh run's own thread only while its session lives, live or set aside (core/aside.ts); else the main chat.
  const own = w.purpose.threadId === rt.threadId || sessionFor(rt, w.purpose.threadId);
  const threadId = own ? w.purpose.threadId : rt.threadId;
  rt.wakes.shift();
  const p = own ? w.purpose : { ...w.purpose, threadId, fresh: false, runId: undefined, runLabel: undefined };
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
  rt.wake = undefined;
  rt.turn = {
    id: randomUUID(),
    threadId,
    fresh: threadId !== rt.threadId,
    hops: p.hops,
    startedBy: p.startedBy,
    lastText: "",
    tidy: false,
    harness: true,
    begun: true,
    ...(p.runId ? { runId: p.runId } : {}),
    ...(p.runLabel ? { runLabel: p.runLabel } : {}),
    ...(p.channelRid ? { channelRid: p.channelRid } : {}),
    ...(p.askFrom ? { askFrom: p.askFrom } : {}),
  };
  const turn = rt.turn;
  log.info(`Bot ${rt.folder.id}: a result came back; it is told in a turn of its own`);
  eng.setState(rt, "thinking", "Thinking");
  void ensureSession(eng, rt)
    .then(({ session, handoff }) => {
      if (rt.turn !== turn) return;
      session.send(w.text, handoff ?? []);
    })
    .catch((err) => {
      if (rt.turn !== turn) return;
      if (err instanceof HarnessUnavailable) eng.notice(rt, err.message, "error");
      else {
        log.error(`Bot ${rt.folder.id}: could not start the harness for a result`, err);
        eng.notice(rt, "The bot could not start. The details are in the engine log.", "error");
      }
      rt.turnError = "start";
      finishTurn(eng, rt, { ok: false, errors: [], subtype: "start_failed" });
    });
}

/**
 * A GPT bot's own tool. Codex waits for such a call only about 30 seconds (notes-engine-3a.md), so
 * one that takes longer is answered with "you get the result in a new message", and its result is
 * told in a turn of its own when it comes. A question to another bot goes the way it does when the
 * asker stops waiting: the answer comes later as a message.
 */
export async function lateCall(eng: Engine, rt: BotRuntime, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, handler: BotTool["handler"]): Promise<ToolResult> {
  const ctx: CallContext = { detached: false };
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => (ctx.detached ? undefined : ac.abort()), { once: true });
  }
  const purpose = currentPurpose(eng, rt);
  const running = callScope.run(ctx, () => handler(args, ac.signal));
  const LATE = Symbol("late");
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    running,
    new Promise<typeof LATE>((r) => {
      timer = setTimeout(() => r(LATE), eng.codexToolSoftMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (first !== LATE) return first;
  if (name === TOOL_NAMES.messageBot) {
    for (const ask of [...eng.asks]) if (ask.from === rt.folder.id && !ask.late && !ask.settled) goLate(eng, ask);
    return running;
  }
  ctx.detached = true;
  ctx.onDetach?.();
  rt.lateCalls.add(ac);
  log.info(`Bot ${rt.folder.id}: ${name} takes long; its result comes in a turn of its own`);
  void running.then(
    (result) => {
      rt.lateCalls.delete(ac);
      if (ac.signal.aborted || eng.stopping || !eng.bots.has(rt.folder.id)) return;
      const text = result.content.map((c) => c.text).join("\n");
      const said = name === TOOL_NAMES.startHelper ? text : `Note from Pobots: your earlier call to ${name} has finished. ${result.isError ? "It ended with a problem" : "Its answer"}:\n\n${text}`;
      wake(eng, rt, { text: said, purpose });
    },
    (err) => {
      rt.lateCalls.delete(ac);
      log.warn(`Bot ${rt.folder.id}: ${name} failed after it was answered early`, err);
    },
  );
  const started = name === TOOL_NAMES.startHelper ? [...rt.helpers.values()].find((h) => h.pobots?.linked && h.pobots.title === String(args.title ?? "").trim() && h.pobots.task === String(args.task ?? "").trim()) : undefined;
  const sid = started ? ` ${shortHelperId(started.base.id)}` : "";
  return ok(
    name === TOOL_NAMES.startHelper
      ? `The helper${sid} is still working. You get its result in a new message when it is done. Do not start it again; carry on with something else or end your turn.${sid ? ` Meanwhile read_helper id${sid} shows its steps, steer_helper sends it more, stop_helper stops it.` : ""}`
      : "This is still going: it waits for the person or for something else that takes time. You get its answer in a new message when it comes. Do not call it again; carry on with something else or end your turn.",
  );
}
