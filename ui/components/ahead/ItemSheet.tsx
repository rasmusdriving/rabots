import { useId, useState } from "react";
import type { AheadAction, AheadItem } from "../../../shared/protocol";
import { messageOf } from "../../engine/types";
import { phoneGo } from "../../state/screens";
import { historyStateWith, store, useAppState } from "../../state/store";
import { CardQuestions } from "../CardQuestions";
import { Dialog } from "../Dialog";
import { useAheadPage } from "./ahead-context";
import { moveDays } from "./ahead-screen-view";
import { KIND_WORD, longDate } from "./ahead-words";
import { aheadAsk } from "./ahead-ask";
import { BotMark } from "./rows/BotMark";

export function ItemSheet({ item, onClose }: { item: AheadItem; onClose(): void }) {
  const { model, today } = useAheadPage();
  const bot = useAppState((s) => s.bots.find((b) => b.id === item.botId));
  const [day, setDay] = useState(item.day < today ? today : item.day);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState(false);
  const dateId = useId();
  if (item.kind === "your-time") return null;

  const { tomorrow, monday, nextWeek } = moveDays(today);
  const run = async (action: AheadAction, to?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await model.act(item, action, to);
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const toChat = () => {
    if (!bot) return;
    store.leave(() => {
      onClose();
      phoneGo(() => {
        const held = store.get().helpers;
        if (held[bot.id]?.length) {
          const stacks = { ...held };
          delete stacks[bot.id];
          try { history.replaceState(historyStateWith(stacks), ""); } catch { /* The chat still opens. */ }
          store.setHelperStacks(stacks);
        }
        store.setTab(bot.id, "chat");
        store.openBot(bot.id);
      });
    });
  };
  return (
    <Dialog title={item.title} size="sheet" onClose={onClose}>
      <div className="pb-ahead-sheet" data-ahead-sheet={item.id}>
        <div className="pb-ahead-sheet-from">
          <BotMark bot={bot} />
          <span>{[KIND_WORD[item.kind], bot?.name ?? (item.botId ? "A bot" : "Added by you"), item.label, `${longDate(item.day)}${item.time ? ` ${item.time}` : ""}`].filter(Boolean).join(" · ")}</span>
        </div>
        {item.why && <p className="pb-ahead-sheet-why">{item.why}</p>}
        {item.state === "open" ? (
          <>
            <div className="pb-ahead-field">
              <span className="label">Move to</span>
              <div className="pb-ahead-sheet-acts" role="group" aria-label="Move to">
                {([["Tomorrow", tomorrow], ["Monday", monday], ["Next week", nextWeek]] as const).map(([text, date]) =>
                  <button key={text} type="button" className="pb-ahead-chip" title={longDate(date)} disabled={busy || item.day === date} onClick={() => void run("move", date)}>{text}</button>)}
              </div>
            </div>
            <div className="pb-ahead-field">
              <label className="label" htmlFor={dateId}>Pick a day</label>
              <div className="pb-ahead-sheet-move">
                <input id={dateId} className="pb-input pb-ahead-day-input" type="date" min={today} value={day} onChange={(e) => setDay(e.target.value)} />
                <button type="button" className="pb-btn" disabled={busy || !day || day < today || day === item.day} onClick={() => void run("move", day)}>Move</button>
              </div>
            </div>
            <div className="pb-ahead-sheet-acts">
              <button type="button" className="pb-btn pb-btn-primary" disabled={busy} onClick={() => void run("done")}>Done</button>
              <button type="button" className="pb-btn" disabled={busy} onClick={() => void run("drop")}>Drop</button>
            </div>
          </>
        ) : (
          <div className="pb-ahead-sheet-acts">
            <span className="pb-hint">{item.state === "done" ? "Done" : "Dropped"}</span>
            <button type="button" className="pb-btn" disabled={busy} onClick={() => void run("reopen")}>Open again</button>
          </div>
        )}
        {error && <p className="pb-hint app-hint-error" role="alert">{error}</p>}
        {bot && !bot.vacationSince && (
          <div className="pb-ahead-field">
            <CardQuestions id={item.id} place="ahead" questions={undefined} botName={bot.name} botId={bot.id} onAsk={async (text) => {
              await aheadAsk(bot.id, item, text);
              setAsked(true);
            }} />
            {asked && <p className="pb-hint" role="status">Asked in the bot's chat</p>}
          </div>
        )}
        <div className="pb-dialog-actions">
          {bot && <button type="button" className="pb-btn pb-btn-quiet" onClick={toChat}>Go to the bot's chat</button>}
          <button type="button" className="pb-btn pb-btn-quiet" onClick={onClose}>Close</button>
        </div>
      </div>
    </Dialog>
  );
}
