// ahead_item, the bot tool for Ahead (engine 0.39.0, docs/build/step-ahead.md): add, move, done,
// drop, list. A bot manages only its own items; the main bot any (it names the bot). An item is a
// note for the person inside Pobots and never writes to a calendar or anywhere else.
//
// Part B: kind "your-time" (the person's time) and the main bot's week note go to ahead-time.ts.
import { z } from "zod";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { BotTool, ToolResult } from "../claude/session.js";
import type { ToolWords } from "../claude/labels.js";
import { AHEAD_LABEL_MAX, AHEAD_OPEN_MAX, AHEAD_TITLE_MAX, AHEAD_WHY_MAX, type AheadItem, type AheadKind } from "../../shared/protocol.js";
import { ok, problem } from "../tool-names.js";
import { newAheadId } from "./ahead-store.js";
import { dayOf, dayWords, isDay, isTime } from "./ahead-days.js";
import { actionLine, tellBot } from "./ahead-news.js";
import { aheadLevel } from "./ahead-settings.js";
import { addYourTime, moveYourTime, weekNote } from "./ahead-time.js";

export const AHEAD_TOOL = "ahead_item";

export interface AheadArgs {
  action: "add" | "move" | "done" | "drop" | "list" | "week_note";
  id?: string;
  kind?: AheadKind;
  title?: string;
  day?: string;
  time?: string;
  label?: string;
  why?: string;
  todo?: string;
  to?: string;
  bot?: string;
  minutes?: number;
  latest_by?: string;
}

const LIST_MAX = 100;

export function aheadToolFor(eng: Engine, rt: BotRuntime, opts: { threadId?: string } = {}): BotTool {
  const main = rt.folder.file.role === "main";
  const time = aheadLevel(rt) === "time";
  return {
    name: AHEAD_TOOL,
    description: [
      "Dated items on Ahead, the person's screen of what is coming.",
      "Add one when you promise something by a time (will-do), an outside date is set (deadline), you start waiting for someone (waiting), or for another dated thing they should see (note).",
      "Not your own steps, meetings or dated to-dos. Items stay inside Pobots.",
      "Keep yours true: move, done, drop.",
      "add: kind, title, day. move: id, day. done, drop: id. list: open items, or day to to.",
      `Days YYYY-MM-DD, times HH:MM, ${eng.tz}.`,
      "You hear at your next turn when the person changes one.",
      ...(main ? ["You may act on any bot's items; name the bot on add, and on list for one bot."] : []),
      ...(time && !main ? ["your-time asks for the person's time to look at something; day means not before; Pobots picks a free slot in working hours."] : []),
      ...(main ? ["You are responsible for the person's time: add or move any your-time; with a time you set it, else Pobots picks a free slot. Yours are focus blocks. week_note: title is the note atop Ahead, empty clears; offer it Monday mornings."] : []),
    ].join(" "),
    shape: {
      action: main ? z.enum(["add", "move", "done", "drop", "list", "week_note"]) : z.enum(["add", "move", "done", "drop", "list"]),
      id: z.string().optional(),
      kind: z.enum(["will-do", "deadline", "waiting", "note", "your-time"]).optional(),
      title: z.string().optional(),
      day: z.string().optional(),
      time: z.string().optional().describe("Empty on move clears it"),
      label: z.string().optional().describe("Such as a project"),
      why: z.string().optional().describe("One line"),
      todo: z.string().optional().describe("Its to-do's id"),
      to: z.string().optional(),
      ...(main ? { bot: z.string().optional() } : {}),
      ...(time ? { minutes: z.number().int().optional().describe(main ? "5-120, yours to 480" : "5-120"), latest_by: z.string().optional() } : {}),
    },
    handler: async (args) => aheadItemFor(eng, rt, args as unknown as AheadArgs, opts.threadId),
  };
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function aheadItemFor(eng: Engine, rt: BotRuntime, a: AheadArgs, threadId?: string): ToolResult | Promise<ToolResult> {
  if (!eng.store.isOpen) return problem("Pobots is stopping, so nothing changed on Ahead.");
  const main = rt.folder.file.role === "main";
  const today = dayOf(eng.clock(), eng.tz);
  // The bot the call is about: its own, or for the main bot the one it names.
  let owner = rt;
  if (main && a.bot?.trim()) {
    const named = eng.findBot(a.bot);
    if (!named) return problem(`There is no bot called ${a.bot.trim()}. list_bots shows them.`);
    owner = named;
  }
  switch (a.action) {
    case "week_note":
      return weekNote(eng, rt, a);
    case "list":
      return list(eng, main && !a.bot?.trim() ? undefined : owner, a, today);
    case "add":
      return add(eng, rt, owner, a, today, threadId);
    case "move":
    case "done":
    case "drop":
      return change(eng, rt, a, today);
  }
  return problem("action is add, move, done, drop or list.");
}

function add(eng: Engine, rt: BotRuntime, owner: BotRuntime, a: AheadArgs, today: string, threadId?: string): ToolResult | Promise<ToolResult> {
  const kind = a.kind ?? "note";
  if (kind === "your-time") return addYourTime(eng, rt, owner, a, threadId);
  const title = clean(a.title, 1000);
  if (!title) return problem("add needs a title.");
  if (title.length > AHEAD_TITLE_MAX) return problem(`Keep the title under ${AHEAD_TITLE_MAX} characters.`);
  if (!isDay(a.day)) return problem("add needs a day as YYYY-MM-DD.");
  if (a.day < today) return problem(`That day has passed. Today is ${today}.`);
  if (a.time && !isTime(a.time)) return problem("time is HH:MM, such as 14:30.");
  const botId = owner.folder.id;
  const same = eng.store.ahead.list({ botId, from: a.day, to: a.day }).find((i) => i.title === title);
  if (same) return ok(`Already on Ahead: ${line(eng, same, false)}`);
  if (eng.store.ahead.countOpen(botId) >= AHEAD_OPEN_MAX) {
    return problem(`${owner === rt ? "You have" : `${owner.folder.file.name} has`} ${AHEAD_OPEN_MAX} open items on Ahead. Finish or drop some first.`);
  }
  const label = clean(a.label, AHEAD_LABEL_MAX);
  const why = clean(a.why, AHEAD_WHY_MAX);
  const todo = clean(a.todo, 60);
  if (todo && !eng.store.getTodo(todo)) return problem("There is no to-do with that id.");
  const at = new Date(eng.clock()).toISOString();
  const thread = owner === rt ? (threadId ?? rt.turn?.threadId ?? rt.threadId) : undefined;
  const item: AheadItem = {
    id: newAheadId(),
    botId,
    kind,
    title,
    day: a.day,
    ...(a.time ? { time: a.time } : {}),
    ...(label ? { label } : {}),
    ...(why ? { why } : {}),
    ...(thread || todo ? { link: { ...(thread ? { threadId: thread } : {}), ...(todo ? { todoId: todo } : {}) } } : {}),
    state: "open",
    createdAt: at,
    changedAt: at,
    changedBy: rt.folder.file.role === "main" && owner !== rt ? "main" : "bot",
  };
  eng.store.ahead.put(item);
  if (owner !== rt) tellBot(eng, item, `Note from Pobots: the main bot put an item on Ahead for you: "${item.title}" (${item.id}, ${when(item)}).`);
  eng.opts.emit("ahead.items", {});
  return ok(`On Ahead: ${line(eng, item, false)}`);
}

function change(eng: Engine, rt: BotRuntime, a: AheadArgs, today: string): ToolResult | Promise<ToolResult> {
  const id = clean(a.id, 60);
  if (!id) return problem(`${a.action} needs the item's id. list shows them.`);
  const item = eng.store.ahead.get(id);
  const main = rt.folder.file.role === "main";
  if (!item || (!main && item.botId !== rt.folder.id)) return problem("You have no item on Ahead with that id. list shows yours.");
  if (item.state !== "open") return problem(`That item is already ${item.state}.`);
  if (a.action === "move" && item.kind === "your-time") return moveYourTime(eng, rt, item, a);
  const at = new Date(eng.clock()).toISOString();
  const byMain = main && item.botId !== rt.folder.id;
  const next: AheadItem = { ...item, changedAt: at, changedBy: byMain ? "main" : "bot" };
  if (a.action === "move") {
    if (!isDay(a.day)) return problem("move needs a day as YYYY-MM-DD.");
    if (a.day < today) return problem(`That day has passed. Today is ${today}.`);
    if (a.time && !isTime(a.time)) return problem("time is HH:MM, such as 14:30.");
    if (a.day !== item.day) next.movedFrom = item.day;
    next.day = a.day;
    if (a.time !== undefined) {
      if (a.time) next.time = a.time;
      else delete next.time;
    }
  } else {
    next.state = a.action === "done" ? "done" : "dropped";
  }
  eng.store.ahead.put(next);
  if (byMain) tellBot(eng, next, actionLine("the main bot", next, a.action as "move" | "done" | "drop", a.action === "move" ? item.day : undefined));
  eng.opts.emit("ahead.items", {});
  const word = a.action === "move" ? `Moved to ${when(next)}` : a.action === "done" ? "Done" : "Dropped";
  return ok(`${word}: "${next.title}" (${next.id}).`);
}

function list(eng: Engine, owner: BotRuntime | undefined, a: AheadArgs, today: string): ToolResult {
  if (a.day && !isDay(a.day)) return problem("day is YYYY-MM-DD.");
  if (a.to && !isDay(a.to)) return problem("to is YYYY-MM-DD.");
  const from = a.day;
  const to = a.to;
  const items = eng.store.ahead
    .list({ ...(owner ? { botId: owner.folder.id } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })
    // A bot's own list leaves out bots that were retired; the main bot's list too.
    .filter((i) => !i.botId || eng.bots.has(i.botId));
  if (!items.length) return ok(from ? "No open items on Ahead in that range." : "No open items on Ahead.");
  const all = !owner;
  const lines = items.slice(0, LIST_MAX).map((i) => `- ${line(eng, i, all)}${i.day < today ? " (day passed)" : ""}`);
  if (items.length > LIST_MAX) lines.push(`And ${items.length - LIST_MAX} more; ask for a shorter range with day and to.`);
  return ok(lines.join("\n"));
}

const when = (i: Pick<AheadItem, "day" | "time">) => `${dayWords(i.day)}${i.time ? ` ${i.time}` : ""}`;

function line(eng: Engine, i: AheadItem, withBot: boolean): string {
  const bits = [`${i.id}`, `${i.day}${i.time ? ` ${i.time}` : ""}`, i.kind, `"${i.title}"`];
  if (i.label) bits.push(i.label);
  if (withBot) bits.push(i.botId ? eng.nameOf(i.botId) : "the person's own");
  return bits.join(" · ");
}

/** The activity line for a call. */
export function aheadToolWords(input: Record<string, unknown>): ToolWords {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 60) : "";
  switch (input.action) {
    case "add":
      return title
        ? { done: `Put ${title} on Ahead`, running: `Putting ${title} on Ahead`, failed: `Could not put ${title} on Ahead` }
        : { done: "Put an item on Ahead", running: "Putting an item on Ahead", failed: "Could not put an item on Ahead" };
    case "move":
      return { done: "Moved an item on Ahead", running: "Moving an item on Ahead", failed: "Could not move an item on Ahead" };
    case "done":
      return { done: "Marked an item done on Ahead", running: "Marking an item done on Ahead", failed: "Could not mark an item done on Ahead" };
    case "drop":
      return { done: "Dropped an item on Ahead", running: "Dropping an item on Ahead", failed: "Could not drop an item on Ahead" };
    default:
      return { done: "Looked at Ahead", running: "Looking at Ahead", failed: "Could not look at Ahead" };
  }
}
