// Times for the calendar tools (engine 0.25.0, docs/build/step-calendar.md): reading the times a bot
// gives, the times Microsoft Graph sends back, words for people, and the free-time sums. Pure
// functions, so the tests can work them through without a flow.
import { graphZone } from "./calendar-zones.js";
import { instantFor, wallOf } from "./schedule.js";

export interface Span {
  start: number;
  end: number;
}

const MIN = 60_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Working hours for free times: weekdays 08:00 to 17:00 in the engine's time zone. */
export const WORK_START_MIN = 8 * 60;
export const WORK_END_MIN = 17 * 60;

/**
 * A time a bot gives: "2026-11-18" (the start of that day), "2026-11-18T10:00" (wall time in `tz`),
 * or with an offset or Z. Undefined when it is not a time. `dateOnly` says the first form was used.
 */
export function parseWhen(raw: string, tz: string): { t: number; dateOnly: boolean } | undefined {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (m) {
    const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
    if (mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined;
    const check = new Date(Date.UTC(y, mo, d));
    if (check.getUTCMonth() !== mo) return undefined;
    return { t: instantFor(y, mo, d, h, mi, tz), dateOnly: m[4] === undefined };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? { t, dateOnly: false } : undefined;
}

/**
 * A time for Graph. With `tz`: the wall time in that zone and the zone's name as Outlook knows it
 * (fix 0.26.1), so a meeting made or moved by a bot stands in the person's own zone and Outlook shows
 * no "(UTC)" on it; Graph works out summer and winter time itself from the wall time and the zone.
 * Without `tz`, or for a zone Graph does not take: wall time in UTC (what free-time lookups send, and
 * what `Prefer: outlook.timezone="UTC"` reads back).
 */
export function graphTime(t: number, tz?: string): { dateTime: string; timeZone: string } {
  const whole = Math.floor(t / 1000) * 1000;
  const zone = tz ? graphZone(tz) : undefined;
  if (!tz || !zone || zone === "UTC") return { dateTime: new Date(whole).toISOString().slice(0, 19), timeZone: "UTC" };
  const w = wallOf(whole, tz);
  const sec = new Date(whole).getUTCSeconds();
  return { dateTime: `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(sec)}`, timeZone: zone };
}

/** A time Graph sent: { dateTime, timeZone }. The flow asks for UTC; a time without a zone is taken as UTC. */
export function fromGraph(v: unknown): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { dateTime?: unknown; timeZone?: unknown };
  if (typeof o.dateTime !== "string") return undefined;
  const dt = o.dateTime.trim();
  const zone = typeof o.timeZone === "string" ? o.timeZone : "UTC";
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(dt)) {
    const t = Date.parse(dt);
    return Number.isFinite(t) ? t : undefined;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dt);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (/^(utc|gmt|etc\/utc|coordinated universal time)$/i.test(zone)) return Date.UTC(y, mo, d, h, mi, sec);
  try {
    return instantFor(y, mo, d, h, mi, zone) + sec * 1000;
  } catch {
    // A Windows zone name Node does not know: taken as UTC, which is what the flow asks for anyway.
    return Date.UTC(y, mo, d, h, mi, sec);
  }
}

/** "Wed 18 Nov 10:00" in `tz`. */
export function dayTime(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${DAY_NAMES[w.wd]} ${w.d} ${MONTHS[w.mo]} ${pad(w.h)}:${pad(w.mi)}`;
}

/** "Wed 18 Nov 10:00 to 10:30", or "Wed 18 Nov 10:00 to Thu 19 Nov 09:00" across days. */
export function spanWords(start: number, end: number, tz: string): string {
  const a = wallOf(start, tz);
  const b = wallOf(end, tz);
  const sameDay = a.y === b.y && a.mo === b.mo && a.d === b.d;
  return `${dayTime(start, tz)} to ${sameDay ? `${pad(b.h)}:${pad(b.mi)}` : dayTime(end, tz)}`;
}

/** A local wall time a bot can pass back as it stands: "2026-11-18T10:00". */
export function localIso(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
export function minutesWords(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ") || "0 minutes";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The start of the day `t` falls on, in `tz`. */
export function dayStart(t: number, tz: string): number {
  const w = wallOf(t, tz);
  return instantFor(w.y, w.mo, w.d, 0, 0, tz);
}

/** The start of the next day after the day `t` falls on, in `tz`. */
export function nextDay(t: number, tz: string): number {
  const w = wallOf(t, tz);
  const n = new Date(Date.UTC(w.y, w.mo, w.d + 1));
  return instantFor(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, tz);
}

/** The working window of the day that starts at `day` (a day start), or undefined on a weekend. */
function workWindow(day: number, tz: string): Span | undefined {
  const w = wallOf(day, tz);
  if (w.wd === 0 || w.wd === 6) return undefined;
  return { start: instantFor(w.y, w.mo, w.d, WORK_START_MIN / 60, WORK_START_MIN % 60, tz), end: instantFor(w.y, w.mo, w.d, WORK_END_MIN / 60, WORK_END_MIN % 60, tz) };
}

/** True when two spans overlap (touching ends do not). */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Rounds up to the next whole `step` minutes after the hour. */
function roundUp(t: number, step: number): number {
  const s = step * MIN;
  return Math.ceil(t / s) * s;
}

/**
 * The free ranges within working hours between `from` and `to` where a meeting of `minutes` fits,
 * given everyone's busy spans together. Starts are rounded up to the quarter hour. At most `max`.
 */
export function freeRanges(busy: Span[], o: { from: number; to: number; minutes: number; tz: string; max: number }): Span[] {
  const need = o.minutes * MIN;
  const sorted = [...busy].filter((b) => b.end > o.from && b.start < o.to).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (let day = dayStart(o.from, o.tz); day < o.to && out.length < o.max; day = nextDay(day, o.tz)) {
    const win = workWindow(day, o.tz);
    if (!win) continue;
    let cursor = roundUp(Math.max(win.start, o.from), 15);
    const stop = Math.min(win.end, o.to);
    for (const b of sorted) {
      if (b.end <= cursor) continue;
      if (b.start >= stop) break;
      if (b.start - cursor >= need) out.push({ start: cursor, end: Math.min(b.start, stop) });
      cursor = Math.max(cursor, roundUp(b.end, 15));
      if (out.length >= o.max) break;
    }
    if (out.length < o.max && stop - cursor >= need) out.push({ start: cursor, end: stop });
  }
  return out.slice(0, o.max);
}

/**
 * Up to `max` start times to suggest after a clash: the start of each free range on the wanted day
 * and the next working day, and, when that gives too few, later starts in the same ranges.
 */
/** The start of the day after the next working day after the day of `t`: the end of what a clash check reads. */
export function afterNextWorkDay(t: number, tz: string): number {
  let day = nextDay(dayStart(t, tz), tz);
  for (let i = 0; i < 7 && !workWindow(day, tz); i++) day = nextDay(day, tz);
  return nextDay(day, tz);
}

export function suggestTimes(busy: Span[], o: { wanted: number; minutes: number; now: number; tz: string; max: number }): number[] {
  const first = dayStart(o.wanted, o.tz);
  const ranges = freeRanges(busy, { from: Math.max(first, o.now), to: afterNextWorkDay(o.wanted, o.tz), minutes: o.minutes, tz: o.tz, max: 20 });
  const starts: number[] = ranges.map((r) => r.start);
  for (const r of ranges) {
    for (let t = r.start + 60 * MIN; t + o.minutes * MIN <= r.end && starts.length < o.max * 3; t += 60 * MIN) starts.push(t);
  }
  // The ones nearest the wanted time first, then in time order.
  return [...new Set(starts)]
    .sort((a, b) => Math.abs(a - o.wanted) - Math.abs(b - o.wanted))
    .slice(0, o.max)
    .sort((a, b) => a - b);
}
