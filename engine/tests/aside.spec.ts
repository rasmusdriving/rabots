// Engine 0.24.1: a bot answers at once while its helpers work (docs/build/step-no-wait-for-helpers.md).
// A session whose helpers still work is set aside instead of closed when a turn for another thread
// needs a session; its helpers report back to the thread that started them. Fake harness.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BotItem, Events, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { REPORT_WAITED } from "../core/aside.js";
import { lastState, settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";

const FAST = { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const world = () => setup(undefined, () => true, FAST);

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const helpers = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const userItem = (events: Ev[], text: string) => items(events).find((i): i is UserItem => i.kind === "user" && i.text === text);
const botTexts = (events: Ev[], threadId: string) => items(events).filter((i): i is BotItem => i.kind === "bot" && i.threadId === threadId).map((i) => i.text);
const states = (events: Ev[], id: string) => events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);

function ownTurn(s: FakeSession, text: string, body?: () => void, end = true) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  body?.();
  if (!end) return;
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

/** A fresh run whose turn starts a helper in the background and ends: its session and the run. */
async function runWithHelper(engine: Engine, sessions: FakeSession[], botId: string, id = "h1") {
  const t = engine.saveTrigger({ botId, trigger: { kind: "schedule", name: "Morning round", prompt: "Look at the day.", where: "fresh", enabled: true, schedule: { type: "daily", time: "07:00", days: ["mon", "tue", "wed", "thu", "fri"] } } });
  const run = engine.runTrigger(t.id);
  await settle();
  const s = sessions.at(-1)!;
  ownTurn(s, "A helper is looking.", () => s.helperStart(id, { description: "Look slowly", background: true }));
  await settle();
  return { s, run };
}

describe("aside: a message does not wait for another thread's helpers", () => {
  test("a main-chat message starts at once while a fresh run's helper works; the helper's row keeps updating; its report runs in the run's thread", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s, run } = await runWithHelper(engine, sessions, bot.id);
    const runThread = store.getRun(run.id)!.threadId!;
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    assert.equal(userItem(events, "Hello")!.queued, false, "not queued");
    const main = sessions.at(-1)!;
    assert.notEqual(main, s, "the main chat gets its own session");
    assert.equal(main.sent.at(-1)!.text, "Hello");
    assert.equal(s.closed, false, "the run's session goes on");
    assert.equal(s.interrupts, 0);
    // The helper keeps working, and its row and thread follow it.
    s.helperTool("h1", "Read", { file_path: "/tmp/notes.txt" });
    s.helperSay("h1", "Half way.");
    main.reply("Hi.");
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.status, "running");
    assert.ok(botTexts(events, row.helperThreadId).includes("Half way."), "what it says goes to its own thread");
    assert.ok(items(events).some((i) => i.kind === "activity" && i.threadId === row.helperThreadId), "and its steps");
    assert.equal(row.threadId, runThread, "its row stays in the run's thread");
    assert.equal(lastState(events, bot.id)?.activity, "Waiting for a helper", "the bot waits for it, with no turn running");
    assert.equal(store.getRun(run.id)!.status, "running", "the run waits for its helper");
    // It reports back while the bot is free: the run's session is live again and the turn is in its thread.
    s.helperEnd("h1", "completed", "Nothing new today.", { background: true });
    s.wake("Nothing new today. Done.");
    await settle();
    assert.ok(botTexts(events, runThread).includes("Nothing new today. Done."));
    assert.ok(!botTexts(events, bot.mainThreadId).includes("Nothing new today. Done."));
    assert.equal(store.getRun(run.id)!.status, "done");
    assert.equal(s.closed, true, "the run's session ends with the run");
    assert.equal(main.closed, true, "the main session sleeps while the run's turn runs; it is resumed when next needed");
    assert.equal(lastState(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("when a set-aside session comes back for one helper's report, its other helper keeps working", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Two looks", prompt: "Look twice.", where: "fresh", enabled: true } });
    const run = engine.runTrigger(t.id);
    await settle();
    const s = sessions.at(-1)!;
    ownTurn(s, "Two helpers are looking.", () => {
      s.helperStart("h1", { description: "Quick look", background: true });
      s.helperStart("h2", { description: "Slow look", background: true, alsoLive: ["task-h1"] });
    });
    await settle();
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    const main = sessions.at(-1)!;
    main.reply("Hi.");
    await settle();
    // The quick one ends and reports while the bot is free; the slow one still runs.
    s.emit({ type: "task-updated", taskId: "task-h1", status: "completed" });
    s.emit({ type: "task-ended", taskId: "task-h1", toolUseId: "h1", status: "completed", summary: "Quick: fine." });
    s.emit({ type: "tasks-live", taskIds: ["task-h2"] });
    s.wake("Quick look is fine; the slow one is still going.");
    await settle();
    const rows = helpers(events);
    assert.equal(rows.find((h) => h.title === "Quick look")!.status, "done");
    assert.equal(rows.find((h) => h.title === "Slow look")!.status, "running", "never stopped by the session coming back");
    assert.equal(s.closed, false, "the run's session stays while its other helper works");
    assert.equal(store.getRun(run.id)!.status, "running");
    s.helperEnd("h2", "completed", "Slow: fine.", { background: true });
    s.wake("Both looks are fine.");
    await settle();
    assert.equal(store.getRun(run.id)!.status, "done");
    assert.equal(s.closed, true);
    engine.shutdown();
    store.close();
  });

  test("a report that comes while the bot answers something else is ended at its start and told after, in its own thread", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s, run } = await runWithHelper(engine, sessions, bot.id);
    const runThread = store.getRun(run.id)!.threadId!;
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    const main = sessions.at(-1)!;
    ownTurn(main, "", undefined, false);
    // The bot is busy in the main chat when the helper ends and the harness begins a turn there.
    s.helperEnd("h1", "completed", "Nothing new today.", { background: true });
    s.wake("This must not show.");
    await settle();
    assert.equal(s.interrupts, 1, "the harness's turn is ended at its start");
    assert.ok(!items(events).some((i) => i.kind === "bot" && i.text === "This must not show."));
    assert.equal(s.closed, false, "the session waits for the bot");
    // The main turn ends; the result is told in a turn of its own, in the run's session and thread.
    main.emit({ type: "text-full", key: "k1", text: "Hi." });
    main.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(s.sent.at(-1)!.text, REPORT_WAITED);
    s.reply("Nothing new today. Done.");
    await settle();
    assert.ok(botTexts(events, runThread).includes("Nothing new today. Done."));
    assert.equal(store.getRun(run.id)!.status, "done");
    assert.equal(s.closed, true);
    assert.equal(lastState(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("the other way: a main-chat helper works while a fresh run runs, then reports back in the main chat", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Look into it" });
    await settle();
    const main = sessions.at(-1)!;
    ownTurn(main, "A helper is on it.", () => main.helperStart("m1", { description: "Dig", background: true }));
    await settle();
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Ticket", prompt: "Look at the ticket.", where: "fresh", enabled: true } });
    const run = engine.runTrigger(t.id);
    await settle();
    const r = sessions.at(-1)!;
    assert.notEqual(r, main, "the run starts at once in a session of its own");
    assert.equal(main.closed, false, "the main session is set aside, its helper works on");
    r.reply("The ticket is fine.");
    await settle();
    assert.equal(store.getRun(run.id)!.status, "done", "the run is over at once: the main chat's helper is not its work");
    assert.equal(r.closed, true);
    assert.equal(lastState(events, bot.id)?.activity, "Waiting for a helper");
    main.helperEnd("m1", "completed", "Found it.", { background: true });
    main.wake("Found it: the cause is the cache.");
    await settle();
    assert.ok(botTexts(events, bot.mainThreadId).includes("Found it: the cause is the cache."));
    assert.equal(lastState(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("a message for a set-aside session's thread brings that session back instead of a new one", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Look into it" });
    await settle();
    const main = sessions.at(-1)!;
    ownTurn(main, "A helper is on it.", () => main.helperStart("m1", { description: "Dig", background: true }));
    await settle();
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Ticket", prompt: "Look at the ticket.", where: "fresh", enabled: true } });
    engine.runTrigger(t.id);
    await settle();
    const r = sessions.at(-1)!;
    r.reply("Fine.");
    await settle();
    const before = sessions.length;
    engine.sendMessage({ botId: bot.id, text: "How is it going?" });
    await settle();
    assert.equal(sessions.length, before, "no new session");
    assert.equal(main.sent.at(-1)!.text, "How is it going?");
    assert.equal(userItem(events, "How is it going?")!.queued, false);
    main.reply("Still digging.");
    await settle();
    assert.equal(helpers(events)[0]!.status, "running", "its helper was never stopped");
    engine.shutdown();
    store.close();
  });

  test("a set-aside session sleeps once its helper ended and nothing followed; the run ends then", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s, run } = await runWithHelper(engine, sessions, bot.id);
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    sessions.at(-1)!.reply("Hi.");
    await settle();
    s.helperEnd("h1", "completed", "Nothing new.", { background: true });
    await wait(40);
    assert.equal(s.closed, true, "asleep");
    assert.equal(store.getRun(run.id)!.status, "done", "the run ended with the last message it had");
    assert.equal(lastState(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("Stop stops the helpers of a set-aside session at once and closes it", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s, run } = await runWithHelper(engine, sessions, bot.id);
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    const main = sessions.at(-1)!;
    main.reply("Hi.");
    await settle();
    await engine.interrupt(bot.id);
    await settle();
    assert.equal(s.closed, true);
    assert.equal(helpers(events)[0]!.status, "stopped");
    assert.equal(store.getRun(run.id)!.status, "failed");
    const b = lastState(events, bot.id)!;
    assert.equal(b.helpers, 0);
    await wait(30);
    assert.equal(lastState(events, bot.id)?.activity, "Stopped");
    const said = items(events).filter((i): i is NoticeItem => i.kind === "notice" && i.threadId === bot.mainThreadId).map((n) => n.text);
    assert.ok(said.includes("Stopped. The helper was stopped before it reported back."));
    engine.shutdown();
    store.close();
  });

  test("a message to the same thread is answered at once while its own helper works", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Look into it" });
    await settle();
    const main = sessions.at(-1)!;
    ownTurn(main, "A helper is on it.", () => main.helperStart("m1", { description: "Dig", background: true }));
    await settle();
    engine.sendMessage({ botId: bot.id, text: "Also this" });
    await settle();
    assert.equal(userItem(events, "Also this")!.queued, false);
    assert.equal(main.sent.at(-1)!.text, "Also this");
    assert.equal(sessions.length, 1);
    engine.shutdown();
    store.close();
  });

  test("a start_helper helper is not stopped when a fresh run starts; its result is told in the main chat's own session", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Start a helper" });
    await settle();
    const main = sessions.at(-1)!;
    const input = { title: "Say a word", task: "Reply with only the word: wren", model: "claude-haiku-5-5", effort: "low", wait: false };
    ownTurn(main, "", undefined, false);
    main.emit({ type: "tool-start", toolUseId: "tu-p1", name: "mcp__pobots__start_helper", input });
    await main.tool("start_helper", input);
    main.emit({ type: "tool-end", toolUseId: "tu-p1", isError: false, text: "Started." });
    main.emit({ type: "text-full", key: "k1", text: "I started a helper." });
    main.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    const hs = sessions.at(-1)!;
    assert.notEqual(hs, main);
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Ticket", prompt: "Look at the ticket.", where: "fresh", enabled: true } });
    engine.runTrigger(t.id);
    await settle();
    const r = sessions.at(-1)!;
    assert.equal(main.closed, false, "set aside");
    assert.equal(hs.closed, false, "the helper works on");
    ownTurn(r, "", undefined, false);
    hs.reply("wren");
    await settle();
    assert.equal(helpers(events)[0]!.status, "done");
    r.emit({ type: "text-full", key: "k2", text: "Fine." });
    r.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.match(main.sent.at(-1)!.text, /wren/, "the result goes back to the session that started it");
    engine.shutdown();
    store.close();
  });

  test("a restart stops the helpers of a set-aside session with a notice in its thread", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s, run } = await runWithHelper(engine, sessions, bot.id);
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    sessions.at(-1)!.reply("Hi.");
    await settle();
    engine.shutdown();
    assert.equal(s.closed, true);
    const runThread = store.getRun(run.id)!.threadId!;
    assert.ok(items(events).some((i) => i.kind === "notice" && i.threadId === runThread && /Pobots restarted, so a helper was stopped/.test(i.text)));
    assert.ok(states(events, bot.id).length > 0);
    store.close();
  });
});
