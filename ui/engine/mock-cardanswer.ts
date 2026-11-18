// Engine 0.29.0 (protocol 22): open cards come back after a restart, and the person's answer to one
// reaches the bot as his own message, marked "From your card: <title>" (&cardanswer=1, the window
// check's section "cards-after-restart"). Kaja's chat has one such answer the bot has read and
// replied to. window.pobotsCardAnswer.answer(botId, title, text) sends another, as the engine does:
// it waits in line while the bot works and cannot be taken back.
import type { BotItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const CARD_TITLE = "Which customer should I start with?";

export interface CardAnswerLevers {
  answer(botId: string, title: string, text: string): void;
}

declare global {
  interface Window {
    pobotsCardAnswer?: CardAnswerLevers;
  }
}

export function seedCardAnswer(mock: MockEngine): void {
  const kaja = mock.bots.find((b) => b.id === "kaja");
  if (!kaja) return;
  const t = kaja.mainThreadId;
  const turnId = "tk-card-answer";
  mock.add<UserItem>(t, { kind: "user", from: { type: "you", card: { id: "card-mock-restored", title: CARD_TITLE } }, queued: false, turnId, text: "Nordvik" }, minutesAgo(4));
  mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId, text: "Thanks. I start with Nordvik and come back to Aalto after." }, minutesAgo(3));
}

export function cardAnswerLevers(mock: MockEngine): CardAnswerLevers {
  return {
    answer: (botId, title, text) => mock.todoAnswer(botId, text, { type: "you", card: { id: `card-mock-${Date.now()}`, title } }),
  };
}
