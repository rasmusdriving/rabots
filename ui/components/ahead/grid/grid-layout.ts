// The Week grid's layout as pure functions (docs/build/step-ahead-redesign.md): which hours the grid
// shows, where a row stands in a day, and how rows at the same time share the width. Everything is
// worked out in minutes of the day and handed on as fractions of the grid, so the window lays the
// grid out in percent and never measures it. No imports at run time: `npm test` reads this file as it is.
import type { AheadRow } from "../../../../shared/protocol";

/** A drag snaps to this many minutes. */
export const SNAP = 15;
/** A short meeting is drawn as at least this long, so its one line can be read. */
export const MIN_MEETING = 15;
/** A bot's thing at a point in time (a run, a timed to-do or item) is drawn as this long. */
export const MIN_BOT = 20;
/** Things at the same time stand side by side up to this many; the rest fold into "+2". */
export const MAX_COLS = 3;
/** How much wider a column with a bot's thing in it is than a column of meetings. */
export const LOUD_WIDTH = 1.5;
/** The lines of the strip on top of a day (things with no time, all-day meetings); on a phone's Day. */
export const STRIP_LINES = 4;
export const STRIP_LINES_PHONE = 3;

const DAY = 24 * 60;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + (m || 0);
}

export function timeOf(minutes: number): string {
  const m = Math.max(0, Math.min(DAY, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export interface GridRange {
  /** Minutes of the day, on whole hours. */
  start: number;
  end: number;
}

/** The hours the grid shows: the working hours, widened to whole hours. 08:00 to 17:00 when they make no day. */
export function gridRange(workStart: string, workEnd: string): GridRange {
  const start = Math.floor(minutesOf(workStart) / 60) * 60;
  const end = Math.min(DAY, Math.ceil(minutesOf(workEnd) / 60) * 60);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : { start: 8 * 60, end: 17 * 60 };
}

export const hoursOf = (range: GridRange) => (range.end - range.start) / 60;

/** Where a row stands in its day, in minutes. Undefined for a row with no time (the strip). */
export function stretchOf(row: AheadRow): { start: number; end: number } | undefined {
  if (!row.time) return undefined;
  const start = minutesOf(row.time);
  let end = start;
  // A meeting with no end on its day runs past midnight.
  if (row.source === "meeting") end = row.end ? minutesOf(row.end) : DAY;
  else if (row.source === "item" && row.item.kind === "your-time") end = start + (row.item.minutes ?? 30);
  const least = row.source === "meeting" ? MIN_MEETING : MIN_BOT;
  return { start, end: Math.min(DAY, Math.max(end, start + least)) };
}

export interface Placed {
  row: AheadRow;
  /** Minutes, cut to the grid's hours. */
  start: number;
  end: number;
  /** Fractions of the grid's height. */
  top: number;
  height: number;
  /** Its column among those it shares the time with, how many there are, and how many it spans. */
  col: number;
  cols: number;
  span: number;
  /** Fractions of the day's width. A column with a bot's thing in it is wider than one with only meetings (LOUD_WIDTH). */
  left: number;
  width: number;
}

/** What did not fit side by side: one "+2" in the last column. */
export interface Folded {
  rows: AheadRow[];
  top: number;
  height: number;
  col: number;
  cols: number;
  left: number;
  width: number;
}

export interface DayLayout {
  blocks: Placed[];
  folded: Folded[];
  /** Wholly before the grid's first hour, and at or after its last. */
  before: AheadRow[];
  after: AheadRow[];
  /** No time at all: the strip on top. */
  untimed: AheadRow[];
}

const meetingFirst = (r: AheadRow) => (r.source === "meeting" ? 0 : 1);

/** Lays out one day's rows. Rows are told apart by `key`, so the same row twice is two things. */
export function placeDay(rows: AheadRow[], range: GridRange): DayLayout {
  const out: DayLayout = { blocks: [], folded: [], before: [], after: [], untimed: [] };
  const span = range.end - range.start;
  const timed: { row: AheadRow; start: number; end: number }[] = [];
  for (const row of rows) {
    const s = stretchOf(row);
    if (!s) out.untimed.push(row);
    else if (s.end <= range.start) out.before.push(row);
    else if (s.start >= range.end) out.after.push(row);
    else {
      const start = Math.max(s.start, range.start);
      // What begins in the last minutes of the day still gets its one line.
      const end = Math.min(range.end, Math.max(s.end, start + MIN_MEETING));
      timed.push({ row, start: Math.min(start, end - MIN_MEETING), end });
    }
  }
  timed.sort((a, b) => a.start - b.start || meetingFirst(a.row) - meetingFirst(b.row) || b.end - a.end || a.row.key.localeCompare(b.row.key));

  const frac = (m: number) => (m - range.start) / span;
  let i = 0;
  while (i < timed.length) {
    // A cluster: everything that overlaps something else in it, directly or through others.
    let until = timed[i]!.end;
    let j = i + 1;
    while (j < timed.length && timed[j]!.start < until) {
      until = Math.max(until, timed[j]!.end);
      j++;
    }
    const cluster = timed.slice(i, j);
    i = j;
    // Each takes the first column that is free at its start.
    const ends: number[] = [];
    const at = cluster.map((e) => {
      let col = ends.findIndex((end) => end <= e.start);
      if (col < 0) col = ends.length;
      ends[col] = e.end;
      return col;
    });
    const wanted = ends.length;
    const cols = Math.min(wanted, MAX_COLS);
    const keep = wanted > MAX_COLS ? MAX_COLS - 1 : wanted;
    const shown = cluster.map((e, n) => ({ ...e, col: at[n]! })).filter((e) => e.col < keep);
    const rest = cluster.filter((_, n) => at[n]! >= keep);
    // What is folded, as stretches of the last column.
    const folds: { rows: AheadRow[]; start: number; end: number }[] = [];
    for (const e of rest) {
      const last = folds.at(-1);
      if (last && e.start < last.end) {
        last.rows.push(e.row);
        last.end = Math.max(last.end, e.end);
      } else folds.push({ rows: [e.row], start: e.start, end: e.end });
    }
    const taken = (col: number, start: number, end: number) =>
      shown.some((o) => o.col === col && o.start < end && o.end > start) || (col === cols - 1 && folds.some((f) => f.start < end && f.end > start));
    // The bots' things are what the screen is for: their column is wider than a column of meetings.
    const weight = Array.from({ length: cols }, (_, c) => (shown.some((o) => o.col === c && o.row.source !== "meeting") ? LOUD_WIDTH : 1));
    const total = weight.reduce((a, b) => a + b, 0);
    const across = (from: number, to: number) => weight.slice(from, to).reduce((a, b) => a + b, 0) / total;
    for (const e of shown) {
      let wide = 1;
      while (e.col + wide < cols && !taken(e.col + wide, e.start, e.end)) wide++;
      out.blocks.push({ row: e.row, start: e.start, end: e.end, top: frac(e.start), height: frac(e.end) - frac(e.start), col: e.col, cols, span: wide, left: across(0, e.col), width: across(e.col, e.col + wide) });
    }
    for (const f of folds) out.folded.push({ rows: f.rows, top: frac(f.start), height: frac(f.end) - frac(f.start), col: cols - 1, cols, left: across(0, cols - 1), width: across(cols - 1, cols) });
  }
  return out;
}

export interface Strip {
  /** The bots' things first, then the all-day meetings. */
  shown: AheadRow[];
  /** How many do not fit: "2 more". */
  hidden: number;
  /** There is room for each of the bots' things to take two lines, so its title can be read. */
  tall: boolean;
}

/** What the strip on top of a day shows in its fixed lines. `earlier`: the "From earlier" chip takes the first line. */
export function stripOf(untimed: AheadRow[], earlier: boolean, lines = STRIP_LINES, twoLines = true): Strip {
  const loud = untimed.filter((r) => r.source !== "meeting");
  const rows = [...loud, ...untimed.filter((r) => r.source === "meeting")];
  const taken = rows.length + (earlier ? 1 : 0);
  if (twoLines && loud.length > 0 && taken + loud.length <= lines) return { shown: rows, hidden: 0, tall: true };
  if (taken <= lines) return { shown: rows, hidden: 0, tall: false };
  const shown = rows.slice(0, Math.max(0, lines - (earlier ? 1 : 0) - 1));
  return { shown, hidden: rows.length - shown.length, tall: false };
}

/** The time a drop at this fraction of the grid means: snapped, and kept inside the grid. */
export function snapTime(fraction: number, range: GridRange, minutes = SNAP): string {
  const raw = range.start + fraction * (range.end - range.start);
  const last = Math.max(range.start, range.end - Math.max(SNAP, Math.ceil(minutes / SNAP) * SNAP));
  return timeOf(Math.max(range.start, Math.min(last, Math.round(raw / SNAP) * SNAP)));
}
