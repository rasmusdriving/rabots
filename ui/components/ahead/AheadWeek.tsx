// Week on a laptop, Day on a phone (docs/build/step-ahead-redesign.md): the shell around the grid.
// It picks the days (the next five working days; on a phone the one chosen in the strip), lays each
// day out, keeps the lines for what lies outside the working hours once they are there, hands a drop
// on to the engine, and opens a day as a list. Under the grid one quiet foot line of fixed height:
// "Done this week" and "Other days are in Agenda".
import { useMemo, useRef, useState } from "react";
import { AHEAD_DEFAULTS, type AheadItemRow, type AheadRow, type AheadView } from "../../../shared/protocol";
import { messageOf } from "../../engine/types";
import { usePhone } from "../../lib/phone";
import { useAppState } from "../../state/store";
import { useVisible } from "./AheadDays";
import { AheadDaySwitch } from "./AheadDaySwitch";
import { useAheadPage } from "./ahead-context";
import { workWeek } from "./ahead-screen-view";
import { longDate } from "./ahead-words";
import { AheadGrid, type GridDay } from "./grid/AheadGrid";
import { DaySheet } from "./grid/DaySheet";
import { useGridDrag, type DropTarget } from "./grid/grid-drag";
import { gridRange, placeDay, stretchOf } from "./grid/grid-layout";
import { movedAway } from "./grid/row-facts";

type Sheet = { kind: "day"; day: string } | { kind: "earlier" } | { kind: "done" };

export function AheadWeek({ view }: { view: AheadView }) {
  const { model } = useAheadPage();
  const phone = usePhone();
  const settings = useAppState((s) => s.ahead);
  const week = useMemo(() => workWeek(view.today, settings?.workDays), [view.today, settings?.workDays]);
  const [picked, setPicked] = useState<string>();
  const one = picked && week.includes(picked) ? picked : week[0]!;
  const days = phone ? [one] : week;
  const range = useMemo(() => gridRange(settings?.workStart ?? AHEAD_DEFAULTS.workStart, settings?.workEnd ?? AHEAD_DEFAULTS.workEnd), [settings?.workStart, settings?.workEnd]);
  const visible = useVisible();
  const earlier = visible(view.earlier);
  const rows = visible(view.rows);
  const later = visible(view.later);
  const done = visible(view.done);
  const [sheet, setSheet] = useState<Sheet>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);

  // A move leaves its old box where it was until the person leaves the screen; the item itself
  // shows at its new day and time as well.
  const arrived: AheadRow[] = [...earlier, ...rows, ...later].flatMap((r) => (movedAway(r) && r.source === "item" ? [{ ...r, day: r.item.day, time: r.item.time, changed: undefined }] : []));
  // In the order of the clock, as the engine hands rows over: what has no time first.
  const onDay = (day: string) => [...rows.filter((r) => r.day === day), ...arrived.filter((r) => r.day === day)].sort((x, y) => (x.time ?? "").localeCompare(y.time ?? ""));
  const grid: GridDay[] = days.map((day) => ({ day, layout: placeDay(onDay(day), range), earlier: day === view.today ? earlier.length : 0 }));

  // The lines outside the working hours come from the whole week as read (not from what a filter
  // lets through, and on a phone not from the one day shown), and once there they stay for the
  // visit: the hours never change their height under the person's eyes.
  const outside = useRef({ before: false, after: false });
  for (const r of [...view.rows, ...arrived]) {
    if (!week.includes(r.day)) continue;
    const s = stretchOf(r);
    if (s && s.end <= range.start) outside.current.before = true;
    if (s && s.start >= range.end) outside.current.after = true;
  }

  const drop = async (row: AheadItemRow, to: DropTarget) => {
    setMoving(true);
    setError(undefined);
    try {
      await model.act(row.item, "move", to.day, { time: to.time });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setMoving(false);
    }
  };
  const drag = useGridDrag(root, range, !phone && !moving, (row, to) => void drop(row, to));

  const omitted = rows.some((r) => !week.includes(r.day) || (r.source === "item" && !week.includes(r.item.day))) || later.length > 0;
  return (
    <div className="pb-ahead-weekview" data-ahead-weekview="">
      {phone && <AheadDaySwitch days={week} day={one} today={view.today} onPick={setPicked} />}
      <AheadGrid
        root={root}
        today={view.today}
        days={grid}
        range={range}
        single={phone}
        before={outside.current.before}
        after={outside.current.after}
        drag={phone ? undefined : { state: drag.drag, start: drag.start, swallow: drag.swallow }}
        onOpenDay={(day) => setSheet({ kind: "day", day })}
        onOpenEarlier={() => setSheet({ kind: "earlier" })}
      />
      <div className="pb-ahead-grid-foot small">
        {done.length > 0 ? (
          <button type="button" className="pb-ahead-grid-foot-btn" aria-haspopup="dialog" data-ahead-done="" onClick={() => setSheet({ kind: "done" })}>
            {`Done this week · ${done.length}`}
          </button>
        ) : (
          <span />
        )}
        {error ? (
          <span className="app-hint-error" role="alert">
            {error}
          </span>
        ) : (
          omitted && <span className="pb-ahead-grid-foot-note">Other days are in Agenda.</span>
        )}
      </div>
      {sheet?.kind === "day" && <DaySheet title={longDate(sheet.day)} rows={onDay(sheet.day)} onClose={() => setSheet(undefined)} />}
      {sheet?.kind === "earlier" && <DaySheet title="From earlier" rows={earlier} dated empty="Nothing from earlier" onClose={() => setSheet(undefined)} />}
      {sheet?.kind === "done" && <DaySheet title="Done this week" rows={done} dated done empty="Nothing done this week yet" onClose={() => setSheet(undefined)} />}
    </div>
  );
}
