import { useState } from "react";
import type { AheadItemRow } from "../../../shared/protocol";
import { DonePlace } from "./ahead-context";
import { useVisible } from "./AheadDays";
import { AheadRowView } from "./rows";
import { ShowDate } from "./rows/RowShell";

export function AheadDone({ rows }: { rows: AheadItemRow[] }) {
  const [open, setOpen] = useState(false);
  const done = useVisible()(rows);
  if (!done.length) return null;
  return (
    <section className="pb-ahead-day" data-ahead-done="">
      <button type="button" className="pb-ahead-fold" aria-expanded={open} onClick={() => setOpen(!open)}>{`Done this week · ${done.length}`}</button>
      {open && <div className="pb-ahead-rows pb-fade-in" data-ahead-done-rows="">
        <DonePlace.Provider value={true}><ShowDate.Provider value={true}>{done.map((r) => <AheadRowView key={r.key} row={r} />)}</ShowDate.Provider></DonePlace.Provider>
      </div>}
    </section>
  );
}
