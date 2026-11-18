// Task managers in the stand-in engine (protocol 21, docs/build/step-task-managers.md). Each bot lists
// its task managers in Bot.taskManagers as the engine does; a task manager's workers are listed among
// the bot's working helpers with `managerId`, never counted as the bot's own helpers. The window check
// drives them with the levers on window.pobotsTaskManagers:
//   start(botId, { title, maxWorkers?, tools?, mayMessage?, model?, effort?, folder?, minutes?, state? }) starts one
//     (its row in the bot's chat, its own thread with the task) and returns its id;
//   worker(id, title) starts a worker in its thread (null at its max_workers), endWorker(itemId) ends one;
//   ask(id, title) puts a question card from it; approve(id, title, caption) an approval card from it, with
//     "Always allow", which saves the rule to its bot (fix 0.26.1); todo(id, title) a to-do; say(id, text) a message in its thread;
//   state(id, "working" | "resting") sets what it does; end(id) ends it as its bot does; list() what is there.
// &tm=1 seeds two: Kaja's "Build the booking page" with two workers and a question card, and HubSpot
// tickets' "Move the old tickets", resting.
import type { ApprovalCard, Bot, BotItem, Card, CardDecision, Effort, HelperItem, Methods, NoticeItem, QuestionCard, TaskManagerInfo, TaskManagerTool, UserItem, WorkingHelper } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";
import { EngineError } from "./types";

interface MockManager {
  id: string;
  botId: string;
  threadId: string;
  ownThread: string;
  title: string;
  model: string;
  effort?: Effort;
  startedAt: string;
  /** What it does when no card of it waits. */
  base: "working" | "resting";
  maxWorkers: number;
  tools: TaskManagerTool[];
  mayMessage: string[];
  folder?: string;
  /** Its workers that work now, by item id. */
  workers: string[];
}

type StartOptions = { title: string; maxWorkers?: number; tools?: TaskManagerTool[]; mayMessage?: string[]; model?: string; effort?: Effort; folder?: string; minutes?: number; state?: "working" | "resting" };

export interface TaskManagerLevers {
  start(botId: string, o: StartOptions): string;
  worker(id: string, title: string): string | null;
  endWorker(itemId: string): void;
  ask(id: string, title: string): string;
  approve(id: string, title: string, caption: string): string;
  todo(id: string, title: string): string;
  say(id: string, text: string): void;
  state(id: string, state: "working" | "resting"): void;
  end(id: string): void;
  list(): TaskManagerInfo[];
  /** What the person sent to task managers, in order. */
  sent(): { managerId: string; text: string }[];
}

declare global {
  interface Window {
    pobotsTaskManagers?: TaskManagerLevers;
  }
}

const DEFAULT_TOOLS: TaskManagerTool[] = ["workers", "ask_human", "notify_human", "message_bot", "show_artifact"];
const managers = new Map<string, MockManager>();
const sentLog: { managerId: string; text: string }[] = [];

function stateOf(mock: MockEngine, tm: MockManager): TaskManagerInfo["state"] {
  if (mock.cards.some((c) => c.kind !== "system" && c.kind !== "note" && c.botId === tm.botId && c.taskManager === tm.title)) return "waiting";
  if (tm.workers.length) return "working";
  return tm.base;
}

function infoOf(mock: MockEngine, tm: MockManager): TaskManagerInfo {
  const bot = mock.bot(tm.botId);
  return {
    id: tm.id,
    threadId: tm.threadId,
    managerThreadId: tm.ownThread,
    title: tm.title,
    harness: /^gpt-/.test(tm.model) ? "codex" : (bot.harness ?? "claude"),
    model: tm.model,
    ...(tm.effort ? { effort: tm.effort } : {}),
    startedAt: tm.startedAt,
    state: stateOf(mock, tm),
    workersNow: tm.workers.length,
    maxWorkers: tm.maxWorkers,
    tools: tm.tools,
    mayMessage: tm.mayMessage.map((id) => mock.bots.find((b) => b.id === id)?.name ?? id),
    ...(tm.folder ? { folder: tm.folder } : {}),
  };
}

/** The bot as the engine sends it: its task managers, and their workers among its working helpers. */
export function withManagers(mock: MockEngine, bot: Bot): Bot {
  const mine = [...managers.values()].filter((tm) => tm.botId === bot.id);
  const { taskManagers: _gone, ...rest } = bot;
  if (mine.length === 0) return rest;
  const own = (bot.workingHelpers ?? []).filter((w) => !w.managerId);
  const workers: WorkingHelper[] = mine.flatMap((tm) =>
    tm.workers.map((itemId) => {
      const item = mock.helperItem(itemId);
      return { itemId, threadId: item.threadId, helperThreadId: item.helperThreadId, title: item.title, startedAt: item.at, ...(item.model ? { model: item.model } : {}), managerId: tm.id, taskManager: tm.title };
    }),
  );
  const working = [...own, ...workers].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const { workingHelpers: _w, ...base } = rest;
  return { ...base, ...(working.length ? { workingHelpers: working } : {}), taskManagers: mine.map((tm) => infoOf(mock, tm)) };
}

/** Its row in the bot's chat says what it does now; the bot is sent again. */
function refresh(mock: MockEngine, tm: MockManager, ended = false): void {
  const row = mock.helperItem(tm.id);
  const state = ended ? "ended" : stateOf(mock, tm);
  mock.putHelper({
    ...row,
    status: state === "working" || state === "waiting" ? "running" : "done",
    ...(ended ? { endedAt: new Date().toISOString() } : {}),
    taskManager: { maxWorkers: tm.maxWorkers, tools: tm.tools, mayMessage: infoOf(mock, tm).mayMessage, ...(tm.folder ? { folder: tm.folder } : {}), state },
  });
  mock.putBot(mock.bot(tm.botId));
}

function find(id: string): MockManager {
  const tm = managers.get(id);
  if (!tm) throw new EngineError({ code: "not_found", message: "This task manager has ended." });
  return tm;
}

function start(mock: MockEngine, botId: string, o: StartOptions): string {
  const bot = mock.bot(botId);
  const when = o.minutes ? minutesAgo(o.minutes) : undefined;
  const ownThread = `tm-${mock.nextId++}`;
  mock.threads.set(ownThread, []);
  const tools = o.tools ?? DEFAULT_TOOLS;
  const maxWorkers = o.maxWorkers ?? 2;
  const mayMessage = o.mayMessage ?? [];
  const model = o.model ?? bot.model;
  mock.add<UserItem>(ownThread, { kind: "user", from: { type: "bot", botId, expectsReply: true }, queued: false, text: `${o.title}. Plan it, run the work through workers, check it and report back.` }, when);
  mock.upsert(mock.add<BotItem>(bot.mainThreadId, { kind: "bot", botId, streaming: false, text: `I started a task manager for this: ${o.title}.` }, when));
  const row = mock.add<HelperItem>(
    bot.mainThreadId,
    {
      kind: "helper",
      botId,
      title: o.title,
      helperThreadId: ownThread,
      status: o.state === "resting" ? "done" : "running",
      background: true,
      steps: 0,
      last: "Planning",
      model,
      ...(o.effort ? { effort: o.effort } : {}),
      taskManager: { maxWorkers, tools, mayMessage, ...(o.folder ? { folder: o.folder } : {}), state: o.state ?? "working" },
    },
    when,
  );
  mock.upsert(row);
  mock.upsert(mock.add<BotItem>(ownThread, { kind: "bot", botId, streaming: false, text: "I split the work in three parts and start the first two now." }, when));
  managers.set(row.id, {
    id: row.id,
    botId,
    threadId: bot.mainThreadId,
    ownThread,
    title: o.title,
    model,
    ...(o.effort ? { effort: o.effort } : {}),
    startedAt: row.at,
    base: o.state ?? "working",
    maxWorkers,
    tools,
    mayMessage,
    ...(o.folder ? { folder: o.folder } : {}),
    workers: [],
  });
  refresh(mock, managers.get(row.id)!);
  return row.id;
}

function worker(mock: MockEngine, id: string, title: string): string | null {
  const tm = find(id);
  if (tm.workers.length >= tm.maxWorkers) return null;
  const helperThreadId = `helper-${mock.nextId++}`;
  mock.threads.set(helperThreadId, []);
  mock.add<UserItem>(helperThreadId, { kind: "user", from: { type: "bot", botId: tm.botId, expectsReply: true }, queued: false, text: title });
  const item = mock.add<HelperItem>(tm.ownThread, { kind: "helper", botId: tm.botId, title, helperThreadId, status: "running", background: true, steps: 0, last: "Reading" });
  mock.upsert(item);
  tm.workers.push(item.id);
  refresh(mock, tm);
  return item.id;
}

function endWorker(mock: MockEngine, itemId: string, status: HelperItem["status"] = "done"): void {
  const tm = [...managers.values()].find((m) => m.workers.includes(itemId));
  if (!tm) return;
  tm.workers = tm.workers.filter((w) => w !== itemId);
  const item = mock.helperItem(itemId);
  mock.putHelper({ ...item, status, endedAt: new Date().toISOString(), steps: 4, last: status === "done" ? "Done" : "Stopped" });
  refresh(mock, tm);
}

function ask(mock: MockEngine, id: string, title: string): string {
  const tm = find(id);
  const card: QuestionCard = {
    kind: "question",
    id: `c${mock.nextId++}`,
    botId: tm.botId,
    threadId: tm.ownThread,
    at: new Date().toISOString(),
    title,
    text: "Both work with the booking page as it is planned.",
    choices: [
      { id: "a", label: "Week view" },
      { id: "b", label: "Month view" },
    ],
    allowText: true,
    taskManager: tm.title,
  };
  mock.cards.push(card);
  mock.emit({ event: "card.added", data: { card } });
  refresh(mock, tm);
  return card.id;
}

/** An approval from it: with "Always allow", as its bot's own card has (fix 0.26.1). */
function approve(mock: MockEngine, id: string, title: string, caption: string): string {
  const tm = find(id);
  const card: ApprovalCard = {
    kind: "approval",
    id: `c${mock.nextId++}`,
    botId: tm.botId,
    threadId: tm.ownThread,
    at: new Date().toISOString(),
    title,
    detail: `Command: ${caption}`,
    caption,
    taskManager: tm.title,
  };
  mock.cards.push(card);
  mock.emit({ event: "card.added", data: { card } });
  refresh(mock, tm);
  return card.id;
}

/** A card of a task manager was answered: it goes on with the answer. */
export function managerCardDone(mock: MockEngine, card: Card, decision: CardDecision): void {
  if (card.kind === "system" || !card.taskManager) return;
  const tm = [...managers.values()].find((m) => m.botId === card.botId && m.title === card.taskManager);
  if (!tm) return;
  if (decision.type !== "dismiss" && decision.type !== "later") tm.base = "working";
  refresh(mock, tm);
}

function say(mock: MockEngine, id: string, text: string): void {
  const tm = find(id);
  mock.upsert(mock.add<BotItem>(tm.ownThread, { kind: "bot", botId: tm.botId, streaming: false, text }));
}

function dropCards(mock: MockEngine, tm: MockManager, notes: boolean): void {
  for (const c of mock.cards.filter((x) => x.kind !== "system" && x.botId === tm.botId && x.taskManager === tm.title && (notes || x.kind !== "note"))) {
    mock.cards = mock.cards.filter((x) => x.id !== c.id);
    mock.emit({ event: "card.removed", data: { cardId: c.id, reason: "withdrawn" } });
  }
}

function stop(mock: MockEngine, tm: MockManager, notice: boolean): void {
  const was = stateOf(mock, tm) !== "resting";
  dropCards(mock, tm, false);
  for (const w of [...tm.workers]) endWorker(mock, w, "stopped");
  tm.base = "resting";
  if (was && notice) mock.upsert(mock.add<NoticeItem>(tm.ownThread, { kind: "notice", tone: "info", text: "Stopped." }));
  refresh(mock, tm);
}

function end(mock: MockEngine, tm: MockManager, text: string): void {
  stop(mock, tm, false);
  dropCards(mock, tm, true);
  managers.delete(tm.id);
  mock.upsert(mock.add<NoticeItem>(tm.ownThread, { kind: "notice", tone: "info", text }));
  // The row says ended; the bot no longer lists it.
  const row = mock.helperItem(tm.id);
  mock.putHelper({ ...row, status: "done", endedAt: new Date().toISOString(), taskManager: { ...row.taskManager!, state: "ended" } });
  mock.putBot(mock.bot(tm.botId));
}

export function taskManagerSend(mock: MockEngine, p: Methods["taskManager.send"]["params"]): Record<string, never> {
  mock.bot(p.botId);
  const tm = find(p.managerId);
  const text = p.text.trim();
  if (!text) throw new EngineError({ code: "bad_request", message: "The message is empty." });
  const busy = stateOf(mock, tm) !== "resting";
  sentLog.push({ managerId: tm.id, text });
  mock.upsert(mock.add<UserItem>(tm.ownThread, { kind: "user", from: { type: "you" }, queued: false, text, ...(busy ? { steered: true } : {}) }));
  if (!busy) {
    tm.base = "working";
    refresh(mock, tm);
  }
  // It answers in a moment, and rests again when nothing else keeps it at work.
  setTimeout(() => {
    if (!managers.has(tm.id)) return;
    say(mock, tm.id, "Noted. I take that into the next step.");
    if (!busy) {
      tm.base = "resting";
      refresh(mock, tm);
    }
  }, 600);
  return {};
}

export function taskManagerStop(mock: MockEngine, p: Methods["taskManager.stop"]["params"]): Record<string, never> {
  mock.bot(p.botId);
  const tm = managers.get(p.managerId);
  if (tm) stop(mock, tm, true);
  return {};
}

export function taskManagerEnd(mock: MockEngine, p: Methods["taskManager.end"]["params"]): Record<string, never> {
  mock.bot(p.botId);
  const tm = managers.get(p.managerId);
  if (tm) end(mock, tm, "You ended this task manager");
  return {};
}

export function taskManagerLevers(mock: MockEngine): TaskManagerLevers {
  return {
    start: (botId, o) => start(mock, botId, o),
    worker: (id, title) => worker(mock, id, title),
    endWorker: (itemId) => endWorker(mock, itemId),
    ask: (id, title) => ask(mock, id, title),
    approve: (id, title, caption) => approve(mock, id, title, caption),
    todo: (id, title) => {
      const tm = find(id);
      return window.pobotsTodos?.add({ botId: tm.botId, title, why: "The booking page needs it before it goes live.", taskManager: { id: tm.id, title: tm.title } }) ?? "";
    },
    say: (id, text) => say(mock, id, text),
    state: (id, state) => {
      const tm = find(id);
      tm.base = state;
      refresh(mock, tm);
    },
    end: (id) => {
      const tm = find(id);
      end(mock, tm, `Ended by ${mock.bot(tm.botId).name}`);
    },
    list: () => [...managers.values()].map((tm) => infoOf(mock, tm)),
    sent: () => [...sentLog],
  };
}

export function seedTaskManagers(mock: MockEngine): void {
  if (!mock.bots.some((b) => b.id === "kaja") || !mock.bots.some((b) => b.id === "hubspot-tickets")) return;
  const booking = start(mock, "kaja", { title: "Build the booking page", minutes: 25, mayMessage: ["onboardings"] });
  worker(mock, booking, "Draw the booking form");
  worker(mock, booking, "Write the booking API");
  ask(mock, booking, "Which calendar view should the booking page open on?");
  start(mock, "hubspot-tickets", { title: "Move the old tickets", minutes: 70, state: "resting", maxWorkers: 3, tools: ["workers", "todos", "message_bot"] });
}
