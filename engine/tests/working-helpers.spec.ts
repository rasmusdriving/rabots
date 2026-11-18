// Helpers at work (protocol 19): a bot lists the helpers that work now, wherever their rows stand,
// so the window can show them in one place and lead to each one's thread
// (docs/build/step-helpers-in-rail.md). Fake harness, as in helpers.spec.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bot, Events, HelperItem } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { lastState, settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";

const FAST = { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 };
const world = () => setup(undefined, () => true, FAST);
const helpers = (events: Ev[]) => [...new Map(upserts(events).filter((i): i is HelperItem => i.kind === "helper").map((i) => [i.id, i] as const)).values()];
const botOf = (events: Ev[], id: string): Bot | undefined => lastState(events, id);
const updates = (events: Ev[], id: string) =>
  events.filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id).map((e) => (e.data as Events["bot.updated"]).bot);

async function send(engine: Engine, sessions: FakeSession[], botId: string, text: string) {
  engine.sendMessage({ botId, text });
  await settle();
  return sessions.at(-1)!;
}

function ownTurn(s: FakeSession, text: string, body?: () => void, end = true) {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  body?.();
  if (!end) return;
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

describe("helpers at work", () => {
  test("a bot lists its working helpers in the order they started, with a helper's helper, and drops each when it ends", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    assert.equal(bot.workingHelpers, undefined, "no list without helpers");
    const s = await send(engine, sessions, bot.id, "Two things");
    ownTurn(s, "", () => {
      s.helperStart("outer", { description: "Outer **helper**" });
      s.helperStart("inner", { description: "Inner helper", parent: "outer" });
    }, false);
    await settle();
    const [outer, inner] = helpers(events);
    const list = botOf(events, bot.id)!.workingHelpers!;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((w) => w.itemId), [outer!.id, inner!.id]);
    assert.equal(list[0]!.title, "Outer helper");
    assert.equal(list[0]!.threadId, bot.mainThreadId);
    assert.equal(list[0]!.helperThreadId, outer!.helperThreadId);
    assert.equal(list[0]!.harness, "claude");
    assert.equal(list[0]!.startedAt, outer!.at);
    assert.equal(list[0]!.inRun, undefined, "a helper of the main chat names no run");
    assert.equal(list[0]!.parentItemId, undefined);
    assert.equal(list[1]!.threadId, outer!.helperThreadId, "the inner row stands in the outer helper's thread");
    assert.equal(list[1]!.parentItemId, outer!.id);

    const before = updates(events, bot.id).length;
    s.helperSay("inner", "Reading");
    await settle();
    assert.equal(updates(events, bot.id).length, before, "what a helper says does not send the bot again");

    s.helperEnd("inner", "completed", "pelican", { parent: "outer" });
    await settle();
    assert.deepEqual(botOf(events, bot.id)!.workingHelpers!.map((w) => w.itemId), [outer!.id]);
    s.helperEnd("outer", "completed", "Done.");
    s.emit({ type: "text-full", key: "end", text: "Done." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(botOf(events, bot.id)!.workingHelpers, undefined, "the list goes when the last helper ends");
    engine.shutdown();
    store.close();
  });

  test("a helper of a fresh run names the run", async () => {
    const { engine, sessions, events, store } = world();
    const bot = engine.createBot("Po");
    const t = engine.saveTrigger({ botId: bot.id, trigger: { kind: "webhook", name: "Morning work round", prompt: "Look around.", where: "fresh", enabled: true } });
    engine.runTrigger(t.id);
    await settle();
    const s = sessions.at(-1)!;
    ownTurn(s, "A helper is on it.", () => s.helperStart("h1", { description: "Read the tickets", background: true }));
    await settle();
    const [row] = helpers(events);
    assert.notEqual(row!.threadId, bot.mainThreadId, "the row stands in the run's thread");
    const [w] = botOf(events, bot.id)!.workingHelpers!;
    assert.equal(w!.threadId, row!.threadId);
    assert.equal(w!.inRun, "Morning work round");
    s.helperEnd("h1", "completed", "Nothing new.", { background: true });
    s.wake("Nothing new.");
    await settle();
    assert.equal(botOf(events, bot.id)!.workingHelpers, undefined);
    engine.shutdown();
    store.close();
  });
});
