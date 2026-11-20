// When a to-do's block lands (engine 0.44.0, docs/build/step-block-time.md). A bot may say when, on
// add_todo and update_todo while blocks are on: an exact start (block_at), not before a day, a time
// of day or both (block_not_before), and a time of day the block ends by (block_not_after). The wish
// is checked before the to-do is made, kept on the block (AheadItem.wish) and used again whenever
// Pobots places the block again. Pure apart from the settings and the clock it reads.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { AheadWish } from "../../shared/protocol.js";
import type { PlaceAsk } from "./ahead-time.js";
import { aheadSettings } from "./ahead-settings.js";
import { dayOf, dayWords, isDay, isTime, timeOf, weekdayOf } from "./ahead-days.js";
import { at, ceilGrid, dayWindow, LEAD_MIN, type SlotFound } from "./ahead-slots.js";

/** The wish fields of add_todo and update_todo. On update an empty string clears that part. */
export interface WishArgs {
  block_at?: string;
  block_not_before?: string;
  block_not_after?: string;
}

/** What update_todo does to the wish: the wish after it, and whether the bot gave one now (it moves the block). */
export interface WishPlan {
  wish?: AheadWish;
  touched: boolean;
}

const MIN = 60_000;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** "Thu 19 Nov". */
export function shortDay(day: string): string {
  const [weekday, d, month] = dayWords(day).split(" ");
  return `${weekday!.slice(0, 3)} ${d} ${month}`;
}

/** A day and a time, "2026-11-23T14:00", as its parts; undefined when it is not one. */
function dayTime(s: string): { day: string; time: string } | undefined {
  const m = AT.exec(s);
  return m && isDay(m[1]) && isTime(m[2]) ? { day: m[1]!, time: m[2]! } : undefined;
}

/** block_not_before as its parts: a day, a time of day, or both. */
function notBeforeParts(s: string): { day?: string; time?: string } | undefined {
  if (isDay(s)) return { day: s };
  if (isTime(s)) return { time: s };
  return dayTime(s);
}

const given = (v: unknown): v is string => typeof v === "string";
const trim = (v: string | undefined) => (typeof v === "string" ? v.trim() : undefined);

/** True when the call says anything about when the block lands. */
export function wishTouched(args: WishArgs): boolean {
  return given(args.block_at) || given(args.block_not_before) || given(args.block_not_after);
}

/**
 * The wish after this call, checked: the old one (on update) with what the call gives, an empty
 * string clearing its part; block_at replaces the other two and the other two replace block_at.
 * Plain words for the bot when it cannot be kept. `minutes` is the to-do's length after the call.
 */
export function planWish(eng: Engine, args: WishArgs, before: AheadWish | undefined, minutes: number): WishPlan | string {
  const touched = wishTouched(args);
  const a = trim(args.block_at);
  const nb = trim(args.block_not_before);
  const na = trim(args.block_not_after);
  if (a && (nb || na)) return "Give block_at alone, or block_not_before and block_not_after: not both.";
  let wish: AheadWish = { ...(before ?? {}) };
  if (a !== undefined) {
    if (a) wish = { at: a };
    else delete wish.at;
  }
  if (nb !== undefined || na !== undefined) {
    if (nb || na) delete wish.at;
    if (nb !== undefined) {
      if (nb) wish.notBefore = nb;
      else delete wish.notBefore;
    }
    if (na !== undefined) {
      if (na) wish.notAfter = na;
      else delete wish.notAfter;
    }
  }
  const now = eng.clock();
  const today = dayOf(now, eng.tz);
  if (a) {
    const p = dayTime(a);
    if (!p) return "block_at is a day and a time, YYYY-MM-DDTHH:MM, such as 2026-11-23T14:00.";
    if (at(p.day, p.time, eng.tz) < now) return `block_at has passed: it is now ${shortDay(today)} ${timeOf(now, eng.tz)}.`;
  }
  if (nb) {
    const p = notBeforeParts(nb);
    if (!p) return "block_not_before is a day (2026-11-24), a time of day (13:00) or both (2026-11-24T13:00).";
    if (p.day && p.day < today) return `block_not_before has passed. Today is ${today}.`;
  }
  if (na && !isTime(na)) return "block_not_after is a time of day the block ends by, HH:MM, such as 16:00.";
  const fit = windowWords(eng, wish, minutes);
  if (fit) return fit;
  const out: WishPlan = { touched };
  if (wish.at || wish.notBefore || wish.notAfter) out.wish = wish;
  return out;
}

/** Why a wish's time of day cannot hold the block in the person's working day; "" when it can. */
function windowWords(eng: Engine, wish: AheadWish, minutes: number): string {
  const nbTime = wish.notBefore ? notBeforeParts(wish.notBefore)?.time : undefined;
  const naTime = wish.notAfter;
  if (!nbTime && !naTime) return "";
  const s = aheadSettings(eng);
  const hours = `the person's working day (${s.workStart} to ${s.workEnd})`;
  if (nbTime && nbTime >= s.workEnd) return `block_not_before ${nbTime} is after ${hours}. Ask the person, or give an earlier time.`;
  if (naTime && naTime <= s.workStart) return `block_not_after ${naTime} is before ${hours}. Ask the person, or give a later time.`;
  const w = dayWindow(s, nbTime, naTime);
  if (w.minutes < minutes) {
    return `From ${w.start} to ${w.end} in ${hours} there ${w.minutes === 1 ? "is 1 minute" : `are ${Math.max(0, w.minutes)} minutes`}, and the block is ${minutes}. Give a wider time (an empty block_not_before or block_not_after clears it) or fewer minutes.`;
  }
  return "";
}

/**
 * The placing rules of a wish. `fresh` when the bot gives it now: the main bot's exact time is then
 * kept even outside working hours. Placed again later, an exact time is "not before" that time. A
 * time of day that no longer holds the block (the working hours changed) is left out.
 */
export function wishRules(eng: Engine, wish: AheadWish | undefined, minutes: number, fresh?: { byMain: boolean }): Pick<PlaceAsk, "earliest" | "notBefore" | "dayStart" | "dayEnd" | "fixed"> {
  if (!wish) return {};
  if (wish.at) {
    const p = dayTime(wish.at);
    if (!p) return {};
    const t = at(p.day, p.time, eng.tz);
    return { earliest: p.day, notBefore: t, ...(fresh?.byMain ? { fixed: t } : {}) };
  }
  const out: Pick<PlaceAsk, "earliest" | "notBefore" | "dayStart" | "dayEnd"> = {};
  const p = wish.notBefore ? notBeforeParts(wish.notBefore) : undefined;
  if (p?.day && p.time) Object.assign(out, { earliest: p.day, notBefore: at(p.day, p.time, eng.tz) });
  else if (p?.day) out.earliest = p.day;
  const dayStart = p?.day ? undefined : p?.time;
  const dayEnd = wish.notAfter && isTime(wish.notAfter) ? wish.notAfter : undefined;
  if ((dayStart || dayEnd) && dayWindow(aheadSettings(eng), dayStart, dayEnd).minutes >= minutes) {
    if (dayStart) out.dayStart = dayStart;
    if (dayEnd) out.dayEnd = dayEnd;
  }
  return out;
}

/** True when the caller is the main bot, whose exact time is kept outside working hours. */
export const byMainBot = (rt: BotRuntime): boolean => rt.folder.file.role === "main";

/**
 * Why the exact time the bot gave was not kept, as words that follow where the block is: "" when
 * it was kept, or when the wish had no exact time.
 */
export function wishWords(eng: Engine, wish: AheadWish | undefined, slot: SlotFound, byMain: boolean): string {
  const p = wish?.at ? dayTime(wish.at) : undefined;
  if (!p) return "";
  const t = at(p.day, p.time, eng.tz);
  // A time off the 5-minute grid lands on the next mark: that is kept too.
  if (slot.start === t || slot.start === ceilGrid(t)) return "";
  const s = aheadSettings(eng);
  const what = slot.day === p.day ? p.time : `${shortDay(p.day)} ${p.time}`;
  let reason: string;
  if (byMain) reason = `${what} was taken`;
  else if (!s.workDays.includes(WEEKDAY_KEYS[weekdayOf(p.day)]!)) reason = `${shortDay(p.day)} is not one of the person's working days`;
  else if (p.time < s.workStart || t + slot.end - slot.start > at(p.day, s.workEnd, eng.tz)) reason = `${what} is outside the person's working hours (${s.workStart} to ${s.workEnd})`;
  else if (t < eng.clock() + LEAD_MIN * MIN) reason = `${what} is less than ${LEAD_MIN} minutes from now`;
  else reason = `${what} was taken`;
  return ` ${reason}, so it is the nearest free time after.`;
}
