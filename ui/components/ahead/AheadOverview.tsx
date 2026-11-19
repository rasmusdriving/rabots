// Overview: everything the row above the days says, in full (docs/build/step-ahead-redesign.md).
// The main bot's week note, what is new since the last visit, and Carrying with every count in
// words and the labels. It floats over the page, so opening it moves nothing. Choosing a bot or a
// label there filters the days and closes it.
import { useAppState } from "../../state/store";
import { Dialog } from "../Dialog";
import { AheadCarrying } from "./AheadCarrying";
import { useSince } from "./AheadSince";
import { WeekNote } from "./time/WeekNote";

export function AheadOverview({ onClose }: { onClose(): void }) {
  const s = useSince();
  const on = useAppState((st) => !!st.ahead?.enabled);
  if (!on) return null;
  return (
    <Dialog title="Overview" size="sheet" onClose={onClose}>
      <div className="pb-ahead-sheet pb-ahead-overview" data-ahead-overview="">
        <WeekNote />
        {s && (
          <p className="pb-ahead-since small" data-ahead-since-full="">
            {s.news && <span className="pb-ahead-change-dot" aria-hidden="true" />}
            {s.full}
          </p>
        )}
        <AheadCarrying onPick={onClose} />
        <div className="pb-dialog-actions">
          <button type="button" className="pb-btn pb-btn-quiet" data-autofocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
