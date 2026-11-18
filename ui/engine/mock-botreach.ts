// Bots reach their helpers and each other (&botreach=1, the window check's section "botreach",
// 15 Nov 2026): Kaja, the main bot, steers a message into Inbox's running turn, and Onboardings sends
// its helper more with steer_helper while the helper works. Both stand where they went in, with a
// quiet "Steered" note or "sent this while it worked".
import type { ActivityItem, BotItem, HelperItem, UserItem, WorkingHelper } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const BOT_STEER_TEXT = "Leave the HubSpot mails for now; the tickets bot has them.";
export const HELPER_STEER_TEXT = "Check Northwind first, the call is at 14:00.";

export function seedBotReach(mock: MockEngine): void {
  const inbox = mock.bots.find((b) => b.id === "inbox");
  const onb = mock.bots.find((b) => b.id === "onboardings");
  if (!inbox || !onb) return;
  // Kaja steers into the turn the person started with Inbox.
  const t = inbox.mainThreadId;
  const turnId = "ti-bot-steer";
  const step = (thread: string, botId: string, label: string, m: number, status: ActivityItem["status"] = "done", turn?: string) =>
    mock.add<ActivityItem>(thread, { kind: "activity", botId, ...(turn ? { turnId: turn } : {}), label, status, ...(status === "done" ? { durationMs: 3_000 } : {}) }, minutesAgo(m));
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId, text: "Go through this morning's mail and tell me what needs me." }, minutesAgo(14));
  step(t, inbox.id, "Read 12 new messages", 13, "done", turnId);
  mock.add<UserItem>(t, { kind: "user", from: { type: "bot", botId: "kaja", expectsReply: false }, queued: false, steered: true, turnId, text: BOT_STEER_TEXT }, minutesAgo(12));
  mock.add<BotItem>(t, { kind: "bot", botId: inbox.id, streaming: false, turnId, text: "Noted. I leave the HubSpot mails to the tickets bot." }, minutesAgo(11));
  step(t, inbox.id, "Reading the Teams messages", 1, "running", turnId);
  // Onboardings' helper, sent more while it works.
  const h = `helper-${mock.nextId++}`;
  mock.threads.set(h, []);
  mock.add<UserItem>(h, { kind: "user", from: { type: "bot", botId: onb.id, expectsReply: true }, queued: false, text: "Go through the three open onboardings and say what each one waits for. Start with Northwind, then Fabrikam, then Contoso. For each, read its notes and its last mails, and give one short line with what it waits for and from whom." }, minutesAgo(10));
  step(h, onb.id, "Read the onboarding list", 9);
  mock.add<UserItem>(h, { kind: "user", from: { type: "bot", botId: onb.id, expectsReply: false }, queued: false, steered: true, text: HELPER_STEER_TEXT }, minutesAgo(8));
  mock.add<BotItem>(h, { kind: "bot", botId: onb.id, streaming: false, text: "I start with Northwind." }, minutesAgo(7));
  step(h, onb.id, "Reading the Northwind notes", 1, "running");
  const row = mock.add<HelperItem>(onb.mainThreadId, { kind: "helper", botId: onb.id, title: "Check the open onboardings", helperThreadId: h, status: "running", background: true, steps: 2, last: "Reading the Northwind notes", model: "claude-haiku-5-5", effort: "low" }, minutesAgo(10));
  // Drawn, not run: its bot lists it as working the way the engine does (protocol 19).
  const working: WorkingHelper = { itemId: row.id, threadId: row.threadId, helperThreadId: h, title: row.title, harness: "claude", model: "claude-haiku-5-5", effort: "low", startedAt: row.at };
  mock.bots = mock.bots.map((b) => (b.id === inbox.id ? { ...b, state: "working", activity: "Reading the Teams messages" } : b.id === onb.id ? { ...b, state: "working", activity: "Waiting for a helper", helpers: 1, workingHelpers: [working] } : b));
}
