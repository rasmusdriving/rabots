// A "your time" row (Ahead part B): the time and its end, the bot, what to look at, how long. While
// it runs the end is softly replaced by "Now"; no card, nothing else moves. Tapping opens its own
// sheet (YourTimeSheet, shown by the page), not the item sheet. A to-do's block is tagged "To-do".
import type { AheadItemRow } from "../../../../shared/protocol";
import { useAppState } from "../../../state/store";
import { useAheadPage } from "../ahead-context";
import { longDate, shortDate } from "../ahead-words";
import { BotMark } from "../rows/BotMark";
import { RowShell } from "../rows/RowShell";
import { endOf, isLate, lengthWords, useRunning } from "./time-words";

const STATE_WORD = { done: "Done", dropped: "Dropped" } as const;

export function YourTimeRow({ row }: { row: AheadItemRow }) {
  const { today, openItem } = useAheadPage();
  const bot = useAppState((s) => (row.item.botId ? s.bots.find((b) => b.id === row.item.botId) : undefined));
  const item = row.item;
  const runs = useRunning(item, today);
  const who = item.botId ? (bot?.name ?? "A bot") : "You";
  const minutes = item.minutes ?? 30;
  const closed = item.state !== "open" ? STATE_WORD[item.state] : undefined;
  // A row the person moved keeps its box until they leave the screen; this says where it went.
  // The quiet line is one line, cut with an ellipsis, so the row keeps its box when it changes.
  const moved = !closed && (item.day !== row.day || (item.time ?? "") !== (row.time ?? "")) ? `Moved to ${item.day === row.day ? "" : `${shortDate(item.day)} `}${item.time ?? ""}`.trim() : undefined;
  // "Now" only at the slot's own place, never on the box a move left behind.
  const running = runs && !moved;
  const late = !closed && !moved && isLate(item) ? "Late" : undefined;
  const bits = [moved, closed, late, lengthWords(minutes), who, item.label, row.away ? "Away" : undefined].filter(Boolean) as string[];
  const time = moved ? row.time : item.time;
  // A to-do's block (protocol 32) is the to-do itself on Ahead.
  const word = item.forTodo ? "To-do" : "Your time";
  return (
    <div className="pb-ahead-yt" data-now={running || undefined} data-ahead-your-time={item.id}>
      <RowShell
        dataKey={row.key}
        day={row.day}
        time={time}
        end={running ? "Now" : time ? endOf(time, minutes) : undefined}
        mark={<BotMark bot={bot} />}
        title={item.title}
        tone={closed ? "closed" : moved ? "moved" : undefined}
        meta={
          <>
            <span className="pb-ahead-tag" data-for="you">
              {word}
            </span>
            {bits.join(" · ")}
          </>
        }
        label={`${word}, ${item.title}, ${[moved ? `moved to ${longDate(item.day)} ${item.time ?? ""}`.trim() : undefined, ...bits.slice(moved ? 1 : 0)].filter(Boolean).join(", ")}${time ? `, at ${time}` : ""}${running ? ", now" : ""}`}
        onOpen={() => openItem(item)}
      />
    </div>
  );
}
