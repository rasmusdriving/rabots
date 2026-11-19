// The head of Ahead (protocol 31): the name, "Thursday 19 Nov · next 14 days", and the head controls.
// HEAD_CONTROLS is a list: part C adds Add and the Agenda/Week switch here, each a file of its own.
import type { ComponentType } from "react";
import { usePhone } from "../../lib/phone";
import { PhoneBack } from "../PhoneBack";
import { useAheadPage } from "./ahead-context";
import { longDate } from "./ahead-words";
import { AheadIcon } from "./icons";
import { AheadAdd } from "./AheadAdd";
import { AheadWeekSwitch } from "./AheadWeekSwitch";

function HideMeetings() {
  const { hideMeetings, setHideMeetings, model } = useAheadPage();
  if (model.view?.meetings !== "on") return null;
  return (
    <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet" aria-pressed={hideMeetings} data-ahead-hide-meetings="" onClick={() => setHideMeetings(!hideMeetings)}>
      {hideMeetings ? "Show meetings" : "Hide meetings"}
    </button>
  );
}

export const HEAD_CONTROLS: ComponentType[] = [HideMeetings, AheadWeekSwitch, AheadAdd];

export function AheadHead() {
  const { today, week } = useAheadPage();
  const phone = usePhone();
  return (
    <>
      {phone && (
        <div className="app-phone-bar">
          <PhoneBack />
        </div>
      )}
      <header className="pb-main-head app-head pb-ahead-head">
        <span className="pb-who pb-who-mark pb-who-lg" aria-hidden="true">
          <AheadIcon />
        </span>
        <div className="app-head-text">
          <h1>Ahead</h1>
          <div className="pb-row-line">{today ? `${longDate(today)} · ${week ? "next five working days" : "next 14 days"}` : "Next 14 days"}</div>
        </div>
        <div className="pb-ahead-controls">
          {HEAD_CONTROLS.map((C, i) => (
            <C key={i} />
          ))}
        </div>
      </header>
    </>
  );
}
