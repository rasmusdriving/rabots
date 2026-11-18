// Steering (protocol 14, 13 Nov 2026): a message the person sends while a bot is in a turn goes into
// that turn, or waits in line, by the setting in Pobots settings or the choice made for one message.
// The fake harness plays what the real ones did in the trials (docs/build/step-steering-result.md):
// Claude takes a steer in at the turn's next step and its one result lists both messages; a steer the
// turn ended before taking up runs next by itself; a Stop cancels what waits in its line and gives it
// back; Codex answers turn/steer, or refuses it once the turn has ended.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BotItem, Events, UserItem } from "../../shared/protocol.js";
import { chatConfig, loadConfigFile } from "../config.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import type { Store } from "../store.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { lastState, settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const T = { wakeGraceMs: 30, helperStopMs: 150, helperNudgeMs: 20, liveCheckMs: 40 };
const world = () => setup(undefined, () => true, T);
const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const botTexts = (events: Ev[]) => items(events).filter((i): i is BotItem => i.kind === "bot").map((i) => i.text);
const user = (store: Store, id: string) => store.getItem(id) as UserItem;

/** What a steerable fake took into its turn. */
type Steered = { text: string; id: string };
/** Gives a fake session the harness's steer: it takes the message (or refuses it when `accept` says no). */
function steerable(s: FakeSession, accept: () => boolean = () => true): Steered[] {
  const got: Steered[] = [];
  (s as FakeSession & { steer(text: string, o: { id: string }): Promise<boolean> }).steer = async (text, o) => {
    if (!accept()) return false;
    got.push({ text, id: o.id });
    return true;
  };
  return got;
}

/** A bot in a turn on a steerable fake: the first message is sent and its turn has begun. */
async function inTurn(engine: Engine, sessions: FakeSession[], accept?: () => boolean) {
  const bot = engine.createBot("Po");
  const first = engine.sendMessage({ botId: bot.id, text: "Count the files" });
  await settle();
  const s = sessions.at(-1)!;
  const steered = steerable(s, accept);
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  s.emit({ type: "tool-start", toolUseId: "tu1", name: "Bash", input: { command: "ls" } });
  return { bot, first, s, steered };
}
function endTurn(s: FakeSession, text: string, o: { ahead?: string[] } = {}) {
  s.emit({ type: "tool-end", toolUseId: "tu1", isError: false, text: "a b c" });
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true, ...(o.ahead ? { ahead: o.ahead } : {}) });
}

describe("steering: the setting", () => {
  test("steer is the default; chat.set saves queue in config.json, says so once, and the snapshot has it", () => {
    const { engine, events, store, dirs } = world();
    assert.deepEqual(engine.snapshot().chat, { followUp: "steer" });
    assert.deepEqual(engine.chatSet({ followUp: "queue" }), { chat: { followUp: "queue" } });
    assert.deepEqual(engine.snapshot().chat, { followUp: "queue" });
    assert.equal(JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8")).chat.followUp, "queue");
    assert.equal(loadConfigFile(dirs.dataDir).chat?.followUp, "queue");
    engine.chatSet({ followUp: "queue" });
    assert.equal(events.filter((e) => e.event === "chat.changed").length, 1, "the same choice again changes nothing");
    assert.deepEqual((events.find((e) => e.event === "chat.changed")!.data as Events["chat.changed"]).chat, { followUp: "queue" });
    engine.shutdown();
    store.close();
  });

  test("a bad value in config.json falls back to steer", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ chat: { followUp: "later" } }));
    assert.equal(loadConfigFile(dataDir).chat?.followUp, undefined);
    assert.deepEqual(chatConfig(loadConfigFile(dataDir).chat), { followUp: "steer" });
  });
});

describe("steering: a message sent while the bot works", () => {
  test("by default it goes into the running turn: marked steered with that turn's id, handed to the harness once, nothing queued", async () => {
    const { engine, sessions, events, store } = world();
    const { bot, first, s, steered } = await inTurn(engine, sessions);
    const turnId = user(store, first.id).turnId;
    const msg = engine.sendMessage({ botId: bot.id, text: "Also count the folders" });
    assert.equal(msg.queued, false);
    assert.equal(msg.steered, true);
    assert.equal(msg.turnId, turnId);
    await settle();
    assert.deepEqual(steered, [{ text: "Also count the folders", id: msg.id }]);
    assert.equal(s.sent.length, 1, "only the first message was sent as a turn");
    endTurn(s, "Three files and two folders.");
    await settle();
    assert.equal(lastState(events, bot.id)?.state, "done");
    assert.equal(s.sent.length, 1, "the steered message is never sent again");
    assert.equal(user(store, msg.id).queued, false);
    assert.equal(user(store, msg.id).steered, true);
    // It stands in the chat where it went in: after what came before it, before what came after.
    const order = items(events).filter((i) => i.threadId === bot.mainThreadId).sort((a, b) => a.seq - b.seq).map((i) => (i.kind === "user" ? `you:${i.text}` : i.kind));
    assert.deepEqual(order, ["you:Count the files", "activity", "you:Also count the folders", "bot"]);
    engine.shutdown();
    store.close();
  });

  test("a steer read early in a long turn stays where it went in, also when the chat is read again (0.21.1)", async () => {
    // 15 Nov 2026: a steer the bot read early stood at the bottom of the chat. The engine's
    // order was right (the window's fold took the rest of the turn); this keeps the engine's part true.
    const { engine, sessions, store } = world();
    const { bot, s } = await inTurn(engine, sessions);
    s.emit({ type: "tool-end", toolUseId: "tu1", isError: false, text: "a b c" });
    const msg = engine.sendMessage({ botId: bot.id, text: "Sign in with SSO only" });
    await settle();
    for (const n of [2, 3, 4]) {
      s.emit({ type: "tool-start", toolUseId: `tu${n}`, name: "Bash", input: { command: `step ${n}` } });
      s.emit({ type: "tool-end", toolUseId: `tu${n}`, isError: false, text: "ok" });
    }
    s.emit({ type: "text-full", key: "t-after", text: "Signed in with SSO, all read." });
    s.emit({ type: "tool-start", toolUseId: "tu5", name: "Bash", input: { command: "step 5" } });
    await settle();
    const read = () => store.readThread(bot.mainThreadId).items.map((i) => (i.kind === "user" ? `you:${i.text}` : i.kind));
    const want = ["you:Count the files", "activity", "you:Sign in with SSO only", "activity", "activity", "activity", "bot", "activity"];
    assert.deepEqual(read(), want, "while the turn still runs");
    s.emit({ type: "tool-end", toolUseId: "tu5", isError: false, text: "ok" });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.deepEqual(read(), want, "after the turn, as a reload reads it");
    assert.equal(user(store, msg.id).steered, true);
    engine.shutdown();
    store.close();
  });

  test("with the setting on queue it waits, and is sent once when the turn ends", async () => {
    const { engine, sessions, store } = world();
    engine.chatSet({ followUp: "queue" });
    const { bot, s, steered } = await inTurn(engine, sessions);
    const msg = engine.sendMessage({ botId: bot.id, text: "Then the folders" });
    assert.equal(msg.queued, true);
    assert.equal(msg.steered, undefined);
    endTurn(s, "Three files.");
    await settle();
    assert.deepEqual(steered, []);
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "Then the folders"]);
    engine.shutdown();
    store.close();
  });

  test("the other way for one message: queue while the default steers, steer while the default queues", async () => {
    const { engine, sessions, store } = world();
    const { bot, s, steered } = await inTurn(engine, sessions);
    const waits = engine.sendMessage({ botId: bot.id, text: "Later, please", mode: "queue" });
    assert.equal(waits.queued, true);
    engine.chatSet({ followUp: "queue" });
    const now = engine.sendMessage({ botId: bot.id, text: "Now, please", mode: "steer" });
    assert.equal(now.steered, true);
    await settle();
    assert.deepEqual(steered.map((x) => x.text), ["Now, please"]);
    endTurn(s, "Done.");
    await settle();
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "Later, please"]);
    engine.shutdown();
    store.close();
  });

  test("a steer the harness refuses waits in line instead, unmarked, and is sent exactly once after the turn", async () => {
    const { engine, sessions, events, store } = world();
    const { bot, s, steered } = await inTurn(engine, sessions, () => false);
    const msg = engine.sendMessage({ botId: bot.id, text: "Also the folders" });
    await settle();
    const now = user(store, msg.id);
    assert.equal(now.queued, true);
    assert.equal(now.steered, undefined);
    assert.equal(now.turnId, undefined);
    assert.deepEqual(steered, []);
    endTurn(s, "Three files.");
    await settle();
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "Also the folders"]);
    s.reply("And two folders.");
    await settle();
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "Also the folders"], "never twice");
    assert.ok(botTexts(events).includes("And two folders."));
    engine.shutdown();
    store.close();
  });

  test("a steer the turn ended before taking up is read next in a turn of its own, and is not sent again", async () => {
    const { engine, sessions, events, store } = world();
    const { bot, first, s, steered } = await inTurn(engine, sessions);
    const msg = engine.sendMessage({ botId: bot.id, text: "And the folders" });
    await settle();
    assert.equal(steered.length, 1);
    endTurn(s, "Three files.", { ahead: [msg.id] });
    await settle();
    // The engine now waits for the harness's own turn for it: busy, nothing sent.
    assert.equal(s.sent.length, 1);
    assert.equal(lastState(events, bot.id)?.state, "thinking");
    const it = user(store, msg.id);
    assert.equal(it.queued, false);
    assert.equal(it.steered, true, "it keeps its mark");
    assert.ok(it.turnId && it.turnId !== user(store, first.id).turnId, "a turn of its own");
    s.emit({ type: "turn-start", own: true });
    s.reply("And two folders.");
    await settle();
    assert.equal(lastState(events, bot.id)?.state, "done");
    assert.equal(s.sent.length, 1, "never sent again");
    assert.ok(botTexts(events).includes("And two folders."));
    engine.shutdown();
    store.close();
  });

  test("Stop: a steer the harness gives back unread waits in line, held, and goes first when the person writes", async () => {
    const { engine, sessions, events, store } = world();
    const { bot, s } = await inTurn(engine, sessions);
    const msg = engine.sendMessage({ botId: bot.id, text: "And the folders" });
    await settle();
    await engine.interrupt(bot.id);
    s.emit({ type: "steer-returned", ids: [msg.id] });
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(user(store, msg.id).queued, true);
    assert.equal(user(store, msg.id).steered, undefined);
    assert.equal(lastState(events, bot.id)?.activity, "Stopped, 1 message waiting");
    assert.equal(s.sent.length, 1, "nothing starts by itself after a Stop");
    engine.sendMessage({ botId: bot.id, text: "Go on" });
    await settle();
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "And the folders"]);
    s.reply("Two folders.");
    await settle();
    assert.deepEqual(s.sent.map((m) => m.text), ["Count the files", "And the folders", "Go on"]);
    engine.shutdown();
    store.close();
  });

  test("no steering into a turn that cannot take it: a session without steer, a Stop being asked", async () => {
    const { engine, sessions, store } = world();
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Count the files" });
    await settle();
    const plain = engine.sendMessage({ botId: bot.id, text: "Plain fake" });
    assert.equal(plain.queued, true, "a harness without steer: it waits");
    const s = sessions.at(-1)!;
    const steered = steerable(s);
    void engine.interrupt(bot.id);
    const during = engine.sendMessage({ botId: bot.id, text: "While stopping" });
    assert.equal(during.queued, true, "a Stop asked: it waits");
    await settle();
    assert.deepEqual(steered, []);
    engine.shutdown();
    store.close();
  });

  test("message.steer: a queued message from the person goes in now; once in, or when no turn can take it, it is refused or stays", async () => {
    const { engine, sessions, store } = world();
    engine.chatSet({ followUp: "queue" });
    const { bot, s, steered } = await inTurn(engine, sessions);
    const msg = engine.sendMessage({ botId: bot.id, text: "Then the folders" });
    assert.equal(msg.queued, true);
    assert.deepEqual(engine.steerQueued({ botId: bot.id, itemId: msg.id }), { steered: true });
    await settle();
    assert.deepEqual(steered.map((x) => x.text), ["Then the folders"]);
    assert.equal(user(store, msg.id).queued, false);
    assert.equal(user(store, msg.id).steered, true);
    assert.throws(() => engine.steerQueued({ botId: bot.id, itemId: msg.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    endTurn(s, "Done.");
    await settle();
    assert.equal(s.sent.length, 1, "never sent again");
    // A message that waits while no turn runs (held by a Stop) is not steered.
    const b2 = engine.createBot("Bo");
    engine.sendMessage({ botId: b2.id, text: "One" });
    await settle();
    const s2 = sessions.at(-1)!;
    steerable(s2);
    const w2 = engine.sendMessage({ botId: b2.id, text: "Two" });
    await engine.interrupt(b2.id);
    s2.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.deepEqual(engine.steerQueued({ botId: b2.id, itemId: w2.id }), { steered: false });
    assert.equal(user(store, w2.id).queued, true);
    engine.shutdown();
    store.close();
  });
});

describe("steering: a bot on a GPT model", () => {
  test("turn/steer takes the message into Codex's running turn: one turn, one answer that has it, nothing sent twice", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[wait:400]]" });
    await waitFor(() => lastState(w.events, bot.id)?.state === "thinking", 5000, "the turn");
    await waitFor(() => w.codex.received("turn/start").length === 1, 5000, "turn/start");
    await new Promise((r) => setTimeout(r, 60));
    const msg = w.engine.sendMessage({ botId: bot.id, text: "Say kiwi too" });
    assert.equal(msg.steered, true);
    await waitFor(() => lastState(w.events, bot.id)?.state === "done", 8000, "done");
    assert.ok(botTexts(w.events).some((t) => t === "waited, steered: Say kiwi too"), botTexts(w.events).join(" | "));
    assert.equal(w.codex.received("turn/start").length, 1, "no second turn");
    assert.equal(w.codex.received("turn/steer").length, 1);
    assert.equal((w.store.getItem(msg.id) as UserItem).queued, false);
    w.engine.shutdown();
    w.store.close();
  });

  test("a steer Codex refuses (its turn has ended) waits in line and starts the next turn once", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[wait:200]]" });
    await waitFor(() => w.codex.received("turn/start").length === 1, 5000, "turn/start");
    await new Promise((r) => setTimeout(r, 60));
    // The session's own steer is made to meet a turn that has just ended, as when the two cross.
    const cs = w.codexSessions.at(-1)! as unknown as { turnId: string | undefined };
    cs.turnId = "ended-turn";
    const msg = w.engine.sendMessage({ botId: bot.id, text: "[[answer:second]]" });
    await waitFor(() => (w.store.getItem(msg.id) as UserItem).queued === true || botTexts(w.events).includes("second"), 5000, "the fallback");
    await waitFor(() => botTexts(w.events).includes("second"), 8000, "the second answer");
    assert.equal(w.codex.received("turn/steer").length, 1);
    assert.equal(w.codex.received("turn/start").length, 2, "sent once, as a turn of its own");
    assert.equal((w.store.getItem(msg.id) as UserItem).steered, undefined);
    w.engine.shutdown();
    w.store.close();
  });
});
