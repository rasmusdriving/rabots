// A to-do with a date: it waits on the person, so its tag is the one amber thing. Tapping opens it.
import type { AheadTodoRow } from "../../../../shared/protocol";
import { useAppState } from "../../../state/store";
import { openTodo } from "../../Todo";
import { BotMark } from "./BotMark";
import { RowShell } from "./RowShell";

export function TodoRow({ row }: { row: AheadTodoRow }) {
  const bot = useAppState((s) => s.bots.find((b) => b.id === row.botId));
  const who = bot?.name ?? "A bot";
  return (
    <RowShell
      dataKey={row.key}
      day={row.day}
      time={row.time}
      mark={<BotMark bot={bot} />}
      title={row.title}
      meta={
        <>
          <span className="pb-ahead-tag" data-for="you">
            For you
          </span>
          {`To-do from ${who}`}
        </>
      }
      label={`To-do for you, ${row.title}, from ${who}${row.time ? `, by ${row.time}` : ""}`}
      onOpen={() => openTodo(row.todoId)}
    />
  );
}
