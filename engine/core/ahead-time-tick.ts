// Ahead's two notifications on the schedule clock (engine 0.39.0, Ahead part B). Both are off by
// default (notify kinds "yourTime" and "dayReady") and say only that:
//   "Your time on Ahead": a "your time" slot starts (told once, within 5 minutes of its start).
//   "Your day is ready": in the first hour of a working day that has something on Ahead today.
// Nothing is computed while Ahead is off or both kinds are off. What was told is kept in one engine
// value, so a restart does not tell it again.
import type { Engine } from "../engine.js";
import { aheadOn, aheadSettings } from "./ahead-settings.js";
import { dayOf, weekdayOf } from "./ahead-days.js";
import { stretchOf } from "./ahead-slots.js";
import { away } from "./vacation.js";

const KEY = "ahead.told";
const LATE_MS = 5 * 60_000;
const DAY_READY_MS = 60 * 60_000;
const KEEP = 50;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

interface Told {
  slots: string[];
  day?: string;
}

function told(eng: Engine): Told {
  try {
    const v = JSON.parse(eng.store.getValue(KEY) ?? "{}") as Partial<Told>;
    return { slots: Array.isArray(v.slots) ? v.slots.filter((s) => typeof s === "string") : [], ...(typeof v.day === "string" ? { day: v.day } : {}) };
  } catch {
    return { slots: [] };
  }
}

/** One look, from the schedule clock (engine/core/triggers.ts). */
export function aheadTimeTick(eng: Engine, at: number): void {
  if (!aheadOn(eng)) return;
  const kinds = { yourTime: eng.notifier.isOn("yourTime"), dayReady: eng.notifier.isOn("dayReady") };
  if (!kinds.yourTime && !kinds.dayReady) return;
  const s = aheadSettings(eng);
  const today = dayOf(at, eng.tz);
  const t = told(eng);
  let changed = false;
  // A retired bot's items and those of a bot on vacation are out of sight, so they tell nothing.
  const items = eng.store.ahead.list({ from: today, to: today }).filter((i) => !i.botId || (eng.bots.has(i.botId) && !away(eng.bots.get(i.botId))));
  if (kinds.yourTime) {
    for (const i of items) {
      if (i.kind !== "your-time" || !i.time) continue;
      const start = stretchOf(i.day, i.time, i.minutes ?? 30, eng.tz).start;
      const key = `${i.id}@${i.day}T${i.time}`;
      if (start > at || at - start > LATE_MS || t.slots.includes(key)) continue;
      t.slots = [...t.slots, key].slice(-KEEP);
      changed = true;
      eng.notifier.aheadNotice("yourTime");
    }
  }
  if (kinds.dayReady && t.day !== today && s.workDays.includes(WEEKDAY_KEYS[weekdayOf(today)]!)) {
    const open = stretchOf(today, s.workStart, 0, eng.tz).start;
    if (at >= open && at - open < DAY_READY_MS) {
      const something = items.length > 0 || eng.store.openTodos().some((d) => d.due?.slice(0, 10) === today && eng.bots.has(d.botId));
      if (something) {
        t.day = today;
        changed = true;
        eng.notifier.aheadNotice("dayReady");
      }
    }
  }
  if (changed) eng.store.setValue(KEY, JSON.stringify(t));
}
