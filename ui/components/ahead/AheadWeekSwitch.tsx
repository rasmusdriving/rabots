// Agenda or Week (docs/build/step-ahead-redesign.md), remembered on this device. On a laptop Week is
// the grid of the next five working days; on a phone the same grid one day at a time, called Day.
import { useCallback, useState } from "react";
import { usePhone } from "../../lib/phone";
import { useAheadPage } from "./ahead-context";

const KEY = "pobotsAheadWeek";
const read = () => {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};

export function useWeekChoice() {
  const [week, choose] = useState(read);
  const setWeek = useCallback((on: boolean) => {
    choose(on);
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch { /* The switch still works without storage. */ }
  }, []);
  return { week, setWeek };
}

export function AheadWeekSwitch() {
  const phone = usePhone();
  const { week, setWeek } = useAheadPage();
  // A phone shows the grid one day at a time, so the choice reads "Day" there.
  return (
    <div className="pb-seg" role="group" aria-label="Ahead view" data-ahead-view-choice="">
      <button type="button" aria-pressed={!week} onClick={() => setWeek(false)}>Agenda</button>
      <button type="button" aria-pressed={week} onClick={() => setWeek(true)}>{phone ? "Day" : "Week"}</button>
    </div>
  );
}
