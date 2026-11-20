// The "Ahead" row in the bots list (protocol 31): first, above the bots, while Ahead is on. No count
// and no badge on it. It opens the screen in the reading panel, or on a phone a screen of its own.
import { AHEAD_PAGE, store, useAppState } from "../../state/store";
import { AheadIcon } from "./icons";

export function AheadRosterRow({ phone }: { phone: boolean }) {
  const on = useAppState((s) => !!s.ahead?.enabled);
  const open = useAppState((s) => s.openChannelId === AHEAD_PAGE && !s.appSettings);
  if (!on) return null;
  return (
    <div className="pb-ahead-slot">
      <button
        type="button"
        className="pb-row app-row pb-ahead-roster-row"
        aria-label="Ahead, next 14 days"
        aria-current={open ? "true" : undefined}
        data-ahead-roster=""
        onClick={() => {
          // On a phone the row opens the screen, also when it was the one open last.
          if (!open || phone) store.leave(() => store.openChannel(AHEAD_PAGE));
        }}
      >
        <span className="pb-ahead-disc" aria-hidden="true">
          <AheadIcon />
        </span>
        <span className="pb-row-text">
          <span className="pb-row-name">Ahead</span>
          <span className="pb-row-line">Next 14 days</span>
        </span>
      </button>
    </div>
  );
}
