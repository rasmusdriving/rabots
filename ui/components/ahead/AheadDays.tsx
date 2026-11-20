// The agenda (protocol 31): "From earlier" at the top of today, today and each day of the range
// that has something, then "Later" folded, grouped by week and then by month.
import { useState } from "react";
import type { AheadRow, AheadView } from "../../../shared/protocol";
import { useAheadPage } from "./ahead-context";
import { countWord, dayHead, laterGroups, shortDate } from "./ahead-words";
import { AheadRowView } from "./rows";
import { ShowDate } from "./rows/RowShell";
import { visibleRows } from "./ahead-screen-view";

/** The rows the page's choices let through: one bot (or the person's own), meetings hidden. */
export function useVisible(): (rows: AheadRow[]) => AheadRow[] {
  const { only, label, hideMeetings } = useAheadPage();
  return (rows) => visibleRows(rows, only, label, hideMeetings);
}

export function Rows({ rows }: { rows: AheadRow[] }) {
  return (
    <div className="pb-ahead-rows">
      {rows.map((r) => (
        <AheadRowView key={r.key} row={r} />
      ))}
    </div>
  );
}

export function AheadDays({ view }: { view: AheadView }) {
  const visible = useVisible();
  const earlier = visible(view.earlier);
  const rows = visible(view.rows);
  const later = visible(view.later);
  const byDay = new Map<string, AheadRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const days = [...byDay.keys()];
  if (!days.includes(view.today)) days.unshift(view.today);
  days.sort();
  return (
    <div className="pb-ahead-days">
      {earlier.length > 0 && (
        <section className="pb-ahead-day" aria-labelledby="ahead-earlier" data-ahead-day="earlier">
          <div className="pb-ahead-day-head">
            <h3 id="ahead-earlier">From earlier</h3>
            <span>{countWord(earlier.length, "item whose day passed", "items whose day passed")}</span>
          </div>
          <ShowDate.Provider value={true}>
            <Rows rows={earlier} />
          </ShowDate.Provider>
        </section>
      )}
      {days.map((day) => {
        const list = byDay.get(day) ?? [];
        const id = `ahead-day-${day}`;
        return (
          <section key={day} className="pb-ahead-day" aria-labelledby={id} data-ahead-day={day}>
            <div className="pb-ahead-day-head">
              <h3 id={id}>{dayHead(day, view.today)}</h3>
              <span>{shortDate(day)}</span>
            </div>
            {list.length ? <Rows rows={list} /> : <div className="pb-ahead-empty-day">Nothing today</div>}
          </section>
        );
      })}
      {later.length > 0 && <Later rows={later} to={view.to} />}
    </div>
  );
}

function Later({ rows, to }: { rows: AheadRow[]; to: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="pb-ahead-day" aria-labelledby="ahead-later" data-ahead-day="later">
      <button type="button" className="pb-ahead-fold" id="ahead-later" aria-expanded={open} onClick={() => setOpen(!open)}>
        {`Later · ${countWord(rows.length, "item", "items")}`}
      </button>
      {open && (
        <ShowDate.Provider value={true}>
        <div className="pb-ahead-later pb-fade-in">
          {laterGroups(rows, to).map((g) => (
            <div key={g.key} className="pb-ahead-group" data-ahead-group={g.key}>
              <h4 className="pb-ahead-group-title">{g.title}</h4>
              <Rows rows={g.rows} />
            </div>
          ))}
        </div>
        </ShowDate.Provider>
      )}
    </section>
  );
}
