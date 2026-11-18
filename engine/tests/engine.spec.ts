// The engine core with a fake harness: no model, no Claude process.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BotItem, Events, Item, UserItem } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { lastState, settle, setup, upserts } from "./fake.js";

describe("engine with a fake harness", () => {
  test("creates bots: first is main, slugs are unique, looks differ", () => {
    const { engine, events, store } = setup();
    assert.deepEqual(engine.snapshot().bots, []);
    const a = engine.createBot("Kaja");
    const b = engine.createBot("Kaja");
    assert.equal(a.role, "main");
    assert.equal(b.role, "bot");
    assert.equal(b.id, "kaja-2");
    assert.notDeepEqual(a.look, b.look);
    assert.equal(a.machine, "test-mac");
    assert.equal(events.filter((e) => e.event === "bot.added").length, 2);
    const snap = engine.snapshot();
    assert.deepEqual(snap.bots.map((x) => x.id), ["kaja", "kaja-2"]);
    assert.deepEqual(snap.machines, [{ id: "test-mac", name: "Test Mac", status: "this" }]);
    assert.ok(snap.models.some((m) => m.id === a.model));
    assert.throws(() => engine.createBot("   "), EngineError);
    store.close();
  });

  test("a message streams an answer, and a second message waits in the queue", async () => {
    const { engine, events, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    const first = engine.sendMessage({ botId: bot.id, text: "Hi" });
    assert.equal(first.queued, false);
    await settle();
    assert.equal(sessions.length, 1);
    const s = sessions[0]!;
    assert.equal(s.settings.resume, undefined);
    assert.deepEqual(s.sent, [{ text: "Hi", before: [] }]);
    assert.equal(lastState(events, bot.id)?.state, "thinking");

    const second = engine.sendMessage({ botId: bot.id, text: "And then?" });
    assert.equal(second.queued, true);

    s.reply("Hello there");
    await settle();
    const bots = upserts(events).filter((i): i is BotItem => i.kind === "bot");
    assert.equal(bots.at(-1)?.text, "Hello there");
    assert.equal(bots.at(-1)?.streaming, false);
    assert.equal(events.filter((e) => e.event === "item.delta").length, 4);
    assert.equal(store.getThread(bot.mainThreadId)?.sessionId, "sess-1");

    // The queued message is taken: no longer queued, handed to the same session.
    const taken = upserts(events).filter((i): i is UserItem => i.kind === "user" && i.id === second.id).at(-1);
    assert.equal(taken?.queued, false);
    assert.equal(s.sent[1]?.text, "And then?");
    s.reply("More");
    await settle();
    assert.equal(lastState(events, bot.id)?.state, "done");

    const read = engine.readThread({ threadId: bot.mainThreadId });
    // In the order things were read (step 7a): the queued message moved to where its turn began, after the first reply.
    assert.deepEqual(read.items.map((i) => i.kind), ["user", "bot", "user", "bot"]);
    assert.deepEqual(read.items.map((i) => i.seq), [1, 3, 4, 5]);
    engine.shutdown();
    store.close();
  });

  test("tool calls become activity lines with plain words", async () => {
    const { engine, events, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Look" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "tool-start", toolUseId: "t1", name: "Read", input: { file_path: "/b/AGENTS.md" } });
    assert.equal(lastState(events, bot.id)?.state, "working");
    assert.equal(lastState(events, bot.id)?.activity, "Reading AGENTS.md");
    s.emit({ type: "tool-end", toolUseId: "t1", isError: false });
    const act = upserts(events).filter((i) => i.kind === "activity").at(-1);
    assert.ok(act && act.kind === "activity");
    assert.equal(act.label, "Read AGENTS.md");
    assert.equal(act.status, "done");
    assert.equal(typeof act.durationMs, "number");
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [] });
    engine.shutdown();
    store.close();
  });

  test("approval cards: allow, always allow, deny and later", async () => {
    const { engine, events, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Do it" });
    await settle();
    const s = sessions[0]!;

    const decide = async (decision: Parameters<Engine["resolveCard"]>[1], suggestions?: unknown[]) => {
      const pending = s.ask("Bash", { command: "touch x" }, suggestions);
      const added = events.filter((e) => e.event === "card.added").at(-1)!.data as Events["card.added"];
      assert.equal(added.card.kind, "approval");
      assert.equal(lastState(events, bot.id)?.state, "waiting");
      assert.equal(engine.snapshot().cards.length, 1);
      engine.resolveCard(added.card.id, decision);
      assert.equal(engine.snapshot().cards.length, 0);
      return pending;
    };

    assert.deepEqual(await decide({ type: "allow-once" }), { behavior: "allow", updatedInput: { command: "touch x" } });
    // "Always allow" saves the rule in the engine and adds it to this session only, never to a settings file.
    const rule = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "localSettings" }];
    const sessionRule = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "session" }];
    assert.deepEqual((await decide({ type: "always-allow" }, rule)) as unknown, { behavior: "allow", updatedInput: { command: "touch x" }, updatedPermissions: sessionRule });
    assert.deepEqual(engine.listRules(bot.id).map((r) => [r.label, r.detail]), [["Run commands that start with touch", "Bash(touch:*)"]]);
    assert.equal((await decide({ type: "deny" }))?.behavior, "deny");
    assert.equal((await decide({ type: "later" }))?.behavior, "deny");
    assert.ok(events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).reason === "resolved"));

    const pending = s.ask("Bash", { command: "ls" });
    const card = (events.filter((e) => e.event === "card.added").at(-1)!.data as Events["card.added"]).card;
    assert.throws(() => engine.resolveCard(card.id, { type: "choice", choiceId: "0" }), EngineError);
    assert.throws(() => engine.resolveCard("nope", { type: "deny" }), EngineError);
    engine.resolveCard(card.id, { type: "deny" });
    await pending;
    engine.shutdown();
    store.close();
  });

  test("a question from the bot becomes a question card and the answer goes back", async () => {
    const { engine, events, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Ask me" });
    await settle();
    const input = {
      questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }],
    };
    const pending = sessions[0]!.ask("AskUserQuestion", input);
    const card = (events.filter((e) => e.event === "card.added").at(-1)!.data as Events["card.added"]).card;
    assert.equal(card.kind, "question");
    assert.ok(card.kind === "question");
    assert.deepEqual(card.choices, [{ id: "0", label: "Red" }, { id: "1", label: "Blue" }]);
    engine.resolveCard(card.id, { type: "choice", choiceId: "1" });
    const result = await pending;
    assert.equal(result?.behavior, "allow");
    assert.deepEqual((result as unknown as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which colour?": "Blue" });
    engine.shutdown();
    store.close();
  });

  test("interrupt withdraws open cards and says stopped; the queued message waits until the person writes again (step 3b, third part)", async () => {
    const { engine, events, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Long job" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "text-start", key: "m1" });
    s.emit({ type: "text-delta", key: "m1", text: "1\n2\n" });
    const queued = engine.sendMessage({ botId: bot.id, text: "Next" });
    assert.equal(queued.queued, true);
    const pending = s.ask("Bash", { command: "ls" });

    await engine.interrupt(bot.id);
    assert.equal(s.interrupts, 1);
    assert.equal((await pending)?.behavior, "deny");
    assert.ok(events.some((e) => e.event === "card.removed" && (e.data as Events["card.removed"]).reason === "withdrawn"));
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: ["aborted"] });
    await settle();

    const items = upserts(events);
    assert.ok(items.some((i) => i.kind === "notice" && i.text === "Stopped." && i.tone === "info"));
    assert.ok(!items.some((i) => i.kind === "notice" && i.tone === "error"), "an interrupt is not an error");
    const cut = items.filter((i): i is BotItem => i.kind === "bot").at(-1);
    assert.equal(cut?.streaming, false);
    // Stop holds: the message that waited is still waiting (it used to start here).
    assert.equal(s.sent.length, 1);
    assert.equal((store.getItem(queued.id) as UserItem).queued, true);
    engine.sendMessage({ botId: bot.id, text: "Go on" });
    await settle();
    assert.equal(s.sent.at(-1)?.text, "Next");
    engine.shutdown();
    store.close();
  });

  test("live settings changes reach the running session", async () => {
    const { engine, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Hi" });
    await settle();
    const updated = await engine.updateBot({ botId: bot.id, patch: { model: "claude-haiku-5-5", effort: "low", access: "full-access", name: "Kaja B" } });
    assert.equal(updated.name, "Kaja B");
    assert.deepEqual(sessions[0]!.changes.sort(), ["access:full-access", "effort:low"]);
    engine.shutdown();
    store.close();
  });

  test("a new model starts a new harness on the same session, because the tools on offer depend on the model", async () => {
    const { engine, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Hi" });
    await settle();
    sessions[0]!.reply("Hello");
    await settle();
    await engine.updateBot({ botId: bot.id, patch: { model: "claude-haiku-5-5" } });
    assert.equal(sessions[0]!.closed, true, "the harness kept the tools of the old model");
    assert.deepEqual(sessions[0]!.changes, [], "the model is not switched inside the running harness");
    engine.sendMessage({ botId: bot.id, text: "Go on" });
    await settle();
    assert.equal(sessions[1]!.settings.resume, "sess-1", "the conversation was not kept");
    assert.equal(sessions[1]!.settings.model, "claude-haiku-5-5");
    engine.shutdown();
    store.close();
  });

  test("after a restart the saved session is resumed", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "Remember pineapple" });
    await settle();
    first.sessions[0]!.reply("OK", "sess-saved");
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = setup(first.dirs, (id) => id === "sess-saved");
    const snap = second.engine.snapshot();
    assert.equal(snap.bots[0]?.state, "idle");
    assert.equal(second.engine.readThread({ threadId: bot.mainThreadId }).items.length, 2);
    second.engine.sendMessage({ botId: bot.id, text: "What word?" });
    await settle();
    assert.equal(second.sessions[0]!.settings.resume, "sess-saved");
    assert.deepEqual(second.sessions[0]!.sent[0]?.before, []);
    second.engine.shutdown();
    second.store.close();
  });

  test("when the saved session is gone, a fresh one starts with a handoff and a notice", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "Remember pineapple" });
    await settle();
    first.sessions[0]!.reply("OK", "sess-gone");
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = setup(first.dirs, () => false);
    second.engine.sendMessage({ botId: bot.id, text: "What word?" });
    await settle();
    const s = second.sessions[0]!;
    assert.equal(s.settings.resume, undefined);
    assert.match(s.sent[0]!.before[0]!, /could not be restored/);
    assert.match(s.sent[0]!.before[0]!, /The person: Remember pineapple/);
    assert.match(s.sent[0]!.before[0]!, /You: OK/);
    assert.ok(upserts(second.events).some((i) => i.kind === "notice" && /fresh session/.test(i.text)));
    second.engine.shutdown();
    second.store.close();
  });

  test("when resuming fails inside the harness, the turn retries fresh with a handoff", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "Remember pineapple" });
    await settle();
    first.sessions[0]!.reply("OK", "sess-broken");
    await settle();
    first.engine.shutdown();
    first.store.close();

    const second = setup(first.dirs, () => true);
    second.engine.sendMessage({ botId: bot.id, text: "What word?" });
    await settle();
    const broken = second.sessions[0]!;
    assert.equal(broken.settings.resume, "sess-broken");
    broken.emit({ type: "exit", error: "No conversation found", beforeInit: true });
    await settle();
    const fresh = second.sessions[1]!;
    assert.ok(fresh, "no fresh session was started");
    assert.equal(fresh.settings.resume, undefined);
    assert.equal(fresh.sent[0]?.text, "What word?");
    assert.match(fresh.sent[0]!.before[0]!, /pineapple/);
    assert.equal(second.store.getThread(bot.mainThreadId)?.sessionId, null);
    second.engine.shutdown();
    second.store.close();
  });

  test("a stop in the middle of a turn is tidied up on the next start", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "Go" });
    await settle();
    const s = first.sessions[0]!;
    s.emit({ type: "text-start", key: "m1" });
    s.emit({ type: "text-delta", key: "m1", text: "half" });
    s.emit({ type: "tool-start", toolUseId: "t", name: "Bash", input: { command: "sleep 9" } });
    first.store.close(); // a crash: no shutdown

    const second = setup(first.dirs);
    assert.deepEqual(second.store.openItems(), []);
    const items: Item[] = second.engine.readThread({ threadId: bot.mainThreadId }).items;
    assert.ok(items.some((i) => i.kind === "notice" && /cut short/.test(i.text)));
    assert.ok(items.some((i) => i.kind === "activity" && i.status === "failed"));
    second.engine.shutdown();
    second.store.close();
  });

  test("messages are refused while Claude is not ready", () => {
    const { engine, store } = setup();
    const bot = engine.createBot("Kaja");
    (engine as unknown as { opts: { claude: { ready: boolean; problem?: string } } }).opts.claude.ready = false;
    (engine as unknown as { opts: { claude: { ready: boolean; problem?: string } } }).opts.claude.problem = "Not here.";
    assert.throws(
      () => engine.sendMessage({ botId: bot.id, text: "Hi" }),
      (err: unknown) => err instanceof EngineError && err.code === "harness_unavailable" && err.message === "Not here.",
    );
    assert.throws(() => engine.sendMessage({ botId: "nobody", text: "Hi" }), (err: unknown) => err instanceof EngineError && err.code === "not_found");
    store.close();
  });
});
