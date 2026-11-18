// Settings, Activity (protocol 22, docs/build/step-activity-day-view.md): one day of what happened in
// Pobots, read only, from the same reading as the main bot's activity_log. Times and labels only,
// never what was written. Built like Usage beside it, as T3 Code builds its read-only Diagnostics
// page among its settings (apps/web/src/components/settings/DiagnosticsSettings.tsx): a section, a
// "read at" line with Refresh, rows, and one quiet line when there are none.
//
// Calm by rule: the head keeps its place and size whatever the day (the day's name has a fixed room,
// Today keeps its room when hidden); while the next day is read the old rows stay, faded; nothing
// moves but that fade.
import { useEffect, useRef, useState } from "react";
import type { ActivityDay } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { clockTime } from "../lib/words";
import { readActivityDay } from "../state/actions";
import { PageBackIcon, PageForwardIcon } from "./bits";
import { ProblemLine } from "./SettingsWindow";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A YYYY-MM-DD `n` days on: calendar days, the same in any time zone. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "Today", "Yesterday", "Mon 16 Nov", with the year when it is not this year. */
export function dayName(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  return `${DAY_NAMES[at.getUTCDay()]} ${d} ${MONTHS[m! - 1]}${day.slice(0, 4) === today.slice(0, 4) ? "" : ` ${y}`}`;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

export function ActivityView() {
  /** The day last read, shown until the next one is in. */
  const [shown, setShown] = useState<ActivityDay | null>(null);
  /** The day asked for: undefined is today. */
  const [want, setWant] = useState<string | undefined>(undefined);
  const [reading, setReading] = useState(true);
  const [readAt, setReadAt] = useState("");
  const [error, setError] = useState("");
  const asked = useRef(0);
  const box = useRef<HTMLElement>(null);
  const shownDay = useRef("");

  const read = (day: string | undefined) => {
    const n = ++asked.current;
    setWant(day);
    setReading(true);
    setError("");
    readActivityDay(day)
      .then((d) => {
        if (n !== asked.current) return;
        // Another day starts at its top, as another section does.
        if (shownDay.current && shownDay.current !== d.day) box.current?.closest(".app-appsettings-scroll")?.scrollTo({ top: 0 });
        shownDay.current = d.day;
        setShown(d);
        setReadAt(new Date().toISOString());
        setReading(false);
      })
      .catch((e: unknown) => {
        if (n !== asked.current) return;
        setError(messageOf(e));
        setWant(shown?.day === shown?.today ? undefined : shown?.day);
        setReading(false);
      });
  };
  useEffect(() => {
    read(undefined);
  }, []);

  const today = shown?.today;
  /** The day the head names: the one asked for, at once, while its rows are read. */
  const day = want ?? today;
  const isToday = !!day && day === today;
  const step = (n: number) => {
    if (!day || !today) return;
    const to = addDays(day, n);
    if (to > today) return;
    read(to === today ? undefined : to);
  };
  const zone = shown && shown.tz !== browserZone() ? ` Times in ${shown.tz}.` : "";
  const status = !shown || (reading && !readAt) ? "Reading now." : reading ? "Reading the day." : `Read at ${clockTime(readAt)}.${zone}`;
  const offsets = !!shown?.rows.some((r) => r.time.length > 5);

  return (
    <section ref={box} className="pb-section pb-actday" aria-labelledby="actday-title" data-reading={reading || undefined}>
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="actday-title">
          Activity
        </h2>
      </div>
      <p className="pb-hint pb-actday-about">What happened in Pobots on a day, with times. Labels only, never what was written.</p>
      <div className="pb-actday-head">
        <button type="button" className="pb-icon-btn pb-actday-prev" aria-label="Previous day" title="Previous day" aria-disabled={!day || undefined} onClick={() => step(-1)}>
          <PageBackIcon />
        </button>
        <span className="pb-actday-name" aria-live="polite">
          {day && today ? dayName(day, today) : " "}
        </span>
        <button
          type="button"
          className="pb-icon-btn pb-actday-next"
          aria-label="Next day"
          title="Next day"
          aria-disabled={isToday || !day || undefined}
          onClick={() => step(1)}
        >
          <PageForwardIcon />
        </button>
        <button
          type="button"
          className="pb-btn pb-btn-sm pb-btn-quiet pb-actday-today"
          data-hide={isToday || !day || undefined}
          aria-hidden={isToday || !day || undefined}
          tabIndex={isToday || !day ? -1 : 0}
          onClick={() => read(undefined)}
        >
          Today
        </button>
      </div>
      <div className="pb-set7-checked pb-actday-checked">
        <span className="pb-set7-checked-text" role="status">
          {status}
        </span>
        <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-refresh" aria-disabled={reading || undefined} onClick={() => !reading && read(want)}>
          Refresh
        </button>
      </div>
      <ProblemLine text={error} />
      <div className="pb-actday-day" data-day={shown?.day}>
        {shown && shown.summary.length > 0 && (
          <div className="pb-actday-summary">
            {shown.summary.map((line) => (
              <p key={line} className="pb-hint">
                {line}
              </p>
            ))}
          </div>
        )}
        {shown && shown.rows.length === 0 && <p className="pb-hint pb-actday-empty">Nothing happened in Pobots on this day.</p>}
        {shown && shown.rows.length > 0 && (
          <ol className="pb-actday-rows" data-offsets={offsets || undefined}>
            {shown.rows.map((r, i) => (
              <li key={`${r.time}-${i}`} className="pb-actday-row" data-kind={r.kind}>
                <span className="pb-actday-time">
                  {r.time}
                  {r.end && <span className="pb-actday-end">{`to ${r.end}`}</span>}
                </span>
                <span className="pb-actday-text">
                  <span className="pb-actday-who">{r.who}</span> <span className="pb-actday-words">{r.words}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {shown?.more ? <p className="pb-hint pb-actday-more">{`${shown.more} more ${shown.more === 1 ? "row is" : "rows are"} not shown.`}</p> : null}
      </div>
    </section>
  );
}
