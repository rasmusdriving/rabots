import assert from "node:assert/strict";
import { aheadAdd } from "../core/ahead-person.js";
import { aheadSeen, setAheadSettings } from "../core/ahead-settings.js";
import { aheadView } from "../core/ahead-view.js";
import { test } from "node:test";
import type { AheadItemRow } from "../../shared/protocol.js";
import { setup, settle } from "./fake.js";

const TODAY = "2026-11-19";
const NOW = Date.parse("2026-11-19T08:00:00Z");
const iso = (at: number) => new Date(at).toISOString();

function visit(t: { after(fn: () => void): void }) {
  let at = NOW;
  const w = setup(undefined, undefined, {}, { clock: () => at, timeZone: "Europe/Stockholm" });
  t.after(() => { w.engine.shutdown(); w.store.close(); });
  const main = w.engine.createBot("Guide");
  const bot = w.engine.createBot({ name: "Sample bot", purpose: "Keep a sample plan" });
  setAheadSettings(w.engine, { enabled: true });
  w.engine.updateBot({ botId: bot.id, patch: { ahead: "items" } });
  return {
    ...w, main, bot, advance: () => { at += 60_000; },
    turn: async () => {
      w.engine.sendMessage({ botId: bot.id, text: "Make a sample plan" });
      await settle();
      return w.sessions.at(-1)!;
    },
  };
}

test("Ahead Carrying uses the whole plan, open to-dos and cards, and real working helpers and managers", async (t) => {
  const w = visit(t);
  const { engine, bot } = w;
  const rt = engine.bot(bot.id);
  const s = await w.turn();
  await s.tool("ahead_item", { action: "add", title: "Look at the example", kind: "note", day: "2026-11-21" });
  await s.tool("ahead_item", { action: "add", title: "Finish the example", kind: "deadline", day: "2027-02-01" });
  for (const [id, due] of [["due", "2026-11-20"], ["earlier", "2026-11-16"], ["undated", undefined]] as const) {
    w.store.saveTodo({ status: "open", todo: { id, botId: bot.id, title: id, at: iso(NOW), updatedAt: iso(NOW), due, blocks: [], buttons: [], keepOpen: false } });
  }
  await s.tool("notify_human", { title: "Review the example" });
  await s.tool("start_task_manager", { title: "Plan the example", task: "Plan the example", model: "claude-haiku-5-5", effort: "low" });
  s.helperStart("look-one", { description: "Look at the sample", background: true });
  await settle();
  aheadAdd(engine, { title: "My own note", day: TODAY });
  engine.saveTrigger({ botId: bot.id, trigger: { kind: "schedule", name: "Review", where: "main", prompt: "Review", enabled: true, schedule: { type: "once", at: "2026-11-20T09:30:00Z" } } });
  const carrying = (await aheadView(engine, { from: "2027-02-01", days: 1 })).screen?.carrying;
  assert.deepEqual(carrying, [{ botId: bot.id, onAhead: 4, due: 4, waiting: 4, helpers: 1, managers: 1 }]);
  assert.equal(rt.helpers.size, 1);
});

test("Ahead Carrying counts a bot's your-time ask this week as waiting on you", async (t) => {
  const w = visit(t);
  const { engine, bot } = w;
  engine.updateBot({ botId: bot.id, patch: { ahead: "time" } });
  const s = await w.turn();
  const r = await s.tool("ahead_item", { action: "add", kind: "your-time", title: "Look at the sample", day: TODAY, minutes: 30 });
  assert.ok(!r.isError, JSON.stringify(r));
  const view = await aheadView(engine);
  const item = view.rows.find((x): x is AheadItemRow => x.source === "item" && x.item.kind === "your-time");
  assert.ok(item && item.day <= "2026-11-22", "placed this week");
  assert.deepEqual(view.screen?.carrying.map((c) => [c.botId, c.waiting]), [[bot.id, 1]]);
});

test("Ahead visit checkpoints preserve unseen changes and do not move backwards across devices", async (t) => {
  const w = visit(t);
  const s = await w.turn();
  const first = await aheadView(w.engine, {});
  assert.equal(first.screen?.readAt, iso(NOW));
  w.advance();
  await s.tool("ahead_item", { action: "add", title: "While the other page was open", kind: "note", day: TODAY });
  const made = (await aheadView(w.engine, {})).rows.find((r): r is AheadItemRow => r.source === "item")!;
  const left = aheadSeen(w.engine, first.screen?.readAt);
  assert.equal(left.lastOpenedAt, iso(NOW));
  const next = await aheadView(w.engine, {});
  assert.equal(next.screen?.seenAt, first.screen?.readAt);
  assert.deepEqual(next.rows[0]?.changed, { kind: "new" });
  aheadSeen(w.engine, next.screen?.readAt);
  assert.equal(aheadSeen(w.engine, first.screen?.readAt).lastOpenedAt, next.screen?.readAt);
  w.advance();
  await s.tool("ahead_item", { action: "move", id: made.item.id, day: "2026-11-23" });
  const moved = await aheadView(w.engine, {});
  assert.deepEqual(moved.rows[0]?.changed, { kind: "moved", from: TODAY });
  assert.equal(aheadSeen(w.engine, "2099-01-01T00:00:00.000Z").lastOpenedAt, moved.screen?.readAt);
  assert.equal((await aheadView(w.engine, {})).rows[0]?.changed, undefined);
  setAheadSettings(w.engine, { enabled: false });
  w.advance();
  assert.equal(aheadSeen(w.engine).lastOpenedAt, moved.screen?.readAt);
});
