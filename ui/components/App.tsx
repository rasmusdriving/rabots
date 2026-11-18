// The window: roster, the open bot's page and the "Needs you" rail. Or the first-run screen.
// Also the two things that float over everything: the sheet for adding a bot and the question
// asked before leaving unsaved text.
import { useEffect, type CSSProperties } from "react";
import { usePhone } from "../lib/phone";
import { useRailWidth } from "../lib/rail-width";
import { shareOf, store, useAppState } from "../state/store";
import { AddBotSheet } from "./AddBot";
import { AppSettingsPage } from "./AppSettings";
import { ArtifactPane, usePanelLayout, type PanelMode } from "./ArtifactPane";
import { ChannelPage, ChannelSheet } from "./ChannelView";
import { ChatPanel, QuietLines } from "./ChatPanel";
import { Confirm, Dialog } from "./Dialog";
import { FirstRun } from "./FirstRun";
import { Rail } from "./Rail";
import { RailHandle } from "./RailHandle";
import { Roster } from "./Roster";
import type { Bot } from "../../shared/protocol";
import type { BotTab, PhoneScreen } from "../state/store";

export function App({ pickerOpenAtStart = false }: { pickerOpenAtStart?: boolean }) {
  const ready = useAppState((s) => s.ready);
  const bots = useAppState((s) => s.bots);
  const openBotId = useAppState((s) => s.openBotId);
  const channel = useAppState((s) => (s.openChannelId ? s.channels.find((c) => c.id === s.openChannelId) : undefined));
  const panel = useAppState((s) => s.panel);
  const share = useAppState(shareOf);
  const appSettings = useAppState((s) => s.appSettings);
  const layout = usePanelLayout(share);
  const phone = usePhone();
  const screen = useAppState((s) => s.phoneScreen);
  const tab = useAppState((s) => (s.openBotId ? (s.tabs[s.openBotId] ?? "chat") : "chat"));
  const rail = useRailWidth();

  // A panel kept from before a reload for a bot that is gone closes.
  useEffect(() => {
    if (ready && panel?.kind === "artifact" && !bots.some((b) => b.id === panel.botId)) store.setPanel(null);
  }, [ready, panel, bots]);

  if (!ready) {
    // Before the first snapshot: the bare ground, and a quiet line if it takes long.
    return (
      <div className="app-first">
        <div className="app-first-drag" />
        <div className="app-first-body app-waiting">
          <QuietLines />
        </div>
      </div>
    );
  }

  if (bots.length === 0) return <FirstRun />;

  const bot = bots.find((b) => b.id === openBotId) ?? bots[0]!;
  if (phone) return <PhoneApp bot={bot} screen={screen} tab={tab} pickerOpenAtStart={pickerOpenAtStart} />;
  // The artifact panel stands in the place of the rail beside the bot's page; it fills the main area
  // when asked, and takes the place of the chat when the window is too narrow for both. The chat and
  // the rail stay where they are underneath, so closing shows them exactly as they were.
  // The browser is not one bot's: it stays beside any bot's page and a channel's.
  // The settings window (step 7b) floats over everything, which stays where it is underneath, out of reach.
  const open = panel && (panel.kind === "browser" || (!channel && panel.botId === bot.id)) ? panel : null;
  const mode: PanelMode | undefined = !open ? undefined : layout.narrow ? "narrow" : open.full ? "full" : "side";
  // The rail's width, when the person chose one (step rail-resize); otherwise app.css's default.
  const style =
    mode === "side" || mode === "full"
      ? ({ "--artifact-w": `${layout.px}px` } as CSSProperties)
      : rail.stored !== null && rail.can
        ? ({ "--rail-w": `${rail.px}px` } as CSSProperties)
        : undefined;
  return (
    <div className="pb-shell app-shell" data-artifact={mode} data-modal={appSettings ? "settings" : undefined} style={style}>
      <div className="app-drag" aria-hidden="true" />
      <Roster covered={appSettings} />
      {/* Under the settings window everything stays where it is, out of reach. */}
      {channel ? (
        <ChannelPage key={channel.id} channel={channel} covered={appSettings} />
      ) : (
        <ChatPanel bot={bot} pickerOpenAtStart={pickerOpenAtStart} covered={appSettings || mode === "full" || mode === "narrow"} />
      )}
      <Rail covered={!!mode || appSettings} />
      {!mode && !appSettings && rail.can && <RailHandle rail={rail} />}
      {open && mode && <ArtifactPane bot={bot} panel={open} mode={mode} layout={layout} backName={channel?.name ?? bot.name} />}
      {appSettings && <AppSettingsPage />}
      <Floating />
    </div>
  );
}

/** What floats over everything: the sheets for adding a bot or a channel, a blocked link, the question before leaving unsaved text. */
function Floating() {
  const adding = useAppState((s) => s.adding);
  const addingChannel = useAppState((s) => s.addingChannel);
  const leaveAsk = useAppState((s) => s.leaveAsk);
  const blocked = useAppState((s) => s.blockedLink);
  return (
    <>
      {adding && <AddBotSheet />}
      {addingChannel && <ChannelSheet />}
      {blocked && (
        <Dialog title="Open on Claude" text="The browser kept the window from opening. Use the link instead." onClose={() => store.setBlockedLink(null)}>
          <div className="pb-dialog-actions">
            <button className="pb-btn pb-btn-quiet" type="button" onClick={() => store.setBlockedLink(null)}>
              Close
            </button>
            <a className="pb-btn pb-btn-primary" href={blocked.url} target="_blank" rel="noopener noreferrer" data-autofocus onClick={() => store.setBlockedLink(null)}>
              {`Open ${blocked.title}`}
            </a>
          </div>
        </Dialog>
      )}
      {leaveAsk && (
        <Confirm
          title="Leave without saving?"
          text={`You changed ${leaveAsk.unsaved.what} and did not save it.`}
          yes="Leave without saving"
          no="Keep editing"
          tone="danger"
          onYes={leaveAsk.go}
          onNo={() => store.stayHere()}
        />
      )}
    </>
  );
}

/**
 * The window on a phone (docs/build/step-phone.md): one column, one thing on screen at a time. The
 * roster is the Bots screen, the reading panel a bot's screen (its chat, or its page as a sheet), the
 * rail the Needs you screen, and the panel and Pobots settings sheets over them. Every part stays laid
 * out in the one cell, the hidden ones out of sight and inert, so each keeps its place and nothing
 * arrives again when it shows. Which one shows is the screen in history (state/screens.ts).
 */
function PhoneApp({ bot, screen, tab, pickerOpenAtStart }: { bot: Bot; screen: PhoneScreen; tab: BotTab; pickerOpenAtStart: boolean }) {
  const channel = useAppState((s) => (s.openChannelId ? s.channels.find((c) => c.id === s.openChannelId) : undefined));
  const panel = useAppState((s) => s.panel);
  const appSettings = useAppState((s) => s.appSettings);
  const share = useAppState(shareOf);
  const layout = usePanelLayout(share);
  const open = !appSettings && panel && (panel.kind === "browser" || (screen === "bot" && !channel && panel.botId === bot.id)) ? panel : null;
  const sheet = appSettings ? "settings" : open ? open.kind : screen === "bot" && !channel && tab !== "chat" ? "page" : undefined;
  const covered = (part: PhoneScreen) => screen !== part || (!!sheet && sheet !== "page");
  return (
    <div className="pb-shell app-shell" data-phone="" data-phone-screen={screen} data-phone-sheet={sheet} data-artifact={open ? "narrow" : undefined} data-page={appSettings ? "settings" : undefined}>
      <Roster covered={covered("bots")} />
      {channel ? (
        <ChannelPage key={channel.id} channel={channel} covered={covered("bot")} />
      ) : (
        <ChatPanel bot={bot} pickerOpenAtStart={pickerOpenAtStart} covered={covered("bot")} />
      )}
      {appSettings && <AppSettingsPage />}
      <Rail covered={covered("needs")} />
      {open && <ArtifactPane bot={bot} panel={open} mode="narrow" layout={layout} backName={backName(screen, channel?.name ?? bot.name)} />}
      <Floating />
    </div>
  );
}

/** The words of the way back from a sheet: where it leads. */
const backName = (screen: PhoneScreen, name: string) => (screen === "bots" ? "Bots" : screen === "needs" ? "Needs you" : name);
