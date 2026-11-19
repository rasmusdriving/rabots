// "Carrying", the one block above the days (protocol 31, part C and the 0.39.0 review): a line per
// bot that carries something, and "You" for the person's own items. A line is the filter: tap it to
// show only that one's rows, tap it again for everyone. The labels sit quietly on the heading line
// as chips, the same way: tap one to show only that label, again to clear.
import { useAppState } from "../../state/store";
import type { AheadCarry, AheadView } from "../../../shared/protocol";
import { useAheadPage } from "./ahead-context";
import { YOUR_ITEMS } from "./ahead-screen-view";
import { addDays, countWord, mondayOf } from "./ahead-words";
import { BotMark } from "./rows/BotMark";

const NONE: AheadCarry = { botId: "", onAhead: 0, due: 0, waiting: 0, helpers: 0, managers: 0 };

/** The person's own open items: on Ahead, and due this week. */
function yours(v: AheadView): { onAhead: number; due: number } {
  const start = mondayOf(v.today);
  const end = addDays(start, 6);
  let onAhead = 0;
  let due = 0;
  for (const r of [...v.earlier, ...v.rows, ...v.later]) {
    if (r.source !== "item" || r.item.botId) continue;
    onAhead++;
    if (r.day >= start && r.day <= end) due++;
  }
  return { onAhead, due };
}

function labelsOf(v: AheadView): string[] {
  return [...new Set([...v.earlier, ...v.rows, ...v.later, ...v.done].flatMap((r) => (r.source === "item" && r.item.label ? [r.item.label] : [])))].sort((a, b) => a.localeCompare(b));
}

export function AheadCarrying() {
  const { model, only, setOnly, label, setLabel } = useAheadPage();
  const bots = useAppState((s) => s.bots);
  const v = model.view;
  if (!v) return null;
  const carrying = v.screen?.carrying ?? [];
  const lines = carrying.filter((c) => bots.some((b) => b.id === c.botId));
  // A bot being filtered keeps its line even when it carries nothing now, so the filter can be cleared.
  if (only && only !== YOUR_ITEMS && !lines.some((c) => c.botId === only) && bots.some((b) => b.id === only)) lines.push({ ...NONE, botId: only });
  const you = yours(v);
  const showYou = you.onAhead > 0 || only === YOUR_ITEMS;
  const labels = labelsOf(v);
  if (label && !labels.includes(label)) labels.push(label);
  if (!lines.length && !showYou && !labels.length) return null;
  const carries = (c: AheadCarry) => !!(c.onAhead || c.waiting || c.helpers || c.managers) || c.botId === only;
  const pick = (id: string) => setOnly(only === id ? null : id);
  return (
    <section className="pb-ahead-carry" aria-labelledby="ahead-carry-title" data-empty={(!lines.some(carries) && !showYou && !labels.length) || undefined}>
      <div className="pb-ahead-carry-head">
        <h2 id="ahead-carry-title" className="label">Carrying</h2>
        {labels.length > 0 && (
          <div className="pb-ahead-carry-labels" role="group" aria-label="Label">
            {labels.map((text) => (
              <button key={text} type="button" className="pb-ahead-chip" data-ahead-label={text} aria-pressed={label === text} onClick={() => setLabel(label === text ? "" : text)}>
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
      {lines.map((c) => {
        const bot = bots.find((b) => b.id === c.botId);
        // A line that drops to nothing keeps its box until the next visit, so nothing below it moves.
        const hidden = !carries(c);
        return (
          <button type="button" key={c.botId} className="pb-ahead-carry-row" data-ahead-carry={c.botId} data-empty={hidden || undefined}
            aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : undefined} aria-pressed={only === c.botId} onClick={() => pick(c.botId)}>
            <BotMark bot={bot} />
            <span className="pb-ahead-carry-body">
              <span className="pb-ahead-carry-name">{bot?.name}</span>
              <span className="small pb-ahead-carry-counts">
                <span>{c.onAhead} on Ahead</span>
                <span>{c.due} due this week</span>
                {!!c.waiting && <span className="pb-ahead-carry-wait">{c.waiting} waiting on you</span>}
                {!!c.helpers && <span>{countWord(c.helpers, "helper", "helpers")} at work</span>}
                {!!c.managers && <span>{countWord(c.managers, "task manager", "task managers")} at work</span>}
              </span>
            </span>
          </button>
        );
      })}
      {showYou && (
        <button type="button" className="pb-ahead-carry-row" data-ahead-carry={YOUR_ITEMS} aria-pressed={only === YOUR_ITEMS} onClick={() => pick(YOUR_ITEMS)}>
          <BotMark bot={undefined} />
          <span className="pb-ahead-carry-body">
            <span className="pb-ahead-carry-name">You</span>
            <span className="small pb-ahead-carry-counts">
              <span>{you.onAhead} on Ahead</span>
              <span>{you.due} due this week</span>
            </span>
          </span>
        </button>
      )}
    </section>
  );
}
