// Protocol 23: the stand-in engine's follow-up questions on cards (docs/build/step-card-follow-ups.md).
// "todo.ask" and "card.ask" as the engine does them: the question is kept with the to-do or card,
// his message goes to the bot's chat marked "Question on your to-do / card", and after a moment the
// bot's answer lands in the card and in the chat. While the bot works, the question waits (queued).
//
// Levers on window.pobotsCardQuestions: hold(true) keeps the next answers waiting (to look at the
// waiting line), hold(false) lets them come; answerNow() answers what waits at once; reask(cardId,
// title) has the bot ask again in the card's place (same id and spot, new words), as after a
// question on an ask_human card; asked() lists what was asked; askedTurn(botName) puts a finished turn in
// the bot's chat where his question went into its waiting ask_human, as the engine leaves it.
import type { ActivityItem, BotItem, Card, CardQuestion, Methods, QuestionCard, Todo, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { EngineError } from "./types";

export interface CardQuestionLevers {
  hold(on: boolean): void;
  answerNow(): void;
  reask(cardId: string, title: string): void;
  asked(): { kind: "todo" | "card"; id: string; text: string }[];
  askedTurn(botName: string): void;
  /** The next question is refused with these words, as the engine refuses one on a card that just closed. */
  refuseNext(message: string): void;
}

/** The words of the finished turn askedTurn() puts in the chat. */
export const ASKED_TURN = {
  question: "Does the customer mind a Thursday?",
  answer: "No, Thursday suits them: their week starts on Wednesday.",
  final: "Thursday it is. I have put it in the plan.",
} as const;

declare global {
  interface Window {
    pobotsCardQuestions?: CardQuestionLevers;
  }
}

type Target = { kind: "todo" | "card"; id: string };

/** How long the stand-in bot takes to answer. */
const ANSWER_MS = 1200;

const answerFor = (text: string) =>
  /urgent|when/i.test(text)
    ? "Not urgent. Friday is fine, the customer reads it on Monday."
    : `Good question. In short: it is the usual one, and nothing else changes. You asked: "${text.slice(0, 80)}"`;

export class MockCardQuestions {
  private holding = false;
  private waiting: { target: Target; qid: string; botId: string; text: string; item: UserItem }[] = [];
  private log: { kind: "todo" | "card"; id: string; text: string }[] = [];
  private n = 1;
  private refusal: string | undefined;

  constructor(private mock: MockEngine) {
    window.pobotsCardQuestions = {
      hold: (on) => {
        this.holding = on;
        if (!on) for (const id of new Set(this.waiting.map((w) => w.botId))) this.answer(this.waiting.find((w) => w.botId === id)!.qid);
      },
      answerNow: () => this.answerAll(),
      reask: (cardId, title) => this.reask(cardId, title),
      asked: () => structuredClone(this.log),
      askedTurn: (botName) => this.askedTurn(botName),
      refuseNext: (message) => {
        this.refusal = message;
      },
    };
  }

  readonly handlers: { "todo.ask": (p: Methods["todo.ask"]["params"]) => Methods["todo.ask"]["result"]; "card.ask": (p: Methods["card.ask"]["params"]) => Methods["card.ask"]["result"] } = {
    "todo.ask": (p) => {
      const todo = window.pobotsTodos?.list().find((t) => t.id === p.todoId);
      if (!todo) throw new EngineError({ code: "not_found", message: "This to-do is no longer on your list." });
      this.ask({ kind: "todo", id: todo.id }, todo.botId, todo.title, p.text);
      return {};
    },
    "card.ask": (p) => {
      const card = this.mock.cards.find((c) => c.id === p.cardId);
      if (!card) throw new EngineError({ code: "not_found", message: "That card is no longer open." });
      if (card.kind !== "question" || card.helper) throw new EngineError({ code: "bad_request", message: "This card does not take questions." });
      this.ask({ kind: "card", id: card.id }, card.botId, card.title, p.text);
      return {};
    },
  };

  private ask(target: Target, botId: string, title: string, raw: string): void {
    if (this.refusal) {
      const message = this.refusal;
      this.refusal = undefined;
      throw new EngineError({ code: "not_found", message });
    }
    const text = raw.trim();
    if (!text) throw new EngineError({ code: "bad_request", message: "Write a question first." });
    const bot = this.mock.bot(botId);
    const alreadyWaiting = this.waiting.some((w) => w.botId === botId);
    const busy = this.mock.turns.has(botId) || alreadyWaiting;
    const from: UserItem["from"] = { type: "you", ...(target.kind === "todo" ? { todo: { id: target.id, title } } : { card: { id: target.id, title } }), question: true };
    const item = this.mock.add<UserItem>(bot.mainThreadId, { kind: "user", from, queued: busy, text });
    this.mock.upsert(item);
    const qid = `cq_mock${this.n++}`;
    this.write(target, (qs) => [...qs, { id: qid, at: new Date().toISOString(), text, state: busy ? "queued" : "answering", itemId: item.id }]);
    this.log.push({ ...target, text });
    this.waiting.push({ target, qid, botId, text, item });
    if (!this.holding && !alreadyWaiting) setTimeout(() => this.answer(qid), ANSWER_MS);
  }

  private answerAll(): void {
    for (const w of [...this.waiting]) this.answer(w.qid);
  }

  private answer(qid: string): void {
    if (this.holding) return;
    const w = this.waiting.find((x) => x.qid === qid);
    if (!w) return;
    this.waiting = this.waiting.filter((x) => x !== w);
    if (w.item.queued) this.mock.upsert({ ...w.item, queued: false });
    const said = answerFor(w.text);
    const bot = this.mock.bot(w.botId);
    this.mock.upsert(this.mock.add<BotItem>(bot.mainThreadId, { kind: "bot", botId: w.botId, streaming: false, text: said }));
    this.write(w.target, (qs) => qs.map((q) => (q.id === qid ? { ...q, state: "answered", answer: said, answeredAt: new Date().toISOString() } : q)));
    const next = this.waiting.find((entry) => entry.botId === w.botId);
    if (next) {
      this.write(next.target, (qs) => qs.map((q) => q.id === next.qid ? { ...q, state: "answering" } : q));
      setTimeout(() => this.answer(next.qid), ANSWER_MS);
    }
  }

  private reask(cardId: string, title: string): void {
    const at = this.mock.cards.findIndex((c) => c.id === cardId);
    const old = this.mock.cards[at];
    if (!old || old.kind !== "question") return;
    const card: QuestionCard = { ...old, title };
    this.mock.cards[at] = card;
    this.mock.emit({ event: "card.changed", data: { card: structuredClone(card) } });
  }

  /** A finished turn: the bot asked, he asked back from the card, it answered him, asked again, and he chose. */
  private askedTurn(botName: string): void {
    const bot = this.mock.bots.find((b) => b.name === botName);
    if (!bot) return;
    const t = bot.mainThreadId;
    const turnId = `tt-asked-${this.n++}`;
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const add = <T extends UserItem | BotItem | ActivityItem>(item: Omit<T, "id" | "threadId" | "seq" | "at">, s: number) => this.mock.upsert(this.mock.add<T>(t, item, at(s)));
    const card = { id: "c-asked", title: "Which day for the kickoff?" };
    add<UserItem>({ kind: "user", from: { type: "you" }, queued: false, turnId, text: "Ask me which day suits the kickoff." }, 90);
    add<ActivityItem>({ kind: "activity", botId: bot.id, turnId, label: "Asked you a question", status: "done", durationMs: 20_000 }, 80);
    add<UserItem>({ kind: "user", from: { type: "you", card, question: true }, queued: false, steered: true, turnId, text: ASKED_TURN.question }, 60);
    add<BotItem>({ kind: "bot", botId: bot.id, streaming: false, turnId, text: ASKED_TURN.answer }, 55);
    add<ActivityItem>({ kind: "activity", botId: bot.id, turnId, label: "Asked you a question", status: "done", durationMs: 30_000 }, 50);
    add<BotItem>({ kind: "bot", botId: bot.id, streaming: false, turnId, text: ASKED_TURN.final }, 10);
  }

  private write(t: Target, change: (qs: CardQuestion[]) => CardQuestion[]): void {
    if (t.kind === "todo") {
      const todo: Todo | undefined = window.pobotsTodos?.list().find((x) => x.id === t.id);
      if (todo) window.pobotsTodos!.change(t.id, { questions: change(todo.questions ?? []) });
      return;
    }
    const at = this.mock.cards.findIndex((c) => c.id === t.id);
    const old: Card | undefined = this.mock.cards[at];
    if (!old || old.kind !== "question") return;
    const card: QuestionCard = { ...old, questions: change(old.questions ?? []) };
    this.mock.cards[at] = card;
    this.mock.emit({ event: "card.changed", data: { card: structuredClone(card) } });
  }
}
