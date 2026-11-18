// Failed words for every Pobots tool (&failedwords=1, the window check's section "failedwords",
// engine 0.31.1): a refused call says it did not work and opens to the reason, alone and inside a
// group of steps, never "Changed HubSpot tickets" beside a small "Failed".
import type { ActivityItem, BotItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const FAILED_CHANGE = "Could not change HubSpot tickets";
export const FAILED_CHANGE_WHY = "HubSpot tickets has the Coding set already, so nothing would change.";
export const FAILED_TODO = "Could not add the to-do";
export const FAILED_SERVICE = "Could not use outlook email search in Microsoft 365";
export const FAILED_COMMAND = "Ran a command";
export const FAILED_TODO_WHY = "A to-do needs a short title.";

export function seedFailedWords(mock: MockEngine): void {
  const bot = mock.bots.find((b) => b.id === "onboardings");
  if (!bot) return;
  const t = bot.mainThreadId;
  const one = "tk-failed-change";
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: one, text: "Give HubSpot tickets the Coding set." }, minutesAgo(9));
  mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId: one, label: FAILED_CHANGE, status: "failed", durationMs: 1_000, detail: FAILED_CHANGE_WHY, tool: "other" }, minutesAgo(8));
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: one, text: "HubSpot tickets has the Coding set already, so there was nothing to change." }, minutesAgo(8));
  const two = "tk-failed-todo";
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: two, text: "Put the Aalto template on my to-dos." }, minutesAgo(4));
  mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId: two, label: "Looked at the to-dos", status: "done", durationMs: 1_000, tool: "other" }, minutesAgo(3));
  mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId: two, label: FAILED_TODO, status: "failed", durationMs: 1_000, detail: FAILED_TODO_WHY, tool: "other" }, minutesAgo(3));
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: two, text: "The first try had no title. I will try again with the title Aalto report template." }, minutesAgo(3));
  for (const [id, request, label, tool] of [
    ["tk-failed-service", "Search the example inbox.", FAILED_SERVICE, "other"],
    ["tk-failed-command", "Check the command result.", FAILED_COMMAND, "command"],
  ] as const) {
    mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: id, text: request }, minutesAgo(2));
    mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId: id, label, status: "failed", durationMs: 1_000, tool }, minutesAgo(1));
    mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId: id, text: "The step did not finish." }, minutesAgo(1));
  }
}
