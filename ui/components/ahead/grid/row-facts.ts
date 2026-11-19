// What a block in the Week grid says about its row (docs/build/step-ahead-redesign.md): the title,
// whose it is, how loud it is drawn, one quiet word, the time in words, what a tap opens and whether
// it can be dragged. The same facts draw a block in the grid, a chip in the strip on top and a chip
// on the lines outside the working hours.
import type { AheadItem, AheadRow, Bot } from "../../../../shared/protocol";
import { useAppState } from "../../../state/store";
import { openTodo } from "../../Todo";
import { useAheadPage } from "../ahead-context";
import { KIND_WORD, changeWords, shortDate, weekdayName } from "../ahead-words";
import { openSchedules } from "../rows/RunRow";
import { endOf, isLate, lengthWords } from "../time/time-words";

export interface RowFacts {
  title: string;
  bot: Bot | undefined;
  /** "meeting" is quiet, "free" a meeting marked free, "bot" stands out, "you" stands out and waits on the person. */
  tone: "meeting" | "free" | "bot" | "you";
  /** The person's own item: a plain disc where a bot's face would be. */
  own: boolean;
  /** Done or dropped during this visit, or the box a move left behind. */
  state?: "closed" | "moved";
  /** "08:30-08:55", "08:30", or nothing for a row with no time. */
  when?: string;
  /** One quiet line: "Your time · 30 min", "Scheduled run", "Moved to Tue 10:15". */
  note?: string;
  /** New or moved since the last visit. */
  mark: boolean;
  label: string;
  open?: () => void;
  /** "any": to a day, with or without a time. "timed": to a day and a time. */
  drag?: "any" | "timed";
  item?: AheadItem;
}

const short = (day: string) => weekdayName(day).slice(0, 3);

/** True for the box an item left behind when the person moved it: it stays until they leave the screen. */
export const movedAway = (r: AheadRow): boolean => r.source === "item" && r.item.state === "open" && (r.item.day !== r.day || (r.item.time ?? "") !== (r.time ?? ""));

export function useRowFacts(row: AheadRow): RowFacts {
  const { openItem, today } = useAheadPage();
  const botId = row.source === "item" ? row.item.botId : row.source === "meeting" ? undefined : row.botId;
  const bot = useAppState((s) => (botId ? s.bots.find((b) => b.id === botId) : undefined));
  const who = bot?.name ?? "A bot";
  const mark = !!row.changed;
  const changed = row.changed ? changeWords(row.changed) : undefined;
  if (row.source === "meeting") {
    const when = row.allDay ? "All day" : row.time ? `${row.time}${row.end ? `-${row.end}` : ""}` : undefined;
    return {
      title: row.title, bot: undefined, tone: row.free ? "free" : "meeting", own: false, when: row.allDay ? undefined : when, note: row.free ? "Marked free" : undefined, mark,
      label: `Meeting, ${row.title}, ${row.allDay ? "all day" : `${row.time}${row.end ? ` to ${row.end}` : ""}`}${row.free ? ", marked free" : ""}`,
    };
  }
  if (row.source === "todo") {
    return {
      title: row.title, bot, tone: "you", own: false, when: row.time, note: `For you · ${who}`, mark,
      label: `To-do for you, ${row.title}, from ${who}${row.time ? `, by ${row.time}` : ""}`, open: () => openTodo(row.todoId),
    };
  }
  if (row.source === "run") {
    return {
      title: row.title, bot, tone: "bot", own: false, when: row.time, note: `Scheduled run · ${who}`, mark,
      label: `Scheduled run, ${row.title}, ${who}, at ${row.time}`, open: bot ? () => openSchedules(bot) : undefined,
    };
  }
  const item = row.item;
  const own = !item.botId;
  const owner = own ? "You" : who;
  const closed = item.state !== "open" ? (item.state === "done" ? "Done" : "Dropped") : undefined;
  const gone = !closed && movedAway(row);
  const moved = gone ? `Moved to ${item.day === row.day ? "" : `${item.day < today || item.day > shortRange(today) ? shortDate(item.day) : short(item.day)} `}${item.time ?? ""}`.trim() : undefined;
  const yourTime = item.kind === "your-time";
  const minutes = item.minutes ?? 30;
  const when = row.time ? (yourTime ? `${row.time}-${endOf(row.time, minutes)}` : row.time) : undefined;
  const kind = yourTime ? `Your time · ${lengthWords(minutes)}${isLate(item) ? " · Late" : ""}` : KIND_WORD[item.kind];
  const status = closed ?? moved ?? changed;
  return {
    title: item.title, bot, tone: yourTime ? "you" : "bot", own, state: closed ? "closed" : gone ? "moved" : undefined, when, mark,
    note: status ?? `${kind} · ${owner}${row.away ? " · Away" : ""}`,
    label: `${yourTime ? "Your time" : KIND_WORD[item.kind]}, ${item.title}, ${[owner, item.label, row.away ? "away" : undefined, status, yourTime ? lengthWords(minutes) : undefined].filter(Boolean).join(", ")}${when ? `, at ${row.time}` : ""}`,
    open: () => openItem(item),
    drag: closed || gone ? undefined : yourTime ? "timed" : "any",
    item,
  };
}

/** The last day a weekday's short name still tells apart: six days on. */
function shortRange(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
}
