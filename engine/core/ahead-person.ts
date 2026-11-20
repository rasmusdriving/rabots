// What the person does on Ahead in the window (engine 0.39.0): done, drop, move, open again, and
// (part C's window) an item of their own. The item's bot is told at its next turn, never woken.
import type { Engine } from "../engine.js";
import type { AheadItem, Methods } from "../../shared/protocol.js";
import { AHEAD_LABEL_MAX, AHEAD_OPEN_MAX, AHEAD_TITLE_MAX } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { aheadOn } from "./ahead-settings.js";
import { newAheadId } from "./ahead-store.js";
import { dayWords, isDay, isTime } from "./ahead-days.js";
import { actionLine, tellBot } from "./ahead-news.js";
import { aheadItemsChanged } from "./todo-block-sync.js";
import { closeTodo } from "./todos.js";

function bad(msg: string): EngineError {
  return new EngineError("bad_request", msg);
}

function needOn(eng: Engine): void {
  if (!aheadOn(eng)) throw bad("Ahead is off. Switch it on in Settings, Ahead.");
}

export function aheadAct(eng: Engine, p: Methods["ahead.act"]["params"]): Methods["ahead.act"]["result"] {
  needOn(eng);
  const item = eng.store.ahead.get(p.itemId);
  if (!item || (item.botId && !eng.bots.has(item.botId))) throw new EngineError("not_found", "That item is no longer on Ahead.");
  const next: AheadItem = { ...item, changedAt: new Date(eng.clock()).toISOString(), changedBy: "you" };
  // A to-do's block (engine 0.41.0): Done finishes the to-do, which closes the block; it keeps a time; it opens again only with its to-do.
  const todo = item.forTodo ? eng.store.getTodo(item.forTodo) : undefined;
  if (item.forTodo) {
    if (p.action === "done" && item.state === "open" && todo?.status === "open") {
      closeTodo(eng, { todoId: item.forTodo, how: "done" });
      return { item: eng.store.ahead.get(item.id) ?? item };
    }
    if (p.action === "move" && p.time === null) throw bad("A to-do's block keeps a time. Pick a time, or remove the block.");
    if (p.action === "reopen" && todo?.status !== "open") throw bad("Its to-do is no longer open, so the block cannot come back.");
    if (p.action === "reopen" && item.outlook?.state === "gone") throw bad("You deleted this block in your calendar, so it stays removed.");
  }
  switch (p.action) {
    case "done":
    case "drop":
      if (item.state !== "open") return { item };
      next.state = p.action === "done" ? "done" : "dropped";
      break;
    case "reopen":
      if (item.state === "open") return { item };
      next.state = "open";
      break;
    case "move":
      if (!isDay(p.day)) throw bad("Pick a day.");
      if (p.time && !isTime(p.time)) throw bad("A time is HH:MM.");
      if (p.day === item.day && (p.time === undefined || (p.time ?? undefined) === item.time) && item.state === "open") return { item };
      if (p.day !== item.day) next.movedFrom = item.day;
      next.day = p.day;
      if (p.time === null) delete next.time;
      else if (p.time) next.time = p.time;
      next.state = "open";
      break;
    default:
      throw bad("Unknown action.");
  }
  // A reopened block: one Pobots deleted from the calendar is made there again; one left there is its event again.
  if (item.forTodo && p.action === "reopen" && item.outlook) {
    if (item.outlook.state === "deleted") delete next.outlook;
    else if (item.outlook.state === "kept" && item.outlook.eventId) next.outlook = { ...item.outlook, state: "made" };
  }
  eng.store.ahead.put(next);
  tellBot(eng, next, item.forTodo ? blockLine(next, p.action, item.day) : actionLine("the person", next, p.action, p.action === "move" ? item.day : undefined));
  aheadItemsChanged(eng);
  return { item: next };
}

function blockLine(item: AheadItem, action: string, from: string): string {
  const what = `the block of your to-do "${item.title}" (${item.forTodo})`;
  if (action === "drop") return `Note from Pobots: the person removed ${what} from their day. The to-do stays on their list.`;
  if (action === "reopen") return `Note from Pobots: the person put ${what} back, for ${dayWords(item.day)}${item.time ? ` ${item.time}` : ""}.`;
  if (action === "done") return `Note from Pobots: the person marked ${what} done.`;
  return `Note from Pobots: the person moved ${what}${from !== item.day ? ` from ${dayWords(from)}` : ""} to ${dayWords(item.day)}${item.time ? ` ${item.time}` : ""}.`;
}

export function aheadAdd(eng: Engine, p: Methods["ahead.add"]["params"]): Methods["ahead.add"]["result"] {
  needOn(eng);
  const title = p.title.replace(/\s+/g, " ").trim().slice(0, AHEAD_TITLE_MAX);
  if (!title) throw bad("Write what it is.");
  if (!isDay(p.day)) throw bad("Pick a day.");
  if (p.time && !isTime(p.time)) throw bad("A time is HH:MM.");
  if (eng.store.ahead.countOpen(null) >= AHEAD_OPEN_MAX) throw bad(`You have ${AHEAD_OPEN_MAX} open items of your own. Finish or drop some first.`);
  const label = p.label?.replace(/\s+/g, " ").trim().slice(0, AHEAD_LABEL_MAX);
  const at = new Date(eng.clock()).toISOString();
  const item: AheadItem = {
    id: newAheadId(),
    kind: p.kind ?? "note",
    title,
    day: p.day,
    ...(p.time ? { time: p.time } : {}),
    ...(label ? { label } : {}),
    state: "open",
    createdAt: at,
    changedAt: at,
    changedBy: "you",
  };
  eng.store.ahead.put(item);
  aheadItemsChanged(eng);
  return { item };
}
