import { useCallback, useState } from "react";
import { usePhone } from "../../lib/phone";
import { useAheadPage } from "./ahead-context";

const KEY = "pobotsAheadWeek";
const read = () => {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};

export function useWeekChoice() {
  const [week, choose] = useState(read);
  const phone = usePhone();
  const setWeek = useCallback((on: boolean) => {
    choose(on);
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch { /* The switch still works without storage. */ }
  }, []);
  return { week: week && !phone, setWeek };
}

export function AheadWeekSwitch() {
  const phone = usePhone();
  const { week, setWeek } = useAheadPage();
  if (phone) return null;
  return (
    <div className="pb-seg" role="group" aria-label="Ahead view" data-ahead-view-choice="">
      <button type="button" aria-pressed={!week} onClick={() => setWeek(false)}>Agenda</button>
      <button type="button" aria-pressed={week} onClick={() => setWeek(true)}>Week</button>
    </div>
  );
}
