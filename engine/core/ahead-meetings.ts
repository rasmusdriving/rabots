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

/** One event as read, for following a to-do's block moved or deleted in Outlook (engine 0.41.0). */
export interface ReadEvent {
  id: string;
  subject: string;
  start: number;
  end: number;
  allDay: boolean;
}

/**
 * The meetings in a range. `events` are every event read (before leaving any out), `startedAt` when
 * the read started and `start`/`end` the instants it covered: the to-do blocks follow Outlook from
 * them (todo-block-sync.ts). The rows leave out the events of to-do blocks: those show as their block.
 */
export type MeetingsRead =
  | { state: "none" }
  | { state: "problem" }
  | { state: "on"; rows: AheadMeetingRow[]; events: ReadEvent[]; startedAt: number; start: number; end: number; coveredTo: number };

interface Kept {
  at: number;
  read: Promise<MeetingsRead>;
}

const kept = new WeakMap<Engine, Map<string, Kept>>();

/** Forgets what was read, as after a calendar change made by a bot. */
export function forgetMeetings(eng: Engine): void {
  kept.delete(eng);
}

/** The meetings from the start of `from` to the end of `to` (YYYY-MM-DD, at most 31 days), without the to-do blocks' own events. */
export function aheadMeetings(eng: Engine, from: string, to: string): Promise<MeetingsRead> {
  return keptRead(eng, from, to).then((r) => withoutBlocks(eng, r));
}

/** The event ids of the to-do blocks, kept or once kept, so their events never show as a grey meeting beside them. */
export function blockEventIds(eng: Engine): Set<string> {
  const ids = new Set<string>();
  for (const i of eng.store.ahead.blocks()) if (i.outlook?.eventId) ids.add(i.outlook.eventId);
  return ids;
}

function withoutBlocks(eng: Engine, r: MeetingsRead): MeetingsRead {
  if (r.state !== "on") return r;
  const ids = blockEventIds(eng);
  if (!ids.size) return r;
  // Row keys are "meeting:<id>" or, for an all-day one, "meeting:<id>:<day>"; Graph ids hold no ":".
  return { ...r, rows: r.rows.filter((m) => !ids.has(m.key.slice("meeting:".length).split(":")[0]!)) };
}

function keptRead(eng: Engine, from: string, to: string): Promise<MeetingsRead> {
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
  const startedAt = eng.clock();
  const a = await callFlow(eng, address, "list", { start: iso(start), end: iso(end) });
  if (!a.ok) return { state: "problem" };
  const r = a.result as { value?: unknown } | undefined;
  const rows: AheadMeetingRow[] = [];
  const events: ReadEvent[] = [];
  for (const v of Array.isArray(r?.value) ? r.value : []) {
    const m = toMeeting(v);
    if (!m || m.cancelled) continue;
    events.push({ id: m.id, subject: m.subject, start: m.start, end: m.end, allDay: m.allDay });
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
  // The flow reads at most 100 events; with more, it says where the next ones are and the read ends at the last one it holds.
  const more = typeof (r as Record<string, unknown> | undefined)?.["@odata.nextLink"] === "string";
  const coveredTo = more && events.length ? Math.max(...events.map((e) => e.start)) : end;
  return { state: "on", rows, events, startedAt, start, end, coveredTo };
}
