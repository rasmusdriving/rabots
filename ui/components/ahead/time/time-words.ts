// Words and the clock for "your time" rows (Ahead part B, protocol 31).
import { useEffect, useState } from "react";
import type { AheadItem } from "../../../../shared/protocol";

const pad = (n: number) => String(n).padStart(2, "0");
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** The end of a slot, HH:MM (on the same day; past midnight it stops at 24:00). */
export function endOf(time: string, minutes: number): string {
  const end = Math.min(24 * 60, minutesOf(time) + minutes);
  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

/** "30 min", "1 h 30 min". */
export function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Placed after its latest day. */
export const isLate = (i: AheadItem) => !!i.latestBy && i.day > i.latestBy;

const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * True while the slot runs. Worked out from this window's clock each half minute, and only on the
 * engine's today (so a window in another time zone shows no "Now" rather than a wrong one).
 */
export function useRunning(item: AheadItem, today: string): boolean {
  const watch = item.state === "open" && item.kind === "your-time" && !!item.time && item.day === today;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!watch) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [watch]);
  if (!watch) return false;
  const now = new Date();
  if (localDay(now) !== today) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(item.time!);
  return at >= start && at < start + (item.minutes ?? 30);
}
