// The switch named "Fast" (step 3b): fast mode for a model that has one, beside the effort choice in
// the three places where a bot's model is chosen. As quiet as an effort option: the same type, no
// colour when it is on. Beside the name stands the model's own few words about it ("1.5x speed").
// It is a button with role "switch", so Tab reaches it and Space and Enter change it.
import { useId } from "react";
import { FAST_WORD } from "../lib/models";

/**
 * The switch as a row of the picker's effort column, under the efforts: the name and the switch on
 * one line, the model's words under the name (the column is narrow). One of the column's options,
 * so the arrow keys reach it at the end of the column.
 */
export function FastOption({ on, hint, onChange }: { on: boolean; hint?: string; onChange(on: boolean): void }) {
  const hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={FAST_WORD}
      aria-describedby={hint ? hintId : undefined}
      className="pb-option pb-fast-option"
      onClick={() => onChange(!on)}
    >
      <span className="pb-fast-name">{FAST_WORD}</span>
      <span className="pb-switch-quiet" aria-hidden="true" />
      {hint && (
        <span className="pb-option-note pb-fast-hint" id={hintId} title={hint}>
          {hint}
        </span>
      )}
    </button>
  );
}

/**
 * The switch as a field beside the effort choice, in a bot's settings and in "Add a bot": the switch,
 * its name, the model's words. It always keeps its room, also when the chosen model has no fast mode
 * (then it is out of sight and out of reach), and the room for the words is as wide as the longest
 * words of any model offered, so nothing around it moves when it comes, goes or is switched.
 */
export function FastField({ on, shown, hint, hints, onChange }: { on: boolean; shown: boolean; hint?: string; hints: string[]; onChange(on: boolean): void }) {
  const hintId = useId();
  const all = [...new Set([...hints, ...(hint ? [hint] : [])])];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={FAST_WORD}
      aria-describedby={shown && hint ? hintId : undefined}
      className="pb-fast"
      data-gone={!shown || undefined}
      aria-hidden={!shown || undefined}
      tabIndex={shown ? undefined : -1}
      inert={!shown || undefined}
      onClick={() => onChange(!on)}
    >
      <span className="pb-switch-quiet" aria-hidden="true" />
      <span className="pb-fast-name">{FAST_WORD}</span>
      {all.length > 0 && (
        <span className="pb-fast-hints">
          {all.map((h) => (
            <span key={h} className="pb-option-note pb-fast-hint" id={h === hint ? hintId : undefined} data-show={(shown && h === hint) || undefined}>
              {h}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
