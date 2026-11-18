// Task managers (protocol 21, docs/build/step-task-managers.md): a bot's helper that owns one long
// task, runs workers of its own and may ask the person. The window lists them in "Task managers" in
// the right rail, just above "Helpers at work", and opens a task manager's thread in the place of its
// bot's chat. Following T3 Code, where a delegated task is an ordinary thread the person can open and
// write in (apps/server/src/mcp/OrchestratorMcpService.ts, delegateTask).
import type { Bot, HelperItem, TaskManagerInfo, TaskManagerTool, WorkingHelper } from "../../shared/protocol";
import { openHelper } from "../state/actions";
import { store, type AppState, type HelperFrame } from "../state/store";
import { isPhone } from "./phone";
import { plural } from "./words";

export type ManagerState = TaskManagerInfo["state"] | "ended";

export const TM_WORDS = {
  title: "Task managers",
  /** The row's second line: whose it is and what it does now. */
  whose: (bot: string, tm: Pick<TaskManagerInfo, "state" | "workersNow">) =>
    tm.state === "waiting" ? `${bot}, waits for you` : tm.state === "resting" ? `${bot}, resting` : tm.workersNow > 0 ? `${bot}, ${plural(tm.workersNow, "worker")}` : `${bot}, working`,
  /** Who a card, a to-do or a worker is for. */
  forBot: (title: string, bot: string) => `${title}, for ${bot}`,
  end: "End task manager",
  stop: "Stop",
} as const;

/** Its state in a word, in its thread's head and on its row in the chat. */
export const TM_STATE_WORD: Record<ManagerState, string> = {
  working: "Working",
  waiting: "Waits for you",
  resting: "Resting",
  ended: "Ended",
};

/** What each tool lets it do, in the head of its thread. */
export const TM_TOOL_WORD: Record<TaskManagerTool, string> = {
  workers: "Workers",
  ask_human: "Questions to you",
  notify_human: "Notes to you",
  todos: "To-dos",
  message_bot: "Messages to bots",
  show_artifact: "Pages",
  browser: "Browser",
};

export interface Managed {
  bot: Bot;
  tm: TaskManagerInfo;
}

/** Every task manager of every bot, oldest first, so a new one comes at the end and nothing moves. */
export function allManagers(bots: Bot[]): Managed[] {
  const out: Managed[] = [];
  for (const bot of bots) for (const tm of bot.taskManagers ?? []) out.push({ bot, tm });
  return out.sort((a, b) => a.tm.startedAt.localeCompare(b.tm.startedAt));
}

/** Opens a task manager's thread, the same thread its row in the chat opens, going to its bot first. */
export function openManager(botId: string, tm: TaskManagerInfo): void {
  store.leave(() => {
    if (store.get().openBotId !== botId || store.get().openChannelId || isPhone()) store.openBot(botId);
    openHelper({ id: tm.id, botId, threadId: tm.threadId, helperThreadId: tm.managerThreadId, title: tm.title, status: tm.state === "resting" ? "done" : "running" });
  });
}

/**
 * Opens a task manager's worker from "Helpers at work": its task manager's thread first, then the
 * worker's, so going back from the worker lands in the task manager's thread. False when its task
 * manager is not known (then the worker opens on its own).
 */
export function openWorker(bot: Bot, w: WorkingHelper): boolean {
  const tm = w.managerId ? bot.taskManagers?.find((t) => t.id === w.managerId) : undefined;
  if (!tm) return false;
  store.leave(() => {
    if (store.get().openBotId !== bot.id || store.get().openChannelId || isPhone()) store.openBot(bot.id);
    const top = store.get().helpers[bot.id]?.at(-1);
    if (top?.itemId !== w.itemId) {
      if (top?.helperThreadId !== tm.managerThreadId) openHelper({ id: tm.id, botId: bot.id, threadId: tm.threadId, helperThreadId: tm.managerThreadId, title: tm.title, status: "running" });
    }
    openHelper({ id: w.itemId, botId: bot.id, threadId: w.threadId, helperThreadId: w.helperThreadId, title: w.title, status: "running" });
  });
  return true;
}

/** The open frame is a task manager's own thread: one of the bot's task managers, or a row that says it is one (an ended one). */
export function isManagerFrame(s: AppState, bot: Bot, frame: HelperFrame): boolean {
  if (bot.taskManagers?.some((t) => t.id === frame.itemId)) return true;
  const item = s.threads[frame.threadId]?.items.find((i): i is HelperItem => i.id === frame.itemId && i.kind === "helper");
  return !!item?.taskManager;
}

/** A row's word: the task manager's state, or the helper's. */
export function managerRowWord(item: HelperItem): string | undefined {
  return item.taskManager ? TM_STATE_WORD[item.taskManager.state] : undefined;
}
