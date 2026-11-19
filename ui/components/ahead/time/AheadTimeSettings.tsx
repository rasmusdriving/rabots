// Settings, Ahead, "Your time" (part B): working hours, working days and the most minutes of "your
// time" a day. Bots' requests for the person's time are placed inside these. Shown while Ahead is on.
// The main bot changes the same with change_settings ahead_time.
import { useEffect, useState } from "react";
import type { AheadSettings } from "../../../../shared/protocol";
import { useSaver } from "../../../lib/hooks";
import { dayLong, dayShort, readTime, WEEKDAYS } from "../../../lib/schedule";
import { engineRequest } from "../../../state/actions";
import { store, useAppState } from "../../../state/store";
import { SectionHead } from "../../SettingsView";

const MINUTES = [30, 60, 90, 120, 180, 240, 300, 360, 420, 480];

export function AheadTimeSettings() {
  const [state, save] = useSaver();
  const ahead = useAppState((s) => s.ahead);
  const [start, setStart] = useState(ahead?.workStart ?? "08:00");
  const [end, setEnd] = useState(ahead?.workEnd ?? "17:00");
  useEffect(() => {
    if (ahead) {
      setStart(ahead.workStart);
      setEnd(ahead.workEnd);
    }
  }, [ahead?.workStart, ahead?.workEnd]);
  if (!ahead?.enabled) return null;

  const put = (patch: Partial<Pick<AheadSettings, "workStart" | "workEnd" | "workDays" | "minutesPerDay">>) =>
    void save(async () => {
      const r = await engineRequest("ahead.settings.set", patch);
      store.event({ event: "ahead.changed", data: r });
    });
  const leave = (which: "workStart" | "workEnd", text: string, set: (v: string) => void) => {
    const t = readTime(text);
    if (!t) return set(ahead[which]);
    set(t);
    if (t !== ahead[which]) put({ [which]: t });
  };
  const minutes = MINUTES.includes(ahead.minutesPerDay) ? MINUTES : [...MINUTES, ahead.minutesPerDay].sort((a, b) => a - b);

  return (
    <section className="pb-section" aria-labelledby="set-ahead-time" data-ahead-time-settings="">
      <SectionHead id="set-ahead-time" title="Your time" state={state} />
      <p className="pb-section-text">Bots you allow can ask for some of your time to look at what they did. Pobots puts it in a free slot inside these hours, around your meetings.</p>
      <div className="pb-ahead-hours">
        <label className="pb-label" htmlFor="set-ahead-start">
          Working hours
        </label>
        <div className="pb-ahead-hours-row">
          <input id="set-ahead-start" className="pb-input pb-time-input" type="text" inputMode="numeric" autoComplete="off" maxLength={5} aria-label="Start" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => leave("workStart", start, setStart)} />
          <span aria-hidden="true">to</span>
          <input className="pb-input pb-time-input" type="text" inputMode="numeric" autoComplete="off" maxLength={5} aria-label="End" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={() => leave("workEnd", end, setEnd)} />
        </div>
      </div>
      <div className="pb-ahead-hours">
        <span className="pb-label" id="set-ahead-days">
          Working days
        </span>
        <div className="pb-days" role="group" aria-labelledby="set-ahead-days">
          {WEEKDAYS.map((d) => {
            const on = ahead.workDays.includes(d);
            return (
              <button
                key={d}
                className="pb-day"
                type="button"
                aria-pressed={on}
                aria-label={dayLong(d)}
                disabled={on && ahead.workDays.length === 1}
                onClick={() => put({ workDays: on ? ahead.workDays.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || ahead.workDays.includes(x)) })}
              >
                {dayShort(d)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pb-ahead-hours">
        <label className="pb-label" htmlFor="set-ahead-minutes">
          Your time a day, at most
        </label>
        <select id="set-ahead-minutes" className="pb-input pb-select pb-ahead-minutes" value={ahead.minutesPerDay} onChange={(e) => put({ minutesPerDay: Number(e.target.value) })}>
          {minutes.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} ${m === 60 ? "hour" : "hours"}`}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
