// Step 7c: the person's to-do list (docs/build/step-7c.md, part 2). "Your to-do" at the bottom of the
// right rail, under Needs you and Later today, and on the phone's Needs you screen: one quiet line per
// to-do with the bot's face, its title and its age or "by" day; the ones with a "by when" first, then
// the newest. A click opens the to-do's window, which Pobots draws from the bot's blocks (never HTML
// from a bot): text, facts, a link, a text to copy, a picture or file from the bot's folder, one of the
// bot's pages, fields and the bot's buttons; "Mark done" and "Dismiss" are always there.
import { useRailExit, useRailLeaving } from "./rail-leaving";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Bot, Todo, TodoBlock } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { carried, useCarry } from "../lib/carry";
import { useNow } from "../lib/hooks";
import { fileSize } from "../lib/words";
import { answerTodo, askTodo, closeTodo, ensureArtifacts, openArtifact, todoFileUrl } from "../state/actions";
import { store, useAppState } from "../state/store";
import { CopyButton } from "./Address";
import { CheckIcon, Face, FileIcon } from "./bits";
import { Dialog } from "./Dialog";
import { CardQuestions } from "./CardQuestions";
import { MarkdownText } from "./ThreadMarkdown";
import { DownloadButton } from "./FileDownload";
import { downloadFileName } from "../../shared/downloads";

// ------------------------------------------------------------ words

export const TODO_WORDS = {
  title: "Your to-do",
  done: "Mark done",
  dismiss: "Dismiss",
  missingFile: "No longer in the bot's folder",
  openPage: "Open beside the chat",
  gone: "This to-do is no longer on your list.",
  answered: (when: string, label?: string) => (label ? `You answered ${when}: ${label}` : `You answered ${when}`),
  fromTodo: "From your to-do",
} as const;

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "now", "5 min", "3 h", "2 d", "3 w": how long ago a to-do was made. */
export function ageWord(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < DAY) return `${Math.floor(ms / 3600_000)} h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)} d`;
  return `${Math.floor(ms / (7 * DAY))} w`;
}

/** The moment a "by when" points at, local time: the end of a day given without a time. */
export function dueAt(due: string): number {
  const [d, t] = due.split("T");
  const [y, m, day] = d!.split("-").map(Number);
  if (!t) return new Date(y!, m! - 1, day!, 23, 59, 59).getTime();
  const [h, mi] = t.split(":").map(Number);
  return new Date(y!, m! - 1, day!, h!, mi!).getTime();
}

/** "by 15:00", "by tomorrow", "by Fri", "by 20 Nov"; "was due Thu" once it has passed. */
export function dueWord(due: string, now: number): { word: string; late: boolean } {
  const at = dueAt(due);
  const d = new Date(at);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / DAY);
  const hasTime = due.includes("T");
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = days === 0 ? (hasTime ? clock : "today") : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : days > 1 && days < 7 ? WEEKDAY[d.getDay()]! : days < -1 && days > -7 ? WEEKDAY[d.getDay()]! : `${d.getDate()} ${MONTH[d.getMonth()]}`;
  const late = at < now;
  return { word: late ? `was due ${day}` : `by ${day}`, late };
}

/** The order of the list: those with a "by when" first, soonest first; then the newest. */
export function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.due && b.due) return dueAt(a.due) - dueAt(b.due) || b.at.localeCompare(a.at);
    if (a.due) return -1;
    if (b.due) return 1;
    return b.at.localeCompare(a.at);
  });
}

// ------------------------------------------------------------ the rail's list

/** The to-do whose window is open, in the rail or on the phone's Needs you screen. One at a time. */
const openListeners = new Set<(id: string | null) => void>();
let openId: string | null = null;
export function openTodo(id: string | null): void {
  openId = id;
  for (const l of openListeners) l(id);
}
function useOpenTodo(): string | null {
  const [id, setId] = useState(openId);
  useEffect(() => {
    openListeners.add(setId);
    return () => {
      openListeners.delete(setId);
    };
  }, []);
  return id;
}

const todoKey = (todo: Todo) => todo.id;

/** "Your to-do": at the bottom of the rail. Nothing while there is none. */
export function TodoList() {
  const todos = useAppState((s) => s.todos);
  const bots = useAppState((s) => s.bots);
  const now = useNow(60_000);
  const open = useOpenTodo();
  const sorted = useMemo(() => sortTodos(todos), [todos]);
  const { rows, finish } = useRailLeaving(sorted, todoKey);
  const openOne = open ? todos.find((t) => t.id === open) : undefined;
  // A to-do answered or closed elsewhere closes its window here.
  useEffect(() => {
    if (open && !openOne) openTodo(null);
  }, [open, openOne]);
  // When the window closes because its to-do left the list, its line is gone: the focus goes to the
  // first line that is left, so it is never lost on the page.
  const wasOpen = useRef<string | null>(null);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (!was || open || todos.some((t) => t.id === was)) return;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    document.querySelector<HTMLElement>(".app-rail li:not([inert]) .pb-todo-item")?.focus();
  }, [open, todos]);
  return (
    <>
      {rows.length > 0 && (
        <section className="pb-todo app-todo" aria-labelledby="todo-title">
          <h3 className="pb-side-title pb-todo-title" id="todo-title">
            {TODO_WORDS.title}
            {sorted.length > 0 && <span className="pb-todo-count">{sorted.length}</span>}
          </h3>
          <ul className="pb-todo-list">
            {rows.map(({ item: t, leaving }) => (
              <TodoRow key={t.id} todo={t} bot={bots.find((b) => b.id === t.botId)} now={now} leaving={leaving} finish={finish} />
            ))}
          </ul>
        </section>
      )}
      {openOne && <TodoWindow todo={openOne} bot={bots.find((b) => b.id === openOne.botId)} onClose={() => openTodo(null)} />}
    </>
  );
}

function TodoRow({ todo, bot, now, leaving, finish }: { todo: Todo; bot: Bot | undefined; now: number; leaving: boolean; finish: (key: string) => void }) {
  const ref = useRailExit<HTMLLIElement>(todo.id, leaving, finish);
  const when = todo.due ? dueWord(todo.due, now) : { word: ageWord(todo.at, now), late: false };
  const from = todo.taskManager ? `${todo.taskManager.title}, for ${bot?.name ?? "a bot"}` : (bot?.name ?? "a bot");
  const label = `${todo.title}, from ${from}, ${todo.due ? when.word : `${when.word} ago`.replace("now ago", "just now")}`;
  return (
    <li ref={ref} className="app-todo-slot app-rail-exit" inert={leaving || undefined} data-leaving={leaving ? "resolved" : undefined}>
      <div className="app-rail-exit-inner pb-arrive">
        <button className="pb-todo-item" type="button" data-todo-id={todo.id} aria-label={label} aria-haspopup="dialog" onClick={() => openTodo(todo.id)}>
          {bot ? <Face look={bot.look} size="sm" /> : <span className="pb-todo-noface" />}
          <span className="pb-todo-name">{todo.title}</span>
          <span className="pb-todo-when" data-due={todo.due ? "" : undefined} data-late={when.late || undefined}>
            {when.word}
          </span>
        </button>
      </div>
    </li>
  );
}

// ------------------------------------------------------------ the window

/** What was typed into a to-do's fields and not sent, kept while the app is open (and across the layouts). */
const drafts = new Map<string, Record<string, string>>();

function TodoWindow({ todo, bot, onClose }: { todo: Todo; bot: Bot | undefined; onClose(): void }) {
  const carryKey = `todo:${todo.id}`;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const start: Record<string, string> = {};
    for (const b of todo.blocks) if (b.type === "field" && b.value) start[b.id] = b.value;
    return { ...start, ...(drafts.get(todo.id) ?? {}), ...(carried<Record<string, string>>(carryKey) ?? {}) };
  });
  useCarry(carryKey, Object.keys(values).length ? values : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(60_000);
  const set = (id: string, v: string) =>
    setValues((old) => {
      const next = { ...old, [id]: v };
      drafts.set(todo.id, next);
      return next;
    });
  const act = (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    run().then(
      () => {
        drafts.delete(todo.id);
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError(messageOf(e));
      },
    );
  };
  const filled = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  const when = todo.due ? dueWord(todo.due, now) : undefined;
  const age = ageWord(todo.at, now);
  const buttons = [...todo.buttons].sort((a, b) => Number(!!a.primary) - Number(!!b.primary));
  return (
    <Dialog title={todo.title} size="sheet" onClose={onClose} text={todo.why}>
      {/* Takes the focus when the window opens, so no control in the bot's blocks lights up by itself. */}
      <div className="pb-todo-from" tabIndex={-1} data-autofocus>
        {bot && <Face look={bot.look} size="sm" />}
        {/* Protocol 21: a to-do a task manager made says so, "<task title>, for <bot>". */}
        {todo.taskManager ? (
          <span className="pb-todo-from-tm">
            <b>{todo.taskManager.title}</b>
            {`, for ${bot?.name ?? "a bot"}`}
          </span>
        ) : (
          <b>{bot?.name ?? "A bot"}</b>
        )}
        <span>{age === "now" ? "just now" : `${age} ago`}</span>
        {when && <span data-late={when.late || undefined}>{when.word}</span>}
      </div>
      {todo.answer && <p className="pb-todo-answered">{TODO_WORDS.answered(ageWord(todo.answer.at, now) === "now" ? "just now" : `${ageWord(todo.answer.at, now)} ago`, todo.answer.label)}</p>}
      <div className="pb-todo-blocks">
        {todo.blocks.map((b, i) => (
          <Block key={`${todo.id}-${i}`} block={b} index={i} todo={todo} value={b.type === "field" ? (values[b.id] ?? "") : ""} onValue={set} disabled={busy} />
        ))}
      </div>
      <p className="pb-hint app-hint-error pb-todo-error" role={error ? "alert" : undefined}>
        {error ?? ""}
      </p>
      <div className="pb-dialog-actions pb-todo-actions">
        <button className="pb-btn pb-btn-quiet" type="button" aria-disabled={busy || undefined} onClick={() => act(() => closeTodo(todo.id, "dismissed"))}>
          {TODO_WORDS.dismiss}
        </button>
        <button className="pb-btn" type="button" aria-disabled={busy || undefined} onClick={() => act(() => closeTodo(todo.id, "done"))}>
          {TODO_WORDS.done}
        </button>
        {buttons.map((btn) => (
          <button key={btn.id} className={`pb-btn${btn.primary ? " pb-btn-primary" : ""}`} type="button" data-button-id={btn.id} aria-disabled={busy || undefined} onClick={() => act(() => answerTodo(todo.id, btn.id, filled()))}>
            {btn.label}
          </button>
        ))}
      </div>
      {/* Protocol 23: ask the bot about it before acting, under the buttons so they never move. The to-do stays open. */}
      <CardQuestions id={todo.id} place="todo" questions={todo.questions} botName={bot?.name ?? "The bot"} botId={todo.botId} disabled={busy} onAsk={(text) => askTodo(todo.id, text)} />
    </Dialog>
  );
}

function Block({ block: b, index, todo, value, onValue, disabled }: { block: TodoBlock; index: number; todo: Todo; value: string; onValue(id: string, v: string): void; disabled: boolean }) {
  switch (b.type) {
    case "text":
      return <div className="pb-todo-text app-md"><MarkdownText text={b.text} botId={todo.botId} /></div>;
    case "facts":
      return (
        <dl className="pb-todo-facts">
          {b.facts.map((f, i) => (
            <div key={i} className="pb-todo-fact">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "link":
      return (
        <a className="pb-todo-link" href={b.url} target="_blank" rel="noreferrer noopener">
          {b.label}
        </a>
      );
    case "copy":
      return (
        <div className="pb-todo-copy">
          <div className="pb-todo-copy-head">
            <span className="pb-todo-copy-label">{b.label ?? "Text to copy"}</span>
            <CopyButton text={b.text} label={`Copy ${b.label ?? "the text"}`} />
          </div>
          <div className="pb-draft pb-todo-copy-text" tabIndex={0}>
            {b.text}
          </div>
        </div>
      );
    case "file":
      return <FileBlock block={b} index={index} todo={todo} />;
    case "page":
      return (
        <button
          className="pb-todo-page"
          type="button"
          disabled={!b.artifact.available}
          onClick={() => {
            const a = b.artifact;
            openTodo(null);
            store.leave(() => {
              store.openBot(a.botId);
              ensureArtifacts(a.botId);
              openArtifact(store.get().artifacts[a.botId]?.find((x) => x.id === a.id) ?? a);
            });
          }}
        >
          <span className="pb-todo-page-title">{b.artifact.title}</span>
          <span className="pb-todo-page-line">{b.artifact.available ? TODO_WORDS.openPage : "The file is gone"}</span>
        </button>
      );
    case "field":
      return <Field block={b} value={value} onValue={onValue} disabled={disabled} />;
  }
}

function FileBlock({ block: b, index, todo }: { block: Extract<TodoBlock, { type: "file" }>; index: number; todo: Todo }) {
  const name = downloadFileName(b.path);
  const url = todoFileUrl(todo.id, index, todo.updatedAt, true);
  const picture = b.picture ? todoFileUrl(todo.id, index, todo.updatedAt) : undefined;
  const [broken, setBroken] = useState(false);
  if (picture && url && !broken && !b.missing) {
    return (
      <div className="pb-todo-picture-block">
        <a className="pb-todo-picture" href={picture} target="_blank" rel="noreferrer noopener" aria-label={`${b.name}. Open the picture`}>
          <img src={picture} alt={b.name} draggable={false} onError={() => setBroken(true)} />
        </a>
        <DownloadButton href={url} name={name} />
      </div>
    );
  }
  const meta = b.missing ? TODO_WORDS.missingFile : b.size !== undefined ? fileSize(b.size) : "";
  const detail = [b.name !== name ? name : "", meta].filter(Boolean).join(" · ");
  const inner = (
    <>
      <span className="pb-chip-thumb" aria-hidden="true">
        <FileIcon />
      </span>
      <span className="pb-chip-text">
        <span className="pb-chip-name">{b.name}</span>
        <span className="pb-chip-meta">{detail}</span>
      </span>
    </>
  );
  return url && !b.missing ? (
    <a className="pb-chip-file pb-todo-file" href={url} download={name} title={`Download ${name}`} aria-label={`${b.name}${detail ? `, ${detail}` : ""}. Download`}>
      {inner}
    </a>
  ) : (
    <div className="pb-chip-file pb-todo-file" data-missing="">
      {inner}
    </div>
  );
}

function Field({ block: b, value, onValue, disabled }: { block: Extract<TodoBlock, { type: "field" }>; value: string; onValue(id: string, v: string): void; disabled: boolean }) {
  const id = `todo-field-${b.id}`;
  const group = useRef<HTMLDivElement>(null);
  if (b.input === "choice") {
    const choices = b.choices ?? [];
    const at = Math.max(0, choices.indexOf(value));
    // While a send is on its way nothing is disabled (the focus would be lost); a choice just does not change.
    const pick = (i: number) => !disabled && onValue(b.id, choices[i]!);
    const keys = (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = (at + step + choices.length) % choices.length;
      pick(next);
      group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    };
    return (
      <div className="pb-field pb-field-wide pb-todo-field">
        <span className="pb-label" id={id}>
          {b.label}
        </span>
        <div className="pb-choices" role="radiogroup" aria-labelledby={id} ref={group} onKeyDown={keys}>
          {choices.map((c, i) => (
            <button key={c} className="pb-choice" type="button" role="radio" aria-checked={c === value} tabIndex={i === at ? 0 : -1} aria-disabled={disabled || undefined} onClick={() => !disabled && pick(i)}>
              <span className="pb-choice-label">{c}</span>
              {c === value && <CheckIcon />}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label className="pb-field pb-field-wide pb-todo-field" htmlFor={id}>
      <span className="pb-label">{b.label}</span>
      {b.input === "long" ? (
        <textarea id={id} className="pb-input pb-textarea" value={value} placeholder={b.placeholder} readOnly={disabled} onChange={(e) => onValue(b.id, e.target.value)} />
      ) : (
        <input id={id} className="pb-input" type="text" value={value} placeholder={b.placeholder} readOnly={disabled} onChange={(e) => onValue(b.id, e.target.value)} />
      )}
    </label>
  );
}
