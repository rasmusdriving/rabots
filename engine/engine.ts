// The engine: the class `Engine`, its state (fields), its constructor and the hubs it builds, the
// protocol's methods (each a method of `Engine`; most are one line that calls the part in
// engine/core/), the bots' items, messages and their queue (`sendMessage`, `enqueue`), status and
// models, settings, and shutdown. `ENGINE_VERSION` stays here: scripts read it as text.
//
// The parts, as functions that take the engine as `eng` (split on 15 Nov 2026, docs/build/step-split.md):
//   core/runtime.ts         a bot's runtime and the other kinds of state, the one call scope, shared words
//   core/words.ts           small helpers with no state
//   core/start-up.ts        loading the bots at start, tidying what a stop left
//   core/turn-start.ts      a turn's start and the bot's session
//   core/harness-events.ts  what a session reports during a turn, the bot's own to-do list
//   core/turn-end.ts        a turn's end and what follows it, fresh sessions and tidy turns
//   core/steering.ts        steering a message into a running turn
//   core/stop.ts            Stop and its holds
//   core/helpers.ts         helpers: rows, events, tasks, ending and stopping; helper-control.ts, helper-read.ts: read_helper, steer_helper, stop_helper
//   core/start-helper.ts    start_helper, results that wait for a turn, a GPT bot's slow tool calls
//   core/cards.ts           cards
//   core/asks.ts            messages between bots; bot-steer.ts: message_bot's delivery steer
//   core/bot-tools.ts       the bots' tools, the chat tools, the words for a tool call
//   core/main-bot-tools.ts  the main bot's settings tools
//   core/bot-changes.ts, bot-view.ts, sees-tools.ts, pobots-tools.ts, notes.ts: the main bot's tools (docs/main-bot.md)
//   core/bot-admin.ts       making, changing, retiring and stopping bots; their files, history and rules
//   core/artifacts.ts       artifacts and page keys
//   core/triggers.ts        triggers, webhook calls and the schedule clock
//   core/trigger-tools.ts   the bots' trigger tools
//   core/channels.ts        channels and replies
//   core/channel-tools.ts   the bots' channel tools
//   core/todos.ts           to-dos for the person
//   core/uploads.ts         attachments and uploads
// The WebSocket and the webhook address live in server.ts, the Claude process in claude/session.ts,
// the git history in history.ts, the files in files.ts, schedule times in schedule.ts.
import { away, requirePresent, setVacation, vacationNeedsStop } from "./core/vacation.js";
import { flushNotes } from "./core/notes.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Artifact,
  Attachment,
  Bot,
  BotContext,
  BotFile as ProtocolBotFile,
  BotState,
  CardDecision,
  Channel,
  ChatSettings,
  SettingsPatch,
  EngineStatus,
  EventName,
  Events,
  Harness,
  Item,
  Machine,
  Methods,
  ModelInfo,
  SavedRule,
  Snapshot,
  Trigger,
  TriggerRun,
  Upcoming,
  UserItem,
} from "../shared/protocol.js";
import { ATTACHMENTS_PER_MESSAGE } from "../shared/protocol.js";
import { ATTACH_WORDS, attachmentPresent, pastKeeping, moveBack, moveToBot, readUpload, type Picture, type ServedFile } from "./attachments.js";
import { slugify, writeBotFile, type BotFolder } from "./bots.js";
import { type PageFile } from "./artifacts.js";
import { BrowserHub, realDriver, type BrowserDriver, type BrowserTimings } from "./browser.js";
import type { ClaudeSetup } from "./claude/detect.js";
import { type ToolWords } from "./claude/labels.js";
import { FALLBACK_MODELS, labelFor, mapModels, modelFor } from "./claude/models.js";
import { type CodexSetup } from "./codex/detect.js";
import { codexLabel, codexModelFor, harnessOfModel, looksLikeCodex, modelHasFast } from "./codex/models.js";
import { type SessionSettings } from "./claude/session.js";
import { Backup, type BackupOptions } from "./core/backup-restic.js";
import { SHORTEN_STUCK_MS, SHORTEN_WAIT_MS } from "./shorten.js";
import { BACKUP_TIME, chatConfig, CONTEXT_DEFAULTS, fullAt, NOTIFY_DEFAULTS, writeConfigPart, type ContextSettings, type EngineConfig } from "./config.js";
import { SettingsHub, type SettingsHubOptions } from "./settings-hub.js";
import { SelfUpdate, type SelfUpdateOptions } from "./self-update.js";
import { showUpdatedCard, tellUpdateAsker } from "./core/pobots-tools.js";
import { TITLE_MODEL_DEFAULT } from "./settings.js";
import { claudeTitleMaker, routedTitleMaker, TITLE_SYSTEM, Titles, toChatTitle, type TitleMaker } from "./titles.js";
import { CodexTitles } from "./codex/titles.js";
import { EngineError } from "./errors.js";
import { type ChangeBy } from "./history.js";
import { log } from "./log.js";
import { Notifier, type NotifyTimers, type Presence, type PushPort } from "./notify.js";
import { PushStore, type Subscription } from "./push.js";
import { localZone } from "./schedule.js";
import type { ChannelMessageRow, Store, ThreadContext } from "./store.js";
import { REPLY_RETRY_MS, REPLY_TIMEOUT_MS, WrongLimiter } from "./channels.js";
import { noReader, readSeesWithClaude, SeesHub, type SeesReader } from "./claude/sees-reader.js";
import type { CodexMcpLister } from "./core/helper-sees.js";
import { RateLimiter } from "./triggers.js";
import { now } from "./core/words.js";
import { type BotRuntime, DEFAULT_WINDOW, helperCount, inBackground, type PendingAsk, type PendingCard, TIDY_ACTIVITY } from "./core/runtime.js";
import { abortUpload, attachmentFile, attachmentKey, beginUpload, discardAttachment, finishUpload, tidyAttachments, tidyUploads, uploadsSize } from "./core/uploads.js";
import { checkArtifacts, listArtifacts, openArtifact, pageRequest, removeArtifact } from "./core/artifacts.js";
import { answerTodo, closeTodo, todoFile } from "./core/todos.js";
import { channelAddress, channelCall, channelMessages, channelNewAddress, getChannel, removeChannel, repliesSent, saveChannel, toChannel } from "./core/channels.js";
import { checkSchedules, enableTrigger, hookAllowed, hookCall, hookTarget, hookWithinLimits, listTriggers, newAddress, removeTrigger, runTrigger, saveTrigger, triggerAddress, triggerRuns, upcoming, wrongHookCall } from "./core/triggers.js";
import { clearSystemCard, resolveCard, showSystemCard } from "./core/cards.js";
import { keepCardsAtShutdown, WAITED_NOTICE } from "./core/restored-cards.js";
import { makeLinks } from "./core/link-bot.js";
import type { Links, LinksOptions } from "./core/links.js";
import { mayMessage } from "./core/asks.js";
import { toolWords } from "./core/bot-tools.js";
import { noteChanges } from "./core/main-bot-tools.js";
import { createBot, deleteFile, history, listFiles, listRules, readChange, readFile, removeRule, retireBot, saveTurnChanges, undoChange, updateBot, writeFile } from "./core/bot-admin.js";
import { endHold, heldWords, interrupt, liveQueue, saveHold, startNextInLine } from "./core/stop.js";
import { noteSent, shown } from "./core/restored-waiting.js";
import { liveTurnId, noteTurnSent } from "./core/live-turn.js";
import { canSteer, queuedOf, steerInto, steerQueued, unqueue } from "./core/steering.js";
import { closeBotItem, cutShortStatus, finishActivity, keptPlan } from "./core/harness-events.js";
import { startTurn } from "./core/turn-start.js";
import { calm, checkContext, startFresh } from "./core/turn-end.js";
import { cancelSettle, stopHelper, stopHelpers } from "./core/helpers.js";
import { closeAllSessions, closeLive, refreshSessions } from "./core/aside.js";
import { aheadLevel, aheadSettings } from "./core/ahead-settings.js";
import { aboutYou, setAboutYou } from "./core/first-start.js";
import { workingHelpers } from "./core/working-helpers.js";
import { closeTaskManagers, taskManagerInfos } from "./core/task-managers.js";
import { init } from "./core/start-up.js";
import { calendarState } from "./core/calendar-settings.js";
import { activityDayFor } from "./core/activity-day.js";

export { HELPER_LAST_MAX, helperLine, helperTitle, insideDir, waitingWords } from "./core/words.js";
export { TIDY_PROMPT, TIDY_REFUSAL } from "./core/runtime.js";

export const ENGINE_VERSION = "0.45.0";

/** How long a bot waits for another bot's answer before the answer is sent later as a message. */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
/** How long an approval card lives in a turn the person did not start. */
const CARD_EXPIRY_MS = 30 * 60 * 1000;

// ------------------------------------------------------------ helpers (docs/build/step-2e.md)

/** A changed helper row is sent at most this often, and always at once when its status changes. */
const HELPER_ROW_MS = 1000;
/** After the last helper ends with no turn running, how long to wait for the harness to wake the bot before it reads as done. */
const WAKE_GRACE_MS = 3000;
/** How long a helper may take to confirm that it stopped before it is marked stopped anyway. */
const HELPER_STOP_MS = 15 * 1000;
/** After an interrupt, helpers still running after this long are stopped one by one. */
const HELPER_NUDGE_MS = 2000;
/** A helper in the background that the harness no longer lists as live is taken as ended after this long. */
const LIVE_CHECK_MS = 3000;

// ------------------------------------------------------------ artifacts (docs/build/step-2f.md)

/** After a tool call, how long to wait before looking whether the bot's artifacts changed (calls come in bursts). */
const ARTIFACT_CHECK_MS = 400;

// ------------------------------------------------------------ GPT models through Codex (docs/build/step-3a.md)

/**
 * How long a call to one of a GPT bot's own tools may take before it is answered with "you get the
 * result in a new message". Codex stops waiting for such a call after about 30 seconds and lets the
 * model poll it instead (seen 12 Nov 2026, codex-cli 0.165.0; notes-engine-3a.md).
 */
const CODEX_TOOL_SOFT_MS = 20 * 1000;

/** What the engine needs from a harness session. ClaudeSession and CodexSession are the real ones; tests use a fake. */
export interface HarnessSession {
  readonly closed: boolean;
  start(): void;
  /**
   * `o.tidy`: this turn is a tidy turn (docs/context.md). The Claude session ignores it: a hook does that work there.
   * `o.pictures`: pictures the person attached, as the engine's copies for the model (docs/build/step-files.md).
   */
  send(text: string, before?: string[], o?: { tidy?: boolean; pictures?: Picture[] }): void;
  /**
   * Steering (protocol 14): puts one message from the person into the running turn, to be read at the
   * turn's next step. `id` is the message's item id, which the session gives back in "turn-end"'s
   * `ahead` and in "steer-returned". True when the harness took it; false when it cannot now (no turn
   * runs, the turn is ending, a tidy turn): the engine then lets the message wait in line. Optional:
   * a session without it never steers.
   */
  steer?(text: string, o: { id: string; pictures?: Picture[] }): Promise<boolean>;
  interrupt(): Promise<void>;
  /** Stops one task of the harness (a helper) by its id. */
  stopTask(taskId: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: Bot["effort"]): Promise<void>;
  setAccess(access: Bot["access"]): Promise<void>;
  /**
   * Fast mode on or off from the next turn, without a new session (step 3b). The engine passes the
   * answer (the choice and the model's fast mode together). Optional so older stand-ins still fit.
   */
  setFast?(fast: boolean): Promise<void>;
  supportedModels(): Promise<Parameters<typeof mapModels>[0]>;
  close(): void;
}

export interface EngineOptions {
  config: EngineConfig;
  store: Store;
  claude: ClaudeSetup;
  emit: <E extends EventName>(event: E, data: Events[E]) => void;
  /** Makes a harness session of the kind asked for. Defaults to a real Claude or Codex session. */
  createSession?: (settings: SessionSettings, harness: Harness) => HarnessSession;
  /** Reads what exists for a bot's folder (docs/sees.md). Defaults to a short Claude session; with stand-in sessions and none given, no read is made. */
  readSees?: SeesReader;
  /** Lists Codex's MCP servers for a folder, for a helper on a GPT model (docs/build/step-helper-sees.md). Defaults to `codex mcp list`; with stand-in sessions and none given, Codex is not asked. */
  listCodexMcp?: CodexMcpLister;
  /** Whether the harness still has a session that can be resumed. Defaults to asking the SDK, or Codex itself. */
  sessionExists?: (sessionId: string, botDir: string, harness: Harness) => Promise<boolean>;
  /**
   * The installed Codex as last checked (step 3a). Not ready until `checkCodex` says otherwise; with
   * neither given, no GPT model is offered and a GPT bot ends blocked with the problem sentence.
   */
  codex?: CodexSetup;
  /** Checks Codex: when the engine starts (without holding it up) and when a GPT bot is about to start and Codex was not ready. */
  checkCodex?: () => Promise<CodexSetup>;
  /** Archives a Codex thread the engine no longer needs. Defaults to asking Codex itself. */
  archiveCodexThread?: (threadId: string) => Promise<void>;
  /** Shorter waits for tests. */
  timings?: {
    askTimeoutMs?: number;
    cardExpiryMs?: number;
    replyTimeoutMs?: number;
    /** How long the calendar flow may take (engine 0.25.0). */
    calendarTimeoutMs?: number;
    replyRetryMs?: number;
    /** See WAKE_GRACE_MS, HELPER_STOP_MS, HELPER_NUDGE_MS, HELPER_ROW_MS, LIVE_CHECK_MS. */
    wakeGraceMs?: number;
    helperStopMs?: number;
    helperNudgeMs?: number;
    helperRowMs?: number;
    liveCheckMs?: number;
    /** See ARTIFACT_CHECK_MS. */
    artifactCheckMs?: number;
    /** See CODEX_TOOL_SOFT_MS. */
    codexToolSoftMs?: number;
    /** Step workers: see SHORTEN_WAIT_MS and SHORTEN_STUCK_MS in shorten.ts. */
    shortenWaitMs?: number;
    shortenStuckMs?: number;
  };
  /** The clock schedules run by. Tests pass one they control. Defaults to Date.now. */
  clock?: () => number;
  /** The time zone schedules run in. Defaults to the machine's own. */
  timeZone?: string;
  /**
   * How helper scripts are started in the bots' browser. Defaults to the real `ego-browser` (unless
   * config.json switches the browser off); null switches it off. Tests pass a stand-in.
   */
  browser?: BrowserDriver | null;
  /** Shorter waits for the browser, for tests. */
  browserTimings?: BrowserTimings;
  /**
   * Notifications (engine/notify.ts). `relay`: the test relay from --push-relay (main.ts only).
   * Tests pass a stand-in push store, a fake clock or shorter waits.
   */
  notify?: { relay?: string; push?: PushPort; timers?: NotifyTimers; graceMs?: Partial<Record<"needs" | "note" | "finished", number>>; foldMs?: number; retryMs?: number };
  /**
   * Step 7b: stand-ins for the providers' update, the version read, the latest-version and hub
   * requests and the usage readers (tests and checks), and how Claude is looked for again after an update.
   */
  settingsHub?: SettingsHubOptions;
  /**
   * A public install's own update (engine 0.34.0, engine/self-update.ts): `installDir` is the running
   * build's folder (main.ts). Left out (as in most tests): nothing about it runs or shows.
   */
  selfUpdate?: Omit<SelfUpdateOptions, "current">;
  checkClaude?: () => Promise<ClaudeSetup>;
  /** Step 7b: what makes a chat's title with a Claude model. Defaults to a `claude -p` call; tests pass a stand-in. A GPT model's titles go through Codex (engine/codex/titles.ts). */
  titleMaker?: TitleMaker;
  titleTimings?: { backfillStartMs?: number; backfillEveryMs?: number };
  /** The nightly backup's stand-ins and shorter waits, for tests. */
  backup?: BackupOptions;
  links?: LinksOptions;
}

/** What a webhook call comes to. The server turns it into an HTTP answer. */
export type HookOutcome = { status: 202; runId: string } | { status: 200; duplicate: true } | { status: 404 } | { status: 503 };

/** What a channel call comes to. The server turns it into an HTTP answer. */
export type ChannelOutcome =
  | { status: 202; messageId: string }
  | { status: 200; body: { ok: true; refused: true } | { ok: true; duplicate: true } | { ok: true; ignored: true } }
  | { status: 400 }
  | { status: 404 }
  | { status: 503 };

/** What a hook address leads to, once the id and secret are right. */
export type HookTarget = "trigger" | "channel";


export class Engine {
  // Members without `private` are shared with the engine's files in engine/core/; only server.ts, main.ts and the tests call the public methods.
  opts: EngineOptions;
  store: Store;
  readonly links: Links;
  bots = new Map<string, BotRuntime>();
  order: string[] = [];
  cards = new Map<string, PendingCard>();
  models: ModelInfo[] = FALLBACK_MODELS;
  modelsFromHarness = false;
  live = new Map<string, Item>();
  dirty = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  stopping = false;
  /** Asks between bots that are not settled yet. */
  asks = new Set<PendingAsk>();
  /** The ask waiting on a queued message, by the message's item id. */
  askByItem = new Map<string, PendingAsk>();
  /** Queued messages that carry a late answer, by item id. */
  lateAnswers = new Set<string>();
  readonly askTimeoutMs: number;
  readonly cardExpiryMs: number;
  readonly clock: () => number;
  /** Step 7c: when this engine started, by its clock (the attachments' clean-up waits a while after it). */
  readonly startedAtMs: number;
  readonly tz: string;
  tickTimer?: NodeJS.Timeout;
  /** Removes unsent uploads older than a day, every hour (also once at start). */
  uploadsTimer?: NodeJS.Timeout;
  /** When the schedules were last looked at. Undefined until the first look after start. */
  lastCheck?: number;
  upcomingList: Upcoming[] = [];
  hookLimits = new RateLimiter();
  wrongHooks = new WrongLimiter();
  /** Answers being posted to channels. Tests wait for them with `repliesSent()`. */
  replies = new Set<Promise<void>>();
  readonly replyTimeoutMs: number;
  readonly replyRetryMs: number;
  /** Step 7b: the settings window's settings, the providers and the usage meters. */
  readonly hub: SettingsHub;
  /** What each bot can see of the person's Claude Code setup, as last read (docs/sees.md). */
  readonly seesHub: SeesHub;
  /** Step 7b: chat titles. */
  readonly titles: Titles;
  /** The quiet Codex app-server that makes a GPT model's chat titles. */
  private readonly codexTitles: CodexTitles;
  readonly wakeGraceMs: number;
  readonly helperStopMs: number;
  readonly shortenTimings: { waitMs: number; stuckMs: number };
  readonly helperNudgeMs: number;
  readonly helperRowMs: number;
  readonly liveCheckMs: number;
  /** Keys under /page/: which artifact each one opens, and until when. Kept in memory only. */
  pageKeys = new Map<string, { artifactId: string; botId: string; expires: number }>();
  /** Artifacts that already got an "updated" line from a publish in a turn, as "<turn>:<artifact id>". */
  publishSeen = new Set<string>();
  /** Bots whose artifacts are to be looked at soon. */
  artifactChecks = new Set<string>();
  artifactTimer?: NodeJS.Timeout;
  readonly artifactCheckMs: number;
  readonly machine: Machine;
  /** The bots' browser (engine/browser.ts). */
  readonly browser: BrowserHub;
  /** The nightly backup (engine/core/backup-restic.ts). */
  readonly backup: Backup;
  /** Notifications when the page is not open (engine/notify.ts). */
  readonly notifier: Notifier;
  /** The engine's own address on this computer, for a webhook's local address. */
  localBase?: string;
  /** The installed Codex as last checked (step 3a). */
  codex: CodexSetup;
  private codexChecking?: Promise<void>;
  readonly codexToolSoftMs: number;
  /** The chat settings (protocol 14), as saved in config.json. */
  chat: ChatSettings;

  constructor(opts: EngineOptions) {
    // Every card reaches the notifier through the engine's own emit, exactly once: a card put back
    // from the database at start is never emitted, so it sends nothing (docs/build/step-push.md, 5).
    const outer = opts.emit;
    const emit = <E extends EventName>(event: E, data: Events[E]): void => {
      outer(event, data);
      if (event === "card.added") this.notifier?.cardAdded((data as Events["card.added"]).card);
      else if (event === "card.removed") this.notifier?.cardRemoved((data as Events["card.removed"]).cardId);
    };
    this.opts = { ...opts, emit };
    this.store = opts.store;
    this.machine = { id: slugify(opts.config.machineName), name: opts.config.machineName, status: "this" };
    this.askTimeoutMs = opts.timings?.askTimeoutMs ?? ASK_TIMEOUT_MS;
    this.cardExpiryMs = opts.timings?.cardExpiryMs ?? CARD_EXPIRY_MS;
    this.replyTimeoutMs = opts.timings?.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.replyRetryMs = opts.timings?.replyRetryMs ?? REPLY_RETRY_MS;
    this.clock = opts.clock ?? Date.now;
    this.links = makeLinks(this, opts.links);
    this.startedAtMs = this.clock();
    this.tz = opts.timeZone ?? localZone();
    this.wakeGraceMs = opts.timings?.wakeGraceMs ?? WAKE_GRACE_MS;
    this.helperStopMs = opts.timings?.helperStopMs ?? HELPER_STOP_MS;
    this.shortenTimings = { waitMs: opts.timings?.shortenWaitMs ?? SHORTEN_WAIT_MS, stuckMs: opts.timings?.shortenStuckMs ?? SHORTEN_STUCK_MS };
    this.helperNudgeMs = opts.timings?.helperNudgeMs ?? HELPER_NUDGE_MS;
    this.helperRowMs = opts.timings?.helperRowMs ?? HELPER_ROW_MS;
    this.liveCheckMs = opts.timings?.liveCheckMs ?? LIVE_CHECK_MS;
    this.artifactCheckMs = opts.timings?.artifactCheckMs ?? ARTIFACT_CHECK_MS;
    this.codexToolSoftMs = opts.timings?.codexToolSoftMs ?? CODEX_TOOL_SOFT_MS;
    this.chat = opts.config.chat ?? chatConfig(undefined);
    this.codex = opts.codex ?? { ready: false, env: {}, models: [] };
    const browserCfg = opts.config.browser ?? { enabled: true };
    const driver = opts.browser === null ? undefined : opts.browser ?? (browserCfg.enabled ? realDriver(browserCfg) : undefined);
    this.browser = new BrowserHub({
      driver,
      store: this.store,
      timings: opts.browserTimings,
      host: {
        botOrder: () => [...this.order],
        addItem: (botId, threadId, item) => {
          const rt = this.bots.get(botId);
          if (!rt || !this.store.isOpen) return undefined;
          return this.addItem(rt, item, threadId);
        },
        putItem: (item) => {
          if (this.store.isOpen) this.putItem(item);
        },
        changed: (state) => this.opts.emit("browser.changed", { state }),
      },
    });
    this.backup = new Backup({
      dataDir: opts.config.dataDir,
      botsDir: opts.config.botsDir,
      config: opts.config.backup ?? { folder: "", folderProblem: "No backup folder is set for this Pobots.", time: BACKUP_TIME },
      engineVersion: ENGINE_VERSION,
      clock: this.clock,
      tz: this.tz,
      ...opts.backup,
      host: {
        snapshotDb: (path) => this.store.snapshotTo(path),
        bots: () => this.order.map((id) => ({ id, name: this.bots.get(id)!.folder.file.name })),
        changed: (backup) => this.opts.emit("backup.changed", { backup }),
        showCard: (title, text) => showSystemCard(this, "backup", title, text),
        clearCard: () => clearSystemCard(this, "backup"),
      },
    });
    this.seesHub = new SeesHub({ read: opts.readSees ?? (opts.createSession ? noReader : readSeesWithClaude), claude: () => this.opts.claude, ...(opts.clock ? { clock: opts.clock } : {}) });
    const busyBots = () => [...this.bots.values()].filter((rt) => !calm(this, rt) || !!rt.turn).map((rt) => rt.folder.file.name);
    const self = opts.selfUpdate?.installDir
      ? new SelfUpdate(
          { dataDir: opts.config.dataDir, busyBots, changed: () => this.hub?.selfChanged(), tellAsker: (botId, line, version, ok, notes) => tellUpdateAsker(this, botId, line, version, ok, notes), updated: (from, to, notes) => showUpdatedCard(this, from, to, notes) },
          { current: ENGINE_VERSION, ...(opts.config.updates ? { config: opts.config.updates } : {}), ...(opts.config.shell ? { shell: true } : {}), ...opts.selfUpdate },
        )
      : undefined;
    this.hub = new SettingsHub(
      {
        dataDir: opts.config.dataDir,
        machineName: opts.config.machineName,
        emit: (event, data) => this.opts.emit(event, data),
        claude: () => this.opts.claude,
        ...(opts.checkClaude ? { redetectClaude: opts.checkClaude } : {}),
        setClaude: (next) => this.setClaude(next),
        codex: () => this.codex,
        waitForCodexCheck: () => this.codexChecking,
        recheckCodex: () => this.recheckCodex(),
        models: () => this.modelList(),
        botsOn: (p) => [...this.bots.values()].filter((rt) => rt.folder.file.harness === p).map((rt) => rt.folder.file.name),
        busyBots,
        restartHarnesses: () => {
          for (const rt of this.bots.values()) this.refreshSession(rt);
        },
        timingChanged: () => {
          for (const rt of this.bots.values()) this.opts.emit("bot.updated", { bot: this.toBot(rt) });
        },
        probeDir: opts.config.dataDir,
      },
      opts.config.settings,
      opts.config.context,
      { ...opts.settingsHub, ...(self ? { self } : {}) },
    );
    const titlesDir = join(opts.config.dataDir, "titles");
    this.codexTitles = new CodexTitles({ setup: () => this.codex, workDir: titlesDir, system: TITLE_SYSTEM });
    const claudeOk = () => this.opts.claude.ready && this.hub.enabled("claude");
    const codexOk = () => this.codex.ready && this.hub.enabled("codex");
    const isGpt = (model: string) => this.harnessOf(model) === "codex";
    this.titles = new Titles({
      store: this.store,
      // A GPT model's titles come from Codex, with the Claude default when Codex cannot (step gpt-titles).
      maker: routedTitleMaker({
        claude: opts.titleMaker ?? claudeTitleMaker(() => this.opts.claude, titlesDir),
        codex: (prompt, model, canStart) => this.codexTitles.make(prompt, model, canStart),
        isGpt,
        codexOk,
        claudeOk,
        fallbackModel: TITLE_MODEL_DEFAULT,
      }),
      model: () => this.hub.titleModel(),
      canMake: () => !this.stopping && (claudeOk() || (isGpt(this.hub.titleModel()) && codexOk())),
      canTitle: (botId) => !away(this.bots.get(botId)),
      titled: (botId, chat) => this.opts.emit("chat.titled", { botId, chat }),
      ...(opts.titleTimings ? { timings: opts.titleTimings } : {}),
    });
    const notifyCfg = opts.config.notify ?? { kinds: { ...NOTIFY_DEFAULTS }, titlePrefix: "" };
    if (opts.notify?.relay) log.warn("Notifications go to a test relay");
    this.notifier = new Notifier({
      push:
        opts.notify?.push ??
        new PushStore(join(opts.config.dataDir, "push"), { ...(notifyCfg.subject ? { subject: notifyCfg.subject } : {}), ...(opts.notify?.relay ? { relay: opts.notify.relay } : {}) }),
      kinds: notifyCfg.kinds,
      titlePrefix: notifyCfg.titlePrefix,
      ...(opts.notify?.timers ? { timers: opts.notify.timers } : {}),
      ...(opts.notify?.graceMs ? { graceMs: opts.notify.graceMs } : {}),
      ...(opts.notify?.foldMs !== undefined ? { foldMs: opts.notify.foldMs } : {}),
      ...(opts.notify?.retryMs !== undefined ? { retryMs: opts.notify.retryMs } : {}),
      host: {
        botName: (botId) => {
          const rt = this.bots.get(botId);
          return away(rt) ? undefined : rt?.folder.file.name;
        },
        openCards: () => [...this.cards.values()].map((p) => p.card),
        atRest: (botId) => {
          const rt = this.bots.get(botId);
          return !!rt && !rt.busy && inBackground(rt) === 0 && rt.state !== "working" && rt.state !== "waiting";
        },
        changed: (notify) => this.opts.emit("notify.changed", { notify }),
        saveKinds: (kinds) => writeConfigPart(opts.config.dataDir, "notify", kinds),
      },
    });
  }

  // ------------------------------------------------------------ start-up

  /**
   * Reads the bot folders, makes sure each has a main thread and a history, tidies up after the
   * last stop, and then sends the messages that were still queued, in order.
   */
  init(): void {
    init(this);
    this.links.start();
  }

  saveSettings(folder: BotFolder): void {
    try {
      writeBotFile(folder.dir, folder.file);
    } catch (err) {
      log.warn(`Could not save the settings of bot ${folder.id}`, err);
    }
  }

  // ------------------------------------------------------------ reading

  status(): EngineStatus {
    const c = this.opts.claude;
    const x = this.codex;
    return {
      engineVersion: ENGINE_VERSION,
      claude: { ready: c.ready, ...(c.version ? { version: c.version } : {}), ...(c.problem ? { problem: c.problem } : {}) },
      codex: { ready: x.ready, ...(x.version ? { version: x.version } : {}), ...(x.problem ? { problem: x.problem } : {}) },
    };
  }

  /**
   * Looks at Codex again (see EngineOptions.checkCodex). One check at a time; "status.updated" goes
   * out, with the new model list, when the answer changed.
   */
  /** The last model list Codex gave that held anything (see codexKnown). */
  private codexSeen: ModelInfo[] = [];

  recheckCodex(): Promise<void> {
    const check = this.opts.checkCodex;
    if (!check) return Promise.resolve();
    if (this.codexChecking) return this.codexChecking;
    this.codexChecking = (async () => {
      try {
        const next = await check();
        if (this.stopping) return;
        const before = JSON.stringify(this.status().codex) + JSON.stringify(this.codex.models);
        this.codex = next;
        if (next.ready) log.info(`Found Codex ${next.version ?? ""} at ${next.executable}, ${next.models.length} GPT models`);
        else log.info(`Codex is not ready: ${next.problem ?? "no reason given"}`);
        if (JSON.stringify(this.status().codex) + JSON.stringify(next.models) !== before) {
          this.opts.emit("status.updated", { status: this.status(), models: this.modelList() });
          // The model tools name the models that exist right now; a sleeping bot gets the new list at its next start.
          for (const rt of this.bots.values()) this.opts.emit("bot.updated", { bot: this.toBot(rt) });
        }
      } catch (err) {
        log.warn("Could not check Codex", err);
      } finally {
        this.codexChecking = undefined;
      }
    })();
    return this.codexChecking;
  }

  /** The harness of a model id: the list it is in, else what the id looks like. */
  harnessOf(model: string): Harness {
    return harnessOfModel(model, { claude: this.models, codex: this.codex.models });
  }

  /** Every GPT model Codex listed, before the list was cut (step 3b). */
  private codexKnown(): ModelInfo[] {
    const now = this.codex.allModels?.length ? this.codex.allModels : this.codex.models;
    // Kept across a moment where Codex is not ready, so a live session is not told "not fast" by mistake.
    if (now.length) this.codexSeen = now;
    return now.length ? now : this.codexSeen;
  }

  /** Does this model have a fast mode right now (step 3b, A1). The one answer everything about fast mode uses. */
  hasFast(model: string): boolean {
    return modelHasFast(model, this.codexKnown());
  }

  /** Whether a bot runs fast: its choice, and its model has a fast mode. What its session is told. */
  runsFast(f: { model: string; fast: boolean }): boolean {
    return f.fast !== false && this.hasFast(f.model);
  }

  /** A model's name for people: from the list, else made from the id. */
  modelLabel(id: string): string {
    return this.modelList().find((m) => m.id === id)?.label ?? (looksLikeCodex(id) ? codexLabel(id) : labelFor(id));
  }

  /** Whether a bot's harness can take a turn now. A GPT bot's turn finds out at its start (it checks Codex again). */
  harnessReady(rt: BotRuntime): boolean {
    return rt.folder.file.harness === "codex" ? true : this.opts.claude.ready;
  }

  snapshot(): Snapshot {
    return {
      status: this.status(),
      bots: this.order.map((id) => this.toBot(this.bots.get(id)!)),
      cards: [...this.cards.values()].map((p) => p.card).sort((a, b) => a.at.localeCompare(b.at)),
      models: this.modelList(),
      machines: [this.machine],
      upcoming: this.upcomingList,
      channels: this.store.listChannels().map((row) => toChannel(this, row)),
      browser: this.browser.snapshot(),
      backup: this.backup.state(),
      connections: this.links.list(),
      notify: this.notifier.state(),
      chat: { ...this.chat },
      settings: this.hub.view(),
      providers: this.hub.providers(),
      todos: this.store.openTodos().filter((todo) => !away(this.bots.get(todo.botId))),
      aboutYou: aboutYou(this),
      calendar: calendarState(this),
      ahead: aheadSettings(this),
    };
  }

  // ------------------------------------------------------------ step 7b: settings, providers, usage, chat titles

  /** The fresh-start rules for a bot, by its provider. */
  ctxOf(rt: BotRuntime): ContextSettings {
    return this.hub.context(rt.folder.file.harness);
  }

  /** Claude as looked at again (its version after an update). The status goes out when it changed. */
  private setClaude(next: ClaudeSetup): void {
    const before = JSON.stringify(this.status().claude);
    this.opts = { ...this.opts, claude: next };
    if (JSON.stringify(this.status().claude) !== before) this.opts.emit("status.updated", { status: this.status() });
  }

  /**
   * "settings.set", from the window or from the main bot's tool. A bot's change needs no card
   * (14 Nov 2026: "it should just let me know it happens"): a quiet line in that bot's chat
   * says what changed, from what to what (core/notes.ts).
   */
  settingsSet(patch: SettingsPatch, byBot?: BotRuntime): Methods["settings.set"]["result"] & { changes: string[] } {
    const r = this.hub.set(patch);
    if (r.changes.length) {
      // The model list leaves out a provider that is off (except models bots use).
      this.opts.emit("status.updated", { status: this.status(), models: this.modelList() });
      if (byBot) noteChanges(this, byBot, r.changes);
    }
    return r;
  }

  /** "aboutYou.set" from the window (engine 0.33.0, core/first-start.ts). */
  aboutYouSet(text: string): Methods["aboutYou.set"]["result"] {
    setAboutYou(this, text);
    return { aboutYou: aboutYou(this) };
  }

  providersCheck(): Promise<Methods["providers.check"]["result"]> {
    return this.hub.check(true).then(() => ({ providers: this.hub.providers() }));
  }

  /** The running version, for words that name it (core/ cannot import it from here). */
  get engineVersion(): string {
    return ENGINE_VERSION;
  }

  /** The update button: Claude Code and Codex, and Pobots itself on a public install (engine 0.34.0). */
  async providersUpdate(what?: { providers?: boolean; pobots?: boolean; askedBy?: string }): Promise<Methods["providers.update"]["result"]> {
    return { providers: await this.hub.startUpdate(what) };
  }

  /** A provider switched off in Settings takes no new bot (step 7b). */
  checkProviderOn(h: Harness): void {
    if (!this.hub.enabled(h)) throw new EngineError("bad_request", `${h === "codex" ? "Codex" : "Claude Code"} is switched off in Settings, Providers.`);
  }

  /** For tests: resolves when the running provider update has ended. */
  providersUpdated(): Promise<void> {
    return this.hub.updateSettled();
  }

  async usageRead(params: Methods["usage.read"]["params"]): Promise<Methods["usage.read"]["result"]> {
    return { usage: await this.hub.readUsage(params.refresh === true) };
  }

  /** Engine 0.30.0: a day's activity for the window, read only (core/activity-day.ts). */
  activityDay(params: Methods["activity.day"]["params"]): Methods["activity.day"]["result"] {
    return { activity: activityDayFor(this, params?.day) };
  }

  usageHubAdd(params: Methods["usage.hub.add"]["params"]): Methods["usage.hub.add"]["result"] {
    return { settings: this.hub.addHub(params.url, params.key) };
  }

  usageHubRemove(params: Methods["usage.hub.remove"]["params"]): Methods["usage.hub.remove"]["result"] {
    return { settings: this.hub.removeHub(params.id) };
  }

  chatTitles(params: Methods["chat.titles"]["params"]): Methods["chat.titles"]["result"] {
    this.bot(params.botId);
    const page = this.store.chatTitles(params.botId, { ...(params.before ? { before: params.before } : {}), limit: params.limit ?? 30 });
    return { chats: page.chats.map(toChatTitle), hasMore: page.hasMore };
  }

  /** For tests: resolves once no chat waits for its title. */
  titlesSettled(): Promise<void> {
    return this.titles.settled();
  }

  /** "sees.inventory": what exists for a bot's folder and what each thing costs (docs/sees.md). */
  seesInventory(params: Methods["sees.inventory"]["params"]): Promise<Methods["sees.inventory"]["result"]> {
    const rt = this.bot(params.botId);
    return this.seesHub.inventory(rt.folder.id, rt.folder.dir, params.refresh === true);
  }

  /** "chat.set": the chat settings, saved in config.json. */
  chatSet(params: Methods["chat.set"]["params"]): Methods["chat.set"]["result"] {
    if (params.followUp !== this.chat.followUp) {
      writeConfigPart(this.opts.config.dataDir, "chat", { followUp: params.followUp });
      this.chat = { ...this.chat, followUp: params.followUp };
      log.info(`A message sent while a bot works now ${params.followUp === "steer" ? "steers" : "waits in line"} by default`);
      this.opts.emit("chat.changed", { chat: { ...this.chat } });
    }
    return { chat: { ...this.chat } };
  }

  /**
   * The model list: Claude first, then GPT (only while Codex is ready), plus any model a bot uses that
   * the list lacks, so the picker can show it.
   */
  modelList(): ModelInfo[] {
    // A provider switched off in Settings offers no models (step 7b); models bots still use stay below.
    const claude = this.hub.enabled("claude") ? [...this.models] : [];
    const gpt = this.codex.ready && this.hub.enabled("codex") ? [...this.codex.models] : [];
    for (const rt of this.bots.values()) {
      const id = rt.folder.file.model;
      if (claude.some((m) => m.id === id) || gpt.some((m) => m.id === id)) continue;
      // An older GPT model Codex still lists keeps its efforts and fast mode; one it does not list has none.
      if (rt.folder.file.harness === "codex") gpt.push((this.codex.ready ? this.codexKnown().find((m) => m.id === id) : undefined) ?? codexModelFor(id));
      else claude.push(modelFor(id));
    }
    return [...claude, ...gpt];
  }

  toBot(rt: BotRuntime): Bot {
    const f = rt.folder.file;
    // Engine 0.31.1: a bot at rest with a restored card reads Waiting for you (core/restored-waiting.ts).
    const view = shown(this, rt);
    noteSent(rt, view);
    const turnId = liveTurnId(rt);
    noteTurnSent(rt, turnId);
    return {
      id: rt.folder.id,
      name: f.name,
      role: f.role,
      purpose: f.purpose,
      look: f.look,
      harness: f.harness,
      model: f.model,
      effort: f.effort,
      fast: f.fast,
      access: f.access,
      machine: f.machine,
      state: view.state,
      ...(away(rt) ? { vacationSince: f.vacationSince } : f.role !== "main" && vacationNeedsStop(this, rt) ? { vacationNeedsStop: true } : {}),
      activity: view.activity,
      ...(view.atRest ? { atRest: true } : {}),
      // Engine 0.31.2: the turn running now in the main chat, so the window gives it its own block (core/live-turn.ts).
      ...(turnId ? { turnId } : {}),
      mainThreadId: rt.threadId,
      mayMessage: f.mayMessage.filter((id) => this.bots.has(id)),
      maySteer: f.role === "main" || f.maySteer === true,
      calendar: f.calendar ?? f.role === "main",
      ahead: aheadLevel(rt),
      context: this.contextOf(rt),
      helpers: helperCount(rt),
      ...(rt.helpers.size ? { workingHelpers: workingHelpers(this, rt) } : {}),
      ...(rt.managers.size ? { taskManagers: taskManagerInfos(this, rt) } : {}),
      ...(f.followUp ? { followUp: f.followUp } : {}),
      ...(f.sees ? { sees: f.sees } : {}),
      ...(keptPlan(this, rt)?.plan.steps.length ? { plan: keptPlan(this, rt)!.plan } : {}),
    };
  }

  /** How full the session behind the bot's main chat is. */
  private contextOf(rt: BotRuntime): BotContext {
    const c = this.store.getContext(rt.threadId);
    return { tokens: c.tokens, window: Math.round(fullAt(this.ctxOf(rt), c.window ?? DEFAULT_WINDOW)), ...(c.since ? { since: c.since } : {}), tidying: !!rt.turn?.tidy };
  }

  bot(botId: string): BotRuntime {
    const rt = this.bots.get(botId);
    if (!rt) throw new EngineError("not_found", "There is no bot with that id.");
    return rt;
  }

  nameOf(botId: string): string {
    return this.bots.get(botId)?.folder.file.name ?? botId;
  }

  readThread(params: Methods["thread.read"]["params"]): Methods["thread.read"]["result"] {
    if (!this.store.getThread(params.threadId)) throw new EngineError("not_found", "There is no thread with that id.");
    this.flush();
    const page = this.store.readThread(params.threadId, params.before, params.limit ?? 50);
    return { ...page, items: page.items.map((i) => this.withMissing(i)) };
  }

  /** A message whose attached files are gone from the Mac says so (`missing`), also before its turn looked; one that is back no longer does. */
  withMissing(item: Item): Item {
    if (item.kind !== "user" || !item.attachments?.length) return item;
    const dir = this.bots.get(this.store.getThread(item.threadId)?.botId ?? "")?.folder.dir;
    if (!dir) return item;
    let changed = false;
    const attachments = item.attachments.map((a) => {
      if (!a.path) return a;
      // Looked at again each time: a file brought back by a restore is there again.
      const present = attachmentPresent(dir, a);
      // Step 7c: gone because attachments are kept 14 days: "No longer kept".
      const expired = !present && pastKeeping(item.at, this.clock());
      if (present === !a.missing && expired === !!a.expired) return a;
      changed = true;
      if (present) {
        const { missing: _gone, expired: _old, ...rest } = a;
        return rest;
      }
      return { ...a, missing: true, ...(expired ? { expired: true } : {}) };
    });
    return changed ? { ...item, attachments } : item;
  }

  // ------------------------------------------------------------ bots

  createBot(params: Methods["bot.create"]["params"] | string): Bot {
    return createBot(this, params);
  }

  updateBot(params: Methods["bot.update"]["params"]): Promise<Bot> {
    return updateBot(this, params);
  }

  setVacation(params: Methods["bot.vacation"]["params"]): Methods["bot.vacation"]["result"] {
    return setVacation(this, params);
  }

  /** Stops a bot, withdraws its cards, archives its folder and takes it off the roster. Its chat stays in the database. */
  retireBot(botId: string): void {
    retireBot(this, botId);
  }

  setState(rt: BotRuntime, state: BotState, activity: string): void {
    // A tidy turn stays calm whatever the harness does: one line, until it ends.
    if (away(rt)) {
      state = "idle";
      activity = "On vacation";
    } else if (rt.busy && rt.turn?.tidy) {
      state = "working";
      activity = TIDY_ACTIVITY;
    }
    // At rest while a Stop holds messages, the line says so (step 3b, third part). A turn's end sets
    // its rest while the turn still counts as running, so this does not look at busy.
    if (!away(rt) && (state === "done" || state === "idle")) activity = heldWords(this, rt) ?? activity;
    if (rt.state === state && rt.activity === activity) return;
    rt.state = state;
    rt.activity = activity;
    this.opts.emit("bot.updated", { bot: this.toBot(rt) });
  }

  // ------------------------------------------------------------ files and history

  listFiles(botId: string): ProtocolBotFile[] {
    return listFiles(this, botId);
  }

  readFile(params: Methods["bot.file.read"]["params"]): Methods["bot.file.read"]["result"] {
    return readFile(this, params);
  }

  writeFile(params: Methods["bot.file.write"]["params"], by: ChangeBy = "you", summary?: string): Methods["bot.file.write"]["result"] {
    return writeFile(this, params, by, summary);
  }

  deleteFile(params: Methods["bot.file.delete"]["params"], by: ChangeBy = "you", summary?: string): void {
    deleteFile(this, params, by, summary);
  }

  history(params: Methods["bot.history"]["params"]): Methods["bot.history"]["result"] {
    return history(this, params);
  }

  readChange(params: Methods["bot.history.read"]["params"]): Methods["bot.history.read"]["result"] {
    return readChange(this, params);
  }

  undoChange(params: Methods["bot.history.undo"]["params"]): Methods["bot.history.undo"]["result"] {
    return undoChange(this, params);
  }

  /** Starts the harness again between turns (keeping the conversation), so it reads what changed. */
  refreshSession(rt: BotRuntime): void {
    refreshSessions(this, rt);
  }

  // ------------------------------------------------------------ artifacts (docs/build/step-2f.md)

  /** A bot's artifacts, newest change first. */
  listArtifacts(botId: string): Artifact[] {
    return listArtifacts(this, botId);
  }

  /**
   * Where a "page" can be shown now: a path under /page/<key>/ (the server makes it a full URL for
   * the desktop window). The key is the same while it has more than an hour left.
   */
  openArtifact(params: Methods["artifact.open"]["params"]): { path: string; rev: number } {
    return openArtifact(this, params);
  }

  /** Takes an artifact off its bot's list. Its file and anything on Claude stay; old lines in the chat stay as they are. */
  removeArtifact(params: Methods["artifact.remove"]["params"]): void {
    removeArtifact(this, params);
  }

  /**
   * The file an address under /page/<key>/ names, or nothing. An unknown or expired key, an artifact
   * taken off the list or of a retired bot, a link, and a file that is gone all give nothing.
   */
  pageRequest(key: string, rest: string, mode?: Parameters<typeof pageRequest>[3]): PageFile {
    return pageRequest(this, key, rest, mode);
  }

  /**
   * Looks whether the files of a bot's page artifacts (or of every bot's) changed: a change raises
   * `rev`, a file that is gone makes the artifact unavailable, and one that comes back makes it
   * available again. Each change is sent as "artifact.changed"; nothing is added to the chat.
   */
  checkArtifacts(botId?: string): void {
    checkArtifacts(this, botId);
  }

  // ------------------------------------------------------------ saved rules

  listRules(botId: string): SavedRule[] {
    return listRules(this, botId);
  }

  removeRule(ruleId: string): void {
    removeRule(this, ruleId);
  }

  // ------------------------------------------------------------ items

  /** The thread things happen in now: the current turn's, or else the main thread. */
  liveThread(rt: BotRuntime): string {
    return rt.busy && rt.turn ? rt.turn.threadId : rt.threadId;
  }

  addItem(rt: BotRuntime, item: Parameters<Store["addItem"]>[1], threadId = this.liveThread(rt)): Item {
    // Everything made in a turn carries its id. A message that waits in the queue gets one when its turn starts.
    const inTurn = rt.turn && rt.busy && item.kind !== "user" && rt.turn.threadId === threadId;
    const withTurn = inTurn ? { ...item, turnId: rt.turn!.id } : item;
    const full = this.store.addItem(threadId, withTurn);
    this.opts.emit("item.upsert", { item: full });
    return full;
  }

  putItem(item: Item): void {
    // A waiting message that is dealt with now (its turn starts, it is steered in, or a Stop or a
    // missing harness ends its wait) moves to the end of its thread: it stands in the chat where it
    // was read, not where it was sent (step 7a).
    if (item.kind === "user" && !item.queued) {
      const was = this.store.getItem(item.id);
      if (was?.kind === "user" && was.queued) {
        const moved = this.store.moveItemToEnd(item);
        this.live.delete(item.id);
        this.dirty.delete(item.id);
        this.opts.emit("item.upsert", { item: moved });
        return;
      }
    }
    this.store.updateItem(item);
    this.live.delete(item.id);
    this.dirty.delete(item.id);
    this.opts.emit("item.upsert", { item });
  }

  notice(rt: BotRuntime, text: string, tone: "info" | "error"): void {
    if (tone === "error" && rt.busy && rt.turn) rt.turn.errorText ??= text;
    // A tidy turn adds nothing to the chat but its own steps and, when it ends well, the fresh line.
    if (rt.busy && rt.turn?.tidy) {
      log.warn(`Bot ${rt.folder.id}: in a tidy turn: ${text}`);
      return;
    }
    this.addItem(rt, { kind: "notice", at: now(), text, tone });
  }

  scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 500);
    this.flushTimer.unref();
  }

  /** Writes streaming text that only lives in memory to the store. */
  private flush(): void {
    for (const id of this.dirty) {
      const item = this.live.get(id);
      if (item) this.store.updateItem(item);
    }
    this.dirty.clear();
  }

  // ------------------------------------------------------------ messages and turns

  sendMessage(params: Methods["message.send"]["params"]): UserItem {
    const rt = this.bot(params.botId);
    requirePresent(rt);
    if (params.threadId !== undefined && params.threadId !== rt.threadId) {
      throw new EngineError("not_found", "That thread does not belong to this bot.");
    }
    const text = params.text.trim();
    const ids = [...new Set(params.attachments ?? [])];
    if (ids.length > ATTACHMENTS_PER_MESSAGE) throw new EngineError("too_many", ATTACH_WORDS.tooMany);
    if (!text && !ids.length) throw new EngineError("bad_request", "The message is empty.");
    for (const id of ids) {
      const up = readUpload(this.opts.config.dataDir, id);
      if (!up || up.botId !== rt.folder.id) throw new EngineError("not_found", ATTACH_WORDS.notFound);
    }
    this.checkReady(rt);
    // The files move into the bot's folder before the message is stored. Should one fail, the ones
    // already moved go back among the uploads, and nothing is sent.
    const attachments: Attachment[] = [];
    const when = new Date(this.clock());
    try {
      for (const id of ids) attachments.push(moveToBot(this.opts.config.dataDir, id, rt.folder.id, rt.folder.dir, when));
    } catch (err) {
      for (const a of attachments) moveBack(this.opts.config.dataDir, rt.folder.dir, a);
      if (err instanceof EngineError) throw err;
      log.error(`Bot ${rt.folder.id}: could not move the attachments into its folder`, err);
      throw new EngineError("internal", "The attachments could not be saved in the bot's folder. Try again.");
    }
    // The person writes: a Stop no longer holds. What waited goes first, in its order, then this. The
    // message is stored first and the hold taken off after, so a failure in between keeps the hold
    // (and a restart in between finds the message and ends it then: see loadHold).
    const holding = !!rt.hold;
    // Should storing the message fail after the files moved, they go back among the uploads, so the
    // person can send again. Once the message is stored, they stay with it whatever follows.
    const stored = { done: false };
    let item: UserItem;
    try {
      for (const a of attachments) this.store.setValue(attachmentKey(a.id), JSON.stringify({ botId: rt.folder.id, path: a.path }));
      const steer = (params.mode ?? rt.folder.file.followUp ?? this.chat.followUp) === "steer";
      item = this.enqueue(rt, text, { type: "you" }, { behind: holding, stored, steer, ...(attachments.length ? { attachments } : {}) });
    } catch (err) {
      if (!stored.done && attachments.length) {
        for (const a of attachments) {
          try {
            this.store.deleteValue(attachmentKey(a.id));
          } catch {
            // the value only finds the file; a stale one leads nowhere
          }
          moveBack(this.opts.config.dataDir, rt.folder.dir, a);
        }
      }
      throw err;
    }
    if (holding) {
      endHold(this, rt);
      startNextInLine(this, rt);
    }
    return item;
  }

  /** A Claude bot's message is refused while Claude is not ready. A GPT bot's is taken up and ends blocked with Codex's sentence when Codex is not there. */
  checkReady(rt?: BotRuntime): void {
    if (rt) requirePresent(rt);
    if ((!rt || rt.folder.file.harness === "claude") && !this.opts.claude.ready) {
      throw new EngineError("harness_unavailable", this.opts.claude.problem ?? "Claude is not ready on this computer.");
    }
    if (this.stopping) throw new EngineError("internal", "The engine is stopping.");
  }

  /**
   * Puts a message in a bot's thread (its main thread unless another is named). It starts a turn at
   * once, or waits in line while the bot is busy in any of its threads.
   */
  enqueue(
    rt: BotRuntime,
    text: string,
    from: UserItem["from"],
    o: { hops?: number; ask?: PendingAsk; lateAnswer?: boolean; threadId?: string; itemId?: string; held?: boolean; behind?: boolean; attachments?: Attachment[]; stored?: { done: boolean }; steer?: boolean; steered?: { done?: Promise<boolean> } } = {},
  ): UserItem {
    requirePresent(rt);
    const { hops = 0, ask, lateAnswer = false } = o;
    // Messages held by a Stop do not keep what is new from starting (step 3b, third part). One that
    // was lined up before the Stop (`held`) waits with them.
    const held = !!o.held && !!rt.hold;
    // `behind`: it goes behind the held messages too (the person's message that ends a hold).
    const waiting = held || rt.busy || (o.behind ? rt.queue.length : liveQueue(this, rt)) > 0;
    // Steering (protocol 14): the person's message goes into the running turn, past anything in line.
    const steer = waiting && !held && !!o.steer && canSteer(this, rt, o.threadId ?? rt.threadId);
    const fields = {
      kind: "user" as const,
      at: now(),
      text,
      from,
      queued: waiting && !steer,
      ...(steer ? { steered: true, turnId: rt.turn!.id } : {}),
      ...(o.attachments?.length ? { attachments: o.attachments } : {}),
      ...(o.itemId ? { id: o.itemId } : {}),
    };
    const item = this.addItem(rt, fields, o.threadId ?? rt.threadId) as UserItem;
    if (o.stored) o.stored.done = true;
    if (hops > 0) this.store.setHops(item.id, hops);
    if (ask) this.askByItem.set(item.id, ask);
    if (lateAnswer) this.lateAnswers.add(item.id);
    if (steer) (o.steered ?? {}).done = steerInto(this, rt, item);
    else if (waiting) rt.queue.push(item.id);
    else void startTurn(this, rt, item);
    if (held) {
      rt.hold!.held.add(item.id);
      saveHold(this, rt);
      log.info(`Bot ${rt.folder.id}: a message lined up before the Stop waits with the others`);
      if (!rt.busy && (rt.state === "done" || rt.state === "idle")) this.setState(rt, rt.state, rt.activity);
    }
    return item;
  }

  // ------------------------------------------------------------ steering (protocol 14)

  /** "message.steer": a queued message from the person goes into the running turn now. */
  steerQueued(params: Methods["message.steer"]["params"]): Methods["message.steer"]["result"] {
    return steerQueued(this, params);
  }

  /** "message.unqueue": the person takes a waiting message back before the bot read it (step 7a). */
  unqueue(params: Methods["message.unqueue"]["params"]): Methods["message.unqueue"]["result"] {
    return unqueue(this, params);
  }

  /** "thread.queued": the messages of a thread that wait, oldest first (step 7a). */
  queuedOf(threadId: string): Methods["thread.queued"]["result"] {
    return queuedOf(this, threadId);
  }

  // ------------------------------------------------------------ fresh sessions

  /** bot.startFresh: a tidy turn now, whatever the size, when there is a session to tidy. */
  startFresh(botId: string): { started: boolean } {
    return startFresh(this, botId);
  }

  /**
   * The clock's look at each bot's session (rules 1 and 3; rule 2 is checked after each turn).
   * Rule 1: a long-lived cache is about to go cold and the session is big enough. Rule 3: the
   * session is big enough and has not been sent to the model for a long time.
   */
  checkContext(): void {
    checkContext(this);
  }

  /** Closes the live session; sessions set aside go on (core/aside.ts). */
  closeSession(rt: BotRuntime): void {
    closeLive(this, rt);
  }

  /**
   * Stops the bot's turn, if one runs, and every helper of the bot that still works. The harness's own
   * interrupt ends helpers in the background too (seen in step 2e); any that still run a moment later
   * are stopped one by one, and any that never confirm are marked stopped.
   */
  interrupt(botId: string): Promise<void> {
    return interrupt(this, botId);
  }

  // ------------------------------------------------------------ helpers

  /** helper.stop: stops one helper through the harness. Its row says "stopped" once the harness confirms. */
  stopHelper(params: Methods["helper.stop"]["params"]): Promise<void> {
    return stopHelper(this, params);
  }

  // ------------------------------------------------------------ the team: messages between bots

  /** May `from` message `to`? The main bot may message everyone, and everyone may message the main bot. */
  mayMessage(from: string, to: string): boolean {
    return mayMessage(this, from, to);
  }

  /** Finds a bot by id, or else by name (any case). */
  findBot(ref: string): BotRuntime | undefined {
    const r = ref.trim();
    const byId = this.bots.get(r) ?? this.bots.get(r.toLowerCase());
    if (byId) return byId;
    const lower = r.toLowerCase();
    return [...this.bots.values()].find((b) => b.folder.file.name.toLowerCase() === lower);
  }

  /** Plain words for a tool call, including the bot tools. */
  toolWords(name: string, input: Record<string, unknown>): ToolWords {
    return toolWords(this, name, input);
  }

  // ------------------------------------------------------------ cards

  resolveCard(cardId: string, decision: CardDecision): void {
    resolveCard(this, cardId, decision);
  }

  // ------------------------------------------------------------ the nightly backup

  /** Saves the 1Password reference; never receives a password. */
  setBackupPasswordRef(passwordRef: string): Methods["backup.setPasswordRef"]["result"] {
    return { backup: this.backup.setPasswordRef(passwordRef) };
  }

  /** "backup.run": starts a backup now. */
  runBackup(): Methods["backup.run"]["result"] {
    if (this.stopping) throw new EngineError("conflict", "Pobots is stopping, so no backup was started.");
    return { backup: this.backup.runNow() };
  }

  /**
   * Resolves when no backup is running: one being made is ended by the stop, its child processes
   * ended and its half-made files removed (by force after a bounded wait). True when that clean-up is
   * proven done. Awaited before the database closes.
   */
  backupStopped(): Promise<boolean> {
    return this.backup.stop();
  }

  /** For tests: resolves when the backup has nothing going. */
  backupIdle(): Promise<void> {
    return this.backup.idle();
  }

  // ------------------------------------------------------------ notifications (engine/notify.ts)

  /** "notify.setKinds": the switches, for all devices, saved in config.json. */
  notifySetKinds(kinds: Methods["notify.setKinds"]["params"]["kinds"]): Methods["notify.setKinds"]["result"] {
    return this.notifier.setKinds(kinds);
  }

  /** "notify.subscribe". */
  notifySubscribe(p: Methods["notify.subscribe"]["params"]): Methods["notify.subscribe"]["result"] {
    return this.notifier.subscribe(p);
  }

  /** "notify.forget". */
  notifyForget(deviceId: string): Methods["notify.forget"]["result"] {
    return this.notifier.forget(deviceId);
  }

  /** "notify.test": answers when the push service has. */
  notifyTest(deviceId: string): Promise<Methods["notify.test"]["result"]> {
    return this.notifier.test(deviceId);
  }

  /** "notify.presence", per connection (`conn` is the server's own id for it). */
  notifyPresence(conn: string, p: Presence): void {
    this.notifier.presence(conn, p);
  }

  /** A connection closed: its window no longer says anything about who is looking. */
  notifyConnectionClosed(conn: string): void {
    this.notifier.dropPresence(conn);
  }

  /** POST /api/push/renew: the service worker's new subscription, for a device the engine knows. Returns its id. */
  notifyRenew(old: string | undefined, subscription: Subscription): string {
    return this.notifier.renew(old, subscription);
  }

  /** For tests: resolves when no notification is being sent. */
  notifyIdle(): Promise<void> {
    return this.notifier.idle();
  }

  // ------------------------------------------------------------ triggers

  listTriggers(botId: string): Trigger[] {
    return listTriggers(this, botId);
  }

  /** Creates or changes a trigger. `createdBy` is "bot" when a bot made it with its own tool. */
  saveTrigger(params: Methods["trigger.save"]["params"], createdBy: Trigger["createdBy"] = "you", madeByBotId?: string): Trigger {
    return saveTrigger(this, params, createdBy, madeByBotId);
  }

  removeTrigger(triggerId: string): void {
    removeTrigger(this, triggerId);
  }

  /** Fires a trigger now, whatever its schedule, also when it is switched off. */
  runTrigger(triggerId: string): TriggerRun {
    return runTrigger(this, triggerId);
  }

  triggerRuns(params: Methods["trigger.runs"]["params"]): Methods["trigger.runs"]["result"] {
    return triggerRuns(this, params);
  }

  /** A webhook's address. Works like a password: only on request, never in an event, never logged. */
  triggerAddress(triggerId: string): Methods["trigger.address"]["result"] {
    return triggerAddress(this, triggerId);
  }

  /** A new secret for a webhook. The old address stops working at once. */
  newAddress(triggerId: string): Methods["trigger.newAddress"]["result"] {
    return newAddress(this, triggerId);
  }

  /** Switches a trigger on or off and nothing else. A schedule gets its next time again when switched on. */
  enableTrigger(triggerId: string, enabled: boolean): Trigger {
    return enableTrigger(this, triggerId, enabled);
  }

  // ------------------------------------------------------------ triggers: webhook calls

  /**
   * Where a hook address leads: a webhook or a channel that is on, or nowhere. The secret is compared
   * in constant time (against a stand-in when the id is unknown); nothing about why not is told.
   */
  hookTarget(id: string, secret: string): HookTarget | undefined {
    return hookTarget(this, id, secret);
  }

  /** Kept for the step 2b callers: is this the address of a webhook that is on? */
  hookAllowed(triggerId: string, secret: string): boolean {
    return hookAllowed(this, triggerId, secret);
  }

  /**
   * Counts a wrong call to /hook/. At most 60 a minute for all hooks together; after that, wrong calls
   * get 429 for the rest of that minute. Returns the seconds to wait, or 0 when within the limit.
   */
  wrongHookCall(): number {
    return wrongHookCall(this);
  }

  /** Counts a call against the limits: per webhook or channel (30 a minute), and 120 a minute for all hooks together. */
  hookWithinLimits(id: string, kind: HookTarget = "trigger"): boolean {
    return hookWithinLimits(this, id, kind);
  }

  /** A webhook call that passed the checks. Never waits for the bot. */
  hookCall(triggerId: string, data: { has: boolean; value?: unknown }, dedupe?: string): HookOutcome {
    return hookCall(this, triggerId, data, dedupe);
  }

  // ------------------------------------------------------------ triggers: the schedule clock

  /**
   * Fires what is due. A schedule that was due while Pobots was not running (or the computer slept)
   * runs once, late, when that was at most an hour ago, and is otherwise recorded as skipped. Never a
   * backlog. Called on a short timer that is planned again from the clock each time.
   */
  checkSchedules(): void {
    checkSchedules(this);
  }

  upcoming(): Upcoming[] {
    return upcoming(this);
  }

  // ------------------------------------------------------------ triggers: the bots' own tools

  /** The engine's own address on this computer, once it listens. For the local address of a webhook. */
  setLocalBase(base: string): void {
    this.localBase = base;
  }

  // ------------------------------------------------------------ channels

  getChannel(channelId: string): Channel {
    return getChannel(this, channelId);
  }

  /** Creates a channel (no id) or changes the fields given. `replyUrl` is write-only: a new one replaces it, "" removes it. */
  saveChannel(params: Methods["channel.save"]["params"]): Channel {
    return saveChannel(this, params);
  }

  /** Removes a channel. Its address stops working at once; what came in on it stays in the database. */
  removeChannel(channelId: string): void {
    removeChannel(this, channelId);
  }

  /** A channel's address. Works like a password: only on request, never in an event, never logged. */
  channelAddress(channelId: string): Methods["channel.address"]["result"] {
    return channelAddress(this, channelId);
  }

  /** A new secret for a channel. The old address stops working at once. */
  channelNewAddress(channelId: string): Methods["channel.newAddress"]["result"] {
    return channelNewAddress(this, channelId);
  }

  channelMessages(params: Methods["channel.messages"]["params"]): Methods["channel.messages"]["result"] {
    return channelMessages(this, params);
  }

  /**
   * A message posted to a channel's address, after the address and the limits were checked. A writer
   * not on the list is refused, a message seen before is a duplicate, one without a matching tag is
   * ignored. Otherwise it goes to the bot's main chat like any message. Never waits for the bot.
   */
  channelCall(channelId: string, value: unknown): ChannelOutcome {
    return channelCall(this, channelId, value);
  }

  /** Waits until every answer being posted has been posted or has failed. For tests. */
  repliesSent(): Promise<void> {
    return repliesSent(this);
  }

  // ------------------------------------------------------------ models

  async refreshModels(session: HarnessSession): Promise<void> {
    try {
      const rows = await session.supportedModels();
      const mapped = mapModels(rows);
      if (mapped.length) {
        this.models = mapped;
        this.modelsFromHarness = true;
        log.info(`The harness offers ${mapped.length} Claude models (${rows.length} rows)`);
      }
    } catch (err) {
      log.debug("Could not read the harness's model list", err);
    }
  }

  // ------------------------------------------------------------ stop

  /**
   * Stops every bot. Messages still waiting in a queue stay queued in the database and are sent
   * after the next start, in order.
   */
  shutdown(): void {
    this.stopping = true;
    this.hub.stop();
    this.titles.stop();
    this.codexTitles.stop();
    this.notifier.shutdown();
    this.links.stop();
    // A backup being made is ended and its half-made file removed; await backupStopped() before the database closes.
    void this.backup.stop();
    this.browser.shutdown();
    clearTimeout(this.flushTimer);
    clearTimeout(this.tickTimer);
    clearTimeout(this.artifactTimer);
    clearInterval(this.uploadsTimer);
    this.flush();
    for (const ask of [...this.asks]) {
      clearTimeout(ask.timer);
      if (!ask.late && !ask.settled) {
        ask.settled = true;
        ask.resolve({ problem: "Pobots is stopping, so there is no answer." });
      }
    }
    this.asks.clear();
    for (const rt of this.bots.values()) {
      flushNotes(this, rt); // what the main bot changed in a turn that is cut short: told now
      clearTimeout(rt.doneTimer);
      clearTimeout(rt.sleepTimer);
      clearTimeout(rt.interruptTimer);
      const waited = keepCardsAtShutdown(this, rt); // engine 0.29.0: open cards come back after the restart
      if (rt.busy) {
        for (const key of [...rt.textItems.keys()]) closeBotItem(this, rt, key);
        for (const tool of rt.tools.values()) finishActivity(this, tool, cutShortStatus(tool, waited));
        rt.tools.clear();
        this.notice(rt, waited ? WAITED_NOTICE : "Pobots stopped while the bot was working, so this turn was cut short.", "info");
        saveTurnChanges(this, rt);
        rt.busy = false;
        rt.turn = undefined;
      }
      cancelSettle(this, rt);
      clearTimeout(rt.liveTimer);
      closeTaskManagers(this, rt);
      stopHelpers(this, rt, "restart");
      rt.queue = [];
      closeAllSessions(this, rt);
    }
  }

  // ------------------------------------------------------------ attachments (docs/build/step-files.md)

  /** Whether a bot's model can be shown pictures: every Claude model, and a GPT model whose Codex list says "image". */
  seesPictures(rt: BotRuntime): boolean {
    if (rt.folder.file.harness !== "codex") return true;
    return !(this.codex.noPictures ?? []).includes(rt.folder.file.model);
  }

  /** A new upload for a bot: its id and the file its bytes are written to. Throws not_found for an unknown bot. */
  beginUpload(botId: string): { id: string; part: string } {
    return beginUpload(this, botId);
  }

  /** The bytes of an upload are all there: check them and make it an attachment, or throw with plain words (and the upload is gone). */
  finishUpload(id: string, botId: string, rawName: string): Promise<Attachment> {
    return finishUpload(this, id, botId, rawName);
  }

  /** Removes unsent uploads older than a day. At start and every hour. Never throws. */
  tidyUploads(): number {
    return tidyUploads(this);
  }

  /**
   * Step 7c: the calm daily pass that removes attachments sent more than 14 days ago from every bot's
   * `.attachments` (cleanOldAttachments; nothing else is touched). Looked at every hour; it runs when
   * the last pass is a day old, never while a backup is being made, and never in the first ten
   * minutes after a start. `force` runs it now (tests). Never throws. Returns how many went.
   */
  tidyAttachments(force = false): number {
    return tidyAttachments(this, force);
  }

  /** The bytes all unsent uploads take on disk now (uploads still arriving included). */
  uploadsSize(): number {
    return uploadsSize(this);
  }

  /** An upload that did not arrive whole goes. */
  abortUpload(id: string): void {
    abortUpload(this, id);
  }

  /** attachment.discard: an unsent upload goes. A sent attachment is never touched. No error when it is gone. */
  discardAttachment(id: string): void {
    discardAttachment(this, id);
  }

  /** The file that answers GET /api/attachments/<id>/<which>, or undefined (404). */
  // ------------------------------------------------------------ step 7c: to-dos for the person

  /**
   * "todo.answer": the person pressed a button of a to-do and/or filled its fields. The bot gets it
   * as his message in its main chat (waiting in line while it works, as a message that is not urgent);
   * the to-do is then off the list unless the bot keeps it open.
   */
  answerTodo(params: Methods["todo.answer"]["params"]): void {
    answerTodo(this, params);
  }

  /** "todo.close": the person marks a to-do done or dismisses it. The bot hears of it at its next turn. */
  closeTodo(params: Methods["todo.close"]["params"]): void {
    closeTodo(this, params);
  }

  /**
   * GET /api/todos/<todoId>/files/<n>: the file of block n of an open to-do, from inside its bot's
   * folder only (looked at again on every request). A checked picture is shown inline, anything else
   * is a download.
   */
  todoFile(todoId: string, index: number): ServedFile | undefined {
    return todoFile(this, todoId, index);
  }

  attachmentFile(id: string, which: "preview" | "full"): ServedFile | undefined {
    return attachmentFile(this, id, which);
  }

  /** True when a bot folder exists on disk. Used by tests. */
  hasFolder(botId: string): boolean {
    const rt = this.bots.get(botId);
    return !!rt && existsSync(rt.folder.dir);
  }
}
