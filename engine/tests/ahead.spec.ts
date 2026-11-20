// Ahead, part A (engine 0.39.0, docs/build/step-ahead.md): off by default with no tool for anyone,
// the switch and the per-bot permission (window and main bot), ahead_item's five actions, the main
// bot acting on any bot's items, the person's actions told at the bot's next turn, a passed day told
// once, the view's sources (items, dated to-dos, once runs, meetings through the stand-in flow),
// "From earlier" and "Later", vacation and retirement, and "Since you looked" marks.
// Stand-in harness, no model, nothing sent outside this computer.
import { aheadAct, aheadAdd } from "../core/ahead-person.js";
import { aheadView } from "../core/ahead-view.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AheadItemRow, AheadView, Events } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { z } from "zod";
import { parseParams } from "../schemas.js";
import { aheadToolFor } from "../core/ahead-tool.js";
import { setCalendar } from "../core/calendar-settings.js";
import { aheadSeen, aheadTool, setAheadSettings } from "../core/ahead-settings.js";
import { addDays, dayOf, mondayOf } from "../core/ahead-days.js";
import { makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { changeLines, type FakeSession, settle, setup } from "./fake.js";

const TZ = "Europe/Stockholm";
/** Thursday 19 Nov 2026, 09:00 in Stockholm. */
const NOW = Date.parse("2026-11-19T08:00:00Z");
const TODAY = "2026-11-19";
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;
const g = (iso: string) => ({ dateTime: new Date(iso).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" });

async function world(o: { calendar?: boolean } = {}) {
  let at = NOW;
  const flow = makeCalendarStandin({
    seed: [
      { id: "m-sync", subject: "Weekly sync", start: g("2026-11-20T09:00:00Z"), end: g("2026-11-20T09:30:00Z"), isOrganizer: true, showAs: "busy", attendees: [] },
      { id: "m-free", subject: "Lunch walk", start: g("2026-11-20T11:00:00Z"), end: g("2026-11-20T12:00:00Z"), isOrganizer: true, showAs: "free", attendees: [] },
      { id: "m-gone", subject: "Cancelled call", start: g("2026-11-21T09:00:00Z"), end: g("2026-11-21T10:00:00Z"), isOrganizer: true, isCancelled: true, attendees: [] },
    ],
  });
  const url = o.calendar ? await flow.listen() : undefined;
  const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 }, { timeZone: TZ, clock: () => at });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Keeps sample projects on track" });
  if (url) await setCalendar(w.engine, { address: url });
  const close = async () => {
    w.engine.shutdown();
    if (url) await flow.close();
    w.store.close();
  };
  /** Sends a message and returns the bot's live session. */
  const turn = async (botId: string, msg = "Go") => {
    w.engine.sendMessage({ botId, text: msg });
    await settle();
    return sessionOf(w.sessions, botId);
  };
  const end = async (s: FakeSession) => {
    s.reply("Done.");
    await settle();
  };
  return { ...w, po, kaja, close, turn, end, flow, setNow: (t: number) => (at = t), now: () => at };
}

describe("ahead: off by default", () => {
  test("no tool for any bot, the main bot at the full level, others off; the view is refused", async () => {
    const w = await world();
    try {
      const snap = w.engine.snapshot();
      assert.equal(snap.ahead.enabled, false);
      assert.deepEqual([snap.ahead.workStart, snap.ahead.workEnd, snap.ahead.workDays.join(","), snap.ahead.minutesPerDay], ["08:00", "17:00", "mon,tue,wed,thu,fri", 120]);
      assert.deepEqual(snap.bots.map((b) => b.ahead), ["time", "off"]);
      const ps = await w.turn(w.po.id);
      assert.ok(!ps.toolNames().includes("ahead_item"));
      await assert.rejects(aheadView(w.engine, {}), /Ahead is off/);
      assert.throws(() => aheadAct(w.engine, { itemId: "ahd_x", action: "done" }), /Ahead is off/);
    } finally {
      await w.close();
    }
  });
});

describe("ahead: switch, permission and the tool", () => {
  test("the main bot switches Ahead on and gives a bot its permission, each with a quiet line; the tool follows", async () => {
    const w = await world();
    try {
      const ps = await w.turn(w.po.id);
      const changed: Events["ahead.changed"][] = [];
      for (const e of w.events) if (e.event === "ahead.changed") changed.push(e.data as Events["ahead.changed"]);
      assert.match(text(await ps.tool("change_settings", { ahead: true })), /Ahead from off to on/);
      assert.equal(w.engine.snapshot().ahead.enabled, true);
      assert.ok(w.events.some((e) => e.event === "ahead.changed"));
      assert.match(text(await ps.tool("get_settings")), /Ahead \(the screen for what is coming\): on/);
      assert.match(text(await ps.tool("update_bot", { bot: "Kaja", ahead: "items" })), /Ahead from off to items/);
      assert.equal(w.engine.snapshot().bots[1]?.ahead, "items");
      assert.match(text(await ps.tool("get_bot", { bot: "Kaja" })), /Ahead: may put items on Ahead\./);
      await w.end(ps);
      assert.ok(changeLines(w.events, w.po.mainThreadId).some((l) => /Ahead from off to on/.test(l)));
      // The tool comes with the next session, for both.
      assert.ok((await w.turn(w.po.id)).toolNames().includes("ahead_item"));
      const ks = await w.turn(w.kaja.id);
      assert.ok(ks.toolNames().includes("ahead_item"));
      const desc = ks.settings.tools.find((t) => t.name === "ahead_item")!.description;
      assert.doesNotMatch(desc, /any bot's items/, "only the main bot is told it may act on any bot's items");
      // Back to off from the window: the tool goes again.
      setAheadSettings(w.engine, { enabled: false });
      await w.end(ks);
      assert.ok(!(await w.turn(w.kaja.id)).toolNames().includes("ahead_item"));
    } finally {
      await w.close();
    }
  });

  test("add, list, move, done, drop: own items only, refusals in plain words, your-time needs level time", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the draft", day: "2026-11-20" })), /needs Ahead permission time/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", title: "Old", day: "2026-11-18" })), /That day has passed/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", title: "No day" })), /needs a day/);
      assert.match(text(await ks.tool("ahead_item", { action: "add", title: "Bad time", day: "2026-11-20", time: "9am" })), /HH:MM/);
      const added = text(await ks.tool("ahead_item", { action: "add", kind: "will-do", title: "Send the sample summary", day: "2026-11-20", time: "15:00", label: "Sample project", why: "Promised in chat" }));
      assert.match(added, /^On Ahead: ahd_\w+ · 2026-11-20 15:00 · will-do · "Send the sample summary" · Sample project$/);
      const id = /ahd_\w+/.exec(added)![0];
      const item = w.store.ahead.get(id)!;
      assert.equal(item.botId, w.kaja.id);
      assert.equal(item.link?.threadId, w.kaja.mainThreadId, "the link back to the chat is filled in by the engine");
      assert.equal(item.changedBy, "bot");
      assert.match(text(await ks.tool("ahead_item", { action: "add", kind: "will-do", title: "Send the sample summary", day: "2026-11-20" })), /^Already on Ahead/);
      assert.equal(w.store.ahead.countOpen(w.kaja.id), 1);
      assert.match(text(await ks.tool("ahead_item", { action: "list" })), /Send the sample summary/);
      assert.match(text(await ks.tool("ahead_item", { action: "move", id, day: "2026-11-24", time: "" })), /Moved to Tuesday 24 Nov: "Send the sample summary"/);
      assert.equal(w.store.ahead.get(id)!.movedFrom, "2026-11-20");
      assert.equal(w.store.ahead.get(id)!.time, undefined);
      assert.match(text(await ks.tool("ahead_item", { action: "list", day: "2026-11-25", to: "2026-11-30" })), /No open items on Ahead in that range/);
      // The main bot's own item is not Kaja's to touch.
      const ps = await w.turn(w.po.id);
      const poItem = /ahd_\w+/.exec(text(await ps.tool("ahead_item", { action: "add", kind: "note", title: "Quarter review", day: "2026-12-01" })))![0];
      assert.match(text(await ks.tool("ahead_item", { action: "done", id: poItem })), /no item on Ahead with that id/);
      assert.match(text(await ks.tool("ahead_item", { action: "done", id })), /^Done:/);
      assert.match(text(await ks.tool("ahead_item", { action: "drop", id })), /already done/);
      assert.ok(w.events.some((e) => e.event === "ahead.items"));
    } finally {
      await w.close();
    }
  });

  test("the main bot adds for another bot, lists all and acts on any bot's items; that bot is told at its next turn", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ps = await w.turn(w.po.id);
      const desc = ps.settings.tools.find((t) => t.name === "ahead_item")!.description;
      assert.match(desc, /any bot's items/);
      const added = text(await ps.tool("ahead_item", { action: "add", bot: "Kaja", kind: "deadline", title: "Report due", day: "2026-11-27" }));
      const id = /ahd_\w+/.exec(added)![0];
      assert.equal(w.store.ahead.get(id)!.botId, w.kaja.id);
      assert.equal(w.store.ahead.get(id)!.changedBy, "main");
      assert.match(text(await ps.tool("ahead_item", { action: "list" })), /"Report due" · Kaja/);
      assert.match(text(await ps.tool("ahead_item", { action: "move", id, day: "2026-11-30" })), /Moved/);
      assert.match(text(await ps.tool("ahead_item", { action: "list", bot: "Nobody" })), /no bot called Nobody/);
      const ks = await w.turn(w.kaja.id, "Hello");
      const sent = ks.sent.at(-1)!.before.join("\n");
      assert.match(sent, /the main bot put an item on Ahead for you: "Report due"/);
      assert.match(sent, /the main bot moved your Ahead item "Report due" \(ahd_\w+\) from Friday 27 Nov to Monday 30 Nov/);
    } finally {
      await w.close();
    }
  });
});

describe("ahead: the person's actions and passed days", () => {
  test("done, move and reopen from the window are told to the bot at its next turn, never by waking it", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      const id = /ahd_\w+/.exec(text(await ks.tool("ahead_item", { action: "add", kind: "waiting", title: "Answer from the sample team", day: "2026-11-23" })))![0];
      const id2 = /ahd_\w+/.exec(text(await ks.tool("ahead_item", { action: "add", kind: "note", title: "Plan the next step", day: "2026-11-23" })))![0];
      await w.end(ks);
      const turnsBefore = ks.sent.length;
      const done = aheadAct(w.engine, { itemId: id, action: "done" });
      assert.equal(done.item.state, "done");
      assert.equal(done.item.changedBy, "you");
      const moved = aheadAct(w.engine, { itemId: id2, action: "move", day: "2026-11-25", time: "10:00" });
      assert.deepEqual([moved.item.day, moved.item.time, moved.item.movedFrom], ["2026-11-25", "10:00", "2026-11-23"]);
      assert.equal(aheadAct(w.engine, { itemId: id, action: "reopen" }).item.state, "open");
      await settle();
      assert.equal(ks.sent.length, turnsBefore, "the bot is not woken");
      assert.throws(() => aheadAct(w.engine, { itemId: "ahd_none", action: "done" }), /no longer on Ahead/);
      assert.throws(() => aheadAct(w.engine, { itemId: id2, action: "move", day: "soon" }), /Pick a day/);
      const next = await w.turn(w.kaja.id, "Hello");
      const sent = next.sent.at(-1)!.before.join("\n");
      assert.match(sent, /the person marked your Ahead item "Answer from the sample team" \(ahd_\w+\) done/);
      assert.match(sent, /the person moved your Ahead item "Plan the next step" \(ahd_\w+\) from Monday 23 Nov to Wednesday 25 Nov 10:00/);
      assert.match(sent, /the person opened your Ahead item "Answer from the sample team" \(ahd_\w+\) again/);
    } finally {
      await w.close();
    }
  });

  test("a passed day: the item collects under From earlier and its bot is told once", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      await ks.tool("ahead_item", { action: "add", kind: "will-do", title: "Call back", day: "2026-11-19" });
      await w.end(ks);
      w.setNow(NOW + 2 * 24 * 3600_000);
      const view = await aheadView(w.engine, {});
      assert.equal(view.today, "2026-11-21");
      assert.deepEqual(view.earlier.map((r) => r.source === "item" && r.item.title), ["Call back"]);
      const s1 = await w.turn(w.kaja.id, "Morning");
      assert.match(s1.sent.at(-1)!.before.join("\n"), /the day passed for your Ahead item: "Call back"/);
      await w.end(s1);
      const s2 = await w.turn(w.kaja.id, "Again");
      assert.doesNotMatch(s2.sent.at(-1)!.before.join("\n"), /the day passed/);
      assert.match(text(await s2.tool("ahead_item", { action: "list" })), /Call back.*\(day passed\)/);
    } finally {
      await w.close();
    }
  });
});

describe("ahead: the view", () => {
  test("items, dated to-dos, once runs and meetings by day; Later beyond the range; nothing from retired bots", async () => {
    const w = await world({ calendar: true });
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      await ks.tool("ahead_item", { action: "add", kind: "will-do", title: "Send the sample summary", day: "2026-11-20", time: "15:00" });
      await ks.tool("ahead_item", { action: "add", kind: "deadline", title: "Year plan due", day: "2027-01-15" });
      await ks.tool("add_todo", { title: "Approve the sample plan", by_when: "2026-11-23T10:00" });
      await ks.tool("add_todo", { title: "No date here" });
      w.engine.saveTrigger({ botId: w.kaja.id, trigger: { kind: "schedule", name: "Check the sample inbox", where: "main", prompt: "Check", enabled: true, schedule: { type: "once", at: "2026-11-24T07:30:00Z" } } });
      w.engine.saveTrigger({ botId: w.kaja.id, trigger: { kind: "schedule", name: "Every morning", where: "main", prompt: "Morning", enabled: true, schedule: { type: "daily", time: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] } } });
      const own = aheadAdd(w.engine, { title: "Dentist", day: "2026-11-26", time: "08:30" }).item;
      assert.equal(own.botId, undefined);
      const view: AheadView = await aheadView(w.engine, {});
      assert.deepEqual([view.today, view.from, view.to, view.meetings], [TODAY, TODAY, "2026-12-02", "on"]);
      const seen = view.rows.map((r) => `${r.day} ${r.time ?? "--:--"} ${r.source} ${r.source === "item" ? r.item.title : r.title}`);
      assert.deepEqual(seen, [
        "2026-11-20 10:00 meeting Weekly sync",
        "2026-11-20 12:00 meeting Lunch walk",
        "2026-11-20 15:00 item Send the sample summary",
        "2026-11-23 10:00 todo Approve the sample plan",
        "2026-11-24 08:30 run Check the sample inbox",
        "2026-11-26 08:30 item Dentist",
      ]);
      const free = view.rows.find((r) => r.source === "meeting" && r.title === "Lunch walk");
      assert.equal(free?.source === "meeting" && free.free, true);
      assert.deepEqual(view.later.map((r) => r.source === "item" && r.item.title), ["Year plan due"]);
      assert.equal(view.earlier.length, 0);
      // The stand-in was asked once for the range; a second look within 10 minutes reads from memory.
      const lists = () => w.flow.calls.filter((c: { action?: string }) => c.action === "list").length;
      const before = lists();
      await aheadView(w.engine, {});
      assert.equal(lists(), before);
      // Retired: its items are left out of the view and kept in the store.
      w.engine.retireBot(w.kaja.id);
      const after = await aheadView(w.engine, {});
      assert.deepEqual(after.rows.filter((r) => r.source !== "meeting").map((r) => r.source === "item" && r.item.title), ["Dentist"]);
      assert.equal(w.store.ahead.countOpen(w.kaja.id), 2);
    } finally {
      await w.close();
    }
  });

  test("no calendar: no meetings and no error; vacation: items marked away and no tool", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      await ks.tool("ahead_item", { action: "add", kind: "note", title: "Sample launch", day: "2026-11-25" });
      await w.end(ks);
      const view = await aheadView(w.engine, {});
      assert.equal(view.meetings, "none");
      w.engine.setVacation({ botId: w.kaja.id, vacation: true });
      const away = await aheadView(w.engine, {});
      assert.equal((away.rows[0] as AheadItemRow).away, true);
      assert.equal(aheadTool(w.engine, w.engine.bot(w.kaja.id)), false, "no tool while on vacation");
      w.engine.setVacation({ botId: w.kaja.id, vacation: false });
      assert.equal(aheadTool(w.engine, w.engine.bot(w.kaja.id)), true);
    } finally {
      await w.close();
    }
  });

  test("since you looked: rows changed by others after the last look are marked new or moved; the person's own are not", async () => {
    const w = await world();
    try {
      setAheadSettings(w.engine, { enabled: true });
      w.engine.updateBot({ botId: w.kaja.id, patch: { ahead: "items" } });
      const ks = await w.turn(w.kaja.id);
      const id = /ahd_\w+/.exec(text(await ks.tool("ahead_item", { action: "add", kind: "note", title: "Before the look", day: "2026-11-24" })))![0];
      w.setNow(NOW + 60_000);
      assert.ok(aheadSeen(w.engine).lastOpenedAt);
      w.setNow(NOW + 120_000);
      await ks.tool("ahead_item", { action: "move", id, day: "2026-11-25" });
      await ks.tool("ahead_item", { action: "add", kind: "note", title: "After the look", day: "2026-11-24" });
      aheadAdd(w.engine, { title: "Mine", day: "2026-11-24" });
      const view = await aheadView(w.engine, {});
      const mark = (t: string) => (view.rows.find((r) => r.source === "item" && r.item.title === t) as AheadItemRow).changed;
      assert.deepEqual(mark("Before the look"), { kind: "moved", from: "2026-11-24" });
      assert.deepEqual(mark("After the look"), { kind: "new" });
      assert.equal(mark("Mine"), undefined);
    } finally {
      await w.close();
    }
  });
});

describe("ahead: settings and shapes", () => {
  test("working hours, days and minutes are checked; the methods' shapes parse", async () => {
    const w = await world();
    try {
      assert.throws(() => setAheadSettings(w.engine, { workStart: "8" }), /08:00/);
      assert.throws(() => setAheadSettings(w.engine, { workStart: "18:00" }), /ends after it starts/);
      assert.throws(() => setAheadSettings(w.engine, { workDays: [] }), /at least one/);
      const s = setAheadSettings(w.engine, { workStart: "07:30", workDays: ["fri", "mon"], minutesPerDay: 90 });
      assert.deepEqual([s.workStart, s.workDays.join(","), s.minutesPerDay, s.enabled], ["07:30", "mon,fri", 90, false]);
      assert.equal(w.engine.snapshot().ahead.workStart, "07:30");
      assert.ok(parseParams("ahead.view", { days: 14 }));
      assert.ok(parseParams("ahead.act", { itemId: "ahd_x", action: "move", day: "2026-11-20", time: null }));
      assert.ok(parseParams("ahead.add", { title: "x", day: "2026-11-20" }));
      assert.ok(parseParams("bot.update", { botId: "kaja", patch: { ahead: "items" } }));
      assert.equal(parseParams("ahead.act", { itemId: "ahd_x", action: "explode" }), undefined);
      assert.equal(parseParams("bot.update", { botId: "kaja", patch: { ahead: "always" } }), undefined);
    } finally {
      await w.close();
    }
  });

  test("the tool stays small: about 300 tokens for a bot, a little more for the main bot", (t) => {
    for (const role of ["bot", "main"] as const) {
      const tool = aheadToolFor({ tz: TZ, store: { getValue: () => undefined } } as never, { folder: { file: { role } } } as never);
      const json = JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(z.object(tool.shape)) });
      // About 3.5 characters a token for English and JSON.
      const tokens = Math.round(json.length / 3.5);
      t.diagnostic(`ahead_item for ${role}: ${json.length} characters, about ${tokens} tokens`);
      // Part B adds the main bot's time manager line and week note (engine/tests/ahead-time.spec.ts measures it).
      // Engine 0.41.0: the main bot's text holds how to schedule the person (their own words, about 65 tokens by default).
      assert.ok(tokens < (role === "main" ? 620 : 380), `${role}: ${tokens}`);
    }
  });

  test("days: weeks start on Monday; adding days crosses months", () => {
    assert.equal(mondayOf("2026-11-19"), "2026-11-16");
    assert.equal(mondayOf("2026-11-16"), "2026-11-16");
    assert.equal(addDays("2026-11-30", 2), "2026-12-02");
    assert.equal(dayOf(Date.parse("2026-11-19T23:30:00Z"), TZ), "2026-11-20");
  });
});
