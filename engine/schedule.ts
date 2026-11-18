// When a schedule fires, in the machine's own time zone (or a named one, for tests), and plain
// words for schedules and times. Pure functions: the clock is always passed in.
//
// Daylight saving: every schedule time is a wall-clock time. A time that does not exist on the day
// the clocks go forward (02:30) fires at the first minute after the gap (03:00). A time that happens
// twice on the day the clocks go back fires once, at the first of the two.
import type { Schedule, Weekday } from "../shared/protocol.js";

/** Index is the day number of Date.getUTCDay(). */
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MIN = 60_000;
const HOUR = 60 * MIN;

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A wall-clock moment in a time zone. `mo` is 0 to 11, `wd` is 0 (Sunday) to 6. */
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  wd: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

export function wallOf(t: number, tz: string): Wall {
  const parts = formatter(tz).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const y = get("year");
  const mo = get("month") - 1;
  const d = get("day");
  return { y, mo, d, h: get("hour") % 24, mi: get("minute"), wd: new Date(Date.UTC(y, mo, d)).getUTCDay() };
}

const keyOf = (y: number, mo: number, d: number, h: number, mi: number) => (((y * 100 + mo) * 100 + d) * 100 + h) * 100 + mi;
const wallKey = (t: number, tz: string) => {
  const w = wallOf(t, tz);
  return keyOf(w.y, w.mo, w.d, w.h, w.mi);
};

function offsetAt(t: number, tz: string): number {
  const w = wallOf(t, tz);
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - Math.floor(t / MIN) * MIN;
}

/**
 * The instant a wall-clock time happens in a time zone. When it happens twice, the first one.
 * When it does not happen (the clocks jumped over it), the first minute after the jump.
 */
export function instantFor(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const want = keyOf(y, mo, d, h, mi);
  const utc = Date.UTC(y, mo, d, h, mi);
  const candidates = new Set<number>();
  for (const probe of [utc - 36 * HOUR, utc, utc + 36 * HOUR]) candidates.add(utc - offsetAt(probe, tz));
  const exact = [...candidates].filter((t) => wallKey(t, tz) === want).sort((a, b) => a - b);
  if (exact.length) return exact[0]!;
  let t = Math.min(...candidates);
  for (let i = 0; i < 48 * 60 && wallKey(t, tz) < want; i++) t += MIN;
  return t;
}

/** "07:30" to minutes after midnight, or undefined when it is not a time. */
export function parseHm(s: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The first time strictly after `after` that the schedule fires, or undefined when it never will. */
export function nextAfter(s: Schedule, after: number, tz: string): number | undefined {
  if (s.type === "once") {
    const t = Date.parse(s.at);
    return Number.isFinite(t) && t > after ? t : undefined;
  }
  const days = new Set(s.days);
  if (!days.size) return undefined;
  const start = wallOf(after, tz);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(start.y, start.mo, start.d + i));
    if (!days.has(WEEKDAYS[date.getUTCDay()]!)) continue;
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth();
    const d = date.getUTCDate();
    if (s.type === "daily") {
      const m = parseHm(s.time);
      if (m === undefined) return undefined;
      const t = instantFor(y, mo, d, Math.floor(m / 60), m % 60, tz);
      if (t > after) return t;
      continue;
    }
    const step = Math.floor(s.minutes);
    if (!(step >= 1)) return undefined;
    const from = s.from ? parseHm(s.from) ?? 0 : 0;
    const to = s.to ? parseHm(s.to) ?? 24 * 60 - 1 : 24 * 60 - 1;
    // Start a little before the current minute: the wall clock and elapsed time differ by up to two hours on daylight saving days.
    let k = i === 0 ? Math.max(0, Math.floor((start.h * 60 + start.mi - 120 - from) / step)) : 0;
    for (; from + k * step <= to; k++) {
      const w = from + k * step;
      const t = instantFor(y, mo, d, Math.floor(w / 60), w % 60, tz);
      if (t > after) return t;
    }
  }
  return undefined;
}

/** The latest time at or before `now` that the schedule fired or should have, starting from `due`. */
export function lastDue(s: Schedule, due: number, now: number, tz: string): number {
  if (s.type === "once") return due;
  let last = due;
  for (let i = 0; i < 100_000; i++) {
    const n = nextAfter(s, last, tz);
    if (n === undefined || n > now) break;
    last = n;
  }
  return last;
}

// ------------------------------------------------------------ words

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "every day", "weekdays", "weekends", "Monday and Friday". */
export function daysWords(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size === 7) return "every day";
  if (set.size === 5 && ["mon", "tue", "wed", "thu", "fri"].every((d) => set.has(d as Weekday))) return "weekdays";
  if (set.size === 2 && set.has("sat") && set.has("sun")) return "weekends";
  return list(ORDER.filter((d) => set.has(d)).map((d) => DAY_NAMES[d]));
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function everyWords(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** A schedule in plain words: "Weekdays at 07:30", "Every 30 minutes, 08:00 to 17:00, weekdays", "Once on 14 Nov 2026 at 13:00". */
export function describeSchedule(s: Schedule, tz: string): string {
  if (s.type === "daily") return `${capital(daysWords(s.days))} at ${s.time}`;
  if (s.type === "every") {
    const parts = [capital(everyWords(s.minutes))];
    if (s.from && s.to) parts.push(`${s.from} to ${s.to}`);
    else if (s.from) parts.push(`from ${s.from}`);
    else if (s.to) parts.push(`until ${s.to}`);
    if (new Set(s.days).size !== 7) parts.push(daysWords(s.days));
    return parts.join(", ");
  }
  const t = Date.parse(s.at);
  if (!Number.isFinite(t)) return "Once";
  const w = wallOf(t, tz);
  return `Once on ${w.d} ${MONTHS[w.mo]} ${w.y} at ${hm(w.h * 60 + w.mi)}`;
}

/** When something happens, from the point of view of `now`: "today 16:30", "tomorrow 07:30", "Friday 13:00", "21 Nov 13:00". */
export function whenWords(t: number, now: number, tz: string): string {
  const a = wallOf(t, tz);
  const b = wallOf(now, tz);
  const days = Math.round((Date.UTC(a.y, a.mo, a.d) - Date.UTC(b.y, b.mo, b.d)) / (24 * HOUR));
  const time = hm(a.h * 60 + a.mi);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days > 1 && days < 7) return `${DAY_NAMES[WEEKDAYS[a.wd]!]} ${time}`;
  return `${a.d} ${MONTHS[a.mo]}${a.y !== b.y ? ` ${a.y}` : ""} ${time}`;
}

/** "at 07:30" when it is the same day as `now`, else "on Tuesday at 07:30" or "on 3 Nov at 07:30". */
export function atWords(t: number, now: number, tz: string): string {
  const a = wallOf(t, tz);
  const b = wallOf(now, tz);
  const time = hm(a.h * 60 + a.mi);
  const days = Math.round((Date.UTC(b.y, b.mo, b.d) - Date.UTC(a.y, a.mo, a.d)) / (24 * HOUR));
  if (days === 0) return `at ${time}`;
  if (days > 0 && days < 7) return `on ${DAY_NAMES[WEEKDAYS[a.wd]!]} at ${time}`;
  return `on ${a.d} ${MONTHS[a.mo]} at ${time}`;
}

/** "Tuesday 11 Nov 2026 14:05". */
export function nowWords(now: number, tz: string): string {
  const w = wallOf(now, tz);
  return `${DAY_NAMES[WEEKDAYS[w.wd]!]} ${w.d} ${MONTHS[w.mo]} ${w.y} ${hm(w.h * 60 + w.mi)}`;
}
