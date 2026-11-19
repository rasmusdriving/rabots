// Protocol 23: follow-up questions on cards (docs/build/step-card-follow-ups.md). At the foot of a
// to-do's window and of a bot's question card: the questions the person asked so far with the bot's
// answers, one quiet line while an answer is on its way, and a one-line box to ask before he acts
// (Enter sends, Shift+Enter makes a new line). Asking never closes or answers the card.
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MarkdownText } from "./ThreadMarkdown";
import type { CardQuestion } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { carried, useCarry } from "../lib/carry";

export const ASK_WORDS = {
  placeholder: "Ask about this before you act",
  ask: "Ask",
  answering: (bot: string) => `${bot} is answering`,
  queued: (bot: string) => `${bot} answers when it is free`,
  unanswered: "No answer came",
  thread: "Your questions about this",
} as const;

const Answer = memo(function Answer({ text, botId }: { text: string; botId?: string }) {
  return <div className="pb-cq-answer app-md"><MarkdownText text={text} botId={botId} /></div>;
});

export function CardQuestions({
  id,
  questions,
  botName,
  botId,
  onAsk,
  disabled,
  place,
}: {
  /** The to-do's or card's id: the draft is kept under it. */
  id: string;
  questions: CardQuestion[] | undefined;
  botName: string;
  botId?: string;
  onAsk(text: string): Promise<void>;
  disabled?: boolean;
  /** On the rail, in the to-do window, or in an Ahead item sheet. */
  place: "card" | "todo" | "ahead";
}) {
  const key = `ask:${id}`;
  const [text, setText] = useState(() => carried<string>(key) ?? "");
  useCarry(key, text || undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const list = questions ?? [];
  const threadRef = useRef<HTMLOListElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const last = list.at(-1);
  // The newest question and its answer stay in sight inside the thread's own box.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length, last?.state]);
  // Only he adds questions: after his own, the box he typed in stays in sight in a long to-do window.
  // Not on the rail, which keeps its place.
  const count = useRef(list.length);
  useEffect(() => {
    if (place === "todo" && list.length > count.current) formRef.current?.scrollIntoView({ block: "nearest" });
    count.current = list.length;
  }, [list.length, place]);

  const send = () => {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    setError(undefined);
    // The box empties at once, so his words never stand twice (in the box and in the card); they
    // come back if the question could not be sent.
    setText("");
    onAsk(t).then(
      () => setSending(false),
      (e: unknown) => {
        setSending(false);
        setText((now) => now || t);
        setError(messageOf(e));
      },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  return (
    <div className="pb-cq" data-place={place}>
      {list.length > 0 && (
        <ol className="pb-cq-thread" ref={threadRef} aria-label={ASK_WORDS.thread}>
          {list.map((q) => (
            <li key={q.id} className="pb-cq-item" data-state={q.state}>
              <p className="pb-cq-question">{q.text}</p>
              {q.state === "answered" && q.answer ? (
                <Answer botId={botId} text={q.answer} />
              ) : (
                <p className="pb-cq-wait" data-state={q.state} aria-live="polite">
                  {q.state === "answering" ? ASK_WORDS.answering(botName) : q.state === "queued" ? ASK_WORDS.queued(botName) : ASK_WORDS.unanswered}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      <form
        ref={formRef}
        className="pb-cq-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="pb-input pb-cq-input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={ASK_WORDS.placeholder}
          aria-label={ASK_WORDS.placeholder}
          maxLength={2000}
          disabled={disabled}
        />
        <button className="pb-btn pb-btn-sm" type="submit" disabled={disabled || sending || !text.trim()}>
          {ASK_WORDS.ask}
        </button>
      </form>
      {error && (
        <p className="pb-cq-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
