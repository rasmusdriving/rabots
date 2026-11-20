// "Your time" on Ahead (engine 0.39.0, Ahead part B, docs/build/step-ahead.md): a bot with level
// "time" asks for a piece of the person's time and Pobots places it in the first free slot
// (ahead-slots.ts). The main bot is the time manager: it may set any "your time" item at a time of
// its choice and adds focus blocks of its own. The person moves one with Later today, Tomorrow,
// Next free slot, Pick a time or Not this week. A meeting that comes on a placed item moves it at
// the next read. The main bot's week note lives here too.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ToolResult } from "../claude/session.js";
import { AHEAD_OPEN_MAX, AHEAD_TITLE_MAX, TODO_MINUTES_MAX, type AheadItem, type AheadSettings, type Methods } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { log } from "../log.js";
import { ok, problem } from "../tool-names.js";
import { aheadLevel, aheadOn, aheadSettings, setAheadSettings } from "./ahead-settings.js";
import { aheadMeetings } from "./ahead-meetings.js";
import { newAheadId } from "./ahead-store.js";
import { addDays, dayOf, dayWords, isDay, isTime, mondayOf, startOf } from "./ahead-days.js";
import { actionLine, tellBot } from "./ahead-news.js";
import { findSlot, meetingStretch, overlaps, stretchOf, wholeDay, SEARCH_DAYS, type Busy, type SlotFound, type SlotNone } from "./ahead-slots.js";
import { aheadItemsChanged } from "./todo-block-sync.js";
import { instantFor } from "../schedule.js";

/** A bot asks for 5 to 120 minutes; the main bot's own focus blocks may run a working day. */
export const ASK_MIN = 5;
export const ASK_MAX = 120;
export const FOCUS_MAX = 480;
export const WEEK_NOTE_MAX = 300;
export const DEFAULT_MINUTES = 30;
const SETTINGS_KEY = "ahead.settings";

/** The yourTime fields of the tool call (ahead_item). */
export interface YourTimeArgs {
  action: string;
  id?: string;
  title?: string;
  day?: string;
  time?: string;
  minutes?: number;
  latest_by?: string;
  todo?: string;
  label?: string;
  why?: string;
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isMain = (rt: BotRuntime | undefined) => rt?.folder.file.role === "main";
const mainBot = (eng: Engine): BotRuntime | undefined => [...eng.bots.values()].find((rt) => isMain(rt));
const when = (i: Pick<AheadItem, "day" | "time">) => `${dayWords(i.day)}${i.time ? ` ${i.time}` : ""}`;

/** True for a "your time" item that has a place (a time). */
const placed = (i: AheadItem) => i.kind === "your-time" && !!i.time && isTime(i.time);

/**
 * False for what does not count toward the day's limit: the main bot's focus blocks and the blocks
 * of to-dos (engine 0.41.0: a to-do is work the person must do anyway; a limit would push it past its date).
 */
function countsToward(eng: Engine, i: Pick<AheadItem, "botId" | "forTodo">): boolean {
  if (i.forTodo) return false;
  const main = mainBot(eng);
  return !main || i.botId !== main.folder.id;
}

/** The longest a your-time item may be: a to-do's block 240 minutes, the main bot's focus blocks 480, others 120. */
function maxMinutes(eng: Engine, i: Pick<AheadItem, "botId" | "forTodo">): number {
  if (i.forTodo) return TODO_MINUTES_MAX;
  return countsToward(eng, i) ? ASK_MAX : FOCUS_MAX;
}

/** By when a to-do's block should end: its by_when with a time, as an instant. */
export function latestEndOf(eng: Engine, i: Pick<AheadItem, "forTodo">): number | undefined {
  const due = i.forTodo ? eng.store.getTodo(i.forTodo)?.todo.due : undefined;
  const m = due ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(due) : null;
  return m ? instantFor(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, eng.tz) : undefined;
}

/** The latest-by rules of an item when it is placed again. */
const lateOf = (eng: Engine, i: AheadItem) => {
  const latestEnd = latestEndOf(eng, i);
  return { ...(i.latestBy ? { latestBy: i.latestBy } : {}), ...(latestEnd !== undefined ? { latestEnd } : {}) };
};

// ---------------------------------------------------------------- what is taken

interface Taken {
  busy: Busy[];
  used: Record<string, number>;
  meetings: "on" | "none" | "problem";
}

/** Busy meetings and every open "your time" item from `from` on (31 days), leaving out `except`. */
async function taken(eng: Engine, from: string, except?: string): Promise<Taken> {
  const to = addDays(from, SEARCH_DAYS - 1);
  const busy: Busy[] = [];
  const used: Record<string, number> = {};
  const read = await aheadMeetings(eng, from, to);
  if (read.state === "on") {
    for (const m of read.rows) {
      if (m.free) continue;
      if (m.allDay) busy.push(wholeDay(m.day, eng.tz));
      else if (m.time) busy.push(meetingStretch(m.day, m.time, m.end, eng.tz));
    }
  }
  for (const i of eng.store.ahead.list({ from, to })) {
    if (i.id === except || !placed(i) || (i.botId && !eng.bots.has(i.botId))) continue;
    const minutes = i.minutes ?? DEFAULT_MINUTES;
    busy.push(stretchOf(i.day, i.time!, minutes, eng.tz));
    // The main bot's focus blocks and the to-dos' blocks block, and do not count toward the limit.
    if (countsToward(eng, i)) used[i.day] = (used[i.day] ?? 0) + minutes;
  }
  return { busy, used, meetings: read.state };
}

export interface PlaceAsk {
  minutes: number;
  earliest?: string;
  notBefore?: number;
  latestBy?: string;
  latestEnd?: number;
  except?: string;
  counts: boolean;
}

export async function place(eng: Engine, a: PlaceAsk): Promise<{ slot: SlotFound | SlotNone; meetings: Taken["meetings"] }> {
  const now = eng.clock();
  const today = dayOf(now, eng.tz);
  const from = a.earliest && a.earliest > today ? a.earliest : today;
  const t = await taken(eng, from, a.except);
  const s = aheadSettings(eng);
  const slot = findSlot({
    minutes: a.minutes,
    now,
    tz: eng.tz,
    rules: s,
    busy: t.busy,
    used: t.used,
    ...(a.earliest ? { earliest: a.earliest } : {}),
    ...(a.notBefore ? { notBefore: a.notBefore } : {}),
    ...(a.latestBy ? { latestBy: a.latestBy } : {}),
    ...(a.latestEnd !== undefined ? { latestEnd: a.latestEnd } : {}),
    counts: a.counts,
  });
  return { slot, meetings: t.meetings };
}

export function noneWords(eng: Engine, why: SlotNone["why"], minutes: number): string {
  const s = aheadSettings(eng);
  if (why === "limit") return `${minutes} minutes is more than the person's limit of ${s.minutesPerDay} minutes of your-time a day. Ask for less.`;
  if (why === "hours") return `${minutes} minutes does not fit in the working day (${s.workStart} to ${s.workEnd}). Ask for less.`;
  return `There is no free slot in the next ${SEARCH_DAYS} days. Ask for less time, or ask again later.`;
}

const meetingWords = (m: Taken["meetings"]) => (m === "problem" ? " The calendar could not be read, so meetings were not checked." : "");

/** Tells the main bot (not when it is the one asking or the owner). */
export function tellMain(eng: Engine, text: string, notFor?: string): void {
  const main = mainBot(eng);
  if (!main || main.folder.id === notFor) return;
  eng.store.addNews(main.folder.id, main.threadId, text);
}

// ---------------------------------------------------------------- the tool

function minutesOf(a: YourTimeArgs, max: number): number | string {
  const n = a.minutes === undefined ? DEFAULT_MINUTES : Math.round(Number(a.minutes));
  if (!Number.isFinite(n) || n < ASK_MIN || n > max) return `minutes is ${ASK_MIN} to ${max}.`;
  return n;
}

const refusal = "Asking for the person's time needs Ahead permission time. The person gives it in your Settings, Ahead, or asks the main bot (update_bot ahead time). Until then use kind will-do, deadline, waiting or note.";

/** ahead_item add with kind your-time. `rt` calls, `owner` is the bot it is for. */
export async function addYourTime(eng: Engine, rt: BotRuntime, owner: BotRuntime, a: YourTimeArgs, threadId?: string): Promise<ToolResult> {
  const byMain = isMain(rt);
  if (!byMain && aheadLevel(rt) !== "time") return problem(refusal);
  const title = clean(a.title, 1000);
  if (!title) return problem("add needs a title: what the person should look at.");
  if (title.length > AHEAD_TITLE_MAX) return problem(`Keep the title under ${AHEAD_TITLE_MAX} characters.`);
  const focus = byMain && owner === rt;
  const minutes = minutesOf(a, focus ? FOCUS_MAX : ASK_MAX);
  if (typeof minutes === "string") return problem(minutes);
  const today = dayOf(eng.clock(), eng.tz);
  if (a.day && !isDay(a.day)) return problem("day is YYYY-MM-DD.");
  if (a.day && a.day < today) return problem(`That day has passed. Today is ${today}.`);
  if (a.latest_by && !isDay(a.latest_by)) return problem("latest_by is YYYY-MM-DD.");
  if (a.latest_by && a.latest_by < today) return problem(`latest_by has passed. Today is ${today}.`);
  if (a.time && !isTime(a.time)) return problem("time is HH:MM, such as 14:30.");
  const botId = owner.folder.id;
  const same = eng.store.ahead.list({ botId }).find((i) => i.kind === "your-time" && i.title === title);
  if (same) return ok(`Already on Ahead: ${same.id}, ${when(same)}, "${same.title}".`);
  if (eng.store.ahead.countOpen(botId) >= AHEAD_OPEN_MAX) {
    return problem(`${owner === rt ? "You have" : `${owner.folder.file.name} has`} ${AHEAD_OPEN_MAX} open items on Ahead. Finish or drop some first.`);
  }
  const todo = clean(a.todo, 60);
  if (todo && !eng.store.getTodo(todo)) return problem("There is no to-do with that id.");
  const latestBy = a.latest_by || undefined;
  const earliest = a.day && a.day > today ? a.day : undefined;
  let day: string;
  let time: string;
  let late = false;
  let meetings: Taken["meetings"] = "none";
  if (byMain && a.time) {
    // The main bot's own choice of time, inside or outside working hours.
    day = a.day || today;
    time = a.time;
  } else {
    const r = await place(eng, { minutes, ...(earliest ? { earliest } : {}), ...(latestBy ? { latestBy } : {}), counts: !focus });
    if (!r.slot.ok) return problem(noneWords(eng, r.slot.why, minutes));
    ({ day, time, late } = r.slot);
    meetings = r.meetings;
  }
  const at = new Date(eng.clock()).toISOString();
  const thread = owner === rt ? (threadId ?? rt.turn?.threadId ?? rt.threadId) : undefined;
  const label = clean(a.label, 40);
  const why = clean(a.why, 200);
  const item: AheadItem = {
    id: newAheadId(),
    botId,
    kind: "your-time",
    title,
    day,
    time,
    ...(label ? { label } : {}),
    ...(why ? { why } : {}),
    ...(thread || todo ? { link: { ...(thread ? { threadId: thread } : {}), ...(todo ? { todoId: todo } : {}) } } : {}),
    state: "open",
    createdAt: at,
    changedAt: at,
    changedBy: byMain && owner !== rt ? "main" : "bot",
    minutes,
    ...(latestBy ? { latestBy } : {}),
    ...(earliest ? { earliest } : {}),
  };
  eng.store.ahead.put(item);
  if (owner !== rt) tellBot(eng, item, `Note from Pobots: the main bot put your-time on Ahead for you: "${item.title}" (${item.id}, ${when(item)}, ${minutes} minutes).`);
  if (late) tellMain(eng, `Note from Pobots: ${owner.folder.file.name} asked for the person's time, "${item.title}" (${item.id}), by ${dayWords(latestBy!)}. The first free slot is ${when(item)}, which is late. Move it with ahead_item if something else can wait.`, rt.folder.id);
  aheadItemsChanged(eng);
  const lateWords = late ? ` That is after ${dayWords(latestBy!)}: there was no free slot before. The main bot is told.` : "";
  const fixed = byMain && a.time ? "" : " Pobots chose the time.";
  return ok(`On Ahead: ${item.id}, your-time, "${item.title}", ${when(item)}, ${minutes} minutes.${fixed}${lateWords}${meetingWords(meetings)} You hear when the person moves or finishes it.`);
}

/** ahead_item move of a your-time item. A bot names a day (not before); the main bot may name a time too. */
export async function moveYourTime(eng: Engine, rt: BotRuntime, item: AheadItem, a: YourTimeArgs): Promise<ToolResult> {
  const byMainBot = isMain(rt);
  if (!byMainBot && aheadLevel(rt) !== "time") return problem(refusal);
  const today = dayOf(eng.clock(), eng.tz);
  if (a.day && !isDay(a.day)) return problem("day is YYYY-MM-DD.");
  if (a.day && a.day < today) return problem(`That day has passed. Today is ${today}.`);
  if (a.time && !isTime(a.time)) return problem("time is HH:MM, such as 14:30.");
  const counts = countsToward(eng, item);
  const minutes = a.minutes !== undefined ? minutesOf(a, maxMinutes(eng, item)) : item.minutes ?? DEFAULT_MINUTES;
  if (typeof minutes === "string") return problem(minutes);
  let day: string;
  let time: string;
  let late = false;
  let meetings: Taken["meetings"] = "none";
  if (byMainBot && a.time) {
    day = a.day || item.day;
    time = a.time;
  } else {
    const earliest = a.day && a.day > today ? a.day : undefined;
    const r = await place(eng, { minutes, ...(earliest ? { earliest } : {}), ...lateOf(eng, item), except: item.id, counts });
    if (!r.slot.ok) return problem(noneWords(eng, r.slot.why, minutes));
    ({ day, time, late } = r.slot);
    meetings = r.meetings;
  }
  // The item may have changed while the meetings were read.
  const now = eng.store.ahead.get(item.id);
  if (!now || now.state !== "open") return problem("That item was closed meanwhile.");
  const byMain = byMainBot && item.botId !== rt.folder.id;
  const next: AheadItem = { ...now, day, time, minutes, changedAt: new Date(eng.clock()).toISOString(), changedBy: byMain ? "main" : "bot" };
  if (day !== now.day) next.movedFrom = now.day;
  if (a.day && a.day > today && !byMainBot) next.earliest = a.day;
  eng.store.ahead.put(next);
  if (byMain) tellBot(eng, next, actionLine("the main bot", next, "move", now.day));
  aheadItemsChanged(eng);
  const lateWords = late ? ` That is after ${next.latestBy ? dayWords(next.latestBy) : "its by-when"}: there was no free slot before.` : "";
  return ok(`Moved to ${when(next)}: "${next.title}" (${next.id}, ${minutes} minutes).${lateWords}${meetingWords(meetings)}`);
}

/** ahead_item week_note, the main bot's note at the top of Ahead: replaced, never stacked; empty clears. */
export function weekNote(eng: Engine, rt: BotRuntime, a: YourTimeArgs): ToolResult {
  if (!isMain(rt)) return problem("Only the main bot writes the week note.");
  const text = clean(a.title, 1000);
  if (text.length > WEEK_NOTE_MAX) return problem(`Keep the week note under ${WEEK_NOTE_MAX} characters.`);
  const s: AheadSettings = { ...aheadSettings(eng) };
  if (text) s.weekNote = { text, at: new Date(eng.clock()).toISOString() };
  else delete s.weekNote;
  eng.store.setValue(SETTINGS_KEY, JSON.stringify(s));
  eng.opts.emit("ahead.changed", { ahead: s });
  return ok(text ? "The week note is at the top of Ahead." : "The week note is cleared.");
}

// ---------------------------------------------------------------- the person

function bad(msg: string): EngineError {
  return new EngineError("bad_request", msg);
}

/** ahead.act with `place`: the person's Later today, Tomorrow, Next free slot or Not this week. */
export async function placeByPerson(eng: Engine, p: Methods["ahead.act"]["params"]): Promise<Methods["ahead.act"]["result"]> {
  if (!aheadOn(eng)) throw bad("Ahead is off. Switch it on in Settings, Ahead.");
  const item = eng.store.ahead.get(p.itemId);
  if (!item || (item.botId && !eng.bots.has(item.botId))) throw new EngineError("not_found", "That item is no longer on Ahead.");
  if (p.action !== "move") throw bad("A place goes with Move.");
  if (item.kind !== "your-time") throw bad("Only your-time is placed by Pobots. Pick a day instead.");
  const now = eng.clock();
  const today = dayOf(now, eng.tz);
  const counts = countsToward(eng, item);
  const minutes = item.minutes ?? DEFAULT_MINUTES;
  let earliest: string | undefined;
  let notBefore: number | undefined;
  switch (p.place) {
    case "today":
      // Later than the current slot: after it ends, or from now.
      notBefore = item.day === today && item.time ? Math.max(now, stretchOf(item.day, item.time, minutes, eng.tz).end) : now;
      break;
    case "tomorrow":
      earliest = addDays(today, 1);
      break;
    case "next":
      notBefore = now;
      break;
    case "next-week":
      earliest = addDays(mondayOf(today), 7);
      notBefore = startOf(earliest, eng.tz);
      break;
    default:
      throw bad("Unknown place.");
  }
  const r = await place(eng, { minutes, ...(earliest ? { earliest } : {}), ...(notBefore ? { notBefore } : {}), except: item.id, counts });
  if (!r.slot.ok) throw bad(r.slot.why === "full" ? `There is no free slot in the next ${SEARCH_DAYS} days. Pick a time instead.` : "It is longer than your working day or your limit. Pick a time instead.");
  if (p.place === "today" && r.slot.day !== today) throw bad("There is no free slot left today. Try Tomorrow or Next free slot.");
  const cur = eng.store.ahead.get(item.id) ?? item;
  const next: AheadItem = { ...cur, day: r.slot.day, time: r.slot.time, state: "open", changedAt: new Date(eng.clock()).toISOString(), changedBy: "you" };
  if (next.day !== cur.day) next.movedFrom = cur.day;
  eng.store.ahead.put(next);
  const line = actionLine("the person", next, "move", cur.day);
  tellBot(eng, next, p.place === "next-week" ? line.replace(/\.$/, " (not this week).") : line);
  aheadItemsChanged(eng);
  return { item: next };
}

// ---------------------------------------------------------------- a meeting comes on an item

const settling = new WeakMap<Engine, Promise<void>>();

/**
 * Before a view read: a "your time" item Pobots placed that a busy meeting now covers is placed
 * again, marked "Moved from". Times the person or the main bot chose stay where they put them.
 */
export function settleYourTime(eng: Engine, from: string, to: string): Promise<void> {
  const had = settling.get(eng);
  if (had) return had;
  // Never in the way of the view: a problem here is logged and the view is read as it is.
  const run = settle(eng, from, to)
    .catch((err) => log.error("Could not place your-time items again after a calendar change", err))
    .finally(() => settling.delete(eng));
  settling.set(eng, run);
  return run;
}

async function settle(eng: Engine, from: string, to: string): Promise<void> {
  const now = eng.clock();
  const today = dayOf(now, eng.tz);
  const start = from > today ? from : today;
  const last = addDays(start, SEARCH_DAYS - 1) < to ? addDays(start, SEARCH_DAYS - 1) : to;
  const mine = eng.store.ahead.list({ from: start, to: last }).filter((i) => placed(i) && i.changedBy === "bot" && i.botId && eng.bots.has(i.botId));
  if (!mine.length) return;
  const read = await aheadMeetings(eng, start, last);
  if (read.state !== "on") return;
  const meetings: Busy[] = [];
  for (const m of read.rows) {
    if (m.free) continue;
    if (m.allDay) meetings.push(wholeDay(m.day, eng.tz));
    else if (m.time) meetings.push(meetingStretch(m.day, m.time, m.end, eng.tz));
  }
  let moved = false;
  for (const item of mine) {
    const own = stretchOf(item.day, item.time!, item.minutes ?? DEFAULT_MINUTES, eng.tz);
    // One that has begun stays: the person may be on it.
    if (own.start <= now || !meetings.some((m) => overlaps(m, own))) continue;
    const r = await place(eng, { minutes: item.minutes ?? DEFAULT_MINUTES, ...(item.earliest ? { earliest: item.earliest } : {}), ...lateOf(eng, item), except: item.id, counts: countsToward(eng, item) });
    if (!r.slot.ok) continue;
    const cur = eng.store.ahead.get(item.id);
    if (!cur || cur.state !== "open" || cur.day !== item.day || cur.time !== item.time) continue;
    const next: AheadItem = { ...cur, day: r.slot.day, time: r.slot.time, movedFrom: cur.day, changedAt: new Date(eng.clock()).toISOString(), changedBy: "bot" };
    eng.store.ahead.put(next);
    const what = next.forTodo ? `the block of your to-do "${next.title}" (${next.forTodo})` : `your Ahead item "${next.title}" (${next.id})`;
    tellBot(eng, next, `Note from Pobots: a meeting came on ${what}, so Pobots moved it to ${when(next)}${r.slot.late ? (next.latestBy ? `, after its latest day ${dayWords(next.latestBy)}` : ", which is late") : ""}.`);
    moved = true;
  }
  if (moved) aheadItemsChanged(eng);
}

// ---------------------------------------------------------------- the main bot's settings

export interface AheadTimeArgs {
  work_start?: string;
  work_end?: string;
  work_days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  minutes_per_day?: number;
}

/** change_settings ahead_time: working hours, days and the day's limit. The lines of what changed. */
export function setAheadTime(eng: Engine, a: AheadTimeArgs): string[] {
  const before = aheadSettings(eng);
  const after = setAheadSettings(eng, {
    ...(a.work_start !== undefined ? { workStart: a.work_start } : {}),
    ...(a.work_end !== undefined ? { workEnd: a.work_end } : {}),
    ...(a.work_days !== undefined ? { workDays: a.work_days } : {}),
    ...(a.minutes_per_day !== undefined ? { minutesPerDay: a.minutes_per_day } : {}),
  });
  const out: string[] = [];
  if (after.workStart !== before.workStart || after.workEnd !== before.workEnd) out.push(`working hours ${after.workStart} to ${after.workEnd} (was ${before.workStart} to ${before.workEnd})`);
  if (after.workDays.join() !== before.workDays.join()) out.push(`working days ${after.workDays.join(", ")} (was ${before.workDays.join(", ")})`);
  if (after.minutesPerDay !== before.minutesPerDay) out.push(`your time at most ${after.minutesPerDay} minutes a day (was ${before.minutesPerDay})`);
  return out;
}
