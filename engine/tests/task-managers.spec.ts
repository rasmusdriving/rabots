// Task managers (engine 0.26.0, docs/build/step-task-managers.md): start, the tools it gets, its cap
// on workers, a worker's result to it, its result to the bot, the person's message, its cards, Stop,
// end and restart. Fake harnesses, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bot, Card, Events, HelperItem, UserItem } from "../../shared/protocol.js";
import { settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { endTaskManagerFrom, sendToTaskManager, stopTaskManagerFrom } from "../core/task-managers.js";

type World = ReturnType<typeof setup>;
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const lastBot = (events: Ev[], botId: string): Bot =>
  events
    .filter((e) => e.event === "bot.updated")
    .map((e) => (e.data as Events["bot.updated"]).bot)
    .filter((b) => b.id === botId)
    .at(-1)!;
const cards = (events: Ev[]): Card[] => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);

/** A bot in a turn on its fake session. */
async function inTurn(w: World, name = "Po") {
  const bot = w.engine.createBot({ name, model: "claude-haiku-5-5", access: "edits-freely" });
  w.engine.sendMessage({ botId: bot.id, text: "Build the page" });
  await settle();
  const s = w.sessions.at(-1)!;
  s.emit({ type: "session", sessionId: "bot-sess" });
  s.emit({ type: "turn-start", own: true });
  return { bot, s };
}

/** The bot starts a task manager; its row, its session and the call's answer. */
async function startManager(w: World, s: FakeSession, extra: Record<string, unknown> = {}) {
  const before = w.sessions.length;
  const answer = await s.tool("start_task_manager", { title: "Build the booking page", task: "Build and test the booking page.", model: "claude-haiku-5-5", effort: "low", ...extra });
  await settle();
  const m = w.sessions.length > before ? w.sessions.at(-1)! : undefined;
  const row = items(w.events).filter((i): i is HelperItem => i.kind === "helper" && !!i.taskManager).at(-1)!;
  return { answer, m: m!, row, id: row?.id.slice(0, 8) };
}

/** The task manager starts a worker (wait false); the worker's session. */
async function startWorker(w: World, m: FakeSession, title: string) {
  const before = w.sessions.length;
  const answer = await m.tool("start_helper", { title, task: `Do ${title}.`, model: "claude-haiku-5-5", effort: "low", wait: false });
  await settle();
  return { answer, h: w.sessions.length > before ? w.sessions.at(-1)! : undefined };
}

function finish(h: FakeSession, said: string) {
  h.emit({ type: "text-full", key: `k-${Math.random()}`, text: said });
  h.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
}

function done(w: World) {
  w.engine.shutdown();
  w.store.close();
}

describe("task managers", () => {
  test("starting one: an id at once, its row and thread, its own session with the chosen tools, and the bot not held", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { answer, m, row, id } = await startManager(w, s, { tools: ["workers", "ask_human", "todos"], max_workers: 3 });
    assert.match(text(answer), new RegExp(`^Started task manager ${id} "Build the booking page" on claude-haiku-5-5, with 3 workers at once`));
    assert.equal(row.threadId, w.engine.toBot(w.engine.bot(bot.id)).mainThreadId);
    assert.deepEqual(row.taskManager, { maxWorkers: 3, tools: ["workers", "ask_human", "todos"], mayMessage: [], state: "working" });
    assert.ok(m, "a session of its own");
    assert.equal(m.sent[0]!.text, "Build and test the booking page.");
    assert.deepEqual(m.toolNames().sort(), ["add_todo", "ask_human", "list_todos", "read_helper", "remove_todo", "start_helper", "steer_helper", "stop_helper", "update_todo"]);
    assert.match(m.settings.systemAppend ?? "", /You are a task manager started by the bot Po/);
    assert.match(m.settings.systemAppend ?? "", /at most 3 at once/);
    assert.equal(m.settings.persist, true);
    // Its thread starts with the task, from the bot.
    const first = items(w.events).find((i) => i.threadId === row.helperThreadId && i.kind === "user") as UserItem;
    assert.equal(first.text, "Build and test the booking page.");
    const b = lastBot(w.events, bot.id);
    assert.equal(b.taskManagers?.length, 1);
    assert.equal(b.taskManagers![0]!.state, "working");
    assert.equal(b.taskManagers![0]!.maxWorkers, 3);
    assert.ok(!b.helpers, "a task manager is not one of the bot's helpers");
    // Left out, the tools are the defaults and the cap is 2.
    const second = await startManager(w, s, { title: "Second" });
    const info = lastBot(w.events, bot.id).taskManagers!.at(-1)!;
    assert.equal(info.maxWorkers, 2);
    assert.deepEqual(info.tools, ["workers", "ask_human", "notify_human", "message_bot", "show_artifact"]);
    assert.ok(second.m.toolNames().includes("message_bot"));
    // Every bot is told when to use one.
    assert.match(s.settings.team, /start a task manager with start_task_manager/);
    done(w);
  });

  test("workers: a third at once is refused, results go to the task manager, and its result goes to the bot once all are done", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m, row } = await startManager(w, s);
    m.emit({ type: "session", sessionId: "tm-sess" });
    m.emit({ type: "turn-start", own: true });
    const a = await startWorker(w, m, "Part one");
    const b = await startWorker(w, m, "Part two");
    assert.ok(a.h && b.h);
    assert.match(text(a.answer), /^Started worker /);
    const third = await startWorker(w, m, "Part three");
    assert.equal(third.answer.isError, true);
    assert.match(text(third.answer), /You already have 2 workers working, the most at once for this task \(2\)/);
    assert.equal(third.h, undefined);
    // The workers' rows stand in its thread and count as its workers, not the bot's helpers.
    const workerRows = items(w.events).filter((i): i is HelperItem => i.kind === "helper" && !i.taskManager);
    assert.equal(workerRows.length, 2);
    assert.ok(workerRows.every((r) => r.threadId === row.helperThreadId));
    const now = lastBot(w.events, bot.id);
    assert.ok(!now.helpers);
    assert.equal(now.workingHelpers?.length, 2);
    assert.ok(now.workingHelpers!.every((x) => x.managerId === row.id && x.taskManager === "Build the booking page"));
    assert.equal(now.taskManagers![0]!.workersNow, 2);
    // The bot's turn ends: it is done, not waiting for anything.
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    assert.notEqual(lastBot(w.events, bot.id).activity, "Waiting for a helper");
    // Its turn ends while the workers work: it waits for them, the bot hears nothing.
    m.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    await settle();
    assert.equal(m.closed, false);
    const botSent = s.sent.length;
    // The first worker is done: its result starts a turn of the task manager.
    finish(a.h!, "Part one is built.");
    await settle();
    assert.match(m.sent.at(-1)!.text, /^Your worker .* "Part one" is done\. Its result:\n\nPart one is built\./);
    // Now the third can start.
    const c = await startWorker(w, m, "Part three");
    assert.ok(c.h);
    m.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    finish(b.h!, "Part two is built.");
    await settle();
    m.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    finish(c.h!, "Part three is built.");
    await settle();
    assert.equal(s.sent.length, botSent, "no worker's result reached the bot");
    m.emit({ type: "text-full", key: "r", text: "The booking page is built and tested." });
    m.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "tm-sess" });
    await settle();
    // All done: its result goes to the bot in a turn of its own, and it rests with its session closed.
    assert.equal(s.sent.length, botSent + 1);
    assert.match(s.sent.at(-1)!.text, /^Your task manager .* "Build the booking page" is done for now\. Its result:\n\nThe booking page is built and tested\./);
    assert.match(s.sent.at(-1)!.text, /end_task_manager id/);
    assert.equal(m.closed, true);
    const info = lastBot(w.events, bot.id).taskManagers![0]!;
    assert.equal(info.state, "resting");
    assert.equal(info.workersNow, 0);
    done(w);
  });

  test("the person writes in its thread: it resumes its session, and work the person started is not reported to the bot", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m, row } = await startManager(w, s);
    m.emit({ type: "session", sessionId: "tm-sess" });
    m.emit({ type: "text-full", key: "a", text: "Done." });
    m.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "tm-sess" });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    const botSent = s.sent.length;
    const before = w.sessions.length;
    sendToTaskManager(w.engine, { botId: bot.id, managerId: row.id, text: "Make the button blue too." });
    await settle();
    const again = w.sessions.at(-1)!;
    assert.equal(w.sessions.length, before + 1);
    assert.equal(again.settings.resume, "tm-sess");
    assert.equal(again.sent[0]!.text, "Make the button blue too.");
    const said = items(w.events).find((i) => i.threadId === row.helperThreadId && i.kind === "user" && i.text === "Make the button blue too.") as UserItem;
    assert.deepEqual(said.from, { type: "you" });
    again.emit({ type: "text-full", key: "b", text: "The button is blue." });
    again.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    await settle();
    assert.equal(s.sent.length, botSent, "the person's own work is not sent to the bot");
    // The bot sends it more with steer_helper and its id: that work is reported.
    const bs = w.sessions.find((x) => x === s)!;
    w.engine.sendMessage({ botId: bot.id, text: "Ask it for the footer too" });
    await settle();
    bs.emit({ type: "turn-start", own: true });
    const sent = await bs.tool("steer_helper", { id: row.id.slice(0, 8), text: "Add a footer." });
    assert.match(text(sent), /It was resting and starts on it now/);
    const third = w.sessions.at(-1)!;
    assert.match(third.sent[0]!.text, /^Message from Po, the bot that started you:\n\nAdd a footer\./);
    third.emit({ type: "text-full", key: "c", text: "Footer added." });
    third.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    bs.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    assert.match(bs.sent.at(-1)!.text, /is done for now\. Its result:\n\nFooter added\./);
    done(w);
  });

  test("its cards name it and never hold the bot; its question's answer comes back to it", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m, row } = await startManager(w, s);
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    const asked = m.tool("ask_human", { question: "Which colour?", choices: ["Blue", "Green"] });
    await settle();
    const card = cards(w.events).at(-1)!;
    assert.equal(card.kind, "question");
    assert.equal(card.kind === "question" && card.taskManager, "Build the booking page");
    assert.equal(card.kind === "question" && card.threadId, row.helperThreadId);
    const b = lastBot(w.events, bot.id);
    assert.notEqual(b.state, "waiting");
    assert.equal(b.taskManagers![0]!.state, "waiting");
    w.engine.resolveCard(card.id, { type: "choice", choiceId: "0" });
    assert.equal(text(await asked), "The person chose: Blue");
    await settle();
    assert.equal(lastBot(w.events, bot.id).taskManagers![0]!.state, "working");
    // A note names it too.
    await m.tool("notify_human", { title: "Halfway there" });
    const note = cards(w.events).at(-1)!;
    assert.equal(note.kind === "note" && note.taskManager, "Build the booking page");
    done(w);
  });

  test("it has exactly its bot's access: the bot's saved rules, and Always allow on its card saves the rule to the bot (fix 0.26.1)", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const rule = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }];
    const sessionRule = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }];
    w.store.addRule(bot.id, "Read(//tmp/**)");
    const { m, row } = await startManager(w, s);
    // Its session starts with the bot's saved rules.
    assert.deepEqual(m.settings.rules, ["Read(//tmp/**)"]);
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "bot-sess" });
    await settle();
    // Its card offers Always allow (no noAlways), names it and stands in its thread.
    const pending = m.ask("Bash", { command: "npm test" }, rule);
    await settle();
    const card = cards(w.events).at(-1)!;
    assert.equal(card.kind, "approval");
    assert.ok(card.kind === "approval" && !card.noAlways, "the card has no Always allow");
    assert.equal(card.kind === "approval" && card.taskManager, "Build the booking page");
    assert.equal(card.kind === "approval" && card.threadId, row.helperThreadId);
    w.engine.resolveCard(card.id, { type: "always-allow" });
    assert.deepEqual((await pending) as unknown, { behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: sessionRule });
    // Saved to the bot, said to the window, and the bot's own resting session is renewed so it has it too.
    assert.deepEqual(w.engine.listRules(bot.id).map((r) => r.detail), ["Read(//tmp/**)", "Bash(npm test:*)"]);
    assert.ok(w.events.some((e) => e.event === "rules.changed" && (e.data as { botId: string }).botId === bot.id));
    assert.equal(s.closed, true, "the bot's session kept its old rules");
    w.engine.sendMessage({ botId: bot.id, text: "Run the tests" });
    await settle();
    assert.deepEqual(w.sessions.at(-1)!.settings.rules, ["Read(//tmp/**)", "Bash(npm test:*)"]);
    // A worker of it starts with the same rules.
    m.emit({ type: "turn-start", own: true });
    const { h } = await startWorker(w, m, "Part one");
    assert.deepEqual(h!.settings.rules, ["Read(//tmp/**)", "Bash(npm test:*)"]);
    done(w);
  });

  test("a worker's Always allow saves to the bot as well, and on Codex its card has none, as a Codex bot's (fix 0.26.1)", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m } = await startManager(w, s);
    m.emit({ type: "turn-start", own: true });
    const { h } = await startWorker(w, m, "Part one");
    const rule = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" }];
    const pending = h!.ask("Bash", { command: "ls" }, rule);
    await settle();
    const card = cards(w.events).at(-1)!;
    assert.ok(card.kind === "approval" && !card.noAlways);
    w.engine.resolveCard(card.id, { type: "always-allow" });
    assert.equal((await pending)?.behavior, "allow");
    assert.deepEqual(w.engine.listRules(bot.id).map((r) => r.detail), ["Bash(ls:*)"]);
    // A request from Codex: no Always allow, nothing saved.
    const codexAsk = m.settings.canUseTool("Bash", { command: "pwd" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r", pobotsNoAlways: true, suggestions: rule } as never);
    await settle();
    const c2 = cards(w.events).at(-1)!;
    assert.ok(c2.kind === "approval" && c2.noAlways === true);
    assert.throws(() => w.engine.resolveCard(c2.id, { type: "always-allow" }), /only be allowed once/);
    w.engine.resolveCard(c2.id, { type: "allow-once" });
    assert.equal((await codexAsk)?.behavior, "allow");
    assert.deepEqual(w.engine.listRules(bot.id).map((r) => r.detail), ["Bash(ls:*)"]);
    done(w);
  });

  test("message_bot reaches its own bot and the allowed ones only, framed as from it", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const other = w.engine.createBot({ name: "Tickets", model: "claude-haiku-5-5", access: "edits-freely" });
    const third = w.engine.createBot({ name: "Mail", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.updateBot({ botId: bot.id, patch: { mayMessage: [other.id, third.id] } });
    const { m } = await startManager(w, s, { may_message: ["Tickets"] });
    const refused = await m.tool("message_bot", { to: "Mail", text: "Hello", mode: "tell" });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /You may not message Mail\. You may message Po, Tickets\./);
    const told = await m.tool("message_bot", { to: "Tickets", text: "The page is live.", mode: "tell" });
    assert.match(text(told), /^Delivered to Tickets/);
    const msg = items(w.events).find((i) => i.kind === "user" && i.text === "The page is live.") as UserItem;
    assert.deepEqual(msg.from, { type: "bot", botId: bot.id, expectsReply: false, taskManager: "Build the booking page" });
    done(w);
  });

  test("Stop on the bot stops it and its workers; it stays, resting", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m } = await startManager(w, s);
    const a = await startWorker(w, m, "Part one");
    await w.engine.interrupt(bot.id);
    await settle();
    assert.equal(m.closed, true);
    assert.equal(a.h!.closed, true);
    const info = lastBot(w.events, bot.id).taskManagers![0]!;
    assert.equal(info.state, "resting");
    assert.equal(info.workersNow, 0);
    // The person's Stop in its thread does the same, and does nothing when it rests.
    stopTaskManagerFrom(w.engine, { botId: bot.id, managerId: info.id });
    done(w);
  });

  test("ending: by its bot, by the main bot for another bot, and by the person; it leaves the rail and its row says ended", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    const { m, id, row } = await startManager(w, s);
    const a = await startWorker(w, m, "Part one");
    const ended = await s.tool("end_task_manager", { id });
    assert.match(text(ended), /^Ended task manager/);
    assert.equal(m.closed, true);
    assert.equal(a.h!.closed, true);
    assert.equal(lastBot(w.events, bot.id).taskManagers, undefined);
    const last = items(w.events).find((i) => i.id === row.id) as HelperItem;
    assert.equal(last.taskManager?.state, "ended");
    assert.equal((await s.tool("end_task_manager", { id })).isError, true);
    // The person ends one: the bot is told at its next turn.
    const second = await startManager(w, s, { title: "Second" });
    const secondRow = items(w.events).filter((i): i is HelperItem => i.kind === "helper" && !!i.taskManager).at(-1)!;
    endTaskManagerFrom(w.engine, { botId: bot.id, managerId: secondRow.id });
    assert.equal(second.m.closed, true);
    assert.equal(lastBot(w.events, bot.id).taskManagers, undefined);
    // Another bot may not end it; the main bot may.
    const worker = w.engine.createBot({ name: "Worker", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.sendMessage({ botId: worker.id, text: "Go" });
    await settle();
    const ws = w.sessions.at(-1)!;
    const third = await startManager(w, ws, { title: "Third" });
    const refused = await ws.tool("end_task_manager", { id: third.id, bot: "Po" });
    assert.equal(refused.isError, true);
    const byMain = await s.tool("end_task_manager", { id: third.id, bot: "Worker" });
    assert.match(text(byMain), /^Ended task manager/);
    done(w);
  });

  test("at most 4 per bot; a restart brings them back resting", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w);
    for (let i = 0; i < 4; i++) await startManager(w, s, { title: `Job ${i}` });
    const fifth = await s.tool("start_task_manager", { title: "Job 5", task: "More" });
    assert.equal(fifth.isError, true);
    assert.match(text(fifth), /already have 4 task managers/);
    const m = w.sessions.at(-1)!;
    m.emit({ type: "session", sessionId: "tm-last" });
    const dirs = w.dirs;
    done(w);
    const w2 = setup(dirs);
    const back = w2.engine.toBot(w2.engine.bot(bot.id));
    assert.equal(back.taskManagers?.length, 4);
    assert.ok(back.taskManagers!.every((t) => t.state === "resting"));
    // One that worked when Pobots stopped says so in its thread.
    const thread = back.taskManagers!.at(-1)!.managerThreadId;
    assert.ok(w2.store.readThread(thread, 50).items.some((i) => i.kind === "notice" && /Pobots restarted, so the task manager stopped/.test(i.text)));
    // Its session resumes when it gets a message.
    sendToTaskManager(w2.engine, { botId: bot.id, managerId: back.taskManagers!.at(-1)!.id, text: "Go on." });
    await settle();
    assert.equal(w2.sessions.at(-1)!.settings.resume, "tm-last");
    done(w2);
  });
});
