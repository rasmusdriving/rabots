// The Week grid's layout (ui/components/ahead/grid/grid-layout.ts, docs/build/step-ahead-redesign.md):
// pure logic of the window, tested here because `npm test` is where logic is tested.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AheadItem, AheadRow } from "../../shared/protocol.js";
import { LOUD_WIDTH, STRIP_LINES, gridRange, hoursOf, placeDay, snapTime, stretchOf, stripOf } from "../../ui/components/ahead/grid/grid-layout.js";

const DAY = "2026-11-19";
const RANGE = gridRange("08:00", "17:00");
const meeting = (id: string, time: string, end?: string): AheadRow => ({ source: "meeting", key: `meeting:${id}`, day: DAY, time, ...(end ? { end } : {}), title: id });
const run = (id: string, time: string): AheadRow => ({ source: "run", key: `run:${id}`, day: DAY, time, triggerId: id, botId: "sample", title: id });
const item = (id: string, more: Partial<AheadItem> = {}): AheadRow => {
  const it: AheadItem = { id, kind: "will-do", title: id, day: DAY, state: "open", createdAt: "", changedAt: "", changedBy: "bot", ...more };
  return { source: "item", key: `item:${id}`, day: DAY, ...(it.time ? { time: it.time } : {}), item: it };
};
const overlap = (a: { top: number; height: number; left: number; width: number }, b: typeof a) =>
  a.top < b.top + b.height - 1e-9 && b.top < a.top + a.height - 1e-9 && a.left < b.left + b.width - 1e-9 && b.left < a.left + a.width - 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("ahead grid: the grid shows the working hours on whole hours", () => {
  assert.deepEqual(gridRange("08:00", "17:00"), { start: 480, end: 1020 });
  assert.deepEqual(gridRange("08:30", "16:15"), { start: 480, end: 1020 });
  assert.equal(hoursOf(gridRange("07:00", "19:00")), 12);
  // Hours that make no day fall back to 08:00 to 17:00.
  assert.deepEqual(gridRange("18:00", "06:00"), { start: 480, end: 1020 });
});

test("ahead grid: height is time, and short things still get a line", () => {
  assert.deepEqual(stretchOf(meeting("a", "09:00", "11:30")), { start: 540, end: 690 });
  assert.deepEqual(stretchOf(meeting("standup", "09:00", "09:05")), { start: 540, end: 555 });
  assert.deepEqual(stretchOf(run("r", "08:30")), { start: 510, end: 530 });
  assert.deepEqual(stretchOf(item("slot", { kind: "your-time", time: "10:00", minutes: 45 })), { start: 600, end: 645 });
  assert.equal(stretchOf(item("untimed")), undefined);
  const l = placeDay([meeting("long", "09:30", "12:00"), meeting("short", "08:00", "08:15")], RANGE);
  const long = l.blocks.find((b) => b.row.key === "meeting:long")!;
  const short = l.blocks.find((b) => b.row.key === "meeting:short")!;
  assert.ok(Math.abs(long.height / short.height - 10) < 1e-9);
  assert.equal(short.top, 0);
});

test("ahead grid: meetings back to back keep the full width", () => {
  const l = placeDay([meeting("a", "09:00", "09:15"), meeting("b", "09:15", "09:30"), meeting("c", "09:30", "10:00")], RANGE);
  assert.equal(l.blocks.length, 3);
  for (const b of l.blocks) assert.deepEqual([b.col, b.cols, b.span], [0, 1, 1]);
});

test("ahead grid: things at the same time stand side by side and never cover each other", () => {
  const rows = [meeting("a", "08:30", "08:55"), run("r", "08:30"), meeting("b", "08:55", "09:00"), meeting("c", "09:00", "09:15"), meeting("d", "10:00", "11:00"), meeting("e", "10:30", "11:30"), item("slot", { kind: "your-time", time: "13:00", minutes: 30 })];
  const l = placeDay(rows, RANGE);
  assert.equal(l.blocks.length, rows.length);
  for (const a of l.blocks) for (const b of l.blocks) if (a !== b) assert.ok(!overlap(a, b), `${a.row.key} covers ${b.row.key}`);
  const r = l.blocks.find((b) => b.row.key === "run:r")!;
  const a = l.blocks.find((b) => b.row.key === "meeting:a")!;
  // The meeting first, the bot's run beside it, and the run's column is the wider one.
  assert.deepEqual([a.col, r.col, r.cols], [0, 1, 2]);
  assert.ok(near(a.left, 0) && near(a.width, 1 / (1 + LOUD_WIDTH)) && near(r.left, a.width) && near(r.width, LOUD_WIDTH / (1 + LOUD_WIDTH)));
  // Two meetings at the same time share the width evenly.
  const d = l.blocks.find((b) => b.row.key === "meeting:d")!;
  const e = l.blocks.find((b) => b.row.key === "meeting:e")!;
  assert.ok(near(d.width, 0.5) && near(e.left, 0.5) && near(e.width, 0.5));
  // What stands alone keeps the full width.
  assert.deepEqual([l.blocks.find((b) => b.row.key === "item:slot")!.cols], [1]);
});

test("ahead grid: a thing takes the free width beside it", () => {
  // a overlaps b and c; c starts after b ended, so c shares only with a.
  const l = placeDay([meeting("a", "09:00", "12:00"), meeting("b", "09:00", "10:00"), meeting("c", "11:00", "12:00"), meeting("x", "09:15", "09:45")], RANGE);
  const c = l.blocks.find((b) => b.row.key === "meeting:c")!;
  assert.deepEqual([c.col, c.cols, c.span], [1, 3, 2]);
  assert.ok(near(c.left, 1 / 3) && near(c.width, 2 / 3));
});

test("ahead grid: from the fourth at the same time they fold into one count", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => meeting(id, "13:00", "14:00"));
  const l = placeDay(rows, RANGE);
  assert.equal(l.blocks.length, 2);
  assert.equal(l.folded.length, 1);
  assert.equal(l.folded[0]!.rows.length, 3);
  assert.deepEqual([l.folded[0]!.col, l.folded[0]!.cols], [2, 3]);
  for (const b of l.blocks) assert.ok(b.col + b.span <= 2);
  assert.ok(near(l.folded[0]!.left, 2 / 3) && near(l.folded[0]!.width, 1 / 3));
  for (const b of l.blocks) assert.ok(b.left + b.width <= 2 / 3 + 1e-9);
  // Exactly three still show, all of them.
  const three = placeDay(rows.slice(0, 3), RANGE);
  assert.deepEqual([three.blocks.length, three.folded.length], [3, 0]);
});

test("ahead grid: outside the working hours, across their edge, and with no time", () => {
  const l = placeDay([meeting("early", "06:30", "07:30"), meeting("edge", "07:30", "08:30"), meeting("late", "17:00", "18:00"), meeting("over", "16:30", "18:00"), meeting("night", "23:30"), item("untimed"), run("evening", "19:00")], RANGE);
  assert.deepEqual(l.before.map((r) => r.key), ["meeting:early"]);
  assert.deepEqual(l.after.map((r) => r.key).sort(), ["meeting:late", "meeting:night", "run:evening"]);
  assert.deepEqual(l.untimed.map((r) => r.key), ["item:untimed"]);
  const edge = l.blocks.find((b) => b.row.key === "meeting:edge")!;
  assert.deepEqual([edge.start, edge.end, edge.top], [480, 510, 0]);
  const over = l.blocks.find((b) => b.row.key === "meeting:over")!;
  assert.equal(over.end, 1020);
  assert.ok(Math.abs(over.top + over.height - 1) < 1e-9);
});

test("ahead grid: a drop snaps to 15 minutes and stays inside the grid", () => {
  assert.equal(snapTime(0, RANGE), "08:00");
  assert.equal(snapTime((10 * 60 + 22 - 480) / 540, RANGE), "10:15");
  assert.equal(snapTime((10 * 60 + 23 - 480) / 540, RANGE), "10:30");
  assert.equal(snapTime(-0.2, RANGE), "08:00");
  assert.equal(snapTime(1.2, RANGE), "16:45");
  // A longer slot ends with the working day.
  assert.equal(snapTime(1, RANGE, 45), "16:15");
});

test("ahead grid: the strip on top has fixed lines, and a bot's thing takes two when there is room", () => {
  const allDay = (id: string): AheadRow => ({ source: "meeting", key: `meeting:${id}`, day: DAY, allDay: true, title: id });
  assert.equal(STRIP_LINES, 4);
  // One of the bot's things and an all-day meeting: the bot's thing first, on two lines.
  const roomy = stripOf([allDay("conference"), item("a")], false);
  assert.deepEqual([roomy.shown.map((r) => r.key), roomy.hidden, roomy.tall], [["item:a", "meeting:conference"], 0, true]);
  // Two of the bots' things fill the four lines; a third thing makes them one line each.
  assert.equal(stripOf([item("a"), item("b")], false).tall, true);
  const three = stripOf([item("a"), item("b"), allDay("conference")], false);
  assert.deepEqual([three.shown.length, three.hidden, three.tall], [3, 0, false]);
  // Only meetings: one line each, nothing to make taller.
  assert.equal(stripOf([allDay("x"), allDay("y")], false).tall, false);
  // More than the lines hold: the last line says how many more.
  const many = stripOf([item("a"), item("b"), item("c"), item("d"), allDay("conference")], false);
  assert.deepEqual([many.shown.map((r) => r.key), many.hidden], [["item:a", "item:b", "item:c"], 2]);
  // "From earlier" takes the first line.
  const late = stripOf([item("a"), item("b"), item("c"), item("d")], true);
  assert.deepEqual([late.shown.length, late.hidden], [2, 2]);
  assert.equal(stripOf([item("a")], true).tall, true);
  assert.equal(stripOf([item("a"), item("b")], true).tall, false);
  // A phone's Day: three lines, one line each.
  const phone = stripOf([item("a"), allDay("conference")], false, 3, false);
  assert.deepEqual([phone.shown.length, phone.hidden, phone.tall], [2, 0, false]);
});
