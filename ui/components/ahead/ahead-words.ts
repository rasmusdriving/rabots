// Words and days for Ahead (protocol 31). Days are YYYY-MM-DD in the engine's time zone, worked out
// as calendar days so the window's own zone never shifts them.
import type { AheadChange, AheadKind, AheadRow } from "../../../shared/protocol";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const KIND_WORD: Record<AheadKind, string> = {
  "will-do": "Will do",
  deadline: "Deadline",
  waiting: "Waiting",
  note: "Note",
  "your-time": "Your time",
};

const parts = (day: string) => day.split("-").map(Number) as [number, number, number];
const utc = (day: string) => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d));
};

export function addDays(day: string, n: number): string {
  const t = utc(day);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const weekdayOf = (day: string) => utc(day).getUTCDay();
export const weekdayName = (day: string) => WEEKDAYS[weekdayOf(day)]!;

export const changeWords = (change: AheadChange) => change.kind === "new" ? "New" : `Moved from ${weekdayName(change.from)}`;

/** "19 Nov". */
export function shortDate(day: string): string {
  const [, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Thursday 19 Nov". */
export function longDate(day: string): string {
  return `${weekdayName(day)} ${shortDate(day)}`;
}

/** The day's head: "Today", "Tomorrow", else the weekday. The date stands beside it. */
export function dayHead(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return weekdayName(day);
}

export const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));

/**
 * "Later", grouped: by week for the next eight weeks after the range ("Week of 7 Dec"), then by
 * month ("January 2027"). Groups in order, rows in order inside them.
 */
export function laterGroups(rows: AheadRow[], to: string): { key: string; title: string; rows: AheadRow[] }[] {
  const weeksUntil = addDays(mondayOf(to), 7 * 9);
  const groups = new Map<string, { key: string; title: string; rows: AheadRow[] }>();
  for (const r of rows) {
    let key: string;
    let title: string;
    if (r.day < weeksUntil) {
      key = `w${mondayOf(r.day)}`;
      title = `Week of ${shortDate(mondayOf(r.day))}`;
    } else {
      const [y, m] = parts(r.day);
      key = `m${y}-${m}`;
      title = `${MONTHS_LONG[m - 1]} ${y}`;
    }
    const g = groups.get(key) ?? { key, title, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function countWord(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
