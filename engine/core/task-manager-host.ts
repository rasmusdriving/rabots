// What a task manager may use (engine 0.26.0, docs/build/step-task-managers.md): the tools its bot
// chose, scoped to it. Cards and to-dos name it ("<title>, for <bot>") and their answers come back
// to it; message_bot reaches its own bot and the bots it was allowed; show_artifact puts the page in
// its thread. Its approvals and questions never hold the bot.
import { aheadTool } from "./ahead-settings.js";
import { aheadToolFor } from "./ahead-tool.js";
import { away, vacationRefusal } from "./vacation.js";
import { followUpWords, takePlace } from "./card-questions.js";
import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Engine } from "../engine.js";
import { type AskOutcome, type BotRuntime, type CallContext, callScope, type InternalDecision, type PendingCard } from "./runtime.js";
import type { ApprovalCard, NoteCard, QuestionCard, Todo, TaskManagerTool, UserItem } from "../../shared/protocol.js";
import { TODOS_PER_BOT } from "../../shared/protocol.js";
import { type BotTool, TOOL_SERVER, type ToolResult } from "../claude/session.js";
import { buildTools, type MessageBotArgs, ok, problem, type StartHelperArgs, type TeamHost, TOOL_NAMES } from "../team.js";
import { describeApproval } from "../claude/labels.js";
import { removeCard, saveAlwaysRules } from "./cards.js";
import { rulesFromSuggestions } from "../rules.js";
import { goLate, newAsk } from "./asks.js";
import { listWords, newTodo, type TodoArgs } from "../todos.js";
import { removeTodoFor, todoContext, updateTodoFor } from "./todos.js";
import { checkShowPath } from "../artifacts.js";
import { artifactLine, pageArtifact } from "./artifacts.js";
import { whenWords } from "../schedule.js";
import { clip, now } from "./words.js";
import { log } from "../log.js";
import { deliver, managerChanged, type TaskManager } from "./task-managers.js";
import { takeGrant } from "./restored-cards.js";
import { readWorkerFor, startWorkerFor, steerWorkerFor, stopWorkerFor } from "./task-manager-workers.js";
import { newBlock } from "./todo-blocks.js";
import { todoBlocksText } from "./ahead-settings.js";
import type { ReadHelperArgs, SteerHelperArgs, StopHelperArgs } from "../helper-tools.js";

/** The bot tools each choice gives. "browser" gives none: only words. */
const TOOLS_OF: Record<TaskManagerTool, string[]> = {
  workers: [TOOL_NAMES.startHelper, TOOL_NAMES.readHelper, TOOL_NAMES.steerHelper, TOOL_NAMES.stopHelper],
  ask_human: [TOOL_NAMES.askHuman],
  notify_human: [TOOL_NAMES.notifyHuman],
  todos: [TOOL_NAMES.addTodo, TOOL_NAMES.updateTodo, TOOL_NAMES.removeTodo, TOOL_NAMES.listTodos],
  message_bot: [TOOL_NAMES.messageBot],
  show_artifact: [TOOL_NAMES.showArtifact],
  browser: [],
};

/** The task manager's tools: the bot tools of its choices, each one working for it. */
export function managerTools(eng: Engine, rt: BotRuntime, tm: TaskManager): BotTool[] {
  const no = async (): Promise<ToolResult> => problem("You do not have this tool.");
  const host = {
    askHuman: (args: { question: string; context?: string; choices?: string[]; allow_text?: boolean }, signal?: AbortSignal) => askFor(eng, rt, tm, args, signal),
    notifyHuman: (args: { title: string; text?: string }) => noteFor(eng, rt, tm, args),
    messageBot: (args: MessageBotArgs, signal?: AbortSignal) => messageFor(eng, rt, tm, args, signal),
    showArtifact: (args: { path: string; title?: string }) => showFor(eng, rt, tm, args),
    startHelper: (args: StartHelperArgs, signal?: AbortSignal) => startWorkerFor(eng, rt, tm, args, signal),
    readHelper: (args: ReadHelperArgs) => readWorkerFor(eng, rt, tm, args),
    steerHelper: (args: SteerHelperArgs) => steerWorkerFor(eng, rt, tm, args),
    stopHelper: (args: StopHelperArgs) => stopWorkerFor(eng, rt, tm, args),
    addTodo: (args: TodoArgs) => addTodoFor(eng, rt, tm, args),
    updateTodo: (args: TodoArgs & { id?: string }) => (ownTodo(eng, tm, args.id) ? updateTodoFor(eng, rt, args) : problem("You have no to-do with that id. list_todos shows your open ones.")),
    removeTodo: (args: { id?: string }) => (ownTodo(eng, tm, args.id) ? removeTodoFor(eng, rt, args) : problem("You have no to-do with that id. list_todos shows your open ones.")),
    listTodos: () => ok(listWords(eng.store.openTodos(rt.folder.id).filter((t) => t.taskManager?.id === tm.id), (at) => whenWords(Date.parse(at), eng.clock(), eng.tz))),
  };
  // Every other method of a bot's host is never reached: its tools are left out below.
  const full = new Proxy(host, { get: (t, p) => (p in t ? t[p as keyof typeof t] : no) }) as unknown as TeamHost;
  const allowed = new Set(tm.tools.flatMap((t) => TOOLS_OF[t]));
  const tools = buildTools("bot", full, { harness: tm.harness, models: eng.modelList(), todoBlocks: todoBlocksText(eng) })
    .filter((t) => allowed.has(t.name))
    .map((t) => (t.name === TOOL_NAMES.startHelper ? { ...t, description: workerWords(t.description, tm.maxWorkers) } : t));
  // Protocol 31: a task manager has its bot's Ahead level; its items are the bot's.
  if (aheadTool(eng, rt)) tools.push(aheadToolFor(eng, rt, { threadId: tm.ownThread }));
  if (tm.harness !== "codex") return tools;
  return tools.map((t) => ({ ...t, handler: (args: Record<string, unknown>, signal?: AbortSignal) => managerLateCall(eng, rt, tm, t.name, args, signal, t.handler) }));
}

/** start_helper's description for a task manager: workers, and its own cap. */
function workerWords(description: string, max: number): string {
  const cut = description.replace(/ At most \d+ at once for you, \d+ across all bots\./, "");
  return `Start a worker of your own. ${cut} At most ${max} of your workers at once, any number over the whole task; a start beyond that is refused.`;
}

function ownTodo(eng: Engine, tm: TaskManager, id: string | undefined): boolean {
  const row = typeof id === "string" ? eng.store.getTodo(id.trim()) : undefined;
  return row?.todo.taskManager?.id === tm.id;
}

// ------------------------------------------------------------ cards

/** A card of the task manager: in its thread, named for it; the bot is not held. */
export function openManagerCard(eng: Engine, rt: BotRuntime, tm: TaskManager, card: ApprovalCard | QuestionCard, signal?: AbortSignal): Promise<InternalDecision> {
  card.taskManager = tm.title;
  // Engine 0.29.0: the repeat of a step the person approved on a card that came back after a restart.
  const granted = card.kind === "approval" ? takeGrant(eng, card) : undefined;
  if (granted) return Promise.resolve(granted);
  // An approval for work the bot asked for expires as one of a helper the person did not start does.
  const expires = card.kind === "approval" && tm.origin === "bot" && tm.purpose.startedBy !== "you";
  if (expires) card.expiresAt = new Date(Date.now() + eng.cardExpiryMs).toISOString();
  // Engine 0.31.0: a question after the person asked about the last one takes its place (core/card-questions.ts).
  const place = card.kind === "question" ? takePlace(eng, rt, card, tm.id) : {};
  if (place.decision) return Promise.resolve(place.decision);
  return new Promise((resolve) => {
    const pending: PendingCard = { card, rt, resolve, manager: tm.id };
    // Only while this call still waits on the card: one it left stays (core/card-questions.ts).
    const mine = () => eng.cards.get(card.id) === pending;
    if (expires) {
      pending.timer = setTimeout(() => mine() && removeCard(eng, card.id, "expired", { type: "expired" }), eng.cardExpiryMs);
      pending.timer.unref?.();
    }
    eng.cards.set(card.id, pending);
    eng.store.addCard(card);
    eng.opts.emit(place.replaced ? "card.changed" : "card.added", { card });
    managerChanged(eng, rt, tm.id);
    if (signal) {
      if (signal.aborted) removeCard(eng, card.id, "withdrawn", { type: "withdrawn" });
      else signal.addEventListener("abort", () => mine() && removeCard(eng, card.id, "withdrawn", { type: "withdrawn" }), { once: true });
    }
  });
}

/**
 * What the harness asks about the task manager's own tool calls. It has exactly its bot's access
 * (16 Nov 2026: "like a consultant hired by the bot ... should have the same access"): the
 * bot's level, the bot's saved rules (given to its session in makeSession), and "Always allow" on its
 * card saves the rule to the bot, as the bot's own card does (core/cards.ts canUseTool). A request from
 * Codex has no "Always allow", as on a Codex bot: the saved rules are in Claude's format.
 */
export async function managerCanUseTool(eng: Engine, rt: BotRuntime, tm: TaskManager, toolName: Parameters<CanUseTool>[0], input: Parameters<CanUseTool>[1], options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
  if (eng.stopping || !rt.managers.has(tm.id)) return { behavior: "deny", message: "The task manager was stopped.", interrupt: true };
  if (toolName.startsWith(`mcp__${TOOL_SERVER}__`)) return { behavior: "allow", updatedInput: input };
  const access = rt.folder.file.access;
  if (access === "full-access") return { behavior: "allow", updatedInput: input };
  if (access === "decides-itself") {
    log.info(`Bot ${rt.folder.id}: refused a ${toolName} call of a task manager that the harness asked about, on "Decides itself"`);
    return { behavior: "deny", message: "Not allowed: your bot decides by itself and does not ask the person. Do it another way, or say in your result what you could not do." };
  }
  const words = describeApproval(toolName, input);
  const noAlways = (options as unknown as { pobotsNoAlways?: boolean }).pobotsNoAlways === true;
  const rules = options.suppressAlwaysAllowRule || noAlways ? [] : rulesFromSuggestions(options.suggestions);
  const card: ApprovalCard = {
    kind: "approval",
    id: randomUUID(),
    botId: rt.folder.id,
    threadId: tm.ownThread,
    at: now(),
    title: words.title,
    detail: words.detail,
    ...(words.caption ? { caption: words.caption } : {}),
    ...(noAlways ? { noAlways: true } : {}),
  };
  const decision = await openManagerCard(eng, rt, tm, card, options.signal);
  switch (decision.type) {
    case "allow-once":
      return { behavior: "allow", updatedInput: input };
    case "always-allow": {
      // Saved to the bot; the bot's own session takes it at its next start (it is not this session).
      const update = saveAlwaysRules(eng, rt, rules, { otherSession: true });
      return { behavior: "allow", updatedInput: input, ...(update.length ? { updatedPermissions: update } : {}) };
    }
    case "later":
      return { behavior: "deny", message: "The person put this aside for later. Leave it for now and carry on, or say what you still need." };
    case "withdrawn":
      return { behavior: "deny", message: "The request was withdrawn because you were stopped.", interrupt: true };
    case "expired":
      return { behavior: "deny", message: "Nobody answered in time, so this counts as a no. Do not try it another way." };
    default:
      return { behavior: "deny", message: "The person said no. Do not try to do this another way without asking first." };
  }
}

/** ask_human for a task manager. */
async function askFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: { question: string; context?: string; choices?: string[]; allow_text?: boolean }, signal?: AbortSignal): Promise<ToolResult> {
  const choices = (args.choices ?? []).map((c) => c.trim()).filter(Boolean).map((label, i) => ({ id: String(i), label }));
  const card: QuestionCard = {
    kind: "question",
    id: randomUUID(),
    botId: rt.folder.id,
    threadId: tm.ownThread,
    at: now(),
    title: clip(args.question, 300),
    ...(args.context?.trim() ? { text: clip(args.context, 1000) } : {}),
    choices,
    allowText: choices.length === 0 ? true : args.allow_text ?? true,
  };
  const decision = await openManagerCard(eng, rt, tm, card, signal);
  switch (decision.type) {
    case "choice":
      return ok(`The person chose: ${choices.find((c) => c.id === decision.choiceId)?.label ?? decision.choiceId}`);
    case "text":
      return ok(`The person answered: ${decision.text}`);
    case "ask":
      // Engine 0.31.0: he asked about the card before answering (core/card-questions.ts). The card stays.
      return ok(followUpWords(decision.text, "ask_human"));
    case "withdrawn":
      return problem("The question was withdrawn because you were stopped.");
    default:
      return ok("The person has not answered yet. Carry on without the answer, or ask again later.");
  }
}

/** notify_human for a task manager. */
function noteFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: { title: string; text?: string }): ToolResult {
  const card: NoteCard = {
    kind: "note",
    id: randomUUID(),
    botId: rt.folder.id,
    threadId: tm.ownThread,
    at: now(),
    title: clip(args.title, 120),
    ...(args.text?.trim() ? { text: clip(args.text, 1000) } : {}),
    taskManager: tm.title,
  };
  eng.cards.set(card.id, { card, rt, resolve: () => undefined, manager: tm.id });
  eng.store.addCard(card);
  eng.opts.emit("card.added", { card });
  return ok("The note is in front of the person now.");
}

// ------------------------------------------------------------ to-dos

/** add_todo for a task manager: the to-do names it, and its answer comes back to it. */
async function addTodoFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: TodoArgs): Promise<ToolResult> {
  if (!eng.store.isOpen) return problem("Pobots is stopping, so the to-do was not added.");
  if (eng.store.openTodos(rt.folder.id).length >= TODOS_PER_BOT) return problem(`Your bot already has ${TODOS_PER_BOT} open to-dos on the person's list, the most. Remove one of yours first, or ask with ask_human.`);
  let todo: Todo;
  try {
    todo = { ...newTodo(rt.folder.id, args, todoContext(eng, rt), now()), taskManager: { id: tm.id, title: tm.title } };
  } catch (err) {
    return problem(err instanceof Error ? err.message : String(err));
  }
  eng.store.saveTodo({ todo, status: "open" });
  eng.opts.emit("todo.changed", { todo });
  log.info(`Bot ${rt.folder.id}: a task manager added a to-do for the person`);
  const block = await newBlock(eng, rt, todo, tm.ownThread);
  return ok(`Added "${todo.title}" to the person's to-do list (id ${todo.id}). When they act on it you get their answer as a message from them.${todo.keepOpen ? " It stays on the list after an answer: update or remove it when it is settled." : " An answer takes it off the list."}${block}`);
}

/** The person answered a task manager's to-do: it gets the answer while it is there. False when it is gone (the bot gets it then). */
export function answerToManager(eng: Engine, rt: BotRuntime, todo: Todo, text: string): boolean {
  const tm = todo.taskManager ? rt.managers.get(todo.taskManager.id) : undefined;
  if (!tm) return false;
  const id = randomUUID();
  eng.addItem(rt, { id, kind: "user", at: now(), text, from: { type: "you", todo: { id: todo.id, title: todo.title } }, queued: false }, tm.ownThread);
  void deliver(eng, rt, tm, `The person answered your to-do "${todo.title}":\n\n${text}`, "person", id).catch((err) => log.error(`Bot ${rt.folder.id}: could not pass a to-do's answer to a task manager`, err));
  return true;
}

// ------------------------------------------------------------ messages to bots

/** message_bot for a task manager: its own bot and the bots it was allowed, framed as from it. */
async function messageFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: MessageBotArgs, signal?: AbortSignal): Promise<ToolResult> {
  const target = eng.findBot(args.to);
  const names = [rt.folder.file.name, ...tm.mayMessage.map((id) => eng.nameOf(id))].join(", ");
  if (!target) return problem(`There is no bot called ${args.to}. You may message ${names}.`);
  const name = target.folder.file.name;
  if (away(target)) return problem(vacationRefusal(target));
  if (target !== rt && !tm.mayMessage.includes(target.folder.id)) return problem(`You may not message ${name}. You may message ${names}.`);
  const text = args.text.trim();
  if (!text) return problem("The message is empty.");
  if (!eng.harnessReady(target) || eng.stopping) return problem(`${name} cannot be reached right now.`);
  const from: UserItem["from"] = { type: "bot", botId: rt.folder.id, expectsReply: args.mode === "ask", taskManager: tm.title };
  if (args.mode === "tell") {
    eng.enqueue(target, text, from, { hops: 1 });
    return ok(`Delivered to ${name}. It reads it when it is free and is not expected to answer.`);
  }
  const ask = newAsk(eng, `tm:${tm.id}`, target.folder.id, 1, 0);
  ask.onLate = (answer) => {
    if (!rt.managers.has(tm.id)) return;
    void deliver(eng, rt, tm, `${name} answered your earlier question, which took longer than you waited:\n\n${answer}`, tm.origin).catch((err) => log.error(`Bot ${rt.folder.id}: could not pass a late answer to a task manager`, err));
  };
  const outcome = await new Promise<AskOutcome>((resolve) => {
    ask.resolve = resolve;
    ask.timer = setTimeout(() => goLate(eng, ask), eng.askTimeoutMs);
    ask.timer.unref?.();
    signal?.addEventListener("abort", () => goLate(eng, ask), { once: true });
    eng.enqueue(target, text, from, { hops: 1, ask });
  });
  if ("late" in outcome) return ok(`${name} has not answered yet. Its answer will come to you later as a message. Carry on without it for now.`);
  if ("problem" in outcome) return problem(outcome.problem);
  return ok(`${name} answered:\n\n${outcome.answer}`);
}

// ------------------------------------------------------------ pages

/** show_artifact for a task manager: a page from its bot's folder, with its line in the task manager's thread. */
async function showFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: { path: string; title?: string }): Promise<ToolResult> {
  const check = checkShowPath(rt.folder.dir, String(args.path ?? ""));
  if (!check.ok) return problem(check.why);
  if (!eng.bots.has(rt.folder.id) || !eng.store.isOpen) return problem("Pobots is stopping, so the artifact was not shown.");
  const { row, made } = pageArtifact(eng, rt, check.rel, check.full, args.title);
  artifactLine(eng, rt, row, made ? "made" : "updated", tm.ownThread);
  return ok(`The person can now open "${row.title}" beside your thread.`);
}

// ------------------------------------------------------------ a GPT task manager's slow calls

/**
 * Codex waits for a tool call only about 30 seconds: a slower one is answered with "you get the
 * result in a new message", and the result comes to the task manager when it is there (as lateCall
 * does for a bot).
 */
export async function managerLateCall(eng: Engine, rt: BotRuntime, tm: TaskManager, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, handler: BotTool["handler"]): Promise<ToolResult> {
  const ctx: CallContext = { detached: false };
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => (ctx.detached ? undefined : ac.abort()), { once: true });
  }
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
    for (const ask of [...eng.asks]) if (ask.from === `tm:${tm.id}` && !ask.late && !ask.settled) goLate(eng, ask);
    return running;
  }
  ctx.detached = true;
  ctx.onDetach?.();
  tm.lateCalls.add(ac);
  void running.then(
    (result) => {
      tm.lateCalls.delete(ac);
      if (ac.signal.aborted || eng.stopping || !rt.managers.has(tm.id)) return;
      const text = result.content.map((c) => c.text).join("\n");
      const said = name === TOOL_NAMES.startHelper ? text.replace(/^Your helper/, "Your worker") : `Note from Pobots: your earlier call to ${name} has finished. ${result.isError ? "It ended with a problem" : "Its answer"}:\n\n${text}`;
      void deliver(eng, rt, tm, said, tm.origin);
    },
    (err) => {
      tm.lateCalls.delete(ac);
      log.warn(`Bot ${rt.folder.id}: a task manager's ${name} failed after it was answered early`, err);
    },
  );
  return ok(
    name === TOOL_NAMES.startHelper
      ? "The worker is still working. You get its result in a new message when it is done. Do not start it again; carry on with something else or end your turn."
      : "This is still going: it waits for the person or for something else that takes time. You get its answer in a new message when it comes. Do not call it again; carry on with something else or end your turn.",
  );
}
