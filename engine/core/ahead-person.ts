// What the person does on Ahead in the window (engine 0.39.0): done, drop, move, open again, and
// (part C's window) an item of their own. The item's bot is told at its next turn, never woken.
import type { Engine } from "../engine.js";
import type { AheadItem, Methods } from "../../shared/protocol.js";
import { AHEAD_LABEL_MAX, AHEAD_OPEN_MAX, AHEAD_TITLE_MAX } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { aheadOn } from "./ahead-settings.js";
import { newAheadId } from "./ahead-store.js";
import { isDay, isTime } from "./ahead-days.js";
import { actionLine, tellBot } from "./ahead-news.js";

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
  eng.store.ahead.put(next);
  tellBot(eng, next, actionLine("the person", next, p.action, p.action === "move" ? item.day : undefined));
  eng.opts.emit("ahead.items", {});
  return { item: next };
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
  eng.opts.emit("ahead.items", {});
  return { item };
}
