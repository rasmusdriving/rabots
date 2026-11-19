// The right side, on the ground: what needs a decision, as raised cards, oldest first.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalCard as Approval, Bot, Card, CardDecision, NoteCard as Note, QuestionCard as Question, SystemCard as System, Upcoming } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { askCard, resolveCard } from "../state/actions";
import { store, useAppState } from "../state/store";
import { useNow } from "../lib/hooks";
import { usePhone } from "../lib/phone";
import { carried, useCarry } from "../lib/carry";
import { clockTime, expiry } from "../lib/words";
import { Face, PobotsMark } from "./bits";
import { PhoneBack } from "./PhoneBack";
import { HelpersAtWork } from "./HelpersAtWork";
import { TaskManagers } from "./TaskManagers";
import { TodoList } from "./Todo";
import { MeetingDetail } from "./MeetingCard";
import { CardQuestions } from "./CardQuestions";
import { useRailExit, useRailLeaving } from "./rail-leaving";

/** How often the "Expires in" line is brought up to date. */
const EXPIRY_TICK_MS = 15_000;

/** `covered`: the artifact panel stands in its place. It stays drawn underneath, out of sight, so nothing in it arrives again when it shows. */
export function Rail({ covered = false }: { covered?: boolean }) {
  const cards = useAppState((s) => s.cards);
  const bots = useAppState((s) => s.bots);
  const { rows: shown, finish } = useRailLeaving(cards, slotKey);
  const open = cards.length;
  const allToday = cards.every((c) => new Date(c.at).toDateString() === new Date().toDateString());
  const phone = usePhone();

  return (
    <aside className="pb-rail app-rail" aria-label="Needs you" inert={covered || undefined} aria-hidden={covered || undefined}>
      {/* On a phone the rail is the Needs you screen: its head leads back to where he came from. */}
      {phone && (
        <div className="app-phone-bar app-rail-bar">
          <PhoneBack />
        </div>
      )}
      <h2 className="pb-rail-title app-rail-title">
        Needs you {open > 0 && <span>{`${open} ${allToday ? "today" : "open"}`}</span>}
      </h2>
      {shown.length === 0 && <p className="app-rail-empty">Nothing needs you</p>}
      {shown.map(({ item: card, key, leaving }) => (
        <CardSlot key={key} card={card} slot={key} leaving={leaving} finish={finish} bot={card.kind === "system" ? undefined : bots.find((b) => b.id === card.botId)} />
      ))}
      <LaterToday />
      {/* The foot of the rail, in sight however many cards wait: the helpers that work now, across
          the bots, then the person's to-do list (step 7c). It grows upward; nothing above it moves.
          The bots' task managers stand just above the helpers (protocol 21). */}
      <div className="pb-rail-foot">
        <TaskManagers />
        <HelpersAtWork />
        <TodoList />
      </div>
    </aside>
  );
}

/**
 * The quiet "Later today" list under the cards: the scheduled runs still to come today, one line
 * per trigger at its next time, as "Name by Bot". Only there when there is something. A line opens
 * that bot's Triggers tab at that trigger.
 */
function LaterToday() {
  const upcoming = useAppState((s) => s.upcoming);
  const bots = useAppState((s) => s.bots);
  const now = useNow(60_000);
  const today = new Date(now).toDateString();
  const seen = new Set<string>();
  const items: Upcoming[] = [];
  for (const u of upcoming) {
    const at = new Date(u.at);
    // A trigger that runs every few minutes would fill the list; its next time says enough.
    if (at.toDateString() !== today || seen.has(u.triggerId)) continue;
    seen.add(u.triggerId);
    items.push(u);
  }
  if (items.length === 0) return null;
  return (
    <section className="pb-later app-later" aria-labelledby="later-title">
      <h3 className="pb-side-title pb-later-title" id="later-title">
        Later today
      </h3>
      <ul className="app-list">
        {items.map((u) => {
          const bot = bots.find((b) => b.id === u.botId);
          return (
            <li key={`${u.triggerId}-${u.at}`}>
              <button
                className="pb-later-item"
                type="button"
                onClick={() =>
                  store.leave(() => {
                    store.openBot(u.botId);
                    store.setTab(u.botId, "triggers");
                    store.openTrigger(u.botId, u.triggerId);
                  })
                }
              >
                <time dateTime={u.at}>{clockTime(u.at)}</time>
                <span className="pb-later-what">{bot ? `${u.name} by ${bot.name}` : u.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A newer Pobots card on the same topic stays in the same keyed slot. */
const slotKey = (card: Card): string => card.kind === "system" ? `system-${card.topic}` : card.id;

function CardSlot({ card, slot, leaving, finish, bot }: { card: Card; slot: string; leaving: boolean; finish: (key: string) => void; bot: Bot | undefined }) {
  const ref = useRailExit<HTMLDivElement>(slot, leaving, finish);
  const reason = store.get().removedReasons[card.id];
  return (
    <div ref={ref} className="app-card-slot app-rail-exit" inert={leaving || undefined}
      data-leaving={leaving ? (reason === "resolved" ? "resolved" : "quiet") : undefined}>
      <div className="app-rail-exit-inner">
        {card.kind === "approval" ? <ApprovalCard card={card} bot={bot} />
          : card.kind === "note" ? <NoteCard card={card} bot={bot} />
          : card.kind === "system" ? <SystemCard card={card} />
          : <QuestionCard card={card} bot={bot} />}
      </div>
    </div>
  );
}

function useDecide(cardId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (decision: CardDecision) => {
    setBusy(true);
    setError(undefined);
    resolveCard(cardId, decision).catch((e: unknown) => {
      setBusy(false);
      setError(messageOf(e));
    });
  };
  return { busy, error, decide };
}

function CardHead({ bot, verb, helper, manager }: { bot: Bot | undefined; verb: string; helper?: string; manager?: string }) {
  // Protocol 21: a card a task manager raised says so, "<task title>, for <bot>"; what it asks goes on the line under it.
  if (manager)
    return (
      <>
        <div className="pb-card-head pb-card-head-tm">
          {bot && <Face look={bot.look} size="sm" />}
          <span className="pb-card-head-who">
            <b>{manager}</b>
            {`, for ${bot?.name ?? "a bot"}`}
          </span>
        </div>
        <div className="pb-card-helper">{`${verb[0]!.toUpperCase()}${verb.slice(1)}${helper ? `, for its worker ${helper}` : ""}`}</div>
      </>
    );
  return (
    <>
      <div className="pb-card-head">
        {bot && <Face look={bot.look} size="sm" />}
        <b>{bot?.name ?? "A bot"}</b> {verb}
      </div>
      {/* Step 7c: a card a helper raised says which helper it is. */}
      {helper && <div className="pb-card-helper">For its helper {helper}</div>}
    </>
  );
}

/**
 * Exactly what will happen, in a well. A long text is cut with a soft fade and a plain "Show all",
 * so the person never allows something they could not read.
 */
function CardDetail({ caption, detail, children }: { caption?: string; detail: string; children?: ReactNode }) {
  const well = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = well.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [detail, caption, open]);
  return (
    <>
      <div className="pb-draft app-draft" ref={well} data-open={open || undefined} data-clipped={long && !open ? "" : undefined}>
        {caption && <span className="pb-draft-to">{caption}</span>}
        {children || detail}
      </div>
      {long && (
        <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush app-draft-more" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

function ApprovalCard({ card, bot }: { card: Approval; bot: Bot | undefined }) {
  const { busy, error, decide } = useDecide(card.id);
  const now = useNow(EXPIRY_TICK_MS);
  const titleId = `card-${card.id}-title`;
  return (
    <section className="pb-card pb-arrive" aria-labelledby={titleId}>
      <CardHead bot={bot} verb="asks for permission" helper={card.helper} manager={card.taskManager} />
      <p className="pb-card-title" id={titleId}>
        {card.title}
      </p>
      {/* A meeting from the calendar tools is written out, and approved or denied: never always. */}
      <CardDetail caption={card.caption} detail={card.detail}>
        {card.meeting && <MeetingDetail meeting={card.meeting} />}
      </CardDetail>
      <div className="pb-card-actions">
        <button className="pb-btn pb-btn-sm pb-btn-primary" type="button" disabled={busy} onClick={() => decide({ type: "allow-once" })}>
          {card.meeting ? "Approve" : "Allow once"}
        </button>
        {!card.noAlways && !card.meeting && (
          <button className="pb-btn pb-btn-sm" type="button" disabled={busy} onClick={() => decide({ type: "always-allow" })}>
            Always allow
          </button>
        )}
        <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" disabled={busy} onClick={() => decide({ type: "deny" })}>
          Deny
        </button>
      </div>
      {error ? (
        <div className="pb-card-foot app-card-error" role="alert">
          {error}
        </div>
      ) : (
        card.expiresAt && <div className="pb-card-foot">{expiry(card.expiresAt, now)}</div>
      )}
    </section>
  );
}

function QuestionCard({ card, bot }: { card: Question; bot: Bot | undefined }) {
  const { busy, error, decide } = useDecide(card.id);
  // A typed answer not sent yet comes back when the window crosses between the layouts (lib/carry.ts).
  const [text, setText] = useState(() => carried<string>(`answer:${card.id}`) ?? "");
  useCarry(`answer:${card.id}`, text || undefined);
  const titleId = `card-${card.id}-title`;
  const verb = card.choices.length > 0 ? "needs a choice" : "has a question";
  return (
    <section className="pb-card pb-arrive" aria-labelledby={titleId}>
      <CardHead bot={bot} verb={verb} helper={card.helper} manager={card.taskManager} />
      {/* Protocol 23: when the bot asks again after his question, the new words fade in where the old ones were. */}
      <p className="pb-card-title pb-fade-in" id={titleId} key={card.title}>
        {card.title}
      </p>
      {card.text && (
        <p className="pb-card-text pb-fade-in" key={card.text}>
          {card.text}
        </p>
      )}
      {card.allowText && (
        <form
          className="app-card-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) decide({ type: "text", text: text.trim() });
          }}
        >
          <input className="pb-input" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" aria-label="Your answer" disabled={busy} />
          <button className="pb-btn pb-btn-sm" type="submit" disabled={busy || !text.trim()}>
            Send answer
          </button>
        </form>
      )}
      <div className="pb-card-actions">
        {card.choices.map((choice) => (
          <button key={choice.id} className="pb-btn pb-btn-sm" type="button" disabled={busy} onClick={() => decide({ type: "choice", choiceId: choice.id })}>
            {choice.label}
          </button>
        ))}
        <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" disabled={busy} onClick={() => decide({ type: "later" })}>
          Later
        </button>
      </div>
      {error && (
        <div className="pb-card-foot app-card-error" role="alert">
          {error}
        </div>
      )}
      {/* Protocol 23: ask the bot about it before answering. Not on a helper's card: its helper cannot be reached from here. */}
      {!card.helper && <CardQuestions id={card.id} place="card" botId={card.botId} questions={card.questions} botName={bot?.name ?? "The bot"} disabled={busy} onAsk={(text) => askCard(card.id, text)} />}
    </section>
  );
}

/**
 * A card from Pobots itself, not from a bot: Pobots' own mark where a face would be, the news, a way to
 * the page it is about, and "Dismiss". A newer card on the same topic takes its place: its words
 * fade in where the old ones were.
 */
function SystemCard({ card }: { card: System }) {
  const { busy, error, decide } = useDecide(card.id);
  const titleId = `card-${card.topic}-title`;
  return (
    <section className="pb-card pb-arrive pb-card-system" aria-labelledby={titleId} data-topic={card.topic} data-card-id={card.id}>
      <div className="pb-card-head">
        <PobotsMark />
        <b>Pobots</b> tells you
      </div>
      <div className="pb-fade-in pb-card-system-body" key={card.id}>
        <p className="pb-card-title" id={titleId}>
          {card.title}
        </p>
        {card.text && <p className="pb-card-text">{card.text}</p>}
      </div>
      <div className="pb-card-actions">
        {card.topic === "backup" && (
          <button className="pb-btn pb-btn-sm" type="button" onClick={() => store.openAppSettings("general")}>
            Open backup settings
          </button>
        )}
        <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" disabled={busy} onClick={() => decide({ type: "dismiss" })}>
          Dismiss
        </button>
      </div>
      {error && (
        <div className="pb-card-foot app-card-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function NoteCard({ card, bot }: { card: Note; bot: Bot | undefined }) {
  const { busy, error, decide } = useDecide(card.id);
  const titleId = `card-${card.id}-title`;
  return (
    <section className="pb-card pb-arrive pb-card-note" aria-labelledby={titleId}>
      <CardHead bot={bot} verb="tells you" manager={card.taskManager} />
      <p className="pb-card-title" id={titleId}>
        {card.title}
      </p>
      {card.text && <p className="pb-card-text">{card.text}</p>}
      <div className="pb-card-actions">
        <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" type="button" disabled={busy} onClick={() => decide({ type: "dismiss" })}>
          Got it
        </button>
      </div>
      {error && (
        <div className="pb-card-foot app-card-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
