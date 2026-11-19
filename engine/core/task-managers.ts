// Task managers (engine 0.26.0, docs/build/step-task-managers.md): a helper a bot starts for one long
// task, with a session and thread of its own, workers of its own (core/task-manager-workers.ts) and
// the tools the bot chose (core/task-manager-host.ts). Not a bot and not one of the bot's helpers:
// it never holds the bot, and it stays, resting, after its result until its bot or the person ends
// it. After T3 Code's delegate_task and taskResultTransfer (apps/server/src/mcp/OrchestratorMcpService.ts, MIT).
import { away, requirePresent } from "./vacation.js";
import { managerEnded, managerSaid, managerTurnBegins, managerTurnOver } from "./card-questions.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import type { Engine, HarnessSession } from "../engine.js";
import type { BotRuntime, Purpose, RunningTool } from "./runtime.js";
import type { Effort, Harness, HelperItem, Methods, TaskManagerInfo, TaskManagerTool } from "../../shared/protocol.js";
import { TASK_MANAGER_TOOLS } from "../../shared/protocol.js";
import { type BotTool, ClaudeSession, type HarnessEvent, HELPER_TOOLS, type SessionSettings, type ToolResult } from "../claude/session.js";
import { CodexSession } from "../codex/session.js";
import { helperSees } from "./helper-sees.js";
import { failWords, toolKind } from "../claude/labels.js";
import { finishActivity } from "./harness-events.js";
import { apiErrorSentence, clip, helperLine, helperTitle, insideDir, localWhen, now, realPath } from "./words.js";
import { ok, problem, TOOL_NAMES, BROWSER_PROMPT } from "../team.js";
import { type EndTaskManagerArgs, type StartTaskManagerArgs, TASK_MANAGER_DEFAULT_TOOLS, TASK_MANAGER_DEFAULT_WORKERS, TASK_MANAGER_MAX_WORKERS, TASK_MANAGERS_PER_BOT, taskManagerInstructions } from "../task-manager-tools.js";
import { currentPurpose } from "./helpers.js";
import { wake } from "./start-helper.js";
import { removeCard } from "./cards.js";
import { shortHelperId } from "./helper-read.js";
import { managerTools, managerCanUseTool } from "./task-manager-host.js";
import { stopWorkers, workersOf } from "./task-manager-workers.js";
import { log } from "../log.js";
import { EngineError } from "../errors.js";

/** A task manager while Pobots runs. */
export type ManagerMessage = string | { text: string; questionId: string };

export interface TaskManager {
  /** Its row's item id. */
  id: string;
  botId: string;
  /** Its row, as last sent. */
  row: HelperItem;
  /** Its own thread. */
  ownThread: string;
  title: string;
  task: string;
  model: string;
  harness: Harness;
  effort: Effort;
  tools: TaskManagerTool[];
  /** Bot ids it may message besides its own bot. */
  mayMessage: string[];
  maxWorkers: number;
  folder?: string;
  startedAt: string;
  /** The harness session to resume. */
  sessionId?: string;
  session?: HarnessSession;
  /** A turn of it runs. */
  busy: boolean;
  /** Whose work it does now: "bot" when its bot started or asked for it (its result then goes to the bot). */
  origin: "bot" | "person";
  /** What the bot was doing when it asked for the work: its result is told there. */
  purpose: Purpose;
  /** Text being written, by key. */
  texts: Map<string, string>;
  /** What it said last in this turn. */
  lastText: string;
  /** Its own tool calls that run now. */
  calls: Map<string, RunningTool>;
  /** Messages for its next turn, oldest first. */
  inbox: ManagerMessage[];
  /** Messages steered into the running turn, by id, until the turn took them up. */
  steered: Map<string, string>;
  /** The text the running turn was started with, for one fresh try when a resumed session fails. */
  sent?: string;
  /** The running turn resumed a session, and nothing came of it yet. */
  resumed?: boolean;
  why?: string;
  steps: number;
  last?: string;
  /** Its workers' row ids, oldest first. */
  workers: string[];
  /** Slow tool calls of a manager on a GPT model that were answered early. */
  lateCalls: Set<AbortController>;
  rowTimer?: NodeJS.Timeout;
  rowAt: number;
}

/** What is kept of a task manager in the database. */
type Saved = Pick<TaskManager, "id" | "ownThread" | "title" | "task" | "model" | "harness" | "effort" | "tools" | "mayMessage" | "maxWorkers" | "folder" | "startedAt" | "sessionId" | "purpose" | "workers"> & { rowThread: string };

const key = (botId: string) => `taskmanagers:${botId}`;

/** Its state as the window reads it. */
export function managerState(eng: Engine, rt: BotRuntime, tm: TaskManager): TaskManagerInfo["state"] {
  if ([...eng.cards.values()].some((p) => p.manager === tm.id && p.card.kind !== "note")) return "waiting";
  if (tm.busy || tm.lateCalls.size || workersOf(rt, tm.id).length) return "working";
  return "resting";
}

/** Task managers that work now, across all bots: they count toward the helpers across all bots. */
export function workingManagers(eng: Engine): { rt: BotRuntime; tm: TaskManager }[] {
  return [...eng.bots.values()].flatMap((rt) => [...rt.managers.values()].filter((tm) => tm.busy).map((tm) => ({ rt, tm })));
}

/** The bot's task managers for the window. */
export function taskManagerInfos(eng: Engine, rt: BotRuntime): TaskManagerInfo[] {
  return [...rt.managers.values()].map((tm) => ({
    id: tm.id,
    threadId: tm.row.threadId,
    managerThreadId: tm.ownThread,
    title: tm.title,
    harness: tm.harness,
    model: tm.model,
    effort: tm.effort,
    startedAt: tm.startedAt,
    state: managerState(eng, rt, tm),
    workersNow: workersOf(rt, tm.id).length,
    maxWorkers: tm.maxWorkers,
    tools: tm.tools,
    mayMessage: tm.mayMessage.map((id) => eng.nameOf(id)),
    ...(tm.folder ? { folder: tm.folder } : {}),
  }));
}

function save(eng: Engine, rt: BotRuntime): void {
  if (!eng.store.isOpen) return;
  const all: Saved[] = [...rt.managers.values()].map((tm) => ({
    id: tm.id,
    rowThread: tm.row.threadId,
    ownThread: tm.ownThread,
    title: tm.title,
    task: tm.task,
    model: tm.model,
    harness: tm.harness,
    effort: tm.effort,
    tools: tm.tools,
    mayMessage: tm.mayMessage,
    maxWorkers: tm.maxWorkers,
    ...(tm.folder ? { folder: tm.folder } : {}),
    startedAt: tm.startedAt,
    ...(tm.sessionId ? { sessionId: tm.sessionId } : {}),
    purpose: tm.purpose,
    workers: tm.workers.slice(-50),
  }));
  if (all.length) eng.store.setValue(key(rt.folder.id), JSON.stringify(all));
  else eng.store.deleteValue(key(rt.folder.id));
}

/** Its row, sent now when urgent, else at most about once a second; and the bot, so the rail follows. */
export function sendManagerRow(eng: Engine, rt: BotRuntime, tm: TaskManager, urgent = false, ended = false): void {
  if (!eng.store.isOpen) return;
  const at = Date.now();
  if (!urgent && at - tm.rowAt < eng.helperRowMs) {
    if (tm.rowTimer) return;
    tm.rowTimer = setTimeout(() => {
      tm.rowTimer = undefined;
      sendManagerRow(eng, rt, tm, true);
    }, tm.rowAt + eng.helperRowMs - at);
    tm.rowTimer.unref?.();
    return;
  }
  clearTimeout(tm.rowTimer);
  tm.rowTimer = undefined;
  tm.rowAt = at;
  const state = ended ? "ended" : managerState(eng, rt, tm);
  const item: HelperItem = {
    ...tm.row,
    status: state === "working" || state === "waiting" ? "running" : "done",
    background: true,
    steps: tm.steps,
    ...(tm.last ? { last: tm.last } : {}),
    ...(ended ? { endedAt: now() } : {}),
    taskManager: { maxWorkers: tm.maxWorkers, tools: tm.tools, mayMessage: tm.mayMessage.map((id) => eng.nameOf(id)), ...(tm.folder ? { folder: tm.folder } : {}), state },
  };
  tm.row = item;
  eng.putItem(item);
  if (urgent) eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}

/** Something about it changed that the rail shows (its state, its workers). */
export function managerChanged(eng: Engine, rt: BotRuntime, managerId: string): void {
  const tm = rt.managers.get(managerId);
  if (tm && eng.bots.has(rt.folder.id)) sendManagerRow(eng, rt, tm, true);
}

/** Finds one of a bot's task managers by its id (its row id or the start of it, at least 6 characters). */
export function findManager(rt: BotRuntime, id: string): TaskManager | undefined {
  const want = id.trim().toLowerCase();
  if (want.length < 6) return undefined;
  return [...rt.managers.values()].find((tm) => tm.id.toLowerCase().startsWith(want));
}

// ------------------------------------------------------------ starting one

/** Why a start_task_manager call cannot go ahead; else what it starts with. */
function checkStart(eng: Engine, rt: BotRuntime, args: StartTaskManagerArgs): string | { model: string; harness: Harness; effort: Effort; tools: TaskManagerTool[]; mayMessage: string[]; maxWorkers: number; folder?: string } {
  const title = args.title?.trim() ?? "";
  const task = args.task?.trim() ?? "";
  if (!title || !task) return "A task manager needs a title and a task.";
  if (rt.managers.size >= TASK_MANAGERS_PER_BOT) return `You already have ${TASK_MANAGERS_PER_BOT} task managers, the most at once. End one with end_task_manager first.`;
  const id = args.model?.trim() || rt.folder.file.model;
  const model = eng.modelList().find((m) => m.id === id);
  if (!model) return `There is no model called ${id}. Pick one of: ${eng.modelList().map((m) => m.id).join(", ")}.`;
  if (model.harness === "codex" && !eng.codex.ready) return `GPT models cannot be used right now: ${eng.codex.problem ?? "Codex is not ready on this computer."}`;
  if (model.harness === "claude" && !eng.opts.claude.ready) return `Claude models cannot be used right now: ${eng.opts.claude.problem ?? "Claude is not ready on this computer."}`;
  const effort = args.effort ?? model.defaultEffort;
  if (!model.efforts.includes(effort)) return `${model.label} does not offer ${effort} effort. It offers ${model.efforts.join(", ")}.`;
  const tools = args.tools ? [...new Set(args.tools)].filter((t) => TASK_MANAGER_TOOLS.includes(t)) : TASK_MANAGER_DEFAULT_TOOLS;
  const maxWorkers = args.max_workers ?? TASK_MANAGER_DEFAULT_WORKERS;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > TASK_MANAGER_MAX_WORKERS) return `max_workers must be a whole number from 1 to ${TASK_MANAGER_MAX_WORKERS}.`;
  const mayMessage: string[] = [];
  for (const ref of args.may_message ?? []) {
    const b = eng.findBot(ref);
    if (!b) return `There is no bot called ${ref}. Use list_bots to see the others.`;
    if (b === rt) continue;
    if (!eng.mayMessage(rt.folder.id, b.folder.id)) return `You may not message ${b.folder.file.name}, so your task manager may not either.`;
    if (!mayMessage.includes(b.folder.id)) mayMessage.push(b.folder.id);
  }
  let folder: string | undefined;
  if (args.folder?.trim()) {
    folder = args.folder.trim();
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
  return { model: model.id, harness: model.harness, effort, tools, mayMessage, maxWorkers, ...(folder ? { folder } : {}) };
}

/** start_task_manager: its row where the bot works now, its own thread with the task, and its first turn. Returns at once. */
export async function startTaskManagerFor(eng: Engine, rt: BotRuntime, args: StartTaskManagerArgs): Promise<ToolResult> {
  requirePresent(rt);
  const checked = checkStart(eng, rt, args);
  if (typeof checked === "string") return problem(checked);
  if (!eng.store.isOpen || eng.stopping) return problem("Pobots is stopping, so the task manager was not started.");
  const title = helperTitle(args.title);
  const task = args.task.trim();
  const itemId = randomUUID();
  const thread = eng.store.createThread(rt.folder.id, "helper", itemId);
  const row = eng.addItem(rt, {
    id: itemId,
    kind: "helper",
    at: now(),
    botId: rt.folder.id,
    title,
    helperThreadId: thread.id,
    status: "running",
    background: true,
    steps: 0,
    model: checked.model,
    effort: checked.effort,
    harness: checked.harness,
    taskManager: { maxWorkers: checked.maxWorkers, tools: checked.tools, mayMessage: checked.mayMessage.map((id) => eng.nameOf(id)), ...(checked.folder ? { folder: checked.folder } : {}), state: "working" },
  }) as HelperItem;
  eng.addItem(rt, { kind: "user", at: now(), text: task, from: { type: "bot", botId: rt.folder.id, expectsReply: true }, queued: false }, thread.id);
  const tm: TaskManager = {
    id: itemId,
    botId: rt.folder.id,
    row,
    ownThread: thread.id,
    title,
    task,
    ...checked,
    startedAt: row.at,
    busy: false,
    origin: "bot",
    purpose: currentPurpose(eng, rt),
    texts: new Map(),
    lastText: "",
    calls: new Map(),
    inbox: [],
    steered: new Map(),
    steps: 0,
    workers: [],
    lateCalls: new Set(),
    rowAt: 0,
  };
  rt.managers.set(tm.id, tm);
  save(eng, rt);
  try {
    beginTurn(eng, rt, tm, task);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not start a task manager`, err);
    endManager(eng, rt, tm, "failed");
    return problem("The task manager could not start. The details are in the engine log.");
  }
  log.info(`Bot ${rt.folder.id}: started a task manager on ${tm.model}, ${tm.maxWorkers} worker${tm.maxWorkers === 1 ? "" : "s"} at once, tools ${tm.tools.join(", ")}`);
  const id = shortHelperId(tm.id);
  return ok(
    `Started task manager ${id} "${title}" on ${tm.model}, with ${tm.maxWorkers} worker${tm.maxWorkers === 1 ? "" : "s"} at once and the tools ${tm.tools.join(", ")}. It works on its own now; you get its result in a new message when it is done. Meanwhile read_helper id ${id} shows its steps and steer_helper id ${id} sends it more. End it with end_task_manager id ${id} when the job is done.`,
  );
}

// ------------------------------------------------------------ its session and turns

function makeSession(eng: Engine, rt: BotRuntime, tm: TaskManager): HarnessSession {
  const f = rt.folder.file;
  const codex = tm.harness === "codex";
  const browser = eng.opts.config.browser?.enabled ?? true;
  const settings: SessionSettings = {
    botId: rt.folder.id,
    botName: f.name,
    botDir: tm.folder ?? rt.folder.dir,
    model: tm.model,
    effort: tm.effort,
    access: f.access,
    fast: eng.hasFast(tm.model),
    ...(tm.sessionId ? { resume: tm.sessionId } : {}),
    ...helperSees(eng, rt, tm.harness, tm.folder ?? rt.folder.dir, [], "a task manager"),
    executable: codex ? eng.codex.executable ?? "codex" : eng.opts.claude.executable ?? "claude",
    env: codex ? eng.codex.env : eng.opts.claude.env,
    tools: [],
    // Its bot's saved rules, as the bot's own session has them; none on Codex, as for a Codex bot.
    rules: codex ? [] : eng.store.listRules(rt.folder.id).map((r) => r.rule),
    team: "",
    systemAppend: taskManagerInstructions({ botName: f.name, title: tm.title, tools: tm.tools, maxWorkers: tm.maxWorkers, mayMessage: tm.mayMessage.map((id) => eng.nameOf(id)), botDir: rt.folder.dir, ...(browser ? { browserPrompt: BROWSER_PROMPT } : {}) }),
    canUseTool: (name, input, o) => managerCanUseTool(eng, rt, tm, name, input, o),
    onEvent: () => undefined,
    // Its workers come from start_helper, and its questions from ask_human: not the harness's own.
    ...(codex ? { args: eng.codex.args ?? [], ephemeral: false } : { disallowedTools: [...HELPER_TOOLS, "AskUserQuestion"], persist: true }),
  };
  settings.tools = managerTools(eng, rt, tm) as BotTool[];
  const make = eng.opts.createSession ?? ((s: SessionSettings, kind: Harness) => (kind === "codex" ? new CodexSession(s) : new ClaudeSession(s)));
  let session: HarnessSession | undefined;
  settings.onEvent = (e) => {
    try {
      if (session) onManagerEvent(eng, rt, tm, session, e);
    } catch (err) {
      log.error(`Bot ${rt.folder.id}: could not handle a task manager's event`, err);
    }
  };
  session = make(settings, tm.harness);
  session.start();
  return session;
}

/** A turn of it, with this message: its session is made (or resumed) when it has none. */
function beginTurn(eng: Engine, rt: BotRuntime, tm: TaskManager, text: string, questionId?: string): void {
  const fresh = !tm.session || tm.session.closed;
  if (fresh) {
    tm.session = makeSession(eng, rt, tm);
    tm.resumed = !!tm.sessionId;
  } else tm.resumed = false;
  tm.busy = true;
  tm.sent = text;
  tm.lastText = "";
  tm.why = undefined;
  if (questionId) managerTurnBegins(eng, tm, questionId);
  tm.session!.send(text);
  sendManagerRow(eng, rt, tm, true);
}

/** A message for it: into its running turn when it works, else its next turn starts with it. */
export async function deliver(eng: Engine, rt: BotRuntime, tm: TaskManager, text: string, origin: "bot" | "person", itemId: string = randomUUID(), question = false): Promise<"steered" | "queued" | "started"> {
  requirePresent(rt);
  if (origin === "bot") tm.origin = "bot";
  else if (managerState(eng, rt, tm) === "resting") tm.origin = "person";
  const session = tm.session;
  if (!question && tm.busy && session && !session.closed && session.steer) {
    tm.steered.set(itemId, text);
    let took = false;
    try {
      took = await session.steer(text, { id: itemId });
    } catch (err) {
      log.warn(`Bot ${rt.folder.id}: could not steer a message into a task manager`, err);
    }
    if (took) return "steered";
    tm.steered.delete(itemId);
  }
  if (!rt.managers.has(tm.id)) return "queued";
  if (tm.busy) {
    tm.inbox.push(question ? { text, questionId: itemId } : text);
    return "queued";
  }
  beginTurn(eng, rt, tm, text, question ? itemId : undefined);
  return "started";
}

function onManagerEvent(eng: Engine, rt: BotRuntime, tm: TaskManager, session: HarnessSession, e: HarnessEvent): void {
  if (tm.session !== session || !rt.managers.has(tm.id)) return;
  switch (e.type) {
    case "session":
      if (e.sessionId && e.sessionId !== tm.sessionId) {
        tm.sessionId = e.sessionId;
        save(eng, rt);
      }
      return;
    case "text-start":
      tm.texts.set(e.key, tm.texts.get(e.key) ?? "");
      return;
    case "text-delta":
      tm.texts.set(e.key, (tm.texts.get(e.key) ?? "") + e.text);
      return;
    case "text-full":
      if (e.parent || tm.texts.has(e.key)) return;
      said(eng, rt, tm, e.text);
      return;
    case "text-end": {
      const text = tm.texts.get(e.key);
      tm.texts.delete(e.key);
      if (text) said(eng, rt, tm, text);
      return;
    }
    case "tool-start": {
      if (e.parent) return;
      tm.resumed = false;
      tm.steps++;
      const words = eng.toolWords(e.name, e.input);
      // A worker shows as its own row in the thread; the call itself is not a line.
      if (e.name.endsWith(`__${TOOL_NAMES.startHelper}`)) {
        tm.calls.set(e.toolUseId, { itemId: "", started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done });
      } else {
        const item = eng.addItem(rt, { kind: "activity", at: now(), botId: rt.folder.id, label: words.running, ...(words.detail ? { detail: words.detail } : {}), status: "running", tool: toolKind(e.name, e.input) }, tm.ownThread);
        tm.calls.set(e.toolUseId, { itemId: item.id, started: Date.now(), name: e.name, input: e.input, running: words.running, done: words.done, ...failWords(words) });
      }
      tm.last = helperLine(words.running);
      sendManagerRow(eng, rt, tm);
      return;
    }
    case "tool-end": {
      if (e.parent) return;
      const call = tm.calls.get(e.toolUseId);
      if (!call) return;
      tm.calls.delete(e.toolUseId);
      if (call.itemId) finishActivity(eng, call, e.isError ? "failed" : "done", e.text);
      tm.last = helperLine(call.done);
      sendManagerRow(eng, rt, tm);
      return;
    }
    case "api-error":
      tm.why = apiErrorSentence(e.code);
      return;
    case "steer-returned":
      // Steered in but given back unread: they start its next turn.
      for (const id of e.ids) {
        const text = tm.steered.get(id);
        tm.steered.delete(id);
        if (text) tm.inbox.push(text);
      }
      return;
    case "turn-end":
      if (e.sessionId && e.sessionId !== tm.sessionId) {
        tm.sessionId = e.sessionId;
        save(eng, rt);
      }
      // A message steered in that the turn ended before reading: the harness runs it next by itself.
      if (e.ok && e.subtype !== "interrupted" && e.ahead?.length) {
        for (const id of [...tm.steered.keys()]) if (!e.ahead.includes(id)) tm.steered.delete(id);
        return;
      }
      turnOver(eng, rt, tm, e.ok, e.ok ? undefined : tm.why ?? (e.errors[0] ? `It stopped because of an error: ${clip(e.errors[0], 200)}` : "It stopped because of an error."));
      return;
    case "exit":
      tm.session = undefined;
      if (tm.busy) turnOver(eng, rt, tm, false, tm.why ?? "Its session stopped unexpectedly.");
      return;
    default:
      return;
  }
}

/** It said something: into its thread, and its row's line. */
function said(eng: Engine, rt: BotRuntime, tm: TaskManager, text: string): void {
  if (!text.trim()) return;
  tm.resumed = false;
  eng.addItem(rt, { kind: "bot", at: now(), botId: rt.folder.id, text, streaming: false }, tm.ownThread);
  tm.lastText = text.trim();
  managerSaid(eng, tm, text);
  const line = helperLine(text);
  if (line) tm.last = line;
  sendManagerRow(eng, rt, tm);
}

/** Batch the usual messages, but give each card question a turn and a reply of its own. */
export function startManagerInbox(eng: Engine, rt: BotRuntime, tm: TaskManager): boolean {
  if (away(rt)) return false;
  const first = tm.inbox.shift();
  if (first === undefined) return false;
  if (typeof first === "string") {
    const messages = [first];
    while (typeof tm.inbox[0] === "string") messages.push(tm.inbox.shift() as string);
    beginTurn(eng, rt, tm, messages.join("\n\n"));
  } else beginTurn(eng, rt, tm, first.text, first.questionId);
  return true;
}

/** Its turn ended: the next message, waiting for its workers, or its result to the bot and rest. */
function turnOver(eng: Engine, rt: BotRuntime, tm: TaskManager, good: boolean, why?: string): void {
  tm.busy = false;
  tm.steered.clear();
  for (const call of tm.calls.values()) if (call.itemId) finishActivity(eng, call, good ? "done" : "failed");
  tm.calls.clear();
  tm.texts.clear();
  // A session that could not be resumed: once more in a fresh one, told what the task was.
  if (!good && tm.resumed && tm.sent !== undefined && !tm.lastText) {
    log.warn(`Bot ${rt.folder.id}: a task manager's session could not be resumed; it starts a fresh one`);
    tm.resumed = false;
    tm.sessionId = undefined;
    if (tm.session && !tm.session.closed) tm.session.close();
    tm.session = undefined;
    save(eng, rt);
    beginTurn(eng, rt, tm, `Note from Pobots: your earlier session could not be resumed, so this is a fresh one. Your task was:\n\n${tm.task}\n\nThe new message:\n\n${tm.sent}`);
    return;
  }
  if (!good) eng.addItem(rt, { kind: "notice", at: now(), text: why ?? "It stopped because of an error.", tone: "error" }, tm.ownThread);
  // Engine 0.31.0: its last message answers the person's questions it took up (core/card-questions.ts).
  managerTurnOver(eng, tm);
  if (good && startManagerInbox(eng, rt, tm)) return;
  settleManager(eng, rt, tm, good ? undefined : why);
}

/**
 * Nothing of it runs any more but perhaps its workers. While they work it waits for them (its
 * session open for their results). Once they are done too, its result goes to the bot when the
 * bot asked for the work, and it rests with its session closed.
 */
export function settleManager(eng: Engine, rt: BotRuntime, tm: TaskManager, failed?: string): void {
  if (tm.busy || !rt.managers.has(tm.id)) return;
  // Its workers, or its slow calls answered early (core/task-manager-host.ts), still come back to it.
  if (workersOf(rt, tm.id).length || tm.lateCalls.size) {
    sendManagerRow(eng, rt, tm, true);
    return;
  }
  if (startManagerInbox(eng, rt, tm)) return;
  if (tm.origin === "bot") report(eng, rt, tm, failed);
  tm.origin = "person";
  if (tm.session && !tm.session.closed) tm.session.close();
  tm.session = undefined;
  save(eng, rt);
  sendManagerRow(eng, rt, tm, true);
}

/** Its result for the bot, in a turn of its own, as a helper's result is. */
function report(eng: Engine, rt: BotRuntime, tm: TaskManager, failed?: string): void {
  const id = shortHelperId(tm.id);
  const after = `It rests now and stays until you end it with end_task_manager id ${id}; steer_helper id ${id} sends it more.`;
  let text: string;
  if (failed) text = `Your task manager ${id} "${tm.title}" stopped: ${failed} What it said last: ${tm.lastText ? clip(tm.lastText, 2000) : "(nothing)"}. ${after}`;
  else {
    const said = tm.lastText || "(It ended without a message.)";
    const cut = said.length > 20_000 ? `${said.slice(0, 20_000)}\n\n(The result was cut here; it was ${said.length} characters long.)` : said;
    text = `Your task manager ${id} "${tm.title}" is done for now. Its result:\n\n${cut}\n\n${after}`;
  }
  log.info(`Bot ${rt.folder.id}: a task manager reported back${failed ? " with a problem" : ""}`);
  wake(eng, rt, { text, purpose: tm.purpose });
}

// ------------------------------------------------------------ messages, stop and end

/** A message from its bot (steer_helper with its id): in its thread, and its work for the bot. */
export async function sendFromBot(eng: Engine, rt: BotRuntime, tm: TaskManager, text: string): Promise<ToolResult> {
  const id = randomUUID();
  tm.purpose = currentPurpose(eng, rt);
  const framed = `Message from ${rt.folder.file.name}, the bot that started you:\n\n${text}`;
  eng.addItem(rt, { id, kind: "user", at: now(), text, from: { type: "bot", botId: rt.folder.id, expectsReply: false }, queued: false }, tm.ownThread);
  const how = await deliver(eng, rt, tm, framed, "bot", id);
  const words = how === "steered" ? "It was working and reads it at its next step." : how === "queued" ? "It reads it when its current step is done." : "It was resting and starts on it now.";
  return ok(`Sent to task manager ${shortHelperId(tm.id)} "${tm.title}". ${words} You get its result in a new message when it is done.`);
}

/** taskManager.send: the person writes to it in its thread. */
export function sendToTaskManager(eng: Engine, params: Methods["taskManager.send"]["params"]): void {
  const rt = eng.bot(params.botId);
  requirePresent(rt);
  const tm = rt.managers.get(params.managerId);
  if (!tm) throw new EngineError("not_found", "This task manager has ended.");
  const text = params.text.trim();
  if (!text) throw new EngineError("bad_request", "The message is empty.");
  const id = randomUUID();
  eng.addItem(rt, { id, kind: "user", at: now(), text, from: { type: "you" }, queued: false, ...(tm.busy ? { steered: true } : {}) }, tm.ownThread);
  void deliver(eng, rt, tm, text, "person", id).catch((err) => log.error(`Bot ${rt.folder.id}: could not pass a message to a task manager`, err));
}

/** Stops what it does: its turn, its workers, its cards. It stays, resting; its session resumes at the next message. */
export function stopManager(eng: Engine, rt: BotRuntime, tm: TaskManager, notice = true): void {
  const working = tm.busy || workersOf(rt, tm.id).length > 0;
  for (const [id, p] of [...eng.cards]) if (p.manager === tm.id && p.card.kind !== "note") removeCard(eng, id, "withdrawn", { type: "withdrawn" });
  for (const ac of tm.lateCalls) ac.abort();
  tm.lateCalls.clear();
  stopWorkers(eng, rt, tm);
  tm.inbox = [];
  if (!eng.stopping) managerEnded(eng, tm);
  tm.steered.clear();
  for (const call of tm.calls.values()) if (call.itemId) finishActivity(eng, call, "failed");
  tm.calls.clear();
  tm.texts.clear();
  tm.busy = false;
  tm.origin = "person";
  if (tm.session && !tm.session.closed) tm.session.close();
  tm.session = undefined;
  if (working && notice) eng.addItem(rt, { kind: "notice", at: now(), text: "Stopped.", tone: "info" }, tm.ownThread);
  save(eng, rt);
  sendManagerRow(eng, rt, tm, true);
}

/** Stop on the bot: its task managers stop what they do, with their workers. */
export function stopTaskManagers(eng: Engine, rt: BotRuntime): void {
  for (const tm of rt.managers.values()) if (managerState(eng, rt, tm) !== "resting") stopManager(eng, rt, tm);
}

/** taskManager.stop: the person's Stop in its thread. */
export function stopTaskManagerFrom(eng: Engine, params: Methods["taskManager.stop"]["params"]): void {
  const rt = eng.bot(params.botId);
  const tm = rt.managers.get(params.managerId);
  if (!tm) return;
  log.info(`Bot ${rt.folder.id}: the person stopped a task manager`);
  stopManager(eng, rt, tm);
}

/** Ends it: stopped, its row says ended, out of the rail and the database. */
function endManager(eng: Engine, rt: BotRuntime, tm: TaskManager, how: "bot" | "person" | "failed" | "retired" | "vacation", by?: string): void {
  stopManager(eng, rt, tm, false);
  for (const [id, p] of [...eng.cards]) if (p.manager === tm.id) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
  rt.managers.delete(tm.id);
  sendManagerRow(eng, rt, tm, true, true);
  const text = how === "person" ? "You ended this task manager" : how === "failed" ? "The task manager could not start" : how === "retired" ? "Ended, because its bot was retired" : how === "vacation" ? "Ended, because its bot went on vacation" : `Ended by ${by ?? rt.folder.file.name}`;
  if (eng.store.isOpen) eng.addItem(rt, { kind: "notice", at: now(), text, tone: "info" }, tm.ownThread);
  eng.titles.add({ threadId: tm.ownThread, botId: rt.folder.id, kind: "helper", fromSeq: 0 });
  save(eng, rt);
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  log.info(`Bot ${rt.folder.id}: a task manager was ended (${how})`);
}

/** taskManager.end: the person's "End task manager". Its bot hears of it at its next turn. */
export function endTaskManagerFrom(eng: Engine, params: Methods["taskManager.end"]["params"]): void {
  const rt = eng.bot(params.botId);
  const tm = rt.managers.get(params.managerId);
  if (!tm) return;
  endManager(eng, rt, tm, "person");
  eng.store.addNews(rt.folder.id, rt.threadId, `Note from Pobots: the person ended your task manager ${shortHelperId(tm.id)} "${tm.title}" ${localWhen(eng, now())}.`);
}

/** end_task_manager: its bot ends it, or the main bot ends another bot's (that bot is told). */
export async function endTaskManagerFor(eng: Engine, asker: BotRuntime, args: EndTaskManagerArgs): Promise<ToolResult> {
  let owner = asker;
  if (args.bot?.trim()) {
    const b = eng.findBot(args.bot.trim());
    if (!b) return problem(`There is no bot called ${args.bot.trim()}. Use list_bots to see the others.`);
    if (b !== asker && asker.folder.file.role !== "main") return problem("Only the main bot can end another bot's task manager.");
    owner = b;
  }
  const want = args.id?.trim() ?? "";
  if (want.length < 6) return problem("Give the task manager's whole id (8 characters), from start_task_manager.");
  const tm = findManager(owner, want);
  if (!tm) return problem(`There is no task manager ${want}${owner === asker ? " of yours" : ` of ${owner.folder.file.name}`} that is still there.`);
  endManager(eng, owner, tm, "bot", asker.folder.file.name);
  if (owner !== asker) eng.store.addNews(owner.folder.id, owner.threadId, `Note from Pobots: ${asker.folder.file.name} ended your task manager ${shortHelperId(tm.id)} "${tm.title}" ${localWhen(eng, now())}.`);
  return ok(`Ended task manager ${shortHelperId(tm.id)} "${tm.title}". Its workers stopped and it left the person's rail; its thread stays in the history.`);
}

/** The bot is retired: its task managers end with it. */
export function endAllTaskManagers(eng: Engine, rt: BotRuntime, why: "retired" | "vacation" = "retired"): void {
  for (const tm of [...rt.managers.values()]) endManager(eng, rt, tm, why);
}

// ------------------------------------------------------------ Pobots stops and starts

/** Pobots is stopping: each task manager stops what it does and is kept, resting. */
export function closeTaskManagers(eng: Engine, rt: BotRuntime): void {
  for (const tm of rt.managers.values()) {
    const working = managerState(eng, rt, tm) !== "resting";
    stopManager(eng, rt, tm, false);
    if (working && eng.store.isOpen) eng.store.addItem(tm.ownThread, { kind: "notice", at: now(), text: "Pobots restarted, so the task manager stopped. Write to it to go on.", tone: "info" });
    clearTimeout(tm.rowTimer);
  }
}

/** At start-up: the bot's task managers come back, resting. One that worked when Pobots stopped says so. */
export function restoreTaskManagers(eng: Engine, rt: BotRuntime): void {
  const raw = eng.store.getValue(key(rt.folder.id));
  if (!raw) return;
  let saved: Saved[] = [];
  try {
    saved = JSON.parse(raw) as Saved[];
  } catch (err) {
    log.warn(`Bot ${rt.folder.id}: could not read its task managers`, err);
    return;
  }
  for (const s of saved) {
    const row = eng.store.getItem(s.id);
    if (!row || row.kind !== "helper") continue;
    const tm: TaskManager = {
      ...s,
      botId: rt.folder.id,
      row,
      busy: false,
      origin: "person",
      texts: new Map(),
      lastText: "",
      calls: new Map(),
      inbox: [],
      steered: new Map(),
      steps: row.steps,
      ...(row.last ? { last: row.last } : {}),
      workers: s.workers ?? [],
      lateCalls: new Set(),
      rowAt: 0,
    };
    if (row.status === "running") eng.store.addItem(tm.ownThread, { kind: "notice", at: now(), text: "Pobots restarted, so the task manager stopped. Write to it to go on.", tone: "info" });
    rt.managers.set(tm.id, tm);
    const state = "resting" as const;
    const item: HelperItem = { ...row, status: "done", taskManager: { maxWorkers: tm.maxWorkers, tools: tm.tools, mayMessage: tm.mayMessage.map((id) => eng.nameOf(id)), ...(tm.folder ? { folder: tm.folder } : {}), state } };
    tm.row = item;
    eng.store.updateItem(item);
  }
  if (rt.managers.size) log.info(`Bot ${rt.folder.id}: ${rt.managers.size} task manager${rt.managers.size === 1 ? "" : "s"} back, resting`);
}
