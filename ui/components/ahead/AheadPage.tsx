// Ahead, the screen for what is coming (protocol 31, docs/build/step-ahead.md). In the reading panel
// on the laptop, as a channel's page is; on a phone a screen of its own with Back to Bots.
// The shell only: the head, the blocks above the days, the days, the item sheet, the empty state.
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
import { AheadBlocks, HeldLine } from "./AheadBlocks";
import { AheadDays } from "./AheadDays";
import { AheadHead } from "./AheadHead";
import { ItemSheet } from "./ItemSheet";

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
  const today = model.view?.today ?? "";
  const ctx = useMemo<AheadPageContext>(() => ({ today, model, openItem: setSheet, only, setOnly, hideMeetings, setHideMeetings, label, setLabel, week, setWeek }), [today, model, only, hideMeetings, setHideMeetings, label, week, setWeek]);
  const v = model.view;
  const empty = v && !v.earlier.length && !v.rows.length && !v.later.length;
  return (
    <AheadContext.Provider value={ctx}>
      <main className="pb-main app-main app-ahead" aria-label="Ahead" inert={covered || undefined} aria-hidden={covered || undefined}>
        <AheadHead />
        <div className="app-view pb-main-scroll app-ahead-scroll">
          <div className="pb-ahead-page">
            {model.error && !v && (
              <div className="pb-hint app-hint-error" role="alert">
                {model.error}
              </div>
            )}
            {v && (
              <div className="pb-fade-in">
                <AheadBlocks />
                {week ? <AheadWeek view={v} /> : empty ? <Empty meetings={v.meetings} /> : <AheadDays view={agendaView(v)} />}
                <AheadDone rows={v.done} />
              </div>
            )}
            {/* Floats at the foot of the page: it takes no room above the rows, so nothing moves when it comes. */}
            <div className="pb-ahead-held-slot">
              <HeldLine />
            </div>
          </div>
        </div>
        {sheet && <ItemSheet item={sheet} onClose={() => setSheet(null)} />}
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
