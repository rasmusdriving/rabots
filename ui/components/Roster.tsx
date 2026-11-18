// The left side, on the ground: the name, the bots with a quiet add control, then at the bottom the
// channels (with their own add control), the browser, the machines, and the icon row (step 7b):
// settings, usage, and the update arrow when Claude Code or Codex has an update.
import { useEffect, useRef, useState } from "react";
import type { Bot, Channel } from "../../shared/protocol";
import { usePhone } from "../lib/phone";
import { openBrowserFromRoster } from "../state/actions";
import { phoneGo, phoneOpen } from "../state/screens";
import { store, useAppState } from "../state/store";
import { countWord, MACHINE_CONNECTED, MACHINE_WORD, STATE_WORD } from "../lib/words";
import { BrowserIcon, Face, ForwardIcon, GearIcon, Mark, PlusIcon, SpeechIcon, UpdateIcon, UsageIcon } from "./bits";
import { UpdateDialog } from "./SettingsWindow";

/** `covered`: on a phone, another screen or a sheet shows; the roster stays laid out underneath, out of sight, so it keeps its place. */
export function Roster({ covered = false }: { covered?: boolean } = {}) {
  const bots = useAppState((s) => s.bots);
  const machines = useAppState((s) => s.machines);
  const openBotId = useAppState((s) => s.openBotId);
  const openChannelId = useAppState((s) => s.openChannelId);
  const engineHere = useAppState((s) => s.engineHere);
  const appSettings = useAppState((s) => s.appSettings);
  const phone = usePhone();
  const nav = useRef<HTMLElement>(null);
  const shownOnce = useRef(false);

  // On a phone, coming back to Bots gives the focus to the row of the bot that was open, where it
  // was (the roster kept its place underneath), without scrolling anything.
  useEffect(() => {
    if (!phone || covered) return;
    if (!shownOnce.current) {
      shownOnce.current = true;
      return;
    }
    const at = document.activeElement;
    if (at && at !== document.body && nav.current?.contains(at)) return;
    nav.current?.querySelector<HTMLElement>(".app-row[aria-current], .pb-channel-row[aria-current]")?.focus({ preventScroll: true });
  }, [phone, covered]);

  return (
    <nav ref={nav} className="pb-side app-side" aria-label="Bots" inert={covered || undefined} aria-hidden={covered || undefined}>
      <div className="app-side-top">
        <div className="pb-wordmark">Pobots</div>
      </div>
      {phone && <NeedsRow />}
      <div className="pb-side-group app-scroll">
        <div className="pb-side-head">
          <div className="pb-side-title" id="bots-title">
            Bots
          </div>
          <button className="pb-icon-btn pb-icon-btn-sm app-add-bot" type="button" aria-label="Add a bot" title="Add a bot" onClick={() => store.setAdding(true)}>
            <PlusIcon />
          </button>
        </div>
        <ul className="app-list" aria-labelledby="bots-title">
          {bots.map((bot) => (
            <li key={bot.id}>
              <BotRow bot={bot} open={!openChannelId && !appSettings && bot.id === openBotId} phone={phone} />
            </li>
          ))}
        </ul>
      </div>
      <div className="app-side-foot">
        <Channels />
        <BrowserLine />
        {machines.length > 0 && (
          <div className="pb-side-group app-machines">
            <div className="pb-side-title">Machines</div>
            {machines.map((m) => (
              <div className="pb-side-line" key={m.id}>
                <span>{m.name}</span>
                <span>{m.status === "this" && !engineHere ? MACHINE_CONNECTED : MACHINE_WORD[m.status]}</span>
              </div>
            ))}
          </div>
        )}
        <FootIcons />
      </div>
    </nav>
  );
}

/**
 * Step 7b: the icon row at the very foot, as in T3 Code's sidebar: the gear (the settings window; a
 * small quiet dot while no backup key is saved), the bars (the settings window on Usage), and at
 * the right a round arrow only while Claude Code or Codex has an update (or one runs). The arrow's
 * place is kept when it is not there, so nothing moves when it comes.
 */
function FootIcons() {
  const open = useAppState((s) => s.appSettings);
  const section = useAppState((s) => s.appSettingsSection);
  const noKey = useAppState((s) => !!s.backup && !s.backup.key);
  const providers = useAppState((s) => s.providers);
  const [asking, setAsking] = useState(false);
  const todo = providers?.providers.filter((p) => p.updateAvailable) ?? [];
  const running = !!providers?.update && !providers.update.endedAt;
  const show = todo.length > 0 || running;
  const updateWords = running ? "Updating" : `Update ${todo.map((p) => p.label).join(" and ")}`;
  const settingsLabel = `Settings${noKey ? ", backup not set up" : ""}`;
  return (
    <div className="pb-side-group app-foot-icons">
      <div className="pb-foot-icons">
        <button
          type="button"
          className="pb-foot-icon pb-foot-settings"
          title={noKey ? "Settings: backup not set up" : "Settings"}
          aria-label={settingsLabel}
          aria-current={open && section !== "usage" ? "page" : undefined}
          onClick={() => store.openAppSettings("general")}
        >
          <GearIcon />
          <span className="pb-foot-dot" data-show={noKey || undefined} aria-hidden="true" />
        </button>
        <button type="button" className="pb-foot-icon pb-foot-usage" title="Usage" aria-label="Usage" aria-current={open && section === "usage" ? "page" : undefined} onClick={() => store.openAppSettings("usage")}>
          <UsageIcon />
        </button>
        <span className="pb-foot-space" />
        <button
          type="button"
          className="pb-foot-update"
          data-show={show || undefined}
          data-running={running || undefined}
          aria-hidden={!show || undefined}
          tabIndex={show ? 0 : -1}
          title={updateWords}
          aria-label={updateWords}
          onClick={() => show && setAsking(true)}
        >
          <UpdateIcon />
        </button>
      </div>
      {asking && <UpdateDialog onClose={() => setAsking(false)} />}
    </div>
  );
}

/**
 * One quiet line for the bots' browser, only while it can be reached: "Browser" and how much is open
 * ("2 open", nothing when none). It opens the browser beside the chat: on the open bot's workspace
 * when it has one, else the newest bot workspace, else the person's own page. No badge, no colour.
 * In a roster of faces only it is a small drawn window, its words read out.
 */
function BrowserLine() {
  const browser = useAppState((s) => s.browser);
  const open = useAppState((s) => s.panel?.kind === "browser");
  if (!browser.available) return null;
  const n = browser.spaces.length;
  const word = n > 0 ? `${n} open` : "";
  return (
    <div className="pb-side-group app-browser">
      <button
        type="button"
        className="pb-browser-line"
        title={word ? `Browser: ${word}` : "Browser"}
        aria-label={`Browser${word ? `, ${word}` : ""}. Opens beside the chat`}
        aria-current={open ? "true" : undefined}
        onClick={() => openBrowserFromRoster()}
      >
        <span className="pb-browser-line-mark" aria-hidden="true">
          <BrowserIcon />
        </span>
        <span className="pb-browser-line-name">Browser</span>
        <span className="pb-browser-line-word">{word}</span>
      </button>
    </div>
  );
}

/** The quiet "Channels" group: each channel by name with "on" or "off", and a small add control. */
function Channels() {
  const channels = useAppState((s) => s.channels);
  const openChannelId = useAppState((s) => s.openChannelId);
  const appSettings = useAppState((s) => s.appSettings);
  const phone = usePhone();
  return (
    <div className="pb-side-group app-channels">
      <div className="pb-side-head">
        <div className="pb-side-title" id="channels-title">
          Channels
        </div>
        <button className="pb-icon-btn pb-icon-btn-sm app-add-channel" type="button" aria-label="Add a channel" title="Add a channel" onClick={() => store.setAddingChannel(true)}>
          <PlusIcon />
        </button>
      </div>
      {channels.length > 0 && (
        <ul className="app-list" aria-labelledby="channels-title">
          {channels.map((c) => (
            <li key={c.id}>
              <ChannelRow channel={c} open={!appSettings && c.id === openChannelId} phone={phone} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelRow({ channel, open, phone }: { channel: Channel; open: boolean; phone: boolean }) {
  const word = channel.enabled ? "on" : "off";
  return (
    <button
      type="button"
      className="pb-channel-row"
      data-off={!channel.enabled || undefined}
      title={`${channel.name}: ${word}`}
      aria-label={`${channel.name}, channel, ${word}`}
      aria-current={open ? "true" : undefined}
      onClick={() => {
        // On a phone the row opens the channel's screen, also when it was the one open last.
        if (!open || phone) store.leave(() => store.openChannel(channel.id));
      }}
    >
      <span className="pb-channel-mark" aria-hidden="true">
        <SpeechIcon />
      </span>
      <span className="pb-channel-name">{channel.name}</span>
      <span className="pb-channel-word">{word}</span>
    </button>
  );
}

function BotRow({ bot, open, phone }: { bot: Bot; open: boolean; phone: boolean }) {
  const line = bot.activity || STATE_WORD[bot.state];
  return (
    <button
      type="button"
      className="pb-row app-row"
      data-state={bot.state}
      title={`${bot.name}: ${line}`}
      aria-label={`${bot.name}, ${line}`}
      aria-current={open ? "true" : undefined}
      onClick={() => {
        // On a phone the row opens the bot's screen on its chat, also when it was the one open last.
        if (phone)
          store.leave(() =>
            phoneGo(() => {
              store.setTab(bot.id, "chat");
              store.openBot(bot.id);
            }),
          );
        else if (!open) store.leave(() => store.openBot(bot.id));
      }}
    >
      <Face look={bot.look} state={bot.state} />
      <span className="pb-row-text">
        <span className="pb-row-name">{bot.name}</span>
        <span className="pb-row-line">{line}</span>
      </span>
      <Mark state={bot.state} title={STATE_WORD[bot.state]} />
    </button>
  );
}

/**
 * On a phone, under the name: one raised row while something needs you, "Two things need you", that
 * opens the Needs you screen. Nothing while nothing does. The count changes in place.
 */
function NeedsRow() {
  const n = useAppState((s) => s.cards.length);
  // Step 7c: while only to-dos wait, the row leads to them (they are on the Needs you screen).
  const todos = useAppState((s) => s.todos.length);
  if (n === 0 && todos === 0) return null;
  const words = n > 0 ? `${countWord(n)} ${n === 1 ? "thing needs" : "things need"} you` : `${countWord(todos)} ${todos === 1 ? "to-do" : "to-dos"} for you`;
  return (
    <button type="button" className="app-needs-row" aria-label={`${words}. Show what needs you`} onClick={() => phoneOpen("needs")}>
      <Mark state="waiting" />
      <span className="app-needs-row-words pb-fade-in" key={n}>
        {words}
      </span>
      <span className="app-needs-row-go" aria-hidden="true">
        <ForwardIcon />
      </span>
    </button>
  );
}
