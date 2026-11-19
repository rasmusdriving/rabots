import { useRef, useState, type DragEvent } from "react";
import type { AheadItemRow, AheadView } from "../../../shared/protocol";
import { messageOf } from "../../engine/types";
import { useAppState } from "../../state/store";
import { Rows, useVisible } from "./AheadDays";
import { useAheadPage } from "./ahead-context";
import { workWeek } from "./ahead-screen-view";
import { dayHead, shortDate } from "./ahead-words";
import { AheadRowView } from "./rows";
import { ShowDate } from "./rows/RowShell";

const TYPE = "application/x-pobots-ahead";

export function AheadWeek({ view }: { view: AheadView }) {
  const { model } = useAheadPage();
  const workDays = useAppState((s) => s.ahead?.workDays);
  const days = workWeek(view.today, workDays);
  const visible = useVisible();
  const earlier = visible(view.earlier);
  const rows = visible(view.rows);
  const later = visible(view.later);
  const omitted = rows.some((r) => !days.includes(r.day) || (r.source === "item" && !days.includes(r.item.day))) || later.length > 0;
  // A local move leaves its old box as a receipt. Put the item at the foot of its new
  // column, so existing cards in either column keep their positions.
  const arriving = [...earlier, ...rows, ...later].flatMap((r) =>
    r.source === "item" && r.item.kind !== "your-time" && r.item.state === "open" && r.item.day !== r.day
      ? [{ ...r, day: r.item.day, changed: undefined }]
      : [],
  );
  const dragged = useRef<AheadItemRow | null>(null);
  const [source, setSource] = useState<string>();
  const [target, setTarget] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();

  const end = () => {
    dragged.current = null;
    setSource(undefined);
    setTarget(undefined);
  };
  const start = (e: DragEvent, r: AheadItemRow) => {
    if (moving) { e.preventDefault(); return; }
    e.dataTransfer.setData(TYPE, r.key);
    e.dataTransfer.effectAllowed = "move";
    dragged.current = r;
    setSource(`${r.key}:${r.day}`);
    setError(undefined);
  };
  const over = (e: DragEvent, day: string) => {
    if (!dragged.current || dragged.current.day === day || !e.dataTransfer.types.includes(TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setTarget(day);
  };
  const drop = async (e: DragEvent, day: string) => {
    const r = dragged.current;
    if (!r || e.dataTransfer.getData(TYPE) !== r.key || day === r.day) return;
    e.preventDefault();
    dragged.current = null;
    setTarget(undefined);
    setMoving(true);
    try {
      await model.act(r.item, "move", day);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSource(undefined);
      setMoving(false);
    }
  };

  return (
    <div data-ahead-week="" className="pb-fade-in">
      {earlier.length > 0 && <details className="pb-ahead-week-earlier">
        <summary className="pb-ahead-fold">{`From earlier · ${earlier.length}`}</summary>
        <ShowDate.Provider value={true}><Rows rows={earlier} /></ShowDate.Provider>
      </details>}
      <div className="pb-ahead-week">
        {days.map((day) => {
          const list = [...rows.filter((r) => r.day === day), ...arriving.filter((r) => r.day === day)];
          return (
            <section key={day} className="pb-ahead-week-col" aria-labelledby={`ahead-week-${day}`} data-ahead-week-day={day} data-drop-target={target === day || undefined}
              onDragOver={(e) => over(e, day)} onDragLeave={(e) => {
                if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setTarget((was) => was === day ? undefined : was);
              }} onDrop={(e) => void drop(e, day)}>
              <h3 className="pb-ahead-week-title label" id={`ahead-week-${day}`}>{dayHead(day, view.today)} <span>{shortDate(day)}</span></h3>
              {list.length ? list.map((r) => {
                const draggable = r.source === "item" && r.item.kind !== "your-time" && r.item.state === "open" && r.item.day === r.day;
                return <div key={r.key} className="pb-ahead-week-slot" draggable={draggable || undefined} data-drag-source={source === `${r.key}:${r.day}` || undefined}
                  onDragStart={draggable ? (e) => start(e, r) : undefined} onDragEnd={draggable ? () => { if (dragged.current) end(); } : undefined}>
                  <AheadRowView row={r} />
                </div>;
              }) : <p className="small pb-ahead-week-empty">Nothing planned</p>}
            </section>
          );
        })}
      </div>
      {omitted && <p className="pb-hint pb-ahead-week-note">Other days are in Agenda.</p>}
      {error && <p className="pb-hint app-hint-error" role="alert">{error}</p>}
    </div>
  );
}
