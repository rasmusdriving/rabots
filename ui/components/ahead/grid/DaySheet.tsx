// A day of the Week grid as a list (docs/build/step-ahead-redesign.md): everything on that day with
// its full title, as the Agenda's rows. It opens from the day's name, from "2 more" in the strip on
// top, from "+2" where more than three things share a time, and for "From earlier" and "Done this
// week". It floats over the page. Tapping a row opens what the row is about over the list, and the list is
// still there afterwards with the row's new state.
import type { ReactNode } from "react";
import type { AheadRow } from "../../../../shared/protocol";
import { Dialog } from "../../Dialog";
import { DonePlace } from "../ahead-context";
import { AheadRowView } from "../rows";
import { ShowDate } from "../rows/RowShell";

interface Props {
  title: string;
  rows: AheadRow[];
  /** Rows show their date where the time stands ("From earlier", "Done this week"). */
  dated?: boolean;
  /** The rows are done or dropped ones. */
  done?: boolean;
  empty?: string;
  onClose(): void;
}

export function DaySheet({ title, rows, dated = false, done = false, empty = "Nothing planned", onClose }: Props) {
  let list: ReactNode = rows.map((r) => <AheadRowView key={`${r.key}|${r.time ?? ""}`} row={r} />);
  if (done) list = <DonePlace.Provider value={true}>{list}</DonePlace.Provider>;
  return (
    <Dialog title={title} size="sheet" onClose={onClose}>
      <div className="pb-ahead-sheet pb-ahead-daysheet" data-ahead-day-sheet="">
        {rows.length ? (
          <div className="pb-ahead-rows">
            <ShowDate.Provider value={dated}>{list}</ShowDate.Provider>
          </div>
        ) : (
          <p className="pb-hint">{empty}</p>
        )}
        <div className="pb-dialog-actions">
          <button type="button" className="pb-btn pb-btn-quiet" data-autofocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
