// The messages that wait for the bot, in a stack right above the message box (step 7a, after T3
// Code's QueuedRunsControl.tsx). Oldest first. Each of the person's own has "Steer now" while the bot
// works and a way to take it back. When the bot takes one it leaves the stack and stands in the
// chat where it was read (see lib/queue.ts).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bot, UserItem } from "../../shared/protocol";
import { steerQueued, unqueueMessage } from "../state/actions";
import { emptyThread, useAppState } from "../state/store";
import { noteStackPlace } from "../lib/queue";
import { usePhone } from "../lib/phone";
import { STEER_NOW } from "../lib/steer";
import { plural, stopHolds } from "../lib/words";
import { CloseIcon } from "./bits";

/** More than this many: one fewer shows, and "Show all" (as T3 Code). On a phone only one shows. */
const SHOWN = 3;
const SHOWN_PHONE = 1;
/** A message longer than about this many characters is cut to a few lines until it is opened. */
const LONG = 180;

export function QueueStack({ bot }: { bot: Bot }) {
  const thread = useAppState((s) => s.threads[bot.mainThreadId] ?? emptyThread);
  const bots = useAppState((s) => s.bots);
  const waiting = useMemo(() => {
    const inItems = thread.items.filter((i): i is UserItem => i.kind === "user" && i.queued);
    const older = (thread.waiting ?? []).filter((w) => w.queued && !thread.items.some((i) => i.id === w.id));
    return [...older, ...inItems].sort((a, b) => a.seq - b.seq);
  }, [thread.items, thread.waiting]);
  const [all, setAll] = useState(false);
  const phone = usePhone();
  if (!waiting.length) return null;
  const most = phone ? SHOWN_PHONE : SHOWN;
  // Not into a tidy turn, and not while a Stop holds the line.
  const working = (bot.state === "thinking" || bot.state === "working" || (bot.state === "waiting" && !bot.atRest)) && !bot.context?.tidying && !stopHolds(bot);
  const shown = waiting.length > most && !all ? waiting.slice(0, Math.max(1, most - 1)) : waiting;
  return (
    <section className="pb-queue" aria-label={plural(waiting.length, "waiting message")}>
      <ol className="pb-queue-list">
        {shown.map((item, i) => (
          <QueuedRow key={item.id} item={item} bot={bot} bots={bots} working={working} n={i + 1} of={waiting.length} />
        ))}
      </ol>
      {waiting.length > most && (
        <button type="button" className="pb-queue-more app-activity-btn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${waiting.length} waiting`}
        </button>
      )}
      <p className="app-line pb-queue-line">{stopHolds(bot) ? `Queued, ${bot.name} will read this when you write again` : `Queued, ${bot.name} will read this next`}</p>
    </section>
  );
}

/** Who a waiting message is from, when it is not the person's own. */
function fromWords(item: UserItem, bots: Bot[]): string | undefined {
  switch (item.from.type) {
    case "you":
      // Step 7c: his answer to a to-do says so here too, as it does in the chat.
      // Protocol 22: so does his answer to a card that came back after a restart.
      // Protocol 23: his question about a to-do or card says so instead.
      if (item.from.question) return item.from.todo ? `Question on your to-do: ${item.from.todo.title}` : item.from.card ? `Question on your card: ${item.from.card.title}` : undefined;
      return item.from.todo ? `From your to-do: ${item.from.todo.title}` : item.from.card ? `From your card: ${item.from.card.title}` : undefined;
    case "bot": {
      const id = item.from.botId;
      return `From ${bots.find((b) => b.id === id)?.name ?? "another bot"}`;
    }
    case "trigger":
      return `From ${item.from.label}`;
    case "connection":
      return `From ${item.from.name} in another Pobots`;
    case "channel":
      return `From ${item.from.sender} in ${item.from.label}`;
    case "app":
      return "From Pobots";
  }
}

function QueuedRow({ item, bot, bots, working, n, of }: { item: UserItem; bot: Bot; bots: Bot[]; working: boolean; n: number; of: number }) {
  const row = useRef<HTMLLIElement>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  // Just before it leaves: where it stood, so it can glide from there into the chat.
  useLayoutEffect(() => {
    const el = row.current;
    return () => {
      if (el) noteStackPlace(item.id, el.querySelector(".pb-queued-bubble") ?? el);
    };
  }, [item.id]);
  const mine = item.from.type === "you";
  // An answer to a to-do cannot be taken back: the to-do has left the list with it (step 7c).
  // Nor an answer to a card: it has left the rail with it (protocol 22).
  const takeBack = mine && !(item.from.type === "you" && (item.from.todo || item.from.card));
  const from = fromWords(item, bots);
  const files = item.attachments?.length ?? 0;
  const text = item.text.trim() || (files ? plural(files, "file") : "");
  const long = text.length > LONG || text.split("\n").length > 3;
  const act = (fn: () => Promise<unknown>) => {
    if (asking) return;
    setAsking(true);
    setError(false);
    fn()
      .catch(() => setError(true))
      .finally(() => setAsking(false));
  };
  return (
    <li className="pb-queued" ref={row} data-from={item.from.type} data-item={item.id} aria-label={`Waiting message ${n} of ${of}`}>
      {from && <span className="pb-queued-from">{from}</span>}
      {long ? (
        <button type="button" className="pb-queued-bubble" data-open={open || undefined} aria-expanded={open} title={open ? "Show less" : "Show all"} onClick={() => setOpen(!open)}>
          <span className="pb-queued-text">{text}</span>
        </button>
      ) : (
        <div className="pb-queued-bubble">
          <span className="pb-queued-text">{text}</span>
        </div>
      )}
      {(mine || files > 0) && (
        <div className="pb-queued-actions">
          {files > 0 && item.text.trim() && <span className="pb-queued-files">{plural(files, "file")}</span>}
          {mine && working && (
            <button type="button" className="app-you-steer" aria-disabled={asking || undefined} onClick={() => act(() => steerQueued(bot.id, item.id))}>
              {STEER_NOW}
            </button>
          )}
          {takeBack && (
            <button
              type="button"
              className="pb-queued-remove"
              aria-label="Remove this waiting message"
              title="Remove"
              aria-disabled={asking || undefined}
              onClick={() => act(() => unqueueMessage(bot.id, item.id))}
            >
              <CloseIcon />
            </button>
          )}
          {error && <span className="pb-queued-error">It is no longer waiting.</span>}
        </div>
      )}
    </li>
  );
}
