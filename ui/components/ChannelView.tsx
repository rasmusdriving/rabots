// A channel's page, in the reading panel in place of a bot's page: a Teams channel where people can
// write to bots through a Power Automate flow. One calm column like a trigger's page: who may write,
// which tag reaches which bot, how much background a bot gets, the address the flow posts to, the
// address answers go to (write-only), which bots may post on their own, what the flow should send,
// what came in, and Remove.
// Also the sheet for making a channel.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Bot, Channel, ChannelMessage, ChannelRoute } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { channelAddress, createChannel, loadChannelMessages, loadOlderChannelMessages, newChannelAddress, removeChannel, saveChannel } from "../state/actions";
import { store, useAppState } from "../state/store";
import { useNow, useSaver, type SaveState } from "../lib/hooks";
import { whenWord } from "../lib/words";
import { CopyButton, HookAddress } from "./Address";
import { CheckIcon, ChevronIcon, Face, Mark, SpeechIcon } from "./bits";
import { usePhone } from "../lib/phone";
import { PhoneBack } from "./PhoneBack";
import { Confirm, Dialog } from "./Dialog";
import { ChannelPosts } from "./ChannelPosts";

// ------------------------------------------------------------ words

export const CHANNEL_WORD: Record<ChannelMessage["status"], string> = {
  delivered: "Delivered",
  answered: "Answered",
  unanswered: "No answer",
  "reply-failed": "Answer not posted",
  refused: "Refused",
  ignored: "No tag matched",
};

/** The status mark of a channel message: the existing marks, nothing new. No answer has no mark. */
export function ChannelMark({ status }: { status: ChannelMessage["status"] }) {
  if (status === "delivered") return <Mark state="working" />;
  if (status === "answered") return <Mark state="check" />;
  if (status === "reply-failed") return <Mark state="blocked" />;
  if (status === "refused" || status === "ignored") return <Mark state="idle" />;
  return <span className="pb-mark" aria-hidden="true" />;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
/** A tag as written in the channel, without a leading "@" or "#". */
const cleanTag = (s: string) => s.trim().replace(/^[@#]+/, "").trim();
/** What the engine accepts as an address for answers. */
const isReplyUrl = (s: string) => /^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/\S*)?$/.test(s);

/** The body a Power Automate flow posts to a channel's address, as in docs/build/step-2c.md. */
export const FLOW_EXAMPLE = JSON.stringify(
  {
    messageId: "1794391578003",
    threadId: "1794391500000",
    from: { name: "Ada Example", email: "ada@example.com" },
    text: "Po can you draft the agenda for Thursday",
    html: '<p><at id="0">Po</at> can you draft the agenda for Thursday</p>',
    mentions: ["Po"],
    context: [{ from: "Bo Example", text: "We need an agenda for Thursday.", at: "2026-11-11T09:58:00Z" }],
    at: "2026-11-11T10:06:20Z",
    link: "https://teams.example.com/l/message/...",
  },
  null,
  2,
);

// ------------------------------------------------------------ the page

/** On a phone only: the way back to the bots, above the channel's head. */
function ChannelPhoneBar() {
  const phone = usePhone();
  if (!phone) return null;
  return (
    <div className="app-phone-bar">
      <PhoneBack />
    </div>
  );
}

/** `covered`: Pobots' settings page stands over it; it stays where it was underneath. */
export function ChannelPage({ channel, covered = false }: { channel: Channel; covered?: boolean }) {
  const id = `channel-${channel.id}`;
  return (
    <main className="pb-main app-main app-channel" aria-label={channel.name} inert={covered || undefined} aria-hidden={covered || undefined}>
      {/* On a phone the channel's page is a screen of its own: a way back stands above its head (phone layout, builder A). */}
      <ChannelPhoneBar />
      <ChannelHead channel={channel} />
      <div className="app-view pb-main-scroll app-channel-scroll">
        <div className="pb-channel-page">
          <Writers channel={channel} id={id} />
          <Routes channel={channel} id={id} />
          <Background channel={channel} id={id} />
          <section className="pb-section" aria-labelledby={`${id}-address`}>
            <h2 className="pb-section-title" id={`${id}-address`}>
              Address
            </h2>
            <HookAddress
              key={channel.id}
              sentence="The Power Automate flow posts each tagged message to this address. Keep it like a password."
              label="Channel address"
              load={() => channelAddress(channel.id)}
              renew={() => newChannelAddress(channel.id)}
              privateHint="Power Automate can only reach this address once Pobots has a public address."
            />
          </section>
          <Answers channel={channel} id={id} />
          <ChannelPosts channel={channel} id={id} />
          <FlowBody id={id} />
          <Messages channel={channel} id={id} />
          <RemoveChannel channel={channel} id={id} />
        </div>
      </div>
    </main>
  );
}

/** The head: a drawn speech mark, the name (renamed in place), "Teams channel" and a switch. */
function ChannelHead({ channel }: { channel: Channel }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    if (editing) input.current?.select();
    else if (refocus.current) {
      refocus.current = false;
      nameButton.current?.focus();
    }
  }, [editing]);

  const start = () => {
    setName(channel.name);
    setError(undefined);
    active.current = true;
    setEditing(true);
  };

  const finish = (save: boolean) => {
    // Escape and the blur that follows it must not both count.
    if (!active.current) return;
    active.current = false;
    const next = name.trim();
    setEditing(false);
    if (!save || next === channel.name || !next) return;
    saveChannel({ id: channel.id, name: next }).catch((e: unknown) => setError(messageOf(e)));
  };

  const toggle = (enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    saveChannel({ id: channel.id, enabled })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };

  return (
    <header className="pb-main-head app-head pb-channel-head">
      <span className="pb-who pb-who-mark pb-who-lg" aria-hidden="true">
        <SpeechIcon />
      </span>
      <div className="app-head-text">
        {editing ? (
          <input
            ref={input}
            className="app-rename"
            value={name}
            aria-label="Channel name"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                refocus.current = true;
                finish(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                refocus.current = true;
                finish(false);
              }
            }}
          />
        ) : (
          <h1>
            <button ref={nameButton} type="button" className="app-name" title="Rename" aria-label={`${channel.name}. Rename`} onClick={start}>
              {channel.name}
            </button>
          </h1>
        )}
        <div className={`pb-row-line${error ? " app-hint-error" : ""}`} role={error ? "alert" : undefined}>
          {error ?? (channel.enabled ? "Teams channel" : "Teams channel · Switched off")}
        </div>
      </div>
      <label className="pb-toggle pb-trigger-switch">
        <input className="pb-switch" type="checkbox" role="switch" checked={channel.enabled} disabled={busy} aria-label={`${channel.name} on`} onChange={(e) => toggle(e.target.checked)} />
        <span>{channel.enabled ? "On" : "Off"}</span>
      </label>
    </header>
  );
}

/** The quiet word beside a section's title: "Saved" for a moment, or what went wrong. */
function SavedWord({ state }: { state: SaveState }) {
  if (state.phase === "error")
    return (
      <span className="pb-saved app-hint-error" role="alert">
        {state.message}
      </span>
    );
  const show = state.phase === "saved";
  return (
    <span className="pb-saved" role="status" data-show={show || undefined} aria-hidden={!show || undefined}>
      Saved
    </span>
  );
}

function SectionHead({ id, title, state }: { id: string; title: string; state?: SaveState }) {
  return (
    <div className="pb-section-head">
      <h2 className="pb-section-title" id={id}>
        {title}
      </h2>
      {state && <SavedWord state={state} />}
    </div>
  );
}

// ------------------------------------------------------------ who may write

function Writers({ channel, id }: { channel: Channel; id: string }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const [state, save] = useSaver();
  const list = channel.allowedSenders;

  const add = async () => {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    if (!isEmail(email)) return setProblem("Write an email address, like name@example.com.");
    if (list.includes(email)) return setProblem("That address is already on the list.");
    setProblem(undefined);
    const typed = draft;
    setDraft("");
    if (!(await save(() => saveChannel({ id: channel.id, allowedSenders: [...list, email] })))) setDraft((now) => now || typed);
  };

  const remove = (email: string) => void save(() => saveChannel({ id: channel.id, allowedSenders: list.filter((x) => x !== email) }));

  return (
    <section className="pb-section" aria-labelledby={`${id}-writers`}>
      <SectionHead id={`${id}-writers`} title="Who may write here" state={state} />
      {list.length === 0 ? (
        <p className="pb-section-text">Nobody can write to bots here yet. Add the email address of each person who may.</p>
      ) : (
        <>
          <p className="pb-section-text">A message from anyone else is refused and reaches no bot.</p>
          <ul className="pb-writers" aria-label="Who may write here">
            {list.map((email) => (
              <li className="pb-writer" key={email}>
                <span className="pb-writer-email">{email}</span>
                <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" aria-label={`Remove ${email}`} onClick={() => remove(email)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        className="pb-add-row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="app-sr" htmlFor={`${id}-writer-new`}>
          Email address of someone who may write here
        </label>
        <input
          id={`${id}-writer-new`}
          className="pb-input pb-add-input"
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="name@example.com"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(undefined);
          }}
        />
        <button className="pb-btn pb-btn-sm" type="submit" disabled={!draft.trim() || state.phase === "saving"}>
          Add
        </button>
      </form>
      {problem && (
        <p className="pb-hint app-hint-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------ tags

function Routes({ channel, id }: { channel: Channel; id: string }) {
  const bots = useAppState((s) => s.bots);
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();
  const [state, save] = useSaver();
  const routes = channel.routes;

  // A tag that is a bot's name reaches that bot unless another is chosen; otherwise the main bot.
  const named = bots.find((b) => b.name.toLowerCase() === cleanTag(tag).toLowerCase());
  const fallback = named?.id ?? bots.find((b) => b.role === "main")?.id ?? bots[0]?.id ?? "";
  const botId = picked ?? fallback;

  const put = (next: ChannelRoute[]) => save(() => saveChannel({ id: channel.id, routes: next }));

  const add = async () => {
    const clean = cleanTag(tag);
    if (!clean) return;
    if (/[@#]/.test(clean)) return setProblem("Write the tag without @ or #.");
    const taken = routes.find((r) => r.tag.toLowerCase() === clean.toLowerCase());
    if (taken) return setProblem(`The tag ${taken.tag} is already here. Choose its bot in its row.`);
    setProblem(undefined);
    // Clear the field at once, not when the save comes back: a next tag typed meanwhile must stay.
    const typed = tag;
    const chosen = picked;
    setTag("");
    setPicked(null);
    if (!(await put([...routes, { tag: clean, botId }]))) {
      setTag((now) => now || typed);
      setPicked((now) => now ?? chosen);
    }
  };

  return (
    <section className="pb-section" aria-labelledby={`${id}-routes`}>
      <SectionHead id={`${id}-routes`} title="Tags" state={state} />
      <p className="pb-section-text">A message that tags a bot here is an instruction to that bot. The messages before it are given as background.</p>
      {routes.length === 0 ? (
        <p className="pb-section-text">No tags yet. Add one so that a message here can reach a bot.</p>
      ) : (
        <ul className="pb-routes" aria-label="Which tag reaches which bot">
          {routes.map((r) => (
            <li className="pb-route" key={r.tag}>
              <span className="pb-route-tag">{r.tag}</span>
              <span className="pb-route-word">reaches</span>
              <BotPicker bots={bots} value={r.botId} label={`The bot the tag ${r.tag} reaches`} onChange={(next) => void put(routes.map((x) => (x.tag === r.tag ? { ...x, botId: next } : x)))} />
              <button className="pb-btn pb-btn-sm pb-btn-quiet pb-route-remove" type="button" aria-label={`Remove the tag ${r.tag}`} onClick={() => void put(routes.filter((x) => x.tag !== r.tag))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="pb-add-row pb-route-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="app-sr" htmlFor={`${id}-tag-new`}>
          New tag
        </label>
        <input
          id={`${id}-tag-new`}
          className="pb-input pb-tag-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          placeholder="Tag, like Po"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value);
            setProblem(undefined);
          }}
        />
        <span className="pb-route-word">reaches</span>
        <BotPicker bots={bots} value={botId} label="The bot the new tag reaches" onChange={setPicked} />
        <button className="pb-btn pb-btn-sm" type="submit" disabled={!cleanTag(tag) || !botId || state.phase === "saving"}>
          Add tag
        </button>
      </form>
      {problem && (
        <p className="pb-hint app-hint-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * Chooses a bot: a quiet button with the bot's face and name that opens a short list of the bots,
 * each with its face. Arrow keys move in the list, Enter chooses, Escape closes.
 */
export function BotPicker({ bots, value, label, onChange }: { bots: Bot[]; value: string; label: string; onChange(botId: string): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const bot = bots.find((b) => b.id === value);

  useEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    (items.find((i) => i.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      items[to]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(false);
  };

  return (
    <span className="pb-pick" ref={wrap}>
      <button
        ref={button}
        className="pb-btn pb-btn-sm pb-pick-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${bot?.name ?? "none"}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {bot && <Face look={bot.look} size="sm" />}
        <span className="pb-pick-name">{bot?.name ?? "A bot that is gone"}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="pb-pop pb-pick-menu pb-arrive" role="menu" aria-label={label} ref={menu} onKeyDown={onMenuKey}>
          {bots.map((b) => (
            <button
              key={b.id}
              className="pb-option"
              type="button"
              role="menuitemradio"
              aria-checked={b.id === value}
              onClick={() => {
                onChange(b.id);
                close(true);
              }}
            >
              <Face look={b.look} size="sm" />
              <span className="pb-pick-name">{b.name}</span>
              {b.id === value && <CheckIcon className="pb-push" />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ------------------------------------------------------------ background

function Background({ channel, id }: { channel: Channel; id: string }) {
  const [value, setValue] = useState(String(channel.contextCount));
  const [state, save] = useSaver();
  const focused = useRef(false);
  const field = `${id}-context`;

  useEffect(() => {
    if (!focused.current) setValue(String(channel.contextCount));
  }, [channel.contextCount]);

  const commit = () => {
    const n = Number(value.trim());
    if (!value.trim() || !Number.isInteger(n) || n < 0 || n > 30) return setValue(String(channel.contextCount));
    if (n === channel.contextCount) return setValue(String(n));
    void save(() => saveChannel({ id: channel.id, contextCount: n }));
  };

  return (
    <section className="pb-section" aria-labelledby={`${id}-background`}>
      <SectionHead id={`${id}-background`} title="Background" state={state} />
      <div className="pb-field">
        <label className="pb-label" htmlFor={field}>
          Earlier messages a bot is given
        </label>
        <input
          id={field}
          className="pb-input pb-number-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          value={value}
          aria-describedby={`${field}-hint`}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setValue(String(channel.contextCount));
            }
          }}
        />
        <span className="pb-hint" id={`${field}-hint`}>
          From 0 to 30, the newest ones. A bot reads them as background for the task, never as instructions.
        </span>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ answers

/**
 * The address answers are posted to: write-only. Once saved it is never shown again. The field draws
 * what is typed as dots like a password field, but is a text field, so a browser's password manager
 * neither fills it nor offers to save the address.
 */
function Answers({ channel, id }: { channel: Channel; id: string }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const [state, save] = useSaver();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const field = `${id}-reply`;

  const set = async () => {
    const url = draft.trim();
    if (!url) return;
    if (!isReplyUrl(url)) return setProblem("Use an address that starts with https://.");
    setProblem(undefined);
    // Cleared once saved: the address is not kept in the window after the engine has it.
    if (await save(() => saveChannel({ id: channel.id, replyUrl: url }))) setDraft("");
  };

  const remove = async () => {
    setRemoveError(undefined);
    try {
      await saveChannel({ id: channel.id, replyUrl: "" });
      setRemoving(false);
    } catch (e) {
      setRemoveError(messageOf(e));
    }
  };

  return (
    <section className="pb-section" aria-labelledby={`${id}-answers`}>
      <SectionHead id={`${id}-answers`} title="Answers" state={state} />
      <p className="pb-reply-state" data-set={channel.hasReplyUrl || undefined}>
        <Mark state={channel.hasReplyUrl ? "check" : "idle"} />
        {channel.hasReplyUrl ? "An address for answers is set. It is not shown again." : "No address for answers yet."}
      </p>
      <form
        className="pb-field pb-field-wide"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void set();
        }}
      >
        <label className="pb-label" htmlFor={field}>
          {channel.hasReplyUrl ? "Replace it with" : "Address for answers"}
        </label>
        <div className="pb-add-row">
          <input
            id={field}
            className="pb-input pb-add-input pb-secret-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            data-1p-ignore=""
            data-lpignore="true"
            spellCheck={false}
            placeholder="https://"
            value={draft}
            aria-describedby={`${field}-hint`}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(undefined);
            }}
          />
          <button className="pb-btn pb-btn-sm" type="submit" disabled={!draft.trim() || state.phase === "saving"}>
            {channel.hasReplyUrl ? "Replace" : "Save"}
          </button>
          {channel.hasReplyUrl && (
            <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" onClick={() => setRemoving(true)}>
              Remove
            </button>
          )}
        </div>
        {problem && (
          <p className="pb-hint app-hint-error" role="alert">
            {problem}
          </p>
        )}
        <span className="pb-hint" id={`${field}-hint`}>
          Without it, bots read messages from here but cannot answer there. The second flow, the one that posts answers in Teams, gives you this address.
        </span>
      </form>
      {removing && (
        <Confirm
          title="Remove the address for answers?"
          text="Bots still read messages from here, but their answers are no longer posted in the channel."
          yes="Remove address"
          no="Keep it"
          tone="danger"
          error={removeError}
          onYes={() => void remove()}
          onNo={() => setRemoving(false)}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------ what the flow sends

function FlowBody({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const panel = `${id}-flow-body`;
  return (
    <section className="pb-section" aria-labelledby={`${id}-flow`}>
      <h2 className="pb-section-title" id={`${id}-flow`}>
        What the flow sends
      </h2>
      <div>
        <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" type="button" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={() => setOpen(!open)}>
          {open ? "Hide what the flow should send" : "Show what the flow should send"}
        </button>
      </div>
      {open && (
        <div className="pb-flow pb-arrive" id={panel}>
          <p className="pb-section-text">
            For each tagged message, the flow posts JSON like this. <code>messageId</code>, <code>from.email</code>, and <code>text</code> or <code>html</code> are needed; the rest may be left out. <code>context</code> holds the messages before it, oldest first.
          </p>
          <div className="pb-address">
            <pre className="pb-address-text pb-flow-text" aria-label="Example body">
              {FLOW_EXAMPLE}
            </pre>
            <CopyButton text={FLOW_EXAMPLE} label="Copy the example body" />
          </div>
          <span className="pb-hint">
            Answers go to the address for answers as JSON with <code>channelId</code>, <code>messageId</code>, <code>threadId</code>, <code>bot</code>, <code>text</code> and <code>html</code>. A bot's own new post goes there too, with <code>kind</code> set to <code>post</code> and no <code>messageId</code> or <code>threadId</code>; the flow answers with the new post's <code>messageId</code>.
          </span>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ messages

function Messages({ channel, id }: { channel: Channel; id: string }) {
  const messages = useAppState((s) => s.channelMessages[channel.id]);
  const bots = useAppState((s) => s.bots);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    loadChannelMessages(channel.id).catch((e: unknown) => setError(messageOf(e)));
  }, [channel.id]);

  return (
    <section className="pb-section" aria-labelledby={`${id}-messages`}>
      <h2 className="pb-section-title" id={`${id}-messages`}>
        Messages
      </h2>
      {error && <p className="pb-hint app-hint-error">{error}</p>}
      {messages?.loaded && messages.messages.length === 0 && <p className="pb-section-text">Nothing has come in yet. Messages show here once the flow posts them.</p>}
      {messages?.loaded && messages.messages.length > 0 && (
        <ol className="pb-cmsgs" aria-label={`What came in on ${channel.name}`}>
          {messages.messages.map((m) => (
            <MessageRow key={m.id} message={m} bots={bots} now={now} open={openId === m.id} onToggle={() => setOpenId(openId === m.id ? null : m.id)} />
          ))}
        </ol>
      )}
      {messages?.hasMore && (
        <div>
          <button
            className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush"
            type="button"
            disabled={more}
            onClick={() => {
              setMore(true);
              loadOlderChannelMessages(channel.id)
                .catch((e: unknown) => setError(messageOf(e)))
                .finally(() => setMore(false));
            }}
          >
            Show earlier messages
          </button>
        </div>
      )}
    </section>
  );
}

/** "to Kaja" when the tag is the bot's name, "tagged Inbox, to Onboardings" when not. */
function toWords(m: ChannelMessage, bot: Bot | undefined): string {
  if (!m.tag) return "";
  const name = bot?.name ?? "a bot that is gone";
  return m.tag.toLowerCase() === name.toLowerCase() ? `to ${name}` : `tagged ${m.tag}, to ${name}`;
}

function MessageRow({ message: m, bots, now, open, onToggle }: { message: ChannelMessage; bots: Bot[]; now: number; open: boolean; onToggle(): void }) {
  const bot = bots.find((b) => b.id === m.botId);
  const note = m.note ?? (m.status === "delivered" && !m.turnId ? "Waiting its turn" : "");
  const body = (
    <>
      <ChannelMark status={m.status} />
      <span className="pb-cmsg-text">
        <span className="pb-cmsg-top">
          <span className="pb-cmsg-who">{m.sender}</span>
          {m.tag && <span className="pb-cmsg-to">{toWords(m, bot)}</span>}
        </span>
        <span className="pb-cmsg-line">
          <span className="pb-cmsg-word">{CHANNEL_WORD[m.status]}</span>
          {note && <span className="pb-cmsg-note">{note}</span>}
        </span>
      </span>
      <time className="pb-time" dateTime={m.at}>
        {whenWord(m.at, new Date(now))}
      </time>
    </>
  );
  // Only a message that became a turn in a bot's chat has more to show.
  if (!m.turnId || !bot)
    return (
      <li className="pb-cmsg" data-status={m.status}>
        <div className="pb-cmsg-row">{body}</div>
      </li>
    );
  const panel = `cmsg-${m.channelId}-${m.id}`;
  return (
    <li className="pb-cmsg" data-status={m.status}>
      <button className="pb-cmsg-row" type="button" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>
        {body}
      </button>
      {open && (
        <div className="pb-run-open pb-arrive" id={panel}>
          {m.note && <p className="pb-run-full">{m.note}</p>}
          <div>
            <button
              className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush"
              type="button"
              onClick={() =>
                store.leave(() => {
                  store.openBot(bot.id);
                  store.focusChat(bot.id, m.turnId!);
                })
              }
            >
              Show in chat
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------ remove

function RemoveChannel({ channel, id }: { channel: Channel; id: string }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setError(undefined);
    try {
      await removeChannel(channel.id);
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="pb-section pb-section-last" aria-labelledby={`${id}-remove`}>
      <h2 className="pb-section-title" id={`${id}-remove`}>
        Remove this channel
      </h2>
      <p className="pb-section-text">Its address stops working and no bot is reached from here any more. What already came in stays in the bots' chats.</p>
      <div>
        <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" onClick={() => setAsking(true)}>
          Remove channel
        </button>
      </div>
      {asking && (
        <Confirm
          title={`Remove ${channel.name}?`}
          text="Its address stops working at once and no bot is reached from here any more. What already came in stays in the bots' chats."
          yes="Remove channel"
          no="Keep it"
          tone="danger"
          error={error}
          onYes={() => void remove()}
          onNo={() => setAsking(false)}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------ the sheet

export function ChannelSheet() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => store.setAddingChannel(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await createChannel(name.trim());
      close();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New channel" size="sheet" onClose={close} text="A Teams channel where people can write to bots, through a Power Automate flow.">
      <form
        className="pb-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="pb-field pb-field-wide">
          <label className="pb-label" htmlFor="new-channel-name">
            Name
          </label>
          <input id="new-channel-name" className="pb-input" type="text" value={name} maxLength={60} autoComplete="off" placeholder="Ops - Internal" data-autofocus disabled={busy} onChange={(e) => setName(e.target.value)} />
          <span className="pb-hint">Use the channel's name in Teams, so you and the bots know which one it is. Who may write and which tag reaches which bot are set on its page.</span>
        </div>
        {error && (
          <p className="pb-hint app-hint-error" role="alert">
            {error}
          </p>
        )}
        <div className="pb-dialog-actions">
          <button className="pb-btn pb-btn-quiet" type="button" onClick={close}>
            Cancel
          </button>
          <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || !name.trim()}>
            Create channel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
