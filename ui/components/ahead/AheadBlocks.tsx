// What stands above the days (protocol 31), in order: "Since you looked", the week note (part B) and
// "Carrying", which is also the bot and label filter (one calm block). ABOVE_DAYS is a list, each a
// file of its own. Also the held line ("2 new · Show"), which floats at the foot of the page so
// nothing moves when it comes.
import type { ComponentType } from "react";
import { useAheadPage } from "./ahead-context";
import { countWord } from "./ahead-words";
import { AheadSince } from "./AheadSince";
import { AheadCarrying } from "./AheadCarrying";
import { WeekNote } from "./time/WeekNote";

export function HeldLine() {
  const { model } = useAheadPage();
  const held = model.held;
  if (!held) return null;
  const words = held.changed === 0 ? `${held.added} new` : held.added === 0 ? countWord(held.changed, "change", "changes") : `${held.added} new, ${countWord(held.changed, "change", "changes")}`;
  return (
    <div className="pb-ahead-held pb-fade-in" role="status" data-ahead-held="">
      <span>{words}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={model.showHeld}>
        Show
      </button>
    </div>
  );
}

export const ABOVE_DAYS: ComponentType[] = [AheadSince, WeekNote, AheadCarrying];

export function AheadBlocks() {
  return (
    <>
      {ABOVE_DAYS.map((B, i) => (
        <B key={i} />
      ))}
    </>
  );
}
