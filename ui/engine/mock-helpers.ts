// The mock engine's end of a turn and its helpers: after a turn, settling a bot, streaming an answer,
// starting, running and ending a helper, a turn with helpers and the wake when a background helper
// ends. Free functions of the mock: `mock` is the MockEngine, and each keeps a one-line method there.
// Moved out of mock.ts unchanged on 15 Nov 2026 (docs/build/step-split.md).
import type { ActivityItem, BotItem, BotState, HelperItem, NoticeItem, UserItem } from "../../shared/protocol";
import { EngineError } from "./types";
import {
  at,
  later,
  type Turn,
  type HelperRun,
  type Wake,
  HELPER_STEPS,
  HELPER_RESULT,
  HELPER_FAILED,
  waitingFor,
  lastLine,
} from "./mock-data";
import type { MockEngine } from "./mock";

/** After a turn: what waited runs now, first a helper that ended meanwhile, then a queued message. */
export function afterTurn(mock: MockEngine, botId: string): void {
  if (!mock.bots.some((b) => b.id === botId) || mock.turns.has(botId)) return;
  const wake = mock.wakes.get(botId)?.shift();
  if (wake) {
    void mock.runWake(botId, wake);
    return;
  }
  const next = mock.threads.get(mock.bot(botId).mainThreadId)!.find((i): i is UserItem => i.kind === "user" && i.queued);
  if (next) void mock.runTurn(botId, next, {});
}

/**
 * The state after a turn, as the engine sets it: while helpers of the bot still work it is
 * "working" with "Waiting for a helper", never done; otherwise the state given.
 */
export function settle(mock: MockEngine, botId: string, state: BotState, activity: string): void {
  const n = mock.runningHelpers(botId);
  const bot = mock.bot(botId);
  if (n > 0) mock.putBot({ ...bot, state: "working", activity: waitingFor(n), helpers: n });
  else mock.putBot({ ...bot, state, activity, helpers: 0 });
}

export function runningHelpers(mock: MockEngine, botId: string): number {
  return [...mock.helperRuns.values()].filter((r) => r.botId === botId).length;
}

/** A changed helper row: kept in its thread and sent, and counted for the rate check. */
export function putHelper(mock: MockEngine, item: HelperItem): HelperItem {
  (mock.helperSent[item.id] ??= []).push(Math.round(performance.now()));
  mock.replace(item);
  return item;
}

export function helperItem(mock: MockEngine, itemId: string): HelperItem {
  for (const list of mock.threads.values()) {
    const found = list.find((i): i is HelperItem => i.id === itemId && i.kind === "helper");
    if (found) return found;
  }
  throw new EngineError({ code: "not_found", message: "That helper is gone." });
}

/** Streams a bot item into a thread, word by word, and returns its text. */
export async function stream(mock: MockEngine, threadId: string, botId: string, turnId: string | undefined, text: string, turn?: Turn): Promise<string> {
  let answer = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text: "", streaming: true });
  mock.upsert(answer);
  for (const textDelta of text.split(/(?<=\s)/)) {
    await later(30);
    if (turn?.stopped) break;
    answer = { ...answer, text: answer.text + textDelta };
    const list = mock.threads.get(threadId)!;
    const i = list.findIndex((x) => x.id === answer.id);
    if (i >= 0) list[i] = answer;
    mock.emit({ event: "item.delta", data: { threadId, itemId: answer.id, textDelta } });
  }
  mock.replace({ ...answer, streaming: false });
  return answer.text;
}

/**
 * Starts a helper: its row in the thread the bot works in, its own thread with the task first,
 * then its work in the background of the mock.
 */
export function startHelper(mock: MockEngine, botId: string, threadId: string, turnId: string, title: string, task: string, background: boolean, result = HELPER_RESULT, choice: Pick<HelperItem, "model" | "effort"> = {}): HelperRun {
  const helperThreadId = `helper-${mock.nextId++}`;
  mock.threads.set(helperThreadId, []);
  mock.add<UserItem>(helperThreadId, { kind: "user", from: { type: "bot", botId, expectsReply: true }, queued: false, text: task });
  const item = mock.add<HelperItem>(threadId, { kind: "helper", botId, turnId, title, helperThreadId, status: "running", background, steps: 0, ...choice });
  let end!: (status: HelperItem["status"]) => void;
  const ended = new Promise<HelperItem["status"]>((r) => (end = r));
  const run: HelperRun = { botId, itemId: item.id, stopped: false, ended, end };
  mock.helperRuns.set(item.id, run);
  mock.putHelper(item);
  mock.putBot({ ...mock.bot(botId), helpers: mock.runningHelpers(botId) });
  void mock.runHelper(run, helperThreadId, result);
  return run;
}

/** A helper at work: a few steps, each a line in its thread and a new line on its row, then its result. */
export async function runHelper(mock: MockEngine, run: HelperRun, threadId: string, done: string): Promise<void> {
  const fails = mock.helperFail;
  const steps = fails ? HELPER_STEPS.slice(0, 1) : HELPER_STEPS;
  for (const [now, past, detail] of steps) {
    await later(500);
    if (run.stopped) return;
    const step = mock.add<ActivityItem>(threadId, { kind: "activity", botId: run.botId, label: now, detail, status: "running" });
    mock.upsert(step);
    const item = mock.helperItem(run.itemId);
    mock.putHelper({ ...item, last: now, steps: item.steps + 1 });
    await later(600);
    if (run.stopped) return;
    mock.replace({ ...step, label: fails ? `Could not read ${detail}` : past, status: fails ? "failed" : "done", durationMs: 600 });
  }
  await later(400);
  if (run.stopped) return;
  const result = fails ? HELPER_FAILED : done;
  await mock.stream(threadId, run.botId, undefined, result);
  // A check can hold the helper here, its steps done and its result written, to look at the row.
  if (mock.helperHold && !run.stopped) await new Promise<void>((r) => (run.release = r));
  run.release = undefined;
  if (run.stopped) return;
  const item = mock.helperItem(run.itemId);
  mock.putHelper({ ...item, last: lastLine(result) });
  mock.endHelper(run, fails ? "failed" : "done", true);
}

/**
 * A helper ends: its row says so at once, the bot's count goes down, and a helper that worked in
 * the background wakes its bot (now, or after the turn it is in).
 */
export function endHelper(mock: MockEngine, run: HelperRun, status: HelperItem["status"], wake: boolean): void {
  if (!mock.helperRuns.has(run.itemId)) return;
  run.stopped = status === "stopped";
  mock.helperRuns.delete(run.itemId);
  run.release?.();
  const item = mock.helperItem(run.itemId);
  const ended = mock.putHelper({ ...item, status, endedAt: new Date().toISOString() });
  run.end(status);
  if (!mock.bots.some((b) => b.id === run.botId)) return;
  const busy = mock.turns.has(run.botId);
  const left = mock.runningHelpers(run.botId);
  // The count goes down at once; the words follow with the turn that comes, or right here.
  mock.putBot({ ...mock.bot(run.botId), helpers: left, ...(!busy && left > 0 ? { activity: waitingFor(left) } : {}) });
  // A helper the turn waits for: the turn goes on. Stopped with the bot: "turn.interrupt" settles it.
  if (!ended.background || !wake) return;
  (mock.wakes.get(run.botId) ?? mock.wakes.set(run.botId, []).get(run.botId)!).push({ item: ended });
  if (!busy) mock.afterTurn(run.botId);
}

/**
 * A turn the bot asked for by itself in its message ("start a helper"): the bot starts one or two
 * helpers and says so. In the background they go on after the turn; one it waits for keeps the
 * turn going until it ends.
 */
export async function runHelperTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.replace({ ...message, queued: false, turnId });
  const two = /two helpers/i.test(message.text);
  const waits = /wait for/i.test(message.text);
  // "helper on GPT": the bot gives the task to a helper on another model, as with start_helper.
  const gpt = !two && /\bon gpt\b/i.test(message.text);
  const choice: Pick<HelperItem, "model" | "effort"> = gpt ? { model: "gpt-6.1-terra", effort: "high" } : {};
  mock.setState(botId, "thinking", "Thinking about your message");
  await later(500);
  const jobs: [string, string, string][] = two
    ? [
        ["Read the open promises in the notes", "Read memory/promises.md and say which promises are still open, with their dates.", HELPER_RESULT],
        ["Check the job description for anything out of date", "Read AGENTS.md and list anything in it that no longer matches how we work. Keep it to five lines.", "AGENTS.md still names the old ticket queue. The rest matches how we work."],
      ]
    : gpt
      ? [["Try the new picker in a browser", "Open the test copy in a browser, try the model picker the way a careful person would, and say what is broken or feels wrong.", "The picker works. The two groups read well in both themes."]]
      : [["Read the notes and find what is still open", "Read AGENTS.md and the memory folder and tell me which promises are still open, with their dates. One short paragraph.", HELPER_RESULT]];
  const runs: HelperRun[] = [];
  if (!turn.stopped) {
    for (const [title, task, result] of jobs) runs.push(mock.startHelper(botId, threadId, turnId, title, task, !waits, result, choice));
    const first = jobs[0]![0];
    mock.setState(botId, "working", `A helper is working: ${first.charAt(0).toLowerCase()}${first.slice(1)}`);
    mock.putBot({ ...mock.bot(botId), helpers: mock.runningHelpers(botId) });
  }
  let said = "";
  if (waits && !turn.stopped) {
    const how = await runs[0]!.ended;
    if (!turn.stopped) {
      mock.setState(botId, "thinking", "Writing an answer");
      said = await mock.stream(threadId, botId, turnId, how === "done" ? `The helper is done. ${HELPER_RESULT}` : how === "stopped" ? "You stopped the helper, so I carried on without its result." : "The helper could not finish, so I have no answer yet.", turn);
    }
  } else if (!turn.stopped) {
    await later(300);
    said = await mock.stream(threadId, botId, turnId, two ? "I started two helpers. One reads the open promises, the other checks the job description. I will tell you what they find." : "I started a helper to read the notes. I will tell you what it finds.", turn);
  }
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.settle(botId, "idle", "Stopped by you");
  } else mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  void said;
  mock.afterTurn(botId);
}

/**
 * A turn the harness starts by itself when a helper that worked in the background ends: no
 * message starts it, it has a turn id of its own, the bot is busy for its length, and afterwards
 * the bot is done the usual way (or still waiting for other helpers).
 */
export async function runWake(mock: MockEngine, botId: string, wake: Wake): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.setState(botId, "thinking", "Reading what the helper found");
  if (mock.wakeHold) await new Promise<void>((r) => (mock.wakeRelease = r));
  mock.wakeRelease = undefined;
  await later(400);
  const text =
    wake.item.status === "done"
      ? `The helper is done. ${wake.item.last ?? HELPER_RESULT}`
      : wake.item.status === "stopped"
        ? "You stopped the helper, so I carry on without its result."
        : "The helper could not finish. The notes folder was not there. Tell me where the notes are and I will try again.";
  if (!turn.stopped) await mock.stream(threadId, botId, turnId, text, turn);
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.settle(botId, "idle", "Stopped by you");
  } else mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  mock.afterTurn(botId);
}
