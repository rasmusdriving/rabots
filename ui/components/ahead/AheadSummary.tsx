// The one row above the days (docs/build/step-ahead-redesign.md): "Carrying" as a small chip per bot
// (its face, how much it has on Ahead and, in amber, how much waits on the person; tap to filter),
// the main bot's week note cut to one line, and at the right end what is new since the last visit,
// or "1 change · Show" in the same fixed place. "Carrying" and the note open Overview with all of it
// in full. The row has one fixed height whatever it holds. What shrinks while the person looks keeps
// its box until they leave the screen (a count that waited on them and is now nothing, a chip of
// their own items that is now empty, a count with a digit less), so nothing beside it moves.
import { useRef, useState } from "react";
import { useAppState } from "../../state/store";
import { useAheadPage } from "./ahead-context";
import { YOUR_ITEMS } from "./ahead-screen-view";
import { HeldLine } from "./AheadHeld";
import { useCarrying } from "./AheadCarrying";
import { AheadOverview } from "./AheadOverview";
import { useSince } from "./AheadSince";
import { BotMark } from "./rows/BotMark";

const Chevron = () => (
  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5 6 7.5 9 4.5" />
  </svg>
);

export function AheadSummary() {
  const { model } = useAheadPage();
  const c = useCarrying();
  const s = useSince();
  const note = useAppState((st) => st.ahead?.weekNote?.text);
  const [open, setOpen] = useState(false);
  // What this visit has shown, so a box that empties keeps its place.
  const seen = useRef({ you: false, waiting: new Set<string>(), digits: new Map<string, number>() }).current;
  if (!c) return null;
  const widthOf = (id: string, n: number) => {
    const digits = Math.max(seen.digits.get(id) ?? 1, String(n).length);
    seen.digits.set(id, digits);
    return digits > 1 ? { minWidth: `${digits}ch` } : undefined;
  };
  for (const { carry } of c.lines) if (carry.waiting) seen.waiting.add(carry.botId);
  if (c.you) seen.you = true;
  return (
    <div className="pb-ahead-sum" data-ahead-summary="">
      <button type="button" className="pb-ahead-sum-open label" aria-haspopup="dialog" data-ahead-overview-open="" onClick={() => setOpen(true)}>
        Carrying
        <Chevron />
      </button>
      <div className="pb-ahead-sum-chips" role="group" aria-label="Show one bot's rows">
        {c.lines.map(({ carry, bot, hidden, words }) => (
          <button type="button" key={carry.botId} className="pb-ahead-sum-chip" data-ahead-carry={carry.botId} data-empty={hidden || undefined} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : undefined}
            aria-pressed={c.only === carry.botId} aria-label={`${bot?.name ?? "A bot"}: ${words.join(", ")}`} title={`${bot?.name ?? "A bot"} · ${words.join(" · ")}`} onClick={() => c.pick(carry.botId)}>
            <BotMark bot={bot} />
            <span className="pb-ahead-sum-name">{bot?.name}</span>
            <span className="pb-ahead-sum-n" style={widthOf(carry.botId, carry.onAhead)}>{carry.onAhead}</span>
            {(!!carry.waiting || seen.waiting.has(carry.botId)) && <span className="pb-ahead-sum-wait" data-empty={carry.waiting ? undefined : ""}>{carry.waiting}</span>}
          </button>
        ))}
        {c.you && (
          <button type="button" className="pb-ahead-sum-chip" data-ahead-carry={YOUR_ITEMS} aria-pressed={c.only === YOUR_ITEMS} aria-label={`You: ${c.you.words.join(", ")}`} title={`You · ${c.you.words.join(" · ")}`} onClick={() => c.pick(YOUR_ITEMS)}>
            <BotMark bot={undefined} />
            <span className="pb-ahead-sum-name pb-ahead-sum-you">You</span>
            <span className="pb-ahead-sum-n" style={widthOf(YOUR_ITEMS, c.you.onAhead)}>{c.you.onAhead}</span>
          </button>
        )}
        {!c.you && seen.you && (
          <span className="pb-ahead-sum-chip" data-empty="" aria-hidden="true">
            <BotMark bot={undefined} />
            <span className="pb-ahead-sum-name pb-ahead-sum-you">You</span>
            <span className="pb-ahead-sum-n" style={widthOf(YOUR_ITEMS, 0)}>0</span>
          </span>
        )}
        {c.label && (
          <button type="button" className="pb-ahead-sum-chip" data-ahead-label-on={c.label} aria-pressed="true" aria-label={`Label ${c.label}, showing only it`} title="Show every label" onClick={() => c.pickLabel(c.label)}>
            <span className="pb-ahead-sum-label">{c.label}</span>
          </button>
        )}
      </div>
      {note ? (
        <button type="button" className="pb-ahead-sum-note small" aria-haspopup="dialog" aria-label={`Week note: ${note}`} title={note} data-ahead-week-note-line="" onClick={() => setOpen(true)}>
          <span className="pb-ahead-sum-note-text">{note}</span>
          <span className="pb-ahead-sum-note-word">Week note</span>
        </button>
      ) : (
        <span className="pb-ahead-sum-note" />
      )}
      <div className="pb-ahead-sum-news small" data-news={(!model.held && s?.news) || undefined}>
        {model.held ? (
          <HeldLine />
        ) : (
          s && (
            <span className="pb-fade-in" data-ahead-since="" title={s.full}>
              {s.news && <span className="pb-ahead-change-dot" aria-hidden="true" />}
              {s.short}
            </span>
          )
        )}
      </div>
      {open && <AheadOverview onClose={() => setOpen(false)} />}
    </div>
  );
}
