// What a bot is told about its Ahead items at its next turn, never by waking it (engine 0.39.0):
// what the person (or the main bot) did to one, and, once, that an item's day passed.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { AheadItem } from "../../shared/protocol.js";
import { aheadTool } from "./ahead-settings.js";
import { dayOf, dayWords } from "./ahead-days.js";

const when = (item: Pick<AheadItem, "day" | "time">) => `${dayWords(item.day)}${item.time ? ` ${item.time}` : ""}`;

/** Queues a line for the item's bot's next turn in its main chat. Nothing for the person's own items. */
export function tellBot(eng: Engine, item: AheadItem, text: string): void {
  const rt = item.botId ? eng.bots.get(item.botId) : undefined;
  if (!rt) return;
  eng.store.addNews(rt.folder.id, rt.threadId, text);
}

export function actionLine(who: "the person" | "the main bot", item: AheadItem, action: "done" | "drop" | "move" | "reopen", from?: string): string {
  const what = `your Ahead item "${item.title}" (${item.id})`;
  switch (action) {
    case "done":
      return `Note from Pobots: ${who} marked ${what} done.`;
    case "drop":
      return `Note from Pobots: ${who} dropped ${what}.`;
    case "reopen":
      return `Note from Pobots: ${who} opened ${what} again, for ${when(item)}.`;
    case "move":
      return `Note from Pobots: ${who} moved ${what}${from ? ` from ${dayWords(from)}` : ""} to ${when(item)}.`;
  }
}

/**
 * At the start of a bot's turn: one line about its open items whose day passed, each told once
 * for the day it had. Empty when there are none or the bot has no tool.
 */
export function passedNews(eng: Engine, rt: BotRuntime): string[] {
  if (!aheadTool(eng, rt)) return [];
  const today = dayOf(eng.clock(), eng.tz);
  const all = eng.store.ahead.passedUntold(rt.folder.id, today);
  if (!all.length) return [];
  eng.store.ahead.markPassedTold(all.map((i) => i.id));
  // A to-do's block that passed is not the bot's to move: its to-do is still on the list.
  const items = all.filter((i) => !i.forTodo);
  if (!items.length) return [];
  const list = items.slice(0, 10).map((i) => `"${i.title}" (${i.id}, ${when(i)})`).join("; ");
  const more = items.length > 10 ? ` and ${items.length - 10} more` : "";
  return [`Note from Pobots: the day passed for ${items.length === 1 ? "your Ahead item" : "these Ahead items"}: ${list}${more}. Move, finish or drop ${items.length === 1 ? "it" : "them"} with ahead_item.`];
}
