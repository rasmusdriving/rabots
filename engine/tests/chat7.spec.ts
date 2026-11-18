// Job 7, the chat (step 7a, protocol 15): a waiting message moves to where it is read and can be
// taken back; thinking summaries and the kind of each line of work; the bot's own to-do list from
// Claude's task tools, TodoWrite and Codex's plan; a colour per bot; the provider of a helper.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ActivityItem, Bot, Events, HelperItem, UserItem } from "../../shared/protocol.js";
import { BOT_COLORS } from "../../shared/protocol.js";
import { pickColor } from "../bots.js";
import { toolKind } from "../claude/labels.js";
import { EngineError } from "../errors.js";
import { applyTaskTool, todoWriteSteps } from "../plan.js";
import { teamPrompt } from "../team.js";
import { settle, setup, upserts, type Ev } from "./fake.js";
import { tempDir } from "./helpers.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const lastBot = (events: Ev[], id: string): Bot | undefined =>
  events
    .filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === id)
    .map((e) => (e.data as Events["bot.updated"]).bot)
    .at(-1);

describe("step 7a: waiting messages", () => {
  test("a queued message moves to the end of the thread when its turn starts, and thread.queued lists what waits", async () => {
    const { engine, sessions, store } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "one" });
    await settle();
    const two = engine.sendMessage({ botId: bot.id, text: "two", mode: "queue" });
    const three = engine.sendMessage({ botId: bot.id, text: "three", mode: "queue" });
    assert.equal(two.queued, true);
    assert.deepEqual(engine.queuedOf(bot.mainThreadId).items.map((i) => i.text), ["two", "three"]);
    const s = sessions[0]!;
    s.reply("first answer");
    await settle();
    const read = engine.readThread({ threadId: bot.mainThreadId }).items;
    const texts = read.map((i) => (i.kind === "user" ? `u:${i.text}` : i.kind === "bot" ? `b:${i.text}` : i.kind));
    // "two" now stands after the answer it waited for; "three" still waits where it was sent.
    assert.deepEqual(texts, ["u:one", "u:three", "b:first answer", "u:two"]);
    assert.ok((store.getItem(two.id) as UserItem).seq > (store.getItem(three.id) as UserItem).seq);
    assert.deepEqual(engine.queuedOf(bot.mainThreadId).items.map((i) => i.text), ["three"]);
    engine.shutdown();
    store.close();
  });

  test("message.unqueue takes a waiting message back: gone from the line, the thread and the database", async () => {
    const { engine, sessions, store, events } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "one" });
    await settle();
    const two = engine.sendMessage({ botId: bot.id, text: "two", mode: "queue" });
    const three = engine.sendMessage({ botId: bot.id, text: "three", mode: "queue" });
    assert.deepEqual(engine.unqueue({ botId: bot.id, itemId: two.id }), {});
    const removed = events.filter((e) => e.event === "item.removed").map((e) => e.data as Events["item.removed"]);
    assert.deepEqual(removed, [{ threadId: bot.mainThreadId, itemId: two.id }]);
    assert.equal(store.getItem(two.id), undefined);
    assert.throws(() => engine.unqueue({ botId: bot.id, itemId: two.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    const s = sessions[0]!;
    s.reply("first answer");
    await settle();
    // The next in line is "three"; "two" is never sent.
    assert.deepEqual(s.sent.map((x) => x.text), ["one", "three"]);
    assert.equal((store.getItem(three.id) as UserItem).queued, false);
    // A message that is no longer waiting cannot be taken back.
    assert.throws(() => engine.unqueue({ botId: bot.id, itemId: three.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    engine.shutdown();
    store.close();
  });
});

describe("step 7a: lines of work", () => {
  test("each line of work says its kind, and a thinking summary is a line of its own", async () => {
    const { engine, sessions, store, events } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "thought", key: "th1", text: "**Checking the files**\n\nI look at the folder first, then run the tests." });
    s.emit({ type: "tool-start", toolUseId: "t1", name: "Bash", input: { command: "ls" } });
    s.emit({ type: "tool-end", toolUseId: "t1", isError: false, text: "a" });
    s.emit({ type: "tool-start", toolUseId: "t2", name: "Read", input: { file_path: "/x/AGENTS.md" } });
    s.emit({ type: "tool-end", toolUseId: "t2", isError: false, text: "a" });
    s.reply("done");
    await settle();
    const lines = items(events).filter((i): i is ActivityItem => i.kind === "activity" && i.botId === bot.id);
    assert.deepEqual(
      lines.map((l) => [l.tool, l.label, l.status]),
      [
        ["think", "Checking the files", "done"],
        ["command", "Ran a command", "done"],
        ["read", "Read AGENTS.md", "done"],
      ],
    );
    assert.match(lines[0]!.detail ?? "", /run the tests/);
    // In the order it came: the thought before the command.
    assert.ok(lines[0]!.seq < lines[1]!.seq);
    engine.shutdown();
    store.close();
  });

  test("the kinds of the harness's tools", () => {
    assert.equal(toolKind("Bash", { command: "npm test" }), "command");
    assert.equal(toolKind("Bash", { command: "ego-browser run x" }), "web");
    assert.equal(toolKind("Edit", {}), "edit");
    assert.equal(toolKind("Write", {}), "edit");
    assert.equal(toolKind("Grep", {}), "search");
    assert.equal(toolKind("WebFetch", {}), "web");
    assert.equal(toolKind("TaskCreate", {}), "plan");
    assert.equal(toolKind("mcp__pobots__message_bot", {}), "message");
    assert.equal(toolKind("mcp__pobots__list_bots", {}), "other");
  });
});

describe("step 7a: the bot's to-do list", () => {
  test("Claude's task tools build the list, kept over a restart; a new session clears it", async () => {
    const first = setup();
    const bot = first.engine.createBot("Kaja");
    first.engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = first.sessions[0]!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const create = (id: string, subject: string, n: number) => {
      s.emit({ type: "tool-start", toolUseId: `c${n}`, name: "TaskCreate", input: { subject, description: subject } });
      s.emit({ type: "tool-end", toolUseId: `c${n}`, isError: false, text: `Task #${id} created successfully: ${subject}`, full: `Task #${id} created successfully: ${subject}` });
    };
    create("1", "Read the brief", 1);
    create("2", "Build it", 2);
    create("3", "Test it", 3);
    s.emit({ type: "tool-start", toolUseId: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } });
    s.emit({ type: "tool-end", toolUseId: "u1", isError: false, text: "Updated task #1 status", full: "Updated task #1 status" });
    s.emit({ type: "tool-start", toolUseId: "u2", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } });
    s.emit({ type: "tool-end", toolUseId: "u2", isError: false, text: "Updated task #2 status", full: "Updated task #2 status" });
    await settle();
    const plan = lastBot(first.events, bot.id)?.plan;
    assert.deepEqual(
      plan?.steps.map((x) => [x.text, x.status]),
      [
        ["Read the brief", "completed"],
        ["Build it", "inProgress"],
        ["Test it", "pending"],
      ],
    );
    assert.ok(plan?.turnId && plan.updatedAt);
    first.engine.shutdown();
    first.store.close();

    // Kept over a restart.
    const second = setup(first.dirs);
    const again = second.engine.snapshot().bots.find((b) => b.id === bot.id)!;
    assert.deepEqual(again.plan?.steps.map((x) => x.status), ["completed", "inProgress", "pending"]);
    second.engine.shutdown();
    second.store.close();
  });

  test("TodoWrite gives the whole list; Codex's plan event replaces it; an empty one takes it away", async () => {
    const { engine, sessions, store, events } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.emit({ type: "tool-start", toolUseId: "w1", name: "TodoWrite", input: { todos: [{ content: "One", status: "completed", activeForm: "Doing one" }, { content: "Two", status: "in_progress" }, { content: " ", status: "pending" }] } });
    await settle();
    assert.deepEqual(lastBot(events, bot.id)?.plan?.steps, [
      { text: "One", status: "completed" },
      { text: "Two", status: "inProgress" },
    ]);
    s.emit({ type: "plan", steps: [{ text: "Plan A", status: "inProgress" }], explanation: "Short" });
    await settle();
    assert.deepEqual(lastBot(events, bot.id)?.plan?.steps, [{ text: "Plan A", status: "inProgress" }]);
    assert.equal(lastBot(events, bot.id)?.plan?.explanation, "Short");
    s.emit({ type: "plan", steps: [] });
    await settle();
    assert.equal(lastBot(events, bot.id)?.plan, undefined);
    engine.shutdown();
    store.close();
  });

  test("applyTaskTool: structured results, deleted, unknown ids, and a fresh list after a finished one", () => {
    let kept = applyTaskTool(undefined, "TaskCreate", { subject: "A" }, { task: { id: "7", subject: "A" } }, undefined, false)!;
    assert.deepEqual(kept.keys, ["7"]);
    kept = applyTaskTool(kept, "TaskCreate", { subject: "B" }, undefined, "Task #8 created successfully: B", false)!;
    assert.deepEqual(kept.plan.steps.map((s) => s.text), ["A", "B"]);
    assert.equal(applyTaskTool(kept, "TaskUpdate", { taskId: "99", status: "completed" }, undefined, "Updated task #99", false), undefined);
    kept = applyTaskTool(kept, "TaskUpdate", { taskId: "7", status: "deleted" }, undefined, "Updated task #7 deleted", false)!;
    assert.deepEqual(kept.keys, ["8"]);
    const fresh = applyTaskTool(kept, "TaskCreate", { subject: "C" }, undefined, "Task #9 created successfully: C", true)!;
    assert.deepEqual(fresh.plan.steps.map((s) => s.text), ["C"]);
    const listed = applyTaskTool(kept, "TaskList", {}, { tasks: [{ id: "8", subject: "B", status: "completed" }, { id: "9", subject: "C", status: "pending" }] }, undefined, false)!;
    assert.deepEqual(listed.plan.steps.map((s) => [s.text, s.status]), [["B", "completed"], ["C", "pending"]]);
    assert.deepEqual(todoWriteSteps({ todos: "no" }), undefined);
  });

  test("the bots are told to keep a to-do list with their harness's tool", () => {
    assert.match(teamPrompt("bot", "claude"), /keep a to-do list with your task tools/);
    assert.match(teamPrompt("bot", "codex"), /keep a plan with your update_plan tool/);
  });
});

describe("step 7a: a colour per bot", () => {
  test("new bots get distinct colours; a colour can be chosen and changed; an older bot gets one once", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    // A bot from before, without a colour.
    mkdirSync(join(dirs.botsDir, "old"), { recursive: true });
    writeFileSync(join(dirs.botsDir, "old", "bot.json"), JSON.stringify({ name: "Old", role: "main", look: { eyes: "tall", gap: "near" }, model: "claude-opus-5-5", effort: "medium", access: "asks-first", machine: "x" }));
    const { engine, store } = setup(dirs);
    const old = engine.snapshot().bots.find((b) => b.id === "old")!;
    assert.ok(old.look.color && BOT_COLORS.includes(old.look.color));
    assert.equal(JSON.parse(readFileSync(join(dirs.botsDir, "old", "bot.json"), "utf8")).look.color, old.look.color, "saved in bot.json");
    const a = engine.createBot("A");
    const b = engine.createBot("B");
    const colours = [old.look.color, a.look.color, b.look.color];
    assert.equal(new Set(colours).size, 3, "distinct");
    const c = engine.createBot({ name: "C", look: { eyes: "round", gap: "mid", color: "rose" } });
    assert.equal(c.look.color, "rose");
    const changed = await engine.updateBot({ botId: a.id, patch: { look: { eyes: a.look.eyes, gap: a.look.gap, color: "teal" } } });
    assert.equal(changed.look.color, "teal");
    // A look without a colour keeps the colour it had.
    const kept = await engine.updateBot({ botId: a.id, patch: { look: { eyes: "square", gap: "far" } } });
    assert.equal(kept.look.color, "teal");
    engine.shutdown();
    store.close();
  });

  test("pickColor goes through the palette, grey last, then the least used", () => {
    assert.equal(pickColor([]), "sky");
    assert.equal(pickColor(["sky"]), "teal");
    assert.equal(pickColor(BOT_COLORS.filter((c) => c !== "grey")), "grey");
    assert.equal(pickColor([...BOT_COLORS, "sky"]), "teal");
  });
});

describe("step 7a: the provider of a helper", () => {
  test("a helper started by the harness on a Claude bot says claude", async () => {
    const { engine, sessions, store, events } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = sessions[0]!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.helperStart("h1", { description: "Look around", prompt: "Look around" });
    await settle();
    const row = items(events).find((i): i is HelperItem => i.kind === "helper");
    assert.equal(row?.harness, "claude");
    engine.shutdown();
    store.close();
  });
});
