// Ahead, part B (engine 0.39.0, docs/build/step-ahead.md): the person's time. The placement is pure
// and tested on its own (working hours and days, the lead of 30 minutes, meetings, other "your time",
// the air, the day's limit, earliest, latest by and late, daylight saving days, nothing that fits);
// then the tool (permission, the main bot as time manager, focus blocks, the week note), the
// person's place choices, a meeting that comes on a placed item, the two notification kinds, and
// the tool's size. Stand-in harness and the calendar stand-in; no model, nothing sent outside.
import { aheadAct } from "../core/ahead-person.js";
import { aheadView } from "../core/ahead-view.js";
import { placeByPerson } from "../core/ahead-time.js";
import { setAheadSettings } from "../core/ahead-settings.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolResult } from "../claude/session.js";
import { z } from "zod";
import { parseParams } from "../schemas.js";
import { aheadToolFor } from "../core/ahead-tool.js";
import { setCalendar } from "../core/calendar-settings.js";
import { forgetMeetings } from "../core/ahead-meetings.js";
import { findSlot, stretchOf, type Busy, type SlotAsk } from "../core/ahead-slots.js";
import { aheadTimeTick } from "../core/ahead-time-tick.js";
import { pushMessage } from "../notify.js";
import { makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { changeLines, type FakeSession, settle, setup } from "./fake.js";

const TZ = "Europe/Stockholm";
/** Thursday 19 Nov 2026, 09:00 in Stockholm. */
const NOW = Date.parse("2026-11-19T08:00:00Z");
const TODAY = "2026-11-19";
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;
const g = (iso: string) => ({ dateTime: new Date(iso).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" });

/** An instant from a wall time in Stockholm. */
const at = (day: string, time: string) => stretchOf(day, time, 0, TZ).start;
const busy = (day: string, from: string, to: string): Busy => ({ start: at(day, from), end: at(day, to) });
const RULES: SlotAsk["rules"] = { workStart: "08:00", workEnd: "17:00", workDays: ["mon", "tue", "wed", "thu", "fri"], minutesPerDay: 120 };
const ask = (o: Partial<SlotAsk> = {}): SlotAsk => ({ minutes: 30, now: NOW, tz: TZ, rules: RULES, busy: [], ...o });
const where = (o: Partial<SlotAsk> = {}) => {
  const r = findSlot(ask(o));
  return r.ok ? `${r.day} ${r.time}${r.late ? " late" : ""}` : `none: ${r.why}`;
};

describe("ahead time: placement (pure)", () => {
  test("inside working hours, at least 30 minutes from now, on the 5-minute grid", () => {
    assert.equal(where(), "2026-11-19 09:30");
    assert.equal(where({ now: at(TODAY, "06:00") }), "2026-11-19 08:00", "before the working day: its start");
    assert.equal(where({ now: at(TODAY, "09:02") }), "2026-11-19 09:35", "09:32 goes up to 09:35");
    assert.equal(where({ now: at(TODAY, "16:20") }), "2026-11-20 08:00", "16:50 to 17:20 runs past the end: the next working day");
    assert.equal(where({ now: at(TODAY, "16:00") }), "2026-11-19 16:30", "16:30 to 17:00 just fits");
  });

  test("working days: the weekend is skipped; other working days are kept", () => {
    assert.equal(where({ now: at("2026-11-20", "16:50") }), "2026-11-23 08:00", "Friday evening: Monday");
    assert.equal(where({ rules: { ...RULES, workDays: ["sat"] } }), "2026-11-21 08:00");
    assert.equal(where({ rules: { ...RULES, workStart: "10:00", workEnd: "12:00" } }), "2026-11-19 10:00");
  });

  test("busy stretches block with 5 minutes of air on both sides", () => {
    assert.equal(where({ busy: [busy(TODAY, "09:30", "10:30")] }), "2026-11-19 10:35");
    assert.equal(where({ busy: [busy(TODAY, "10:10", "11:00")] }), "2026-11-19 09:30", "ends 10:00, air to 10:05, the meeting at 10:10");
    assert.equal(where({ busy: [busy(TODAY, "10:00", "11:00")] }), "2026-11-19 11:05", "no 5 minutes before 10:00");
    assert.equal(where({ busy: [busy(TODAY, "09:00", "10:02")] }), "2026-11-19 10:10", "10:07 goes up to 10:10");
    // A row of stretches with gaps too small: past all of them.
    assert.equal(where({ busy: [busy(TODAY, "09:00", "10:00"), busy(TODAY, "10:20", "11:00"), busy(TODAY, "11:30", "12:00")] }), "2026-11-19 12:05");
    // Overlapping stretches in any order.
    assert.equal(where({ busy: [busy(TODAY, "10:00", "12:00"), busy(TODAY, "09:00", "10:30")] }), "2026-11-19 12:05");
    // A whole day busy: the next working day.
    assert.equal(where({ busy: [{ start: at(TODAY, "00:00"), end: at("2026-11-20", "00:00") }] }), "2026-11-20 08:00");
  });

  test("the day's limit in minutes; focus blocks (counts false) are outside it", () => {
    assert.equal(where({ used: { [TODAY]: 90 } }), "2026-11-19 09:30", "90 + 30 is the limit exactly");
    assert.equal(where({ used: { [TODAY]: 100 } }), "2026-11-20 08:00");
    assert.equal(where({ used: { [TODAY]: 120, "2026-11-20": 120 } }), "2026-11-23 08:00");
    assert.equal(where({ minutes: 130 }), "none: limit");
    assert.equal(where({ minutes: 200, counts: false, used: { [TODAY]: 120 } }), "2026-11-19 09:30");
  });

  test("earliest, not before, latest by and the late case", () => {
    assert.equal(where({ earliest: "2026-11-24" }), "2026-11-24 08:00");
    assert.equal(where({ earliest: "2026-11-10" }), "2026-11-19 09:30", "a day in the past changes nothing");
    assert.equal(where({ notBefore: at(TODAY, "13:12") }), "2026-11-19 13:15");
    assert.equal(where({ latestBy: TODAY }), "2026-11-19 09:30");
    const fullDay = (d: string) => busy(d, "07:00", "18:00");
    assert.equal(where({ latestBy: "2026-11-20", busy: [fullDay(TODAY), fullDay("2026-11-20")] }), "2026-11-23 08:00 late");
    assert.equal(where({ latestBy: "2026-11-20", busy: [fullDay(TODAY)] }), "2026-11-20 08:00");
  });

  test("daylight saving days: wall times stay wall times", () => {
    // Sunday 25 Oct 2026: clocks go back at 03:00. 08:00 that day is 07:00 UTC.
    const sun = { ...RULES, workDays: ["sun"] as SlotAsk["rules"]["workDays"] };
    const r = findSlot(ask({ now: Date.parse("2026-10-24T20:00:00Z"), rules: sun }));
    assert.ok(r.ok);
    assert.deepEqual([r.day, r.time, new Date(r.start).toISOString()], ["2026-10-25", "08:00", "2026-10-25T07:00:00.000Z"]);
    // Sunday 28 Mar 2027: clocks go forward at 02:00, so 01:00 to 04:00 is only two hours long.
    const night = { ...RULES, workStart: "01:00", workEnd: "04:00", workDays: ["sun"] as SlotAsk["rules"]["workDays"], minutesPerDay: 480 };
    const before = Date.parse("2027-03-27T12:00:00Z");
    assert.equal(where({ now: before, rules: night, minutes: 120 }), "2027-03-28 01:00", "two hours fit");
    assert.equal(where({ now: before, rules: night, minutes: 150 }), "2027-04-04 01:00", "two and a half do not: the next Sunday");
    // 02:30 does not exist that night: the slot starts at 03:00.
    assert.equal(where({ now: before, rules: { ...night, workStart: "02:30" }, minutes: 30 }), "2027-03-28 03:00");
  });

  test("nothing fits: longer than the working day, or no room in 31 days", () => {
    assert.equal(where({ minutes: 60, rules: { ...RULES, workStart: "08:00", workEnd: "08:30", minutesPerDay: 480 } }), "none: hours");
    assert.equal(where({ busy: [{ start: NOW, end: NOW + 40 * 86_400_000 }] }), "none: full");
    // Gaps of 20 minutes everywhere are too small for 30 minutes with air.
    const gaps: Busy[] = [];
    for (let t = at(TODAY, "00:00"); t < NOW + 33 * 86_400_000; t += 40 * 60_000) gaps.push({ start: t, end: t + 20 * 60_000 });
    assert.equal(where({ busy: gaps }), "none: full");
  });
});

async function world(o: { calendar?: boolean } = {}) {
  let now = NOW;
  const flow = makeCalendarStandin({
    seed: [
      // Today 09:30 to 10:30 busy, 10:40 to 11:40 free.
      { id: "m-busy", subject: "Planning", start: g("2026-11-19T08:30:00Z"), end: g("2026-11-19T09:30:00Z"), isOrganizer: true, showAs: "busy", attendees: [] },
      { id: "m-free", subject: "Walk", start: g("2026-11-19T09:40:00Z"), end: g("2026-11-19T10:40:00Z"), isOrganizer: true, showAs: "free", attendees: [] },
    ],
  });
  const url = o.calendar ? await flow.listen() : undefined;
  const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 }, { timeZone: TZ, clock: () => now });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Keeps sample projects on track" });
  const lars = w.engine.createBot({ name: "Lars", purpose: "Writes sample reports" });
  if (url) await setCalendar(w.engine, { address: url });
  setAheadSettings(w.engine, { enabled: true });
  w.engine.updateBot({ botId: kaja.id, patch: { ahead: "time" } });
  w.engine.updateBot({ botId: lars.id, patch: { ahead: "items" } });
  const close = async () => {
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
  const idOf = (r: ToolResult) => /ahd_\w+/.exec(text(r))![0];
  return { ...w, po, kaja, lars, close, turn, end, flow, idOf, setNow: (t: number) => (now = t) };
}

describe("ahead time: asking for the person's time", () => {
  test("level items is refused in plain words; level time gets a slot it did not choose; the day is only not-before", async () => {
    const w = await world();
    try {
      const ls = await w.turn(w.lars.id);
      const desc = ls.settings.tools.find((t) => t.name === "ahead_item")!.description;
      assert.doesNotMatch(desc, /Pobots picks a free slot/, "a bot at level items is not told about your-time");
      assert.match(text(await ls.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the report", minutes: 30 })), /needs Ahead permission time\. The person gives it in your Settings, Ahead, or asks the main bot \(update_bot ahead time\)/);
      const ks = await w.turn(w.kaja.id);
      assert.match(ks.settings.tools.find((t) => t.name === "ahead_item")!.description, /Pobots picks a free slot/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Too long", minutes: 200 })), /minutes is 5 to 120/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", minutes: 30 })), /needs a title/);
      const r = await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30, time: "15:00", todo: undefined });
      assert.match(text(r), /On Ahead: ahd_\w+, your-time, "Look at the draft plan", Thursday 19 Nov 09:30, 30 minutes\. Pobots chose the time\./);
      const item = w.store.ahead.get(w.idOf(r))!;
      assert.deepEqual([item.kind, item.day, item.time, item.minutes, item.changedBy, item.link?.threadId], ["your-time", TODAY, "09:30", 30, "bot", w.kaja.mainThreadId]);
      // The second goes around the first, with air.
      const r2 = await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Check the numbers", minutes: 20 });
      assert.match(text(r2), /Thursday 19 Nov 10:05, 20 minutes/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Check the numbers", minutes: 20 })), /^Already on Ahead/);
      // A day is only "not before".
      const r3 = await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Read the summary", minutes: 15, day: "2026-11-24" });
      assert.match(text(r3), /Tuesday 24 Nov 08:00/);
      assert.equal(w.store.ahead.get(w.idOf(r3))!.earliest, "2026-11-24");
      // list shows the plan.
      assert.match(text(await ks.tool("ahead_item", { action: "list" })), /your-time · "Look at the draft plan"/);
    } finally {
      await w.close();
    }
  });

  test("meetings block, those marked free do not; no calendar means only Pobots' own items count", async () => {
    const w = await world({ calendar: true });
    try {
      const ks = await w.turn(w.kaja.id);
      // 09:30 to 10:30 is a busy meeting; the free walk after it does not block.
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30 })), /Thursday 19 Nov 10:35/);
    } finally {
      await w.close();
    }
    const n = await world();
    try {
      const ks = await n.turn(n.kaja.id);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30 })), /Thursday 19 Nov 09:30/);
    } finally {
      await n.close();
    }
  });

  test("the day's limit and late: the bot and the main bot are told", async () => {
    const w = await world();
    try {
      const ps = await w.turn(w.po.id);
      assert.match(text(await ps.tool("change_settings", { ahead_time: { minutes_per_day: 60 } })), /Ahead, your time at most 60 minutes a day \(was 120\)/);
      await w.end(ps);
      assert.ok(changeLines(w.events, w.po.mainThreadId).some((l) => /your time at most 60 minutes/.test(l)), "a quiet line in the main bot's chat");
      const ks = await w.turn(w.kaja.id);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "First", minutes: 45 })), /Thursday 19 Nov 09:30/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Second", minutes: 30, latest_by: TODAY })), /Friday 20 Nov 08:00, 30 minutes\. Pobots chose the time\. That is after Thursday 19 Nov: there was no free slot before\. The main bot is told\./);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Third", minutes: 90 })), /more than the person's limit of 60 minutes/);
      assert.match(w.store.takeNews(w.po.mainThreadId).join("\n"), /Kaja asked for the person's time, "Second".*which is late/);
    } finally {
      await w.close();
    }
  });
});

describe("ahead time: the main bot is the time manager", () => {
  test("tool text says so; it places and moves any your-time at a time of its choice; focus blocks block but do not count", async () => {
    const w = await world();
    try {
      const ps = await w.turn(w.po.id);
      assert.match(ps.settings.tools.find((t) => t.name === "ahead_item")!.description, /responsible for the person's time/);
      assert.match(text(await ps.tool("get_settings")), /Working hours 08:00 to 17:00, mon tue wed thu fri, your-time at most 120 minutes a day \(change_settings ahead_time\)/);
      // A focus block of its own, 09:00 to 12:00, larger than the limit.
      assert.match(text(await ps.tool("ahead_item", { action: "add", kind: "your-time", title: "Focus", minutes: 180, time: "09:00", day: TODAY })), /Thursday 19 Nov 09:00, 180 minutes\.( |$)/);
      // Outside working hours too.
      assert.match(text(await ps.tool("ahead_item", { action: "add", kind: "your-time", title: "Evening read", minutes: 30, time: "19:00", day: TODAY })), /Thursday 19 Nov 19:00/);
      const ks = await w.turn(w.kaja.id);
      const r = await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 120 });
      assert.match(text(r), /Thursday 19 Nov 12:05, 120 minutes/, "goes around the focus block; the block does not use up the limit");
      const id = w.idOf(r);
      // The main bot moves Kaja's to a time of its choice; Kaja is told.
      assert.match(text(await ps.tool("ahead_item", { action: "move", id, day: "2026-11-20", time: "07:30" })), /Moved to Friday 20 Nov 07:30/);
      const moved = w.store.ahead.get(id)!;
      assert.deepEqual([moved.day, moved.time, moved.movedFrom, moved.changedBy], ["2026-11-20", "07:30", TODAY, "main"]);
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /the main bot moved your Ahead item "Look at the draft plan".*Friday 20 Nov 07:30/);
      // For another bot without a time: Pobots places it.
      assert.match(text(await ps.tool("ahead_item", { action: "add", kind: "your-time", title: "Sign off the sample", minutes: 15, bot: "Kaja" })), /Thursday 19 Nov 12:05/);
      // A bot's own move names a day; the time is Pobots'.
      assert.match(text(await ks.tool("ahead_item", { action: "move", id, day: "2026-11-24", time: "13:00" })), /Moved to Tuesday 24 Nov 08:00/);
      assert.match(text(await ps.tool("ahead_item", { action: "list" })), /Kaja/);
    } finally {
      await w.close();
    }
  });

  test("the week note: main bot only, replaced never stacked, 300 characters, empty clears", async () => {
    const w = await world();
    try {
      const ps = await w.turn(w.po.id);
      assert.match(text(await ps.tool("ahead_item", { action: "week_note", title: "A calm week. Two reviews on Tuesday." })), /at the top of Ahead/);
      assert.equal(w.engine.snapshot().ahead.weekNote?.text, "A calm week. Two reviews on Tuesday.");
      assert.ok(w.events.some((e) => e.event === "ahead.changed"));
      await ps.tool("ahead_item", { action: "week_note", title: "Busy Thursday." });
      assert.equal(w.engine.snapshot().ahead.weekNote?.text, "Busy Thursday.");
      assert.match(text(await ps.tool("ahead_item", { action: "week_note", title: "x".repeat(301) })), /under 300 characters/);
      // The window's own settings change keeps the note.
      setAheadSettings(w.engine, { minutesPerDay: 90 });
      assert.equal(w.engine.snapshot().ahead.weekNote?.text, "Busy Thursday.");
      const ks = await w.turn(w.kaja.id);
      assert.match(text(await ks.tool("ahead_item", { action: "week_note", title: "Mine" })), /Only the main bot/);
      await ps.tool("ahead_item", { action: "week_note", title: "" });
      assert.equal(w.engine.snapshot().ahead.weekNote, undefined);
      const view = await aheadView(w.engine, {});
      assert.ok(!view.rows.some((r) => r.source === "item" && r.item.kind === "note"), "the note is never a row");
    } finally {
      await w.close();
    }
  });
});

describe("ahead time: the person and the calendar", () => {
  test("Later today, Tomorrow, Next free slot and Not this week; the bot is told", async () => {
    const w = await world();
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.idOf(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30 }));
      assert.equal(w.store.ahead.get(id)!.time, "09:30");
      assert.deepEqual(parseParams("ahead.act", { itemId: id, action: "move", place: "next" }), { itemId: id, action: "move", place: "next" });
      assert.equal(parseParams("ahead.act", { itemId: id, action: "move", place: "soon" }), undefined);
      let r = await placeByPerson(w.engine, { itemId: id, action: "move", place: "today" });
      assert.deepEqual([r.item.day, r.item.time, r.item.changedBy], [TODAY, "10:00", "you"], "after its own slot");
      r = await placeByPerson(w.engine, { itemId: id, action: "move", place: "tomorrow" });
      assert.deepEqual([r.item.day, r.item.time, r.item.movedFrom], ["2026-11-20", "08:00", TODAY]);
      r = await placeByPerson(w.engine, { itemId: id, action: "move", place: "next" });
      assert.deepEqual([r.item.day, r.item.time], [TODAY, "09:30"]);
      r = await placeByPerson(w.engine, { itemId: id, action: "move", place: "next-week" });
      assert.deepEqual([r.item.day, r.item.time], ["2026-11-23", "08:00"]);
      const news = w.store.takeNews(w.kaja.mainThreadId).join("\n");
      assert.match(news, /the person moved your Ahead item "Look at the draft plan".*Monday 23 Nov 08:00 \(not this week\)\./);
      // Pick a time goes through the plain move; done is told too.
      aheadAct(w.engine, { itemId: id, action: "move", day: "2026-11-25", time: "14:00" });
      assert.equal(w.store.ahead.get(id)!.time, "14:00");
      aheadAct(w.engine, { itemId: id, action: "done" });
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /marked your Ahead item "Look at the draft plan" \(ahd_\w+\) done/);
      // Late in the day: nothing left today.
      const id2 = w.idOf(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Second look", minutes: 30 }));
      w.setNow(at(TODAY, "16:40"));
      await assert.rejects(placeByPerson(w.engine, { itemId: id2, action: "move", place: "today" }), /no free slot left today/);
      const note = w.idOf(await ks.tool("ahead_item", { action: "add", kind: "note", title: "A note", day: "2026-11-20" }));
      await assert.rejects(placeByPerson(w.engine, { itemId: note, action: "move", place: "next" }), /Only your-time/);
    } finally {
      await w.close();
    }
  });

  test("a meeting that comes on a placed item moves it at the next read, marked Moved from; a time the person chose stays", async () => {
    const w = await world({ calendar: true });
    try {
      const ks = await w.turn(w.kaja.id);
      const id = w.idOf(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30, day: "2026-11-20" }));
      const id2 = w.idOf(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Second look", minutes: 30, day: "2026-11-20" }));
      assert.deepEqual([w.store.ahead.get(id)!.time, w.store.ahead.get(id2)!.time], ["08:00", "08:35"]);
      aheadAct(w.engine, { itemId: id2, action: "move", day: "2026-11-20", time: "08:40" });
      // A meeting comes on Friday 08:00 to 09:00.
      w.flow.events.set("m-new", { id: "m-new", subject: "Early call", start: g("2026-11-20T07:00:00Z"), end: g("2026-11-20T08:00:00Z"), isOrganizer: true, showAs: "busy", attendees: [] });
      forgetMeetings(w.engine);
      await aheadView(w.engine, {});
      const moved = w.store.ahead.get(id)!;
      assert.deepEqual([moved.day, moved.time, moved.movedFrom], ["2026-11-20", "09:15", "2026-11-20"], "after the meeting and the person's own item, with air");
      assert.equal(w.store.ahead.get(id2)!.time, "08:40", "the person's choice stays");
      assert.match(w.store.takeNews(w.kaja.mainThreadId).join("\n"), /a meeting came on your Ahead item "Look at the draft plan".*Friday 20 Nov 09:15/);
      // A second read changes nothing.
      await aheadView(w.engine, {});
      assert.equal(w.store.ahead.get(id)!.time, "09:15");
    } finally {
      await w.close();
    }
  });
});

describe("ahead time: notifications", () => {
  test("off by default; at a slot's start once, and Your day is ready once in the first hour", async () => {
    const w = await world();
    try {
      const sent: string[] = [];
      w.engine.notifier.aheadNotice = (k) => (sent.push(k), true);
      assert.deepEqual([w.engine.notifier.state().kinds.yourTime, w.engine.notifier.state().kinds.dayReady], [false, false]);
      const ks = await w.turn(w.kaja.id);
      await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft plan", minutes: 30 });
      aheadTimeTick(w.engine, at(TODAY, "09:31"));
      assert.deepEqual(sent, [], "both kinds are off");
      w.engine.notifier.setKinds({ yourTime: true, dayReady: true });
      aheadTimeTick(w.engine, at(TODAY, "09:29"));
      aheadTimeTick(w.engine, at(TODAY, "09:31"));
      aheadTimeTick(w.engine, at(TODAY, "09:32"));
      assert.deepEqual(sent, ["yourTime"], "once, at its start; not in the first hour of the day (09:31 is past 09:00)");
      // Friday 08:10 with something on Ahead that day.
      await ks.tool("ahead_item", { action: "add", kind: "note", title: "Sample release", day: "2026-11-20" });
      aheadTimeTick(w.engine, at("2026-11-20", "08:10"));
      aheadTimeTick(w.engine, at("2026-11-20", "08:20"));
      assert.deepEqual(sent, ["yourTime", "dayReady"]);
      // Saturday is not a working day.
      await ks.tool("ahead_item", { action: "add", kind: "note", title: "Weekend thing", day: "2026-11-21" });
      aheadTimeTick(w.engine, at("2026-11-21", "08:10"));
      assert.deepEqual(sent, ["yourTime", "dayReady"]);
      // The words say only that.
      const m = pushMessage({ kind: "yourTime", prefix: "Test copy: " });
      assert.deepEqual([m.title, m.tag, m.url], ["Test copy: Your time on Ahead", "pobots-system-yourTime", "/"]);
      assert.equal(pushMessage({ kind: "dayReady" }).title, "Your day is ready");
      assert.ok(parseParams("notify.setKinds", { kinds: { yourTime: true, dayReady: false } }));
      const ps = await w.turn(w.po.id);
      assert.match(text(await ps.tool("change_settings", { notifications: { dayReady: false } })), /notifications for dayReady off/);
      assert.match(text(await ps.tool("get_settings")), /yourTime true, dayReady false/);
    } finally {
      await w.close();
    }
  });
});

describe("ahead time: the tool's size", () => {
  test("measured for a bot at level time and for the main bot", (t) => {
    const sizes: Record<string, number> = {};
    for (const [name, file] of [["items", { role: "bot", ahead: "items" }], ["time", { role: "bot", ahead: "time" }], ["main", { role: "main" }]] as const) {
      const tool = aheadToolFor({ tz: TZ } as never, { folder: { file } } as never);
      const json = JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(z.object(tool.shape)) });
      sizes[name] = Math.round(json.length / 3.5);
      t.diagnostic(`ahead_item for ${name}: ${json.length} characters, about ${sizes[name]} tokens`);
    }
    assert.ok(sizes.items! < 380, `items: ${sizes.items}`);
    assert.ok(sizes.time! < 440, `time: ${sizes.time}`);
    assert.ok(sizes.main! < 500, `main: ${sizes.main}`);
  });
});
