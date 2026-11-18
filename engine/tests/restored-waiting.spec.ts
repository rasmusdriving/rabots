// Engine 0.31.1: a bot with a restored card reads Waiting for you (docs/build/step-restored-waiting.md).
// Only what is shown changes: the bot's own state stays at rest. Stand-in harness, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalCard, Bot, Events, QuestionCard } from "../../shared/protocol.js";
import { askOnCard } from "../core/card-questions.js";
import { listBotsFor } from "../core/bot-tools.js";
import { settle, setup } from "./fake.js";

type World = ReturnType<typeof setup>;

/** A bot asked a question on a card, then Pobots stopped with the card open; the second engine has it back. */
async function restarted(): Promise<{ w: World; botId: string; card: QuestionCard }> {
  const first = setup();
  const bot = first.engine.createBot("Kaja");
  first.engine.sendMessage({ botId: bot.id, text: "Go through the customers" });
  await settle();
  void first.sessions[0]!.tool("ask_human", { question: "Which customer first?", choices: ["Nordvik", "Aalto"] });
  await settle();
  const card = first.engine.snapshot().cards.find((c): c is QuestionCard => c.kind === "question")!;
  first.engine.shutdown();
  await settle();
  first.store.close();
  const w = setup(first.dirs);
  return { w, botId: bot.id, card };
}

const botOf = (w: World, id: string): Bot => w.engine.snapshot().bots.find((b) => b.id === id)!;
/** The bot as the window was sent it, in order, from event `from` on. */
const sent = (w: World, id: string, from = 0) =>
  w.events
    .slice(from)
    .filter((e) => e.event === "bot.updated")
    .map((e) => (e.data as Events["bot.updated"]).bot)
    .filter((b) => b.id === id);
const done = (w: World) => {
  w.engine.shutdown();
  w.store.close();
};

describe("a bot with a restored card reads Waiting for you", () => {
  test("a restored question: waiting, with the words it had, and atRest; its own state stays at rest", async () => {
    const { w, botId } = await restarted();
    const b = botOf(w, botId);
    assert.equal(b.state, "waiting");
    assert.equal(b.activity, "Waiting for your answer");
    assert.equal(b.atRest, true);
    assert.equal(w.engine.bots.get(botId)!.state, "idle", "the engine's own state changed");
    done(w);
  });

  test("answering it goes straight to thinking (never idle between), and after the turn the bot is not waiting", async () => {
    const { w, botId, card } = await restarted();
    const from = w.events.length;
    w.engine.resolveCard(card.id, { type: "choice", choiceId: card.choices[1]!.id });
    const first = sent(w, botId, from)[0];
    assert.equal(first?.state, "thinking", JSON.stringify(sent(w, botId, from)));
    assert.equal(first?.atRest, undefined);
    await settle();
    w.sessions.at(-1)!.reply("Aalto it is.");
    await settle();
    const all = sent(w, botId, from);
    assert.ok(!all.some((b) => b.state === "idle"), JSON.stringify(all.map((b) => b.state)));
    assert.ok(!all.slice(1).some((b) => b.state === "waiting"), "it read waiting again after the answer");
    assert.equal(botOf(w, botId).state, "done");
    assert.equal(botOf(w, botId).atRest, undefined);
    done(w);
  });

  test("Later goes straight to idle, once, and starts no turn; so does a dismiss", async () => {
    for (const type of ["later", "deny"] as const) {
      const { w, botId, card } = await restarted();
      const from = w.events.length;
      w.engine.resolveCard(card.id, { type });
      const all = sent(w, botId, from);
      assert.equal(all.length, 1, JSON.stringify(all));
      assert.equal(all[0]!.state, "idle");
      assert.equal(all[0]!.atRest, undefined);
      await settle();
      assert.equal(w.sessions.length, 0, "a turn was started");
      done(w);
    }
  });

  test("work while the card is open reads working (Working wins), then waiting again", async () => {
    const { w, botId, card } = await restarted();
    const from = w.events.length;
    w.engine.sendMessage({ botId, text: "Something else first" });
    await settle();
    assert.equal(botOf(w, botId).state, "thinking");
    assert.equal(botOf(w, botId).atRest, undefined);
    w.sessions[0]!.reply("Done with that.");
    await settle();
    const b = botOf(w, botId);
    assert.equal(b.state, "waiting");
    assert.equal(b.activity, "Waiting for your answer");
    assert.equal(b.atRest, true);
    assert.equal(sent(w, botId, from).at(-1)?.state, "waiting", "the window was not sent the waiting again");
    // Straight from the work to Waiting: no Finished or Idle in between.
    assert.ok(!sent(w, botId, from).some((b) => b.state === "done" || b.state === "idle"), JSON.stringify(sent(w, botId, from).map((b) => b.state)));
    assert.deepEqual(w.engine.snapshot().cards.map((c) => c.id), [card.id]);
    done(w);
  });

  test("a follow-up question on it starts a turn (working), then waiting again; the answer then goes to thinking", async () => {
    const { w, botId, card } = await restarted();
    const from = w.events.length;
    askOnCard(w.engine, { cardId: card.id, text: "Does it matter?" });
    await settle();
    assert.equal(botOf(w, botId).state, "thinking");
    w.sessions.at(-1)!.reply("Not much.");
    await settle();
    assert.equal(botOf(w, botId).state, "waiting");
    assert.equal(botOf(w, botId).atRest, true);
    const mid = w.events.length;
    w.engine.resolveCard(card.id, { type: "text", text: "Aalto" });
    assert.equal(sent(w, botId, mid)[0]?.state, "thinking");
    assert.ok(!sent(w, botId, from).some((b) => b.state === "idle"), JSON.stringify(sent(w, botId, from).map((b) => b.state)));
    await settle();
    done(w);
  });

  test("a restored approval reads Waiting for your approval; running out goes to idle", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    await first.engine.updateBot({ botId: bot.id, patch: { access: "asks-first" } });
    first.engine.sendMessage({ botId: bot.id, text: "Clean up" });
    await settle();
    void first.sessions[0]!.ask("Bash", { command: "ls -la" });
    await settle();
    const card = first.engine.snapshot().cards.find((c): c is ApprovalCard => c.kind === "approval")!;
    first.engine.shutdown();
    await settle();
    // Its time runs out right after the start.
    first.store.removeCard(card.id);
    first.store.addCard({ ...card, expiresAt: new Date(Date.now() + 150).toISOString() });
    first.store.close();
    const w = setup(first.dirs);
    const b = botOf(w, bot.id);
    assert.equal(b.state, "waiting");
    assert.equal(b.activity, "Waiting for your approval");
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    assert.equal(w.engine.snapshot().cards.length, 0);
    assert.equal(botOf(w, bot.id).state, "idle");
    assert.equal(sent(w, bot.id).at(-1)?.state, "idle");
    done(w);
  });

  test("a task manager's card and a to-do do not count", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.shutdown();
    first.store.addCard({ kind: "question", id: "qtm", botId: bot.id, threadId: "t-tm", at: new Date().toISOString(), title: "Which page?", choices: [{ id: "0", label: "Booking" }], allowText: true, taskManager: "Build the page" });
    first.store.close();
    const w = setup(first.dirs);
    assert.equal(botOf(w, bot.id).state, "idle");
    assert.equal(botOf(w, bot.id).atRest, undefined);
    w.engine.sendMessage({ botId: bot.id, text: "Write a to-do" });
    await settle();
    const s = w.sessions.at(-1)!;
    await s.tool("add_todo", { title: "Send the summary", why: "It is ready.", blocks: [{ type: "text", text: "Ready to send." }] });
    s.reply("Added.");
    await settle();
    assert.equal(botOf(w, bot.id).state, "done");
    done(w);
  });

  test("a blocked bot stays blocked", async () => {
    const { w, botId } = await restarted();
    w.engine.setState(w.engine.bots.get(botId)!, "blocked", "Claude is not signed in");
    assert.equal(botOf(w, botId).state, "blocked");
    assert.equal(botOf(w, botId).atRest, undefined);
    done(w);
  });

  test("messages held by a Stop keep their own line", async () => {
    const { w, botId } = await restarted();
    const rt = w.engine.bots.get(botId)!;
    rt.queue.push("held-1");
    rt.hold = { held: new Set(["held-1"]) } as typeof rt.hold;
    w.engine.setState(rt, "done", "Stopped");
    assert.equal(botOf(w, botId).state, "done");
    assert.equal(botOf(w, botId).activity, "Stopped, 1 message waiting");
    assert.equal(botOf(w, botId).atRest, undefined);
    rt.hold = undefined;
    rt.queue = [];
    done(w);
  });

  test("Po sees it waiting too", async () => {
    const { w, botId } = await restarted();
    const po = w.engine.createBot("Po");
    assert.match(listBotsFor(w.engine, w.engine.bots.get(po.id)!), /Kaja \(id [^)]+\)\. Purpose: [^.]*\. Now: waiting, waiting for your answer\./);
    void botId;
    done(w);
  });
});
