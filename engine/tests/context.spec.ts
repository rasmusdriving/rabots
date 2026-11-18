// Step 2d: the session behind a bot's never-ending chat. How full it is, when it is replaced by a
// fresh one (the three rules), the tidy turn before that, the first turn of the fresh session, the
// compaction notice, and the bot's two tools for its own old chat. Fake harness and fake clock.
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { Bot, Events, Item, NoticeItem, UserItem } from "../../shared/protocol.js";
import { ClaudeSession, windowOf, type HarnessEvent } from "../claude/session.js";
import { cleanContext, CONTEXT_DEFAULTS, resolveConfig } from "../config.js";
import { TIDY_PROMPT, TIDY_REFUSAL, type Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { MIGRATIONS, Store } from "../store.js";
import { lastState, settle, setup, upserts, usage, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const T0 = Date.parse("2026-11-11T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An engine on a clock the test moves. */
function clocked(extra: Parameters<typeof setup>[3] = {}) {
  const clock = { t: T0 };
  const env = setup(undefined, () => true, undefined, { clock: () => clock.t, ...extra });
  return { ...env, clock };
}

/** Sends a message, lets the bot answer with the given usage, and returns the session. */
async function chat(engine: Engine, sessions: FakeSession[], botId: string, text: string, answer: string, u?: ReturnType<typeof usage>, sessionId = "sess-1") {
  engine.sendMessage({ botId, text });
  await settle();
  const s = sessions.at(-1)!;
  s.reply(answer, sessionId, u);
  await settle();
  return s;
}

/** The latest version of each item, in the order they were first seen. */
const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const tidyItems = (events: Ev[]) => items(events).filter((i): i is UserItem => i.kind === "user" && i.from.type === "app");
const freshNotices = (events: Ev[]) => items(events).filter((i): i is NoticeItem => i.kind === "notice" && i.mark === "fresh");
const notices = (events: Ev[]) => items(events).filter((i): i is NoticeItem => i.kind === "notice");
const botOf = (events: Ev[], id: string): Bot | undefined => lastState(events, id);

describe("fresh sessions behind one chat", () => {
  test("the session's size, window and start are kept per main thread and sent with the bot", async () => {
    const { engine, sessions, events, store } = clocked();
    const bot = engine.createBot("Po");
    assert.deepEqual(bot.context, { tokens: 0, window: 150_000, tidying: false });
    const from = events.length;
    await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000, { window: 1_000_000 }));
    const sent = events.slice(from).filter((e) => e.event === "bot.updated").map((e) => (e.data as Events["bot.updated"]).bot);
    const withSize = sent.find((b) => b.context?.tokens === 120_000);
    assert.ok(withSize, "no bot.updated with the new size");
    assert.equal(withSize.context?.window, 300_000);
    assert.ok(withSize.context?.since, "the session's start is not set");
    const snap = engine.snapshot().bots[0]!;
    assert.equal(snap.context?.tokens, 120_000);
    const ctx = store.getContext(bot.mainThreadId);
    assert.equal(ctx.cache, "1h");
    assert.equal(ctx.sentAt, new Date(T0).toISOString());
    engine.shutdown();
    store.close();
  });

  test("rule 1: a tidy turn begins shortly before a one hour cache goes cold, not before and not twice", async () => {
    const { engine, sessions, events, store, clock } = clocked();
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000, { cache: "1h" }));
    const stateBefore = botOf(events, bot.id)?.state;
    clock.t = T0 + 40 * MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 0, "tidied too early");
    clock.t = T0 + 53 * MIN;
    engine.checkContext();
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 1, "no tidy turn, or two");
    const tidy = tidyItems(events)[0]!;
    assert.equal(tidy.text, TIDY_PROMPT);
    assert.deepEqual(tidy.from, { type: "app", reason: "tidy" });
    assert.equal(s.sent.at(-1)?.text, TIDY_PROMPT);
    const during = botOf(events, bot.id)!;
    assert.equal(during.state, "working");
    assert.equal(during.activity, "Writing down what matters");
    assert.equal(during.context?.tidying, true);
    // Tool steps and thinking do not change the calm line.
    s.emit({ type: "thinking" });
    s.emit({ type: "tool-start", toolUseId: "t1", name: "Write", input: { file_path: join(s.settings.botDir, "memory", "MEMORY.md") } });
    assert.equal(botOf(events, bot.id)?.activity, "Writing down what matters");
    s.emit({ type: "tool-end", toolUseId: "t1", isError: false });
    s.reply("Working on nothing. Nothing open.", "sess-1", usage(121_000));
    await settle();
    const after = botOf(events, bot.id)!;
    assert.equal(after.context?.tidying, false);
    // A tidy turn by the clock leaves the bot idle: a done mark would read as if the tidy turn were finished work.
    assert.ok(stateBefore === "done" || stateBefore === "idle");
    assert.equal(after.state, "idle", "the bot did not go idle after the tidy turn");
    assert.notEqual(after.state, "working");
    engine.shutdown();
    store.close();
  });

  test("rule 1 noticed late: still begins with two minutes of cache left, otherwise waits for rule 3", async () => {
    const { engine, sessions, events, store, clock } = clocked();
    const a = engine.createBot("Po");
    await chat(engine, sessions, a.id, "Hi", "Hello", usage(120_000, { cache: "1h" }));
    clock.t = T0 + 57 * MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 1, "not tidied at 57 minutes");
    engine.shutdown();
    store.close();

    const late = clocked();
    const c = late.engine.createBot("Late");
    await chat(late.engine, late.sessions, c.id, "Hi", "Hello", usage(120_000, { cache: "1h" }));
    late.clock.t = T0 + 59 * MIN;
    late.engine.checkContext();
    await settle();
    assert.equal(tidyItems(late.events).length, 0, "tidied with less than two minutes of cache left");
    late.clock.t = T0 + 3 * HOUR;
    late.engine.checkContext();
    await settle();
    assert.equal(tidyItems(late.events).length, 0, "tidied before the long quiet");
    late.clock.t = T0 + 4 * HOUR;
    late.engine.checkContext();
    await settle();
    assert.equal(tidyItems(late.events).length, 1, "rule 3 did not take over");
    late.engine.shutdown();
    late.store.close();
  });

  test("rule 1 needs a long-lived cache and a big enough session; cacheMinutes overrides the measured life", async () => {
    const short = clocked();
    const a = short.engine.createBot("Po");
    await chat(short.engine, short.sessions, a.id, "Hi", "Hello", usage(120_000, { cache: "5m" }));
    short.clock.t = T0 + 53 * MIN;
    short.engine.checkContext();
    await settle();
    assert.equal(tidyItems(short.events).length, 0, "tidied a five minute cache by rule 1");
    short.engine.shutdown();
    short.store.close();

    const small = clocked();
    const b = small.engine.createBot("Po");
    await chat(small.engine, small.sessions, b.id, "Hi", "Hello", usage(30_000, { cache: "1h" }));
    for (const t of [53 * MIN, 5 * HOUR]) {
      small.clock.t = T0 + t;
      small.engine.checkContext();
    }
    await settle();
    assert.equal(tidyItems(small.events).length, 0, "tidied a small session");
    small.engine.shutdown();
    small.store.close();

    const forced = clocked({ context: { ...CONTEXT_DEFAULTS, cacheMinutes: 60 } });
    const c = forced.engine.createBot("Po");
    await chat(forced.engine, forced.sessions, c.id, "Hi", "Hello", usage(120_000, { cache: "5m" }));
    forced.clock.t = T0 + 53 * MIN;
    forced.engine.checkContext();
    await settle();
    assert.equal(tidyItems(forced.events).length, 1, "cacheMinutes did not count");
    forced.engine.shutdown();
    forced.store.close();

    const off = clocked({ context: { ...CONTEXT_DEFAULTS, enabled: false } });
    const d = off.engine.createBot("Po");
    await chat(off.engine, off.sessions, d.id, "Hi", "Hello", usage(190_000, { cache: "1h" }));
    off.clock.t = T0 + 53 * MIN;
    off.engine.checkContext();
    await settle();
    assert.equal(tidyItems(off.events).length, 0, "tidied while switched off");
    off.engine.shutdown();
    off.store.close();
  });

  test("rule 3: after a long quiet with a cold cache", async () => {
    const { engine, sessions, events, store, clock } = clocked();
    const bot = engine.createBot("Po");
    await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000, { cache: "5m" }));
    clock.t = T0 + 4 * HOUR - MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 0);
    clock.t = T0 + 4 * HOUR;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 1);
    engine.shutdown();
    store.close();
  });

  test("rule 2: nearly full right after a turn, but only once nothing waits in line", async () => {
    const { engine, sessions, events, store } = clocked();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "One" });
    engine.sendMessage({ botId: bot.id, text: "Two" });
    await settle();
    const s = sessions[0]!;
    s.reply("First", "sess-1", usage(160_000));
    await settle();
    assert.equal(tidyItems(events).length, 0, "tidied while a message waited");
    assert.equal(s.sent.at(-1)?.text, "Two");
    s.reply("Second", "sess-1", usage(155_000));
    await settle();
    assert.equal(tidyItems(events).length, 1, "no tidy turn after the queue emptied");
    assert.equal(s.sent.at(-1)?.text, TIDY_PROMPT);
    engine.shutdown();
    store.close();
  });

  test("a tidy turn that ends well: the note is kept, the session forgotten, one fresh line in the chat", async () => {
    const { engine, sessions, events, store } = clocked();
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "The code word is pineapple", "Noted", usage(120_000));
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    const tidy = tidyItems(events)[0]!;
    const note = "Working on the trip plan. Waiting for Kaja's answer by Friday.";
    s.reply(note, "sess-1", usage(122_000));
    await settle();
    const fresh = freshNotices(events);
    assert.equal(fresh.length, 1);
    const line = fresh[0]!;
    assert.equal(line.text, "Started fresh");
    assert.equal(line.tone, "info");
    assert.equal(line.detail, note);
    assert.equal(line.tidyTurnId, store.getItem(tidy.id)?.turnId);
    assert.equal(line.turnId, undefined, "the fresh line belongs to no turn");
    assert.ok(s.closed, "the harness was not stopped");
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, null);
    const ctx = store.getContext(bot.mainThreadId);
    assert.equal(ctx.note, note);
    assert.equal(ctx.notePending, true);
    assert.equal(ctx.tokens, 0);
    const b = botOf(events, bot.id)!;
    assert.equal(b.context?.tokens, 0);
    assert.equal(b.context?.tidying, false);
    assert.ok(b.context?.since);
    // No error or done mark came from the tidy turn.
    assert.ok(!notices(events).some((n) => n.tone === "error"));
    engine.shutdown();
    store.close();
  });

  test("the first turn in the fresh session gets the note and the last messages, once", async () => {
    const { engine, sessions, store } = clocked();
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "The code word is pineapple", "Noted", usage(120_000));
    await chat(engine, sessions, bot.id, "Book the train", "Booked for Friday", usage(121_000));
    engine.startFresh(bot.id);
    await settle();
    s.reply("Code word pineapple. Train booked for Friday.", "sess-1", usage(122_000));
    await settle();
    const fresh = await chat(engine, sessions, bot.id, "What was the code word?", "pineapple", usage(20_000), "sess-2");
    assert.notEqual(fresh, s, "the old harness was used again");
    assert.equal(fresh.settings.resume, undefined, "the fresh session resumed the old one");
    const first = fresh.sent[0]!;
    assert.equal(first.text, "What was the code word?");
    assert.equal(first.before.length, 4);
    assert.match(first.before[3]!, /^That is all the background from Pobots\. The next part is the new message itself, from the person\./);
    assert.match(first.before[0]!, /^Note from Pobots: this is a fresh session in the same chat/);
    assert.equal(first.before[1], "Code word pineapple. Train booked for Friday.");
    const last = first.before[2]!;
    assert.match(last, /^The last messages of the chat, for the thread of the conversation:/);
    assert.match(last, /The person: The code word is pineapple/);
    assert.match(last, /You: Booked for Friday/);
    assert.ok(!last.includes("Save to your memory folder"), "the tidy request is in the last messages");
    assert.ok(!last.includes("Train booked for Friday."), "the note is in the last messages");
    assert.ok(!last.includes("What was the code word?"), "the new message is in the last messages");
    assert.ok(!first.before.some((b) => /could not be restored/.test(b)), "the lost-session handoff fired");
    assert.equal(store.getContext(bot.mainThreadId).notePending, false);
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, "sess-2");
    // Once the fresh session is there, the note is not sent again: not in the same harness, not after it sleeps.
    await chat(engine, sessions, bot.id, "And the train?", "Friday", usage(21_000), "sess-2");
    assert.deepEqual(fresh.sent[1]?.before, []);
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# Po\n\nA new job.\n" });
    const again = await chat(engine, sessions, bot.id, "Hello again", "Hi", usage(22_000), "sess-2");
    assert.notEqual(again, fresh);
    assert.equal(again.settings.resume, "sess-2");
    assert.ok(!again.sent[0]!.before.some((b) => b.includes("Train booked for Friday.")), "the note was sent twice");
    engine.shutdown();
    store.close();
  });

  test("a message that arrives during a tidy turn waits, then runs in the fresh session", async () => {
    const { engine, sessions, events, store } = clocked();
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000));
    engine.startFresh(bot.id);
    await settle();
    const waiting = engine.sendMessage({ botId: bot.id, text: "Are you there?" });
    assert.equal(waiting.queued, true);
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    s.reply("Nothing open.", "sess-1", usage(121_000));
    await settle();
    const fresh = sessions.at(-1)!;
    assert.notEqual(fresh, s);
    assert.equal(fresh.sent[0]?.text, "Are you there?");
    assert.equal(fresh.sent[0]?.before[1], "Nothing open.");
    // The fresh line comes before the waiting message's answer in the chat.
    const read = engine.readThread({ threadId: bot.mainThreadId }).items;
    const freshAt = read.findIndex((i) => i.kind === "notice" && i.mark === "fresh");
    assert.ok(freshAt > 0);
    assert.equal(lastState(events, bot.id)?.state, "thinking");
    engine.shutdown();
    store.close();
  });

  test("a failed, interrupted or empty tidy turn keeps the session, adds nothing, and is not tried again too soon", async () => {
    const { engine, sessions, events, store, clock } = clocked();
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000));
    const noticesBefore = notices(events).length;

    // Failed.
    clock.t = T0 + 53 * MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 1);
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: ["boom"], sessionId: "sess-1" });
    await settle();
    assert.equal(notices(events).length, noticesBefore, "the failed tidy turn added a line");
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, "sess-1");
    assert.ok(!s.closed, "the harness was stopped");
    assert.ok(store.getContext(bot.mainThreadId).tidyBlockedAt);
    assert.notEqual(botOf(events, bot.id)?.state, "blocked");
    clock.t = T0 + 55 * MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 1, "tried again before another turn");

    // Another turn lets rule 1 try again later. This time the person stops it.
    await chat(engine, sessions, bot.id, "Again", "Yes", usage(120_000));
    assert.equal(store.getContext(bot.mainThreadId).tidyBlockedAt, undefined);
    clock.t = T0 + 55 * MIN + 53 * MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 2);
    await engine.interrupt(bot.id);
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1" });
    await settle();
    assert.equal(notices(events).length, noticesBefore, "the interrupted tidy turn added a line");
    assert.equal(freshNotices(events).length, 0);
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, "sess-1");

    // Rule 3 tries again only after another long quiet.
    clock.t = T0 + 55 * MIN + 4 * HOUR + MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 2, "rule 3 did not wait after the failed try");
    clock.t = T0 + 55 * MIN + 53 * MIN + 4 * HOUR + MIN;
    engine.checkContext();
    await settle();
    assert.equal(tidyItems(events).length, 3, "rule 3 did not try again after another long quiet");

    // Ends without any text: no note, so no fresh start.
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1" });
    await settle();
    assert.equal(freshNotices(events).length, 0);
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, "sess-1");
    engine.shutdown();
    store.close();
  });

  test("a tidy turn cut short by a crash leaves no line in the chat and keeps the session", async () => {
    const first = clocked();
    const bot = first.engine.createBot("Po");
    const s = await chat(first.engine, first.sessions, bot.id, "Hi", "Hello", usage(120_000));
    first.engine.startFresh(bot.id);
    await settle();
    s.emit({ type: "tool-start", toolUseId: "w1", name: "Write", input: { file_path: join(s.settings.botDir, "memory", "x.md") } });
    // A crash: the database is left as it is, with the tidy turn's step still running.
    first.store.close();
    const second = setup(first.dirs, () => true, undefined, { clock: () => T0 });
    const all = second.engine.readThread({ threadId: bot.mainThreadId }).items;
    assert.ok(!all.some((i) => i.kind === "notice"), `a line was added: ${all.filter((i) => i.kind === "notice").map((i) => (i as NoticeItem).text).join(" | ")}`);
    assert.equal(second.store.getThread(bot.mainThreadId)?.sessionId, "sess-1");
    assert.equal(second.engine.snapshot().bots[0]?.context?.tidying, false);
    second.engine.shutdown();
    second.store.close();
  });

  test("a tidy turn whose session is gone does nothing, and the next turn gets the usual handoff", async () => {
    let exists = true;
    const env = setup(undefined, () => exists, undefined, { clock: () => T0 });
    const { engine, sessions, events, store } = env;
    const bot = engine.createBot("Po");
    const s = await chat(engine, sessions, bot.id, "Hi", "Hello", usage(120_000));
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: "# Po\n\nNew.\n" });
    assert.ok(s.closed);
    exists = false;
    engine.startFresh(bot.id);
    await settle();
    assert.equal(sessions.length, 1, "a new session was started for the tidy turn");
    assert.equal(freshNotices(events).length, 0);
    assert.equal(botOf(events, bot.id)?.context?.tidying, false);
    const next = await chat(engine, sessions, bot.id, "Hello", "Hi", usage(5_000), "sess-9");
    assert.ok(next.sent[0]!.before.some((b) => /could not be restored/.test(b)));
    engine.shutdown();
    store.close();
  });

  test("in a tidy turn only reading and writes in the memory folder go on, never with a card", async () => {
    const { engine, sessions, events, store } = clocked();
    const main = engine.createBot("Po");
    engine.createBot("Bo");
    const s = await chat(engine, sessions, main.id, "Hi", "Hello", usage(120_000));
    const dir = s.settings.botDir;
    const gate = s.settings.gate!;
    // Outside a tidy turn the gate lets everything through to the usual checks.
    assert.equal(gate("Bash", { command: "ls" }), undefined);
    engine.startFresh(main.id);
    await settle();
    const cards = () => events.filter((e) => e.event === "card.added").length;
    const before = cards();

    assert.equal(gate("Bash", { command: "rm -rf x" }), TIDY_REFUSAL);
    assert.equal(gate("Write", { file_path: join(dir, "AGENTS.md") }), TIDY_REFUSAL);
    assert.equal(gate("Write", { file_path: join(dir, "memory", "../AGENTS.md") }), TIDY_REFUSAL);
    assert.equal(gate("Write", { file_path: "/somewhere/else/memory/x.md" }), TIDY_REFUSAL);
    assert.equal(gate("Agent", { prompt: "do things" }), TIDY_REFUSAL);
    assert.equal(gate("mcp__othertool__send", {}), TIDY_REFUSAL);
    assert.equal(gate("mcp__pobots__message_bot", { to: "Bo", text: "x", mode: "tell" }), TIDY_REFUSAL);
    assert.equal(gate("mcp__pobots__notify_human", { title: "x" }), TIDY_REFUSAL);
    assert.equal(gate("mcp__pobots__set_schedule", {}), TIDY_REFUSAL);
    assert.equal(gate("Read", { file_path: join(dir, "AGENTS.md") }), undefined);
    assert.equal(gate("Grep", { pattern: "x" }), undefined);
    assert.equal(gate("Write", { file_path: join(dir, "memory", "topics", "trips.md") }), undefined);
    assert.equal(gate("Edit", { file_path: join(realpathSync(dir), "memory", "MEMORY.md") }), undefined);
    assert.equal(gate("Write", { file_path: "memory/new.md" }), undefined);
    assert.equal(gate("mcp__pobots__search_chat", { query: "x" }), undefined);
    assert.equal(gate("mcp__pobots__list_bots", {}), undefined);

    // The same through the harness's permission question: no card either way.
    const no = await s.ask("Bash", { command: "rm -rf x" });
    assert.equal(no?.behavior, "deny");
    assert.equal(no && "message" in no ? no.message : "", TIDY_REFUSAL);
    const yes = await s.ask("Write", { file_path: join(dir, "memory", "MEMORY.md"), content: "x" });
    assert.equal(yes?.behavior, "allow");

    // The bot's own tools that reach out say no; the reading ones work.
    for (const [name, args] of [
      ["message_bot", { to: "Bo", text: "hello", mode: "tell" }],
      ["ask_human", { question: "Which?" }],
      ["notify_human", { title: "Note" }],
      ["create_bot", { name: "X", purpose: "", job: "x" }],
      ["set_schedule", { name: "X", prompt: "x", schedule: { type: "once", at: "2026-12-01T10:00" } }],
    ] as const) {
      const r = await s.tool(name, args as Record<string, unknown>);
      assert.equal(r.isError, true, `${name} was not refused`);
      assert.equal(r.content[0]!.text, TIDY_REFUSAL);
    }
    const found = await s.tool("search_chat", { query: "Hi" });
    assert.notEqual(found.isError, true);
    assert.equal(cards(), before, "a card was raised in a tidy turn");
    assert.equal(engine.snapshot().bots.find((b) => b.id === "bo")?.state, "idle", "Bo was messaged");

    // After the tidy turn, the same tools work as before.
    s.reply("Nothing open.", "sess-1", usage(121_000));
    await settle();
    const fresh = await chat(engine, sessions, main.id, "Tell Bo hello", "Done", usage(5_000), "sess-2");
    assert.equal(fresh.settings.gate!("Bash", { command: "ls" }), undefined);
    engine.shutdown();
    store.close();
  });

  test("bot.startFresh: nothing to tidy without a session, and refused while the bot is busy", async () => {
    const { engine, sessions, store } = clocked();
    const bot = engine.createBot("Po");
    assert.deepEqual(engine.startFresh(bot.id), { started: false });
    engine.sendMessage({ botId: bot.id, text: "Hi" });
    await settle();
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    engine.sendMessage({ botId: bot.id, text: "And" });
    sessions[0]!.reply("Hello", "sess-1", usage(1_000));
    await settle();
    // The second message is in its turn now; still refused.
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    sessions[0]!.reply("More", "sess-1", usage(1_200));
    await settle();
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    assert.throws(() => engine.startFresh(bot.id), (e: unknown) => e instanceof EngineError && e.code === "conflict" && /already/.test(e.message));
    assert.throws(() => engine.startFresh("nobody"), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    engine.shutdown();
    store.close();
  });

  test("a compaction in the main session adds one quiet line; one in a fresh run does not", async () => {
    const { engine, sessions, events, store } = clocked();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "A long task" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "compacted", trigger: "auto", preTokens: 160_000 });
    s.reply("Done", "sess-1", usage(40_000));
    await settle();
    const marked = items(events).filter((i): i is NoticeItem => i.kind === "notice" && i.mark === "compacted");
    assert.equal(marked.length, 1);
    assert.equal(marked[0]!.text, "The session was nearly full, so it was shortened in the middle of this task");
    assert.equal(marked[0]!.tone, "info");
    assert.equal(marked[0]!.threadId, bot.mainThreadId);

    const hook = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Hook", prompt: "Check", where: "fresh", enabled: true } });
    engine.runTrigger(hook.id);
    await settle();
    const run = sessions.at(-1)!;
    assert.notEqual(run, s);
    run.emit({ type: "compacted", trigger: "auto" });
    run.reply("Nothing to report", "sess-run", usage(1_000));
    await settle();
    assert.equal(items(events).filter((i) => i.kind === "notice" && i.mark === "compacted").length, 1);
    engine.shutdown();
    store.close();
  });

  for (const fullText of [true, false]) {
    test(`search_chat and read_chat read only the bot's own chat (${fullText ? "full-text index" : "plain search"})`, async () => {
      const { engine, sessions, store } = clocked({ fullText });
      assert.equal(store.chatIndex, fullText);
      const po = engine.createBot("Po");
      const bo = engine.createBot("Bo");
      await chat(engine, sessions, bo.id, "The secret fruit is mango", "Noted", usage(1_000));
      const s = await chat(engine, sessions, po.id, "The code word is pineapple", "Noted the code word", usage(1_000));
      for (let i = 0; i < 6; i++) await chat(engine, sessions, po.id, `Filler message ${i}`, `Answer ${i}`, usage(1_000));
      const found = await s.tool("search_chat", { query: "code word" });
      const text = found.content[0]!.text;
      assert.match(text, /^Old text from your own chat/);
      assert.match(text, /the person: The code word is pineapple/);
      assert.match(text, /you: Noted the code word/);
      assert.ok(text.indexOf("Noted the code word") < text.indexOf("The code word is pineapple"), "not newest first");
      const prefix = await s.tool("search_chat", { query: "pineap" });
      assert.match(prefix.content[0]!.text, /pineapple/);
      const none = await s.tool("search_chat", { query: "mango" });
      assert.match(none.content[0]!.text, /Nothing in your chat/);
      const old = await s.tool("search_chat", { query: "pineapple", before: "2000-01-01T00:00:00Z" });
      assert.match(old.content[0]!.text, /Nothing in your chat/);
      const bad = await s.tool("search_chat", { query: "pineapple", before: "someday" });
      assert.equal(bad.isError, true);
      const limited = await s.tool("search_chat", { query: "Filler", limit: 2 });
      assert.equal((limited.content[0]!.text.match(/^- seq/gm) ?? []).length, 2);

      const seq = Number(/seq (\d+), [^\n]*the person: The code word/.exec(text)?.[1]);
      assert.ok(seq > 0);
      const around = await s.tool("read_chat", { around: seq, count: 4 });
      const at = around.content[0]!.text;
      assert.match(at, /^Old text from your own chat/);
      assert.match(at, /The code word is pineapple/);
      assert.match(at, /Noted the code word/);
      assert.ok(!/mango/.test(at));
      // Bo's chat has the same seq numbers; Po never reads it.
      const boSeq = engine.readThread({ threadId: bo.mainThreadId }).items.find((i) => i.kind === "user")!.seq;
      const other = await s.tool("read_chat", { around: boSeq, count: 30 });
      assert.ok(!/mango/.test(other.content[0]!.text), "read another bot's chat");

      // A tidy turn's request and note are not found.
      engine.startFresh(po.id);
      await settle();
      s.reply("Remember: the code word pineapple, and the zebra plan.", "sess-1", usage(1_000));
      await settle();
      const fresh = await chat(engine, sessions, po.id, "Hi", "Hello", usage(1_000), "sess-2");
      const afterTidy = await fresh.tool("search_chat", { query: "zebra" });
      assert.match(afterTidy.content[0]!.text, /Nothing in your chat/, "found the note");
      const request = await fresh.tool("search_chat", { query: "memory folder" });
      assert.match(request.content[0]!.text, /Nothing in your chat/, "found the tidy request");
      const all = await fresh.tool("read_chat", { around: 1, count: 30 });
      assert.ok(!/zebra|Save to your memory folder/.test(all.content[0]!.text));
      engine.shutdown();
      store.close();
    });
  }

  test("the real session reads the size and the cache's life from the requests of its own loop only", () => {
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
    const start = (id: string, u: object, parent: string | null = null) =>
      handle({ type: "stream_event", parent_tool_use_id: parent, uuid: "u", session_id: "s", event: { type: "message_start", message: { id, usage: u } } });
    handle({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5" });
    // Request 1: writes the one hour kind.
    start("m1", { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 }, output_tokens: 1 });
    handle({ type: "stream_event", parent_tool_use_id: null, uuid: "u", session_id: "s", event: { type: "message_delta", usage: { output_tokens: 300 } } });
    handle({ type: "stream_event", parent_tool_use_id: null, uuid: "u", session_id: "s", event: { type: "message_stop" } });
    // A subagent's request does not count.
    start("sub", { input_tokens: 9_999, cache_read_input_tokens: 99_999, cache_creation_input_tokens: 9_999, cache_creation: { ephemeral_5m_input_tokens: 9_999, ephemeral_1h_input_tokens: 0 }, output_tokens: 9 }, "tool-1");
    // Request 2: reads it back, writes a little more; its output comes with the assistant message.
    start("m2", { input_tokens: 7, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 }, output_tokens: 1 });
    handle({ type: "assistant", parent_tool_use_id: null, uuid: "u", session_id: "s", message: { id: "m2", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 7, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 400, output_tokens: 50 } } });
    handle({ type: "system", subtype: "compact_boundary", session_id: "s", uuid: "u", compact_metadata: { trigger: "auto", pre_tokens: 150_000 } });
    handle({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s",
      modelUsage: { "claude-haiku-5-5": { contextWindow: 1_000_000, inputTokens: 12 }, "claude-other": { contextWindow: 200_000, inputTokens: 99_999 } },
    });
    assert.deepEqual(got.find((e) => e.type === "compacted"), { type: "compacted", trigger: "auto", preTokens: 150_000 });
    const end = got.find((e): e is Extract<HarnessEvent, { type: "turn-end" }> => e.type === "turn-end")!;
    const u = end.usage!;
    assert.equal(u.requests, 2);
    assert.deepEqual(u.last, { input: 7, cacheRead: 20_000, cacheWrite: 400, output: 50 });
    assert.deepEqual(u.turn, { cacheRead: 20_000, cacheWrite: 20_400, write5m: 0, write1h: 20_400 });
    assert.equal(u.cache, "1h");
    assert.equal(u.window, 1_000_000);
    assert.ok(u.lastSentAgoMs >= 0 && u.lastSentAgoMs < 5_000);

    // The next turn starts counting again. A write with both kinds counts as five minutes.
    got.length = 0;
    start("m3", { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 2 });
    handle({ type: "result", subtype: "success", is_error: false, session_id: "s", modelUsage: {} });
    const next = got.find((e): e is Extract<HarnessEvent, { type: "turn-end" }> => e.type === "turn-end")!.usage!;
    assert.equal(next.requests, 1);
    assert.equal(next.cache, "5m");
    assert.equal(next.window, undefined);
    // A turn that sent nothing reports no usage.
    got.length = 0;
    handle({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", errors: ["x"], modelUsage: {} });
    assert.equal((got[0] as Extract<HarnessEvent, { type: "turn-end" }>).usage, undefined);

    assert.deepEqual(windowOf({ "claude-haiku-5-5[1m]": { contextWindow: 1_000_000 } }, "claude-haiku-5-5"), { window: 1_000_000 });
    assert.deepEqual(windowOf({}, "x"), {});
  });

  test("context settings: defaults, good values, and bad values fall back with a warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    assert.deepEqual(cleanContext(undefined, "x", warn), CONTEXT_DEFAULTS);
    assert.deepEqual(CONTEXT_DEFAULTS, { enabled: true, minTokens: 100000, fullFraction: 0.75, fullTokens: 300000, warmMarginMinutes: 8, coldHours: 4, compactTokens: 300000 });
    assert.deepEqual(cleanContext({ enabled: false, minTokens: 1000, fullFraction: 0.5, fullTokens: 2000, warmMarginMinutes: 5, coldHours: 2, compactTokens: 450000, cacheMinutes: 3 }, "x", warn), {
      enabled: false,
      minTokens: 1000,
      fullFraction: 0.5,
      fullTokens: 2000,
      warmMarginMinutes: 5,
      coldHours: 2,
      compactTokens: 450000,
      cacheMinutes: 3,
    });
    assert.equal(warnings.length, 0);
    const bad = cleanContext({ enabled: "yes", minTokens: -1, fullFraction: 2, warmMarginMinutes: "8", coldHours: 0, cacheMinutes: Number.NaN }, "x", warn);
    assert.deepEqual(bad, CONTEXT_DEFAULTS);
    assert.equal(warnings.length, 6);
    assert.ok(warnings.every((w) => /^"context(\.\w+)?" in x must be/.test(w)), warnings.join(" | "));
    warnings.length = 0;
    assert.deepEqual(cleanContext([1], "x", warn), CONTEXT_DEFAULTS);
    assert.equal(warnings.length, 1);

    const dataDir = tempDir();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ context: { minTokens: 5000, coldHours: "x" } }));
    const cfg = resolveConfig({ dataDir, botsDir: join(dataDir, "bots") });
    assert.deepEqual(cfg.context, { ...CONTEXT_DEFAULTS, minTokens: 5000 });
    const plain = tempDir();
    assert.deepEqual(resolveConfig({ dataDir: plain, botsDir: join(plain, "bots") }).context, CONTEXT_DEFAULTS);
  });

  test("a database from version 5 gets the new columns, and its old chat can be searched", () => {
    for (const fullText of [true, false]) {
      const path = join(tempDir(), "pobots.db");
      const old = new DatabaseSync(path);
      for (const m of MIGRATIONS.slice(0, 5)) old.exec(m);
      old.exec("PRAGMA user_version = 5");
      old.prepare("INSERT INTO threads (id, bot_id, kind, created_at, session_id, next_seq) VALUES ('t1', 'po', 'main', '2026-11-10T00:00:00.000Z', 's1', 3)").run();
      const item = (id: string, seq: number, data: object) =>
        old.prepare("INSERT INTO items (id, thread_id, seq, kind, open, data) VALUES (?, 't1', ?, ?, 0, ?)").run(id, seq, (data as Item).kind, JSON.stringify({ id, threadId: "t1", seq, ...data }));
      item("i1", 1, { kind: "user", at: "2026-11-10T00:00:00.000Z", text: "Find the kiwi", from: { type: "you" }, queued: false });
      item("i2", 2, { kind: "bot", at: "2026-11-10T00:00:01.000Z", botId: "po", text: "The kiwi is in the fridge", streaming: false });
      old.close();
      const s = new Store(path, fullText ? {} : { fullText: false });
      assert.equal(s.schemaVersion, 11);
      assert.equal(s.getThread("t1")?.sessionId, "s1");
      assert.deepEqual(s.getContext("t1"), { tokens: 0, notePending: false });
      assert.deepEqual(
        s.searchChat("t1", ["kiwi"], { limit: 8 }).map((i) => i.id),
        ["i2", "i1"],
      );
      s.setContext("t1", { tokens: 5, window: 1000, cache: "1h", note: "n", notePending: true });
      assert.deepEqual(s.getContext("t1"), { tokens: 5, window: 1000, cache: "1h", note: "n", notePending: true });
      s.setContext("t1", { cache: null, notePending: false });
      assert.deepEqual(s.getContext("t1"), { tokens: 5, window: 1000, note: "n", notePending: false });
      s.close();
      // Opened again: no second migration, the index is kept.
      const again = new Store(path, fullText ? {} : { fullText: false });
      assert.equal(again.schemaVersion, 11);
      assert.equal(again.searchChat("t1", ["fridge"], { limit: 8 }).length, 1);
      again.close();
    }
  });
});
