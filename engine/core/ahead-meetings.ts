// Meetings for Ahead (engine 0.39.0): read through the calendar flow for the range the window
// shows, kept in memory for 10 minutes and never stored. Without a calendar: none, no error.
// Part B reads these too, for the free slots (busy meetings block, those marked free do not).
import type { Engine } from "../engine.js";
import type { AheadMeetingRow } from "../../shared/protocol.js";
import { callFlow } from "./calendar-flow.js";
import { flowAddress } from "./calendar-settings.js";
import { toMeeting } from "./calendar.js";
import { addDays, dayOf, startOf, timeOf } from "./ahead-days.js";
import { iso } from "./words.js";

const KEEP_MS = 10 * 60 * 1000;
const READ_MAX_DAYS = 31;

export type MeetingsRead = { state: "none" } | { state: "problem" } | { state: "on"; rows: AheadMeetingRow[] };

interface Kept {
  at: number;
  read: Promise<MeetingsRead>;
}

const kept = new WeakMap<Engine, Map<string, Kept>>();

/** Forgets what was read, as after a calendar change made by a bot. */
export function forgetMeetings(eng: Engine): void {
  kept.delete(eng);
}

/** The meetings from the start of `from` to the end of `to` (YYYY-MM-DD, at most 31 days). */
export function aheadMeetings(eng: Engine, from: string, to: string): Promise<MeetingsRead> {
  const address = flowAddress(eng);
  if (!address) return Promise.resolve({ state: "none" });
  let map = kept.get(eng);
  if (!map) kept.set(eng, (map = new Map()));
  const key = `${address.length}:${from}:${to}`;
  const t = eng.clock();
  const had = map.get(key);
  if (had && t - had.at < KEEP_MS) return had.read;
  const read = readMeetings(eng, address, from, to);
  map.set(key, { at: t, read });
  // A failed read is not kept: the next look tries again.
  void read.then((r) => { if (r.state === "problem" && map!.get(key)?.read === read) map!.delete(key); });
  return read;
}

async function readMeetings(eng: Engine, address: string, from: string, to: string): Promise<MeetingsRead> {
  const last = addDays(from, READ_MAX_DAYS - 1) < to ? addDays(from, READ_MAX_DAYS - 1) : to;
  const start = startOf(from, eng.tz);
  const end = startOf(addDays(last, 1), eng.tz);
  const a = await callFlow(eng, address, "list", { start: iso(start), end: iso(end) });
  if (!a.ok) return { state: "problem" };
  const r = a.result as { value?: unknown } | undefined;
  const rows: AheadMeetingRow[] = [];
  for (const v of Array.isArray(r?.value) ? r.value : []) {
    const m = toMeeting(v);
    if (!m || m.cancelled) continue;
    const free = m.showAs === "free" ? { free: true as const } : {};
    if (m.allDay) {
      // An all-day meeting shows on each of its days inside the range.
      let day = dayOf(Math.max(m.start, start), eng.tz);
      const lastDay = dayOf(Math.min(m.end, end) - 1, eng.tz);
      for (let n = 0; day <= lastDay && n < READ_MAX_DAYS; n++, day = addDays(day, 1)) {
        rows.push({ source: "meeting", key: `meeting:${m.id}:${day}`, day, title: m.subject, allDay: true, ...free });
      }
      continue;
    }
    const day = dayOf(m.start, eng.tz);
    if (day < from || day > last) continue;
    const sameDay = dayOf(m.end - 1, eng.tz) === day;
    rows.push({
      source: "meeting",
      key: `meeting:${m.id}`,
      day,
      time: timeOf(m.start, eng.tz),
      ...(sameDay ? { end: timeOf(m.end, eng.tz) } : {}),
      title: m.subject,
      ...free,
    });
  }
  return { state: "on", rows };
}
