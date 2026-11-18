// Step 7c, part 2: to-dos for the person. A bot adds, changes, removes and lists its own; the modal is
// built from fixed blocks, checked with plain words; the person's answer wakes the bot in its main
// chat as his own message, and the to-do is then off the list unless the bot keeps it open; done and
// dismiss reach the bot at its next turn; a file block is served only from inside the bot's folder.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Events, Todo, UserItem } from "../../shared/protocol.js";
import { TODOS_PER_BOT } from "../../shared/protocol.js";
import { TOOL_NAMES } from "../team.js";
import { answerText, cleanDue } from "../todos.js";
import { settle, setup, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201c7b1c8a20000000049454e44ae426082", "hex");

async function world() {
  const w = setup(undefined, () => true, { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 });
  const bot = w.engine.createBot("Kaja");
  w.engine.sendMessage({ botId: bot.id, text: "Hello" });
  await settle();
  const s = w.sessions.at(-1)!;
  s.reply("Hi");
  await settle();
  const dir = join(w.dirs.botsDir, bot.id);
  return { ...w, bot, s, dir };
}

const todoEvents = (events: Ev[]) => events.filter((e) => e.event === "todo.changed" || e.event === "todo.removed");
const lastTodo = (events: Ev[]) => (events.filter((e) => e.event === "todo.changed").at(-1)?.data as Events["todo.changed"] | undefined)?.todo;
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");
const idOf = (r: { content: { text: string }[] }) => /\(id (todo_[a-z0-9]{16})\)/.exec(text(r))?.[1] ?? "";

async function add(s: FakeSession, args: Record<string, unknown>) {
  return s.tool(TOOL_NAMES.addTodo, args);
}

describe("step 7c: to-dos, the bot's tools", () => {
  test("every bot has the four tools, both on Claude and the main bot", async () => {
    const w = await world();
    for (const n of ["add_todo", "update_todo", "remove_todo", "list_todos"]) assert.ok(w.s.toolNames().includes(n), n);
    w.engine.shutdown();
    w.store.close();
  });

  test("add_todo with every kind of block: checked, shaped, sent to the window, in the snapshot", async () => {
    const w = await world();
    mkdirSync(join(w.dir, "out"));
    writeFileSync(join(w.dir, "out", "chart.png"), PNG);
    writeFileSync(join(w.dir, "out", "report.pdf"), "%PDF-1.4 fake");
    mkdirSync(join(w.dir, "artifacts", "status"), { recursive: true });
    writeFileSync(join(w.dir, "artifacts", "status", "index.html"), "<title>Import status</title><p>ok</p>");
    const r = await add(w.s, {
      title: "Send the Nordvik summary",
      why: "The import is done and the customer waits.",
      by_when: "2026-11-20",
      blocks: [
        { type: "text", text: "The import **finished** at 09:12." },
        { type: "facts", facts: [{ label: "Customer", value: "Nordvik AB" }, { label: "Rows", value: "4 210" }] },
        { type: "link", label: "The ticket", url: "https://example.com/ticket/1" },
        { type: "copy", label: "Email draft", text: "Hej,\n\nImporten är klar.\n" },
        { type: "file", path: "out/chart.png" },
        { type: "file", path: "out/report.pdf", label: "Import report" },
        { type: "page", path: "artifacts/status/index.html" },
        { type: "field", label: "Anything to add?", input: "long", placeholder: "A line for the customer" },
        { type: "field", id: "lang", label: "Language", input: "choice", choices: ["Swedish", "English"], value: "Swedish" },
      ],
      buttons: [{ label: "Sent it", primary: true }, { label: "Not yet" }],
    });
    assert.ok(!r.isError, text(r));
    const todo = lastTodo(w.events)!;
    assert.equal(idOf(r), todo.id);
    assert.deepEqual([todo.title, todo.why, todo.due, todo.keepOpen, todo.botId], ["Send the Nordvik summary", "The import is done and the customer waits.", "2026-11-20", false, w.bot.id]);
    assert.deepEqual(todo.blocks.map((b) => b.type), ["text", "facts", "link", "copy", "file", "file", "page", "field", "field"]);
    const [pic, pdf] = todo.blocks.filter((b) => b.type === "file") as Extract<Todo["blocks"][number], { type: "file" }>[];
    assert.deepEqual([pic!.path, pic!.name, pic!.picture], ["out/chart.png", "chart.png", true]);
    assert.deepEqual([pdf!.name, pdf!.picture], ["Import report", false]);
    const page = todo.blocks[6] as Extract<Todo["blocks"][number], { type: "page" }>;
    assert.deepEqual([page.artifact.title, page.artifact.path, page.artifact.kind], ["Import status", "artifacts/status/index.html", "page"]);
    const fields = todo.blocks.filter((b) => b.type === "field") as Extract<Todo["blocks"][number], { type: "field" }>[];
    assert.deepEqual(fields.map((f) => f.id), ["anything-to-add", "lang"]);
    assert.deepEqual(todo.buttons, [{ id: "sent-it", label: "Sent it", primary: true }, { id: "not-yet", label: "Not yet" }]);
    assert.deepEqual(w.engine.snapshot().todos.map((t) => t.id), [todo.id]);
    // The file of block 4 (the picture) is served inline; the PDF as a download; another block, nothing.
    const served = w.engine.todoFile(todo.id, 4)!;
    assert.deepEqual([served.inline, served.type, served.name], [true, "image/png", "chart.png"]);
    const pdfServed = w.engine.todoFile(todo.id, 5)!;
    assert.deepEqual([pdfServed.inline, pdfServed.type, pdfServed.name], [false, "application/octet-stream", "Import report"]);
    assert.equal(w.engine.todoFile(todo.id, 0), undefined);
    assert.equal(w.engine.todoFile(todo.id, 99), undefined);
    w.engine.shutdown();
    w.store.close();
  });

  test("plain words for what is wrong; nothing outside the bot's folder; at most 50 open", async () => {
    const w = await world();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(w.dir, "link.txt"));
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ title: "" }, /needs a short title/],
      [{ title: "x", by_when: "next friday" }, /by_when must be a day like 2026-11-20/],
      [{ title: "x", by_when: "2026-02-30" }, /not a real day/],
      [{ title: "x", blocks: [{ type: "html", text: "<b>" }] }, /unknown type "html"/],
      [{ title: "x", blocks: [{ type: "link", url: "javascript:alert(1)" }] }, /https:\/\/ or mailto:/],
      [{ title: "x", blocks: [{ type: "file", path: join(outside, "secret.txt") }] }, /outside your folder/],
      [{ title: "x", blocks: [{ type: "file", path: "link.txt" }] }, /a link to a place outside your folder/],
      [{ title: "x", blocks: [{ type: "file", path: "nope.txt" }] }, /There is no file at nope\.txt/],
      [{ title: "x", blocks: [{ type: "page", path: "notes.md" }] }, /Only an HTML file/],
      [{ title: "x", blocks: [{ type: "field", label: "Pick", input: "choice", choices: ["one"] }] }, /at least two choices/],
      [{ title: "x", buttons: [{ label: "a", primary: true }, { label: "b", primary: true }] }, /At most one button can be primary/],
    ];
    for (const [args, words] of cases) {
      const r = await add(w.s, args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(text(r), words);
    }
    assert.equal(w.engine.snapshot().todos.length, 0);
    for (let i = 0; i < TODOS_PER_BOT; i++) assert.ok(!(await add(w.s, { title: `T${i}` })).isError);
    const over = await add(w.s, { title: "One too many" });
    assert.match(text(over), /already have 50 open to-dos/);
    w.engine.shutdown();
    w.store.close();
  });

  test("fields without buttons get a plain Send; update, list and remove; another bot's id is not found", async () => {
    const w = await world();
    const r = await add(w.s, { title: "Pick a date", blocks: [{ type: "field", label: "Date", input: "short" }] });
    const id = idOf(r);
    assert.deepEqual(lastTodo(w.events)!.buttons, [{ id: "send", label: "Send", primary: true }]);
    const u = await w.s.tool(TOOL_NAMES.updateTodo, { id, title: "Pick a start date", by_when: "2026-11-21T15:00" });
    assert.ok(!u.isError, text(u));
    assert.deepEqual([lastTodo(w.events)!.title, lastTodo(w.events)!.due, lastTodo(w.events)!.buttons.length], ["Pick a start date", "2026-11-21T15:00", 1]);
    const listed = text(await w.s.tool(TOOL_NAMES.listTodos));
    assert.match(listed, new RegExp(`- ${id}: "Pick a start date" \\(made .*; by 2026-11-21 15:00\\)`));
    assert.match(text(await w.s.tool(TOOL_NAMES.updateTodo, { id: "todo_aaaaaaaaaaaaaaaa", title: "x" })), /no to-do with that id/);
    const rm = await w.s.tool(TOOL_NAMES.removeTodo, { id });
    assert.match(text(rm), /Took "Pick a start date" off the person's list/);
    assert.deepEqual(todoEvents(w.events).at(-1)?.data, { todoId: id, reason: "removed" });
    assert.match(text(await w.s.tool(TOOL_NAMES.listTodos)), /no open to-dos/);
    assert.match(text(await w.s.tool(TOOL_NAMES.updateTodo, { id, title: "again" })), /no longer open/);
    w.engine.shutdown();
    w.store.close();
  });

  test("cleanDue and answerText", () => {
    assert.equal(cleanDue("2026-11-20 09:05"), "2026-11-20T09:05");
    assert.equal(cleanDue(""), undefined);
    const todo = {
      buttons: [{ id: "ok", label: "Approve" }],
      blocks: [
        { type: "field", id: "note", label: "Note", input: "long" },
        { type: "field", id: "who", label: "Who", input: "short" },
      ],
    } as unknown as Todo;
    assert.equal(answerText(todo, "ok", { note: "Line one\nLine two", who: "" }), 'Pressed "Approve".\nNote:\nLine one\nLine two');
  });
});

describe("step 7c: to-dos, the person's answer", () => {
  test("a button and fields: the bot is woken with them as his message, marked from the to-do; the to-do is off the list", async () => {
    const w = await world();
    const id = idOf(await add(w.s, { title: "Approve the mail", blocks: [{ type: "copy", text: "Hej" }, { type: "field", id: "note", label: "Note", input: "long" }], buttons: [{ id: "go", label: "Send it" }] }));
    w.engine.answerTodo({ todoId: id, buttonId: "go", values: { note: "Add the date." } });
    await settle();
    assert.deepEqual(todoEvents(w.events).at(-1)?.data, { todoId: id, reason: "answered" });
    const sent = w.s.sent.at(-1)!;
    assert.equal(sent.text, 'Pressed "Send it".\nNote:\nAdd the date.');
    assert.ok(sent.before.some((b) => b.includes(`your to-do "Approve the mail" (${id})`) && b.includes("It is off their list now.")), sent.before.join(" | "));
    const item = w.engine.readThread({ threadId: w.bot.mainThreadId }).items.find((i) => i.kind === "user" && i.text.startsWith("Pressed")) as UserItem;
    assert.deepEqual(item.from, { type: "you", todo: { id, title: "Approve the mail" } });
    assert.throws(() => w.engine.answerTodo({ todoId: id, buttonId: "go" }), /no longer on your list/);
    w.engine.shutdown();
    w.store.close();
  });

  test("kept open: the answer is recorded on it and it stays; the bot is told so", async () => {
    const w = await world();
    const id = idOf(await add(w.s, { title: "Weekly check", keep_open: true, buttons: [{ label: "Done this week" }] }));
    w.engine.answerTodo({ todoId: id, buttonId: "done-this-week" });
    await settle();
    const kept = lastTodo(w.events)!;
    assert.equal(kept.id, id);
    assert.equal(kept.answer?.label, "Done this week");
    assert.deepEqual(w.engine.snapshot().todos.map((t) => t.id), [id]);
    assert.ok(w.s.sent.at(-1)!.before.some((b) => b.includes("stays on their list")));
    w.engine.shutdown();
    w.store.close();
  });

  test("while the bot works, the answer waits in line (never steered); wrong input is refused in plain words", async () => {
    const w = await world();
    const id = idOf(await add(w.s, { title: "Choose", blocks: [{ type: "field", id: "c", label: "Colour", input: "choice", choices: ["Red", "Blue"] }] }));
    assert.throws(() => w.engine.answerTodo({ todoId: id }), /Press a button or fill in a field first/);
    assert.throws(() => w.engine.answerTodo({ todoId: id, values: { c: "Green" } }), /Choose one of the choices for Colour/);
    assert.throws(() => w.engine.answerTodo({ todoId: id, buttonId: "nope" }), /not on this to-do any more/);
    w.engine.sendMessage({ botId: w.bot.id, text: "Work on something" });
    await settle();
    w.engine.answerTodo({ todoId: id, values: { c: "Blue" } });
    await settle();
    const item = w.engine.readThread({ threadId: w.bot.mainThreadId }).items.find((i) => i.kind === "user" && i.text === "Colour: Blue") as UserItem;
    assert.equal(item.queued, true);
    assert.equal(item.steered, undefined);
    // In the stack above the message box (step 7a) it cannot be taken back: the to-do left the list with it.
    assert.throws(() => w.engine.unqueue({ botId: w.bot.id, itemId: item.id }), /cannot be taken back/);
    assert.equal((w.engine.readThread({ threadId: w.bot.mainThreadId }).items.find((i) => i.id === item.id) as UserItem | undefined)?.queued, true);
    w.engine.shutdown();
    w.store.close();
  });

  test("done and dismissed by the person: off the list, and the bot hears of it at its next turn", async () => {
    const w = await world();
    const a = idOf(await add(w.s, { title: "Call Nordvik" }));
    const b = idOf(await add(w.s, { title: "Old idea" }));
    w.engine.closeTodo({ todoId: a, how: "done" });
    w.engine.closeTodo({ todoId: b, how: "dismissed" });
    assert.deepEqual(todoEvents(w.events).slice(-2).map((e) => e.data), [{ todoId: a, reason: "done" }, { todoId: b, reason: "dismissed" }]);
    assert.equal(w.engine.snapshot().todos.length, 0);
    w.engine.sendMessage({ botId: w.bot.id, text: "Next" });
    await settle();
    const before = w.s.sent.at(-1)!.before.join("\n");
    assert.match(before, /marked your to-do "Call Nordvik" \(todo_[a-z0-9]+\) done themselves/);
    assert.match(before, /dismissed your to-do "Old idea"/);
    assert.throws(() => w.engine.closeTodo({ todoId: a, how: "done" }), /no longer on your list/);
    w.engine.shutdown();
    w.store.close();
  });

  test("a retired bot's to-dos leave the list", async () => {
    const w = await world();
    const other = w.engine.createBot("Inbox");
    w.engine.sendMessage({ botId: other.id, text: "Hi" });
    await settle();
    const s2 = w.sessions.at(-1)!;
    const id = idOf(await s2.tool(TOOL_NAMES.addTodo, { title: "From Inbox" }));
    s2.reply("ok");
    await settle();
    w.engine.retireBot(other.id);
    assert.deepEqual(todoEvents(w.events).at(-1)?.data, { todoId: id, reason: "retired" });
    w.engine.shutdown();
    w.store.close();
  });
});
