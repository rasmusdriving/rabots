// A helper row inside a fold (&helperfold=1, the window check's section "smallfixes", fix 0.26.3).
// At 360 px the row's title was cut to a few letters beside the model label. Here Inbox asks HubSpot
// tickets for a check, and the bot starts a helper on a model of its own choosing with a long label.
import type { BotItem, HelperItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const HELPER_FOLD_TITLE = "Check the open onboarding tickets";

export function seedHelperFold(mock: MockEngine): void {
  const bot = mock.bots.find((b) => b.id === "hubspot-tickets");
  if (!bot) return;
  const t = bot.mainThreadId;
  const turnId = "tt-helper-fold";
  mock.add<UserItem>(t, { kind: "user", from: { type: "bot", botId: "inbox", expectsReply: true }, queued: false, turnId, text: "Check which onboarding tickets wait for the customer." }, minutesAgo(30));
  mock.add<HelperItem>(t, { kind: "helper", botId: bot.id, turnId, title: HELPER_FOLD_TITLE, helperThreadId: "ht-helper-fold", status: "done", background: false, steps: 6, last: "Three tickets wait for the customer.", model: "gpt-6.1-terra", effort: "xhigh", fast: true, endedAt: minutesAgo(26) }, minutesAgo(29));
  mock.add<BotItem>(t, { kind: "bot", botId: bot.id, streaming: false, turnId, text: "Three of the open onboarding tickets wait for the customer." }, minutesAgo(25));
}
