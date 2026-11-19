// Ahead, the screen for what is coming (protocol 31, docs/build/step-ahead.md). In the reading panel
// on the laptop, as a channel's page is; on a phone a screen of its own with Back to Bots.
// The shell only: the head, the one row above the days, the days (Agenda, or the Week grid), the
// sheet of an item, the empty state.
import { useMemo, useState } from "react";
import { usePhone } from "../../lib/phone";
import { useAppState } from "../../state/store";
import { agendaView } from "./ahead-screen-view";
import { AheadDone } from "./AheadDone";
import { AheadWeek } from "./AheadWeek";
import { useWeekChoice } from "./AheadWeekSwitch";
import type { AheadItem } from "../../../shared/protocol";
import { AheadContext, type AheadPageContext } from "./ahead-context";
import { useAhead, useHideMeetings } from "./ahead-state";
import { AheadBlocks } from "./AheadBlocks";
import { AheadDays } from "./AheadDays";
import { AheadHead } from "./AheadHead";
import { ItemSheet } from "./ItemSheet";
import { YourTimeSheet } from "./time/YourTimeSheet";

export function AheadPage({ covered = false }: { covered?: boolean }) {
  const phone = usePhone();
  const screen = useAppState((s) => s.phoneScreen);
  return phone && screen !== "bot" ? null : <AheadVisit covered={covered} />;
}

function AheadVisit({ covered }: { covered: boolean }) {
  const model = useAhead();
  const [hideMeetings, setHideMeetings] = useHideMeetings();
  const [only, setOnly] = useState<string | null>(null);
  const [sheet, setSheet] = useState<AheadItem | null>(null);
  const [label, setLabel] = useState("");
  const { week, setWeek } = useWeekChoice();
  const phone = usePhone();
  const today = model.view?.today ?? "";
  const ctx = useMemo<AheadPageContext>(() => ({ today, model, openItem: setSheet, only, setOnly, hideMeetings, setHideMeetings, label, setLabel, week, setWeek }), [today, model, only, hideMeetings, setHideMeetings, label, week, setWeek]);
  const v = model.view;
  const empty = v && !v.earlier.length && !v.rows.length && !v.later.length;
  return (
    <AheadContext.Provider value={ctx}>
      <main className="pb-main app-main app-ahead" aria-label="Ahead" inert={covered || undefined} aria-hidden={covered || undefined}>
        <AheadHead />
        <div className="app-view pb-main-scroll app-ahead-scroll" data-ahead-view={week ? (phone ? "day" : "week") : "agenda"}>
          <div className="pb-ahead-page">
            {model.error && !v && (
              <div className="pb-hint app-hint-error" role="alert">
                {model.error}
              </div>
            )}
            {v && (
              <div className="pb-fade-in pb-ahead-content">
                <AheadBlocks />
                {week ? <AheadWeek view={v} /> : empty ? <Empty meetings={v.meetings} /> : <AheadDays view={agendaView(v)} />}
                {!week && <AheadDone rows={v.done} />}
              </div>
            )}
          </div>
        </div>
        {/* One sheet for the page: an item's, or a "your time" slot's own. It floats; nothing under it moves. */}
        {sheet && (sheet.kind === "your-time" ? <YourTimeSheet item={sheet} onClose={() => setSheet(null)} /> : <ItemSheet item={sheet} onClose={() => setSheet(null)} />)}
      </main>
    </AheadContext.Provider>
  );
}

function Empty({ meetings }: { meetings: "on" | "none" | "problem" }) {
  return (
    <div className="pb-ahead-empty" data-ahead-empty="">
      <p className="pb-ahead-empty-title">Nothing ahead yet</p>
      <p className="pb-hint">Bots you allow put their dated promises, deadlines and waits here. To-dos with a date and one-off schedules show too.</p>
      {meetings === "none" && <p className="pb-hint">Meetings show here once the calendar is set up.</p>}
      {meetings === "problem" && <p className="pb-hint">The calendar could not be read just now.</p>}
    </div>
  );
}
