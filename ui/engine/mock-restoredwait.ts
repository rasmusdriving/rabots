// Engine 0.31.1: a bot with a restored card reads Waiting for you (&restoredwait=1, the window check's
// section "restored-waiting"). HubSpot tickets is at rest with a question card that came back after
// a restart: it reads "waiting" with `atRest`, as the engine shows it (engine/core/restored-waiting.ts).
// A message to it starts a turn at once (Working wins), and when that ends it reads Waiting again.
// Answering the card starts a turn straight from Waiting (no Idle in between); "Later" goes to Idle.
import type { Bot, BotState, Card, CardDecision } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";

export const RESTORED_BOT = "hubspot-tickets";
export const RESTORED_CARD = "card-mock-restoredwait";
export const RESTORED_TITLE = "Which ticket queue should I watch first?";

interface Own {
  state: BotState;
  activity: string;
}

/**
 * Per stand-in engine: the open cards that came back after a restart (by id: its bot and kind), and
 * each bot's own state under the view. A card counts until its answer has been handed on, as in the
 * engine, so the bot goes from Waiting straight into the turn the answer starts.
 */
const kept = new WeakMap<MockEngine, { cards: Map<string, { botId: string; kind: "approval" | "question" }>; own: Map<string, Own> }>();

function of(mock: MockEngine) {
  let k = kept.get(mock);
  if (!k) kept.set(mock, (k = { cards: new Map(), own: new Map() }));
  return k;
}

/** What the window sees of a bot: the engine's rule, in the stand-in. Called for every bot sent (putBot). */
export function restWaitView(mock: MockEngine, bot: Bot): Bot {
  const k = kept.get(mock);
  if (!k) return bot;
  // A bot sent on as it was shown (a change of something else) keeps its own state underneath; a new
  // state set on it (setState spreads the shown bot) is its own.
  const { atRest, ...rest } = bot;
  const plain: Bot = atRest && rest.state === "waiting" ? { ...rest, ...(k.own.get(bot.id) ?? { state: "idle", activity: "" }) } : rest;
  k.own.set(bot.id, { state: plain.state, activity: plain.activity });
  // In a turn the state is thinking, working or waiting; "done" or "idle" is at rest (as engine/core/restored-waiting.ts).
  if (plain.state !== "idle" && plain.state !== "done") return plain;
  if ((plain.helpers ?? 0) > 0) return plain;
  const card = [...k.cards.values()].reverse().find((c) => c.botId === bot.id);
  if (!card) return plain;
  return { ...plain, state: "waiting", activity: card.kind === "approval" ? "Waiting for your approval" : "Waiting for your answer", atRest: true };
}

/** A restored card went: an answer becomes his message and starts a turn; anything else leaves the bot at rest. */
export function restWaitGone(mock: MockEngine, card: Card, decision?: CardDecision): void {
  const k = kept.get(mock);
  if (card.kind === "system" || !k?.cards.delete(card.id)) return;
  if (!mock.bots.some((b) => b.id === card.botId)) return;
  if (decision && card.kind === "question" && (decision.type === "choice" || decision.type === "text")) {
    const text = decision.type === "text" ? decision.text : (card.choices.find((c) => c.id === decision.choiceId)?.label ?? "");
    mock.todoAnswer(card.botId, text, { type: "you", card: { id: card.id, title: card.title } });
    return;
  }
  const own = k.own.get(card.botId) ?? { state: "idle", activity: "" };
  mock.setState(card.botId, own.state, own.activity);
}

export function seedRestoredWait(mock: MockEngine): void {
  const bot = mock.bots.find((b) => b.id === RESTORED_BOT);
  if (!bot) return;
  of(mock).cards.set(RESTORED_CARD, { botId: bot.id, kind: "question" });
  mock.cards = [
    ...mock.cards,
    {
      kind: "question",
      id: RESTORED_CARD,
      botId: bot.id,
      threadId: bot.mainThreadId,
      at: minutesAgo(12),
      title: RESTORED_TITLE,
      text: "Pobots restarted while I asked. Both queues have new tickets.",
      choices: [
        { id: "support", label: "Support" },
        { id: "onboarding", label: "Onboarding" },
      ],
      allowText: false,
    },
  ];
  mock.setState(bot.id, bot.state, bot.activity);
}
