// The floating reading panel: a bot's page. The head holds the face, the name, quiet text tabs
// (Chat, Job, Files, Triggers, History, Settings) and the status. Chat is the default; the open tab is
// remembered per bot while the app is open.
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Bot, HelperItem } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { HELPER_WORD, STATE_WORD, statusWord, stopHolds } from "../lib/words";
import { codexReady, helperModelLabel } from "../lib/models";
import { usePhone } from "../lib/phone";
import { phoneOpen } from "../state/screens";
import { canUpload, ensureThread, helperBack, stopHelper, updateBot } from "../state/actions";
import { addFiles } from "../state/tray";
import { store, useAppState, type BotTab, type HelperFrame } from "../state/store";
import { BotTabs as Tabs } from "./BotTabs";
import { BackIcon, Face, ForwardIcon, Mark, Status } from "./bits";
import { PhoneBack } from "./PhoneBack";
import { ArtifactsView } from "./ArtifactsView";
import { Composer, filesFor } from "./Composer";
import { Confirm } from "./Dialog";
import { FilesView, JobView } from "./FilesView";
import { HistoryView } from "./HistoryView";
import { VacationChat } from "./VacationControls";
import { SettingsView } from "./SettingsView";
import { Thread } from "./Thread";
import { PlanPanel } from "./PlanPanel";
import { QueueStack } from "./QueueStack";
import { TriggersView } from "./TriggersView";
import { TaskManagerPane } from "./TaskManagerPane";
import { isManagerFrame } from "../lib/task-managers";

/** Wait this long before saying the connection dropped: most drops mend before anyone notices. */
const QUIET_MS = 2000;
/** Wait this long before saying the first connection has not come up yet. */
const FIRST_QUIET_MS = 5000;

/** `covered`: the artifact panel fills the main area over it; it stays where it was underneath. */
export function ChatPanel({ bot, pickerOpenAtStart, covered = false }: { bot: Bot; pickerOpenAtStart?: boolean; covered?: boolean }) {
  const tab = useAppState((s) => s.tabs[bot.id] ?? "chat");
  const helperOpen = useAppState((s) => (s.helpers[bot.id]?.length ?? 0) > 0);
  const panelId = `bot-${bot.id}-${tab}`;
  const drop = useDrop(bot.id, tab === "chat" && !helperOpen && !covered && !bot.vacationSince && canUpload());
  const phone = usePhone();
  return (
    <main className="pb-main app-main" aria-label={bot.name} inert={covered || undefined} aria-hidden={(phone && covered) || undefined} data-drop={drop.over || undefined} {...drop.handlers}>
      {drop.over && (
        <div className="pb-drop" aria-hidden="true">
          <span className="pb-drop-note">Drop here to attach</span>
        </div>
      )}
      {phone ? <PhoneHead bot={bot} tab={tab} panelId={panelId} helperOpen={helperOpen} /> : <Header bot={bot} tab={tab} panelId={panelId} />}
      <div className="app-tabpanel" role="tabpanel" id={panelId} aria-labelledby={`tab-${bot.id}-${tab}`} data-tab={tab}>
        {tab === "chat" && <ChatTab bot={bot} pickerOpenAtStart={pickerOpenAtStart} />}
        {tab === "job" && <JobView key={bot.id} bot={bot} />}
        {tab === "files" && <FilesView key={bot.id} bot={bot} />}
        {tab === "artifacts" && <ArtifactsView key={bot.id} bot={bot} />}
        {tab === "triggers" && <TriggersView key={bot.id} bot={bot} />}
        {tab === "history" && <HistoryView key={bot.id} bot={bot} />}
        {tab === "settings" && <SettingsView key={bot.id} bot={bot} />}
      </div>
    </main>
  );
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

/**
 * Files dropped anywhere on a bot's chat go into its message box. While files are dragged over it,
 * a calm outline and one line over the chat say so; nothing in the chat moves. Drags of text or of
 * anything that is not a file are left alone.
 */
function useDrop(botId: string, on: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!on) {
      depth.current = 0;
      setOver(false);
      return;
    }
    // A file let go of beside the chat must not make the browser leave Pobots to show it.
    const keep = (e: globalThis.DragEvent) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
    };
    const end = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
      window.removeEventListener("dragend", end);
    };
  }, [on]);
  if (!on) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) addFiles(botId, filesFor(botId, files));
        document.querySelector<HTMLTextAreaElement>(".app-main .pb-composer textarea")?.focus({ preventScroll: true });
      },
    },
  };
}

const NO_FRAMES: HelperFrame[] = [];

function ChatTab({ bot, pickerOpenAtStart }: { bot: Bot; pickerOpenAtStart?: boolean }) {
  const [error, setError] = useState<string>();
  const stack = useAppState((s) => s.helpers[bot.id] ?? NO_FRAMES);
  const frame = stack[stack.length - 1];

  // A task manager's own thread has a message box and its settings (docs/build/step-task-managers.md).
  const managed = useAppState((s) => (frame ? isManagerFrame(s, bot, frame) : false));

  useEffect(() => setError(undefined), [bot.id]);

  if (frame) return managed && !bot.vacationSince ? <TaskManagerPane key={frame.helperThreadId} bot={bot} frame={frame} stack={stack} /> : <HelperPane key={frame.helperThreadId} bot={bot} frame={frame} stack={stack} />;

  return (
    <>
      {/* The bot's own to-do list (step 7a): floating at the top right, or one line above the chat. */}
      <PlanPanel bot={bot} />
      <Thread bot={bot} />
      <div className="pb-main-foot">
        <div className="app-foot">
          <QuietLines bot={bot} />
          {error && (
            <p className="app-line app-line-error" role="alert">
              <Mark state="blocked" />
              {error}
            </p>
          )}
          {/* Waiting messages stand here until the bot takes them, with their line (step 7a). */}
          {bot.vacationSince ? <VacationChat key={bot.id} bot={bot} /> : (
            <>
              <QueueStack bot={bot} />
              <Composer key={bot.id} bot={bot} pickerOpenAtStart={pickerOpenAtStart} onError={setError} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A helper's thread in the place of the bot's chat. One calm line above it says where you are and
 * takes you back; where the message box would be, one quiet sentence, and "Stop helper" while it works.
 */
function HelperPane({ bot, frame, stack }: { bot: Bot; frame: HelperFrame; stack: HelperFrame[] }) {
  // The row's item, live, once the thread it stands in is loaded. The copy in the frame stands in until then.
  const item = useAppState((s) => s.threads[frame.threadId]?.items.find((i): i is HelperItem => i.id === frame.itemId && i.kind === "helper"));
  const back = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const depth = stack.length;
  const parent = stack[depth - 2];
  const parentItem = useAppState((s) => (parent ? s.threads[parent.threadId]?.items.find((i): i is HelperItem => i.id === parent.itemId && i.kind === "helper") : undefined));
  const backTo = parent ? (parentItem?.title ?? parent.title) || "Helper" : bot.name;
  const status = item?.status ?? frame.status;
  const title = (item?.title ?? frame.title).trim() || "Helper";
  const running = status === "running";
  const models = useAppState((s) => s.models);
  const modelLabel = helperModelLabel(models, item ?? {});
  // A worker of a task manager works for that task manager, not for the bot directly (protocol 21).
  const manager = parent ? bot.taskManagers?.find((t) => t.managerThreadId === parent.helperThreadId) : undefined;

  // The thread the row stands in is read too, so the row's state is live after a reload.
  useEffect(() => ensureThread(frame.threadId), [frame.threadId]);
  // Opening moves the focus to the way back, without scrolling anything. Coming back up from a
  // helper further in, the row it came from has the focus already and keeps it.
  useEffect(() => {
    if (!document.activeElement?.closest(".pb-helper")) back.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!running) setAsking(false);
  }, [running]);

  const goBack = () => helperBack(bot.id);
  const stop = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await stopHelper(bot.id, frame.itemId);
      setAsking(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="pb-helper-bar" role="navigation" aria-label="Where you are">
        <button ref={back} type="button" className="pb-helper-back" aria-label={`Back to ${backTo}`} onClick={goBack}>
          <BackIcon />
          <span className="pb-helper-back-name">{backTo}</span>
        </button>
        <span className="pb-helper-bar-sep" aria-hidden="true">
          <ForwardIcon />
        </span>
        <h2 className="pb-helper-bar-title" title={title}>
          {title}
        </h2>
        {modelLabel && (
          <span className="pb-helper-model pb-helper-bar-model" title={`Runs on ${modelLabel}`}>
            {modelLabel}
          </span>
        )}
        <span className="pb-helper-bar-state" data-status={status}>
          {running && <Mark state="thinking" />}
          <span className="pb-fade-in" key={status}>
            {HELPER_WORD[status]}
          </span>
        </span>
      </div>
      <Thread bot={bot} helper={{ frame, item, depth }} />
      <div className="pb-main-foot">
        <div className="app-foot">
          <QuietLines bot={bot} />
          <div className="pb-helper-foot">
            <p className="pb-helper-note">{manager ? `This worker works for the task manager ${manager.title}. Write to it to change what it does.` : `This helper works for ${bot.name}. Write to ${bot.name} to change what it does.`}</p>
            {/* Kept in place, out of sight, once the helper has ended, so the foot keeps its height. */}
            <button
              type="button"
              className="pb-btn pb-btn-sm"
              data-gone={!running || undefined}
              aria-hidden={!running || undefined}
              tabIndex={running ? undefined : -1}
              onClick={() => {
                if (!running) return;
                setError(undefined);
                setAsking(true);
              }}
            >
              Stop helper
            </button>
          </div>
        </div>
      </div>
      {asking && (
        <Confirm
          title="Stop this helper?"
          text={manager ? "Its task manager is told that it was stopped and carries on without its result." : `${bot.name} is told that it was stopped and carries on without its result.`}
          yes="Stop helper"
          no="Cancel"
          tone="danger"
          busy={busy}
          error={error}
          onYes={() => void stop()}
          onNo={() => setAsking(false)}
        />
      )}
    </>
  );
}

/**
 * Lines about the app itself: Claude is not ready, the engine connection dropped. For a bot on a GPT
 * model, Codex takes Claude's place: its sentence when Codex is not ready (step 3a).
 */
export function QuietLines({ bot }: { bot?: Bot } = {}) {
  const status = useAppState((s) => s.status);
  const connection = useAppState((s) => s.connection);
  const [now, setNow] = useState(() => Date.now());

  const down = connection.phase === "reconnecting" || connection.phase === "connecting";
  useEffect(() => {
    if (!down) return;
    const wait = connection.phase === "connecting" ? FIRST_QUIET_MS : QUIET_MS;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, connection.since + wait - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [down, connection.since]);

  const lines: string[] = [];
  if (connection.phase === "refused" && connection.message) lines.push(connection.message);
  else if (connection.phase === "reconnecting" && now - connection.since >= QUIET_MS) lines.push("Lost the connection to the engine. Trying again.");
  else if (connection.phase === "connecting" && now - connection.since >= FIRST_QUIET_MS) lines.push("Cannot reach the engine yet. Trying again.");
  if (bot?.harness === "codex") {
    if (status && !codexReady(status)) lines.push(status.codex?.problem ?? "Codex is not ready on this machine.");
  } else if (status && !status.claude.ready) lines.push(status.claude.problem ?? "Claude is not ready on this machine.");

  return (
    <>
      {lines.map((line) => (
        <p className="app-line" role="status" key={line}>
          {line}
        </p>
      ))}
    </>
  );
}

function Header({ bot, tab, panelId }: { bot: Bot; tab: BotTab; panelId: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(bot.name);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    setEditing(false);
    setError(undefined);
  }, [bot.id]);

  useEffect(() => {
    if (editing) input.current?.select();
    else if (refocus.current) {
      refocus.current = false;
      nameButton.current?.focus();
    }
  }, [editing]);

  const start = () => {
    setName(bot.name);
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
    if (!save || next === bot.name || !next) {
      setError(undefined);
      return;
    }
    updateBot(bot.id, { name: next }).catch((e: unknown) => setError(messageOf(e)));
  };

  return (
    <header className="pb-main-head app-head">
      <Face look={bot.look} state={bot.state} />
      <div className="app-head-text">
        {editing ? (
          <input
            ref={input}
            className="app-rename"
            value={name}
            aria-label="Bot name"
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
            <button ref={nameButton} type="button" className="app-name" title="Rename" aria-label={`${bot.name}. Rename`} onClick={start}>
              {bot.name}
            </button>
          </h1>
        )}
        <div className="pb-row-line">{error ?? (bot.role === "main" ? "Main bot" : "Bot")}</div>
      </div>
      <Tabs bot={bot} tab={tab} panelId={panelId} />
      <Status state={bot.state} word={statusWord(bot)} />
    </header>
  );
}

/** The tab the bot's page opens on, on a phone: the one shown last, or the job. */
const pageTabs = new Map<string, Exclude<BotTab, "chat">>();

/**
 * The head of a bot's screen on a phone. On the chat: the way back, the face, the name and what the
 * bot is doing, "Needs you 2" while cards wait anywhere, and "Page", which opens the bot's page as a
 * sheet. On the page: the way back to the chat, the name, and the row of tabs, which scrolls inside
 * itself. While a helper's thread is open its own bar leads back, so this way back steps aside in
 * place (the head keeps its height).
 */
function PhoneHead({ bot, tab, panelId, helperOpen }: { bot: Bot; tab: BotTab; panelId: string; helperOpen: boolean }) {
  const cards = useAppState((s) => s.cards.length);
  const page = tab !== "chat";
  // What the bot is doing, as its row on the Bots screen says it.
  const line = bot.activity || STATE_WORD[bot.state];
  useEffect(() => {
    if (page) pageTabs.set(bot.id, tab);
  }, [bot.id, tab, page]);
  const openPage = () => store.leave(() => store.setTab(bot.id, pageTabs.get(bot.id) ?? "job"));
  return (
    <header className="pb-main-head app-head app-phone-head" data-page={page || undefined}>
      <PhoneBack label={page ? "Chat" : undefined} hidden={!page && helperOpen} />
      <Face look={bot.look} state={bot.state} />
      <div className="app-head-text">
        <h1 className="app-phone-name">{bot.name}</h1>
        <div className="pb-row-line app-phone-status">
          <span className="pb-fade-in" key={line}>
            {line}
          </span>
        </div>
      </div>
      {!page && cards > 0 && (
        <button type="button" className="pb-artifact-needs app-phone-needs" aria-label={`Needs you, ${cards}. Show what needs you`} onClick={() => phoneOpen("needs")}>
          <Mark state="waiting" />
          <span className="pb-artifact-needs-word">Needs you</span>
          <span className="pb-artifact-needs-n pb-fade-in" key={cards}>
            {cards}
          </span>
        </button>
      )}
      {!page && (
        <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet app-phone-page" aria-label={`${bot.name}'s page: job, files, settings and more`} onClick={openPage}>
          Page
        </button>
      )}
      {page && <Tabs bot={bot} tab={tab} panelId={panelId} />}
    </header>
  );
}
