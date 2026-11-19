// The Week grid (docs/build/step-ahead-redesign.md): a column per day, height is time. From the top:
// the days' names, the strip of things with no time (four fixed lines a day; a bot's thing takes two
// of them when there is room, so its title can be read), one thin line for
// what lies before the working hours when the week has such things, the working hours themselves,
// and one line for what lies after. The hours fill the room that is left, so the whole working day
// shows without scrolling; only in a window too low for 48px an hour do they scroll inside
// themselves. Everything is placed in percent (grid-layout.ts): nothing is measured, nothing settles.
import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import type { AheadRow } from "../../../../shared/protocol";
import { countWord, longDate, shortDate, weekdayName } from "../ahead-words";
import { GridBlock, type BlockDrag } from "./GridBlock";
import { ghostPlace, type GridDragState } from "./grid-drag";
import { STRIP_LINES, STRIP_LINES_PHONE, hoursOf, stripOf, timeOf, type DayLayout, type GridRange } from "./grid-layout";

export interface GridDay {
  day: string;
  layout: DayLayout;
  /** Open items whose day passed: one chip at the top of today's strip. */
  earlier: number;
}

interface Props {
  root: RefObject<HTMLDivElement | null>;
  today: string;
  days: GridDay[];
  range: GridRange;
  /** A phone's Day: one day, as tall as it needs, and the page scrolls. */
  single?: boolean;
  /** Whether the lines outside the working hours are there. */
  before: boolean;
  after: boolean;
  drag?: { state: GridDragState | undefined; start: BlockDrag["start"]; swallow: BlockDrag["swallow"] };
  onOpenDay(day: string): void;
  onOpenEarlier(): void;
}

const pct = (n: number) => `${Math.round(n * 100000) / 1000}%`;
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The minute of the day by this window's clock, only on the engine's today. It ticks each half minute. */
function useNow(today: string): number | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = new Date();
  return localDay(now) === today ? now.getHours() * 60 + now.getMinutes() : undefined;
}

/** A moved item shows twice on a day when only its time changed: the box it left and where it is now. */
export const rowKey = (r: AheadRow) => `${r.key}|${r.time ?? ""}`;

export function AheadGrid({ root, today, days, range, single, before, after, drag, onOpenDay, onOpenEarlier }: Props) {
  const now = useNow(today);
  const hours = hoursOf(range);
  const span = range.end - range.start;
  const dragOf = (row: AheadRow, day: string): BlockDrag | undefined =>
    drag && { source: drag.state?.row.key === row.key && drag.state.row.day === day && (drag.state.row.time ?? "") === (row.time ?? ""), start: drag.start, swallow: drag.swallow };
  const target = drag?.state?.target;
  const lines = single ? STRIP_LINES_PHONE : STRIP_LINES;
  const vars = { "--days": days.length, "--hours": hours, "--strip-lines": lines } as CSSProperties;

  const band = (which: "before" | "after") => (
    <div className="pb-ahead-grid-row pb-ahead-grid-band" data-ahead-band={which}>
      <span className="pb-ahead-grid-gutter">{which === "before" ? "Before" : "After"}</span>
      {days.map(({ day, layout }) => {
        const rows = layout[which];
        return (
          <div key={day} className="pb-ahead-grid-cell" data-today={day === today || undefined}>
            {rows.length === 1 && <GridBlock row={rows[0]!} showTime />}
            {rows.length > 1 && (
              <button type="button" className="pb-ahead-grid-more" aria-haspopup="dialog" aria-label={`${countWord(rows.length, "thing", "things")} ${which} ${timeOf(which === "before" ? range.start : range.end)} on ${longDate(day)}`} onClick={() => onOpenDay(day)}>
                {`${rows.length} ${which === "before" ? "earlier" : "later"}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="pb-ahead-grid" ref={root} data-ahead-week="" data-days={days.length} data-single={single ? "" : undefined} data-ahead-dragging={drag?.state ? "" : undefined} style={vars}>
      <div className="pb-ahead-grid-row pb-ahead-grid-head">
        <span className="pb-ahead-grid-gutter" />
        {days.map(({ day }) => (
          <button key={day} type="button" className="pb-ahead-grid-day" id={`ahead-week-${day}`} data-today={day === today || undefined} aria-haspopup="dialog" aria-label={`${longDate(day)}, open as a list`} onClick={() => onOpenDay(day)}>
            <span className="pb-ahead-grid-day-name">
              {day === today ? (
                "Today"
              ) : (
                <>
                  <span data-short="">{weekdayName(day).slice(0, 3)}</span>
                  <span data-long="">{weekdayName(day)}</span>
                </>
              )}
            </span>
            <span className="pb-ahead-grid-day-date">{shortDate(day)}</span>
          </button>
        ))}
      </div>

      <div className="pb-ahead-grid-row pb-ahead-grid-strip">
        <span className="pb-ahead-grid-gutter">Any time</span>
        {days.map(({ day, layout, earlier }) => {
          // On a phone a chip is as wide as the screen, so one line holds its title.
          const { shown, hidden, tall } = stripOf(layout.untimed, earlier > 0, lines, !single);
          return (
            <div key={day} className="pb-ahead-grid-cell" data-ahead-strip-day={day} data-today={day === today || undefined} data-drop-target={(target?.day === day && target.time === null) || undefined}>
              {earlier > 0 && (
                <button type="button" className="pb-ahead-grid-more" data-ahead-earlier="" aria-haspopup="dialog" onClick={onOpenEarlier}>
                  {`From earlier · ${earlier}`}
                </button>
              )}
              {shown.map((r) => (
                <GridBlock key={rowKey(r)} row={r} drag={dragOf(r, day)} twoLines={tall && r.source !== "meeting"} />
              ))}
              {hidden > 0 && (
                <button type="button" className="pb-ahead-grid-more" data-ahead-strip-more="" aria-haspopup="dialog" aria-label={`${hidden} more on ${longDate(day)}`} onClick={() => onOpenDay(day)}>
                  {`${hidden} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {before && band("before")}

      <div className="pb-ahead-grid-body" data-ahead-grid-body="">
        <div className="pb-ahead-grid-hours">
          <div className="pb-ahead-grid-gutter pb-ahead-grid-times" aria-hidden="true">
            {Array.from({ length: hours }, (_, i) => (
              <span key={i} style={{ top: pct(i / hours) }}>
                {timeOf(range.start + i * 60)}
              </span>
            ))}
          </div>
          {days.map(({ day, layout }) => (
            <section key={day} className="pb-ahead-grid-col" aria-labelledby={`ahead-week-${day}`} data-ahead-week-day={day} data-today={day === today || undefined}>
              {layout.blocks.map((b) => (
                <GridBlock key={rowKey(b.row)} row={b.row} drag={dragOf(b.row, day)} style={{ top: pct(b.top), height: pct(b.height), left: pct(b.left), width: pct(b.width) }} />
              ))}
              {layout.folded.map((f) => (
                <div key={f.rows[0]!.key} className="pb-ahead-blk" style={{ top: pct(f.top), height: pct(f.height), left: pct(f.left), width: pct(f.width) }}>
                  <button type="button" className="pb-ahead-blk-box pb-ahead-grid-folded" data-ahead-folded="" aria-haspopup="dialog" aria-label={`${f.rows.length} more at this time on ${longDate(day)}`} title={f.rows.map((r) => (r.source === "item" ? r.item.title : r.title)).join(" · ")} onClick={() => onOpenDay(day)}>
                    {`+${f.rows.length}`}
                  </button>
                </div>
              ))}
              {target?.day === day && target.time !== null && drag?.state && (
                <div className="pb-ahead-grid-ghost" data-ahead-ghost="" style={{ top: pct(ghostPlace(target.time, drag.state.minutes, range).top), height: pct(ghostPlace(target.time, drag.state.minutes, range).height) }}>
                  {`${weekdayName(day).slice(0, 3)} ${target.time}`}
                </div>
              )}
              {day === today && now !== undefined && now >= range.start && now < range.end && <div className="pb-ahead-grid-now" data-ahead-now="" aria-hidden="true" style={{ top: pct((now - range.start) / span) }} />}
            </section>
          ))}
        </div>
      </div>

      {after && band("after")}
    </div>
  );
}
