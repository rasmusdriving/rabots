// Engine 0.31.2: a turn that begins by itself keeps the answer before it (&lostreply=1, the window
// check's section "lost-reply", docs/build/step-lost-reply.md). On 17 Nov 2026 Developer answered a
// question at length, a command of its turn still ran in the background, and when that command ended
// the harness began a turn by itself with a short reply. The window drew both turns as one answer, and
// the long answer folded away into "Worked for". Here Onboardings' chat holds that shape as stored,
// and a message that asks for a check in the background plays it live: the turn answers, works in
// the background, and a turn with no message begins and says something short.
import type { ActivityItem, Bot, BotItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { later, minutesAgo, type Turn } from "./mock-data";

export const LOST_BOT = "onboardings";
export const LOST_QUESTION = "Why did the import for Nordvik stop last night?";
export const LOST_ANSWER =
  "The import stopped because the file from Nordvik had a new column for the department code. The mapping did not know it, so every row after the first was set aside. I added the column to the mapping and ran the import again for the rows that were set aside. All 412 people are in now. Nothing else in last night's run changed.";
export const LOST_LATER = "Nothing has changed. That notice was about the check I started earlier; it ended on its own.";
/** A message with these words to Onboardings plays the live turns. */
export const LOST_ASK = /in the background/i;
export const LIVE_ANSWER = "The check runs in the background. The mapping looks right so far, and I tell you what it finds.";
export const LIVE_LATER = "The check has finished. All rows passed.";

/** The bot as the engine sends it: the turn that runs now in its main chat (Bot.turnId, engine 0.31.2). */
export function withLiveTurn(mock: MockEngine, bot: Bot): Bot {
  const { turnId: _was, ...rest } = bot;
  const t = mock.turns.get(bot.id);
  return t?.id && !t.stopped && t.threadId === bot.mainThreadId ? { ...rest, turnId: t.id } : rest;
}

/** The stored shape of 17 Nov: the question, its turn's work and long answer, then a turn no message started. */
export function seedLostReply(mock: MockEngine): void {
  const bot = mock.bots.find((b) => b.id === LOST_BOT);
  if (!bot) return;
  const t = bot.mainThreadId;
  const a = "tt-lost-a";
  const b = "tt-lost-b";
  const step = (turnId: string, label: string, m: number, extra: Partial<ActivityItem> = {}) =>
    mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId, label, status: "done", durationMs: 6_000, ...extra }, minutesAgo(m));
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: a, text: LOST_QUESTION }, minutesAgo(52));
  step(a, "Read the import log", 51);
  step(a, "Ran a command in the background", 50, { detail: "node scripts/check-import.mjs --watch" });
  step(a, "Read mapping/nordvik.json", 49);
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: a, text: "The log shows the rows were set aside. I look at the mapping next." }, minutesAgo(48));
  step(a, "Edited mapping/nordvik.json", 47);
  step(a, "Ran the import again", 46);
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: a, text: LOST_ANSWER }, minutesAgo(45));
  step(b, "The background check ended", 16, { durationMs: 0 });
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: b, text: LOST_LATER }, minutesAgo(15));
}

/**
 * The live turns: the message's turn starts a check in the background and answers; the bot then
 * works in the background with no turn running; after a moment a turn with no message begins, thinks,
 * works and says something short; then the bot is done. With "later" in the message the bot rests
 * in between instead (its answer folds), as when a helper's result is told in a turn of its own.
 */
export async function runLostReplyTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const bot = mock.bot(botId);
  const threadId = bot.mainThreadId;
  const pace = Number(mock.flags.get("lostpace") ?? "1");
  const wait = (ms: number) => later(ms * pace);
  const a: Turn = { botId, threadId, stopped: false, id: `turn${mock.nextId++}` };
  mock.turns.set(botId, a);
  mock.replace({ ...message, queued: false, turnId: a.id });
  mock.setState(botId, "thinking", "Thinking about your message");
  await wait(600);
  const check = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId: a.id, label: "Ran a command in the background", detail: "node scripts/check-import.mjs --watch", status: "done", durationMs: 400 });
  mock.upsert(check);
  mock.setState(botId, "working", "Running a command");
  await wait(500);
  const said = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId: a.id, text: LIVE_ANSWER, streaming: false });
  mock.upsert(said);
  mock.turns.delete(botId);
  // Between the turns: no turn runs, the command still works in the background (or the bot rests).
  if (/later/i.test(message.text)) mock.setState(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  else mock.setState(botId, "working", "Working in the background");
  await wait(Number(mock.flags.get("lostgap") ?? "2500"));
  if (!mock.bots.some((x) => x.id === botId)) return;

  // The command ended; the harness begins a turn by itself. It has no message.
  const b: Turn = { botId, threadId, stopped: false, id: `turn${mock.nextId++}` };
  mock.turns.set(botId, b);
  mock.setState(botId, "thinking", "Thinking");
  await wait(1200);
  const thought = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId: b.id, label: "The background check ended", status: "done", durationMs: 0, tool: "think" });
  mock.upsert(thought);
  await wait(700);
  const read = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId: b.id, label: "Read the check's output", status: "running" });
  mock.upsert(read);
  mock.setState(botId, "working", "Reading the check's output");
  await wait(700);
  mock.replace({ ...read, status: "done", durationMs: 700 });
  await wait(300);
  const last = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId: b.id, text: LIVE_LATER, streaming: false });
  mock.upsert(last);
  mock.turns.delete(botId);
  mock.setState(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
}
