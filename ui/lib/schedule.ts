// Schedules in plain words, and when one runs next. Used by the Triggers tab to say what a schedule
// means as it is being set, and by the mock engine to keep `nextAt`. Times are local, like the
// engine's. The engine is the source of truth for `nextAt`; the window only works it out itself to
// show a preview while a schedule is being edited.
import type { Schedule, Trigger, Weekday } from "../../shared/protocol";

export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WORK_DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const LONG: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Date.getDay() order, Sunday first. */
const BY_JS_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const dayShort = (d: Weekday) => SHORT[d];
export const dayLong = (d: Weekday) => LONG[d];
export const weekdayOf = (date: Date): Weekday => BY_JS_DAY[date.getDay()]!;

/** At least this many minutes between runs of an "every" schedule. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 24 * 60;

const pad = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const sorted = (days: Weekday[]) => WEEKDAYS.filter((d) => days.includes(d));

/** "07:30" to minutes after midnight. Null when it is not a time. */
export function minutesOf(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Reads a time the way people type it: "7", "730", "0730", "7:30", "7.30", "07:30". Returns
 * "HH:MM", or null when it is not a time.
 */
export function readTime(text: string): string | null {
  const t = text.trim().replace(/[.,h]/g, ":");
  let h: number;
  let m: number;
  const colon = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  const digits = /^\d{1,4}$/.test(t) ? t : null;
  if (colon) {
    h = Number(colon[1]);
    m = Number(colon[2]);
    if (colon[2]!.length === 1) m *= 10;
  } else if (digits) {
    if (digits.length <= 2) {
      h = Number(digits);
      m = 0;
    } else {
      h = Number(digits.slice(0, -2));
      m = Number(digits.slice(-2));
    }
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** "every day", "weekdays", "weekends", "Fridays", "Mon, Wed and Fri". Lower case except day names. */
export function daysWords(days: Weekday[]): string {
  const d = sorted(days);
  if (d.length === 7) return "every day";
  if (d.length === 5 && WORK_DAYS.every((x) => d.includes(x))) return "weekdays";
  if (d.length === 2 && d.includes("sat") && d.includes("sun")) return "weekends";
  if (d.length === 1) return `${LONG[d[0]!]}s`;
  const names = d.map((x) => SHORT[x]);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const downFirst = (s: string) => (/^(Every|Weekdays|Weekends|Once|When)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** "Every 30 minutes", "Every hour", "Every 2 hours". */
export function everyWords(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

/** "Friday 14 Nov". */
export function dateWords(d: Date): string {
  return `${LONG[weekdayOf(d)]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** When a schedule runs, in plain words: "Weekdays at 07:30", "Every 30 minutes, 08:00 to 17:00, weekdays". */
export function scheduleWords(s: Schedule): string {
  switch (s.type) {
    case "daily":
      return `${upFirst(daysWords(s.days))} at ${s.time}`;
    case "every": {
      const parts = [everyWords(s.minutes)];
      if (s.from && s.to) parts.push(`${s.from} to ${s.to}`);
      else if (s.from) parts.push(`from ${s.from}`);
      else if (s.to) parts.push(`until ${s.to}`);
      if (sorted(s.days).length < 7) parts.push(daysWords(s.days));
      return parts.join(", ");
    }
    case "once": {
      const d = new Date(s.at);
      if (Number.isNaN(d.getTime())) return "Once";
      return `Once on ${dateWords(d)} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
}

/** When a trigger runs, in plain words. A webhook: "When its address is called". */
export function triggerWhen(t: Pick<Trigger, "kind" | "schedule">): string {
  if (t.kind === "webhook" || !t.schedule) return "When its address is called";
  return scheduleWords(t.schedule);
}

/** "today 16:30", "tomorrow 07:30", "Friday 13:00", "Mon 24 Nov 13:00". */
export function nextWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `today ${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `tomorrow ${hm}`;
  const inAWeek = new Date(now);
  inAWeek.setDate(now.getDate() + 6);
  inAWeek.setHours(23, 59, 59, 999);
  if (d <= inAWeek) return `${LONG[weekdayOf(d)]} ${hm}`;
  return `${SHORT[weekdayOf(d)]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** The day `n` days from `from`, at hh:mm local time. Invalid local times move forward, as the engine does. */
function at(from: Date, n: number, minutes: number): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n, 0, 0, 0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** The first time after `after` that a schedule runs, or null when it never runs again. */
export function nextRun(s: Schedule, after = new Date()): Date | null {
  switch (s.type) {
    case "once": {
      const d = new Date(s.at);
      return !Number.isNaN(d.getTime()) && d > after ? d : null;
    }
    case "daily": {
      const time = minutesOf(s.time);
      if (time === null || s.days.length === 0) return null;
      for (let n = 0; n <= 7; n++) {
        const d = at(after, n, time);
        if (s.days.includes(weekdayOf(d)) && d > after) return d;
      }
      return null;
    }
    case "every": {
      if (s.days.length === 0 || s.minutes < 1) return null;
      const start = s.from ? minutesOf(s.from) : 0;
      const end = s.to ? minutesOf(s.to) : 24 * 60 - 1;
      if (start === null || end === null || end < start) return null;
      for (let n = 0; n <= 7; n++) {
        const day = at(after, n, 0);
        if (!s.days.includes(weekdayOf(day))) continue;
        for (let m = start; m <= end; m += s.minutes) {
          const d = at(after, n, m);
          if (d > after) return d;
        }
      }
      return null;
    }
  }
}

/** Why a schedule cannot be saved, in one plain sentence, or null when it is fine. */
export function scheduleProblem(s: Schedule, now = new Date()): string | null {
  switch (s.type) {
    case "daily":
      if (minutesOf(s.time) === null) return "Write a time like 07:30.";
      if (s.days.length === 0) return "Choose at least one day.";
      return null;
    case "every":
      if (!Number.isInteger(s.minutes) || s.minutes < MIN_EVERY_MINUTES) return `Runs must be at least ${MIN_EVERY_MINUTES} minutes apart.`;
      if (s.minutes > MAX_EVERY_MINUTES) return "Choose at most 24 hours between runs.";
      if (s.days.length === 0) return "Choose at least one day.";
      if ((s.from && minutesOf(s.from) === null) || (s.to && minutesOf(s.to) === null)) return "Write a time like 07:30.";
      if (s.from && s.to && minutesOf(s.to)! <= minutesOf(s.from)!) return "The end time must come after the start time.";
      return null;
    case "once": {
      const d = new Date(s.at);
      if (Number.isNaN(d.getTime())) return "Choose a date and a time.";
      if (d <= now) return "That time has passed. Choose a later one.";
      return null;
    }
  }
}

/**
 * The sentence under the schedule controls: "Runs weekdays at 07:30. Next: tomorrow 07:30".
 * Says the problem instead when there is one.
 */
export function scheduleSentence(s: Schedule, now = new Date(), off = false): { text: string; problem: boolean } {
  // A trigger that is switched off never promises a next run, and a "once" that has had its time is not a mistake.
  if (off && s.type === "once" && new Date(s.at) <= now) return { text: "This time has passed and the trigger is switched off. Choose a later time to run it again.", problem: false };
  const problem = scheduleProblem(s, now);
  if (problem) return { text: problem, problem: true };
  const words = `Runs ${downFirst(scheduleWords(s))}.`;
  if (off) return { text: `${words} It is switched off, so it will not run.`, problem: false };
  if (s.type === "once") return { text: `${words} Then it switches itself off.`, problem: false };
  const next = nextRun(s, now);
  return { text: next ? `${words} Next: ${nextWords(next.toISOString(), now)}` : words, problem: false };
}

/** "2026-11-14" for a local date. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A local date ("2026-11-14") and time ("13:00") as an ISO time. */
export function localIso(date: string, time: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const mins = minutesOf(time) ?? 0;
  return new Date(y!, mo! - 1, d!, Math.floor(mins / 60), mins % 60, 0, 0).toISOString();
}
