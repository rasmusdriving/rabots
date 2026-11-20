// Free slots for "your time" (engine 0.39.0, Ahead part B, docs/build/step-ahead.md). Pure: no store,
// no clock, no calendar; the caller passes everything in.
//
// A slot is inside working hours on a working day, starts at least 30 minutes from now, keeps 5
// minutes of air on both sides of anything busy, starts on the 5-minute grid, and keeps the day
// within its limit of minutes. Days are worked out as wall times turned into instants, so a
// daylight saving day has the right length. With no slot on or before "latest by" the search goes
// on and the slot it finds is late. It looks 31 days ahead at most (the meetings read's limit).
import { instantFor } from "../schedule.js";
import { addDays, dayOf, isDay, timeOf, weekdayOf } from "./ahead-days.js";

export const LEAD_MIN = 30;
export const AIR_MIN = 5;
export const GRID_MIN = 5;
export const SEARCH_DAYS = 31;

const MIN = 60_000;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAY_KEYS)[number];

export interface SlotRules {
  workStart: string;
  workEnd: string;
  workDays: readonly Weekday[];
  minutesPerDay: number;
}

/** A busy stretch, as instants: [start, end). */
export interface Busy {
  start: number;
  end: number;
}

export interface SlotAsk {
  minutes: number;
  now: number;
  tz: string;
  rules: SlotRules;
  busy: readonly Busy[];
  /** Minutes of "your time" already on each day (YYYY-MM-DD), counted toward the limit. */
  used?: Readonly<Record<string, number>>;
  /** Not before this day. */
  earliest?: string;
  /** Not before this time (such as "later today" or "next week"). */
  notBefore?: number;
  /** The last good day; a slot after it is late. */
  latestBy?: string;
  /** The last good end, as an instant (a to-do's by_when with a time); a slot ending after it is late. */
  latestEnd?: number;
  /** False for the main bot's own focus blocks: they do not count toward the day's limit. */
  counts?: boolean;
}

export type SlotFound = { ok: true; day: string; time: string; start: number; end: number; late: boolean };
/** Why nothing was found: longer than the day's limit, longer than the working day, or no room in 31 days. */
export type SlotNone = { ok: false; why: "limit" | "hours" | "full" };

const hm = (s: string): [number, number] => {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return [h, m];
};

const at = (day: string, time: string, tz: string): number => {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = hm(time);
  return instantFor(y, mo - 1, d, h, mi, tz);
};

/** Up to the next 5-minute mark. Every time zone's offset is a multiple of 5 minutes, so the grid is the wall clock's too. */
export const ceilGrid = (t: number): number => Math.ceil(t / (GRID_MIN * MIN)) * GRID_MIN * MIN;

/** The busy stretch (the one ending last) that [start, end) runs into, air on both sides counted; none when clear. */
const clashOf = (busy: readonly Busy[], start: number, end: number): Busy | undefined => {
  const air = AIR_MIN * MIN;
  let worst: Busy | undefined;
  for (const b of busy) {
    if (b.start < end + air && b.end > start - air && (!worst || b.end > worst.end)) worst = b;
  }
  return worst;
};

/** The first free slot, or why there is none. */
export function findSlot(ask: SlotAsk): SlotFound | SlotNone {
  const { minutes, now, tz, rules } = ask;
  const counts = ask.counts !== false;
  if (counts && minutes > rules.minutesPerDay) return { ok: false, why: "limit" };
  const [sh, sm] = hm(rules.workStart);
  const [eh, em] = hm(rules.workEnd);
  if (eh * 60 + em - (sh * 60 + sm) < minutes) return { ok: false, why: "hours" };
  const today = dayOf(now, tz);
  const first = ask.earliest && isDay(ask.earliest) && ask.earliest > today ? ask.earliest : today;
  const lead = now + LEAD_MIN * MIN;
  const length = minutes * MIN;
  for (let n = 0; n < SEARCH_DAYS; n++) {
    const day = addDays(first, n);
    if (!rules.workDays.includes(WEEKDAY_KEYS[weekdayOf(day)]!)) continue;
    if (counts && (ask.used?.[day] ?? 0) + minutes > rules.minutesPerDay) continue;
    const open = at(day, rules.workStart, tz);
    const close = at(day, rules.workEnd, tz);
    let t = ceilGrid(Math.max(open, lead, ask.notBefore ?? 0));
    while (t + length <= close) {
      const clash = clashOf(ask.busy, t, t + length);
      if (!clash) {
        const late = (!!ask.latestBy && day > ask.latestBy) || (ask.latestEnd !== undefined && t + length > ask.latestEnd);
        return { ok: true, day, time: timeOf(t, tz), start: t, end: t + length, late };
      }
      t = ceilGrid(clash.end + AIR_MIN * MIN);
    }
  }
  return { ok: false, why: "full" };
}

/** The start and end of a wall-time stretch on a day, as instants. */
export function stretchOf(day: string, time: string, minutes: number, tz: string): Busy {
  const start = at(day, time, tz);
  return { start, end: start + minutes * MIN };
}

/** A whole day, as instants (an all-day meeting). */
export function wholeDay(day: string, tz: string): Busy {
  return { start: at(day, "00:00", tz), end: at(addDays(day, 1), "00:00", tz) };
}

/** A meeting from `time` to `end` on `day`; without an end it is taken as 30 minutes. */
export function meetingStretch(day: string, time: string, end: string | undefined, tz: string): Busy {
  const start = at(day, time, tz);
  const stop = end ? at(day, end, tz) : start + 30 * MIN;
  return { start, end: stop > start ? stop : start + 30 * MIN };
}

/** True when two stretches overlap (no air). */
export const overlaps = (a: Busy, b: Busy): boolean => a.start < b.end && b.start < a.end;
