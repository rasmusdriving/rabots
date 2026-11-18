// Engine 0.31.2 (docs/build/step-lost-reply.md): a turn that begins by itself after the bot's turn
// (a command in the background ended, a helper reported back, a result told in a turn of its own)
// is a turn of its own. Its items carry their own turn id, no user item starts it, and the bot says
// which turn runs now (Bot.turnId), so the window gives each turn its own answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bot, BotItem, Events, UserItem } from "../../shared/protocol.js";
import { wake } from "../core/start-helper.js";
import { settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";

const T = { wakeGraceMs: 30, helperStopMs: 150, helperNudgeMs: 20, liveCheckMs: 40 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const states = (events: Ev[], id: string): Bot[] =>
  events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);

const OWN = "toolu_own";
const OTASK = "bsbmjfh3p";

function live(s: FakeSession, taskIds: string[]) {
  s.emit({ type: "tasks-live", taskIds, tasks: taskIds.map((taskId) => ({ taskId, taskType: "local_bash", quiet: false })) });
}

/** The person's turn: a command goes to the background, then the long answer. */
function firstTurn(s: FakeSession, answer: string) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  s.emit({ type: "tool-start", toolUseId: OWN, name: "Bash", input: { command: 'node -e "setTimeout(()=>{},30000)"', run_in_background: true } });
  live(s, [OTASK]);
  s.emit({ type: "task-started", taskId: OTASK, toolUseId: OWN, taskType: "local_bash", background: true, quiet: false });
  s.emit({ type: "tool-end", toolUseId: OWN, isError: false, text: "Command running in background with ID: bsbmjfh3p." });
  s.emit({ type: "text-full", key: "answer-a", text: answer });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

describe("lost reply: a turn that begins by itself is a turn of its own", () => {
  test("the harness's turn after a background command: both answers stored with their own turn, no user item, Bot.turnId while each runs", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, T);
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Check the build and tell me what you find" });
    await settle();
    const s = sessions.at(-1)!;
    const user = items(events).find((i): i is UserItem => i.kind === "user")!;
    assert.ok(user.turnId, "the message carries its turn id");
    const during = states(events, bot.id).at(-1)!;
    assert.equal(during.turnId, user.turnId, "Bot.turnId is the message's turn while it runs");

    firstTurn(s, "Here is what I found: the long answer to the question.");
    await settle();
    const between = states(events, bot.id).at(-1)!;
    assert.equal(between.state, "working", "the command still runs in the background");
    assert.equal(between.turnId, undefined, "no turn runs between the turns");

    // The command ends; the harness begins a turn by itself and says something short.
    const from = events.length;
    s.emit({ type: "task-updated", taskId: OTASK, status: "killed" });
    s.emit({ type: "task-ended", taskId: OTASK, toolUseId: OWN, status: "stopped", summary: "Background command stopped" });
    live(s, []);
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: false });
    s.emit({ type: "thinking" });
    await settle();
    const begun = states(events.slice(from), bot.id).find((b) => b.turnId);
    assert.ok(begun, "Bot.turnId is set as soon as the harness's turn begins");
    assert.notEqual(begun.turnId, user.turnId, "the harness's turn has its own id");
    s.emit({ type: "text-full", key: "answer-b", text: "Nothing has changed." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: false });
    await wait(80);

    const texts = items(events).filter((i): i is BotItem => i.kind === "bot");
    const a = texts.find((t) => t.text.startsWith("Here is what I found"))!;
    const b = texts.find((t) => t.text === "Nothing has changed.")!;
    assert.ok(a && b, "both answers are stored");
    assert.equal(a.turnId, user.turnId, "the first answer belongs to the message's turn");
    assert.equal(b.turnId, begun.turnId, "the second answer belongs to the harness's turn");
    assert.equal(items(events).filter((i) => i.kind === "user" && i.turnId === b.turnId).length, 0, "no user item starts the harness's turn");
    // Stored, as a reload gets it.
    const stored = engine.readThread({ threadId: bot.mainThreadId, limit: 100 }).items.filter((i): i is BotItem => i.kind === "bot");
    assert.deepEqual(stored.map((i) => i.turnId), [user.turnId, begun.turnId]);
    const after = states(events, bot.id).at(-1)!;
    assert.equal(after.state, "done");
    assert.equal(after.turnId, undefined, "Bot.turnId is gone once the turn ended");
    engine.shutdown();
    store.close();
  });

  test("a result told in a turn of its own (wake) gets its own turn id and Bot.turnId too", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, T);
    const bot = engine.createBot("Po");
    engine.sendMessage({ botId: bot.id, text: "Hello" });
    await settle();
    const s = sessions.at(-1)!;
    const user = items(events).find((i): i is UserItem => i.kind === "user")!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "text-full", key: "a", text: "First answer." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(states(events, bot.id).at(-1)!.turnId, undefined);

    const rt = engine.bots.get(bot.id)!;
    const from = events.length;
    wake(engine, rt, { text: "A helper's result.", purpose: { startedBy: "you", threadId: bot.mainThreadId, fresh: false, hops: 0 } });
    await settle();
    const begun = states(events.slice(from), bot.id).find((b) => b.turnId);
    assert.ok(begun, "Bot.turnId is set when the result's turn begins");
    assert.notEqual(begun.turnId, user.turnId);
    assert.equal(s.sent.at(-1)?.text, "A helper's result.", "the result is told to the harness");
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "text-full", key: "b", text: "Second answer." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await wait(60);
    const texts = items(events).filter((i): i is BotItem => i.kind === "bot");
    assert.deepEqual(texts.map((t) => [t.text, t.turnId]), [["First answer.", user.turnId], ["Second answer.", begun.turnId]]);
    assert.equal(items(events).filter((i) => i.kind === "user").length, 1, "the result adds no user item");
    assert.equal(states(events, bot.id).at(-1)!.turnId, undefined);
    engine.shutdown();
    store.close();
  });
});
