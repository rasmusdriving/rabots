// To-do blocks in Outlook (engine 0.41.0, docs/build/step-todo-blocks.md). One function keeps each
// to-do's block in the person's calendar in step with its Ahead item: it runs after every change to
// Ahead's items (aheadItemsChanged), one run at a time, and compares what each block should be with
// what Pobots last wrote (AheadItem.outlook).
//
//   open, never made          create (only while the switch is on, and once per change of the block)
//   open, at another time     move
//   closed, start still ahead delete; begun or past stays in Outlook as a record of the time
//
// A create that may have happened (no answer in time, Outlook failed) is "unsure": before trying
// again Pobots looks for an event with the same subject at that time and keeps it. One that did not
// happen is "failed": tried again at the block's next change. Never more than one try per change.
//
// It also follows Outlook (followOutlook, at every meetings read for Ahead): a kept event at a new
// time moves the block to it; one missing from the read is looked up by id, and when Outlook says it
// is not there the block is removed and never made again. A read that started before Pobots' own
// last write to that event is not followed.
import type { Engine } from "../engine.js";
import type { AheadItem, AheadOutlook } from "../../shared/protocol.js";
import { log } from "../log.js";
import { callFlow } from "./calendar-flow.js";
import { flowAddress } from "./calendar-settings.js";
import { htmlBody, toMeeting } from "./calendar.js";
import { graphTime } from "../calendar-time.js";
import { forgetMeetings, type MeetingsRead } from "./ahead-meetings.js";
import { stretchOf } from "./ahead-slots.js";
import { aheadSettings } from "./ahead-settings.js";
import { dayOf, dayWords, timeOf } from "./ahead-days.js";
import { tellBot } from "./ahead-news.js";
import { iso } from "./words.js";

const MIN = 60_000;
const DEFAULT_MINUTES = 15;

interface Runner {
  run?: Promise<void>;
  again: boolean;
}

const runners = new WeakMap<Engine, Runner>();

/** Ahead's items changed: the windows read the view again, and the blocks are brought in step with Outlook. */
export function aheadItemsChanged(eng: Engine): void {
  eng.opts.emit("ahead.items", {});
  void syncTodoBlocks(eng);
}

/** Starts a run, or asks the running one to go round once more. Resolves when the blocks are in step. */
export function syncTodoBlocks(eng: Engine): Promise<void> {
  let r = runners.get(eng);
  if (!r) runners.set(eng, (r = { again: false }));
  if (r.run) {
    r.again = true;
    return r.run;
  }
  const me = r;
  me.run = (async () => {
    try {
      do {
        me.again = false;
        await syncOnce(eng);
      } while (me.again && eng.store.isOpen);
    } catch (err) {
      log.error("Could not bring the to-do blocks in step with the calendar", err);
    } finally {
      me.run = undefined;
    }
  })();
  return me.run;
}

/** Waits for a run in progress (the tool answers and the tests). */
export function todoBlocksSynced(eng: Engine): Promise<void> {
  return runners.get(eng)?.run ?? Promise.resolve();
}

const subjectOf = (i: AheadItem) => `To-do: ${i.title}`;

/** Where the block should be in Outlook, as instants; none without a time. */
function wanted(eng: Engine, i: AheadItem): { start: number; end: number } | undefined {
  if (!i.time) return undefined;
  return stretchOf(i.day, i.time, i.minutes ?? DEFAULT_MINUTES, eng.tz);
}

/** Saves the outlook part on the item as it is in the store now (it may have changed during a call). */
function saveOutlook(eng: Engine, id: string, outlook: AheadOutlook): AheadItem | undefined {
  const cur = eng.store.ahead.get(id);
  if (!cur || !eng.store.isOpen) return undefined;
  const next = { ...cur, outlook };
  eng.store.ahead.put(next);
  return next;
}

async function syncOnce(eng: Engine): Promise<void> {
  const address = flowAddress(eng);
  if (!address || !eng.store.isOpen) return;
  const switchOn = aheadSettings(eng).todoBlocks === true && aheadSettings(eng).enabled;
  let changed = false;
  for (const item of eng.store.ahead.blocks()) {
    if (!eng.store.isOpen) return;
    const o = item.outlook;
    const now = eng.clock();
    const at = new Date(now).toISOString();
    if (item.state === "open") {
      const w = wanted(eng, item);
      if (!w) continue;
      if (!o || o.state === "failed" || o.state === "unsure") {
        // Once per change of the block: a failed or unsure try waits for the block to change again.
        if (o && o.at >= item.changedAt) continue;
        if (!switchOn || w.end <= now) continue;
        if (o?.state === "unsure" && o.start && o.end) {
          const found = await lookFor(eng, address, item, Date.parse(o.start), Date.parse(o.end));
          if (found) {
            saveOutlook(eng, item.id, { eventId: found, state: "made", start: o.start, end: o.end, at, ...(o.subject ? { subject: o.subject } : {}) });
            changed = true;
            // Brought to its place, if it moved since, on the next round.
            const r = runners.get(eng);
            if (r) r.again = true;
            continue;
          }
        }
        changed = (await create(eng, address, item, w)) || changed;
        continue;
      }
      if (o.state !== "made" || !o.eventId) continue;
      if (o.start && o.end && Date.parse(o.start) === w.start && Date.parse(o.end) === w.end) continue;
      const a = await callFlow(eng, address, "move", { id: o.eventId, start: graphTime(w.start, eng.tz), end: graphTime(w.end, eng.tz) });
      forgetMeetings(eng);
      if (a.ok) saveOutlook(eng, item.id, { eventId: o.eventId, state: "made", start: iso(w.start), end: iso(w.end), at: new Date(eng.clock()).toISOString() });
      else if (a.gone) gone(eng, item.id);
      else {
        log.warn(`To-do blocks: could not move a block in the calendar (${a.line})`);
        // Kept as it was: the next change of the block tries again. The note says why for the window.
        saveOutlook(eng, item.id, { ...o, note: a.line });
      }
      changed = true;
      continue;
    }
    // Closed: deleted while its start is ahead, kept as a record once it has begun.
    if (!o || o.state !== "made" || !o.eventId) continue;
    const start = o.start ? Date.parse(o.start) : NaN;
    if (!(start > now)) {
      saveOutlook(eng, item.id, { ...o, state: "kept", at });
      changed = true;
      continue;
    }
    const a = await callFlow(eng, address, "delete", { id: o.eventId });
    forgetMeetings(eng);
    if (a.ok || a.gone) saveOutlook(eng, item.id, { ...o, state: "deleted", at: new Date(eng.clock()).toISOString() });
    else {
      log.warn(`To-do blocks: could not delete a block from the calendar (${a.line})`);
      // Not tried again by itself: a closed block does not change again. Left in the calendar, said in its note.
      saveOutlook(eng, item.id, { ...o, state: "kept", note: a.line, at: new Date(eng.clock()).toISOString() });
    }
    changed = true;
  }
  if (changed) eng.opts.emit("ahead.items", {});
}

async function create(eng: Engine, address: string, item: AheadItem, w: { start: number; end: number }): Promise<boolean> {
  const botName = item.botId && eng.bots.has(item.botId) ? eng.nameOf(item.botId) : "a bot";
  const text = [item.why, `Pobots made this block of time for a to-do from ${botName}.`].filter(Boolean).join("\n\n");
  const event = {
    subject: subjectOf(item),
    body: { contentType: "html", content: htmlBody(text) },
    start: graphTime(w.start, eng.tz),
    end: graphTime(w.end, eng.tz),
    showAs: "busy",
    isOnlineMeeting: false,
    isReminderOn: false,
    attendees: [],
  };
  const a = await callFlow(eng, address, "create", { event });
  forgetMeetings(eng);
  const at = new Date(eng.clock()).toISOString();
  const times = { start: iso(w.start), end: iso(w.end), subject: event.subject };
  if (a.ok) {
    const made = toMeeting(a.result);
    if (made) {
      saveOutlook(eng, item.id, { eventId: made.id, state: "made", start: iso(made.start), end: iso(made.end), at, subject: event.subject });
      return true;
    }
    // Made, but its id cannot be read: looked for by its subject before anything is made again.
    saveOutlook(eng, item.id, { state: "unsure", ...times, at, note: "the flow did not send back the event" });
    return true;
  }
  log.warn(`To-do blocks: could not put a block in the calendar (${a.line})`);
  saveOutlook(eng, item.id, { state: a.maybeDone ? "unsure" : "failed", ...times, at, note: a.line });
  return true;
}

/** An event with the block's subject at that time, from an earlier try that may have worked. */
async function lookFor(eng: Engine, address: string, item: AheadItem, start: number, end: number): Promise<string | undefined> {
  const a = await callFlow(eng, address, "list", { start: iso(start - 60 * MIN), end: iso(end + 60 * MIN) });
  if (!a.ok) return undefined;
  const value = (a.result as { value?: unknown } | undefined)?.value;
  for (const v of Array.isArray(value) ? value : []) {
    const m = toMeeting(v);
    if (m && !m.cancelled && m.subject === (item.outlook?.subject ?? subjectOf(item)) && m.start === start) return m.id;
  }
  return undefined;
}

/** The person deleted the block in Outlook: it leaves Ahead, its to-do stays, and nothing is made again. */
function gone(eng: Engine, id: string): void {
  const cur = eng.store.ahead.get(id);
  if (!cur) return;
  const at = new Date(eng.clock()).toISOString();
  const next: AheadItem = { ...cur, outlook: { ...(cur.outlook ?? { at }), state: "gone", at } };
  const wasOpen = cur.state === "open";
  if (wasOpen) Object.assign(next, { state: "dropped", changedAt: at, changedBy: "you" });
  eng.store.ahead.put(next);
  if (wasOpen && cur.forTodo) {
    tellBot(eng, next, `Note from Pobots: the person deleted the block of your to-do "${cur.title}" (${cur.forTodo}) from their calendar. The to-do stays on their list, without a block.`);
  }
}

const checked = new WeakMap<object, Set<string>>();

/**
 * At a meetings read for Ahead: blocks the person moved or deleted in Outlook follow. Returns true
 * when a block changed. Never throws into the view.
 */
export async function followOutlook(eng: Engine, read: MeetingsRead): Promise<boolean> {
  if (read.state !== "on") return false;
  const address = flowAddress(eng);
  if (!address) return false;
  let seen = checked.get(read);
  if (!seen) checked.set(read, (seen = new Set()));
  const events = new Map(read.events.map((e) => [e.id, e]));
  let changed = false;
  try {
    for (const item of eng.store.ahead.blocks()) {
      const o = item.outlook;
      if (item.state !== "open" || o?.state !== "made" || !o.eventId || !o.start || !o.end) continue;
      // Pobots' own write came after this read started: the read may show the old picture.
      if (read.startedAt < Date.parse(o.at)) continue;
      const start = Date.parse(o.start);
      const end = Date.parse(o.end);
      let ev = events.get(o.eventId);
      if (!ev) {
        // Only what the read covered (a long read may stop early), and one look per read.
        if (!(start < read.coveredTo && end > read.start) || seen.has(o.eventId)) continue;
        seen.add(o.eventId);
        const a = await callFlow(eng, address, "get", { id: o.eventId });
        if (!a.ok) {
          if (a.gone && stillSame(eng, item)) {
            gone(eng, item.id);
            changed = true;
          }
          continue;
        }
        const m = toMeeting(a.result);
        if (!m) continue;
        if (m.cancelled) {
          if (stillSame(eng, item)) {
            gone(eng, item.id);
            changed = true;
          }
          continue;
        }
        ev = { id: m.id, subject: m.subject, start: m.start, end: m.end, allDay: m.allDay };
      }
      if (ev.allDay || (ev.start === start && ev.end === end)) continue;
      if (!stillSame(eng, item)) continue;
      changed = movedThere(eng, item.id, ev.start, ev.end) || changed;
    }
  } catch (err) {
    log.error("Could not follow the to-do blocks in the calendar", err);
  }
  if (changed) {
    eng.opts.emit("ahead.items", {});
    void syncTodoBlocks(eng);
  }
  return changed;
}

/** The item has not changed in the store since it was listed (no follow over a newer change). */
function stillSame(eng: Engine, item: AheadItem): boolean {
  const cur = eng.store.ahead.get(item.id);
  return !!cur && cur.state === "open" && cur.changedAt === item.changedAt && cur.outlook?.at === item.outlook?.at;
}

/** The person moved the block in their calendar: the item goes there, and Outlook is not written back. */
function movedThere(eng: Engine, id: string, start: number, end: number): boolean {
  const cur = eng.store.ahead.get(id);
  if (!cur || !cur.outlook) return false;
  const day = dayOf(start, eng.tz);
  const minutes = Math.max(1, Math.round((end - start) / MIN));
  const at = new Date(eng.clock()).toISOString();
  const next: AheadItem = {
    ...cur,
    day,
    time: timeOf(start, eng.tz),
    minutes,
    changedAt: at,
    changedBy: "you",
    outlook: { ...cur.outlook, start: iso(start), end: iso(end), at },
  };
  if (day !== cur.day) next.movedFrom = cur.day;
  eng.store.ahead.put(next);
  tellBot(eng, next, `Note from Pobots: the person moved the block of your to-do "${cur.title}" (${cur.forTodo}) in their calendar, to ${dayWords(day)} ${next.time} (${minutes} min).`);
  return true;
}
