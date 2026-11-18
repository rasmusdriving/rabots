// The messages that start a turn: yours, a queued note, another bot's, a trigger's, a channel's, a helper's task.
import { useContext, useState } from "react";
import type { Bot, UserItem } from "../../shared/protocol";
import { steerQueued } from "../state/actions";
import { useAppState } from "../state/store";
import { clockTime } from "../lib/words";
import { STEER_NOW, STEERED } from "../lib/steer";
import { MessageAttachments } from "./Attachments";
import { arriveFromStack } from "../lib/queue";
import { ClockIcon, Face, HelperIcon, HookIcon, SpeechIcon } from "./bits";
import { MarkdownText } from "./ThreadMarkdown";
import { InHelper } from "./thread-blocks";

/** How many lines of the task show before "Show all". */
export const TASK_LINES = 4;
/** About how many characters fit on a line of a message (the design system's measure). */
export const LINE_CHARS = 68;
/** About how many lines a text takes in a message: each line of it, wrapped at the measure. */
export const taskLines = (text: string): number => text.trim().split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / LINE_CHARS)), 0);

/**
 * The task the bot gave the helper, the first item of its thread: on the left like a message from
 * a bot, with the bot's face and a quiet "asked the helper". It can be long, so a few lines show
 * and the rest opens on request. In the thread of a helper started by a helper, the one who asked
 * is that helper, shown with the helper's mark.
 */
export function HelperTask({ item, bot, depth }: { item: UserItem; bot: Bot; depth: number }) {
  const [open, setOpen] = useState(false);
  // Known from the text itself, so the first frame already has its final height: measuring after
  // drawing would add "Show all" a frame later and move the chat.
  const long = taskLines(item.text) > TASK_LINES;
  const bodyId = `task-${item.id}`;
  const byHelper = depth > 1;
  // In a task manager's thread the bot asked the task manager (protocol 21).
  const name = (useContext(InHelper)?.name ?? "Helper").toLowerCase();
  return (
    <article className="pb-msg pb-msg-task pb-arrive" data-turn={item.turnId}>
      {byHelper ? (
        <span className="pb-who pb-who-mark" aria-hidden="true">
          <HelperIcon />
        </span>
      ) : (
        <Face look={bot.look} size="sm" />
      )}
      <div>
        <div className="pb-msg-head">
          <b>{byHelper ? "Helper" : bot.name}</b>
          <span className="pb-msg-from">{item.steered ? "sent this while it worked" : byHelper ? "asked this helper" : `asked the ${name}`}</span>
          <time dateTime={item.at}>{clockTime(item.at)}</time>
        </div>
        <div className="pb-msg-body pb-task-body app-md" id={bodyId} data-open={open || undefined} data-long={long || undefined} style={{ ["--task-lines" as string]: TASK_LINES }}>
          <MarkdownText text={item.text} />
        </div>
        {(long || open) && (
          <button type="button" className="pb-task-more app-activity-btn" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </article>
  );
}

export function YourMessage({ item, bots }: { item: UserItem; bots: Bot[] }) {
  // Pobots' own request for a tidy turn is never a message; it lives behind the fresh start line.
  if (item.from.type === "app") return null;
  if (item.from.type === "bot") return <FromBot item={item} from={bots.find((b) => b.id === (item.from as { botId: string }).botId)} />;
  if (item.from.type === "trigger") return <FromTrigger item={item} label={item.from.label} />;
  if (item.from.type === "channel") return <FromChannel item={item} from={item.from} />;
  return (
    <div className="app-you pb-arrive" ref={arriveFromStack(item.id)} data-item={item.id} data-queued={item.queued || undefined} data-steered={item.steered || undefined} data-turn={item.turnId}>
      {/* Step 7c: his answer to a to-do says so, quietly, above the bubble. */}
      {/* Protocol 23: his question about a to-do or card before he acts says so instead. */}
      {item.from.todo && <div className="app-you-note pb-from-todo">{item.from.question ? "Question on your to-do" : "From your to-do"}: {item.from.todo.title}</div>}
      {/* Protocol 22: his answer to a card that came back after a restart names the card, the same way. */}
      {item.from.card && <div className="app-you-note pb-from-todo pb-from-card">{item.from.question ? "Question on your card" : "From your card"}: {item.from.card.title}</div>}
      {item.attachments && item.attachments.length > 0 && <MessageAttachments attachments={item.attachments} />}
      {(item.text || !item.attachments?.length) && <div className="pb-msg-you">{item.text}</div>}
      {item.queued ? <QueuedNote item={item} bot={bots.find((b) => b.mainThreadId === item.threadId)} /> : item.steered ? <div className="app-you-note">{STEERED}</div> : null}
    </div>
  );
}

/**
 * "Queued" under a message that waits. While its bot is at work (and no Stop holds it) a quiet
 * "Steer now" beside it puts it into what the bot does now; the line then reads "Steered", in the
 * same box. As T3 Code's "Send now" on a queued message.
 */
export function QueuedNote({ item, bot }: { item: UserItem; bot: Bot | undefined }) {
  const [asking, setAsking] = useState(false);
  // Not while it writes down what matters (a tidy turn): nothing can be steered into that.
  const working = !!bot && (bot.state === "thinking" || bot.state === "working") && !bot.context?.tidying;
  return (
    <div className="app-you-note">
      Queued
      {working && (
        <>
          {" · "}
          <button
            type="button"
            className="app-you-steer"
            aria-disabled={asking || undefined}
            onClick={() => {
              if (asking || !bot) return;
              setAsking(true);
              steerQueued(bot.id, item.id)
                .catch(() => undefined)
                .finally(() => setAsking(false));
            }}
          >
            {STEER_NOW}
          </button>
        </>
      )}
    </div>
  );
}

/** A message to this bot from another bot: on the left with the sender's face, saying who it is from. */
export function FromBot({ item, from }: { item: UserItem; from: Bot | undefined }) {
  const ask = item.from.type === "bot" && item.from.expectsReply;
  return (
    <article className="pb-msg pb-arrive">
      {from ? <Face look={from.look} size="sm" /> : <span />}
      <div>
        <div className="pb-msg-head">
          <b>{from?.name ?? "Another bot"}</b>
          <span className="pb-msg-from">{ask ? "asked, waits for the answer" : "passed this on"}</span>
          <time dateTime={item.at}>{clockTime(item.at)}</time>
        </div>
        <div className="pb-msg-body app-from-bot">{item.text}</div>
        {item.queued ? <div className="app-you-note app-from-note">Queued</div> : item.steered ? <div className="app-you-note app-from-note">{STEERED}</div> : null}
      </div>
    </article>
  );
}

/**
 * A message from a trigger: something that arrived, not something the person typed. On the left
 * like a message from a bot, with a small clock (a schedule) or an arrow coming in (a webhook) where
 * a face would be, and the trigger's name, quietly, where a sender would be. A result passed on
 * from a fresh run ("Result of Morning brief:") reads the same way.
 */
export function FromTrigger({ item, label }: { item: UserItem; label: string }) {
  const bot = useAppState((s) => s.bots.find((b) => b.mainThreadId === item.threadId));
  const kind = useAppState((s) => {
    const list = bot ? s.triggers[bot.id] : undefined;
    const id = item.from.type === "trigger" ? item.from.triggerId : undefined;
    return (list?.find((t) => t.id === id) ?? list?.find((t) => t.name === label))?.kind;
  });
  return (
    <article className="pb-msg pb-msg-trigger pb-arrive" data-turn={item.turnId}>
      <span className="pb-who pb-who-mark" aria-hidden="true">
        {kind === "webhook" ? <HookIcon /> : <ClockIcon />}
      </span>
      <div>
        <div className="pb-msg-head">
          <b className="pb-msg-trigger-name">{label}</b>
          <time dateTime={item.at}>{clockTime(item.at)}</time>
        </div>
        <TriggerText text={item.text} />
        {item.queued && <div className="app-you-note app-from-note">Queued</div>}
      </div>
    </article>
  );
}

export type ChannelFrom = Extract<UserItem["from"], { type: "channel" }>;

/**
 * A message from a person in an outside channel: an instruction that arrived, not something typed
 * in Pobots. On the left like other arrivals, a small drawn speech mark where a face would be, the
 * writer's name where a sender would be, and quietly where it came from and which tag it used. The
 * messages before it are background, closed behind "Show the messages before it".
 */
export function FromChannel({ item, from }: { item: UserItem; from: ChannelFrom }) {
  const [open, setOpen] = useState(false);
  const context = from.context ?? [];
  const panel = `context-${item.id}`;
  return (
    <article className="pb-msg pb-msg-channel pb-arrive" data-turn={item.turnId}>
      <span className="pb-who pb-who-mark" aria-hidden="true">
        <SpeechIcon />
      </span>
      <div>
        <div className="pb-msg-head">
          <b>{from.sender}</b>
          <span className="pb-msg-from">{`in ${from.label}, to ${from.tag}`}</span>
          <time dateTime={item.at}>{clockTime(item.at)}</time>
        </div>
        <div className="pb-msg-body app-from-channel">{item.text}</div>
        {context.length > 0 && (
          <>
            <button type="button" className="pb-activity app-activity-btn app-sent-btn" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={() => setOpen(!open)}>
              {open ? "Hide the messages before it" : "Show the messages before it"}
            </button>
            {open && (
              <ol className="pb-context pb-arrive" id={panel} aria-label="The messages before it, oldest first">
                {context.map((m, i) => (
                  <li className="pb-context-msg" key={i}>
                    <span className="pb-context-head">
                      <b>{m.from}</b>
                      {m.at && <time dateTime={m.at}>{clockTime(m.at)}</time>}
                    </span>
                    <span className="pb-context-text">{m.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {item.queued && <div className="app-you-note app-from-note">Queued</div>}
      </div>
    </article>
  );
}

/**
 * What a trigger said to the bot. A webhook's message ends with what the other system sent, fenced
 * by the engine; that part is shown as data in a well, closed until asked for, not as chat text.
 */
export const HOOK_DATA = /\n\n[^\n]*\n\n<data from="webhook">\n```json\n([\s\S]*?)\n```\n<\/data>([\s\S]*)$/;

export function TriggerText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const m = HOOK_DATA.exec(text);
  if (!m) {
    return (
      <div className="pb-msg-body app-md app-from-trigger">
        <MarkdownText text={text} />
      </div>
    );
  }
  return (
    <>
      <div className="pb-msg-body app-md app-from-trigger">
        <MarkdownText text={text.slice(0, m.index)} />
      </div>
      <button type="button" className="pb-activity app-activity-btn app-sent-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide what was sent" : "Show what was sent"}
      </button>
      {open && <pre className="pb-draft app-activity-detail app-sent">{m[1] + (m[2] ?? "")}</pre>}
    </>
  );
}
