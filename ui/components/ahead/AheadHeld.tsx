// The held line ("2 new · Show", protocol 31): what arrived or changed while the person looks waits
// behind it. It has a fixed place at the right end of the row above the days (AheadSummary), where
// the since words stand, so nothing floats over the days and nothing moves when it comes.
import { useAheadPage } from "./ahead-context";
import { countWord } from "./ahead-words";

export function heldWords(held: { added: number; changed: number }): string {
  return held.changed === 0 ? `${held.added} new` : held.added === 0 ? countWord(held.changed, "change", "changes") : `${held.added} new, ${countWord(held.changed, "change", "changes")}`;
}

export function HeldLine() {
  const { model } = useAheadPage();
  const held = model.held;
  if (!held) return null;
  return (
    <span className="pb-ahead-held pb-fade-in" role="status" data-ahead-held="">
      <span className="pb-ahead-held-words" title={heldWords(held)}>{heldWords(held)}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={model.showHeld}>
        Show
      </button>
    </span>
  );
}
