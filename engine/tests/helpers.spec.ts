// Step 2e: helpers you can see. A helper (the harness's own subagent) becomes a row in the thread
// where the bot started it and a thread of its own; a bot with helpers working is working; a turn
// the harness begins by itself when a helper reports back is a real turn. Fake harness, played the
// way the real one sent things in the probes (docs/build/notes-engine-2e.md).
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { ActivityItem, Bot, BotItem, Events, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import { ClaudeSession, type HarnessEvent } from "../claude/session.js";
import { helperLine, helperTitle, type Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { MIGRATIONS, Store } from "../store.js";
import { lastState, settle, setup, upserts, usage, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const FAST = { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(extra: Parameters<typeof setup>[2] = {}, dirs?: { dataDir: string; botsDir: string }) {
  return setup(dirs, () => true, { ...FAST, ...extra });
}

/** The latest version of each item, in the order first seen. */
const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const helpers = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const helperUpserts = (events: Ev[], id: string) => upserts(events).filter((i): i is HelperItem => i.kind === "helper" && i.id === id);
const inThread = (events: Ev[], threadId: string) => items(events).filter((i) => i.threadId === threadId);
const botOf = (events: Ev[], id: string): Bot | undefined => lastState(events, id);
const states = (events: Ev[], id: string) =>
  events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);

/** A message to the bot, and the session that takes it. */
async function send(engine: Engine, sessions: FakeSession[], botId: string, text: string) {
  engine.sendMessage({ botId, text });
  await settle();
  return sessions.at(-1)!;
}

/** The bot's own turn: it starts, begins the turn, and (unless `end` is false) ends with `text`. */
function ownTurn(s: FakeSession, text: string, body?: () => void, end = true) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  body?.();
  if (!end) return;
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

describe("helpers: a row and a thread", () => {
  test("a helper the bot waits for: one row, its own thread with the task, its words and steps, and nothing of it in the bot's thread", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "What word is in notes.txt?");
    ownTurn(s, "", () => {
      s.helperStart("h1", { description: "Read the **word** file", prompt: "Read notes.txt and report the single word in it." });
    }, false);
    const row = helpers(events)[0]!;
    assert.ok(row, "no helper row");
    assert.equal(row.threadId, bot.mainThreadId);
    assert.equal(row.title, "Read the word file", "the title is plain text");
    assert.equal(row.status, "running");
    assert.equal(row.background, false);
    assert.equal(row.steps, 0);
    assert.ok(row.turnId, "the row belongs to the bot's turn");
    assert.match(botOf(events, bot.id)!.activity, /^A helper is working: read the/);
    assert.equal(botOf(events, bot.id)?.helpers, 1);
    assert.equal(items(events).filter((i) => i.kind === "activity" && i.threadId === bot.mainThreadId).length, 0, "no activity line in place of the row");

    const thread = store.getThread(row.helperThreadId)!;
    assert.equal(thread.kind, "helper");
    assert.equal(thread.parentItemId, row.id);
    const first = engine.readThread({ threadId: row.helperThreadId }).items[0] as UserItem;
    assert.equal(first.kind, "user");
    assert.deepEqual(first.from, { type: "bot", botId: bot.id, expectsReply: true });
    assert.equal(first.text, "Read notes.txt and report the single word in it.");

    s.helperSay("h1", "Let me look.");
    s.helperTool("h1", "Read", { file_path: "/x/notes.txt" });
    s.helperSay("h1", "The word is **pelican**.");
    s.helperEnd("h1", "completed", "The word is **pelican**.");
    await settle();
    const done = helpers(events)[0]!;
    assert.equal(done.status, "done");
    assert.equal(done.steps, 1);
    assert.equal(done.last, "The word is pelican.", "the end of the row is the start of the result, without markdown marks");
    assert.ok(done.endedAt);
    const h = engine.readThread({ threadId: row.helperThreadId }).items;
    assert.deepEqual(
      h.map((i) => i.kind),
      ["user", "bot", "activity", "bot"],
    );
    assert.equal((h[2] as ActivityItem).label, "Read notes.txt");
    assert.equal((h[2] as ActivityItem).status, "done");
    assert.equal((h[3] as BotItem).botId, bot.id);
    assert.equal((h[3] as BotItem).streaming, false);
    assert.ok(h.every((i) => !i.turnId), "a helper's thread is not part of the bot's turn");
    assert.equal(inThread(events, bot.mainThreadId).filter((i) => i.kind === "bot").length, 0, "nothing the helper said is in the bot's chat");

    s.emit({ type: "text-full", key: "z", text: "The word is pelican." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "done");
    assert.equal(botOf(events, bot.id)?.helpers, 0);
    engine.shutdown();
    store.close();
  });

  test("a result handed back with the harness's tool reads as the helper's message, once, and ends the row", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "What is the first heading?");
    ownTurn(s, "", () => s.helperStart("h1", { description: "Read the heading" }), false);
    s.helperTool("h1", "Read", { file_path: "/x/AGENTS.md" });
    s.helperTool("h1", "mcp__pobots__SubagentHandback", { message: "The heading is **Kaja**." });
    s.helperTool("h1", "SubagentHandback", { message: "The heading is **Kaja**." });
    s.helperEnd("h1", "completed", 'This agent\'s report was delivered to you as a message from "a0ac" (its SubagentHandback call). Read it there; it is not repeated here.');
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.status, "done");
    assert.equal(row.steps, 1, "handing back is not a step of work");
    assert.equal(row.last, "The heading is Kaja.", "the row ends with the result, not with the harness's pointer to it");
    const h = engine.readThread({ threadId: row.helperThreadId }).items;
    assert.deepEqual(h.map((i) => i.kind), ["user", "activity", "bot"]);
    assert.equal((h[2] as BotItem).text, "The heading is **Kaja**.");
    engine.shutdown();
    store.close();
  });

  test("a title falls back to Helper, and a long description is one line", () => {
    assert.equal(helperTitle(undefined), "Helper");
    assert.equal(helperTitle("  "), "Helper");
    assert.equal(helperTitle("Inventory\nthe `work-bot` agents"), "Inventory the work-bot agents");
    assert.ok(helperTitle("x".repeat(300)).length <= 120);
  });

  test("background shells and quiet tasks are not helpers, and a late message of an ended helper goes nowhere", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "Done.", () => {
      s.emit({ type: "tool-start", toolUseId: "b1", name: "Bash", input: { command: "sleep 5", run_in_background: true } });
      s.emit({ type: "task-started", taskId: "bash-1", toolUseId: "b1", taskType: "local_bash", background: true, quiet: false });
      s.emit({ type: "task-started", taskId: "amb-1", taskType: "local_agent", background: true, quiet: true });
      s.emit({ type: "tool-end", toolUseId: "b1", isError: false, text: "Command running in background" });
      s.emit({ type: "text-full", key: "late", text: "I am a ghost", parent: "nobody" });
    });
    await settle();
    assert.equal(helpers(events).length, 0);
    assert.ok(items(events).some((i) => i.kind === "activity" && i.label.startsWith("Ran")), "the shell keeps its activity line");
    assert.ok(!items(events).some((i) => i.kind === "bot" && i.text === "I am a ghost"));
    // Since step 3b the bot's own command in the background keeps it working until it ends (waiting.spec.ts).
    assert.equal(botOf(events, bot.id)?.state, "working");
    assert.equal(botOf(events, bot.id)?.activity, "Working in the background");
    s.emit({ type: "task-ended", taskId: "bash-1", toolUseId: "b1", status: "completed", summary: "Background command completed (exit code 0)" });
    await wait(20);
    assert.equal(botOf(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("a helper started by a helper is a row in the first helper's thread", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Nested");
    ownTurn(s, "", () => {
      s.helperStart("outer", { description: "Outer helper" });
      s.helperStart("inner", { description: "Inner helper", parent: "outer" });
      s.helperTool("inner", "Read", { file_path: "/x/notes.txt" });
      s.helperSay("inner", "pelican");
      s.helperEnd("inner", "completed", "pelican", { parent: "outer" });
      s.helperSay("outer", "The inner helper said pelican.");
      s.helperEnd("outer", "completed", "The inner helper said pelican.");
    }, false);
    await settle();
    const [outer, inner] = helpers(events);
    assert.equal(outer!.threadId, bot.mainThreadId);
    assert.equal(inner!.threadId, outer!.helperThreadId, "the inner row stands in the outer helper's thread");
    assert.equal(inner!.status, "done");
    assert.equal(outer!.status, "done");
    assert.equal(outer!.steps, 1, "starting the inner helper is a step of the outer one");
    assert.equal(inner!.steps, 1);
    const outerThread = engine.readThread({ threadId: outer!.helperThreadId }).items.map((i) => i.kind);
    assert.deepEqual(outerThread, ["user", "helper", "bot"]);
    assert.equal(inThread(events, bot.mainThreadId).filter((i) => i.kind === "helper").length, 1);
    engine.shutdown();
    store.close();
  });

  test("a helper that fails says so, and a card raised by a helper's tool is the bot's card", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Try");
    ownTurn(s, "", () => s.helperStart("h1", { description: "Change a file", background: true }), false);
    // The helper's tool needs approval while the bot's own turn is still running.
    const asked = s.settings.canUseTool("Bash", { command: "touch a.txt" }, { signal: new AbortController().signal, toolUseID: "t1", agentID: "task-h1" } as never);
    await settle();
    const card = events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).at(-1)!;
    assert.ok(card && card.kind !== "system");
    assert.equal(card.botId, bot.id);
    assert.equal(card.threadId, bot.mainThreadId);
    assert.equal(botOf(events, bot.id)?.state, "waiting");
    // The bot's turn ends; the helper's card stays open.
    s.emit({ type: "text-full", key: "a", text: "A helper is on it." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.ok(!events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).cardId === card.id), "the helper's card outlived the bot's turn");
    engine.resolveCard(card.id, { type: "allow-once" });
    const r = await asked;
    assert.equal(r?.behavior, "allow");
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "working");
    assert.equal(botOf(events, bot.id)?.activity, "Waiting for a helper");
    s.helperEnd("h1", "failed", "Could not write the file: permission denied", { background: true });
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.status, "failed");
    assert.equal(row.last, "Could not write the file: permission denied");
    engine.shutdown();
    store.close();
  });
});

describe("helpers: the row stays true", () => {
  test("a background helper stays running after its tool call returns, and the bot waits for it after its turn", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper in the background");
    ownTurn(s, "I started a helper.", () => s.helperStart("h1", { description: "Read the word file", background: true }));
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.status, "running", "the quick tool result does not end it");
    assert.equal(row.background, true);
    const b = botOf(events, bot.id)!;
    assert.equal(b.state, "working");
    assert.equal(b.activity, "Waiting for a helper");
    assert.equal(b.helpers, 1);
    assert.ok(!states(events, bot.id).slice(-3).some((x) => x.state === "done"), "no done mark while it works");

    // A second one makes it two.
    const s2 = await send(engine, sessions, bot.id, "And one more");
    assert.equal(s2, s, "the same session");
    const userItem = items(events).filter((i): i is UserItem => i.kind === "user" && i.text === "And one more")[0]!;
    assert.equal(userItem.queued, false, "a message while helpers work starts a turn at once");
    ownTurn(s, "Another one is on it.", () => s.helperStart("h2", { description: "Second", background: true, alsoLive: ["task-h1"] }));
    await settle();
    assert.equal(botOf(events, bot.id)?.activity, "Waiting for 2 helpers");
    assert.equal(botOf(events, bot.id)?.helpers, 2);
    engine.shutdown();
    store.close();
  });

  test("a waiting helper moved to the background turns background", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "", () => s.helperStart("h1", { description: "Slow" }), false);
    s.emit({ type: "task-updated", taskId: "task-h1", background: true });
    s.emit({ type: "tool-end", toolUseId: "h1", isError: false, text: "The agent is running in the background" });
    await settle();
    const row = helpers(events)[0]!;
    assert.equal(row.background, true);
    assert.equal(row.status, "running");
    engine.shutdown();
    store.close();
  });

  test("the last line: plain, one line, at most 160 characters, and sent at most about once a second", async () => {
    const long = "# Result\n\n" + "**word** ".repeat(60);
    const line = helperLine(long);
    assert.ok(line.length <= 160);
    assert.ok(!/[#*\n]/.test(line));
    assert.ok(line.endsWith("…"));
    assert.equal(helperLine("- [a link](https://example.com) and `code`"), "a link and code");

    const { engine, sessions, events, store } = setup(undefined, () => true, { ...FAST, helperRowMs: 200 });
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }));
    await wait(250);
    const row = helpers(events)[0]!;
    const before = helperUpserts(events, row.id).length;
    for (let i = 0; i < 10; i++) s.helperTool("h1", "Read", { file_path: `/x/f${i}.txt` });
    await settle();
    assert.equal(helperUpserts(events, row.id).length - before, 1, "only the first change goes at once");
    await wait(260);
    const after = helperUpserts(events, row.id);
    assert.equal(after.length - before, 2, "the rest follow together after the pause");
    assert.equal(after.at(-1)!.steps, 10);
    assert.equal(after.at(-1)!.last, "Read f9.txt");
    s.helperEnd("h1", "completed", "Finished reading.", { background: true });
    assert.equal(helperUpserts(events, row.id).at(-1)!.status, "done", "a status change goes at once");
    engine.shutdown();
    store.close();
  });
});

describe("helpers: a turn the harness begins by itself", () => {
  test("it has an id, keeps the bot busy, queues a message, and ends done, never thinking", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper");
    ownTurn(s, "Started.", () => s.helperStart("h1", { description: "Read the word file", background: true }));
    await settle();
    s.helperSay("h1", "pelican");
    s.helperEnd("h1", "completed", "pelican", { background: true });
    // The harness wakes the bot.
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: false });
    s.emit({ type: "thinking" });
    s.emit({ type: "text-start", key: "w1" });
    s.emit({ type: "text-delta", key: "w1", text: "The word is pelican." });
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "thinking");
    const wakeItem = items(events).filter((i): i is BotItem => i.kind === "bot" && i.threadId === bot.mainThreadId).at(-1)!;
    assert.ok(wakeItem.turnId, "the harness's turn has an id");
    const firstTurn = helpers(events)[0]!.turnId;
    assert.notEqual(wakeItem.turnId, firstTurn);
    // A message now waits in line, as in any turn.
    engine.sendMessage({ botId: bot.id, text: "Thanks" });
    await settle();
    const queued = items(events).filter((i): i is UserItem => i.kind === "user" && i.text === "Thanks")[0]!;
    assert.equal(queued.queued, true);
    s.emit({ type: "text-end", key: "w1" });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: false });
    await settle();
    // Then the queued message's turn.
    assert.equal(items(events).filter((i): i is UserItem => i.kind === "user" && i.text === "Thanks")[0]!.queued, false);
    assert.equal(s.sent.at(-1)!.text, "Thanks");
    s.reply("You are welcome.");
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("the fault from the real machine: after a turn the harness began, the bot is done, not thinking", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Start a helper");
    ownTurn(s, "Started.", () => s.helperStart("h1", { description: "Read", background: true }));
    s.helperEnd("h1", "completed", "pelican", { background: true });
    s.wake("The word is pelican.");
    await settle();
    const b = botOf(events, bot.id)!;
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Finished");
    assert.equal(b.helpers, 0);
    const wakeText = items(events).filter((i): i is BotItem => i.kind === "bot" && i.text === "The word is pelican.")[0]!;
    assert.ok(wakeText.turnId);
    assert.equal(wakeText.streaming, false);
    engine.shutdown();
    store.close();
  });

  test("even without the init signal, text from the harness while no turn runs starts a turn", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Hi");
    s.reply("Hello");
    await settle();
    s.emit({ type: "text-start", key: "x" });
    s.emit({ type: "text-delta", key: "x", text: "One more thing." });
    s.emit({ type: "text-end", key: "x" });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], own: false });
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "done");
    assert.ok(items(events).filter((i): i is BotItem => i.kind === "bot" && i.text === "One more thing.")[0]!.turnId);
    engine.shutdown();
    store.close();
  });

  test("when the harness runs its own turn before taking up our message, our turn goes on until its own end", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "First");
    s.reply("One.");
    await settle();
    engine.sendMessage({ botId: bot.id, text: "Second" });
    await settle();
    s.emit({ type: "turn-start", own: false });
    s.emit({ type: "text-full", key: "a", text: "The helper reported." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], own: false });
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "thinking", "still in the message's turn");
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "text-full", key: "b", text: "Two." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], own: true });
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "done");
    engine.shutdown();
    store.close();
  });

  test("a bot that asked and got the first answer is told the last message of the turn that follows", async () => {
    const { engine, sessions, events, store } = world();
    const po = engine.createBot("Po");
    const kaja = engine.createBot("Kaja");
    const sPo = await send(engine, sessions, po.id, "Ask Kaja");
    const asking = sPo.tool("message_bot", { to: "Kaja", text: "What word is in your notes?", mode: "ask" });
    await settle();
    const sKaja = sessions.filter((x) => x.settings.botId === kaja.id).at(-1)!;
    ownTurn(sKaja, "I started a helper; the word follows.", () => sKaja.helperStart("h1", { description: "Read notes", background: true }));
    const answer = await asking;
    assert.match(answer.content[0]!.text, /the word follows/);
    sPo.reply("Kaja is on it.");
    await settle();
    sKaja.helperEnd("h1", "completed", "heron", { background: true });
    sKaja.wake("The word is heron.");
    await settle();
    const told = items(events).filter((i): i is UserItem => i.kind === "user" && i.threadId === po.mainThreadId && i.from.type === "bot").at(-1)!;
    assert.equal(told.text, "The word is heron.");
    assert.deepEqual(told.from, { type: "bot", botId: kaja.id, expectsReply: false });
    engine.shutdown();
    store.close();
  });

  test("a channel's message: the last message of the turn that follows is posted there too", async () => {
    const flow = await standIn();
    const { engine, sessions, events, store } = world({ replyRetryMs: 30, replyTimeoutMs: 400 });
    const po = engine.createBot("Po");
    const ch = engine.saveChannel({ channel: { name: "Ops - Internal", allowedSenders: ["ada@example.com"], routes: [{ tag: "Po", botId: po.id }], replyUrl: flow.url } });
    const out = engine.channelCall(ch.id, { messageId: "m-1", threadId: "th-1", from: { name: "Ada Example", email: "ada@example.com" }, text: "Po what word is in the notes?" });
    assert.equal(out.status, 202);
    await settle();
    const s = sessions.at(-1)!;
    ownTurn(s, "A helper is reading the notes.", () => s.helperStart("h1", { description: "Read notes", background: true }));
    await settle();
    await engine.repliesSent();
    assert.equal(flow.got.length, 1);
    s.helperEnd("h1", "completed", "heron", { background: true });
    s.wake("The word is heron.");
    await settle();
    await engine.repliesSent();
    assert.equal(flow.got.length, 2);
    assert.equal(flow.got[1]!.body.text, "The word is heron.");
    const said = items(events).filter((i): i is NoticeItem => i.kind === "notice" && i.text === "Answered in Ops - Internal");
    assert.equal(said.length, 2);
    engine.shutdown();
    store.close();
    await flow.close();
  });
});

describe("helpers: a bot with helpers is never calm", () => {
  test("no fresh start while helpers work: startFresh is a conflict and no rule tidies", async () => {
    const clock = { t: Date.parse("2026-11-11T10:00:00Z") };
    const { engine, sessions, events, store } = setup(undefined, () => true, FAST, { clock: () => clock.t });
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    // A big session with a one hour cache: rule 1 would tidy it 53 minutes later.
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }), false);
    s.emit({ type: "text-full", key: "k", text: "On it." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true, usage: usage(120_000, { cache: "1h" }) });
    await settle();
    clock.t += 53 * 60_000;
    assert.throws(
      () => engine.startFresh(bot.id),
      (e: unknown) => e instanceof EngineError && e.code === "conflict" && e.message === "Po's helpers are working. Try again when they are done.",
    );
    engine.checkContext();
    await settle();
    assert.equal(items(events).filter((i) => i.kind === "user" && i.from.type === "app").length, 0, "no tidy turn");
    assert.equal(s.closed, false, "the session stays");
    engine.shutdown();
    store.close();
  });

  test("a fresh run waits for its helpers, and passes on the last message after them; a message for the main chat does not wait (engine 0.24.1)", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "New ticket", prompt: "Look at the ticket.", where: "fresh", enabled: true } });
    const run = engine.runTrigger(t.id);
    await settle();
    const s = sessions.at(-1)!;
    ownTurn(s, "A helper is reading the ticket.", () => s.helperStart("h1", { description: "Read the ticket", background: true }));
    await settle();
    const running = () => store.getRun(run.id)!;
    assert.equal(running().status, "running", "the run waits for its helper");
    assert.equal(s.closed, false, "its session stays while the helper works");
    // A message for the main chat starts at once, in a session of its own; the run's session is set aside.
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    assert.equal(items(events).filter((i): i is UserItem => i.kind === "user" && i.text === "Hello")[0]!.queued, false);
    const main = sessions.at(-1)!;
    assert.notEqual(main, s);
    assert.equal(s.closed, false, "the run's session goes on while its helper works");
    main.reply("Hi.");
    await settle();
    s.helperEnd("h1", "completed", "Ticket 42 is about a login.", { background: true });
    s.wake("Ticket 42 is about a login. Nothing else to do.");
    await settle();
    assert.equal(running().status, "done");
    assert.equal(running().note, "Ticket 42 is about a login. Nothing else to do.");
    const result = items(events).filter((i): i is UserItem => i.kind === "user" && i.threadId === bot.mainThreadId && i.from.type === "trigger").at(-1)!;
    assert.match(result.text, /Nothing else to do/);
    assert.equal(s.closed, true, "the run's session ends with the run");
    engine.shutdown();
    store.close();
  });

  test("the session never sleeps while helpers work, and the bot reads done once they end without a turn", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }));
    await settle();
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# New job\n" });
    await settle();
    assert.equal(s.closed, false, "a changed job waits for the helper");
    s.helperEnd("h1", "completed", "Done.", { background: true });
    await wait(20);
    assert.equal(botOf(events, bot.id)?.state, "done", "done once the last helper ended and nothing followed");
    assert.equal(s.closed, true, "and now the session restarts for the new job");
    engine.shutdown();
    store.close();
  });
});

describe("helpers: stopping", () => {
  test("helper.stop stops one helper through the harness; the row says stopped when the harness confirms", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }));
    await settle();
    const row = helpers(events)[0]!;
    await engine.stopHelper({ botId: bot.id, itemId: row.id });
    assert.deepEqual(s.stopped, ["task-h1"]);
    assert.equal(helpers(events)[0]!.status, "running", "not before the harness says so");
    s.helperEnd("h1", "stopped", "Busy", { background: true });
    await settle();
    assert.equal(helpers(events)[0]!.status, "stopped");
    // The harness tells the bot and it carries on.
    s.wake("The helper was stopped, so I have no result.");
    await settle();
    assert.equal(botOf(events, bot.id)?.state, "done");
    // Once ended, stopping again is no error; an unknown item is.
    await engine.stopHelper({ botId: bot.id, itemId: row.id });
    await assert.rejects(engine.stopHelper({ botId: bot.id, itemId: "nope" }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    engine.shutdown();
    store.close();
  });

  test("a helper that never confirms is marked stopped anyway", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }));
    await settle();
    await engine.stopHelper({ botId: bot.id, itemId: helpers(events)[0]!.id });
    await wait(100);
    assert.equal(helpers(events)[0]!.status, "stopped");
    engine.shutdown();
    store.close();
  });

  test("turn.interrupt works when only helpers work, and stops them all", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "Two helpers are on it.", () => {
      s.helperStart("h1", { description: "One", background: true });
      s.helperStart("h2", { description: "Two", background: true, alsoLive: ["task-h1"] });
    });
    await settle();
    assert.equal(botOf(events, bot.id)?.activity, "Waiting for 2 helpers");
    await engine.interrupt(bot.id);
    assert.equal(s.interrupts, 1, "the harness's interrupt is used");
    // The interrupt spares helpers in the background (perTaskStopAffordance): each is asked to stop at once.
    assert.deepEqual(s.stopped, ["task-h1", "task-h2"]);
    s.helperEnd("h1", "stopped", "One", { background: true });
    await wait(30);
    assert.deepEqual(s.stopped, ["task-h1", "task-h2"], "once each");
    s.helperEnd("h2", "stopped", "Two", { background: true });
    await wait(20);
    assert.deepEqual(helpers(events).map((h) => h.status), ["stopped", "stopped"]);
    const b = botOf(events, bot.id)!;
    assert.equal(b.state, "done");
    assert.equal(b.activity, "Stopped");
    assert.equal(b.helpers, 0);
    const said = items(events).filter((i): i is NoticeItem => i.kind === "notice" && i.threadId === bot.mainThreadId).map((n) => n.text);
    assert.deepEqual(said, ["Stopped. 2 helpers were stopped before they reported back."], "the chat says that no result is coming");
    engine.shutdown();
    store.close();
  });

  test("turn.interrupt during a turn stops the turn and the helpers", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "", () => s.helperStart("h1", { description: "One", background: true }), false);
    await engine.interrupt(bot.id);
    s.helperEnd("h1", "stopped", "One", { background: true });
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: [], own: true });
    await wait(20);
    assert.equal(helpers(events)[0]!.status, "stopped");
    assert.equal(botOf(events, bot.id)?.state, "done");
    assert.equal(botOf(events, bot.id)?.activity, "Stopped");
    engine.shutdown();
    store.close();
  });
});

describe("helpers: when the harness or the engine goes away", () => {
  test("the harness process ends: running helpers are stopped, with a notice and a word for the bot", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const s = await send(engine, sessions, bot.id, "Go");
    ownTurn(s, "On it.", () => s.helperStart("h1", { description: "Busy", background: true }));
    await settle();
    s.emit({ type: "exit", error: "killed", beforeInit: false });
    await wait(20);
    assert.equal(helpers(events)[0]!.status, "stopped");
    assert.ok(items(events).some((i) => i.kind === "notice" && i.text === "The bot stopped unexpectedly, so a helper was stopped"));
    assert.equal(botOf(events, bot.id)?.state, "done");
    const s2 = await send(engine, sessions, bot.id, "Again");
    assert.ok(s2.sent.at(-1)!.before.some((b) => /a helper you started was stopped/.test(b) && b.includes('"Busy"')));
    engine.shutdown();
    store.close();
  });

  test("the engine restarts while helpers work: no row says running, one notice, and the bot learns it at its next turn", async () => {
    const first = world();
    const bot = first.engine.createBot("Po");
    const s = await send(first.engine, first.sessions, bot.id, "Go");
    ownTurn(s, "Two helpers.", () => {
      s.helperStart("h1", { description: "One", background: true });
      s.helperStart("h2", { description: "Two", background: true });
      // The real harness lists every task that runs in the background. Each helperStart of the fake
      // lists only its own, which leaves h1 out: the engine then rightly ends h1 after liveCheckMs
      // (20 ms), and on a slow run the shutdown below came after that.
      s.emit({ type: "tasks-live", taskIds: ["task-h1", "task-h2"] });
    });
    s.helperTool("h1", "Read", { file_path: "/x/a.txt" }, { end: false });
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = world({}, first.dirs);
    await settle();
    const thread = second.engine.readThread({ threadId: bot.mainThreadId }).items;
    const rows = thread.filter((i): i is HelperItem => i.kind === "helper");
    assert.deepEqual(rows.map((r) => r.status), ["stopped", "stopped"]);
    assert.ok(rows.every((r) => r.endedAt));
    const restartNotices = thread.filter((i): i is NoticeItem => i.kind === "notice" && /restarted/.test(i.text));
    assert.deepEqual(restartNotices.map((n) => n.text), ["Pobots restarted, so 2 helpers were stopped"]);
    const inner = second.engine.readThread({ threadId: rows[0]!.helperThreadId }).items;
    assert.ok(inner.every((i) => i.kind !== "activity" || i.status !== "running"), "no step in a helper's thread still runs");
    assert.ok(!inner.some((i) => i.kind === "notice"), "the helper's own thread gets no notice");
    assert.equal(second.engine.snapshot().bots[0]!.helpers, 0);
    const s2 = await send(second.engine, second.sessions, bot.id, "Hello again");
    const news = s2.sent.at(-1)!.before.filter((b) => /helpers you started were stopped/.test(b));
    assert.equal(news.length, 1, "told once");
    assert.match(news[0]!, /Pobots restarted/);
    s2.reply("Noted.");
    await settle();
    const s3 = await send(second.engine, second.sessions, bot.id, "And again");
    assert.ok(!s3.sent.at(-1)!.before.some((b) => /were stopped/.test(b)), "not told twice");
    second.engine.shutdown();
    second.store.close();
  });

  test("a database from version 6 gets the helper threads and the bot's news, and keeps everything", () => {
    const dir = tempDir();
    const path = join(dir, "pobots.db");
    const db = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 6)) db.exec(m);
    db.exec("PRAGMA user_version = 6");
    db.prepare("INSERT INTO threads (id, bot_id, kind, created_at) VALUES ('t1', 'po', 'main', '2026-11-10T10:00:00Z')").run();
    db.prepare("INSERT INTO items (id, thread_id, seq, kind, open, data) VALUES ('i1', 't1', 1, 'activity', 0, ?)").run(
      JSON.stringify({ id: "i1", threadId: "t1", seq: 1, kind: "activity", at: "2026-11-10T10:00:00Z", botId: "po", label: "Had a helper inventory work-bot agents", status: "done" }),
    );
    db.close();
    const s = new Store(path);
    assert.equal(s.schemaVersion, 11);
    assert.equal(s.getThread("t1")!.kind, "main");
    const old = s.readThread("t1").items[0] as ActivityItem;
    assert.equal(old.label, "Had a helper inventory work-bot agents", "old lines stay as they were");
    const h = s.createThread("po", "helper", "i9");
    assert.equal(s.getThread(h.id)!.parentItemId, "i9");
    s.addNews("po", "t1", "news");
    assert.deepEqual(s.takeNews("t1"), ["news"]);
    assert.deepEqual(s.takeNews("t1"), []);
    s.close();
  });
});

describe("helpers: how the real session reads the harness", () => {
  test("helper messages, task notices, and turns the harness begins by itself, as the real harness sent them", () => {
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
    cs.send("Start a helper");
    const uuid = [...(cs as unknown as { pending: Set<string> }).pending][0]!;
    handle({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
    handle({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5" });
    handle({ type: "assistant", parent_tool_use_id: null, uuid: "u", session_id: "s", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { description: "Read the word file", prompt: "Read notes.txt", run_in_background: true } }] } });
    handle({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Read the word file" }], session_id: "s", uuid: "u" });
    handle({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "tu1", description: "Read the word file", is_backgrounded: true, task_type: "local_agent", session_id: "s", uuid: "u" });
    handle({ type: "user", parent_tool_use_id: null, session_id: "s", uuid: "u", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Async agent launched successfully." }] }] } });
    handle({ type: "result", subtype: "success", is_error: false, session_id: "s", user_message_uuids: [uuid], modelUsage: {} });
    // The helper works on after the turn.
    handle({ type: "user", parent_tool_use_id: "tu1", session_id: "s", uuid: "u", message: { role: "user", content: [{ type: "text", text: "Read notes.txt" }] } });
    handle({ type: "assistant", parent_tool_use_id: "tu1", uuid: "u", session_id: "s", message: { id: "m2", content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/x/notes.txt" } }] } });
    handle({ type: "user", parent_tool_use_id: "tu1", session_id: "s", uuid: "u", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "pelican" }] } });
    handle({ type: "assistant", parent_tool_use_id: "tu1", uuid: "u", session_id: "s", message: { id: "m3", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "The word is pelican." }] } });
    handle({ type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "completed" }, session_id: "s", uuid: "u" });
    handle({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "tu1", status: "completed", output_file: "/x", summary: "The word is pelican.", session_id: "s", uuid: "u" });
    handle({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: "s", uuid: "u" });
    // The harness wakes the bot: init with no message of ours taken up.
    handle({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5" });
    handle({ type: "result", subtype: "success", is_error: false, session_id: "s", modelUsage: {} });

    const kinds = got.map((e) => e.type + ("own" in e ? `:${e.own}` : "") + ("parent" in e && e.parent ? `@${e.parent}` : ""));
    assert.deepEqual(kinds, [
      "session",
      "turn-start:true",
      "tool-start",
      "tasks-live",
      "task-started",
      "tool-end",
      "turn-end:true",
      "tool-start@tu1",
      "tool-end@tu1",
      "text-full@tu1",
      "task-updated",
      "task-ended",
      "tasks-live",
      "session",
      "turn-start:false",
      "turn-end:false",
    ]);
    const launched = got.find((e) => e.type === "tool-end" && !e.parent) as Extract<HarnessEvent, { type: "tool-end" }>;
    assert.match(launched.text!, /Async agent launched/);
    const started = got.find((e) => e.type === "task-started") as Extract<HarnessEvent, { type: "task-started" }>;
    assert.deepEqual(started, { type: "task-started", taskId: "a1", toolUseId: "tu1", taskType: "local_agent", background: true, quiet: false });
    const ended = got.find((e) => e.type === "task-ended") as Extract<HarnessEvent, { type: "task-ended" }>;
    assert.equal(ended.summary, "The word is pelican.");
  });
});

/** A local stand-in for the flow that posts answers in Teams. */
async function standIn() {
  const got: { body: Record<string, unknown>; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    let t = "";
    req.on("data", (c) => (t += c));
    req.on("end", () => {
      got.push({ body: JSON.parse(t) as Record<string, unknown>, headers: req.headers });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/reply?sig=s3cret-flow`, got, close: () => new Promise<void>((r) => server.close(() => r())) };
}
