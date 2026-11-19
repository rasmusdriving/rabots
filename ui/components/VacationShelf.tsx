import { useId, useState } from "react";
import type { Bot } from "../../shared/protocol";
import { messageOf } from "../engine/types";

import { setBotVacation } from "../state/actions";
import { phoneGo } from "../state/screens";
import { store } from "../state/store";
import { useRailExit, useRailLeaving } from "./rail-leaving";
import { ChevronIcon, Face } from "./bits";

const sinceDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const KEY = "pobots:vacation-shelf-open";

export function VacationShelf({ bots, selected, phone }: { bots: Bot[]; selected?: string | null; phone: boolean }) {
  const id = useId();
  const { rows, finish } = useRailLeaving(bots, (bot) => bot.id);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
  });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(KEY, String(!open)); } catch { /* The choice still holds for this page. */ }
  };
  const bringBack = async (bot: Bot) => {
    setError(undefined);
    setBusy(bot.id);
    try {
      await setBotVacation(bot.id, false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  if (!rows.length) return null;
  return (
    <section className="pb-vacation-shelf" data-empty={!bots.length || undefined} inert={!bots.length || undefined} aria-label="Bots on vacation">
      <button className="pb-btn pb-btn-sm pb-btn-quiet pb-vacation-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <ChevronIcon /> <span>On vacation</span> <span className="pb-vacation-count">{bots.length || rows.length}</span>
      </button>
      <div id={id} className="pb-vacation-motion" data-collapsed={!open || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
        <div className="pb-vacation-inner">
          <ul className="app-list" aria-label="On vacation">
            {rows.map(({ item, leaving, arriving }) => (
              <VacationRow key={item.id} bot={item} selected={selected === item.id} phone={phone} busy={!!busy} leaving={leaving} arriving={arriving} finish={finish} bringBack={bringBack} />
            ))}
          </ul>
          {error && <p className="pb-hint app-hint-error pb-vacation-feedback" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}


function VacationRow({ bot, selected, phone, busy, leaving, arriving, finish, bringBack }: {
  bot: Bot; selected: boolean; phone: boolean; busy: boolean; leaving: boolean; arriving?: true;
  finish(id: string): void; bringBack(bot: Bot): Promise<void>;
}) {
  const ref = useRailExit<HTMLLIElement>(bot.id, leaving, finish);
  return (
    <li ref={ref} className="pb-vacation-motion" data-entering={arriving && !leaving || undefined} data-leaving={leaving || undefined} inert={leaving || undefined}>
      <div className="pb-vacation-inner pb-vacation-row">
        <button
          className="pb-row app-row app-vacation-row"
          type="button"
          title={bot.name}
          aria-label={`${bot.name}, on vacation`}
          aria-current={selected ? "true" : undefined}
          onClick={() => store.leave(() => phoneGo(() => {
            store.setTab(bot.id, "chat");
            store.openBot(bot.id);
          }))}
        >
          <Face look={bot.look} state="idle" size="sm" />
          <span className="pb-row-text">
            <span className="pb-row-name">{bot.name}</span>
            <span className="pb-row-line"><time dateTime={bot.vacationSince}>Since {sinceDate.format(new Date(bot.vacationSince!))}</time></span>
          </span>
        </button>
        <button className="pb-btn pb-btn-sm pb-btn-quiet pb-vacation-quick" type="button" aria-label={`Bring back ${bot.name}`} disabled={busy || phone} onClick={() => void bringBack(bot)}>
          Bring back
        </button>
      </div>
    </li>
  );
}
