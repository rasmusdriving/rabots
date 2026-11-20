// The sheet of a "your time" item (Ahead part B): what to look at, Done, Move (Later today, Tomorrow,
// Next free slot, Pick a time), Not this week, Ask about this, Drop. Pobots finds the slot for the
// first four; the bot is told at its next turn. "Ask about this" opens the bot's chat.
import { useState } from "react";
import type { AheadItem, AheadPlace } from "../../../../shared/protocol";
import { messageOf } from "../../../engine/types";
import { readTime } from "../../../lib/schedule";
import { phoneGo } from "../../../state/screens";
import { store, useAppState } from "../../../state/store";
import { Dialog } from "../../Dialog";
import { openTodo } from "../../Todo";
import { BotMark } from "../rows/BotMark";
import { useAheadPage } from "../ahead-context";
import { longDate } from "../ahead-words";
import { endOf, isLate, lengthWords } from "./time-words";

const PLACES: { place: AheadPlace; label: string }[] = [
  { place: "today", label: "Later today" },
  { place: "tomorrow", label: "Tomorrow" },
  { place: "next", label: "Next free slot" },
];

/** Where a to-do's block stands in Outlook, when it is not simply there. */
function outlookWords(item: AheadItem): string | undefined {
  const o = item.outlook;
  if (!o || o.state === "made" || o.state === "deleted") return undefined;
  if (o.state === "failed") return `Not in your calendar yet: ${o.note ?? "the calendar said no"}. Pobots tries again when the block changes.`;
  if (o.state === "unsure") return "Your calendar did not answer in time. Pobots looks there before it tries again.";
  if (o.state === "gone") return "You deleted it in your calendar.";
  return o.note ? `Left in your calendar: ${o.note}.` : undefined;
}

export function YourTimeSheet({ item, onClose }: { item: AheadItem; onClose(): void }) {
  const { model, today } = useAheadPage();
  const bot = useAppState((s) => (item.botId ? s.bots.find((b) => b.id === item.botId) : undefined));
  const [now, setNow] = useState(item);
  const [day, setDay] = useState(item.day < today ? today : item.day);
  const [time, setTime] = useState(item.time ?? "09:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = now.state === "open";
  const who = item.botId ? (bot?.name ?? "A bot") : "You";
  const minutes = now.minutes ?? 30;

  const run = async (action: "done" | "drop" | "move" | "reopen", more: { day?: string; time?: string; place?: AheadPlace } = {}) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await model.act(now, action, more.day, { ...(more.time ? { time: more.time } : {}), ...(more.place ? { place: more.place } : {}) });
      setNow(next);
      if (action !== "reopen") onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const toChat = bot
    ? () => {
        onClose();
        store.leave(() =>
          phoneGo(() => {
            store.setTab(bot.id, "chat");
            store.openBot(bot.id);
          }),
        );
      }
    : undefined;
  const todo = item.forTodo ?? item.link?.todoId;
  // A to-do's block (protocol 32): Done finishes the to-do, Remove the block keeps it, and it comes back only with its to-do.
  const block = !!item.forTodo;
  const todoOpen = useAppState((s) => !!todo && s.todos.some((t) => t.id === todo));
  const calendarNote = block ? outlookWords(now) : undefined;
  const when = `${longDate(now.day)}${now.time ? ` ${now.time} to ${endOf(now.time, minutes)}` : ""}`;

  return (
    <Dialog title={now.title} onClose={onClose}>
      <div className="pb-ahead-sheet" data-ahead-sheet={item.id} data-ahead-time-sheet="">
        <div className="pb-ahead-sheet-from">
          <BotMark bot={bot} />
          <span>{`${block ? "To-do" : "Your time"} · ${who} · ${when} · ${lengthWords(minutes)}${isLate(now) ? " · Late" : ""}`}</span>
        </div>
        {now.why && <p className="pb-ahead-sheet-why">{now.why}</p>}
        {calendarNote && (
          <p className="pb-hint" data-ahead-block-calendar="">
            {calendarNote}
          </p>
        )}
        {(todo || toChat) && (
          <div className="pb-ahead-sheet-acts">
            {todo && (
              <button
                type="button"
                className="pb-btn"
                onClick={() => {
                  onClose();
                  openTodo(todo);
                }}
              >
                Open the to-do
              </button>
            )}
            {toChat && (
              <button type="button" className="pb-btn" onClick={toChat} data-ahead-ask="">
                Ask about this
              </button>
            )}
          </div>
        )}
        {open ? (
          <>
            <div className="pb-ahead-sheet-acts">
              <button type="button" className="pb-btn pb-btn-primary" disabled={busy} data-autofocus onClick={() => void run("done")}>
                Done
              </button>
              <button type="button" className="pb-btn" disabled={busy} data-ahead-drop="" onClick={() => void run("drop")}>
                {block ? "Remove the block" : "Drop"}
              </button>
            </div>
            <span className="pb-ahead-sheet-label">Move</span>
            <div className="pb-ahead-sheet-acts" role="group" aria-label="Move">
              {PLACES.map((p) => (
                <button key={p.place} type="button" className="pb-btn" disabled={busy} data-ahead-place={p.place} onClick={() => void run("move", { place: p.place })}>
                  {p.label}
                </button>
              ))}
              <button type="button" className="pb-btn" disabled={busy} data-ahead-place="next-week" onClick={() => void run("move", { place: "next-week" })}>
                Not this week
              </button>
            </div>
            <label className="pb-ahead-sheet-label" htmlFor={`ahead-pick-${item.id}`}>
              Pick a time
            </label>
            <div className="pb-ahead-sheet-move">
              <input id={`ahead-pick-${item.id}`} className="pb-input pb-ahead-day-input" type="date" min={today} value={day} onChange={(e) => setDay(e.target.value)} />
              <input
                className="pb-input pb-time-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                aria-label="Time"
                placeholder="09:00"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                onBlur={() => {
                  const t = readTime(time);
                  if (t && t !== time) setTime(t);
                }}
              />
              <button type="button" className="pb-btn" disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !readTime(time) || (day === now.day && readTime(time) === now.time)} onClick={() => void run("move", { day, time: readTime(time)! })}>
                Move
              </button>
            </div>
          </>
        ) : (
          <div className="pb-ahead-sheet-acts">
            <span className="pb-hint">{now.state === "done" ? "Done." : block ? "The block is removed. The to-do stays on your list." : "Dropped."}</span>
            {(!block || (todoOpen && now.outlook?.state !== "gone")) && (
              <button type="button" className="pb-btn" disabled={busy} onClick={() => void run("reopen")}>
                Open again
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="pb-hint app-hint-error" role="alert">
            {error}
          </div>
        )}
        <div className="pb-dialog-actions">
          <button type="button" className="pb-btn pb-btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
        {item.botId && <p className="pb-hint">{block ? `Done marks the to-do done. ${who} is told at its next turn.` : `${who} is told at its next turn.`}</p>}
      </div>
    </Dialog>
  );
}
