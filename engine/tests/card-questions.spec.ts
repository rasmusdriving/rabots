// Engine 0.31.0: follow-up questions on cards (docs/build/step-card-follow-ups.md). The person asks a
// bot about one of its to-dos or question cards before he acts; the card stays open, and the bot's
// answer is kept with the card. Stand-in harness, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CardQuestion, Events, QuestionCard, Todo, UserItem } from "../../shared/protocol.js";
import { askOnCard, askOnTodo } from "../core/card-questions.js";
import { personActionBefore } from "../core/person-actions.js";
import { activityLogFor } from "../core/activity-log.js";
import { FOLLOW_UP_RULE } from "../tool-names.js";
import { settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";

type World = ReturnType<typeof setup>;
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");
const idOf = (r: { content: { text: string }[] }) => /\(id (todo_[a-z0-9]{16})\)/.exec(text(r))?.[1] ?? "";
const todoOf = (w: World, id: string): Todo => w.store.getTodo(id)!.todo;
const cardOf = (w: World, id: string) => w.engine.snapshot().cards.find((c): c is QuestionCard => c.id === id && c.kind === "question");
const questionItems = (events: Ev[]) => upserts(events).filter((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.question);

/** The bot writes a message in its running turn, as the harness streams it. */
function say(s: FakeSession, words: string, key = `m-${Math.random()}`) {
  s.emit({ type: "text-start", key });
  s.emit({ type: "text-delta", key, text: words });
  s.emit({ type: "text-full", key, text: words });
  s.emit({ type: "text-end", key });
}

function end(s: FakeSession) {
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1" });
}

async function world() {
  const w = setup();
  const bot = w.engine.createBot("Kaja");
  w.engine.sendMessage({ botId: bot.id, text: "Plan the uptime report" });
  await settle();
  const s = w.sessions.at(-1)!;
  return { ...w, bot, s };
}

/** A bot with one to-do on the list, at rest. */
async function withTodo() {
  const w = await world();
  const r = await w.s.tool("add_todo", { title: "File the uptime ticket", why: "October's report is due.", blocks: [{ type: "text", text: "Use the usual board." }], buttons: [{ id: "filed", label: "Filed it" }] });
  const todoId = idOf(r);
  assert.ok(todoId, text(r));
  w.s.reply("Added it to your list.");
  await settle();
  return { ...w, todoId };
}

describe("questions on a to-do", () => {
  test("it reaches the bot as his marked message with the note; the answer lands in the to-do, which stays open", async () => {
    const w = await withTodo();
    askOnTodo(w.engine, { todoId: w.todoId, text: "  Which board is the usual one?  " });
    await settle();
    const [item] = questionItems(w.events);
    assert.deepEqual(item?.from, { type: "you", todo: { id: w.todoId, title: "File the uptime ticket" }, question: true });
    assert.equal(item?.text, "Which board is the usual one?");
    const sent = w.s.sent.at(-1)!;
    assert.equal(sent.text, "Which board is the usual one?");
    const note = sent.before.find((b) => b.includes("question about your to-do"));
    assert.ok(note, JSON.stringify(sent.before));
    assert.match(note, /still open on their list and they have not acted on it yet/);
    assert.ok(note.includes(FOLLOW_UP_RULE));
    assert.ok(!sent.before.some((b) => b.includes("answer to your to-do")), "told it was an answer");
    let q = todoOf(w, w.todoId).questions![0]!;
    assert.equal(q.state, "answering");
    assert.equal(q.itemId, item!.id);

    w.s.reply("The Delivery board, column Ops.");
    await settle();
    q = todoOf(w, w.todoId).questions![0]!;
    assert.equal(q.state, "answered");
    assert.equal(q.answer, "The Delivery board, column Ops.");
    assert.ok(q.answeredAt);
    assert.equal(w.store.getTodo(w.todoId)!.status, "open");
    assert.ok(!w.events.some((e) => e.event === "todo.removed"));
    const changed = (w.events.filter((e) => e.event === "todo.changed").at(-1)!.data as Events["todo.changed"]).todo;
    assert.equal(changed.questions?.[0]?.state, "answered", "the window was not told");
    w.engine.shutdown();
    w.store.close();
  });

  test("while the bot works it waits in line (queued), never steers in; a second question keeps the order", async () => {
    const w = await withTodo();
    w.engine.sendMessage({ botId: w.bot.id, text: "Something else first" });
    await settle();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Is it urgent?" });
    await settle();
    assert.equal(todoOf(w, w.todoId).questions![0]!.state, "queued");
    assert.equal(questionItems(w.events)[0]!.queued, true);
    assert.throws(() => askOnTodo(w.engine, { todoId: w.todoId, text: "And who reads it?" }), /Wait for the answer/);
    assert.throws(() => w.engine.unqueue({ botId: w.bot.id, itemId: questionItems(w.events)[0]!.id }), /cannot be taken back/);
    w.s.reply("Done with that.");
    await settle();
    assert.equal(todoOf(w, w.todoId).questions![0]!.state, "answering");
    w.s.reply("Not urgent, by Friday.");
    await settle();
    askOnTodo(w.engine, { todoId: w.todoId, text: "And who reads it?" });
    await settle();
    w.s.reply("The customer's IT lead.");
    await settle();
    const qs = todoOf(w, w.todoId).questions!;
    assert.deepEqual(
      qs.map((q) => [q.text, q.state, q.answer]),
      [
        ["Is it urgent?", "answered", "Not urgent, by Friday."],
        ["And who reads it?", "answered", "The customer's IT lead."],
      ],
    );
    w.engine.shutdown();
    w.store.close();
  });

  test("the bot may change the to-do in its answer; the thread stays; an answer by button still works as before", async () => {
    const w = await withTodo();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Which board?" });
    await settle();
    const r = await w.s.tool("update_todo", { id: w.todoId, why: "October's report is due; use the Delivery board." });
    assert.match(text(r), /Changed/);
    w.s.reply("The Delivery board. I put it in the to-do.");
    await settle();
    const todo = todoOf(w, w.todoId);
    assert.equal(todo.why, "October's report is due; use the Delivery board.");
    assert.equal(todo.questions?.[0]?.answer, "The Delivery board. I put it in the to-do.");
    w.engine.answerTodo({ todoId: w.todoId, buttonId: "filed" });
    await settle();
    assert.equal(w.store.getTodo(w.todoId)!.status, "answered");
    const sent = w.s.sent.at(-1)!;
    assert.ok(sent.before.some((b) => b.includes("answer to your to-do")), JSON.stringify(sent.before));
    w.engine.shutdown();
    w.store.close();
  });

  test("an empty question, one on a closed to-do, or too long is refused", async () => {
    const w = await withTodo();
    assert.throws(() => askOnTodo(w.engine, { todoId: w.todoId, text: "   " }), /Write a question first/);
    assert.throws(() => askOnTodo(w.engine, { todoId: w.todoId, text: "x".repeat(2001) }), /under 2,000/);
    w.engine.closeTodo({ todoId: w.todoId, how: "done" });
    assert.throws(() => askOnTodo(w.engine, { todoId: w.todoId, text: "Still there?" }), /no longer on your list/);
    w.engine.shutdown();
    w.store.close();
  });

  test("the thread survives a restart: an answered one stays, one being answered has no answer coming, one in line still waits", async () => {
    const w = await withTodo();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Which board?" });
    await settle();
    w.s.reply("Delivery.");
    await settle();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Who reads it?" });
    await settle();
    // Cut short while it is answered.
    w.engine.shutdown();
    await settle();
    w.store.close();
    const second = setup(w.dirs);
    const qs = second.store.getTodo(w.todoId)!.todo.questions!;
    assert.deepEqual(qs.map((q: CardQuestion) => q.state), ["answered", "unanswered"]);
    assert.equal(qs[0]!.answer, "Delivery.");
    assert.deepEqual(second.engine.snapshot().todos.find((t) => t.id === w.todoId)?.questions?.map((q) => q.state), ["answered", "unanswered"]);
    second.engine.shutdown();
    second.store.close();
  });

  test("a question still in line at a restart waits on, and is answered after the start", async () => {
    const w = await withTodo();
    w.engine.sendMessage({ botId: w.bot.id, text: "Something else first" });
    await settle();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Is it urgent?" });
    await settle();
    w.engine.shutdown();
    await settle();
    w.store.close();
    const second = setup(w.dirs);
    assert.equal(second.store.getTodo(w.todoId)!.todo.questions![0]!.state, "queued");
    await settle();
    // The turn that ran was cut short by the stop; the question that waited runs after the start.
    const s = second.sessions.at(-1)!;
    assert.equal(s.sent.at(-1)?.text, "Is it urgent?");
    assert.equal(second.store.getTodo(w.todoId)!.todo.questions![0]!.state, "answering");
    s.reply("Not urgent.");
    await settle();
    const q = second.store.getTodo(w.todoId)!.todo.questions![0]!;
    assert.equal(q.state, "answered");
    assert.equal(q.answer, "Not urgent.");
    second.engine.shutdown();
    second.store.close();
  });
});

describe("questions on a question card (ask_human)", () => {
  test("the waiting call returns his question; the card stays; the next ask takes its place with the answer", async () => {
    const w = await world();
    const asked = w.s.tool("ask_human", { question: "Which customer first?", context: "Both wait for an import.", choices: ["Nordvik", "Aalto"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    askOnCard(w.engine, { cardId: card.id, text: "How big is each import?" });
    await settle();
    const r = await asked;
    assert.match(text(r), /^The person asks before answering: How big is each import\?/);
    assert.match(text(r), /call ask_human again/);
    assert.match(text(r), /Your new card takes this card's place\./);
    assert.deepEqual(cardOf(w, card.id)?.questions?.map((q) => q.state), ["answering"]);
    assert.ok(!w.events.some((e) => e.event === "card.removed"), "the card left the rail");
    // His question stands in the chat of the card's thread, once, as part of the running turn; it
    // is not queued as a message too (the bot already has it from the call).
    const shown = questionItems(w.events);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.text, "How big is each import?");
    assert.equal(shown[0]!.threadId, card.threadId);
    assert.equal(shown[0]!.queued, false);
    assert.equal(shown[0]!.steered, true);
    assert.equal(shown[0]!.from.type === "you" && shown[0]!.from.card?.id, card.id);

    say(w.s, "Nordvik is two files, Aalto is twelve.");
    const added = w.events.filter((e) => e.event === "card.added").length;
    const again = w.s.tool("ask_human", { question: "Which customer first, knowing that?", choices: ["Nordvik", "Aalto"] });
    await settle();
    assert.equal(w.events.filter((e) => e.event === "card.added").length, added, "a second card went up");
    const changed = w.events.filter((e) => e.event === "card.changed").at(-1)!.data as Events["card.changed"];
    const next = changed.card as QuestionCard;
    assert.equal(next.id, card.id);
    assert.equal(next.at, card.at);
    assert.equal(next.title, "Which customer first, knowing that?");
    assert.equal(next.questions?.[0]?.state, "answered");
    assert.equal(next.questions?.[0]?.answer, "Nordvik is two files, Aalto is twelve.");
    assert.equal(w.engine.snapshot().cards.filter((c) => c.kind === "question").length, 1);

    w.engine.resolveCard(card.id, { type: "choice", choiceId: next.choices.find((c) => c.label === "Nordvik")!.id });
    assert.equal(text(await again), "The person chose: Nordvik");
    w.engine.shutdown();
    w.store.close();
  });

  test("a choice pressed before the bot asks again comes back at once to its next ask", async () => {
    const w = await world();
    const asked = w.s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    askOnCard(w.engine, { cardId: card.id, text: "Does it matter?" });
    await asked;
    w.engine.resolveCard(card.id, { type: "choice", choiceId: card.choices.find((c) => c.label === "Aalto")!.id });
    await settle();
    assert.equal(w.engine.snapshot().cards.length, 0);
    say(w.s, "Not much.");
    const added = w.events.filter((e) => e.event === "card.added").length;
    const r = await w.s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    assert.equal(text(r), "The person chose: Aalto");
    assert.equal(w.events.filter((e) => e.event === "card.added").length, added, "a card went up");
    w.engine.shutdown();
    w.store.close();
  });

  test("the turn ends without a new ask: the card stays, its question is answered, and his answer reaches the bot as a message", async () => {
    const w = await world();
    const asked = w.s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    askOnCard(w.engine, { cardId: card.id, text: "Does it matter?" });
    await asked;
    say(w.s, "Not much; the card is still open for your choice.");
    end(w.s);
    await settle();
    const kept = cardOf(w, card.id)!;
    assert.ok(kept, "the card left");
    assert.equal(kept.questions?.[0]?.answer, "Not much; the card is still open for your choice.");
    w.engine.resolveCard(card.id, { type: "text", text: "Aalto" });
    await settle();
    const msg = upserts(w.events).find((i): i is UserItem => i.kind === "user" && i.from.type === "you" && !!i.from.card && !i.from.question)!;
    assert.equal(msg.text, "Aalto");
    const sent = w.s.sent.at(-1)!;
    assert.equal(sent.text, "Aalto");
    assert.ok(sent.before.some((b) => b.includes("They asked you about it first")), JSON.stringify(sent.before));
    w.engine.shutdown();
    w.store.close();
  });

  test("a second question on a card, after the first was answered, goes as a message and is answered by that turn", async () => {
    const w = await world();
    const asked = w.s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    askOnCard(w.engine, { cardId: card.id, text: "Does it matter?" });
    await asked;
    say(w.s, "Not much.");
    end(w.s);
    await settle();
    askOnCard(w.engine, { cardId: card.id, text: "Which is quicker?" });
    await settle();
    const [item] = questionItems(w.events);
    assert.deepEqual(item?.from, { type: "you", card: { id: card.id, title: "Which customer first?" }, question: true });
    assert.ok(w.s.sent.at(-1)!.before.some((b) => b.includes("question about the question you put on a card")));
    w.s.reply("Nordvik.");
    await settle();
    assert.deepEqual(cardOf(w, card.id)?.questions?.map((q) => [q.state, q.answer]), [
      ["answered", "Not much."],
      ["answered", "Nordvik."],
    ]);
    w.engine.shutdown();
    w.store.close();
  });

  test("the harness's own question tool is refused with his question, and the next ask takes the place", async () => {
    const w = await world();
    const asked = w.s.ask("AskUserQuestion", { questions: [{ question: "Which customer first?", options: [{ label: "Nordvik" }, { label: "Aalto" }] }] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    askOnCard(w.engine, { cardId: card.id, text: "Does it matter?" });
    const r = (await asked) as { behavior: string; message?: string };
    assert.equal(r.behavior, "deny");
    assert.match(r.message ?? "", /^The person asks before answering: Does it matter\?/);
    assert.match(r.message ?? "", /AskUserQuestion again/);
    assert.ok(cardOf(w, card.id));
    w.engine.shutdown();
    w.store.close();
  });

  test("an approval card does not take questions", async () => {
    const w = await world();
    void w.s.ask("Bash", { command: "ls", description: "List files" });
    await settle();
    const card = w.engine.snapshot().cards.find((c) => c.kind === "approval");
    if (card) assert.throws(() => askOnCard(w.engine, { cardId: card.id, text: "Why?" }), /does not take questions/);
    assert.throws(() => askOnCard(w.engine, { cardId: "nope", text: "Why?" }), /no longer open/);
    w.engine.shutdown();
    w.store.close();
  });

  test("a card that came back after a restart: the question goes as a message", async () => {
    const w = await world();
    void w.s.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    w.engine.shutdown();
    await settle();
    w.store.close();
    const second = setup(w.dirs);
    askOnCard(second.engine, { cardId: card.id, text: "Does it matter?" });
    await settle();
    const [item] = questionItems(second.events);
    assert.equal(item?.text, "Does it matter?");
    const s = second.sessions.at(-1)!;
    s.reply("Not much.");
    await settle();
    assert.equal(cardOf(second, card.id)?.questions?.[0]?.answer, "Not much.");
    second.engine.shutdown();
    second.store.close();
  });
});

describe("questions on a task manager's cards", () => {
  async function managerWorld() {
    const w = setup();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.sendMessage({ botId: bot.id, text: "Build the page" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "bot-sess" });
    s.emit({ type: "turn-start", own: true });
    const before = w.sessions.length;
    await s.tool("start_task_manager", { title: "Build the booking page", task: "Build it.", model: "claude-haiku-5-5", effort: "low", tools: ["ask_human", "todos"] });
    await settle();
    assert.ok(w.sessions.length > before, "no task manager session");
    const m = w.sessions.at(-1)!;
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    return { ...w, bot, s, m };
  }

  test("its waiting ask_human returns his question; its next ask takes the place with its answer", async () => {
    const w = await managerWorld();
    const asked = w.m.tool("ask_human", { question: "Which colour?", choices: ["Blue", "Green"] });
    await settle();
    const card = w.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
    assert.equal(card.taskManager, "Build the booking page");
    askOnCard(w.engine, { cardId: card.id, text: "What does the logo use?" });
    assert.match(text(await asked), /^The person asks before answering: What does the logo use\?/);
    const shown = questionItems(w.events);
    assert.equal(shown.length, 1, "his question is in the task manager's thread once");
    assert.equal(shown[0]!.threadId, card.threadId);
    say(w.m, "The logo is blue.");
    await settle();
    const again = w.m.tool("ask_human", { question: "Which colour, then?", choices: ["Blue", "Green"] });
    await settle();
    const next = cardOf(w, card.id)!;
    assert.equal(next.title, "Which colour, then?");
    assert.equal(next.questions?.[0]?.answer, "The logo is blue.");
    w.engine.resolveCard(card.id, { type: "choice", choiceId: "0" });
    assert.equal(text(await again), "The person chose: Blue");
    w.engine.shutdown();
    w.store.close();
  });

  test("a question on its to-do goes to it, and its turn's last message is the answer", async () => {
    const w = await managerWorld();
    const r = await w.m.tool("add_todo", { title: "Pick a font", blocks: [{ type: "text", text: "Two options." }], buttons: [{ id: "a", label: "Serif" }] });
    const todoId = idOf(r);
    w.m.reply("Added.");
    await settle();
    askOnTodo(w.engine, { todoId, text: "Which reads better on phones?" });
    await settle();
    // It rested with its session closed: the question starts a turn in a new one.
    const m2 = w.sessions.at(-1)!;
    assert.match(m2.sent.at(-1)!.text, /The person asks about your to-do "Pick a font"/);
    assert.match(m2.sent.at(-1)!.text, /Which reads better on phones\?$/);
    assert.equal(todoOf(w, todoId).questions![0]!.state, "answering");
    m2.reply("The sans one, at small sizes.");
    await settle();
    assert.equal(todoOf(w, todoId).questions![0]!.answer, "The sans one, at small sizes.");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("questions on cards in the activity log", () => {
  test("a question is one of his actions: labels only, never the text", async () => {
    const w = await withTodo();
    const row = personActionBefore(w.engine, "todo.ask", { todoId: w.todoId, text: "SECRET-QUESTION" }, "phone")!;
    assert.equal(row.kind, "question");
    assert.equal(row.what, "the to-do File the uptime ticket");
    assert.ok(!JSON.stringify(row).includes("SECRET-QUESTION"));
    w.store.activity.addPersonAction(row);
    askOnTodo(w.engine, { todoId: w.todoId, text: "SECRET-QUESTION" });
    await settle();
    const out = text(activityLogFor(w.engine, {}));
    assert.match(out, /asked Kaja about the to-do File the uptime ticket, from the phone/);
    assert.ok(!out.includes("SECRET-QUESTION"), out);
    assert.ok(!/to-do of Kaja answered/.test(out), "the question counted as an answer");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("a waiting question steered in", () => {
  test("Steer now takes it into the running turn with its note, and that turn answers it", async () => {
    const w = await withTodo();
    w.engine.sendMessage({ botId: w.bot.id, text: "Something else first" });
    await settle();
    askOnTodo(w.engine, { todoId: w.todoId, text: "Is it urgent?" });
    await settle();
    const item = questionItems(w.events)[0]!;
    const got: string[] = [];
    (w.s as unknown as { steer(text: string, o: { id: string }): Promise<boolean> }).steer = async (text) => (got.push(text), true);
    w.s.emit({ type: "session", sessionId: "sess-1" });
    w.s.emit({ type: "turn-start", own: true });
    w.s.emit({ type: "thinking" });
    const r = w.engine.steerQueued({ botId: w.bot.id, itemId: item.id });
    assert.equal(r.steered, true);
    await settle();
    assert.match(got[0] ?? "", /question about your to-do "File the uptime ticket"[\s\S]*Is it urgent\?$/);
    assert.equal(todoOf(w, w.todoId).questions![0]!.state, "answering");
    w.s.reply("Not urgent.");
    await settle();
    assert.equal(todoOf(w, w.todoId).questions![0]!.answer, "Not urgent.");
    w.engine.shutdown();
    w.store.close();
  });
});
