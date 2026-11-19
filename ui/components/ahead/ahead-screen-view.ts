import { AHEAD_DAYS, AHEAD_DEFAULTS, type AheadRow, type AheadSettings, type AheadView } from "../../../shared/protocol";
import { addDays, weekdayOf } from "./ahead-words";

/** Distinct from any bot id, including a bot called You. */
export const YOUR_ITEMS = "@you";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function workWeek(today: string, workDays: AheadSettings["workDays"] = AHEAD_DEFAULTS.workDays): string[] {
  const wanted = workDays.length ? workDays : AHEAD_DEFAULTS.workDays;
  const days: string[] = [];
  for (let day = today; days.length < 5; day = addDays(day, 1)) {
    if (wanted.includes(DAYS[weekdayOf(day)]!)) days.push(day);
  }
  return days;
}

export function moveDays(today: string) {
  const tomorrow = addDays(today, 1);
  const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
  // "Next week" is the same weekday a week on (a weekend day goes to the Monday after it), so it
  // lands in next week, as "Not this week" on a your-time sheet does.
  const inAWeek = addDays(today, 7);
  const w = weekdayOf(inAWeek);
  return { tomorrow, monday, nextWeek: w === 6 ? addDays(inAWeek, 2) : w === 0 ? addDays(inAWeek, 1) : inAWeek };
}

/** Agenda stays at 14 days even when a sparse work week needs a wider calendar read. */
export function agendaView(view: AheadView): AheadView {
  const to = addDays(view.today, AHEAD_DAYS - 1);
  if (to >= view.to) return view;
  return { ...view, to, rows: view.rows.filter((r) => r.day <= to), later: [...view.rows.filter((r) => r.day > to && r.source !== "meeting"), ...view.later] };
}

export function visibleRows(rows: AheadRow[], only: string | null, label: string, hideMeetings: boolean): AheadRow[] {
  return rows.filter((r) => {
    if (label && (r.source !== "item" || r.item.label !== label)) return false;
    if (r.source === "meeting") return !hideMeetings && only === null;
    if (only === null) return true;
    const botId = r.source === "item" ? r.item.botId : r.botId;
    return only === YOUR_ITEMS ? !botId : botId === only;
  });
}
