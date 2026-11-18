// Engine 0.29.0: open cards come back after a restart (docs/build/step-cards-after-restart.md).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalCard, Events, QuestionCard, UserItem } from "../../shared/protocol.js";
import { settle, setup, upserts } from "./fake.js";
import { WAITED_NOTICE } from "../core/restored-cards.js";

type World = ReturnType<typeof setup>;

/** A bot that asked a question on a card, then Pobots stopped with the card open. */
async function askedThenStopped(): Promise<{ first: World; botId: string; card: QuestionCard; asked: Promise<unknown> }> {
  const first = setup();
  const bot = first.engine.createBot("Kaja");
  first.engine.sendMessage({ botId: bot.id, text: "Go through the customers" });
  await settle();
  const s = first.sessions[0]!;
  const asked = s.tool("ask_human", { question: "Which customer first?", context: "Both wait for an import.", choices: ["Nordvik", "Aalto"] });
  await settle();
  const card = first.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
  assert.ok(card, "no card was raised");
  first.engine.shutdown();
  await settle();
  first.store.close();
  return { first, botId: bot.id, card, asked };
}

const removed = (w: World) => w.events.filter((e) => e.event === "card.removed").map((e) => (e.data as Events["card.removed"]).cardId);

describe("open cards come back after a restart", () => {
  test("a question card is kept at shutdown, without card.removed, and its turn is let go", async () => {
    const { first, card, asked } = await askedThenStopped();
    assert.deepEqual(removed(first), [], "the window was told the card left");
    await asked; // the tool call that waited on it is not left hanging
    const second = setup(first.dirs);
    const back = second.engine.snapshot().cards;
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], card, "not the same card: id, words and time");
    second.engine.shutdown();
    second.store.close();
  });

  test("the chat says the card stays open, not that the turn was cut short", async () => {
    const { first, botId } = await askedThenStopped();
    const second = setup(first.dirs);
    const texts = second.engine.readThread({ threadId: second.engine.snapshot().bots.find((b) => b.id === botId)!.mainThreadId }).items.flatMap((i) => (i.kind === "notice" ? [i.text] : []));
    assert.ok(texts.includes(WAITED_NOTICE), JSON.stringify(texts));
    assert.ok(!texts.some((t) => /cut short/.test(t)), JSON.stringify(texts));
    second.engine.shutdown();
    second.store.close();
  });

  test("after a crash with the card open, the same: the card comes back and the chat says so", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "Go through the customers" });
    await settle();
    const s = first.sessions[0]!;
    s.emit({ type: "text-start", key: "m1" });
    s.emit({ type: "text-delta", key: "m1", text: "Let me ask you first." });
    void s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    await settle();
    // A crash: the second engine starts on the database as the first left it, with no shutdown and
    // the bot's text still open. The first is only put away at the end, so nothing of it runs late.
    const second = setup(first.dirs);
    assert.equal(second.engine.snapshot().cards.filter((c) => c.kind === "question").length, 1);
    const texts = second.engine.readThread({ threadId: bot.mainThreadId }).items.flatMap((i) => (i.kind === "notice" ? [i.text] : []));
    assert.ok(texts.includes(WAITED_NOTICE), JSON.stringify(texts));
    assert.ok(!texts.some((t) => /cut short/.test(t)), JSON.stringify(texts));
    second.engine.shutdown();
    second.store.close();
    first.engine.shutdown();
    first.store.close();
  });

  test("its answer reaches the bot as a message marked with the card, and the turn gets the note", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    const choice = card.choices.find((c) => c.label === "Aalto")!;
    second.engine.resolveCard(card.id, { type: "choice", choiceId: choice.id });
    await settle();
    assert.deepEqual(removed(second), [card.id]);
    assert.equal(second.engine.snapshot().cards.length, 0);
    const msg = upserts(second.events).find((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.card);
    assert.equal(msg?.text, "Aalto");
    assert.deepEqual(msg?.from, { type: "you", card: { id: card.id, title: "Which customer first?" } });
    assert.equal(msg?.threadId, second.engine.snapshot().bots.find((b) => b.id === botId)!.mainThreadId);
    const sent = second.sessions.at(-1)!.sent[0]!;
    assert.equal(sent.text, "Aalto");
    const note = sent.before.find((b) => b.includes("before Pobots restarted"));
    assert.ok(note, `no note: ${JSON.stringify(sent.before)}`);
    assert.match(note, /The question: Which customer first\?/);
    assert.match(note, /Its context: Both wait for an import\./);
    assert.match(note, /The choices were: Nordvik; Aalto/);
    // The note was used once and is gone.
    assert.equal(second.store.getValue(`card-answer:${msg!.id}`), undefined);
    second.engine.shutdown();
    second.store.close();
  });

  test("while the bot works the answer waits in line, and it cannot be taken back", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.sendMessage({ botId, text: "Something else first" });
    await settle();
    second.engine.resolveCard(card.id, { type: "text", text: "Nordvik, then Aalto" });
    await settle();
    const msg = upserts(second.events).find((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.card)!;
    assert.equal(msg.queued, true);
    assert.throws(() => second.engine.unqueue({ botId, itemId: msg.id }), /cannot be taken back/);
    second.sessions[0]!.reply("Done with that");
    await settle();
    const sent = second.sessions.at(-1)!.sent.at(-1)!;
    assert.equal(sent.text, "Nordvik, then Aalto");
    assert.ok(sent.before.some((b) => /The question: Which customer first\?/.test(b)));
    second.engine.shutdown();
    second.store.close();
  });

  test("Steer now on a waiting answer takes its note into the turn with it, once", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.sendMessage({ botId, text: "Something else first" });
    await settle();
    const s = second.sessions[0]!;
    const got: { text: string; id: string }[] = [];
    (s as unknown as { steer(text: string, o: { id: string }): Promise<boolean> }).steer = async (text, o) => (got.push({ text, id: o.id }), true);
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "thinking" });
    second.engine.resolveCard(card.id, { type: "text", text: "Nordvik" });
    await settle();
    const msg = upserts(second.events).find((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.card)!;
    assert.equal(msg.queued, true, "it steered in by itself");
    second.engine.steerQueued({ botId, itemId: msg.id });
    await settle();
    assert.equal(got.length, 1);
    assert.match(got[0]!.text, /The question: Which customer first\?[\s\S]*\n\nNordvik$/);
    assert.equal(second.store.getValue(`card-answer:${msg.id}`), undefined);
    second.engine.shutdown();
    second.store.close();
  });

  test("the waiting answer and its note survive another restart", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.sendMessage({ botId, text: "Something else first" });
    await settle();
    second.engine.resolveCard(card.id, { type: "text", text: "Nordvik" });
    await settle();
    second.engine.shutdown();
    second.store.close();
    const third = setup(first.dirs);
    await settle();
    await settle();
    const sent = third.sessions.flatMap((s) => s.sent).find((x) => x.text === "Nordvik");
    assert.ok(sent, "the answer was not sent after the second restart");
    assert.ok(sent.before.some((b) => /The question: Which customer first\?/.test(b)));
    third.engine.shutdown();
    third.store.close();
  });

  test("Dismiss starts no turn: the bot hears it at its next turn", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.resolveCard(card.id, { type: "deny" });
    await settle();
    assert.equal(second.sessions.length, 0, "a turn was started");
    second.engine.sendMessage({ botId, text: "Hi again" });
    await settle();
    const before = second.sessions[0]!.sent[0]!.before.join("\n");
    assert.match(before, /before Pobots restarted, you asked the person "Which customer first\?" on a card\. They dismissed it/);
    second.engine.shutdown();
    second.store.close();
  });

  test("an approved approval is not run: the bot is told, and its same repeat goes through once without a card", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    await first.engine.updateBot({ botId: bot.id, patch: { access: "asks-first" } });
    first.engine.sendMessage({ botId: bot.id, text: "Clean up" });
    await settle();
    void first.sessions[0]!.ask("Bash", { command: "ls -la" });
    await settle();
    const card = first.engine.snapshot().cards.find((c): c is ApprovalCard => c.kind === "approval")!;
    first.engine.shutdown();
    await settle();
    first.store.close();

    const second = setup(first.dirs);
    assert.deepEqual(second.engine.snapshot().cards, [card]);
    second.engine.resolveCard(card.id, { type: "allow-once" });
    await settle();
    const s = second.sessions.at(-1)!;
    assert.equal(s.sent[0]!.text, "Approved");
    const note = s.sent[0]!.before.find((b) => b.includes("approval card"))!;
    assert.match(note, /It has not been done/);
    assert.ok(note.includes(card.title) && note.includes(card.detail), note);
    // The same request again: allowed, no card.
    const again = await s.ask("Bash", { command: "ls -la" });
    assert.equal(again?.behavior, "allow");
    assert.equal(second.events.filter((e) => e.event === "card.added").length, 0);
    // Only once: the next one asks.
    void s.ask("Bash", { command: "ls -la" });
    await settle();
    assert.equal(second.engine.snapshot().cards.length, 1);
    // Something else is never let through by it.
    second.engine.shutdown();
    second.store.close();
  });

  test("a different request after an approval still raises a card", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    await first.engine.updateBot({ botId: bot.id, patch: { access: "asks-first" } });
    first.engine.sendMessage({ botId: bot.id, text: "Clean up" });
    await settle();
    void first.sessions[0]!.ask("Bash", { command: "ls -la" });
    await settle();
    const card = first.engine.snapshot().cards[0]!;
    first.engine.shutdown();
    await settle();
    first.store.close();
    const second = setup(first.dirs);
    second.engine.resolveCard(card.id, { type: "allow-once" });
    await settle();
    void second.sessions.at(-1)!.ask("Bash", { command: "rm -rf build" });
    await settle();
    assert.equal(second.engine.snapshot().cards.length, 1);
    second.engine.shutdown();
    second.store.close();
  });

  test("an approval past its time expires at start and the bot hears it; one with time left keeps it", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.shutdown();
    const base = { kind: "approval" as const, botId: bot.id, threadId: bot.mainThreadId, at: new Date().toISOString(), detail: "ls", noAlways: true };
    first.store.addCard({ ...base, id: "late", title: "Run ls?", expiresAt: new Date(Date.now() - 1000).toISOString() });
    first.store.addCard({ ...base, id: "later", title: "Run pwd?", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    first.store.close();
    const second = setup(first.dirs);
    await new Promise((r) => setTimeout(r, 20));
    await settle();
    assert.deepEqual(second.engine.snapshot().cards.map((c) => c.id), ["later"]);
    assert.ok(second.events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).cardId === "late" && (e.data as Events["card.removed"]).reason === "expired"));
    assert.match(second.store.takeNews(bot.mainThreadId).join("\n"), /"Run ls\?" on a card\. Nobody answered in time/);
    second.engine.shutdown();
    second.store.close();
  });

  test("the card of a bot that is gone is dropped; notes come back as before", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.shutdown();
    const at = new Date().toISOString();
    first.store.addCard({ kind: "question", id: "q-gone", botId: "gone", threadId: "t-gone", at, title: "Still there?", choices: [], allowText: true });
    first.store.addCard({ kind: "note", id: "n", botId: bot.id, threadId: bot.mainThreadId, at, title: "Report sent" });
    first.store.close();
    const second = setup(first.dirs);
    assert.deepEqual(second.engine.snapshot().cards.map((c) => c.id), ["n"]);
    assert.equal(second.store.listCards().length, 1);
    second.engine.shutdown();
    second.store.close();
  });

  test("a card that came back does not hold the bot: its turns end and leave it open", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.sendMessage({ botId, text: "Hi" });
    await settle();
    second.sessions[0]!.reply("Hello");
    await settle();
    // Engine 0.31.1: at rest, it reads Waiting for you again while the card is open (core/restored-waiting.ts).
    assert.equal(second.engine.bots.get(botId)?.state, "done");
    assert.equal(second.engine.snapshot().bots.find((b) => b.id === botId)?.state, "waiting");
    assert.deepEqual(second.engine.snapshot().cards.map((c) => c.id), [card.id], "the turn's end withdrew it");
    second.engine.shutdown();
    second.store.close();
  });

  test("a helper's card goes to its bot's main chat and the note names the helper; a gone task manager's to the bot", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.shutdown();
    const at = new Date().toISOString();
    first.store.addCard({ kind: "question", id: "qh", botId: bot.id, threadId: "t-helper", at, title: "Which folder?", choices: [{ id: "0", label: "docs" }], allowText: true, helper: "Look through the docs" });
    first.store.close();
    const second = setup(first.dirs);
    second.engine.resolveCard("qh", { type: "choice", choiceId: "0" });
    await settle();
    const msg = upserts(second.events).find((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.card)!;
    assert.equal(msg.threadId, bot.mainThreadId);
    assert.match(second.sessions[0]!.sent[0]!.before.join("\n"), /Your helper "Look through the docs" asked it; Pobots stopped that helper/);
    second.engine.shutdown();
    second.store.close();
  });

  test("an answer that would become a message is refused while the bot's harness is not ready, and the card stays", async () => {
    const { first, card } = await askedThenStopped();
    const second = setup(first.dirs, undefined, undefined, { claudeReady: false });
    assert.throws(() => second.engine.resolveCard(card.id, { type: "text", text: "Nordvik" }));
    assert.deepEqual(second.engine.snapshot().cards.map((c) => c.id), [card.id]);
    second.engine.shutdown();
    second.store.close();
  });

  test("retiring the bot takes its restored card away and sends nothing", async () => {
    const { first, botId, card } = await askedThenStopped();
    const second = setup(first.dirs);
    second.engine.retireBot(botId);
    await settle();
    assert.deepEqual(removed(second), [card.id]);
    assert.equal(second.store.listCards().length, 0);
    assert.equal(second.sessions.length, 0);
    second.engine.shutdown();
    second.store.close();
  });
});
