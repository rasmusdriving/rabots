// A message the person steered into a turn another bot started (&foldsteer=1, the window check's
// section "foldsteer"). On 15 Nov 2026 the person steered such a turn early, the bot read it at once, and
// yet the message stood at the very bottom of the chat: the fold took the whole turn and the message
// came after it. Here Inbox asks HubSpot tickets to read five tickets, the person steers in after the
// second, and the bot is still at work: the message must stand after the second ticket.
import type { ActivityItem, BotItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const FOLD_STEER_TEXT = "For HubSpot, sign in with SSO only.";
export const FOLD_STEER_AFTER = "Got it. I sign in with SSO and read the rest.";

export function seedFoldSteer(mock: MockEngine): void {
  const bot = mock.bots.find((b) => b.id === "hubspot-tickets");
  if (!bot) return;
  const t = bot.mainThreadId;
  const turnId = "tt-fold-steer";
  const step = (label: string, m: number, status: ActivityItem["status"] = "done") =>
    mock.add<ActivityItem>(t, { kind: "activity", botId: bot.id, turnId, label, status, ...(status === "done" ? { durationMs: 4_000 } : {}) }, minutesAgo(m));
  mock.add<UserItem>(t, { kind: "user", from: { type: "bot", botId: "inbox", expectsReply: true }, queued: false, turnId, text: "Read the five open onboarding tickets and tell me what each one waits for." }, minutesAgo(12));
  step("Read the first ticket", 11);
  step("Read the second ticket", 10);
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, steered: true, turnId, text: FOLD_STEER_TEXT }, minutesAgo(9));
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId, text: FOLD_STEER_AFTER }, minutesAgo(8));
  step("Read the third ticket", 6);
  step("Read the fourth ticket", 4);
  step("Reading the fifth ticket", 1, "running");
  mock.bots = mock.bots.map((b) => (b.id === bot.id ? { ...b, state: "working", activity: "Reading the fifth ticket" } : b));
}
