// A one-off scheduled run that is on. Tapping opens the bot's schedules.
import type { AheadRunRow } from "../../../../shared/protocol";
import { phoneGo } from "../../../state/screens";
import { store, useAppState } from "../../../state/store";
import { BotMark } from "./BotMark";
import { RowShell } from "./RowShell";

export function RunRow({ row }: { row: AheadRunRow }) {
  const bot = useAppState((s) => s.bots.find((b) => b.id === row.botId));
  const who = bot?.name ?? "A bot";
  return (
    <RowShell
      dataKey={row.key}
      day={row.day}
      time={row.time}
      mark={<BotMark bot={bot} />}
      title={row.title}
      meta={`Scheduled run · ${who}`}
      label={`Scheduled run, ${row.title}, ${who}, at ${row.time}`}
      onOpen={
        bot
          ? () =>
              store.leave(() =>
                phoneGo(() => {
                  store.setTab(bot.id, "triggers");
                  store.openBot(bot.id);
                }),
              )
          : undefined
      }
    />
  );
}
