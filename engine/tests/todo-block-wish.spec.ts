// When a to-do's block lands (engine 0.43.0, docs/build/step-block-time.md). The placer alone (an
// exact time free and taken, not before a time of day and a day, ending by a time of day, past
// latest-by, the main bot's exact time outside working hours), then add_todo and update_todo against
// the calendar stand-in: kept, the nearest after with the reason, wrong shapes refused before the
// to-do is made, a new wish moves the block and its event, a meeting keeps the wish, the person's
// drag wins (new minutes then drop the old wish), and the fields only while blocks are on. No
// model, nothing sent outside.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolResult } from "../claude/session.js";
import { AHEAD_DEFAULTS } from "../../shared/protocol.js";
import { aheadAct } from "../core/ahead-person.js";
import { aheadView } from "../core/ahead-view.js";
import { setAheadSettings } from "../core/ahead-settings.js";
import { setCalendar } from "../core/calendar-settings.js";
import { forgetMeetings } from "../core/ahead-meetings.js";
import { dayWindow, findSlot, stretchOf, type Busy, type SlotAsk } from "../core/ahead-slots.js";
import { todoBlocksSynced } from "../core/todo-block-sync.js";
import { makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { type FakeSession, settle, setup } from "./fake.js";

const TZ = "Europe/Stockholm";
/** Thursday 19 Nov 2026, 09:00 in Stockholm. */
const NOW = Date.parse("2026-11-19T08:00:00Z");
const TODAY = "2026-11-19";
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;
const g = (iso: string) => ({ dateTime: new Date(iso).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" });
const at = (day: string, time: string) => stretchOf(day, time, 0, TZ).start;
const span = (day: string, from: string, to: string): Busy => ({ start: at(day, from), end: at(day, to) });
const meeting = (id: string, day: string, from: string, to: string) => ({ id, subject: "Sample call", start: g(new Date(at(day, from)).toISOString()), end: g(new Date(at(day, to)).toISOString()), isOrganizer: true, showAs: "busy", attendees: [] });

const rules = { workStart: AHEAD_DEFAULTS.workStart, workEnd: AHEAD_DEFAULTS.workEnd, workDays: AHEAD_DEFAULTS.workDays, minutesPerDay: AHEAD_DEFAULTS.minutesPerDay };
/** Today 09:30 to 10:30 is busy, as in the stand-in. */
const ask = (o: Partial<SlotAsk> = {}): SlotAsk => ({ minutes: 30, now: NOW, tz: TZ, rules, busy: [span(TODAY, "09:30", "10:30")], counts: false, ...o });
const where = (r: ReturnType<typeof findSlot>) => (r.ok ? `${r.day} ${r.time}${r.late ? " late" : ""}` : r.why);

describe("block time: the placer", () => {
  test("an exact time free is kept; taken, the nearest free time after it", () => {
    assert.equal(where(findSlot(ask({ earliest: "2026-11-20", notBefore: at("2026-11-20", "14:00") }))), "2026-11-20 14:00");
    const busy = [span("2026-11-20", "14:00", "15:00")];
    assert.equal(where(findSlot(ask({ busy, earliest: "2026-11-20", notBefore: at("2026-11-20", "14:00") }))), "2026-11-20 15:05");
  });

  test("not before a time of day, not before a day, ending by a time of day", () => {
    assert.equal(where(findSlot(ask({ dayStart: "13:00" }))), `${TODAY} 13:00`);
    assert.equal(where(findSlot(ask({ earliest: "2026-11-24" }))), "2026-11-24 08:00");
    // Ending by 10:00: today only 09:30 is left after the lead, and the meeting has it; so tomorrow.
    assert.equal(where(findSlot(ask({ dayEnd: "10:00" }))), "2026-11-20 08:00");
    assert.equal(where(findSlot(ask({ dayStart: "13:00", dayEnd: "13:20" }))), "hours", "a window shorter than the block");
    assert.deepEqual(dayWindow(rules, "07:00", "18:00"), { start: "08:00", end: "17:00", minutes: 540 }, "clipped to working hours");
  });

  test("a wish that fits only after latest-by is late, not refused", () => {
    const busy = [span(TODAY, "13:00", "17:00")];
    assert.equal(where(findSlot(ask({ busy, dayStart: "13:00", latestBy: TODAY }))), "2026-11-20 13:00 late");
  });

  test("an exact time outside working hours: kept only as the main bot's fixed time, and only when free", () => {
    const six = at(TODAY, "18:00");
    assert.equal(where(findSlot(ask({ fixed: six, notBefore: six }))), `${TODAY} 18:00`);
    assert.equal(where(findSlot(ask({ notBefore: six }))), "2026-11-20 08:00");
    assert.equal(where(findSlot(ask({ fixed: at("2026-11-21", "10:00") }))), "2026-11-21 10:00", "a day off too");
    assert.equal(where(findSlot(ask({ fixed: at(TODAY, "09:45"), notBefore: at(TODAY, "09:45") }))), `${TODAY} 10:35`, "taken: the nearest after");
  });
});

async function world(o: { on?: boolean } = {}) {
  let now = NOW;
  const flow = makeCalendarStandin({ seed: [meeting("m-busy", TODAY, "09:30", "10:30")] });
  const url = await flow.listen();
  const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 }, { timeZone: TZ, clock: () => now });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Keeps sample projects on track" });
  await setCalendar(w.engine, { address: url });
  setAheadSettings(w.engine, { enabled: true, ...(o.on === false ? {} : { todoBlocks: true }) });
  const close = async () => {
    await todoBlocksSynced(w.engine);
    w.engine.shutdown();
    await flow.close();
    w.store.close();
  };
  const turn = async (botId: string) => {
    w.engine.sendMessage({ botId, text: "Go" });
    await settle();
    return sessionOf(w.sessions, botId);
  };
  const todoId = (r: ToolResult) => /todo_\w+/.exec(text(r))![0];
  const blockOf = (id: string) => w.store.ahead.blockOf(id);
  const eventOf = (title: string) => [...flow.events.values()].find((e) => e.subject === `To-do: ${title}`) as { start: { dateTime: string } } | undefined;
  const eventStart = (title: string) => Date.parse(eventOf(title)!.start.dateTime + "Z");
  const view = async () => {
    forgetMeetings(w.engine);
    return aheadView(w.engine, {});
  };
  return { ...w, po, kaja, close, turn, flow, todoId, blockOf, eventStart, view, setNow: (t: number) => (now = t) };
}

describe("block time: add_todo", () => {
  test("not before 13:00 lands at 13:00, in Ahead and in the calendar, and the wish is kept on the block", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const add = ks.settings.tools.find((t) => t.name === "add_todo")!;
      assert.ok(["block_at", "block_not_before", "block_not_after"].every((k) => k in add.shape));
      assert.match(add.description, /"after 13:00" is block_not_before 13:00/);
      const r = await ks.tool("add_todo", { title: "Send the sample summary", minutes: 15, block_not_before: "13:00" });
      assert.match(text(r), /Its block is Thu 19 Nov 13:00 to 13:15 \(15 min\), on Ahead and in the person's calendar\.$/);
      const b = w.blockOf(w.todoId(r))!;
      assert.deepEqual([b.day, b.time, b.wish], [TODAY, "13:00", { notBefore: "13:00" }]);
      assert.equal(w.eventStart("Send the sample summary"), at(TODAY, "13:00"));
    } finally {
      await w.close();
    }
  });

  test("an exact time: free, kept; taken, too soon, outside working hours or on a day off, the nearest after with the reason", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const free = await ks.tool("add_todo", { title: "Free", minutes: 15, block_at: "2026-11-20T14:00" });
      assert.match(text(free), /Its block is Fri 20 Nov 14:00 to 14:15 \(15 min\), on Ahead and in the person's calendar\.$/);
      assert.deepEqual(w.blockOf(w.todoId(free))!.wish, { at: "2026-11-20T14:00" });
      assert.equal(w.eventStart("Free"), at("2026-11-20", "14:00"));
      const taken = await ks.tool("add_todo", { title: "Taken", minutes: 15, block_at: "2026-11-19T10:00" });
      assert.match(text(taken), /Its block is Thu 19 Nov 10:35 to 10:50 \(15 min\), on Ahead and in the person's calendar\. 10:00 was taken, so it is the nearest free time after\./);
      const soon = await ks.tool("add_todo", { title: "Soon", minutes: 5, block_at: "2026-11-19T09:10" });
      assert.match(text(soon), /Thu 19 Nov 10:55 to 11:00.*09:10 is less than 30 minutes from now, so it is the nearest free time after\./);
      const late = await ks.tool("add_todo", { title: "Evening", minutes: 15, block_at: "2026-11-19T18:00" });
      assert.match(text(late), /Its block is Fri 20 Nov 08:00 to 08:15.*Thu 19 Nov 18:00 is outside the person's working hours \(08:00 to 17:00\), so it is the nearest free time after\./);
      const sat = await ks.tool("add_todo", { title: "Saturday", minutes: 15, block_at: "2026-11-21T10:00" });
      assert.match(text(sat), /Its block is Mon 23 Nov 08:00 to 08:15.*Sat 21 Nov is not one of the person's working days, so it is the nearest free time after\./);
      // The main bot sets times outside working hours, as with ahead_item.
      const ps = await w.turn(w.po.id);
      const own = await ps.tool("add_todo", { title: "Main evening", minutes: 15, block_at: "2026-11-19T18:00" });
      assert.match(text(own), /Its block is Thu 19 Nov 18:00 to 18:15 \(15 min\), on Ahead and in the person's calendar\.$/);
    } finally {
      await w.close();
    }
  });

  test("past by-when: placed late and told, not refused", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const r = await ks.tool("add_todo", { title: "Late one", minutes: 15, by_when: TODAY, block_not_before: "2026-11-20" });
      assert.match(text(r), /Its block is Fri 20 Nov 08:00 to 08:15.*That is after its by-when: there was no free time before it that keeps to when you asked\. The main bot is told\./);
    } finally {
      await w.close();
    }
  });

  test("wrong shapes are refused in plain words before the to-do is made", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const no = async (args: Record<string, unknown>, words: RegExp) => {
        const r = await ks.tool("add_todo", { title: "Shape", minutes: 15, ...args });
        assert.match(text(r), words);
        assert.match(text(r), /The to-do was not added\./);
      };
      await no({ block_at: "tomorrow at 10" }, /block_at is a day and a time, YYYY-MM-DDTHH:MM/);
      await no({ block_at: "2026-11-19T08:00" }, /block_at has passed: it is now Thu 19 Nov 09:00\./);
      await no({ block_at: "2026-11-20T10:00", block_not_before: "13:00" }, /Give block_at alone/);
      await no({ block_not_before: "after lunch" }, /block_not_before is a day \(2026-11-24\), a time of day \(13:00\) or both/);
      await no({ block_not_before: "2026-11-01" }, /block_not_before has passed\. Today is 2026-11-19\./);
      await no({ block_not_after: "4pm" }, /block_not_after is a time of day the block ends by, HH:MM/);
      await no({ block_not_before: "18:00" }, /block_not_before 18:00 is after the person's working day \(08:00 to 17:00\)/);
      await no({ block_not_after: "07:30" }, /block_not_after 07:30 is before the person's working day/);
      await no({ block_not_before: "13:00", block_not_after: "13:10" }, /From 13:00 to 13:10 in the person's working day \(08:00 to 17:00\) there are 10 minutes, and the block is 15\./);
      assert.equal(w.store.openTodos(w.kaja.id).length, 0, "no to-do was made");
    } finally {
      await w.close();
    }
  });

  test("the fields only while blocks are on", async () => {
    const w = await world({ on: false });
    try {
      const ks = await w.turn(w.kaja.id);
      const add = ks.settings.tools.find((t) => t.name === "add_todo")!;
      const update = ks.settings.tools.find((t) => t.name === "update_todo")!;
      assert.ok(!("block_at" in add.shape) && !("block_not_before" in update.shape));
      assert.doesNotMatch(add.description + update.description, /block_at/);
      // A bot that sends one anyway: ignored while blocks are off.
      const r = await ks.tool("add_todo", { title: "No block", block_at: "nonsense" });
      assert.match(text(r), /Added "No block"/);
      assert.equal(w.blockOf(w.todoId(r)), undefined);
    } finally {
      await w.close();
    }
  });
});

describe("block time: placed again", () => {
  test("update_todo with a new wish moves the block and its event; an empty one clears it", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Move me", minutes: 15 }));
      assert.equal(w.blockOf(id)!.time, "10:35");
      const r = await ks.tool("update_todo", { id, block_not_before: "2026-11-20T09:00" });
      assert.match(text(r), /Its block is now Fri 20 Nov 09:00 to 09:15 \(15 min\), on Ahead and in the person's calendar\./);
      assert.deepEqual(w.blockOf(id)!.wish, { notBefore: "2026-11-20T09:00" });
      assert.equal(w.eventStart("Move me"), at("2026-11-20", "09:00"));
      // block_at replaces the other wish.
      await ks.tool("update_todo", { id, block_at: "2026-11-20T11:00" });
      assert.deepEqual([w.blockOf(id)!.time, w.blockOf(id)!.wish], ["11:00", { at: "2026-11-20T11:00" }]);
      // The same wish again: told where it stays.
      assert.match(text(await ks.tool("update_todo", { id, block_at: "2026-11-20T11:00" })), /Its block stays Fri 20 Nov 11:00 to 11:15/);
      const cleared = await ks.tool("update_todo", { id, block_at: "" });
      assert.match(text(cleared), /Its block is now Thu 19 Nov 10:35 to 10:50/);
      assert.equal(w.blockOf(id)!.wish, undefined);
      assert.equal(w.eventStart("Move me"), at(TODAY, "10:35"));
      // New minutes that the wish cannot hold are refused, and nothing changes.
      await ks.tool("update_todo", { id, block_not_before: "13:00", block_not_after: "13:30" });
      const no = await ks.tool("update_todo", { id, minutes: 60 });
      assert.match(text(no), /From 13:00 to 13:30 .* there are 30 minutes, and the block is 60\..*The to-do was not changed\./);
      assert.equal(w.store.getTodo(id)!.todo.minutes, 15);
    } finally {
      await w.close();
    }
  });

  test("a meeting that comes on the block moves it within the wish", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "After lunch", minutes: 15, block_not_before: "13:00" }));
      w.flow.events.set("m-new", meeting("m-new", TODAY, "13:00", "14:00"));
      await w.view();
      await todoBlocksSynced(w.engine);
      const b = w.blockOf(id)!;
      // Not 11:00 or so before the meeting: 14:05, after it with air.
      assert.deepEqual([b.time, b.wish], ["14:05", { notBefore: "13:00" }]);
      assert.equal(w.eventStart("After lunch"), at(TODAY, "14:05"));
      // New minutes place it again, still keeping to 13:00 or later.
      await ks.tool("update_todo", { id, minutes: 30 });
      assert.equal(w.blockOf(id)!.time, "14:05");
    } finally {
      await w.close();
    }
  });

  test("the person's drag wins: a meeting does not move it back, only a new wish from the bot does", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Mine now", minutes: 15, block_not_before: "13:00" }));
      aheadAct(w.engine, { itemId: w.blockOf(id)!.id, action: "move", day: "2026-11-20", time: "09:00" });
      await todoBlocksSynced(w.engine);
      assert.deepEqual([w.blockOf(id)!.day, w.blockOf(id)!.time, w.blockOf(id)!.changedBy], ["2026-11-20", "09:00", "you"]);
      w.flow.events.set("m-fri", meeting("m-fri", "2026-11-20", "09:00", "10:00"));
      await w.view();
      assert.equal(w.blockOf(id)!.time, "09:00", "the person put it there");
      // New minutes place it again without the old wish (not kept to 13:00), and the wish is gone.
      await ks.tool("update_todo", { id, minutes: 30 });
      assert.deepEqual([w.blockOf(id)!.day, w.blockOf(id)!.time, w.blockOf(id)!.wish], [TODAY, "10:35", undefined]);
      const r = await ks.tool("update_todo", { id, block_not_before: "14:00" });
      assert.match(text(r), /Its block is now Thu 19 Nov 14:00 to 14:30/);
      assert.equal(w.eventStart("Mine now"), at(TODAY, "14:00"));
    } finally {
      await w.close();
    }
  });

  test("after the person's move a new wish does not mix with the old one", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.todoId(await ks.tool("add_todo", { title: "Fresh wish", minutes: 15, block_not_before: "15:30" }));
      aheadAct(w.engine, { itemId: w.blockOf(id)!.id, action: "move", day: "2026-11-20", time: "09:00" });
      await todoBlocksSynced(w.engine);
      // Only an end time now: the old "not before 15:30" went with the person's move.
      await ks.tool("update_todo", { id, block_not_after: "12:00" });
      assert.deepEqual(w.blockOf(id)!.wish, { notAfter: "12:00" });
      assert.ok(w.blockOf(id)!.time! <= "11:45", `placed by the new wish alone, got ${w.blockOf(id)!.time}`);
    } finally {
      await w.close();
    }
  });
});
