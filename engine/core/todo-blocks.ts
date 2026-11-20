// To-do blocks (engine 0.41.0, docs/build/step-todo-blocks.md): while blocks are on (Ahead on, the
// switch on, the calendar set up), every new to-do from a bot gets a block of the person's time. The
// block is an Ahead item of kind "your-time" that carries the to-do's id (forTodo), placed like a
// "your time" slot (ahead-time.ts) before the to-do's by_when, without counting toward the day's
// limit. It closes when the to-do closes. Outlook is kept in step by todo-block-sync.ts.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { TodoArgs } from "../todos.js";
import { AHEAD_OPEN_MAX, AHEAD_TITLE_MAX, AHEAD_WHY_MAX, TODO_MINUTES_DEFAULT, type AheadItem, type AheadWish, type Todo } from "../../shared/protocol.js";
import { newAheadId } from "./ahead-store.js";
import { aheadSettings, schedulingOf, setAheadSettings, todoBlocksOn } from "./ahead-settings.js";
import { flowAddress } from "./calendar-settings.js";
import { EngineError } from "../errors.js";
import { dayWords, isDay, timeOf } from "./ahead-days.js";
import { latestEndOf, noneWords, place, tellMain, type PlaceAsk } from "./ahead-time.js";
import { stretchOf } from "./ahead-slots.js";
import { aheadItemsChanged, todoBlocksSynced } from "./todo-block-sync.js";
import { byMainBot, wishRules, wishWords, type WishPlan } from "./todo-block-wish.js";

const clip = (s: string | undefined, max: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** "Tue 24 Nov 10:15 to 10:30 (15 min)". */
function spanOf(eng: Engine, i: AheadItem): string {
  const minutes = i.minutes ?? TODO_MINUTES_DEFAULT;
  const s = stretchOf(i.day, i.time!, minutes, eng.tz);
  const [weekday, d, month] = dayWords(i.day).split(" ");
  return `${weekday!.slice(0, 3)} ${d} ${month} ${i.time} to ${timeOf(s.end, eng.tz)} (${minutes} min)`;
}

/** The latest-by rules from a to-do's by_when: the day, and with a time the instant it should end by. */
function dueRules(eng: Engine, todo: Todo): Pick<PlaceAsk, "latestBy" | "latestEnd"> {
  const day = todo.due?.slice(0, 10);
  if (!day || !isDay(day)) return {};
  const latestEnd = latestEndOf(eng, { forTodo: todo.id });
  return { latestBy: day, ...(latestEnd !== undefined ? { latestEnd } : {}) };
}

/** What the bot is told about where the block stands in the calendar, after the first try. */
async function calendarWords(eng: Engine, id: string): Promise<string> {
  await todoBlocksSynced(eng);
  const o = eng.store.ahead.get(id)?.outlook;
  if (o?.state === "made") return "on Ahead and in the person's calendar";
  if (o?.state === "unsure") return `on Ahead. The calendar did not answer in time (${o.note ?? "no answer"}), so Pobots looks there before it tries again`;
  if (o?.state === "failed") return `on Ahead, but not in the person's calendar: ${o.note ?? "the calendar flow said no"}. Pobots tries again when the block changes`;
  return "on Ahead";
}

const howLong = `Next time give minutes: how long it takes the person.`;

/** Why a block is after its by-when: no free time before it, or none that keeps to when the bot asked. */
const lateWhy = (wish: AheadWish | undefined, who = "you") => (wish ? `there was no free time before it that keeps to when ${who} asked` : "there was no free time before");

/**
 * Places a block for a to-do that has none yet, keeping to when the bot asked (`wish`, checked by
 * planWish). The words for the bot's answer, starting with a space, or "" while blocks are off.
 */
export async function newBlock(eng: Engine, rt: BotRuntime, todo: Todo, threadId?: string, wish?: AheadWish): Promise<string> {
  if (!todoBlocksOn(eng)) return "";
  const minutes = todo.minutes ?? TODO_MINUTES_DEFAULT;
  const due = dueRules(eng, todo);
  const byMain = byMainBot(rt);
  const r = await place(eng, { minutes, ...due, ...wishRules(eng, wish, minutes, { byMain }), counts: false });
  if (!r.slot.ok) {
    const why = r.slot.why === "full" ? `there is no free time in the person's working hours in the next 31 days${wish ? " that keeps to when you asked" : ""}` : noneWords(eng, r.slot.why, minutes).replace(/ Ask for less\.$/, "").replace(/\.$/, "");
    return ` It has no block of time: ${why[0]!.toLowerCase()}${why.slice(1)}.${r.slot.why === "hours" ? " Give fewer minutes with update_todo." : ""}`;
  }
  // The to-do may have closed while the calendar was read.
  if (eng.store.getTodo(todo.id)?.status !== "open") return "";
  if (eng.store.ahead.countOpen(todo.botId) >= AHEAD_OPEN_MAX) return ` It has no block of time: you have ${AHEAD_OPEN_MAX} open items on Ahead.`;
  const at = new Date(eng.clock()).toISOString();
  const why = clip(todo.why, AHEAD_WHY_MAX);
  const thread = threadId ?? rt.turn?.threadId ?? rt.threadId;
  const item: AheadItem = {
    id: newAheadId(),
    botId: todo.botId,
    kind: "your-time",
    title: clip(todo.title, AHEAD_TITLE_MAX),
    day: r.slot.day,
    time: r.slot.time,
    ...(why ? { why } : {}),
    link: { todoId: todo.id, ...(thread ? { threadId: thread } : {}) },
    state: "open",
    createdAt: at,
    changedAt: at,
    changedBy: "bot",
    minutes,
    ...(due.latestBy ? { latestBy: due.latestBy } : {}),
    forTodo: todo.id,
    ...(wish ? { wish } : {}),
  };
  eng.store.ahead.put(item);
  aheadItemsChanged(eng);
  if (r.slot.late) tellMain(eng, `Note from Pobots: the to-do "${todo.title}" from ${rt.folder.file.name} is due ${todo.due!.replace("T", " ")}, and its block is ${spanOf(eng, item)}, which is late: ${lateWhy(wish, "the bot")}. Move it with ahead_item (${item.id}) if something else can wait.`, rt.folder.id);
  const where = await calendarWords(eng, item.id);
  const kept = wishWords(eng, wish, r.slot, byMain);
  const late = r.slot.late ? ` That is after its by-when: ${lateWhy(wish)}.${byMain ? "" : " The main bot is told."}` : "";
  const meetings = r.meetings === "problem" ? " The calendar could not be read, so meetings were not checked." : "";
  return ` Its block is ${spanOf(eng, item)}, ${where}.${kept}${late}${meetings}${todo.minutes ? "" : ` You gave no minutes, so it got ${minutes}. ${howLong}`}`;
}

/**
 * After update_todo: the block follows the to-do. Minutes or by_when place it again; a new title or
 * why is shown on Ahead. A to-do with no block gets one on its first change while blocks are on;
 * one whose block was removed never gets a new one by itself. Engine 0.44.0: a new wish (`plan`,
 * checked by planWish) always places it again; placed again for minutes or by_when it keeps the
 * old wish while the block is still where the bot or Pobots put it (a move by the person wins).
 */
export async function changedBlock(eng: Engine, rt: BotRuntime, before: Todo, after: Todo, args: TodoArgs, plan?: WishPlan): Promise<string> {
  const block = eng.store.ahead.blockOf(after.id);
  if (!block) return newBlock(eng, rt, after, undefined, plan?.wish);
  if (block.state !== "open") return args.minutes !== undefined || args.by_when !== undefined || plan?.touched ? " Its block was removed earlier, so it has none." : "";
  const at = new Date(eng.clock()).toISOString();
  let next: AheadItem = { ...block, title: clip(after.title, AHEAD_TITLE_MAX) };
  const why = clip(after.why, AHEAD_WHY_MAX);
  if (why) next.why = why;
  else delete next.why;
  const due = dueRules(eng, after);
  const minutes = after.minutes ?? block.minutes ?? TODO_MINUTES_DEFAULT;
  const minutesChanged = minutes !== (block.minutes ?? TODO_MINUTES_DEFAULT);
  const dueChanged = before.due !== after.due;
  const touched = !!plan?.touched;
  const byMain = byMainBot(rt);
  // The wish it is placed by: the new one, or the old one while the block is still the bot's.
  const wish = touched ? plan!.wish : block.changedBy === "bot" ? block.wish : undefined;
  let words = "";
  if (minutesChanged || dueChanged || touched) {
    // A new by-when that the block already meets keeps it where it is (the person may have put it there).
    const s = block.time ? stretchOf(block.day, block.time, minutes, eng.tz) : undefined;
    const fits = !minutesChanged && !touched && s && (!due.latestBy || block.day <= due.latestBy) && (due.latestEnd === undefined || s.end <= due.latestEnd);
    if (!fits) {
      const r = await place(eng, { minutes, ...due, ...wishRules(eng, wish, minutes, touched ? { byMain } : undefined), except: block.id, counts: false });
      if (!r.slot.ok) {
        const reason = r.slot.why === "full" ? `there is no free time in the next 31 days${wish ? " that keeps to when you asked" : ""}` : `${minutes} minutes does not fit in the person's working day`;
        return ` Its block stays ${spanOf(eng, block)}: ${reason}.`;
      }
      const cur = eng.store.ahead.get(block.id);
      if (!cur || cur.state !== "open") return "";
      next = { ...next, day: r.slot.day, time: r.slot.time };
      if (r.slot.day !== block.day) next.movedFrom = block.day;
      // Placed again after the person moved it: the old wish is gone with their move.
      if (!touched && block.changedBy !== "bot") delete next.wish;
      words = `${touched ? wishWords(eng, wish, r.slot, byMain) : ""}${r.slot.late ? ` That is after its by-when: ${lateWhy(wish)}.` : ""}`;
    }
    next.minutes = minutes;
    if (due.latestBy) next.latestBy = due.latestBy;
    else delete next.latestBy;
    if (touched) {
      if (plan!.wish) next.wish = plan!.wish;
      else delete next.wish;
    }
  }
  const same = JSON.stringify({ ...next }) === JSON.stringify(block);
  if (!same) {
    next = { ...next, changedAt: at, changedBy: "bot" };
    eng.store.ahead.put(next);
    aheadItemsChanged(eng);
  }
  if (!minutesChanged && !dueChanged && !touched) return "";
  if (same && !touched) return "";
  const where = await calendarWords(eng, next.id);
  const moved = next.day !== block.day || next.time !== block.time;
  return ` Its block ${moved || !touched ? "is now" : "stays"} ${spanOf(eng, next)}, ${where}.${words}`;
}

/** The to-do closed: its block closes with it, done when it was answered or done, dropped otherwise. */
export function closeBlockOf(eng: Engine, todoId: string, state: "done" | "dropped", by: "you" | "bot"): void {
  const block = eng.store.ahead.blockOf(todoId);
  if (!block || block.state !== "open") return;
  const at = new Date(eng.clock()).toISOString();
  eng.store.ahead.put({ ...block, state, changedAt: at, changedBy: by });
  aheadItemsChanged(eng);
}

/** The open block of a to-do, if it has one: the to-do then shows only as its block on Ahead. */
export function openBlockIds(eng: Engine): Set<string> {
  const ids = new Set<string>();
  for (const i of eng.store.ahead.list()) if (i.forTodo) ids.add(i.forTodo);
  return ids;
}

/** change_settings ahead_todo_blocks and ahead_scheduling (the main bot). The lines of what changed. */
export function setTodoBlocks(eng: Engine, on: boolean | undefined, scheduling: string | undefined): string[] {
  const before = aheadSettings(eng);
  if (!before.enabled) throw new EngineError("bad_request", "Ahead is off, so to-dos in the calendar and how to schedule the person cannot be set. Switch Ahead on first (change_settings ahead), when the person asks.");
  const after = setAheadSettings(eng, { ...(on !== undefined ? { todoBlocks: on } : {}), ...(scheduling !== undefined ? { scheduling } : {}) });
  const out: string[] = [];
  if (!!after.todoBlocks !== !!before.todoBlocks) {
    const calendar = after.todoBlocks && !flowAddress(eng) ? " (the calendar is not set up, so no blocks are made until it is)" : "";
    out.push(`Ahead, to-dos in the calendar from ${after.todoBlocks ? "off to on" : "on to off"}${calendar}`);
  }
  if (schedulingOf(after) !== schedulingOf(before)) {
    const words = schedulingOf(after).split(/\s+/).filter(Boolean).length;
    out.push(after.scheduling ? `Ahead, how to schedule the person: changed (about ${words} words)` : "Ahead, how to schedule the person: back to the default");
  }
  return out;
}
