// "Carrying" (protocol 31, part C; made small in the redesign, docs/build/step-ahead-redesign.md):
// what each bot carries, and "You" for the person's own items. It is also the filter: tap one to
// show only its rows, tap it again for everyone. `useCarrying` works it out once; the row above the
// days draws it as small chips (AheadSummary), and Overview draws it in full, a line per bot with
// its counts in words and the labels as chips (this file's AheadCarrying).
import { useAppState } from "../../state/store";
import type { AheadCarry, AheadView, Bot } from "../../../shared/protocol";
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
    // As the bots' counts: only what is still open. A row done during this visit keeps its box in the days, not its count.
    if (r.source !== "item" || r.item.botId || r.item.state !== "open") continue;
    onAhead++;
    if (r.day >= start && r.day <= end) due++;
  }
  return { onAhead, due };
}

function labelsOf(v: AheadView): string[] {
  return [...new Set([...v.earlier, ...v.rows, ...v.later, ...v.done].flatMap((r) => (r.source === "item" && r.item.label ? [r.item.label] : [])))].sort((a, b) => a.localeCompare(b));
}

export interface CarryLine {
  carry: AheadCarry;
  bot: Bot | undefined;
  /** A line that dropped to nothing keeps its box until the next visit, so nothing beside it moves. */
  hidden: boolean;
  /** The counts in words: "5 on Ahead", "1 due this week", "3 waiting on you". */
  words: string[];
}

export interface Carrying {
  lines: CarryLine[];
  you: { onAhead: number; due: number; words: string[] } | undefined;
  labels: string[];
  only: string | null;
  label: string;
  pick(id: string): void;
  pickLabel(text: string): void;
}

const wordsOf = (c: AheadCarry) => [
  `${c.onAhead} on Ahead`,
  `${c.due} due this week`,
  ...(c.waiting ? [`${c.waiting} waiting on you`] : []),
  ...(c.helpers ? [`${countWord(c.helpers, "helper", "helpers")} at work`] : []),
  ...(c.managers ? [`${countWord(c.managers, "task manager", "task managers")} at work`] : []),
];

export function useCarrying(): Carrying | undefined {
  const { model, only, setOnly, label, setLabel } = useAheadPage();
  const bots = useAppState((s) => s.bots);
  const v = model.view;
  if (!v) return undefined;
  const carrying = (v.screen?.carrying ?? []).filter((c) => bots.some((b) => b.id === c.botId));
  // A bot being filtered keeps its line even when it carries nothing now, so the filter can be cleared.
  if (only && only !== YOUR_ITEMS && !carrying.some((c) => c.botId === only) && bots.some((b) => b.id === only)) carrying.push({ ...NONE, botId: only });
  const mine = yours(v);
  const labels = labelsOf(v);
  if (label && !labels.includes(label)) labels.push(label);
  const carries = (c: AheadCarry) => !!(c.onAhead || c.waiting || c.helpers || c.managers) || c.botId === only;
  return {
    lines: carrying.map((carry) => ({ carry, bot: bots.find((b) => b.id === carry.botId), hidden: !carries(carry), words: wordsOf(carry) })),
    you: mine.onAhead > 0 || only === YOUR_ITEMS ? { ...mine, words: [`${mine.onAhead} on Ahead`, `${mine.due} due this week`] } : undefined,
    labels,
    only,
    label,
    pick: (id) => setOnly(only === id ? null : id),
    pickLabel: (text) => setLabel(label === text ? "" : text),
  };
}

/** Carrying in full, as Overview shows it. `onPick` runs after a line or a label was chosen. */
export function AheadCarrying({ onPick }: { onPick?: () => void }) {
  const c = useCarrying();
  if (!c) return null;
  const lines = c.lines.filter((l) => !l.hidden);
  if (!lines.length && !c.you && !c.labels.length) return <p className="pb-hint">No bot carries anything on Ahead yet.</p>;
  const pick = (id: string) => {
    c.pick(id);
    onPick?.();
  };
  return (
    <section className="pb-ahead-carry" aria-labelledby="ahead-carry-title">
      <div className="pb-ahead-carry-head">
        <h3 id="ahead-carry-title" className="label">Carrying</h3>
        {c.labels.length > 0 && (
          <div className="pb-ahead-carry-labels" role="group" aria-label="Label">
            {c.labels.map((text) => (
              <button key={text} type="button" className="pb-ahead-chip" data-ahead-label={text} aria-pressed={c.label === text} onClick={() => {
                c.pickLabel(text);
                onPick?.();
              }}>
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
      {lines.map(({ carry, bot }) => (
        <button type="button" key={carry.botId} className="pb-ahead-carry-row" data-ahead-carry-line={carry.botId} aria-pressed={c.only === carry.botId} onClick={() => pick(carry.botId)}>
          <BotMark bot={bot} />
          <span className="pb-ahead-carry-body">
            <span className="pb-ahead-carry-name">{bot?.name}</span>
            <span className="small pb-ahead-carry-counts">
              <span>{carry.onAhead} on Ahead</span>
              <span>{carry.due} due this week</span>
              {!!carry.waiting && <span className="pb-ahead-carry-wait">{carry.waiting} waiting on you</span>}
              {!!carry.helpers && <span>{countWord(carry.helpers, "helper", "helpers")} at work</span>}
              {!!carry.managers && <span>{countWord(carry.managers, "task manager", "task managers")} at work</span>}
            </span>
          </span>
        </button>
      ))}
      {c.you && (
        <button type="button" className="pb-ahead-carry-row" data-ahead-carry-line={YOUR_ITEMS} aria-pressed={c.only === YOUR_ITEMS} onClick={() => pick(YOUR_ITEMS)}>
          <BotMark bot={undefined} />
          <span className="pb-ahead-carry-body">
            <span className="pb-ahead-carry-name">You</span>
            <span className="small pb-ahead-carry-counts">
              <span>{c.you.onAhead} on Ahead</span>
              <span>{c.you.due} due this week</span>
            </span>
          </span>
        </button>
      )}
    </section>
  );
}
