// One thing in the Week grid (docs/build/step-ahead-redesign.md): a block as tall as its time, or a
// one-line chip in the strip on top and on the lines outside the working hours. A meeting is quiet
// and not a button. A bot's thing carries the bot's face and opens what it is about; what waits on
// the person rests on the soft amber. How much a block shows follows its own height and width
// (ahead-grid.css): a title is never broken inside a word, and a time is shown whole or not at all.
import type { CSSProperties, PointerEvent } from "react";
import type { AheadRow } from "../../../../shared/protocol";
import { useAheadPage } from "../ahead-context";
import { BotMark } from "../rows/BotMark";
import { useRunning } from "../time/time-words";
import { useRowFacts, type RowFacts } from "./row-facts";

export interface BlockDrag {
  /** True for the block being dragged. */
  source: boolean;
  start(e: PointerEvent, row: AheadRow, kind: "any" | "timed"): void;
  /** True once, right after a drag: the click that ends it opens nothing. */
  swallow(): boolean;
}

interface Props {
  row: AheadRow;
  /** Where it stands in its column, in percent. Absent: a one-line chip. */
  style?: CSSProperties;
  /** On the lines outside the working hours the time is written out before the title. */
  showTime?: boolean;
  /** A chip in the strip on top with room for its title on two lines. */
  twoLines?: boolean;
  drag?: BlockDrag;
}

function Running({ f, today }: { f: RowFacts; today: string }) {
  const runs = useRunning(f.item!, today);
  return runs && !f.state ? <span className="pb-ahead-blk-now">Now</span> : null;
}

export function GridBlock({ row, style, showTime, twoLines, drag }: Props) {
  const { today } = useAheadPage();
  const f = useRowFacts(row);
  const yourTime = f.item?.kind === "your-time";
  const loud = f.tone === "bot" || f.tone === "you";
  // A meeting says its time and nothing more; the rest is in its tooltip.
  const note = loud ? f.note : undefined;
  const inner = (
    <>
      {loud && (
        <span className="pb-ahead-blk-mark" aria-hidden="true">
          <BotMark bot={f.own ? undefined : f.bot} />
          {/* New or moved since the last visit: on the corner of the face, so it takes no room from the title. */}
          {f.mark && <span className="pb-ahead-change-dot" />}
        </span>
      )}
      <span className="pb-ahead-blk-text">
        <span className="pb-ahead-blk-line">
          {showTime && row.time && <span className="pb-ahead-blk-at">{row.time}</span>}
          {f.mark && !loud && <span className="pb-ahead-change-dot" aria-hidden="true" />}
          <span className="pb-ahead-title">{f.title}</span>
        </span>
        {style && (f.when || yourTime) && (
          <span className="pb-ahead-blk-more">
            {yourTime && f.item && <Running f={f} today={today} />}
            {f.when}
            {f.tone === "free" && <span className="pb-ahead-blk-free">Free</span>}
          </span>
        )}
        {style && note && <span className="pb-ahead-blk-note">{note}</span>}
      </span>
    </>
  );
  const hint = [f.title, f.when, f.note].filter(Boolean).join(" · ");
  const can = drag && f.drag;
  return (
    <div className="pb-ahead-blk" style={style} data-line={style ? undefined : ""} data-lines={twoLines ? 2 : undefined} data-tone={f.tone} data-state={f.state} data-drag-source={drag?.source || undefined} data-ahead-your-time={yourTime ? f.item!.id : undefined}>
      {f.open ? (
        <button
          type="button"
          className="pb-ahead-blk-box"
          data-ahead-row={row.key}
          data-draggable={can ? f.drag : undefined}
          aria-label={f.label}
          aria-haspopup="dialog"
          title={hint}
          onPointerDown={can ? (e) => drag.start(e, row, f.drag!) : undefined}
          onClick={() => {
            if (!drag?.swallow()) f.open!();
          }}
        >
          {inner}
        </button>
      ) : (
        <div className="pb-ahead-blk-box" data-ahead-row={row.key} role="group" aria-label={f.label} title={hint}>
          {inner}
        </div>
      )}
    </div>
  );
}
