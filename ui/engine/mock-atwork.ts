// Helpers at work in the mock (protocol 19, docs/build/step-helpers-in-rail.md): every bot lists the
// helpers the mock runs for it, as the engine does in Bot.workingHelpers, and the window check starts
// and ends helpers anywhere with the levers on window.pobotsAtWork:
//   start(botId, { title, inRun?, model?, parent?, minutes?, say? }) starts one that works until ended
//     (its row in the main chat, in a fresh run's thread when `inRun` names the run, or in the
//     thread of the helper `parent`; `say`: what the bot says after it), and returns its item id;
//   end(itemId) ends it, as done.
// &atwork=1 seeds two (Kaja's in the chat, Onboardings' in the run "Morning work round"); &atwork=5 five.
import type { Bot, BotItem, HelperItem, UserItem, WorkingHelper } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo, waitingFor, type HelperRun } from "./mock-data";

export interface AtWorkLevers {
  start(botId: string, o: { title: string; inRun?: string; model?: string; parent?: string; minutes?: number; say?: string }): string;
  end(itemId: string): void;
  /** Puts the bot's activity, as the engine says it: "Waiting for your answer" while it also waits for helpers. */
  activity(botId: string, words: string): void;
}

declare global {
  interface Window {
    pobotsAtWork?: AtWorkLevers;
  }
}

/** The bot as the engine sends it: its working helpers listed, oldest first, none when none. */
export function withWorking(mock: MockEngine, bot: Bot): Bot {
  const runs = [...mock.helperRuns.values()].filter((r) => r.botId === bot.id);
  if (runs.length === 0) {
    // A helper a scene draws without running it keeps the list the scene gave.
    if (bot.helpers) return bot;
    const { workingHelpers: _gone, ...rest } = bot;
    return rest;
  }
  const list = runs.map((r) => working(mock, r, bot)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { ...bot, workingHelpers: list };
}

function working(mock: MockEngine, run: HelperRun, bot: Bot): WorkingHelper {
  const item = mock.helperItem(run.itemId);
  const harness = item.harness ?? (item.model ? (/^gpt-/.test(item.model) ? "codex" : "claude") : bot.harness);
  return {
    itemId: item.id,
    threadId: item.threadId,
    helperThreadId: item.helperThreadId,
    title: item.title,
    ...(harness ? { harness } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.effort ? { effort: item.effort } : {}),
    startedAt: item.at,
    ...(run.inRun ? { inRun: run.inRun } : {}),
    ...(run.parentItemId ? { parentItemId: run.parentItemId } : {}),
  };
}

/** A helper that works until the check ends it. */
function start(mock: MockEngine, botId: string, o: Parameters<AtWorkLevers["start"]>[1]): string {
  const bot = mock.bot(botId);
  const parent = o.parent ? mock.helperItem(o.parent) : undefined;
  let threadId = parent?.helperThreadId ?? bot.mainThreadId;
  if (!parent && o.inRun) {
    threadId = `run-atwork-${mock.nextId++}`;
    mock.threads.set(threadId, []);
    mock.add<UserItem>(threadId, { kind: "user", from: { type: "trigger", triggerId: "atwork", label: o.inRun }, queued: false, text: "Look at what came in overnight." });
  }
  const when = o.minutes ? minutesAgo(o.minutes) : undefined;
  const helperThreadId = `helper-${mock.nextId++}`;
  mock.threads.set(helperThreadId, []);
  mock.add<UserItem>(helperThreadId, { kind: "user", from: { type: "bot", botId, expectsReply: true }, queued: false, text: o.title }, when);
  const item = mock.add<HelperItem>(threadId, { kind: "helper", botId, title: o.title, helperThreadId, status: "running", background: true, steps: 0, last: "Reading", ...(o.model ? { model: o.model } : {}) }, when);
  let end!: (status: HelperItem["status"]) => void;
  const ended = new Promise<HelperItem["status"]>((r) => (end = r));
  const inRun = parent ? mock.helperRuns.get(parent.id)?.inRun : o.inRun;
  mock.helperRuns.set(item.id, { botId, itemId: item.id, stopped: false, ended, end, ...(inRun ? { inRun } : {}), ...(parent ? { parentItemId: parent.id } : {}) });
  mock.putHelper(item);
  // What the bot said after starting it, as a bot does: the chat then ends with its words, and the waiting line stands under them.
  if (o.say) mock.upsert(mock.add<BotItem>(threadId, { kind: "bot", botId, streaming: false, text: o.say }, when));
  const n = mock.runningHelpers(botId);
  const busy = mock.turns.has(botId);
  mock.putBot({ ...mock.bot(botId), helpers: n, ...(busy ? {} : { state: "working", activity: waitingFor(n) }) });
  return item.id;
}

function end(mock: MockEngine, itemId: string): void {
  const run = mock.helperRuns.get(itemId);
  if (!run) return;
  mock.endHelper(run, "done", false);
  if (mock.runningHelpers(run.botId) === 0 && !mock.turns.has(run.botId)) mock.settle(run.botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
}

export function atWorkLevers(mock: MockEngine): AtWorkLevers {
  return {
    start: (botId, o) => start(mock, botId, o),
    end: (itemId) => end(mock, itemId),
    activity: (botId, words) => mock.putBot({ ...mock.bot(botId), activity: words }),
  };
}

export function seedAtWork(mock: MockEngine, n: number): void {
  const go = () => {
    start(mock, "onboardings", { title: "Sort the overnight mails", inRun: "Morning work round", model: "gpt-6.1-terra", minutes: 12 });
    start(mock, "kaja", { title: "Check the Nordvik import date", minutes: 4, say: "I asked a helper to check the import date." });
    if (n >= 5) {
      start(mock, "hubspot-tickets", { title: "Read ticket 48213", minutes: 3 });
      start(mock, "kaja", { title: "Find the Aalto report template", minutes: 2, say: "Another helper looks for the template." });
      start(mock, "inbox", { title: "List the open onboardings", minutes: 1 });
    }
  };
  // After the scene's bots are made and before the window asks for them.
  if (mock.bots.length) go();
}
