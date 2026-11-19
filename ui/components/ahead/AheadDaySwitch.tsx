// The strip of days on a phone's Day view (docs/build/step-ahead-redesign.md): five columns do not
// fit a phone, so the grid shows one day and this strip switches between the working days. One fixed
// row; the chosen day is pressed in. Nothing slides: the grid below is swapped in one frame.
import { shortDate, weekdayName } from "./ahead-words";

export function AheadDaySwitch({ days, day, today, onPick }: { days: string[]; day: string; today: string; onPick(day: string): void }) {
  return (
    <div className="pb-ahead-dayswitch" role="group" aria-label="Day" data-ahead-day-switch="">
      {days.map((d) => (
        <button key={d} type="button" aria-pressed={d === day} data-day={d} data-today={d === today || undefined} aria-label={`${weekdayName(d)} ${shortDate(d)}`} onClick={() => onPick(d)}>
          <span className="pb-ahead-dayswitch-name">{d === today ? "Today" : weekdayName(d).slice(0, 3)}</span>
          <span className="pb-ahead-dayswitch-date">{Number(d.slice(8))}</span>
        </button>
      ))}
    </div>
  );
}
