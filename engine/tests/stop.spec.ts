// Step 3b, third part: a Stop holds until the person writes to the bot again
// (docs/build/step-3b-stop.md). The fake harness plays the sequences seen on the real one
// (docs/build/notes-engine-3b-stop.md): a command in the background that ends by itself after the
// interrupt, the turn the harness then begins by itself (init, which takes up no message of ours),
// and its end after the interrupt that ends it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bot, BotItem, Events, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import type { CodexSession } from "../codex/session.js";
import type { Engine } from "../engine.js";
import { TIDY_PROMPT } from "../engine.js";
import type { Store } from "../store.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { lastState, settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const T = { wakeGraceMs: 30, helperStopMs: 150, helperNudgeMs: 20, liveCheckMs: 40 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const world = (t: typeof T = T, dirs?: { dataDir: string; botsDir: string }, extra: Parameters<typeof setup>[3] = {}) => setup(dirs, () => true, t, extra);

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const notices = (events: Ev[]) => items(events).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);
const botTexts = (events: Ev[]) => items(events).filter((i): i is BotItem => i.kind === "bot").map((i) => i.text);
const helpers = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const states = (events: Ev[], id: string): Bot[] =>
  events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);
const botOf = (events: Ev[], id: string) => lastState(events, id)!;
const holdOf = (store: Store, botId: string) => {
  const raw = store.getValue(`stop.hold:${botId}`);
  return raw ? (JSON.parse(raw) as { at: string; held: string[] }) : undefined;
};
const queued = (store: Store, id: string) => (store.getItem(id) as UserItem).queued;

async function send(engine: Engine, sessions: FakeSession[], botId: string, text: string) {
  const item = engine.sendMessage({ botId, text });
  await settle();
  return { s: sessions.filter((x) => x.settings.botId === botId).at(-1)!, item };
}
function live(s: FakeSession, tasks: [taskId: string, taskType: string, parentTaskId?: string][]) {
  s.emit({ type: "tasks-live", taskIds: tasks.map((t) => t[0]), tasks: tasks.map(([taskId, taskType, parentTaskId]) => ({ taskId, taskType, ...(parentTaskId ? { parentTaskId } : {}), quiet: false })) });
}
function ownTurnStart(s: FakeSession) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
}
function ownTurnEnd(s: FakeSession, text: string) {
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}
/** What the real harness sends when its interrupt ends a turn of ours. */
function interruptedEnd(s: FakeSession) {
  s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: [], sessionId: "sess-1", own: true });
}
/** A turn the harness begins by itself: init that takes up no message of ours, the model at work, its end. */
function harnessTurn(s: FakeSession, text: string, o: { end?: boolean } = {}) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: false });
  s.emit({ type: "thinking" });
  s.emit({ type: "text-start", key: "w" });
  s.emit({ type: "text-delta", key: "w", text });
  s.emit({ type: "text-full", key: "w", text });
  s.emit({ type: "text-end", key: "w" });
  s.emit({ type: "tool-start", toolUseId: `tw-${Math.random()}`, name: "Bash", input: { command: "git commit -am x" } });
  if (o.end !== false) harnessTurnEnd(s);
}
function harnessTurnEnd(s: FakeSession, subtype = "success") {
  s.emit({ type: "turn-end", ok: subtype === "success", subtype, errors: [], sessionId: "sess-1", own: false });
}

const OWN = "toolu_own";
const OTASK = "b5bytmpjy";
const FG = "toolu_fg";
function ownCommand(s: FakeSession, taskId = OTASK, toolUseId = OWN) {
  s.emit({ type: "tool-start", toolUseId, name: "Bash", input: { command: 'node -e "setTimeout(()=>{},14000)"', run_in_background: true } });
  live(s, [[taskId, "local_bash"]]);
  s.emit({ type: "task-started", taskId, toolUseId, taskType: "local_bash", background: true, quiet: false });
  s.emit({ type: "tool-end", toolUseId, isError: false, text: `Command running in background with ID: ${taskId}.` });
}
function ownCommandEnds(s: FakeSession, status: "completed" | "stopped" = "completed", taskId = OTASK, toolUseId = OWN) {
  s.emit({ type: "task-updated", taskId, status: status === "stopped" ? "killed" : status });
  s.emit({ type: "task-ended", taskId, toolUseId, status, summary: 'Background command "Wait" completed (exit code 0)' });
  live(s, []);
}
/** The bot waits for a marker in a foreground command, as the developer bot did. */
function foregroundWait(s: FakeSession) {
  s.emit({ type: "tool-start", toolUseId: FG, name: "Bash", input: { command: 'node -e "setTimeout(()=>{},90000)"' } });
  s.emit({ type: "task-started", taskId: "bfg", toolUseId: FG, taskType: "local_bash", background: false, quiet: false });
}
/** Nothing new reached the chat or the bot's state since `from`. */
function nothingSince(events: Ev[], from: number, botId: string) {
  const later = events.slice(from);
  const shown = later.filter((e) => e.event === "item.upsert" || e.event === "item.delta").map((e) => (e.event === "item.upsert" ? (e.data as Events["item.upsert"]).item.kind : "delta"));
  assert.deepEqual(shown.filter((k) => k !== "helper"), [], `the chat got: ${shown.join(", ")}`);
  const st = states(later, botId).map((b) => `${b.state}/${b.activity}`);
  assert.ok(!st.some((x) => x.startsWith("thinking")), `the state flickered: ${st.join(" > ")}`);
}

describe("Stop holds: when it starts", () => {
  test("a Stop on a bot with nothing to stop changes nothing: no hold, and a turn the harness begins runs as before", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Hello");
    s.reply("Hi.");
    await settle();
    await engine.interrupt(bot.id);
    assert.equal(holdOf(store, bot.id), undefined);
    assert.equal(s.interrupts, 0);
    harnessTurn(s, "Something came back.");
    await settle();
    assert.ok(botTexts(events).includes("Something came back."));
    engine.shutdown();
    store.close();
  });

  test("helper.stop on one helper is not a Stop on the bot and holds nothing", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Start a helper");
    ownTurnStart(s);
    s.helperStart("toolu_h", { background: true, description: "Look around" });
    ownTurnEnd(s, "Started.");
    await settle();
    await engine.stopHelper({ botId: bot.id, itemId: helpers(events)[0]!.id });
    s.helperEnd("toolu_h", "stopped", "", { background: true });
    await settle();
    assert.equal(holdOf(store, bot.id), undefined);
    harnessTurn(s, "The helper was stopped.");
    await settle();
    assert.ok(botTexts(events).includes("The helper was stopped."));
    engine.shutdown();
    store.close();
  });
});

describe("Stop holds: while it holds", () => {
  test("(try 3) messages that waited at the Stop stay waiting, in their place, and the roster says so", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Long job");
    ownTurnStart(s);
    const second = engine.sendMessage({ botId: bot.id, text: "Second" });
    const third = engine.sendMessage({ botId: bot.id, text: "Third" });
    await engine.interrupt(bot.id);
    interruptedEnd(s);
    await wait(60);
    assert.equal(s.sent.length, 1, "no turn started out of a waiting message");
    assert.equal(queued(store, second.id), true);
    assert.equal(queued(store, third.id), true);
    assert.deepEqual(notices(events), ["Stopped."]);
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped, 2 messages waiting");
    assert.deepEqual(holdOf(store, bot.id)?.held, [second.id, third.id]);
    engine.shutdown();
    store.close();
  });

  test("(try 4) a command in the background that ends by itself after Stop: asked to stop at once, and the turn the harness begins is ended at once", async () => {
    const { engine, sessions, events, store } = world({ ...T, helperNudgeMs: 2000 });
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Run the checks");
    ownTurnStart(s);
    ownCommand(s);
    foregroundWait(s);
    await engine.interrupt(bot.id);
    assert.deepEqual(s.stopped, [OTASK], "the bot's own command is asked to stop at once, not after the nudge");
    assert.equal(s.interrupts, 1);
    interruptedEnd(s);
    await settle();
    const from = events.length;
    // The command ends by itself before the stop lands, and the harness wakes the model.
    ownCommandEnds(s, "completed");
    harnessTurn(s, "The checks passed, so I will commit and put it live.", { end: false });
    assert.equal(s.interrupts, 2, "the harness's own turn is interrupted at its start");
    assert.equal(s.settings.gate?.("Bash", { command: "npm run live:update" }), "Not now: the person pressed Stop. Do nothing more and end your turn.");
    harnessTurnEnd(s, "error_during_execution");
    await wait(60);
    nothingSince(events, from, bot.id);
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped");
    assert.deepEqual(notices(events), ["Stopped."], "no Stopped. of its own");
    // The gate is open again once that turn has ended.
    assert.equal(s.settings.gate?.("Bash", { command: "ls" }), undefined);
    engine.shutdown();
    store.close();
  });

  test("(try 1) Stop in a turn that waits in a foreground command, with a long command in the background: nothing starts", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Run the checks");
    ownTurnStart(s);
    ownCommand(s);
    foregroundWait(s);
    await engine.interrupt(bot.id);
    assert.ok(s.stopped.includes(OTASK));
    interruptedEnd(s);
    await settle();
    const from = events.length;
    ownCommandEnds(s, "stopped");
    // Should the harness wake the model for the stopped command, that turn is ended too.
    harnessTurn(s, "The command was stopped. Shall I start it again?");
    await wait(60);
    nothingSince(events, from, bot.id);
    assert.equal(s.sent.length, 1);
    assert.equal(botOf(events, bot.id).activity, "Stopped");
    engine.shutdown();
    store.close();
  });

  test("(try 2) Stop while the bot rests and its command runs in the background: asked to stop at once, and its report starts no turn", async () => {
    const { engine, sessions, events, store } = world({ ...T, helperNudgeMs: 2000 });
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Run the checks in the background");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "The checks run in the background.");
    await settle();
    assert.equal(botOf(events, bot.id).activity, "Working in the background");
    await engine.interrupt(bot.id);
    assert.deepEqual(s.stopped, [OTASK]);
    assert.ok(holdOf(store, bot.id));
    const from = events.length;
    ownCommandEnds(s, "completed");
    harnessTurn(s, "The checks passed.");
    await wait(80);
    const shown = items(events.slice(from)).filter((i) => i.kind === "bot");
    assert.deepEqual(shown, []);
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped");
    assert.ok(!states(events.slice(from), bot.id).some((x) => x.state === "thinking"));
    engine.shutdown();
    store.close();
  });

  test("a command that is let go after the grace and ends later starts no turn", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(250);
    assert.deepEqual(notices(events), ["Stopped.", "A command in the background may still be running."]);
    assert.equal(botOf(events, bot.id).activity, "Stopped");
    const from = events.length;
    // Minutes later it ends after all, and the harness wakes the model.
    ownCommandEnds(s, "completed");
    harnessTurn(s, "The command finished.");
    await wait(60);
    nothingSince(events, from, bot.id);
    assert.equal(s.interrupts, 2);
    engine.shutdown();
    store.close();
  });

  test("a helper from before the Stop that reports back before it stops starts no turn", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Start a helper");
    ownTurnStart(s);
    s.helperStart("toolu_h", { background: true, description: "Build it" });
    ownTurnEnd(s, "A helper builds it.");
    await settle();
    await engine.interrupt(bot.id);
    // The helper finishes before the stop reaches it, and the harness tells the bot.
    s.helperSay("toolu_h", "Built and checked.");
    s.helperEnd("toolu_h", "completed", "Built and checked.", { background: true });
    const from = events.length;
    harnessTurn(s, "The helper is done. I will put it live now.");
    await wait(80);
    assert.deepEqual(items(events.slice(from)).filter((i) => i.kind === "bot"), []);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("a turn of ours that starts while the harness's own turn is being ended gets none of that turn's words", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    ownCommandEnds(s, "completed");
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: false });
    // The person writes before that turn's end has come back.
    engine.sendMessage({ botId: bot.id, text: "What happened?" });
    await settle();
    assert.equal(s.sent.at(-1)!.text, "What happened?");
    s.emit({ type: "text-full", key: "x", text: "Words of the turn that was ended." });
    harnessTurnEnd(s, "error_during_execution");
    ownTurnStart(s);
    ownTurnEnd(s, "You pressed Stop.");
    await settle();
    assert.deepEqual(botTexts(events), ["Running.", "You pressed Stop."]);
    assert.equal(botOf(events, bot.id).activity, "Finished");
    engine.shutdown();
    store.close();
  });

  test("a late answer to a question asked before the Stop waits with the held messages", async () => {
    const { engine, sessions, events, store } = world();
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s: ps } = await send(engine, sessions, po.id, "Ask Inbox");
    ownTurnStart(ps);
    ps.emit({ type: "tool-start", toolUseId: "t1", name: "mcp__pobots__message_bot", input: { to: "inbox", text: "What colour?", mode: "ask" } });
    const pending = ps.tool("message_bot", { to: "inbox", text: "What colour?", mode: "ask" });
    await settle();
    const is = sessions.find((x) => x.settings.botId === inbox.id)!;
    await engine.interrupt(po.id);
    interruptedEnd(ps);
    await pending;
    await settle();
    is.reply("Teal");
    await settle();
    assert.equal(ps.sent.length, 1, "the late answer starts no turn");
    const late = items(events).find((i): i is UserItem => i.kind === "user" && i.text === "Teal")!;
    assert.equal(late.queued, true);
    assert.equal(botOf(events, po.id).activity, "Stopped, 1 message waiting");
    assert.deepEqual(holdOf(store, po.id)?.held, [late.id]);
    // The person writes: the answer is read first, then the new message.
    engine.sendMessage({ botId: po.id, text: "Carry on" });
    await settle();
    assert.equal(ps.sent.at(-1)!.text, "Teal");
    ps.reply("Teal it is.");
    await settle();
    assert.equal(ps.sent.at(-1)!.text, "Carry on");
    engine.shutdown();
    store.close();
  });

  test("a helper started with start_helper before the Stop is not told back when it ends later", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Start a helper");
    const input = { title: "Say a word", task: "Reply with only the word: wren", model: "claude-haiku-5-5", effort: "low", wait: false };
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: "tu-p1", name: "mcp__pobots__start_helper", input });
    await s.tool("start_helper", input);
    s.emit({ type: "tool-end", toolUseId: "tu-p1", isError: false, text: "Started." });
    ownTurnEnd(s, "I started a helper.");
    await settle();
    const hs = sessions.find((x) => x !== s)!;
    await engine.interrupt(bot.id);
    hs.reply("wren");
    await wait(60);
    assert.equal(s.sent.length, 1, "no turn of its own for the helper's result");
    assert.equal(helpers(events)[0]!.status, "stopped");
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });
});

/** A clock the test moves, Wednesday 11 Nov 2026 13:00 in Stockholm. */
function clock(start = "2026-11-11T12:00:00Z") {
  const c = { t: Date.parse(start), now: () => c.t, set: (x: string) => (c.t = Date.parse(x)) };
  return c;
}

describe("Stop holds: what is new after the Stop still wakes the bot", () => {
  test("a schedule that fires while a Stop holds runs; the held message stays waiting behind it and the hold stays", async () => {
    const c = clock();
    const { engine, sessions, events, store } = world(T, undefined, { clock: c.now, timeZone: "Europe/Stockholm" });
    const bot = engine.createBot("Po");
    await settle();
    engine.saveTrigger({ botId: bot.id, trigger: { kind: "schedule", name: "Afternoon", prompt: "Check the inbox.", where: "main", enabled: true, schedule: { type: "daily", time: "16:30", days: ["wed"] } } });
    const { s } = await send(engine, sessions, bot.id, "Long job");
    ownTurnStart(s);
    const held = engine.sendMessage({ botId: bot.id, text: "Waiting one" });
    await engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    c.set("2026-11-11T15:30:05Z");
    engine.checkSchedules();
    await settle();
    assert.equal(s.sent.at(-1)!.text, "Check the inbox.", "the schedule's turn runs although the Stop holds");
    assert.equal(queued(store, held.id), true);
    // Work the schedule's turn starts in the background is its own and may report back.
    ownTurnStart(s);
    ownCommand(s, "bnew", "toolu_new");
    ownTurnEnd(s, "Checking in the background.");
    await settle();
    ownCommandEnds(s, "completed", "bnew", "toolu_new");
    harnessTurn(s, "The inbox has nothing new.");
    await wait(80);
    assert.ok(botTexts(events).includes("The inbox has nothing new."), "the new work's report is a turn as before");
    assert.equal(s.sent.length, 2, "the held message did not start");
    assert.equal(queued(store, held.id), true);
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped, 1 message waiting");
    assert.deepEqual(holdOf(store, bot.id)?.held, [held.id]);
    engine.shutdown();
    store.close();
  });

  test("a message from another bot while a Stop holds runs, and the held message stays waiting", async () => {
    const { engine, sessions, store } = world();
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, inbox.id, "Long job");
    ownTurnStart(s);
    const held = engine.sendMessage({ botId: inbox.id, text: "Waiting one" });
    await engine.interrupt(inbox.id);
    interruptedEnd(s);
    await settle();
    const { s: ps } = await send(engine, sessions, po.id, "Tell Inbox");
    await ps.tool("message_bot", { to: "inbox", text: "The meeting moved.", mode: "tell" });
    await settle();
    assert.equal(s.sent.at(-1)!.text, "The meeting moved.");
    s.reply("Noted.");
    await settle();
    assert.equal(s.sent.length, 2);
    assert.equal(queued(store, held.id), true);
    engine.shutdown();
    store.close();
  });
});

describe("Stop holds: when it ends", () => {
  test("the person's message ends it: the held messages are read first, in their order, then the new one", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Long job");
    ownTurnStart(s);
    engine.sendMessage({ botId: bot.id, text: "Second" });
    engine.sendMessage({ botId: bot.id, text: "Third" });
    await engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    engine.sendMessage({ botId: bot.id, text: "Fourth" });
    await settle();
    assert.equal(holdOf(store, bot.id), undefined, "the hold is gone from the database too");
    assert.equal(s.sent.at(-1)!.text, "Second");
    s.reply("2");
    await settle();
    assert.equal(s.sent.at(-1)!.text, "Third");
    s.reply("3");
    await settle();
    assert.equal(s.sent.at(-1)!.text, "Fourth");
    s.reply("4");
    await settle();
    assert.deepEqual(s.sent.map((x) => x.text), ["Long job", "Second", "Third", "Fourth"]);
    assert.equal(botOf(events, bot.id).activity, "Finished");
    // Without a hold, a turn the harness begins runs as before.
    harnessTurn(s, "Something came back.");
    await settle();
    assert.ok(botTexts(events).includes("Something came back."));
    engine.shutdown();
    store.close();
  });
});

describe("Stop holds: a restart", () => {
  test("a Stop from before a restart still holds: the waiting message is not sent on start, the roster says so, and the person's message ends it", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world(T, dirs);
    const bot = first.engine.createBot("Po");
    const { s } = await send(first.engine, first.sessions, bot.id, "Long job");
    ownTurnStart(s);
    const held = first.engine.sendMessage({ botId: bot.id, text: "Waiting one" });
    await first.engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = world(T, dirs);
    await wait(30);
    assert.equal(second.sessions.length, 0, "nothing was sent on start");
    assert.equal(queued(second.store, held.id), true);
    const b = second.engine.snapshot().bots.find((x) => x.id === bot.id)!;
    assert.equal(b.state, "idle");
    assert.equal(b.activity, "Stopped, 1 message waiting");
    second.engine.sendMessage({ botId: bot.id, text: "Go on" });
    await settle();
    const s2 = second.sessions.at(-1)!;
    assert.equal(s2.sent[0]!.text, "Waiting one");
    s2.reply("Done.");
    await settle();
    assert.equal(s2.sent.at(-1)!.text, "Go on");
    second.engine.shutdown();
    second.store.close();
  });
});

describe("Stop holds: a bot on a GPT model", () => {
  test("its waiting message stays waiting, what Codex sends after the Stop starts no turn, and the person's message ends the hold", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[slow]]" });
    await waitFor(() => lastState(w.events, bot.id)?.activity === "Ran a command" || lastState(w.events, bot.id)?.state === "working", 5000, "the slow command");
    // Sent to wait in line (protocol 14 would steer it by default; steering has its own tests).
    const second = w.engine.sendMessage({ botId: bot.id, text: "[[answer:two]]", mode: "queue" });
    assert.equal(second.queued, true);
    await w.engine.interrupt(bot.id);
    await waitFor(() => lastState(w.events, bot.id)?.state === "done", 5000, "stopped");
    await wait(100);
    assert.equal(queued(w.store, second.id), true);
    assert.equal(lastState(w.events, bot.id)?.activity, "Stopped, 1 message waiting");
    // Something Codex sends for the thread after the Stop, with no turn of ours running.
    const from = w.events.length;
    const cs = w.codexSessions.at(-1)! as unknown as { settings: { onEvent: (e: unknown) => void } } & CodexSession;
    cs.settings.onEvent({ type: "thinking" });
    cs.settings.onEvent({ type: "text-full", key: "late", text: "A late word from Codex." });
    await settle();
    nothingSince(w.events, from, bot.id);
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:three]]" });
    await waitFor(() => botTexts(w.events).includes("three"), 8000, "the new message's answer");
    const said = botTexts(w.events);
    assert.ok(said.indexOf("two") >= 0 && said.indexOf("two") < said.indexOf("three"), said.join(" | "));
    assert.ok(!said.includes("A late word from Codex."));
    w.engine.shutdown();
    w.store.close();
  });
});

describe("Stop holds: unchanged", () => {
  test("a fresh start goes on while messages are held, and they still wait afterwards", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Hello");
    ownTurnStart(s);
    const held = engine.sendMessage({ botId: bot.id, text: "Waiting one" });
    await engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    assert.equal(s.sent.at(-1)!.text, TIDY_PROMPT);
    s.reply("Nothing is open.");
    await settle();
    assert.ok(s.closed, "the old session went to sleep for the fresh start");
    assert.equal(queued(store, held.id), true);
    assert.equal(botOf(events, bot.id).activity, "Stopped, 1 message waiting");
    engine.shutdown();
    store.close();
  });
});

// ------------------------------------------------------------ after the review (second brief)

/** Another bot tells `to` something, as message_bot does. */
async function tell(from: FakeSession, to: string, text: string) {
  await from.tool("message_bot", { to, text, mode: "tell" });
  await settle();
}
const threadNotices = (store: Store, threadId: string) => store.readThread(threadId, undefined, 100).items.filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);

describe("Stop holds: after the review", () => {
  test("A. a restart while Claude is not ready keeps the held messages held and waiting; only those that came after the Stop are not sent", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world(T, dirs);
    const po = first.engine.createBot("Po");
    const inbox = first.engine.createBot("Inbox");
    const { s } = await send(first.engine, first.sessions, po.id, "Long job");
    ownTurnStart(s);
    const held = first.engine.sendMessage({ botId: po.id, text: "Waiting one" });
    await first.engine.interrupt(po.id);
    interruptedEnd(s);
    await settle();
    // New after the Stop: one message starts a turn, a second waits behind it.
    const { s: is } = await send(first.engine, first.sessions, inbox.id, "Go");
    await tell(is, "po", "First news");
    await tell(is, "po", "Second news");
    const second = first.store.queuedItemsOfBot(po.id).find((i) => i.kind === "user" && i.text === "Second news")!;
    first.engine.shutdown();
    first.store.close();

    const notReady = world(T, dirs, { claudeReady: false });
    await wait(30);
    assert.equal(queued(notReady.store, held.id), true, "the held message is still waiting");
    assert.equal(queued(notReady.store, second.id), false, "the message from after the Stop was not sent, as before");
    assert.deepEqual(holdOf(notReady.store, po.id)?.held, [held.id]);
    assert.ok(threadNotices(notReady.store, po.mainThreadId).includes("Claude is not ready on this computer, so the messages that came after the Stop were not sent. Send them again when it is."));
    notReady.engine.shutdown();
    notReady.store.close();

    const ready = world(T, dirs);
    await wait(30);
    assert.equal(ready.sessions.length, 0);
    assert.equal(ready.engine.snapshot().bots.find((b) => b.id === po.id)!.activity, "Stopped, 1 message waiting");
    ready.engine.sendMessage({ botId: po.id, text: "Go on" });
    await settle();
    assert.equal(ready.sessions.at(-1)!.sent[0]!.text, "Waiting one");
    ready.engine.shutdown();
    ready.store.close();
  });

  test("B. an answer to a question asked before the Stop is held, also when the engine restarted before the other bot answered", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world(T, dirs);
    const po = first.engine.createBot("Po");
    const inbox = first.engine.createBot("Inbox");
    const { s: is } = await send(first.engine, first.sessions, inbox.id, "Long job");
    ownTurnStart(is);
    const { s: ps } = await send(first.engine, first.sessions, po.id, "Ask Inbox");
    ownTurnStart(ps);
    ps.emit({ type: "tool-start", toolUseId: "t1", name: "mcp__pobots__message_bot", input: { to: "inbox", text: "What colour?", mode: "ask" } });
    const pending = ps.tool("message_bot", { to: "inbox", text: "What colour?", mode: "ask" });
    await settle();
    await first.engine.interrupt(po.id);
    interruptedEnd(ps);
    await pending;
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = world(T, dirs);
    await settle();
    const is2 = second.sessions.find((x) => x.settings.botId === inbox.id)!;
    assert.equal(is2.sent[0]!.text, "What colour?", "Inbox takes up the question after the restart");
    is2.reply("Teal");
    await settle();
    assert.equal(second.sessions.filter((x) => x.settings.botId === po.id).length, 0, "the old answer starts no turn for Po");
    const late = second.store.queuedItemsOfBot(po.id).find((i) => i.kind === "user" && i.text === "Teal");
    assert.ok(late, "the answer waits for Po");
    assert.deepEqual(holdOf(second.store, po.id)?.held, [late.id]);
    assert.equal(botOf(second.events, po.id).activity, "Stopped, 1 message waiting");
    second.engine.shutdown();
    second.store.close();
  });

  test("C. the person's message that cannot be stored leaves the hold as it was", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Long job");
    ownTurnStart(s);
    const held = engine.sendMessage({ botId: bot.id, text: "Waiting one" });
    await engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    const addItem = store.addItem;
    store.addItem = () => {
      throw new Error("the disk is full");
    };
    assert.throws(() => engine.sendMessage({ botId: bot.id, text: "Go on" }), /disk is full/);
    store.addItem = addItem;
    await settle();
    assert.deepEqual(holdOf(store, bot.id)?.held, [held.id], "the hold is still in the database");
    assert.equal(s.sent.length, 1, "nothing started");
    assert.equal(botOf(events, bot.id).activity, "Stopped, 1 message waiting");
    engine.shutdown();
    store.close();
  });

  test("C. a restart after the person's message was stored and before the hold was taken off: the hold ends then, held first", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world(T, dirs);
    const bot = first.engine.createBot("Po");
    const { s } = await send(first.engine, first.sessions, bot.id, "Long job");
    ownTurnStart(s);
    first.engine.sendMessage({ botId: bot.id, text: "Waiting one" });
    await first.engine.interrupt(bot.id);
    interruptedEnd(s);
    await settle();
    first.engine.shutdown();
    // What the database holds when Pobots stopped between storing the message and taking the hold off.
    await wait(5);
    first.store.addItem(bot.mainThreadId, { kind: "user", at: new Date().toISOString(), text: "Go on", from: { type: "you" }, queued: true });
    first.store.close();

    const second = world(T, dirs);
    await settle();
    assert.equal(holdOf(second.store, bot.id), undefined, "the hold ended at start");
    const s2 = second.sessions.at(-1)!;
    assert.equal(s2.sent[0]!.text, "Waiting one", "the held message goes first");
    s2.reply("Done.");
    await settle();
    assert.equal(s2.sent.at(-1)!.text, "Go on");
    second.engine.shutdown();
    second.store.close();
  });

  test("D. a turn for new work runs after the grace too, while old work may still report back", async () => {
    const { engine, sessions, events, store } = world();
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(po.id);
    await wait(250); // the command is let go: work from before the Stop may still report back
    // New work after the Stop: another bot's message, a command of that turn, its end.
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "Check the build");
    ownTurnStart(s);
    // The let-go command is still in the harness's list: it may still report back.
    s.emit({ type: "tool-start", toolUseId: "toolu_new", name: "Bash", input: { command: "node -e 1", run_in_background: true } });
    live(s, [[OTASK, "local_bash"], ["bnew", "local_bash"]]);
    s.emit({ type: "task-started", taskId: "bnew", toolUseId: "toolu_new", taskType: "local_bash", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: "toolu_new", isError: false, text: "Command running in background with ID: bnew." });
    ownTurnEnd(s, "Checking in the background.");
    await settle();
    s.emit({ type: "task-ended", taskId: "bnew", toolUseId: "toolu_new", status: "completed", summary: "completed" });
    live(s, [[OTASK, "local_bash"]]);
    await wait(80); // longer than the grace after which the bot settles
    harnessTurn(s, "The build is green.");
    await wait(30);
    assert.ok(botTexts(events).includes("The build is green."), "the turn for the new work ran");
    engine.shutdown();
    store.close();
  });

  test("D. a turn nothing can be placed for is ended only while work from before the Stop may still report back", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(250); // the command is let go: it may still report back
    harnessTurn(s, "First.");
    await wait(30);
    assert.ok(!botTexts(events).includes("First."), "ended: the let-go command may still report");
    ownCommandEnds(s, "completed");
    harnessTurn(s, "Second.");
    await wait(30);
    assert.ok(!botTexts(events).includes("Second."), "ended: the let-go command reported");
    harnessTurn(s, "Third.");
    await wait(30);
    assert.ok(botTexts(events).includes("Third."), "nothing from before the Stop is left, so it runs");
    engine.shutdown();
    store.close();
  });

  test("D. old and new work reporting at nearly the same moment, with one turn for both: the turn is ended", async () => {
    const { engine, sessions, events, store } = world({ ...T, helperStopMs: 2000 });
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(po.id);
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "Check the build");
    ownTurnStart(s);
    ownCommand(s, "bnew", "toolu_new");
    ownTurnEnd(s, "Checking in the background.");
    await settle();
    // The old command ends (the stop never landed), then the new one, then one turn for both.
    s.emit({ type: "task-ended", taskId: OTASK, toolUseId: OWN, status: "completed", summary: "completed" });
    live(s, [["bnew", "local_bash"]]);
    ownCommandEnds(s, "completed", "bnew", "toolu_new");
    harnessTurn(s, "Both are done; I will put it live.");
    await wait(30);
    assert.ok(!botTexts(events).includes("Both are done; I will put it live."));
    engine.shutdown();
    store.close();
  });

  test("D. a still-running helper given more to do with SendMessage after the Stop is work of now: its report starts a turn", async () => {
    const { engine, sessions, events, store } = world({ ...T, helperStopMs: 2000 });
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Start a helper");
    ownTurnStart(s);
    s.helperStart("toolu_h", { background: true, description: "Build it", taskId: "htask" });
    ownTurnEnd(s, "A helper builds it.");
    await settle();
    await engine.interrupt(po.id);
    await wait(40);
    // A turn of now gives the same helper, still running, more to do.
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "Have the helper check the docs too");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: "toolu_send", name: "SendMessage", input: { to: "htask", message: "Check the docs too.", recipient_kind: "agent" } });
    s.emit({ type: "task-started", taskId: "htask", toolUseId: "toolu_send", taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: "toolu_send", isError: false, text: '{"success":true}' });
    ownTurnEnd(s, "I gave it more to do.");
    await settle();
    s.helperSay("toolu_h", "Built, and the docs are fine.");
    s.helperEnd("toolu_h", "completed", "Built, and the docs are fine.", { background: true, taskId: "htask" });
    harnessTurn(s, "The helper says the docs are fine.");
    await wait(30);
    assert.ok(botTexts(events).includes("The helper says the docs are fine."));
    engine.shutdown();
    store.close();
  });

  test("E. two Stops in a row: the second during a hold, with and without something to stop; held messages stay held in order", async () => {
    const { engine, sessions, events, store } = world();
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Long job");
    ownTurnStart(s);
    const first = engine.sendMessage({ botId: po.id, text: "Waiting one" });
    await engine.interrupt(po.id);
    interruptedEnd(s);
    await settle();
    const at = holdOf(store, po.id)!.at;
    await wait(5);
    // New work runs during the hold; a message waits behind it; Stop again.
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "News");
    ownTurnStart(s);
    await tell(is, "po", "More news");
    const more = store.queuedItemsOfBot(po.id).find((i) => i.kind === "user" && i.text === "More news")!;
    await engine.interrupt(po.id);
    interruptedEnd(s);
    await settle();
    let row = holdOf(store, po.id)!;
    assert.deepEqual(row.held, [first.id, more.id]);
    assert.ok(row.at > at, "the hold's time is the latest Stop's");
    assert.equal(botOf(events, po.id).activity, "Stopped, 2 messages waiting");
    // A Stop with nothing to stop changes nothing.
    const raw = store.getValue(`stop.hold:${po.id}`);
    await engine.interrupt(po.id);
    assert.equal(store.getValue(`stop.hold:${po.id}`), raw);
    assert.equal(botOf(events, po.id).activity, "Stopped, 2 messages waiting");
    // The person writes: both go first, in their order.
    engine.sendMessage({ botId: po.id, text: "Go on" });
    await settle();
    assert.equal(s.sent.at(-1)!.text, "Waiting one");
    s.reply("1");
    await settle();
    assert.equal(s.sent.at(-1)!.text, "More news");
    s.reply("2");
    await settle();
    assert.equal(s.sent.at(-1)!.text, "Go on");
    row = holdOf(store, po.id)!;
    assert.equal(row, undefined);
    engine.shutdown();
    store.close();
  });

  test("E. Stop during a tidy turn: the hold begins, the message that waited stays held, and the tidy turn counts as not finished", async () => {
    const { engine, sessions, events, store } = world();
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Hello");
    s.reply("Hi.");
    await settle();
    assert.deepEqual(engine.startFresh(po.id), { started: true });
    await settle();
    assert.equal(s.sent.at(-1)!.text, TIDY_PROMPT);
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "News");
    const news = store.queuedItemsOfBot(po.id).find((i) => i.kind === "user" && i.text === "News")!;
    await engine.interrupt(po.id);
    interruptedEnd(s);
    await settle();
    assert.deepEqual(holdOf(store, po.id)?.held, [news.id]);
    assert.equal(queued(store, news.id), true);
    assert.equal(s.sent.length, 2, "nothing started after the tidy turn");
    // The rules for a tidy turn that was stopped: the session stays, no fresh line, the rules wait.
    assert.equal(s.closed, false);
    assert.ok(!items(events).some((i) => i.kind === "notice" && i.mark === "fresh"));
    assert.ok(store.getContext(po.mainThreadId).tidyBlockedAt);
    assert.equal(botOf(events, po.id).activity, "Stopped, 1 message waiting");
    engine.shutdown();
    store.close();
  });
});

// ------------------------------------------------------------ after the second review

describe("Stop holds: after the second review", () => {
  test("1. two Stops, then a restart: an answer to a question asked between the two Stops is held", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world(T, dirs);
    const po = first.engine.createBot("Po");
    const inbox = first.engine.createBot("Inbox");
    const { s: ps } = await send(first.engine, first.sessions, po.id, "Long job");
    ownTurnStart(ps);
    const held = first.engine.sendMessage({ botId: po.id, text: "Waiting one" });
    await first.engine.interrupt(po.id);
    interruptedEnd(ps);
    await settle();
    await wait(5);
    // During the hold, new work: Inbox (busy with its own turn) tells Po something, and Po asks Inbox.
    const { s: is } = await send(first.engine, first.sessions, inbox.id, "Busy work");
    ownTurnStart(is);
    await tell(is, "po", "Ask me the colour");
    ownTurnStart(ps);
    ps.emit({ type: "tool-start", toolUseId: "t1", name: "mcp__pobots__message_bot", input: { to: "inbox", text: "What colour?", mode: "ask" } });
    const pending = ps.tool("message_bot", { to: "inbox", text: "What colour?", mode: "ask" });
    await settle();
    await wait(5);
    // Stop again before Inbox answers.
    await first.engine.interrupt(po.id);
    interruptedEnd(ps);
    await pending;
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = world(T, dirs);
    await settle();
    const is2 = second.sessions.find((x) => x.settings.botId === inbox.id)!;
    assert.equal(is2.sent[0]!.text, "What colour?");
    is2.reply("Teal");
    await settle();
    assert.equal(second.sessions.filter((x) => x.settings.botId === po.id).length, 0, "the answer from before the second Stop starts no turn");
    const late = second.store.queuedItemsOfBot(po.id).find((i) => i.kind === "user" && i.text === "Teal")!;
    assert.ok(late);
    assert.deepEqual(holdOf(second.store, po.id)?.held, [held.id, late.id], "the first Stop's held message stays held, in order");
    second.engine.shutdown();
    second.store.close();
  });

  /** Stop while Po rests with an old command; then a turn of now; then a turn nothing can be placed for. */
  async function oldEndsThenUnplaceable(end: (s: FakeSession) => void) {
    const { engine, sessions, events, store } = world({ ...T, helperStopMs: 2000 });
    const po = engine.createBot("Po");
    const inbox = engine.createBot("Inbox");
    const { s } = await send(engine, sessions, po.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(po.id);
    end(s);
    await settle();
    // New work during the hold: a turn of now, then a turn the harness begins whose report cannot be matched.
    const { s: is } = await send(engine, sessions, inbox.id, "Go");
    await tell(is, "po", "Start a helper");
    ownTurnStart(s);
    ownTurnEnd(s, "Started one.");
    await wait(60);
    harnessTurn(s, "The helper reported back.");
    await wait(30);
    const ran = botTexts(events).includes("The helper reported back.");
    engine.shutdown();
    store.close();
    return ran;
  }

  test("2. an old command that ends only by a task update (no notification): later turns of new work run", async () => {
    const ran = await oldEndsThenUnplaceable((s) => s.emit({ type: "task-updated", taskId: OTASK, status: "completed" }));
    assert.equal(ran, true);
  });

  test("2. an old command that only leaves the harness's list: later turns of new work run", async () => {
    const ran = await oldEndsThenUnplaceable((s) => live(s, []));
    assert.equal(ran, true);
  });

  test("2. an old command (here one let go) that ends with update, notification and list in that order: the turn right after is ended", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const { s } = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(250); // let go: the engine no longer has it among its live tasks
    s.emit({ type: "task-updated", taskId: OTASK, status: "completed" });
    s.emit({ type: "task-ended", taskId: OTASK, toolUseId: OWN, status: "completed", summary: "completed" });
    live(s, []);
    harnessTurn(s, "The command finished; I will go on.");
    await wait(30);
    assert.ok(!botTexts(events).includes("The command finished; I will go on."));
    engine.shutdown();
    store.close();
  });

  test("2. a let-go command that is no longer listed by the harness leaves the set at the next list", async () => {
    const ran = await (async () => {
      const { engine, sessions, events, store } = world();
      const po = engine.createBot("Po");
      const inbox = engine.createBot("Inbox");
      const { s } = await send(engine, sessions, po.id, "Go");
      ownTurnStart(s);
      ownCommand(s);
      ownTurnEnd(s, "Running.");
      await settle();
      await engine.interrupt(po.id);
      await wait(250); // let go
      live(s, [["other", "local_bash"]]);
      live(s, []);
      const { s: is } = await send(engine, sessions, inbox.id, "Go");
      await tell(is, "po", "Start a helper");
      ownTurnStart(s);
      ownTurnEnd(s, "Started one.");
      await wait(60);
      harnessTurn(s, "The helper reported back.");
      await wait(30);
      const r = botTexts(events).includes("The helper reported back.");
      engine.shutdown();
      store.close();
      return r;
    })();
    assert.equal(ran, true);
  });
});
