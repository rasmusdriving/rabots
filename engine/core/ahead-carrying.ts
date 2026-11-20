// Carrying counts the plan and the work around it. Meetings and the person's own items have no bot.
// "Waiting on you": open to-dos, cards, and a bot's open your-time asks up to the end of this week.
import type { AheadCarry, AheadRow } from "../../shared/ahead.js";
import type { Engine } from "../engine.js";
import { addDays, mondayOf } from "./ahead-days.js";
import { managerState } from "./task-managers.js";
import { away } from "./vacation.js";

export function aheadCarrying(eng: Engine, today: string, rows: AheadRow[]): AheadCarry[] {
  const start = mondayOf(today);
  const end = addDays(start, 6);
  const counts = new Map<string, AheadCarry>();
  for (const botId of eng.bots.keys()) counts.set(botId, { botId, onAhead: 0, due: 0, waiting: 0, helpers: 0, managers: 0 });

  for (const r of rows) {
    if (r.source === "meeting") continue;
    const botId = r.source === "item" ? r.item.botId : r.botId;
    const c = botId ? counts.get(botId) : undefined;
    if (!c) continue;
    c.onAhead++;
    // A to-do's block is its to-do, counted below with the open to-dos (engine 0.41.0).
    if (r.source === "item" && r.item.forTodo) continue;
    if (r.source !== "todo" && r.day >= start && r.day <= end) c.due++;
    // A bot's ask for the person's time this week (or passed) waits on the person. The main bot's
    // own your-time are the person's focus blocks, not an ask.
    if (r.source === "item" && r.item.kind === "your-time" && r.day <= end && eng.bots.get(botId!)?.folder.file.role !== "main") c.waiting++;
  }
  for (const t of eng.store.openTodos()) {
    const c = counts.get(t.botId);
    if (!c || away(eng.bots.get(t.botId))) continue;
    c.waiting++;
    const day = t.due?.slice(0, 10);
    if (day && day >= start && day <= end) c.due++;
  }
  for (const { card } of eng.cards.values()) {
    if (card.kind === "system" || away(eng.bots.get(card.botId))) continue;
    const c = counts.get(card.botId);
    if (c) c.waiting++;
  }
  for (const [id, rt] of eng.bots) {
    if (away(rt)) continue;
    const c = counts.get(id)!;
    for (const m of rt.managers.values()) if (managerState(eng, rt, m) === "working") c.managers++;
    for (const h of rt.helpers.values()) if (!h.manager) c.helpers++;
  }
  return [...counts.values()].filter((c) => c.onAhead || c.waiting || c.helpers || c.managers);
}
