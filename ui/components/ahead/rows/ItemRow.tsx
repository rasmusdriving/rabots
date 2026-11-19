// An Ahead item: its kind as a quiet tag, its bot (or "You"), its label. Tapping opens the item sheet.
import { useContext } from "react";
import type { AheadItemRow } from "../../../../shared/protocol";
import { useAppState } from "../../../state/store";
import { DonePlace, useAheadPage } from "../ahead-context";
import { KIND_WORD, longDate, shortDate } from "../ahead-words";
import { BotMark } from "./BotMark";
import { RowShell } from "./RowShell";

const STATE_WORD = { done: "Done", dropped: "Dropped" } as const;

export function ItemRow({ row }: { row: AheadItemRow }) {
  const { openItem, week } = useAheadPage();
  const bot = useAppState((s) => (row.item.botId ? s.bots.find((b) => b.id === row.item.botId) : undefined));
  const item = row.item;
  const onDoneShelf = useContext(DonePlace);
  const who = item.botId ? (bot?.name ?? "A bot") : "You";
  const closed = item.state !== "open" ? STATE_WORD[item.state] : undefined;
  // A row the person moved keeps its box until they leave the screen; this says where it went.
  const moved = !closed && item.day !== row.day ? `Moved to ${week ? shortDate(item.day) : longDate(item.day)}` : undefined;
  const bits = [who, item.label, row.away ? "Away" : undefined].filter(Boolean) as string[];
  const status = closed ?? moved ?? (onDoneShelf ? "Opened again" : undefined);
  return (
    <RowShell
      dataKey={row.key}
      day={row.day}
      time={item.time}
      mark={<BotMark bot={bot} />}
      title={item.title}
      tone={closed ? "closed" : status ? "moved" : undefined}
      meta={
        <>
          <span className="pb-ahead-tag">{KIND_WORD[item.kind]}</span>
          {status ?? bits.join(" · ")}
        </>
      }
      label={`${item.title}, ${KIND_WORD[item.kind].toLowerCase()}, ${[...bits, status].filter(Boolean).join(", ")}${item.time ? `, at ${item.time}` : ""}`}
      onOpen={item.kind === "your-time" ? undefined : () => openItem(item)}
    />
  );
}
