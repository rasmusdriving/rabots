// Step 3b, second part: a bot that waits for work in the background is working. The fake harness
// plays the message sequences the real one sent in the trial (docs/build/notes-engine-3b-waiting.md):
// a helper that stops to wait for a command of its own and comes back, a helper given more to do with
// SendMessage, and the bot's own command in the background.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bot, BotItem, Events, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import { ClaudeSession, type HarnessEvent } from "../claude/session.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { lastState, settle, setup, upserts, usage, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

// A little slower than the helper tests' timings, so a busy machine does not decide a test.
const T = { wakeGraceMs: 30, helperStopMs: 150, helperNudgeMs: 20, liveCheckMs: 40 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const world = () => setup(undefined, () => true, T);

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const helpers = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const rowStatuses = (events: Ev[], id: string) => upserts(events).filter((i): i is HelperItem => i.kind === "helper" && i.id === id).map((i) => i.status);
const states = (events: Ev[], id: string): Bot[] =>
  events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);
const botOf = (events: Ev[], id: string) => lastState(events, id)!;

async function send(engine: Engine, sessions: FakeSession[], botId: string, text: string) {
  engine.sendMessage({ botId, text });
  await settle();
  return sessions.at(-1)!;
}

/** The harness's list of live background tasks, with details, as background_tasks_changed gives it. */
function live(s: FakeSession, tasks: [taskId: string, taskType: string, parentTaskId?: string, ambient?: boolean][]) {
  s.emit({
    type: "tasks-live",
    taskIds: tasks.map((t) => t[0]),
    tasks: tasks.map(([taskId, taskType, parentTaskId, ambient]) => ({ taskId, taskType, ...(parentTaskId ? { parentTaskId } : {}), quiet: ambient === true })),
  });
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

// ------------------------------------------------------------ the three sequences from the trial

const AGENT = "toolu_agent";
const HTASK = "a20c4073b1a3d7cfa";
const BASH = "toolu_bash";
const BTASK = "bun3757ot";

/** Case 1, first part: the bot starts a helper in the background; it starts a command in the background and stops to wait for it. */
function helperWaitsForItsCommand(s: FakeSession) {
  s.emit({ type: "tool-start", toolUseId: AGENT, name: "Agent", input: { description: "Wait for a command", prompt: "Run the command in the background and wait for it.", run_in_background: true } });
  live(s, [[HTASK, "local_agent"]]);
  s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
  s.emit({ type: "tool-end", toolUseId: AGENT, isError: false, text: "Async agent launched successfully." });
  s.emit({ type: "tool-start", toolUseId: BASH, name: "Bash", input: { command: 'node -e "setTimeout(()=>{},40000)"', run_in_background: true }, parent: AGENT });
  live(s, [[HTASK, "local_agent"], [BTASK, "local_bash", HTASK]]);
  s.emit({ type: "task-started", taskId: BTASK, toolUseId: BASH, taskType: "local_bash", background: true, parentTaskId: HTASK, quiet: false });
  s.emit({ type: "tool-end", toolUseId: BASH, isError: false, parent: AGENT, text: "Command running in background with ID: bun3757ot." });
  s.emit({ type: "text-full", key: "h1", text: "The background command is running, so I am waiting for it to finish.", parent: AGENT });
  s.emit({ type: "task-updated", taskId: HTASK, status: "completed" });
  s.emit({ type: "task-ended", taskId: HTASK, toolUseId: AGENT, status: "completed", summary: "The background command is running, so I am waiting for it to finish." });
  live(s, [[BTASK, "local_bash", HTASK]]);
}

/** A turn the harness begins by itself. */
function harnessTurn(s: FakeSession, text: string) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: false });
  s.emit({ type: "thinking" });
  s.emit({ type: "text-full", key: `w-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: false });
}

/** Case 1, second part: the command ends, the same helper task starts again, reports and completes. */
function commandEndsAndHelperComesBack(s: FakeSession) {
  s.emit({ type: "task-updated", taskId: BTASK, status: "completed" });
  s.emit({ type: "task-ended", taskId: BTASK, toolUseId: BASH, status: "completed", summary: 'Background command "Wait" completed (exit code 0)' });
  live(s, []);
  live(s, [[HTASK, "local_agent"]]);
  s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
  s.emit({ type: "text-full", key: "h2", text: "The command finished with exit code 0. done", parent: AGENT });
  s.emit({ type: "task-updated", taskId: HTASK, status: "completed" });
  s.emit({ type: "task-ended", taskId: HTASK, toolUseId: AGENT, status: "completed", summary: "The command finished with exit code 0. done" });
  live(s, []);
}

describe("waiting: a helper that waits for a command of its own", () => {
  test("its row stays running, the bot keeps working and is never calm, and both settle once the helper comes back and ends", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper that waits for a command");
    ownTurnStart(s);
    helperWaitsForItsCommand(s);
    ownTurnEnd(s, "I started the helper in the background.");
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.status, "running", "a helper that waits for its own work is not done");
    let b = botOf(events, bot.id);
    assert.equal(b.state, "working");
    assert.equal(b.activity, "Waiting for a helper");
    assert.equal(b.helpers, 1);

    // The harness tells the bot that the helper stopped with work running; the bot says it waits.
    const from = events.length;
    harnessTurn(s, "The helper is still running, so I will wait for its report.");
    await wait(80);
    b = botOf(events, bot.id);
    assert.equal(b.state, "working", "still working after the turn the harness began");
    assert.equal(b.activity, "Waiting for a helper");
    assert.equal(helpers(events)[0]!.status, "running");

    // Not calm: no fresh start, no tidy turn, the session stays.
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    engine.checkContext();
    await settle();
    assert.equal(s.closed, false);

    commandEndsAndHelperComesBack(s);
    await settle();
    const done = helpers(events)[0]!;
    assert.equal(done.status, "done");
    assert.equal(done.last, "The command finished with exit code 0. done");
    // What it said after coming back is in its thread.
    const thread = engine.readThread({ threadId: row.helperThreadId }).items.filter((i): i is BotItem => i.kind === "bot").map((i) => i.text);
    assert.deepEqual(thread, ["The background command is running, so I am waiting for it to finish.", "The command finished with exit code 0. done"]);
    harnessTurn(s, "done");
    await wait(80);
    b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.helpers, 0);
    // The row never read done until the end, and the bot never read done or idle in between.
    assert.deepEqual([...new Set(rowStatuses(events, row.id))], ["running", "done"]);
    assert.equal(rowStatuses(events, row.id).at(-1), "done");
    assert.equal(rowStatuses(events, row.id).indexOf("done"), rowStatuses(events, row.id).length - 1, "done once, at the end");
    const between = states(events.slice(from), bot.id).slice(0, -1);
    assert.ok(!between.some((x) => x.state === "done" || x.state === "idle"), between.map((x) => `${x.state}/${x.activity}`).join(" > "));
    engine.shutdown();
    store.close();
  });

  test("when its command ends and the harness never brings it back, it ends done after a moment and the bot settles", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    helperWaitsForItsCommand(s);
    ownTurnEnd(s, "Started.");
    await settle();
    s.emit({ type: "task-ended", taskId: BTASK, toolUseId: BASH, status: "completed", summary: "completed" });
    live(s, []);
    await wait(20);
    assert.equal(helpers(events)[0]!.status, "running", "not at once: the helper usually comes back");
    await wait(150);
    assert.equal(helpers(events)[0]!.status, "done");
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("Stop on the bot stops the helper's command, and its row says stopped", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    helperWaitsForItsCommand(s);
    ownTurnEnd(s, "Started.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(40);
    assert.ok(s.stopped.includes(BTASK), `stopped: ${s.stopped.join(", ")}`);
    s.emit({ type: "task-ended", taskId: BTASK, toolUseId: BASH, status: "stopped", summary: "stopped" });
    live(s, []);
    await wait(250);
    assert.equal(helpers(events)[0]!.status, "stopped");
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped");
    assert.equal(b.helpers, 0);
    engine.shutdown();
    store.close();
  });

  test("helper.stop on such a helper stops its command", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    helperWaitsForItsCommand(s);
    ownTurnEnd(s, "Started.");
    await settle();
    await engine.stopHelper({ botId: bot.id, itemId: helpers(events)[0]!.id });
    assert.deepEqual(s.stopped, [BTASK]);
    s.emit({ type: "task-ended", taskId: BTASK, toolUseId: BASH, status: "stopped", summary: "stopped" });
    live(s, []);
    // The harness may bring the helper back to hear of it; it ends, and its row says stopped.
    live(s, [[HTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "task-ended", taskId: HTASK, toolUseId: AGENT, status: "completed", summary: "The command was stopped." });
    live(s, []);
    await settle();
    assert.equal(helpers(events)[0]!.status, "stopped");
    engine.shutdown();
    store.close();
  });
});

// ------------------------------------------------------------ a helper given more to do

const SEND = "toolu_send";
const PTASK = "af16ee621d4bf51ed";

describe("waiting: a helper given more to do with SendMessage", () => {
  test("the same row works again with the new task in its thread, the bot is working meanwhile, and it settles after", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper that says a word");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: AGENT, name: "Agent", input: { description: "Say a word", prompt: "Reply with only the word: plover", run_in_background: true } });
    live(s, [[PTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: PTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: AGENT, isError: false, text: "Async agent launched successfully." });
    ownTurnEnd(s, "I started the helper.");
    s.emit({ type: "text-full", key: "p1", text: "Plover", parent: AGENT });
    s.emit({ type: "task-updated", taskId: PTASK, status: "completed" });
    s.emit({ type: "task-ended", taskId: PTASK, toolUseId: AGENT, status: "completed", summary: "Plover" });
    live(s, []);
    harnessTurn(s, "Plover");
    await wait(60);
    const row = helpers(events)[0]!;
    assert.equal(row.status, "done");
    assert.equal(botOf(events, bot.id).state, "done");

    // The bot gives the same helper a second task.
    await send(engine, sessions, bot.id, "Give it a second task");
    const from = events.length;
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: SEND, name: "SendMessage", input: { to: PTASK, message: "Reply with only the word: heron", summary: "Second task", recipient_kind: "agent" } });
    live(s, [[PTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: PTASK, toolUseId: SEND, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: SEND, isError: false, text: '{"success":true,"message":"Resuming agent af16ee6"}' });
    await settle();
    const again = helpers(events);
    assert.equal(again.length, 1, "the same row, no new one");
    assert.equal(again[0]!.id, row.id);
    assert.equal(again[0]!.status, "running");
    assert.equal(again[0]!.endedAt, undefined);
    assert.equal(botOf(events, bot.id).helpers, 1);
    const line = items(events.slice(from)).find((i) => i.kind === "activity");
    assert.equal(line && line.kind === "activity" ? line.label : "", "Gave a helper more to do");
    ownTurnEnd(s, "I sent it.");
    await settle();
    assert.equal(botOf(events, bot.id).state, "working");
    assert.equal(botOf(events, bot.id).activity, "Waiting for a helper");
    // Its messages name the call that first started it.
    s.emit({ type: "text-full", key: "p2", text: "heron", parent: AGENT });
    s.emit({ type: "task-updated", taskId: PTASK, status: "completed" });
    s.emit({ type: "task-ended", taskId: PTASK, toolUseId: SEND, status: "completed", summary: "heron" });
    live(s, []);
    await settle();
    assert.equal(helpers(events)[0]!.status, "done");
    assert.equal(helpers(events)[0]!.last, "heron");
    const thread = engine.readThread({ threadId: row.helperThreadId }).items;
    assert.deepEqual(
      thread.map((i) => (i.kind === "user" || i.kind === "bot" ? `${i.kind}:${i.text}` : i.kind)),
      ["user:Reply with only the word: plover", "bot:Plover", "user:Reply with only the word: heron", "bot:heron"],
    );
    harnessTurn(s, "heron");
    await wait(60);
    assert.equal(botOf(events, bot.id).state, "done");
    assert.equal(botOf(events, bot.id).helpers, 0);
    engine.shutdown();
    store.close();
  });

  test("a helper from before this engine's life gets a new row for the continuation, and its words land there", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Give your old helper more to do");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: SEND, name: "SendMessage", input: { to: "old-task", message: "Reply with only the word: heron", summary: "One more word" } });
    live(s, [["old-task", "local_agent"]]);
    s.emit({ type: "task-started", taskId: "old-task", toolUseId: SEND, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: SEND, isError: false, text: "Resuming agent" });
    ownTurnEnd(s, "Sent.");
    await settle();
    const row = helpers(events)[0]!;
    assert.ok(row, "a row for the continuation");
    assert.equal(row.title, "One more word");
    assert.equal(row.status, "running");
    assert.equal(botOf(events, bot.id).activity, "Waiting for a helper");
    s.emit({ type: "text-full", key: "o1", text: "heron", parent: "toolu_from_before" });
    s.emit({ type: "task-ended", taskId: "old-task", toolUseId: SEND, status: "completed", summary: "heron" });
    live(s, []);
    await settle();
    assert.equal(helpers(events)[0]!.status, "done");
    const said = engine.readThread({ threadId: row.helperThreadId }).items.filter((i): i is BotItem => i.kind === "bot").map((i) => i.text);
    assert.deepEqual(said, ["heron"]);
    engine.shutdown();
    store.close();
  });
});

// ------------------------------------------------------------ the bot's own command in the background

const OWN = "toolu_own";
const OTASK = "bsbmjfh3p";

function ownCommand(s: FakeSession) {
  s.emit({ type: "tool-start", toolUseId: OWN, name: "Bash", input: { command: 'node -e "setTimeout(()=>{},30000)"', run_in_background: true } });
  live(s, [[OTASK, "local_bash"]]);
  s.emit({ type: "task-started", taskId: OTASK, toolUseId: OWN, taskType: "local_bash", background: true, quiet: false });
  s.emit({ type: "tool-end", toolUseId: OWN, isError: false, text: "Command running in background with ID: bsbmjfh3p." });
}
function ownCommandEnds(s: FakeSession, status: "completed" | "stopped" = "completed") {
  s.emit({ type: "task-updated", taskId: OTASK, status: status === "stopped" ? "killed" : status });
  s.emit({ type: "task-ended", taskId: OTASK, toolUseId: OWN, status, summary: 'Background command "Wait" completed (exit code 0)' });
  live(s, []);
}

describe("waiting: the bot's own command in the background", () => {
  test("the bot reads working in the background, not done; nothing calm happens; the harness's turn after it ends leaves it done", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Run a command in the background");
    ownTurnStart(s);
    ownCommand(s);
    s.emit({ type: "text-full", key: "o", text: "The command is running." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true, usage: usage(120_000, { cache: "1h" }) });
    await settle();
    const from = events.length;
    let b = botOf(events, bot.id);
    assert.equal(b.state, "working");
    assert.equal(b.activity, "Working in the background");
    assert.equal(b.helpers ?? 0, 0, "a command is not a helper");
    assert.equal(helpers(events).length, 0);

    assert.throws(
      () => engine.startFresh(bot.id),
      (e: unknown) => e instanceof EngineError && e.code === "conflict" && e.message === "Po is still working in the background. Try again when it is done.",
    );
    engine.checkContext();
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# New job\n" });
    await settle();
    assert.equal(s.closed, false, "the session is not closed under the command");
    assert.equal(items(events).filter((i) => i.kind === "user" && i.from.type === "app").length, 0, "no tidy turn");

    ownCommandEnds(s);
    harnessTurn(s, "The command finished.");
    await wait(80);
    b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Finished");
    const between = states(events.slice(from), bot.id).slice(0, -1);
    assert.ok(!between.some((x) => x.state === "done" || x.state === "idle"), between.map((x) => `${x.state}/${x.activity}`).join(" > "));
    assert.equal(s.closed, true, "now the session restarts for the new job");
    engine.shutdown();
    store.close();
  });

  test("when the command ends and the harness begins no turn, the bot settles done", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    assert.equal(botOf(events, bot.id).state, "working");
    ownCommandEnds(s);
    await settle();
    assert.equal(botOf(events, bot.id).state, "working", "a moment for the harness to wake the bot");
    await wait(80);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("Stop on the bot stops the command and says so", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(40);
    assert.ok(s.stopped.includes(OTASK));
    ownCommandEnds(s, "stopped");
    await wait(80);
    const b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped");
    const said = items(events).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);
    assert.deepEqual(said, ["Stopped."], "the command was confirmed as stopped; nothing more to say");
    await wait(200);
    assert.deepEqual(items(events).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text), ["Stopped."]);
    engine.shutdown();
    store.close();
  });

  test("a command the harness never confirms as stopped is let go, and the chat says it may still run", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    await wait(300);
    assert.equal(botOf(events, bot.id).state, "done");
    const said = items(events).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);
    assert.deepEqual(said, ["Stopped.", "A command in the background may still be running."]);
    engine.shutdown();
    store.close();
  });

  test("Stop touches only what ran when it was pressed: a command started right after in a new turn goes on", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    await engine.interrupt(bot.id);
    // Before the nudge: the old command is confirmed stopped, and a new turn starts a new command.
    ownCommandEnds(s, "stopped");
    await send(engine, sessions, bot.id, "Start another");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: "toolu_new", name: "Bash", input: { command: "node -e 1", run_in_background: true } });
    live(s, [["new-task", "local_bash"]]);
    s.emit({ type: "task-started", taskId: "new-task", toolUseId: "toolu_new", taskType: "local_bash", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: "toolu_new", isError: false, text: "Command running in background" });
    ownTurnEnd(s, "Running again.");
    await wait(300);
    assert.ok(!s.stopped.includes("new-task"), `stopped: ${s.stopped.join(", ")}`);
    assert.equal(botOf(events, bot.id).activity, "Working in the background", "the new command still counts");
    assert.ok(!items(events).some((i) => i.kind === "notice" && /may still be running/.test(i.text)));
    engine.shutdown();
    store.close();
  });

  test("a quiet task (one the harness marks as not activity) does not keep the bot working", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    live(s, [["watch-1", "local_bash", undefined, true]]);
    s.emit({ type: "task-started", taskId: "watch-1", taskType: "local_bash", background: true, quiet: true });
    ownTurnEnd(s, "Done.");
    await wait(60);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("a fresh run waits for the bot's command; a message for the main chat starts at once and the run's session is set aside (engine 0.24.1)", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "New ticket", prompt: "Look at the ticket.", where: "fresh", enabled: true } });
    const run = engine.runTrigger(t.id);
    await settle();
    const s = sessions.at(-1)!;
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "A command is checking the ticket.");
    await settle();
    assert.equal(store.getRun(run.id)!.status, "running");
    assert.equal(s.closed, false);
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    assert.equal(items(events).filter((i): i is UserItem => i.kind === "user" && i.text === "Hello")[0]!.queued, false, "answered at once");
    const main = sessions.at(-1)!;
    assert.notEqual(main, s);
    assert.equal(s.closed, false, "the run's session goes on beside it");
    ownTurnStart(main);
    ownTurnEnd(main, "Hi.");
    await settle();
    ownCommandEnds(s);
    harnessTurn(s, "The ticket is about a login. Nothing else to do.");
    await settle();
    assert.equal(store.getRun(run.id)!.status, "done");
    assert.equal(s.closed, true);
    engine.shutdown();
    store.close();
  });

  test("when the harness process ends under a command, the bot does not keep waiting", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    ownCommand(s);
    ownTurnEnd(s, "Running.");
    await settle();
    s.emit({ type: "exit", error: "killed", beforeInit: false });
    await wait(80);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });
});

describe("waiting: after the review", () => {
  test("a helper the harness lists with no row (its start was missed) counts as a helper, holds the session, and Stop stops it", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    live(s, [["lost-helper", "local_agent"]]);
    ownTurnEnd(s, "On it.");
    await settle();
    let b = botOf(events, bot.id);
    assert.equal(b.state, "working");
    assert.equal(b.activity, "Waiting for a helper");
    assert.equal(b.helpers, 1);
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# New job\n" });
    await settle();
    assert.equal(s.closed, false, "the session stays under it");
    await engine.interrupt(bot.id);
    await wait(40);
    assert.ok(s.stopped.includes("lost-helper"), `stopped: ${s.stopped.join(", ")}`);
    s.emit({ type: "task-ended", taskId: "lost-helper", status: "stopped", summary: "" });
    live(s, []);
    await wait(80);
    b = botOf(events, bot.id);
    assert.equal(b.state, "done");
    assert.equal(b.helpers, 0);
    engine.shutdown();
    store.close();
  });

  test("a helper stopped on request that the harness brings back under its first call keeps the bot working, without its row coming back", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: AGENT, name: "Agent", input: { description: "Busy", prompt: "Work", run_in_background: true } });
    live(s, [[HTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: AGENT, isError: false, text: "Async agent launched successfully." });
    ownTurnEnd(s, "On it.");
    await settle();
    await engine.stopHelper({ botId: bot.id, itemId: helpers(events)[0]!.id });
    s.emit({ type: "task-ended", taskId: HTASK, toolUseId: AGENT, status: "stopped", summary: "" });
    live(s, []);
    await settle();
    assert.equal(helpers(events)[0]!.status, "stopped");
    live(s, [[HTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
    await settle();
    assert.equal(helpers(events)[0]!.status, "stopped", "a helper stopped on request does not come back by itself");
    assert.equal(botOf(events, bot.id).state, "working");
    assert.equal(botOf(events, bot.id).activity, "Waiting for a helper");
    s.emit({ type: "task-ended", taskId: HTASK, toolUseId: AGENT, status: "completed", summary: "" });
    live(s, []);
    await wait(80);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("a waiting helper stopped without confirmation: once its command leaves the list without a notice, the bot settles", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    helperWaitsForItsCommand(s);
    ownTurnEnd(s, "Started.");
    await settle();
    await engine.stopHelper({ botId: bot.id, itemId: helpers(events)[0]!.id });
    await wait(220);
    assert.equal(helpers(events)[0]!.status, "stopped", "marked stopped after the grace");
    assert.equal(botOf(events, bot.id).state, "working", "its command is still listed");
    assert.equal(botOf(events, bot.id).activity, "Working in the background");
    // The command leaves the list, with no notification.
    live(s, []);
    await wait(80);
    assert.equal(botOf(events, bot.id).state, "done");
    engine.shutdown();
    store.close();
  });

  test("a missing helper ends on time even while other tasks keep changing the list more often than the grace", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: AGENT, name: "Agent", input: { description: "Busy", prompt: "Work", run_in_background: true } });
    live(s, [[HTASK, "local_agent"]]);
    s.emit({ type: "task-started", taskId: HTASK, toolUseId: AGENT, taskType: "local_agent", background: true, quiet: false });
    s.emit({ type: "tool-end", toolUseId: AGENT, isError: false, text: "Async agent launched successfully." });
    s.emit({ type: "text-full", key: "x", text: "Partly done.", parent: AGENT });
    ownTurnEnd(s, "On it.");
    await settle();
    // The helper drops out of the list with no notice; a busy neighbour keeps changing the list every 10 ms.
    const started = Date.now();
    for (let i = 0; i < 20 && helpers(events)[0]!.status === "running"; i++) {
      live(s, i % 2 ? [["n1", "local_bash"]] : [["n1", "local_bash"], ["n2", "local_bash"]]);
      await wait(10);
    }
    assert.equal(helpers(events)[0]!.status, "done", `still running after ${Date.now() - started} ms`);
    engine.shutdown();
    store.close();
  });

  test("a tidy turn during which a helper comes back does not start fresh or close the session; a waiting restart waits too", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Hello");
    s.reply("Hi.");
    await settle();
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    // During the tidy turn a helper comes back, and the job changes.
    ownTurnStart(s);
    live(s, [["back-helper", "local_agent"]]);
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# New job\n" });
    ownTurnEnd(s, "Note for later: the person said hello.");
    await settle();
    assert.equal(s.closed, false, "the session stays while the helper works");
    assert.ok(!items(events).some((i) => i.kind === "notice" && i.mark === "fresh"), "no fresh start");
    assert.equal(botOf(events, bot.id).state, "working");
    assert.equal(botOf(events, bot.id).activity, "Waiting for a helper");
    s.emit({ type: "task-ended", taskId: "back-helper", status: "completed", summary: "" });
    live(s, []);
    await wait(80);
    assert.equal(s.closed, true, "now the waiting restart for the new job happens");
    assert.notEqual(botOf(events, bot.id).state, "working");
    engine.shutdown();
    store.close();
  });
});

describe("waiting: helpers started with start_helper", () => {
  test("one in the background is not ended by the bot harness's list of live tasks, which does not hold it", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper");
    const input = { title: "Say a word", task: "Reply with only the word: wren", model: "claude-haiku-5-5", effort: "low", wait: false };
    ownTurnStart(s);
    s.emit({ type: "tool-start", toolUseId: "tu-p1", name: "mcp__pobots__start_helper", input });
    const r = await s.tool("start_helper", input);
    assert.match(r.content[0]!.text, /^Started helper \w{8} /);
    s.emit({ type: "tool-end", toolUseId: "tu-p1", isError: false, text: r.content[0]!.text });
    live(s, []);
    ownTurnEnd(s, "I started a helper.");
    await wait(150);
    assert.equal(helpers(events)[0]!.status, "running", "the bot's own harness does not know this helper");
    assert.equal(botOf(events, bot.id).activity, "Waiting for a helper");
    const hs = sessions.find((x) => x !== s)!;
    hs.reply("wren");
    await settle();
    assert.equal(helpers(events)[0]!.status, "done");
    engine.shutdown();
    store.close();
  });
});

describe("waiting: how the real session reads the list of live tasks", () => {
  test("background_tasks_changed gives each task's type, the helper that started it, and whether it is quiet", () => {
    const got: HarnessEvent[] = [];
    const cs = new ClaudeSession({
      botId: "po",
      botName: "Po",
      botDir: tempDir(),
      model: "claude-haiku-5-5",
      effort: "low",
      access: "asks-first",
      executable: "/fake/claude",
      env: {},
      tools: [],
      rules: [],
      team: "",
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      onEvent: (e) => got.push(e),
    });
    const handle = (m: unknown) => (cs as unknown as { handle(m: unknown): void }).handle(m);
    handle({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: HTASK, task_type: "local_agent", description: "Wait for a command" },
        { task_id: BTASK, task_type: "local_bash", description: "Wait", parent_task_id: HTASK },
        { task_id: "m1", task_type: "monitor", description: "Watch", ambient: true },
      ],
      session_id: "s",
      uuid: "u",
    });
    assert.deepEqual(got, [
      {
        type: "tasks-live",
        taskIds: [HTASK, BTASK, "m1"],
        tasks: [
          { taskId: HTASK, taskType: "local_agent", quiet: false },
          { taskId: BTASK, taskType: "local_bash", parentTaskId: HTASK, quiet: false },
          { taskId: "m1", taskType: "monitor", quiet: true },
        ],
      },
    ]);
  });
});
