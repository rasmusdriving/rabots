// The colour of a bot's face (step 7a): a row of small faces, one in each colour of the palette. A
// radio group: the arrow keys move between them.
import type { KeyboardEvent } from "react";
import { BOT_COLORS, EYE_GAPS, EYE_SHAPES, type Bot, type BotColor, type BotLook } from "../../shared/protocol";
import { Face } from "./bits";

export const COLOR_WORD: Record<BotColor, string> = { grey: "Grey", sky: "Sky", teal: "Teal", moss: "Moss", sand: "Sand", copper: "Copper", rose: "Rose", lilac: "Lilac" };

/** The colour the engine would give a new bot: the first of the palette no bot has, grey last. */
export function nextColor(bots: Bot[]): BotColor {
  const order = [...BOT_COLORS.filter((c) => c !== "grey"), "grey" as const];
  const count = (c: BotColor) => bots.filter((b) => (b.look.color ?? "grey") === c).length;
  const least = Math.min(...order.map(count));
  return order.find((c) => count(c) === least)!;
}

/** A face no bot has yet, in the order the pickers show them; when all are taken, the first. */
export function nextLook(bots: Bot[]): Pick<BotLook, "eyes" | "gap"> {
  for (const gap of EYE_GAPS) for (const eyes of EYE_SHAPES) if (!bots.some((b) => b.look.eyes === eyes && b.look.gap === gap)) return { eyes, gap };
  return { eyes: EYE_SHAPES[0]!, gap: EYE_GAPS[0]! };
}

/** `small`: a row of small faces that fits on a label's line (in "Add a bot"). */
export function ColorPicker({ look, value, onPick, labelledBy, small = false }: { look: BotLook; value: BotColor; onPick: (c: BotColor) => void; labelledBy: string; small?: boolean }) {
  const at = Math.max(0, BOT_COLORS.indexOf(value));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (at + step + BOT_COLORS.length) % BOT_COLORS.length;
    onPick(BOT_COLORS[next]!);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className={small ? "pb-colors pb-colors-sm" : "pb-colors"} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKey}>
      {BOT_COLORS.map((c, i) => (
        <button
          key={c}
          type="button"
          className="pb-face-pick pb-color-pick"
          role="radio"
          aria-checked={i === at}
          tabIndex={i === at ? 0 : -1}
          aria-label={COLOR_WORD[c]}
          title={COLOR_WORD[c]}
          data-color={c}
          onClick={() => onPick(c)}
        >
          <Face look={{ ...look, color: c }} />
        </button>
      ))}
    </div>
  );
}
