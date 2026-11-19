// Days for Ahead (engine 0.39.0): YYYY-MM-DD and HH:MM in the engine's time zone. Pure functions.
import { instantFor, wallOf } from "../schedule.js";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The day `t` falls on in `tz`. */
export function dayOf(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}`;
}

/** The time of day `t` shows in `tz`, HH:MM. */
export function timeOf(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

export function isDay(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const c = new Date(Date.UTC(y, mo, d));
  return c.getUTCFullYear() === y && c.getUTCMonth() === mo && c.getUTCDate() === d;
}

export function isTime(s: unknown): s is string {
  return typeof s === "string" && TIME.test(s);
}

/** `day` plus `n` days (calendar days, no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const c = new Date(Date.UTC(y, mo - 1, d + n));
  return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}`;
}

/** 0 Sunday to 6 Saturday. */
export function weekdayOf(day: string): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** The Monday of the week `day` is in. */
export function mondayOf(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** The start of `day` in `tz`, as a time. */
export function startOf(day: string, tz: string): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return instantFor(y, mo - 1, d, 0, 0, tz);
}

/** "Thursday 19 Nov". */
export function dayWords(day: string): string {
  const [, mo, d] = day.split("-").map(Number) as [number, number, number];
  return `${WEEKDAYS[weekdayOf(day)]} ${d} ${MONTHS[mo - 1]}`;
}
