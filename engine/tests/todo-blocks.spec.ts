// To-do blocks (engine 0.41.0, docs/build/step-todo-blocks.md): every new to-do gets a block of the
// person's time on Ahead and in Outlook. Against the calendar stand-in and the stand-in harness; no
// model, nothing sent outside. Placing (minutes, the default, before by_when, late, no room, outside
// the day's limit), the create (busy, no Teams, no reminder), moves after a drag, a bot's change and
// a meeting, delete on each kind of close and a past block left alone, following Outlook (moved,
// deleted, never made again), no grey meeting beside a block, a failed write never doubled, the
// switch off makes nothing, and the instruction in the tool texts and the main bot's settings.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolResult } from "../claude/session.js";
import { AHEAD_SCHEDULING_DEFAULT } from "../../shared/protocol.js";
import { aheadAct } from "../core/ahead-person.js";
import { aheadView } from "../core/ahead-view.js";
import { setAheadSettings } from "../core/ahead-settings.js";
import { setCalendar } from "../core/calendar-settings.js";
import { forgetMeetings } from "../core/ahead-meetings.js";
import { stretchOf } from "../core/ahead-slots.js";
import { syncTodoBlocks, todoBlocksSynced } from "../core/todo-block-sync.js";
import { makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { changeLines, type FakeSession, settle, setup } from "./fake.js";

const TZ = "Europe/Stockholm";
/** Thursday 19 Nov 2026, 09:00 in Stockholm. */
const NOW = Date.parse("2026-11-19T08:00:00Z");
const TODAY = "2026-11-19";
const MIN = 60_000;
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;
const g = (iso: string) => ({ dateTime: new Date(iso).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" });
const at = (day: string, time: string) => stretchOf(day, time, 0, TZ).start;

interface StandinEvent {
  id: string;
  subject: string;
  start: { dateTime: string };
  end: { dateTime: string };
  showAs?: string;
  isReminderOn?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeeting?: unknown;
  attendees?: unknown[];
  body?: { contentType: string; content: string };
}
const startOfEvent = (e: StandinEvent) => Date.parse(e.start.dateTime + "Z");

async function world(o: { calendar?: boolean; on?: boolean } = {}) {
  let now = NOW;
  const flow = makeCalendarStandin({
    // Today 09:30 to 10:30 busy.
    seed: [{ id: "m-busy", subject: "Planning", start: g("2026-11-19T08:30:00Z"), end: g("2026-11-19T09:30:00Z"), isOrganizer: true, showAs: "busy", attendees: [] }],
  });
  const url = o.calendar === false ? undefined : await flow.listen();
  const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 }, { timeZone: TZ, clock: () => now });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Keeps sample projects on track" });
  if (url) await setCalendar(w.engine, { address: url });
  setAheadSettings(w.engine, { enabled: true, ...(o.on === false ? {} : { todoBlocks: true }) });
  const close = async () => {
    await todoBlocksSynced(w.engine);
    w.engine.shutdown();
    if (url) await flow.close();
    w.store.close();
  };
  const turn = async (botId: string, msg = "Go") => {
    w.engine.sendMessage({ botId, text: msg });
    await settle();
    return sessionOf(w.sessions, botId);
  };
  const end = async (s: FakeSession) => {
    s.reply("Done.");
    await settle();
  };
  const todoId = (r: ToolResult) => /todo_\w+/.exec(text(r))![0];
  const blockOf = (id: string) => w.store.ahead.blockOf(id);
  const outlook = () => [...flow.events.values()].filter((e) => e.id !== "m-busy") as StandinEvent[];
  const calls = (action: string) => flow.calls.filter((c: { action?: string }) => c.action === action);
  const view = async () => {
    forgetMeetings(w.engine);
    return aheadView(w.engine, {});
  };
  return { ...w, po, kaja, close, turn, end, flow, todoId, blockOf, outlook, calls, view, setNow: (t: number) => (now = t) };
}

describe("to-do blocks: placing", () => {
  test("off by default: add_todo has no minutes and nothing is made; on without a calendar makes nothing either", async () => {
    const w = await world({ on: false });
    try {
      const ks = await w.turn(w.kaja.id);
      const add = ks.settings.tools.find((t) => t.name === "add_todo")!;
      assert.doesNotMatch(add.description, /block of the person's time/);
      const r = await ks.tool("add_todo", { title: "Send the sample summary", minutes: 30 });
      assert.doesNotMatch(text(r), /block/);
      assert.equal(w.blockOf(w.todoId(r)), undefined);
      assert.equal(w.store.getTodo(w.todoId(r))!.todo.minutes, 30, "the minutes are kept on the to-do");
      assert.equal(w.calls("create").length, 0);
    } finally {
      await w.close();
    }
    const n = await world({ calendar: false });
    try {
      const ks = await n.turn(n.kaja.id);
      assert.doesNotMatch(ks.settings.tools.find((t) => t.name === "add_todo")!.description, /block of the person's time/);
      const r = await ks.tool("add_todo", { title: "Send the sample summary" });
      assert.equal(n.blockOf(n.todoId(r)), undefined);
      const ps = await n.turn(n.po.id);
      assert.match(text(await ps.tool("get_settings")), /To-dos in the calendar: on, but the calendar is not set up/);
    } finally {
      await n.close();
    }
  });

  test("a block of the given minutes in the first free slot, in Outlook as busy with no Teams and no reminder", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const add = ks.settings.tools.find((t) => t.name === "add_todo")!;
      assert.match(add.description, /Every to-do gets a block of the person's time/);
      assert.ok(add.description.includes(AHEAD_SCHEDULING_DEFAULT), "the instruction is in add_todo's text");
      assert.match(text(await ks.tool("add_todo", { title: "Too long", minutes: 300 })), /minutes is how long it takes the person, 5 to 240/);
      const r = await ks.tool("add_todo", { title: "Send the sample summary", why: "The import is done.", minutes: 5 });
      // 09:30 to 10:30 is busy, so 10:35 with air.
      assert.match(text(r), /Its block is Thu 19 Nov 10:35 to 10:40 \(5 min\), on Ahead and in the person's calendar\./);
      assert.doesNotMatch(text(r), /You gave no minutes/);
      const b = w.blockOf(w.todoId(r))!;
      assert.deepEqual([b.kind, b.day, b.time, b.minutes, b.forTodo, b.link?.todoId, b.state, b.outlook?.state], ["your-time", TODAY, "10:35", 5, w.todoId(r), w.todoId(r), "open", "made"]);
      const [ev, ...more] = w.outlook();
      assert.equal(more.length, 0);
      assert.equal(ev!.subject, "To-do: Send the sample summary");
      assert.equal(startOfEvent(ev!), at(TODAY, "10:35"));
      assert.deepEqual([ev!.showAs, ev!.isReminderOn, ev!.isOnlineMeeting, ev!.onlineMeeting, ev!.attendees], ["busy", false, false, undefined, []]);
      assert.match(ev!.body!.content, /The import is done\..*Pobots made this block of time for a to-do from Kaja/);
      const sent = w.calls("create")[0] as { event: Record<string, unknown> };
      assert.equal(sent.event.onlineMeetingProvider, undefined, "no Teams field is sent");
      assert.equal(b.outlook?.eventId, ev!.id);
      // No minutes: 15, and the bot is asked to say next time. It goes around the first, with air.
      const r2 = await ks.tool("add_todo", { title: "Approve the sample plan" });
      assert.match(text(r2), /Its block is Thu 19 Nov 10:45 to 11:00 \(15 min\).*You gave no minutes, so it got 15\. Next time give minutes/);
    } finally {
      await w.close();
    }
  });

  test("before by_when, late when there is no room before, outside the day's limit, no room at all", async () => {
    const w = await world();
    try {
      const ps = await w.turn(w.po.id);
      await ps.tool("change_settings", { ahead_time: { minutes_per_day: 15 } });
      await w.end(ps);
      const ks = await w.turn(w.kaja.id);
      // 45 minutes is more than the limit of 15: the limit does not apply to to-do blocks.
      const r = await ks.tool("add_todo", { title: "Review the sample deck", minutes: 45, by_when: `${TODAY}T12:00` });
      assert.match(text(r), /Its block is Thu 19 Nov 10:35 to 11:20 \(45 min\)/);
      // Due today by 11:00: the free time before is gone (10:35 to 11:20 taken), so late, and the main bot is told.
      const late = await ks.tool("add_todo", { title: "Call back the sample customer", minutes: 30, by_when: `${TODAY}T11:00` });
      assert.match(text(late), /Its block is Thu 19 Nov 11:25 to 11:55 \(30 min\).*That is after its by-when: there was no free time before\. The main bot is told\./);
      assert.match(w.store.takeNews(w.po.mainThreadId).join("\n"), /"Call back the sample customer" from Kaja is due 2026-11-19 11:00.*which is late/);
      // A day only: on or before it.
      const day = await ks.tool("add_todo", { title: "Check the sample numbers", minutes: 20, by_when: "2026-11-20" });
      assert.match(text(day), /Thu 19 Nov 12:00 to 12:20/);
      assert.doesNotMatch(text(day), /after its by-when/);
      // Longer than the working day: the to-do is made without a block, and the bot is told why.
      await ps.tool("change_settings", { ahead_time: { work_start: "08:00", work_end: "09:00" } });
      const none = await ks.tool("add_todo", { title: "Write the sample report", minutes: 90 });
      assert.match(text(none), /Added "Write the sample report".*It has no block of time: 90 minutes does not fit in the working day \(08:00 to 09:00\)\. Give fewer minutes with update_todo\./);
      assert.equal(w.blockOf(w.todoId(none)), undefined);
    } finally {
      await w.close();
    }
  });
});

describe("to-do blocks: one thing on Ahead, kept in step with Outlook", () => {
  test("the view shows the block, not the dated to-do and not its event as a grey meeting", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15, by_when: "2026-11-20" }));
      const v = await w.view();
      const rows = v.rows.filter((r) => (r.source === "item" ? r.item.forTodo === id : r.source === "todo" ? r.todoId === id : r.source === "meeting" && /To-do:/.test(r.title)));
      assert.deepEqual(rows.map((r) => r.source), ["item"]);
      assert.ok(v.rows.some((r) => r.source === "meeting" && r.title === "Planning"), "other meetings stay");
    } finally {
      await w.close();
    }
  });

  test("a drag, a bot's change and the main bot's move move the event; no time is refused", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 }));
      const b = w.blockOf(id)!;
      aheadAct(w.engine, { itemId: b.id, action: "move", day: "2026-11-20", time: "13:00" });
      await todoBlocksSynced(w.engine);
      assert.equal(startOfEvent(w.outlook()[0]!), at("2026-11-20", "13:00"));
      assert.equal(w.blockOf(id)!.outlook?.start, new Date(at("2026-11-20", "13:00")).toISOString());
      assert.throws(() => aheadAct(w.engine, { itemId: b.id, action: "move", day: "2026-11-20", time: null }), /keeps a time/);
      // update_todo with minutes places it again.
      const u = await ks.tool("update_todo", { id, minutes: 30 });
      assert.match(text(u), /Its block is now Thu 19 Nov 10:35 to 11:05 \(30 min\), on Ahead and in the person's calendar\./);
      const ev = w.outlook()[0]!;
      assert.equal(startOfEvent(ev), at(TODAY, "10:35"));
      assert.equal(Date.parse(ev.end.dateTime + "Z") - startOfEvent(ev), 30 * MIN);
      // A bot cannot move or finish its block with ahead_item; the main bot can move it.
      await w.end(ks);
      await w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "time" } });
      const ks2 = await w.turn(w.kaja.id);
      assert.match(text(await ks2.tool("ahead_item", { action: "move", id: b.id, day: "2026-11-24" })), /update_todo with minutes or by_when/);
      assert.match(text(await ks2.tool("ahead_item", { action: "done", id: b.id })), /done when its to-do is/);
      const ps = await w.turn(w.po.id);
      assert.match(ps.settings.tools.find((t) => t.name === "ahead_item")!.description, /rewrite that text with change_settings ahead_scheduling/);
      assert.match(text(await ps.tool("ahead_item", { action: "move", id: b.id, day: "2026-11-23", time: "14:00" })), /Moved to Monday 23 Nov 14:00/);
      await todoBlocksSynced(w.engine);
      assert.equal(startOfEvent(w.outlook()[0]!), at("2026-11-23", "14:00"));
      assert.equal(w.outlook().length, 1, "never a second event");
    } finally {
      await w.close();
    }
  });

  test("each kind of close: answered and done end the block, dismissed and removed drop it; the event goes; a begun one stays", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const a = w.todoId(await ks.tool("add_todo", { title: "Answer me", minutes: 15, buttons: [{ label: "Yes" }] }));
      const d = w.todoId(await ks.tool("add_todo", { title: "Mark me done", minutes: 15 }));
      const x = w.todoId(await ks.tool("add_todo", { title: "Dismiss me", minutes: 15 }));
      const r = w.todoId(await ks.tool("add_todo", { title: "Remove me", minutes: 15 }));
      const p = w.todoId(await ks.tool("add_todo", { title: "Past one", minutes: 15 }));
      await w.end(ks);
      assert.equal(w.outlook().length, 5);
      w.engine.answerTodo({ todoId: a, buttonId: w.store.getTodo(a)!.todo.buttons[0]!.id });
      w.engine.closeTodo({ todoId: d, how: "done" });
      w.engine.closeTodo({ todoId: x, how: "dismissed" });
      const ks2 = await w.turn(w.kaja.id);
      await ks2.tool("remove_todo", { id: r });
      await todoBlocksSynced(w.engine);
      assert.deepEqual([a, d, x, r].map((t) => w.blockOf(t)!.state), ["done", "done", "dropped", "dropped"]);
      assert.deepEqual([a, d, x, r].map((t) => w.blockOf(t)!.outlook?.state), ["deleted", "deleted", "deleted", "deleted"]);
      assert.deepEqual(w.outlook().map((e) => e.subject), ["To-do: Past one"]);
      // Its time comes: closed after its start, it stays in Outlook as a record.
      const pb = w.blockOf(p)!;
      w.setNow(at(pb.day, pb.time!) + 5 * MIN);
      w.engine.closeTodo({ todoId: p, how: "done" });
      await todoBlocksSynced(w.engine);
      assert.equal(w.blockOf(p)!.outlook?.state, "kept");
      assert.equal(w.outlook().length, 1);
    } finally {
      await w.close();
    }
  });

  test("Done on the block in the window marks the to-do done; Remove the block keeps the to-do; it comes back only with an open to-do", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const t1 = w.todoId(await ks.tool("add_todo", { title: "First", minutes: 15 }));
      const t2 = w.todoId(await ks.tool("add_todo", { title: "Second", minutes: 15 }));
      aheadAct(w.engine, { itemId: w.blockOf(t1)!.id, action: "done" });
      assert.equal(w.store.getTodo(t1)!.status, "done");
      assert.equal(w.blockOf(t1)!.state, "done");
      aheadAct(w.engine, { itemId: w.blockOf(t2)!.id, action: "drop" });
      assert.equal(w.store.getTodo(t2)!.status, "open");
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /the person removed the block of your to-do "Second".*The to-do stays on their list/);
      await todoBlocksSynced(w.engine);
      assert.equal(w.outlook().length, 0);
      // The dated to-do shows again once its block is gone? It has no date, so it is on the list only.
      aheadAct(w.engine, { itemId: w.blockOf(t2)!.id, action: "reopen" });
      await todoBlocksSynced(w.engine);
      assert.equal(w.outlook().length, 1, "made again in the calendar");
      assert.throws(() => aheadAct(w.engine, { itemId: w.blockOf(t1)!.id, action: "reopen" }), /no longer open/);
    } finally {
      await w.close();
    }
  });

  test("followed from Outlook: moved there, the block follows; deleted there, it is removed and never made again", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 }));
      await w.end(ks);
      w.store.takeNews(w.kaja.mainThreadId);
      const ev = w.outlook()[0]!;
      // The person moves it to 14:00 to 14:30 in Outlook.
      Object.assign(w.flow.events.get(ev.id)!, { start: g(new Date(at(TODAY, "14:00")).toISOString()), end: g(new Date(at(TODAY, "14:30")).toISOString()) });
      // A read that started before Pobots' own last write is not followed.
      w.setNow(NOW - MIN);
      await w.view();
      assert.equal(w.blockOf(id)!.time, "10:35", "an older read is not followed");
      w.setNow(NOW + MIN);
      await w.view();
      const b = w.blockOf(id)!;
      assert.deepEqual([b.day, b.time, b.minutes, b.changedBy], [TODAY, "14:00", 30, "you"]);
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /the person moved the block of your to-do "Send the sample summary".*in their calendar, to Thursday 19 Nov 14:00 \(30 min\)/);
      await todoBlocksSynced(w.engine);
      assert.equal(w.calls("move").length, 0, "not written back");
      // The person deletes it in Outlook: missing from the read, looked up, gone.
      w.setNow(NOW + 2 * MIN);
      w.flow.events.delete(ev.id);
      await w.view();
      const gone = w.blockOf(id)!;
      assert.deepEqual([gone.state, gone.outlook?.state], ["dropped", "gone"]);
      assert.equal(w.store.getTodo(id)!.status, "open", "the to-do stays");
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /deleted the block of your to-do "Send the sample summary" \(todo_\w+\) from their calendar/);
      const ks2 = await w.turn(w.kaja.id);
      assert.match(text(await ks2.tool("update_todo", { id, minutes: 20 })), /Its block was removed earlier, so it has none/);
      await todoBlocksSynced(w.engine);
      assert.equal(w.calls("create").length, 1, "never made again");
      assert.throws(() => aheadAct(w.engine, { itemId: gone.id, action: "reopen" }), /deleted this block in your calendar/);
    } finally {
      await w.close();
    }
  });

  test("a meeting that comes on a block moves it, as any your-time Pobots placed", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 }));
      w.flow.events.set("m-new", { id: "m-new", subject: "Sample call", start: g(new Date(at(TODAY, "10:30")).toISOString()), end: g(new Date(at(TODAY, "11:30")).toISOString()), isOrganizer: true, showAs: "busy", attendees: [] });
      await w.view();
      await todoBlocksSynced(w.engine);
      const b = w.blockOf(id)!;
      assert.equal(b.time, "11:35");
      assert.equal(startOfEvent(w.outlook().find((e) => e.subject.startsWith("To-do:"))!), at(TODAY, "11:35"));
    } finally {
      await w.close();
    }
  });
});

describe("to-do blocks: a failed write is never doubled", () => {
  test("nothing happened: failed, tried again only at the next change", async () => {
    const w = await world();
    try {
      w.flow.control.failOn = { create: 400 };
      const ks = await w.turn(w.kaja.id);
      const r = await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 });
      assert.match(text(r), /on Ahead, but not in the person's calendar: the flow has no case for it yet\. Pobots tries again when the block changes/);
      const id = w.todoId(r);
      assert.equal(w.blockOf(id)!.outlook?.state, "failed");
      w.flow.control.failOn = {};
      await syncTodoBlocks(w.engine);
      assert.equal(w.calls("create").length, 1, "no try without a change");
      w.setNow(NOW + MIN);
      aheadAct(w.engine, { itemId: w.blockOf(id)!.id, action: "move", day: TODAY, time: "13:00" });
      await todoBlocksSynced(w.engine);
      assert.equal(w.calls("create").length, 2);
      assert.equal(w.blockOf(id)!.outlook?.state, "made");
      assert.equal(w.outlook().length, 1);
    } finally {
      await w.close();
    }
  });

  test("may have happened: unsure; at the next change Pobots looks first and keeps what it finds", async () => {
    const w = await world();
    try {
      w.flow.control.failOn = { create: 502 };
      const ks = await w.turn(w.kaja.id);
      const r = await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 });
      assert.match(text(r), /The calendar did not answer in time.*looks there before it tries again/);
      const id = w.todoId(r);
      const b = w.blockOf(id)!;
      assert.equal(b.outlook?.state, "unsure");
      // It did happen after all: the event is in the calendar.
      w.flow.events.set("AAMk-late", { id: "AAMk-late", subject: "To-do: Send the sample summary", start: g(b.outlook!.start!), end: g(b.outlook!.end!), isOrganizer: true, showAs: "busy", attendees: [] });
      w.flow.control.failOn = {};
      w.setNow(NOW + MIN);
      aheadAct(w.engine, { itemId: b.id, action: "move", day: TODAY, time: "13:00" });
      await todoBlocksSynced(w.engine);
      assert.equal(w.calls("create").length, 1, "not made a second time");
      const after = w.blockOf(id)!;
      assert.deepEqual([after.outlook?.state, after.outlook?.eventId], ["made", "AAMk-late"]);
      assert.equal(w.outlook().length, 1);
      assert.equal(startOfEvent(w.outlook()[0]!), at(TODAY, "13:00"), "then moved to the new time");
    } finally {
      await w.close();
    }
  });
});

describe("to-do blocks: the switch and the instruction", () => {
  test("the main bot turns it on and off and rewrites the instruction, with quiet lines; off makes no new blocks, made ones keep in step", async () => {
    const w = await world({ on: false });
    try {
      const ps = await w.turn(w.po.id);
      const cs = ps.settings.tools.find((t) => t.name === "change_settings")!;
      assert.ok("ahead_todo_blocks" in cs.shape && "ahead_scheduling" in cs.shape);
      assert.match(text(await ps.tool("get_settings")), /To-dos in the calendar: off \(change_settings ahead_todo_blocks\)\. How to schedule the person \(change_settings ahead_scheduling, now the default\)/);
      assert.match(text(await ps.tool("change_settings", { ahead_todo_blocks: true })), /Ahead, to-dos in the calendar from off to on/);
      const mine = "Five minutes for small things, an hour for reviews. Mornings are for customers.";
      assert.match(text(await ps.tool("change_settings", { ahead_scheduling: mine })), /Ahead, how to schedule the person: changed \(about 13 words\)/);
      await w.end(ps);
      const lines = changeLines(w.events, w.po.mainThreadId);
      assert.ok(lines.some((l) => /to-dos in the calendar from off to on/.test(l)) && lines.some((l) => /how to schedule the person: changed/.test(l)), "quiet lines in the main bot's chat");
      const ks = await w.turn(w.kaja.id);
      assert.ok(ks.settings.tools.find((t) => t.name === "add_todo")!.description.includes(mine), "the bot's new session has the person's words");
      const id = w.todoId(await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15 }));
      assert.ok(w.blockOf(id));
      await w.end(ks);
      const ps2 = await w.turn(w.po.id);
      assert.match(text(await ps2.tool("change_settings", { ahead_scheduling: "" })), /back to the default/);
      assert.match(text(await ps2.tool("change_settings", { ahead_todo_blocks: false })), /from on to off/);
      await w.end(ps2);
      const ks2 = await w.turn(w.kaja.id);
      assert.equal(ks2.settings.tools.find((t) => t.name === "add_todo")!.shape.minutes, undefined, "no minutes while off");
      const id2 = w.todoId(await ks2.tool("add_todo", { title: "Approve the sample plan" }));
      assert.equal(w.blockOf(id2), undefined, "off makes nothing");
      // The block made before keeps in step.
      aheadAct(w.engine, { itemId: w.blockOf(id)!.id, action: "move", day: "2026-11-20", time: "09:00" });
      await todoBlocksSynced(w.engine);
      assert.equal(startOfEvent(w.outlook()[0]!), at("2026-11-20", "09:00"));
      // An old to-do made while off gets a block on its first change while on.
      setAheadSettings(w.engine, { todoBlocks: true });
      const u = await ks2.tool("update_todo", { id: id2, minutes: 10 });
      assert.match(text(u), /Its block is/);
    } finally {
      await w.close();
    }
  });

  test("the settings: the text is checked, saved without the default, and Ahead off refuses the main bot", async () => {
    const w = await world({ on: false });
    try {
      assert.throws(() => setAheadSettings(w.engine, { scheduling: "x".repeat(601) }), /under 600 characters/);
      assert.equal(setAheadSettings(w.engine, { scheduling: AHEAD_SCHEDULING_DEFAULT }).scheduling, undefined);
      assert.equal(setAheadSettings(w.engine, { scheduling: "  Mornings free.  " }).scheduling, "Mornings free.");
      setAheadSettings(w.engine, { enabled: false });
      const ps = await w.turn(w.po.id);
      assert.match(text(await ps.tool("change_settings", { ahead_todo_blocks: true })), /Ahead is off/);
    } finally {
      await w.close();
    }
  });
});
