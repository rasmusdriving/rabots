// The contract between the app (ui/) and the engine (engine/).
//
// Everything that crosses the WebSocket is defined here and nowhere else. Both sides import
// these types. The UI never talks to a harness and the engine never renders anything.
//
// Wire format: JSON text frames, one message per frame.
//   request   { t: "req", id, method, params }          app -> engine
//   response  { t: "res", id, ok: true, result }        engine -> app
//             { t: "res", id, ok: false, error }
//   event     { t: "evt", event, data }                 engine -> app, unprompted
//
// The desktop shell's window connects to ws://127.0.0.1:<port>/?token=<token>. The engine refuses
// any other token. On start the engine prints one line to stdout so its parent can find it:
//   {"pobotsEngine":{"port":51234,"token":"..."}}
//
// Serve mode (`--serve`): the engine also serves the built app window as a web page on the same
// port, with the WebSocket on /ws. A browser page connects to its own origin without a token and is
// let in by its Tailscale identity (see docs/remote.md). In serve mode there is no stdout line; the
// port and token are in <dataDir>/engine.json (EngineLock) for local programs.
//
// Webhooks: `POST /hook/<trigger id>/<secret>` on the same port wakes a bot (see Trigger). It needs
// no token and no Tailscale identity; the secret in the path is the key. JSON bodies only.
// Channels use the same path with a channel's id (see Channel and docs/build/step-2c.md for the body).
// Only `/hook/` may be published outside the tailnet.
//
// Artifacts: `GET /page/<key>/<path>` on the same port serves the files of one artifact for showing
// in a frame (see Artifact and "artifact.open"). The key is short-lived and is the only thing that
// lets a caller in. Every answer carries a content security policy that seals the page: it runs as
// a sandboxed document with an origin of its own, may load scripts and fonts only from the places
// a Claude artifact may, and can reach neither the engine nor anything else on the network.
//
// The browser: the bots work in a browser on the engine's machine (see BrowserState). The engine
// can show a live picture of one of its pages and pass the person's pointer and keys on to it.
// Pictures travel as "browser.frame" events on this same socket and nowhere else.
//
// Harnesses: a bot runs on one harness, the program that drives its model. "claude" is the
// installed Claude Code; "codex" is the installed Codex, signed in with ChatGPT, which runs the
// GPT models. A bot's model decides its harness (see ModelInfo.harness). Everything else in this
// file is the same for both: the app never asks which harness a bot runs on, except to say so.

import type { UsageOverviewRead, UsageRange } from "./usage-overview.js";
export * from "./usage-overview.js";

export const PROTOCOL_VERSION = 28;

// ---------------------------------------------------------------- steering (protocol 14)

/**
 * What a message the person sends while the bot is in a turn does. "steer": it goes into the running
 * turn and the bot reads it at its next step (after the command or helper it is in), without
 * stopping. "queue": it waits until the turn has ended, as before. The default is the person's
 * setting (ChatSettings); the window can ask for the other one for a single message.
 */
export type FollowUp = "steer" | "queue";

/** Settings for the chat as a whole, saved in config.json ("chat"). */
export interface ChatSettings {
  /** What a message sent while a bot works does by default. "steer" unless the person chose "queue". */
  followUp: FollowUp;
}

// ---------------------------------------------------------------- pictures and files in a message

/** Up to this many attachments in one message, and up to this many bytes each. */
export const ATTACHMENTS_PER_MESSAGE = 10;
/** Step 7c (protocol 15): any kind of file, up to 100 MB (was 25 MB and only some kinds). */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** Step 7c (protocol 15): sent attachments are removed from the bot's folder after this many days. */
export const ATTACHMENT_KEEP_DAYS = 14;

/**
 * A picture or a file the person attached to a message. The engine keeps the file in the bot's
 * folder at `path` and tells the bot where it is. A picture is also shown to the model as a picture.
 *
 * The bytes travel over HTTP on the engine's own port, not over the socket:
 *   POST /api/attachments?bot=<botId>&name=<file name, URI-encoded>     body: the file's bytes
 *     -> 200 AttachmentUploadResult, or 400, 413, 415 with { error: ErrorBody }; codes "too_large",
 *        "unsupported", "bad_request", "not_found" (no such bot). Needs the socket's own rule: the
 *        local token, or an allowed Tailscale login from the page's own origin.
 *   GET /api/attachments/<id>/preview   a picture's small JPEG, about 1024 px on the long side
 *   GET /api/attachments/<id>/full      the file as it was sent; a picture inline, the rest as a download
 *     Need the token or an allowed Tailscale login, like /api/whoami.
 * Only pictures the engine has checked by their contents are ever served inline.
 */
export interface Attachment {
  /** Stable for life: "att_" and random letters. Names the upload and the stored file. */
  id: string;
  /** The file's own name, cleaned: "Screenshot 2026-11-13 08.12.png". */
  name: string;
  kind: "picture" | "file";
  /** The media type the engine found by the file's contents: "image/png", "application/pdf". */
  type: string;
  /** Bytes of the file as sent. */
  size: number;
  /** A picture's size in pixels, upright. The app reserves its box from these, so nothing jumps. */
  width?: number;
  height?: number;
  /** Where the bot finds it, inside its folder: ".attachments/2026-11/att_x/report.pdf". Empty until the message is sent. */
  path: string;
  /** True when the file is gone from the Mac (deleted, or not brought back by a restore). */
  missing?: boolean;
  /**
   * Step 7c (protocol 15): true when it is gone because attachments are kept ATTACHMENT_KEEP_DAYS
   * days and its message is older. Comes with `missing`. The app says "No longer kept".
   */
  expired?: boolean;
}

export interface AttachmentUploadResult {
  attachment: Attachment;
}

// ---------------------------------------------------------------- connections between Pobots
export interface PobotsConnection {
  id: string;
  name: string;
  state: "draft" | "waiting" | "connected" | "paused" | "unreached" | "expired";
  expiresAt: string;
  lastReached?: string;
  lastMessage?: string;
}

export interface ConnectionsState {
  hasPublicAddress: boolean;
  connections: PobotsConnection[];
}

export type ConnectionChange =
  | { action: "start"; name: string }
  | { action: "code" | "pause" | "resume" | "remove"; id: string }
  | { action: "connect"; id: string; code: string }
  | { action: "rename"; id: string; name: string };

export interface ConnectionChangeResult {
  state: ConnectionsState;
  id: string;
  /** Public pairing code, only returned when starting or asking to see one. */
  code?: string;
}

// ---------------------------------------------------------------- the nightly backup

/** The nightly backup and the most recent runs of this restic repository. */
export interface BackupState {
  passwordRef?: string;
  resticInstalled: boolean;
  folder: { path: string; ok: boolean; iCloud: boolean; problem?: string };
  time: string;
  keep: number;
  nextAt?: string;
  running: boolean;
  lastGood?: BackupRun;
  history: BackupRun[];
  repositoryBytes?: number;
  snapshots?: number;
}

export interface BackupRun {
  at: string;
  /** "made" while checking upload; a failed run may still have made a snapshot. */
  status: "made" | "saved" | "unconfirmed" | "failed";
  by: "night" | "you";
  snapshot?: string;
  bytes?: number;
  problem?: string;
  leftOut?: string[];
}

// ---------------------------------------------------------------- notifications when the page is not open
//
// Web push: the engine sends a short message to each device the person turned notifications on
// for, through that browser's push service (Google, Microsoft, Mozilla or Apple). The message is
// locked for the one browser (RFC 8291) and says only which bot and what kind of thing, never what
// the chat says. The page's service worker (/sw.js, a file of the built app) shows it. The engine
// decides who gets one: it never sends a push that the service worker would have to hide.

/**
 * What a notification can be about. Each can be switched off, for all devices at once.
 * "needs": a card waits for the person's answer (a question or an approval). "note": a bot, or
 * Pobots itself, put a note in front of the person. "finished": a bot came to rest after work the
 * person asked for, or stopped on an error in such work.
 */
export type NotifyKind = "needs" | "note" | "finished";

/** A device (a browser, or a home screen app) that gets notifications. Never its address or keys. */
export interface NotifyDevice {
  /** SHA-256 of the device's push address, base64url, its first 22 characters: the same address always gives the same id, and the page can work out its own. */
  id: string;
  /** Made by the page from the browser and system: "Edge on Windows", "Home screen app on iPhone". At most 60 characters. */
  label: string;
  service: "Google" | "Microsoft" | "Mozilla" | "Apple";
  addedAt: string;
  /** The last notification sent to it, or tried. */
  last?: NotifySend;
  /** When the push service said this device no longer takes notifications. It gets none until it is turned on again on that device. */
  goneAt?: string;
}

export interface NotifySend {
  at: string;
  kind: NotifyKind | "test";
  /** "sent": the push service took it. "refused": it answered with an error. "unreachable": no answer in time, or no connection. */
  result: "sent" | "refused" | "unreachable";
  /** The push service's own short reason, for "refused" and "unreachable". One line, no address. */
  problem?: string;
}

export interface NotifyState {
  /** The engine's public key for web push (the browser's applicationServerKey), base64url. Not a secret. */
  publicKey: string;
  /** Which kinds are on, for all devices. */
  kinds: Record<NotifyKind, boolean>;
  /** Oldest first. At most NOTIFY_MAX_DEVICES. */
  devices: NotifyDevice[];
}

/** What one push message holds. The engine makes the words; the service worker shows it as it is. */
export interface PushMessage {
  v: 1;
  kind: NotifyKind | "test";
  title: string;
  body: string;
  /** One notification per bot and kind: "pobots-<botId>-needs". A newer one with the same tag replaces it. */
  tag: string;
  /** Where a click leads, a path on the page's own origin: "/?bot=po&open=needs". */
  url: string;
  botId?: string;
}

/**
 * What the service worker posts to an open Pobots window when a notification is clicked. A window
 * that is not open yet gets the same as a query on its address, read once after the first
 * snapshot and then taken out of the address bar: "/?bot=<id>&open=needs", "/?bot=<id>&open=chat",
 * or "/?open=needs" for a note from Pobots itself.
 */
export interface NotificationOpen {
  pobots: "open";
  bot?: string;
  open: "chat" | "needs";
}

/** At most this many devices get notifications. */
export const NOTIFY_MAX_DEVICES = 20;
/** A visible window says so again this often (ms), and is taken as gone after NOTIFY_PRESENCE_STALE_MS without a word. */
export const NOTIFY_PRESENCE_EVERY_MS = 60_000;
export const NOTIFY_PRESENCE_STALE_MS = 150_000;
/** While a Pobots window is in front and was used within this time (ms), no device gets a notification. */
export const NOTIFY_QUIET_AFTER_USE_MS = 120_000;

// ---------------------------------------------------------------- bots

/**
 * What a bot is doing right now. Drives the face and the status mark (see the design system).
 * A bot whose own turn has ended while helpers it started still work is "working", never "done".
 */
export type BotState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

/** How much a bot may do without asking. Shown as: Asks first, Edits freely, Decides itself, Full access. */
export type AccessLevel = "asks-first" | "edits-freely" | "decides-itself" | "full-access";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The program that drives a bot's model: the installed Claude Code, or the installed Codex (the GPT models, through the ChatGPT login). */
export type Harness = "claude" | "codex";

export type EyeShape = "round" | "tall" | "wide" | "square";
export type EyeGap = "near" | "mid" | "far";

/** A bot's face. Chosen once when the bot is created and kept for life. */
export interface BotLook {
  eyes: EyeShape;
  gap: EyeGap;
}

export interface Bot {
  /** Folder name of the bot, a lowercase slug. Stable for life. */
  id: string;
  name: string;
  /** Exactly one bot is "main". It coordinates, may message every bot, and is the only one with the tools to create, change and retire bots. */
  role: "main" | "bot";
  /** One line for people and for the other bots about what this bot is for. May be empty. */
  purpose: string;
  look: BotLook;
  /**
   * Which harness runs the bot. Always the harness of `model` (ModelInfo.harness): the engine sets
   * it when the model is set, and a client never sends it.
   */
  harness: Harness;
  /** Model id as the harness knows it, for example "claude-opus-5-5" or "gpt-6.1-terra". */
  model: string;
  effort: Effort;
  /**
   * The bot's choice for fast mode: the model answers faster, on some models for more of the plan's
   * usage. True unless the person or a bot switched it off. It is the bot's own setting and is kept
   * when the model changes, but it has an effect, and is shown, only while the bot's model has a
   * fast mode (ModelInfo.fast). For such a model the engine tells the harness the choice itself on
   * every turn, on or off, so the person's own settings of that harness never decide it.
   */
  fast: boolean;
  access: AccessLevel;
  /** Id of the machine the bot lives on. */
  machine: string;
  state: BotState;
  /** One line in plain words about what the bot is doing, written for the roster. May be empty. */
  activity: string;
  /**
   * Engine 0.31.1: true when the bot reads "waiting" only because a card of it waits on no turn (a
   * card that came back after a restart, or one left open after a question on it). The bot is not in
   * a turn: a message starts one at once, as for an idle bot. Absent otherwise. An older window
   * ignores it.
   */
  atRest?: boolean;
  /**
   * Engine 0.31.2: the id of the turn running now in the bot's main chat (the turn id its items
   * carry), absent between turns and for a turn in another thread. The window draws that turn as
   * the current answer, so a turn that begins by itself (a helper or background task reported
   * back) starts its own block instead of reopening the answer before it. An older window ignores it.
   */
  turnId?: string;
  /** The bot's permanent chat. */
  mainThreadId: string;
  /**
   * Ids of the bots this bot may message. The main bot may message every bot whatever this says,
   * and every bot may message the main bot. Ids of retired bots are dropped by the engine.
   */
  mayMessage: string[];
  /**
   * Protocol 17 (15 Nov 2026): the bot may steer another bot, that is send a message into its running
   * turn with message_bot's delivery "steer". Off by default; always true for the main bot. A bot
   * without it that asks for steer has its message queued. Every bot steers its own helpers.
   */
  maySteer: boolean;
  /**
   * Protocol 20 (16 Nov 2026): the bot has the calendar tools, which work on the person's own Outlook
   * calendar through a Power Automate flow (see CalendarState). Off by default; on by default for the
   * main bot. The tools are there only while the flow is set up too.
   */
  calendar: boolean;
  /**
   * How full the working session behind the bot's chat is, when the engine knows. The chat the
   * person sees is never shortened; the session is what the bot holds in its head, and the engine
   * replaces it with a fresh one at calm moments (docs/context.md, docs/build/step-2d.md).
   */
  context?: BotContext;
  /**
   * How many helpers of this bot are working right now, in any of its threads (see HelperItem).
   * 0 or absent when none. While it is above 0 the bot is not calm: no fresh start, and `state`
   * is never "idle" or "done".
   */
  helpers?: number;
  /**
   * Protocol 19: the helpers of this bot that work right now, in the order they started, so the
   * window can list them in one place ("Helpers at work") and lead to each one's thread, wherever
   * its row stands (docs/build/step-helpers-in-rail.md). Absent when none. Changes only when a
   * helper starts or ends, so the bot is not sent again while a helper works.
   */
  workingHelpers?: WorkingHelper[];
  /**
   * Step 7b (protocol 15): what a message the person sends while this bot works does, when the bot
   * has a choice of its own. Absent: the Pobots default (ChatSettings.followUp).
   */
  followUp?: FollowUp;
}

/** The working session behind a bot's main chat. */
export interface BotContext {
  /** Tokens in the session after its last turn. 0 for a session that has not had a turn yet. */
  tokens: number;
  /**
   * The size at which the engine starts the session fresh right after a turn: a share of what the
   * model can hold, or a fixed limit, whichever is smaller. `tokens / window` is how full it is.
   */
  window: number;
  /** When the current session started, ISO 8601: the last fresh start, or the bot's first turn. */
  since?: string;
  /** True while the bot is writing down what matters before a fresh start. */
  tidying: boolean;
}

export interface ModelInfo {
  id: string;
  /** The harness that runs this model. The picker groups the list by it: "Claude" and "ChatGPT". */
  harness: Harness;
  /** Short name for people, for example "Opus 5.5" or "GPT-6.1 Terra". */
  label: string;
  efforts: Effort[];
  defaultEffort: Effort;
  /**
   * True when the model has a fast mode. Today only GPT models have one (Codex's service tier
   * "priority"), and the engine reads it from the harness's own model list. Absent or false: no
   * fast mode, and no switch for it is shown.
   */
  fast?: boolean;
  /** The harness's own few words about what fast mode gives on this model, for example "1.5x speed". Only with `fast`. */
  fastHint?: string;
}

export interface Machine {
  id: string;
  name: string;
  /** "this" is the machine the connected engine runs on. A page opened from another device shows it as connected, not as "this one". */
  status: "this" | "online" | "asleep";
}

/** Whether the engine can reach each harness. Shown as a quiet notice when something is missing. */
export interface EngineStatus {
  engineVersion: string;
  claude: {
    ready: boolean;
    /** Version string of the installed Claude Code, when found. */
    version?: string;
    /** One plain sentence saying what is wrong and what to do, when not ready. */
    problem?: string;
  };
  /**
   * The installed Codex and its ChatGPT login. Not ready is no fault as long as no bot uses a GPT
   * model: the picker then lists no GPT models, and `problem` says in one plain sentence what is
   * missing ("Codex is not installed on this Mac.", "Codex is not signed in. ...").
   */
  codex: {
    ready: boolean;
    version?: string;
    problem?: string;
  };
}

// ---------------------------------------------------------------- thread items

interface ItemBase {
  id: string;
  threadId: string;
  /** Position in the thread. Strictly increasing within a thread, never reused. */
  seq: number;
  /** ISO 8601 time. */
  at: string;
  /**
   * The turn this item belongs to. A user item carries the id of the turn it started, once that
   * turn starts (a queued message has none yet). The app folds a whole turn that another bot
   * started into one line. A turn the harness starts by itself, when a helper that worked in the
   * background reports back, is a turn like any other with an id of its own; no user item starts it.
   */
  turnId?: string;
}

/** Something said to the bot. */
export interface UserItem extends ItemBase {
  kind: "user";
  /** May be empty when the message has attachments. */
  text: string;
  /** Pictures and files the person attached, in the order attached. Absent when none. Only on a message from the person. */
  attachments?: Attachment[];
  /**
   * Who said it. From another bot: `expectsReply` is true when the sender waits for this turn's
   * last message as its answer ("ask"), false when it only passed something on ("tell").
   */
  from:
    /**
     * From the person. Step 7c (protocol 15): `todo` when it is his answer to one of the bot's
     * to-dos (what he pressed and typed in its modal); the app marks it "From your to-do".
     * Protocol 22: `card` when it is his answer to a card that came back after a restart (the turn
     * that asked was gone, so the answer became a message); the app marks it "From your card".
     * Protocol 23: `question` is true when it is not an answer but his question about that to-do or
     * card before he acts (docs/build/step-card-follow-ups.md); the app marks it "Question on your
     * to-do" / "Question on your card", and the card stays open.
     */
    | { type: "you"; todo?: { id: string; title: string }; card?: { id: string; title: string }; question?: true }
    /** Protocol 21: `taskManager` is the title of the bot's task manager that wrote it (`botId` is its bot). */
    | { type: "bot"; botId: string; expectsReply: boolean; taskManager?: string }
    | { type: "connection"; id: string; name: string; mode: "ask" | "tell" | "answer"; messageId: string }
    /**
     * From a trigger. `label` is its name at the time. `triggerId` and `runId` say which trigger and
     * which run. `result` is true when this is not the trigger's own message but what a fresh run
     * passed on to the main chat.
     */
    | { type: "trigger"; label: string; triggerId?: string; runId?: string; result?: boolean }
    /**
     * From a person in an outside channel such as a Teams channel, sent to this bot with its tag.
     * `sender` is the person's name there. `label` is the channel's name. The message counts as an
     * instruction from the person (decision of 11 Nov 2026). The item's text is what was written;
     * `context` holds the messages before it, oldest first, which are background, not instructions.
     */
    | { type: "channel"; channelId: string; label: string; sender: string; tag: string; messageId: string; context?: ChannelContextMessage[] }
    /**
     * From Pobots itself, not from a person: the request to a bot to write down what matters
     * before its session is replaced by a fresh one. The turn it starts is a tidy turn. The app
     * never shows it as a message; it folds the whole turn behind the "fresh" notice that ends it.
     */
    | { type: "app"; reason: "tidy" };
  /** True while the message waits for the bot to finish its current turn. */
  queued: boolean;
  /**
   * The person sent it into the bot's running turn (steering): it carries that turn's id, stands in
   * the chat where it went in, and the bot reads it at its next step. Should the turn end before the
   * bot could take it, it is read at once in a turn of its own (it keeps this mark); should the
   * harness refuse it, it waits in line as a queued message instead (and loses the mark). Absent on
   * every other message. Protocol 17 (15 Nov 2026): also on a message from another bot that steered
   * it in (message_bot delivery "steer"), and in a helper's thread on a message its bot sent with
   * steer_helper while the helper worked.
   */
  steered?: boolean;
}

/** Something the bot said. Markdown. */
export interface BotItem extends ItemBase {
  kind: "bot";
  botId: string;
  text: string;
  /** True while the text is still arriving. Deltas come as "item.delta" events. */
  streaming: boolean;
}

/** One line for work done: a tool call, summed up in plain words. */
export interface ActivityItem extends ItemBase {
  kind: "activity";
  botId: string;
  /** Plain words in the past or present tense: "Read AGENTS.md", "Searching the web". */
  label: string;
  /** Optional extra detail, shown on request: the command, the path, the query. */
  detail?: string;
  status: "running" | "done" | "failed";
  durationMs?: number;
}

/**
 * Protocol 19: one helper that works now, as listed on its bot (Bot.workingHelpers). Enough to show
 * its row in "Helpers at work" and to open its thread like its row in the chat does.
 */
export interface WorkingHelper {
  /** The id of its helper item. */
  itemId: string;
  /** The thread its helper item stands in: the main chat, a fresh run's thread, or the thread of the helper that started it. */
  threadId: string;
  /** Its own thread. */
  helperThreadId: string;
  title: string;
  harness?: Harness;
  model?: string;
  effort?: Effort;
  /** When it started (ISO). */
  startedAt: string;
  /** The name of the fresh run it works for, when its work does not stand in the main chat: "Morning work round". */
  inRun?: string;
  /** The item id of the helper that started it, when a helper did. */
  parentItemId?: string;
}

/**
 * A helper: a worker the bot started for one task. Either inside its own harness (the harness's
 * own subagent) or, with the bot tool "start_helper", on any model of the list, also one of the
 * other harness: a bot on Claude can give a task to a helper on a GPT model and the other way
 * round. Not a bot: it has no folder, no memory and no name of its own, and it is gone when
 * its task ends. This item is one line in the thread, at the place where the bot started it. What
 * the helper said and did is a thread of its own (`helperThreadId`), read with "thread.read" and
 * kept for good like every thread.
 *
 * The helper's thread holds, in order: one user item `from: { type: "bot", botId, expectsReply: true }`
 * with the task the bot gave it; then the helper's own messages (bot items that carry the starting
 * bot's id; the app shows them as the helper's, not the bot's), its work (activity items), and a
 * helper item for each helper it started itself. Its last bot item is the result it handed back.
 * Live changes arrive as "item.upsert" and "item.delta" with the helper thread's id, like any thread.
 */
export interface HelperItem extends ItemBase {
  kind: "helper";
  /** The bot the helper works for. */
  botId: string;
  /** The task in a few words, as the bot named it: "Inventory the work-bot agents". Plain text. */
  title: string;
  helperThreadId: string;
  /** "stopped": ended by the person, by "Stop" on the bot, or because the engine or harness went away. */
  status: "running" | "done" | "failed" | "stopped";
  /** True when the bot went on with its turn without waiting for the helper. */
  background: boolean;
  /**
   * One line about now, or about the end: the step that is running ("Reading AGENTS.md"), or the
   * start of what the helper last said. Plain text on one line, at most 160 characters. The engine
   * sends a changed `last` at most about once a second for each helper.
   */
  last?: string;
  /** How many steps of work (tool calls) the helper has done so far. */
  steps: number;
  /**
   * The model the helper runs on (a ModelInfo id) and its effort, when the bot chose them for this
   * helper. Absent when the helper runs on the bot's own model and effort. The row shows them as a
   * quiet label ("GPT-6.1 Terra, high").
   */
  model?: string;
  effort?: Effort;
  /**
   * True when the helper runs in fast mode (see Bot.fast). Absent when it does not, or when its
   * model has none. The row adds it to the label: "GPT-6.1 Terra, extra high, fast".
   */
  fast?: boolean;
  /** When it ended, ISO 8601. Absent while it runs. */
  endedAt?: string;
}

/**
 * An artifact: a page a bot made for the person to look at or use, such as a report, a mock-up or a
 * chart. Two kinds. A "page" is an HTML file in the bot's folder, shown inside Pobots in a sealed
 * frame; it may also have been published to Claude, and then has a link. A "link" lives only on
 * Claude (a document, a deck, a page of a special type, or a page whose file is not in the bot's
 * folder); Claude's pages refuse to be shown inside another page, so it opens in a window of its own.
 */
export interface Artifact {
  id: string;
  botId: string;
  kind: "page" | "link";
  /** A name of a few words: "Onboarding status". From the bot, else from the page's own title. */
  title: string;
  /** For a "page": the HTML file, relative to the bot's folder, for example "artifacts/onboarding-status/index.html". */
  path?: string;
  /** The page on Claude, once it is published there. Always set for a "link". */
  url?: string;
  /** Goes up by one each time the page's files change. A frame showing an older number loads again. 0 for a "link". */
  rev: number;
  /** False when the file of a "page" is gone. The row then says so and cannot be opened. */
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One line in the thread where a bot showed an artifact, changed it, or published it. The item
 * carries the artifact as it was at that moment; the app shows the newest state it knows for that
 * `artifact.id` (from "artifact.list" and "artifact.changed"). It is part of the bot's answer, not
 * of its work: it stays in sight when the turn's work is folded away.
 */
export interface ArtifactItem extends ItemBase {
  kind: "artifact";
  botId: string;
  artifact: Artifact;
  what: "made" | "updated" | "published";
}

/**
 * One line in the thread where a bot worked in the browser: a row that opens the live picture of
 * its workspace beside the chat. One item per turn and workspace, at the place where the bot first
 * worked in that workspace in that turn. It is part of the turn's work (it folds away with it). The
 * lines of work for the bot's single browser commands stay as they are, after it.
 */
export interface BrowserItem extends ItemBase {
  kind: "browser";
  botId: string;
  /** The workspace, see BrowserSpace. It may be gone by now. */
  spaceId: string;
  /** The name the bot gave the workspace: "Check the survey settings". Plain text. */
  name: string;
  /** "closed" once the workspace is gone from the browser. */
  status: "open" | "closed";
  /**
   * One line about now: the title of the page the workspace shows and its host, "Surveys ·
   * app.example.com". Plain text on one line, at most 160 characters, changed at most about once a
   * second. When closed: the last one it had.
   */
  last?: string;
  /** When the workspace was closed, ISO 8601. */
  endedAt?: string;
}

/** A quiet line from the app itself: an interruption, an error, a fresh start. */
export interface NoticeItem extends ItemBase {
  kind: "notice";
  text: string;
  tone: "info" | "error";
  /**
   * What kind of line this is, when it marks the bot's session. "fresh": from here on the bot
   * works in a fresh session, with its memory and the note in `detail`. "compacted": the harness
   * shortened the session by itself in the middle of a long task. Absent for ordinary notices.
   */
  mark?: "fresh" | "compacted" | "posted" | "calendar";
  /**
   * For "fresh": the note the bot wrote for itself, shown on request. For "posted" (protocol 18),
   * and for a post that failed: the post's text, shown on request. For "calendar" (protocol 20), and
   * for a calendar action that failed: what was done, when and with whom. Markdown.
   */
  detail?: string;
  /** For "fresh": the tidy turn this notice ends, so the app can show its steps on request. */
  tidyTurnId?: string;
}

export type Item = UserItem | BotItem | ActivityItem | NoticeItem | HelperItem | ArtifactItem | BrowserItem;

// ---------------------------------------------------------------- cards (the "Needs you" rail)

interface CardBase {
  id: string;
  botId: string;
  threadId: string;
  at: string;
}

/** A bot asks to do one thing. The three answers are fixed. */
export interface ApprovalCard extends CardBase {
  kind: "approval";
  /** The question in one sentence: "Run this command?", "Send this reply in Teams?". */
  title: string;
  /** Exactly what will happen: the command, the draft, the change. Shown in a well. */
  detail: string;
  /** Small mono caption above the detail, for example the tool name or the destination. */
  caption?: string;
  /** ISO time after which the card is withdrawn and counts as denied. */
  expiresAt?: string;
  /** True when "Always allow" must not be offered: retiring a bot, creating one. */
  noAlways?: boolean;
  /** Step 7c (protocol 15): the title of the bot's helper that asks, when a helper asks. */
  helper?: string;
  /**
   * Protocol 20: the meeting a calendar tool will make, move, cancel or answer once the person
   * approves. The app draws it and names the buttons "Approve" and "Deny"; `detail` says the same in
   * words, so a window that does not know it still shows everything.
   */
  meeting?: CardMeeting;
}

/** A bot asks you to choose or to answer. */
export interface QuestionCard extends CardBase {
  kind: "question";
  title: string;
  /** One sentence of context. */
  text?: string;
  choices: { id: string; label: string }[];
  /** True when a typed answer is also welcome. */
  allowText: boolean;
  /** Step 7c (protocol 15): the title of the bot's helper that asks, when a helper asks. */
  helper?: string;
}

/** A bot tells you something you should see, with nothing to decide. Put away with "dismiss". */
export interface NoteCard extends CardBase {
  kind: "note";
  title: string;
  /** A sentence or two. Plain text. */
  text?: string;
}

/**
 * A card from Pobots itself, not from a bot: something about the app the person should see, such as
 * a backup that failed. It has no bot and no thread. Put away with "dismiss". There is at most one
 * per topic: a new one replaces the old, and the engine removes it by itself when the matter is
 * settled (after the next good backup).
 */
export interface SystemCard {
  id: string;
  kind: "system";
  at: string;
  /** What it is about. */
  topic: "backup";
  title: string;
  /** A sentence or two. Plain text. */
  text?: string;
}

export type Card = ApprovalCard | QuestionCard | NoteCard | SystemCard;

export type CardDecision =
  | { type: "allow-once" }
  | { type: "always-allow" }
  | { type: "deny" }
  | { type: "choice"; choiceId: string }
  | { type: "text"; text: string }
  /** Put a note card away. */
  | { type: "dismiss" }
  /** Put the card away for now. Counts as "deny" for an approval and as no answer for a question. */
  | { type: "later" };

// ---------------------------------------------------------------- a bot's files, changes and saved rules

/** What a file in a bot's folder is, for grouping in the app. */
export type BotFileKind = "job" | "memory" | "skill" | "other";

/** One text file in a bot's folder. `bot.json`, `.git` and anything outside the folder are never listed. */
export interface BotFile {
  /** Path inside the bot's folder, with forward slashes: "AGENTS.md", "memory/MEMORY.md". */
  path: string;
  kind: BotFileKind;
  /** A name for people: "Job", "Memory index", "customers" (for memory/topics/customers.md). */
  title: string;
  /** Bytes. */
  size: number;
  /** ISO 8601 time. */
  modifiedAt: string;
}

/** One saved change to a bot's folder (a commit in its git history). */
export interface BotChange {
  id: string;
  /** ISO 8601 time. */
  at: string;
  /** Who made it: you in the app, the bot in a turn, or the app itself (creating the bot, an undo). */
  by: "you" | "bot" | "app";
  /** Plain words: "Edited the job", "Po changed 2 files", "Undid: Edited the job". */
  summary: string;
  /** Paths changed, at most 20. */
  files: string[];
  /** False when this change cannot be undone, such as the one that created the bot. */
  canUndo: boolean;
}

/** Something the person answered "Always allow" to. */
export interface SavedRule {
  id: string;
  botId: string;
  /** Plain words: "Run commands that start with git status". */
  label: string;
  /** The exact match, shown in mono: the tool and the pattern. */
  detail?: string;
  /** ISO 8601 time. */
  at: string;
}

// ---------------------------------------------------------------- triggers: what wakes a bot by itself

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** When a schedule fires. Times are "HH:MM" in the machine's own time zone. */
export type Schedule =
  /** At one time on the chosen days: weekdays 07:30. */
  | { type: "daily"; time: string; days: Weekday[] }
  /** Again and again on the chosen days, optionally only between two times: every 30 minutes, 08:00 to 17:00. At least 5 minutes apart. */
  | { type: "every"; minutes: number; days: Weekday[]; from?: string; to?: string }
  /** Once, at an ISO 8601 time. The trigger switches itself off afterwards. */
  | { type: "once"; at: string };

/** One firing of a trigger. */
export interface TriggerRun {
  id: string;
  triggerId: string;
  botId: string;
  /** ISO 8601 time it fired. */
  at: string;
  /**
   * running: the bot is on it (or it waits in line). done: finished with something to say.
   * silent: finished with nothing to report. skipped: did not start (see `note`). failed: ended in an error.
   */
  status: "running" | "done" | "silent" | "skipped" | "failed";
  /** One plain line: why it was skipped, what went wrong, or the first words of the result. */
  note?: string;
  /** The thread the run happened in: the bot's main thread, or the run's own thread for a fresh run. */
  threadId?: string;
  turnId?: string;
}

/** Something that wakes a bot without the person writing: a schedule, or a call from outside. */
export interface Trigger {
  id: string;
  botId: string;
  kind: "schedule" | "webhook";
  /** A name for people: "Morning brief", "New ticket". */
  name: string;
  /** What the bot is told when it fires. For a webhook, what was sent is added after it, marked as data from outside. */
  prompt: string;
  /**
   * main: the run is a turn in the bot's main chat. fresh: the run gets its own thread with no
   * earlier conversation (the bot still has its job and memory), and only its result is passed
   * on to the main chat, or nothing when there is nothing to report.
   */
  where: "main" | "fresh";
  enabled: boolean;
  /** Schedules only. */
  schedule?: Schedule;
  /** Schedules only: when it fires next, ISO 8601. Absent when switched off or finished. */
  nextAt?: string;
  lastRun?: TriggerRun;
  /** Who set it up: you in the app, or a bot with its tool. */
  createdBy: "you" | "bot";
  /** The bot that made it, when a bot did: the bot itself, or the main bot for another bot. */
  madeByBotId?: string;
}

/** A run that is coming up, for the "Later today" list. */
export interface Upcoming {
  /** ISO 8601 time. */
  at: string;
  botId: string;
  triggerId: string;
  name: string;
}

// ---------------------------------------------------------------- channels: talking to bots from outside

/** One earlier message in an outside conversation, given to a bot as background. */
export interface ChannelContextMessage {
  /** The writer's name there. */
  from: string;
  text: string;
  /** ISO 8601 time, when known. */
  at?: string;
}

/** Which bot a tag in a channel reaches. */
export interface ChannelRoute {
  /** The tag as written in the channel, without "@" or "#": "Po". Compared without regard to case. */
  tag: string;
  botId: string;
}

/**
 * An outside place where people can write to bots: a Teams channel, fed by a Power Automate flow
 * that posts each tagged message to the channel's address and posts the bot's answer back.
 */
export interface Channel {
  id: string;
  kind: "teams";
  /** A name for people: "Ops - Internal". */
  name: string;
  enabled: boolean;
  /** Who may write to bots here, as lowercase email addresses. A message from anyone else is refused. */
  allowedSenders: string[];
  routes: ChannelRoute[];
  /** How many earlier messages a bot is given as background, at most. 0 to 30. */
  contextCount: number;
  /** True when an address to post answers to is set. The address itself is never sent to the app. */
  hasReplyUrl: boolean;
  /**
   * The bots that may write new posts here on their own (protocol 18), as bot ids. Empty by
   * default. A post goes out through the address for answers.
   */
  mayPost: string[];
  lastMessage?: ChannelMessage;
}

/** One message that came in on a channel, and what became of it. */
export interface ChannelMessage {
  /** The message's id in the outside system. */
  id: string;
  channelId: string;
  /** ISO 8601 time it arrived. */
  at: string;
  /** The writer's name. */
  sender: string;
  /** The tag it used, when one matched. */
  tag?: string;
  /** The bot it went to. */
  botId?: string;
  /**
   * delivered: the bot has it (or it waits in line). answered: the bot's answer was posted back.
   * unanswered: the bot finished without anything to post. reply-failed: the answer could not be
   * posted. refused: the writer is not allowed here. ignored: no tag matched a bot.
   */
  status: "delivered" | "answered" | "unanswered" | "reply-failed" | "refused" | "ignored";
  /** One plain line: the first words of the message, or why it was refused or the answer failed. */
  note?: string;
  /** The turn in the bot's main thread, for "Show in chat". */
  turnId?: string;
}

// ---------------------------------------------------------------- the browser

/** One page (a tab) in a workspace of the browser. */
export interface BrowserPage {
  /** Stable while the page is open. */
  id: string;
  title: string;
  url: string;
  /** True for the page the workspace shows in front. */
  active: boolean;
}

/**
 * A workspace in the browser the bots use, on the engine's machine: a group of pages that belong to
 * one piece of work. A bot opens one when it starts browser work and closes it when it is done.
 * "you" is the person's own workspace, made by Pobots when they open a page themselves. "other" is
 * work in the same browser that Pobots cannot tie to one of its bots (another program's agent).
 * The person's own everyday window of that browser is never listed.
 */
export interface BrowserSpace {
  id: string;
  /** The name its maker gave it. "Your page" for the person's own. */
  name: string;
  owner: "bot" | "you" | "other";
  /** The bot it belongs to, when `owner` is "bot". */
  botId?: string;
  /** In tab order. */
  pages: BrowserPage[];
  /** True while a bot's browser command is running in it right now. */
  busy: boolean;
  /** True while the person has taken control of it in Pobots (from any window). */
  controlled: boolean;
}

/** Whether the browser can be reached, and what is open in it. */
export interface BrowserState {
  /** False when the browser is not installed on the engine's machine or cannot be reached. */
  available: boolean;
  /** One plain sentence saying what is wrong and what to do, when not available. */
  problem?: string;
  /** Open workspaces: the bots' first (in roster order), then the person's own, then others. */
  spaces: BrowserSpace[];
}

/**
 * Something the person did over the live picture, passed on to the page. Positions are in the
 * page's own pixels (see "browser.frame": `width` and `height`), from the top left of what is
 * shown. `mods` is a sum: 1 alt, 2 ctrl, 4 meta (the command key), 8 shift.
 */
export type BrowserInput =
  | { type: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; clicks?: number; mods?: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; mods?: number }
  /** A key going down or up. `key` and `code` as a browser's keyboard event names them. `text` is what the key types, when it types something. */
  | { type: "key"; down: boolean; key: string; code: string; text?: string; repeat?: boolean; mods?: number }
  /** Text put in at once: a paste, or what an input method composed. */
  | { type: "text"; text: string };

/**
 * Something the watched page shows that is not part of its picture, because the browser draws it
 * outside the page: a question of the page itself (alert, confirm, prompt), which holds the page
 * until it is answered, or the choices of a drop-down list the person opened. The app draws it
 * over the picture. Everyone who watches sees it; only the person in control can answer it.
 */
export type BrowserPrompt =
  | { kind: "dialog"; type: "alert" | "confirm" | "prompt"; message: string; defaultText?: string }
  /**
   * `x`, `y`, `width`, `height`: the list's own box in the page's pixels, for placing the choices
   * under it. `options` in the list's order; `group` is the heading an option stands under.
   */
  | { kind: "choices"; x: number; y: number; width: number; height: number; options: { label: string; selected: boolean; disabled: boolean; group?: string }[] };

// ---------------------------------------------------------------- requests

export interface Snapshot {
  status: EngineStatus;
  /** In roster order. Empty on first run. */
  bots: Bot[];
  /** Open cards, oldest first. */
  cards: Card[];
  models: ModelInfo[];
  machines: Machine[];
  /** The next run of each schedule that fires within 24 hours, soonest first, at most 20. One line per trigger. */
  upcoming: Upcoming[];
  /** The outside channels, in the order they were made. */
  channels: Channel[];
  /** The browser as the engine last knew it. Looking does not start the browser. */
  browser: BrowserState;
  /** The nightly backup. */
  backup: BackupState;
  connections?: ConnectionsState;
  /** Notifications: the switches and the devices. */
  notify: NotifyState;
  /** Settings for the chat as a whole (protocol 14). */
  chat: ChatSettings;
  /** Step 7c (protocol 15): the person's open to-dos, oldest first (the app sorts them). */
  todos: Todo[];
  /**
   * Protocol 24: "About you", the short note about the person every bot gets in its instructions.
   * Written by the person in Settings or by the main bot (change_settings about_you). Empty when none.
   */
  aboutYou: string;
}

export interface Methods {
  /** First call on every connection. The engine refuses a client with a different major protocol. */
  hello: { params: { protocol: number; client: string }; result: { protocol: number; engineVersion: string } };

  /** Everything the app needs to draw its first frame. */
  snapshot: { params: Record<string, never>; result: Snapshot };

  /**
   * Creates a bot folder and its main thread. The first bot becomes the main bot. Only the name is
   * needed. `job` is the text for the "Your job" part of its AGENTS.md. `welcome` (protocol 24, sent
   * by the first-start screen): when the bot made is the main bot, its first turn starts by itself,
   * greets the person and gets to know them. Ignored for any other bot.
   */
  "bot.create": {
    params: { name: string; purpose?: string; job?: string; model?: string; effort?: Effort; fast?: boolean; access?: AccessLevel; look?: BotLook; mayMessage?: string[]; welcome?: boolean };
    result: { bot: Bot };
  };

  /**
   * Changes settings. Takes effect at once, also in the middle of a turn where the harness allows it.
   * A model of the other harness is refused with "conflict" while the bot is in a turn or has helpers
   * working, and with "harness_unavailable" when that harness is not ready. Otherwise the bot's next
   * turn starts in a fresh session on the new harness, with its memory and the last of the chat, as
   * after "bot.startFresh"; a notice in the chat says so. `fast` is taken for any model and takes
   * effect from the bot's next turn, without a new session.
   */
  "bot.update": {
    /**
     * `followUp` (protocol 15, step 7b): the bot's own choice, or null for the Pobots default.
     * `sees` (protocol 16): what the bot sees of the person's own Claude Code setup, or null for everything.
     */
    params: { botId: string; patch: Partial<Pick<Bot, "name" | "purpose" | "model" | "effort" | "fast" | "access" | "look" | "mayMessage" | "maySteer" | "calendar">> & { followUp?: FollowUp | null; sees?: BotSees | null } };
    result: { bot: Bot };
  };

  /**
   * Retires a bot: stops it, moves its folder to the archive and takes it off the roster. Its
   * history stays in the database. The main bot can only be retired when it is the last bot.
   */
  "bot.retire": { params: { botId: string }; result: Record<string, never> };

  /**
   * Asks for a fresh session now. The bot first writes down what matters (a tidy turn), then its
   * next turn starts in a fresh session. Refused with "conflict" while the bot is in a turn or has
   * messages waiting. `started` is false when there is nothing to tidy (no session yet).
   */
  "bot.startFresh": { params: { botId: string }; result: { started: boolean } };

  /** The text files in a bot's folder, job first, then memory, skills and the rest. */
  "bot.files": { params: { botId: string }; result: { files: BotFile[] } };

  /** Reads one file. `rev` names this exact content; send it back when writing. */
  "bot.file.read": { params: { botId: string; path: string }; result: { file: BotFile; text: string; rev: string } };

  /**
   * Writes a file (creating it and its folders when new) and saves the change in the bot's history.
   * With `baseRev`, fails with code "conflict" when the file changed since it was read.
   */
  "bot.file.write": { params: { botId: string; path: string; text: string; baseRev?: string }; result: { file: BotFile; rev: string } };

  /** Removes a file and saves the change. The job (AGENTS.md) cannot be removed. */
  "bot.file.delete": { params: { botId: string; path: string }; result: Record<string, never> };

  /** The saved changes to a bot's folder, newest first. Pass `before` (a change id) to page backwards. */
  /** A bot's artifacts, newest change first. */
  "artifact.list": { params: { botId: string }; result: { artifacts: Artifact[] } };
  /**
   * Where a "page" can be shown right now: a URL on the engine's own origin (a path such as
   * "/page/<key>/index.html"; the desktop window gets a full URL), valid for some hours and for the
   * page's current `rev`. Put it in a frame or open it in a tab; the engine seals it either way.
   * "not_found" for an unknown artifact, "conflict" for a "link" or a page whose file is gone.
   */
  "artifact.open": { params: { botId: string; artifactId: string }; result: { src: string; rev: number } };
  /** Takes an artifact off the bot's list. Its file stays in the bot's folder and a page on Claude stays on Claude. */
  "artifact.remove": { params: { botId: string; artifactId: string }; result: Record<string, never> };

  /** Looks at the browser now (and starts watching it for changes while this connection lives). Never opens the browser app when it is not running: then `spaces` is empty. */
  "browser.state": { params: Record<string, never>; result: BrowserState };
  /**
   * Starts the live picture of one workspace for this connection: "browser.frame" events follow
   * until "browser.unwatch", "browser.ended" or the connection's end. Leave `pageId` out to follow
   * whatever page the workspace shows in front (a page that opens from it is followed); pass it to
   * start on one page, which is then brought to the front (see "browser.page.show"). A connection
   * watches one workspace at a time: a new watch ends the one before (with "browser.ended", reason
   * "replaced"). Watching the front page never changes the page and does not disturb the bot
   * working in it. "not_found" for an unknown workspace or page, "unavailable" when the
   * browser cannot be reached.
   */
  "browser.watch": { params: { spaceId: string; pageId?: string; ratio?: number }; result: { watchId: string; pageId: string; width: number; height: number } };
  "browser.unwatch": { params: { watchId: string }; result: Record<string, never> };
  /**
   * How sharp the pictures of this watch need to be: `ratio` is how many pixels of the viewer's
   * screen one pixel of the page covers as it is drawn (the screen's own pixel ratio times how
   * much the picture is scaled). The engine sends pictures of about that size, within its limits,
   * so that they are drawn without being stretched. Also given to "browser.watch" at the start.
   * Sent again when the panel's size changes.
   */
  "browser.view": { params: { watchId: string; ratio: number }; result: Record<string, never> };
  /**
   * Shows another page of the watched workspace in this watch, without ending it: control is
   * kept. The page is brought to the front in the browser, as a click on its tab would, with or
   * without control: in this browser a page cannot be looked at without coming to the front
   * (found 12 Nov 2026). The watch then follows the front page again, so a bot that goes back to
   * its own page is followed there. `pageId` left out goes back to the front page.
   * "not_found" for a page that is not in the workspace.
   */
  "browser.page.show": { params: { watchId: string; pageId?: string }; result: { pageId: string; width: number; height: number } };
  /** Opens a new page in the watched workspace, at `url` when given, in front, and shows it. Only in the person's own workspace ("conflict" otherwise). Needs control. */
  "browser.page.open": { params: { watchId: string; url?: string }; result: { pageId: string } };
  /** Closes a page of the watched workspace. Only in the person's own workspace ("conflict" otherwise), and never its last page. Needs control. */
  "browser.page.close": { params: { watchId: string; pageId: string }; result: Record<string, never> };
  /**
   * Takes control of the watched workspace, or hands it back. While the person has control their
   * "browser.input" and "browser.go" reach the page; without it both answer "conflict". Taking
   * control does not stop a bot that is working there; the app says so. Control ends by itself when
   * the watch ends.
   */
  "browser.control": { params: { watchId: string; take: boolean }; result: { controlled: boolean } };
  /** What the person did over the picture, in order. Needs control. */
  "browser.input": { params: { watchId: string; events: BrowserInput[] }; result: Record<string, never> };
  /** Moves the watched page: to an address (a bare host gets "https://"), back, forward, or loads it again. Needs control. Only http and https addresses. */
  "browser.go": { params: { watchId: string; to: { url: string } | "back" | "forward" | "reload" }; result: Record<string, never> };
  /** The text selected in the watched page right now, for copying to the person's own clipboard. Needs control. Empty when nothing is selected. */
  "browser.selection": { params: { watchId: string }; result: { text: string } };
  /**
   * Answers what "browser.prompt" showed. A dialog: accept it (with `text` for a prompt) or dismiss
   * it. Choices: the option at `index`, or none (closed without choosing) when left out. Needs
   * control. "conflict" when nothing waits for an answer.
   */
  "browser.answer": {
    params: { watchId: string; answer: { kind: "dialog"; accept: boolean; text?: string } | { kind: "choices"; index?: number } };
    result: Record<string, never>;
  };
  /**
   * The person's own workspace, made when there is none (this may open the browser app). With `url`,
   * its front page goes there. It is where a page on Claude opens beside the chat. Watch it with
   * "browser.watch".
   */
  "browser.own": { params: { url?: string }; result: { space: BrowserSpace } };
  /** Closes the person's own workspace and its pages. "conflict" for a workspace that is not the person's own. */
  "browser.close": { params: { spaceId: string }; result: Record<string, never> };

  "bot.history": { params: { botId: string; before?: string; limit?: number }; result: { changes: BotChange[]; hasMore: boolean } };

  /** One change with what it did, as a unified diff (text files only, cut off when very long). */
  "bot.history.read": { params: { botId: string; changeId: string }; result: { change: BotChange; diff: string } };

  /** Undoes one change by saving a new change that reverses it. Fails with code "conflict" when it cannot be reversed cleanly. */
  "bot.history.undo": { params: { botId: string; changeId: string }; result: { change: BotChange } };

  /** What the person has answered "Always allow" to for this bot. */
  "rule.list": { params: { botId: string }; result: { rules: SavedRule[] } };

  /** Forgets a saved rule. The bot asks again next time. */
  "rule.remove": { params: { ruleId: string }; result: Record<string, never> };

  /** A bot's triggers, in the order they were made. */
  "trigger.list": { params: { botId: string }; result: { triggers: Trigger[] } };

  /**
   * Creates a trigger (no `id`) or changes one. A new webhook gets its address from the engine.
   * `kind` cannot change once made.
   */
  "trigger.save": {
    params: {
      botId: string;
      trigger: { id?: string; kind: "schedule" | "webhook"; name: string; prompt: string; where: "main" | "fresh"; enabled: boolean; schedule?: Schedule };
    };
    result: { trigger: Trigger };
  };

  "trigger.remove": { params: { triggerId: string }; result: Record<string, never> };

  /** Fires a trigger now, whatever its schedule, also when it is switched off. For a webhook, as if called with an empty body. */
  "trigger.run": { params: { triggerId: string }; result: { run: TriggerRun } };

  /** A trigger's runs, newest first. Pass `before` (a run id) to page backwards. */
  "trigger.runs": { params: { triggerId: string; before?: string; limit?: number }; result: { runs: TriggerRun[]; hasMore: boolean } };

  /**
   * A webhook's address: the path to POST to, ending in its secret ("/hook/<id>/<secret>"), and the
   * engine's public base address when one is set ("https://host:10000"), so the app can show an
   * address that works from outside. Works like a password: asked for only when the person wants to
   * see it, never part of an event, never logged.
   */
  "trigger.address": { params: { triggerId: string }; result: { hookPath: string; publicBase?: string } };

  /** Gives a webhook a new address. The old one stops working at once. */
  "trigger.newAddress": { params: { triggerId: string }; result: { hookPath: string; publicBase?: string } };

  /** Switches a trigger on or off without touching anything else about it. */
  "trigger.enable": { params: { triggerId: string; enabled: boolean }; result: { trigger: Trigger } };

  /** A channel with its settings. */
  "channel.get": { params: { channelId: string }; result: { channel: Channel } };

  /**
   * Creates a channel (no `id`) or changes one. Only the fields given change. `replyUrl` is
   * write-only: give a new one to replace it, an empty string to remove it.
   */
  "channel.save": {
    params: { channel: { id?: string; name?: string; enabled?: boolean; allowedSenders?: string[]; routes?: ChannelRoute[]; contextCount?: number; replyUrl?: string; mayPost?: string[] } };
    result: { channel: Channel };
  };

  "channel.remove": { params: { channelId: string }; result: Record<string, never> };

  /** A channel's address, as for a webhook: asked for only when the person wants to see it. */
  "channel.address": { params: { channelId: string }; result: { hookPath: string; publicBase?: string } };

  /** Gives a channel a new address. The old one stops working at once. */
  "channel.newAddress": { params: { channelId: string }; result: { hookPath: string; publicBase?: string } };

  /** What came in on a channel, newest first. Pass `before` (a message id) to page backwards. */
  "channel.messages": { params: { channelId: string; before?: string; limit?: number }; result: { messages: ChannelMessage[]; hasMore: boolean } };

  /** Reads a thread, newest last. Pass `before` (a seq) to page backwards. */
  "thread.read": {
    params: { threadId: string; before?: number; limit?: number };
    result: { items: Item[]; hasMore: boolean };
  };

  /**
   * Sends a message to a bot's thread (its main thread when threadId is left out). While the bot is in
   * a turn in that thread, `mode` "steer" puts it into the running turn (UserItem.steered) and "queue"
   * lets it wait for the turn to end (UserItem.queued); left out, the person's setting decides
   * (ChatSettings.followUp). A steer the harness cannot take now (the turn is ending, a tidy turn, a
   * fresh run in another thread, a Stop that holds) waits in line instead; it is never lost and never
   * sent twice.
   */
  /**
   * `attachments` are ids of uploads made for the same bot, at most ATTACHMENTS_PER_MESSAGE ("too_many"
   * above that, "not_found" for an id that is not an unsent upload of this bot). The text may be empty
   * when there is at least one attachment.
   */
  "message.send": { params: { botId: string; threadId?: string; text: string; attachments?: string[]; mode?: FollowUp }; result: { item: UserItem } };

  /**
   * Steers a queued message from the person now: it leaves the line and goes into the bot's running
   * turn. `steered` is false when that cannot be done now (the bot is not in a turn it can take it
   * in); the message then simply stays queued. "not_found" for an item that is not a queued message
   * from the person to this bot.
   */
  "message.steer": { params: { botId: string; itemId: string }; result: { steered: boolean } };

  /** Changes the chat settings, saved in config.json. Answers with all of them. */
  "chat.set": { params: { followUp: FollowUp }; result: { chat: ChatSettings } };

  /**
   * Protocol 24: writes "About you" (the whole text; empty clears it). Trimmed; at most 4,000
   * characters, more is refused with "bad_request". Every bot's session starts again between turns
   * so its next turn has the new text. Answers with the text as kept.
   */
  "aboutYou.set": { params: { text: string }; result: { aboutYou: string } };

  /** Throws away an upload that was not sent (the person removed it from the box). No error when it is already gone. */
  "attachment.discard": { params: { id: string }; result: Record<string, never> };

  /**
   * Stops one running helper. `itemId` is the helper item's id. The bot is told by its harness that
   * the helper was stopped and carries on. "not_found" for an unknown item; no error when the
   * helper has already ended.
   */
  "helper.stop": { params: { botId: string; itemId: string }; result: Record<string, never> };

  /** Stops the bot's current turn and every helper of the bot that is still working. Works too when only helpers are working. Queued messages stay queued. */
  "turn.interrupt": { params: { botId: string }; result: Record<string, never> };

  /** Answers a card. The card is removed with a "card.removed" event. */
  "card.resolve": { params: { cardId: string; decision: CardDecision }; result: Record<string, never> };

  /** Saves a 1Password reference. An empty string clears it. */
  "backup.setPasswordRef": { params: { passwordRef: string }; result: { backup: BackupState } };
  "connection.list": { params: Record<string, never>; result: ConnectionsState };
  "connection.set": { params: ConnectionChange; result: ConnectionChangeResult };
  /** Starts a backup now; changes arrive with "backup.changed". */
  "backup.run": { params: Record<string, never>; result: { backup: BackupState } };

  /** Switches kinds of notification on or off, for all devices. Saved with the settings. */
  "notify.setKinds": { params: { kinds: Partial<Record<NotifyKind, boolean>> }; result: { notify: NotifyState } };
  /**
   * Keeps this browser's push subscription. `asked`: true when the person pressed "Turn on" (adds
   * the device, or updates it, or puts its fresh address in place of the device named in
   * `replaces`; a device marked gone works again only this way, with a fresh subscription from the
   * browser); false when the page says on opening that it is still there. That only updates a
   * device the engine knows and that is not gone, or puts a new address in place of the device
   * named in `replaces` when that device is gone; naming a device that works is refused with
   * "conflict" and changes nothing. An unknown one is refused with "not_found", so a device
   * forgotten elsewhere does not come back by itself. An address the push service called gone is
   * refused with "conflict" by every way in, asked or not, also after its device was replaced or
   * forgotten, so a dead device never reads as on. Refuses an address that is not one of the four
   * push services ("bad_request", in one plain sentence) and one device too many ("too_many"). The
   * address and keys are never sent back.
   */
  "notify.subscribe": {
    params: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; label: string; asked: boolean; replaces?: string };
    result: { deviceId: string; notify: NotifyState };
  };
  /** Forgets a device. Its browser may keep its subscription, but nothing is sent to it. */
  "notify.forget": { params: { deviceId: string }; result: { notify: NotifyState } };
  /** Sends the test notification to one device now, whatever the switches say and whoever is looking. Answers when the push service has answered (at most about 15 seconds). */
  "notify.test": { params: { deviceId: string }; result: { notify: NotifyState } };
  /**
   * Whether this window is seen and used, for deciding who gets a notification. `visible`: the page
   * is shown. `focused`: it is the window in front. `idleMs`: how long ago the last key, pointer or
   * touch came in this window, in milliseconds, or null when none came since it opened; the engine
   * counts NOTIFY_QUIET_AFTER_USE_MS from that moment, never from when this was sent. `deviceId`:
   * this browser's own device, when notifications are on here. Sent on connect, when `visible` or
   * `focused` changes, on use at most once a minute, and every NOTIFY_PRESENCE_EVERY_MS while
   * visible. Nothing is broadcast.
   */
  "notify.presence": { params: { deviceId?: string; visible: boolean; focused: boolean; idleMs: number | null }; result: Record<string, never> };
  // ---- step 7c (protocol 15): to-dos for the person
  /**
   * The person acts on a to-do: pressed one of its buttons (`buttonId`) and/or filled its fields
   * (`values`, by field id). The bot is woken in its main chat with what he chose and typed, as his
   * own message (`from: { type: "you", todo }`). The to-do is then done ("todo.removed", reason
   * "answered"), unless the bot keeps it open ("todo.changed" with `answer`).
   */
  "todo.answer": { params: { todoId: string; buttonId?: string; values?: Record<string, string> }; result: Record<string, never> };
  /** The person marks a to-do done or dismisses it himself. The bot hears of it at its next turn. */
  "todo.close": { params: { todoId: string; how: "done" | "dismissed" }; result: Record<string, never> };
}

export type MethodName = keyof Methods;

// ---------------------------------------------------------------- events

export interface Events {
  /** A bot changed: state, activity, settings. Always the whole bot. */
  "bot.updated": { bot: Bot };
  /** A bot was added to the roster. */
  "bot.added": { bot: Bot };
  /** A bot was retired and left the roster. Its cards are withdrawn with "card.removed". */
  "bot.removed": { botId: string };
  "connection.changed": ConnectionsState;
  /** The nightly backup changed: a reference was saved, a run began or ended. Always the whole state. */
  "backup.changed": { backup: BackupState };
  /** Notifications changed: a switch, a device, or a send was recorded. Always the whole state. */
  "notify.changed": { notify: NotifyState };
  /** The chat settings changed (protocol 14). Always all of them. */
  "chat.changed": { chat: ChatSettings };
  /** Protocol 24: "About you" changed, from the window or the main bot. */
  "aboutYou.changed": { aboutYou: string };
  /** Files in a bot's folder changed and the change was saved. `by` says who: you in the app, the bot in a turn, or the app (an undo). */
  "bot.files.changed": { botId: string; paths: string[]; by: "you" | "bot" | "app" };
  /** An artifact was made or changed (the whole artifact), or taken off the list (`removedId`). */
  "artifact.changed": { botId: string; artifact?: Artifact; removedId?: string };
  /** What is open in the browser changed. Always the whole state. Sent to connections that asked "browser.state" or watch a workspace, and to all when a bot starts or ends browser work. */
  "browser.changed": { state: BrowserState };
  /**
   * One picture of the watched page, as base64: a JPEG, or another format a browser draws, named
   * in `type` ("image/jpeg" when left out). `width` and `height` are the page's own size in its
   * pixels (the picture itself may be smaller or larger; scale positions for "browser.input" to
   * these). A page that stands still gets one more picture after a moment, of the best quality.
   * `pageId`, `url` and `title` say which page it shows. Only the newest matters: the engine never
   * lets more than one picture wait for a connection, and drops older ones.
   */
  "browser.frame": { watchId: string; seq: number; data: string; type?: string; width: number; height: number; pageId: string; url: string; title: string };
  /**
   * The watched page shows something outside its picture (see BrowserPrompt), or, with `prompt`
   * left out, no longer does. Sent again to a connection that starts watching while one waits.
   */
  "browser.prompt": { watchId: string; prompt?: BrowserPrompt };
  /** The watch is over: the workspace was closed ("closed"), the browser went away ("gone"), or this connection started another watch ("replaced"). */
  "browser.ended": { watchId: string; reason: "closed" | "gone" | "replaced" };
  /** A bot's saved rules changed: one was added by "Always allow", or one was forgotten. Read them again with "rule.list". */
  "rules.changed": { botId: string };
  /** A trigger was made or changed (the whole trigger), or removed (`removedId`). */
  "trigger.changed": { botId: string; trigger?: Trigger; removedId?: string };
  /** A run started or changed. Always the whole run. */
  "trigger.run": { run: TriggerRun };
  /** The list of coming runs changed. Always the whole list. */
  "upcoming.updated": { upcoming: Upcoming[] };
  /** A channel was made or changed (the whole channel), or removed (`removedId`). */
  "channel.changed": { channel?: Channel; removedId?: string };
  /** A message came in on a channel, or its outcome changed. Always the whole record. */
  "channel.message": { message: ChannelMessage };
  /** A new item, or a changed one (same id). Always the whole item. */
  "item.upsert": { item: Item };
  /** More text for a streaming bot item. Append to its text. */
  "item.delta": { threadId: string; itemId: string; textDelta: string };
  "card.added": { card: Card };
  "card.removed": { cardId: string; reason: "resolved" | "expired" | "withdrawn" };
  /** Step 7c (protocol 15): a to-do was added or changed. Always the whole to-do; always an open one. */
  "todo.changed": { todo: Todo };
  /**
   * Step 7c (protocol 15): a to-do left the list: answered (a button or fields), marked done or
   * dismissed by the person, removed by its bot, or its bot was retired.
   */
  "todo.removed": { todoId: string; reason: "answered" | "done" | "dismissed" | "removed" | "retired" };
  /** `models` is the whole model list as it is now, sent along when a harness became ready or stopped being ready. */
  "status.updated": { status: EngineStatus; models?: ModelInfo[] };
}

export type EventName = keyof Events;

// ---------------------------------------------------------------- step 7b: settings, providers, usage, chat titles (protocol 15)
//
// The settings window (General, Chats, Providers, Usage), the update button for the harnesses, the
// usage meters and the titles of chats. Interfaces below add to Snapshot, Methods and Events.

/** A program that drives bots' models on the engine's machine. Today the two harnesses. */
export type ProviderId = Harness;

/**
 * When the working session behind a bot's main chat is started fresh, for the bots of one provider
 * (docs/context.md). The same rules as `context` in config.json, per provider.
 */
export interface ChatTiming {
  /** Fresh starts on or off. */
  enabled: boolean;
  /** A session smaller than this (tokens) is not worth a fresh start before the cache goes cold or after a long quiet. */
  minTokens: number;
  /** Right after a turn, a session holding at least this share of the model's window starts fresh at once. */
  fullFraction: number;
  /** The same in tokens, whichever comes first. */
  fullTokens: number;
  /** How many minutes before the cache goes cold the fresh start begins. Claude only: Codex has no cache clock. */
  warmMarginMinutes: number;
  /** A session not used for this many hours starts fresh, cache or not. */
  coldHours: number;
  /**
   * The size (tokens) at which the provider's own program shortens a conversation by itself in the
   * middle of work: Claude Code's and Codex's own summarising, not Pobots'. It is what a helper
   * works under, and a bot itself in one very long turn. Used by sessions started after a change.
   */
  compactTokens: number;
}

export type ChatTimingKey = keyof ChatTiming;

/** A usage hub: another place that knows the plans' limits, such as a CLIProxyAPI server. Its key never leaves the engine. */
export interface UsageHub {
  id: string;
  kind: "cliproxy";
  /** The hub's address as entered, cleaned: "https://host:8443". */
  url: string;
  addedAt: string;
  /** How its key is kept: saved on the Mac, or read from 1Password (an op:// reference) when used. */
  keyKind: "saved" | "1password";
}

/** The settings of the settings window that are not elsewhere in the snapshot. */
export interface PobotsSettings {
  /** The fresh-start timing in use, per provider. */
  timing: Record<ProviderId, ChatTiming>;
  /** What each value goes back to on reset: the setting for all providers in config.json, else Pobots' own default. */
  timingDefaults: Record<ProviderId, ChatTiming>;
  /** Which values of each provider are set apart from the default. */
  timingSet: Record<ProviderId, ChatTimingKey[]>;
  /** How often Pobots looks at the providers (version, signed in, latest version), in seconds. 0: never by itself. */
  healthCheckSeconds: number;
  /** The model that names chats (a ModelInfo id of a Claude model). */
  titleModel: string;
  /** Which providers are on. A provider can be switched off only while no bot runs on it. */
  providers: Record<ProviderId, { enabled: boolean }>;
  /** Usage hubs, in the order added. */
  hubs: UsageHub[];
}

/** A change to PobotsSettings. A timing value of null goes back to its default. */
export interface SettingsPatch {
  timing?: Partial<Record<ProviderId, Partial<{ [K in ChatTimingKey]: ChatTiming[K] | null }>>>;
  healthCheckSeconds?: number;
  titleModel?: string;
  providers?: Partial<Record<ProviderId, { enabled: boolean }>>;
}

/** One provider as Pobots last looked at it. */
export interface ProviderState {
  id: ProviderId;
  /** "Claude Code", "Codex". */
  label: string;
  enabled: boolean;
  /** Found on the machine. */
  installed: boolean;
  /** Bots can use it now. */
  ready: boolean;
  version?: string;
  /** The newest version its install channel offers, when it could be read. */
  latest?: string;
  /** True when `latest` is newer than `version` and Pobots can update it. */
  updateAvailable: boolean;
  /** Signed in, when Pobots could tell. */
  signedIn?: boolean;
  /** The program Pobots runs. */
  executable?: string;
  /** How it was installed, which decides how it is updated. */
  installedBy: "native" | "npm" | "homebrew" | "other" | "none";
  /** One plain sentence when something is wrong. */
  problem?: string;
}

/** An update of the providers from the update button. */
export interface ProviderUpdateRun {
  startedAt: string;
  endedAt?: string;
  /** waiting: for the bots to be calm. updating: the commands run. restarting: the bots' harness processes are closed. */
  phase: "waiting" | "updating" | "restarting" | "done" | "failed";
  /** One plain line about now or the end: "Waiting for Po to finish.", "Codex updated to 0.169.0." */
  line: string;
  results: { provider: ProviderId; from?: string; to?: string; outcome: "updated" | "current" | "failed" | "skipped"; problem?: string }[];
}

export interface ProvidersState {
  /** The machine they are on. */
  machine: string;
  providers: ProviderState[];
  /** When Pobots last looked. */
  checkedAt?: string;
  checking: boolean;
  /** The running update, or the last one since the engine started. */
  update: ProviderUpdateRun | null;
  /**
   * Pobots itself, only on an install run from a clone of the public repository (protocol 25).
   * Absent everywhere else, and then nothing about it shows.
   */
  pobots?: PobotsUpdateState;
}

/** A self-update of Pobots from the update button (protocol 25). */
export interface PobotsUpdateRun {
  startedAt: string;
  endedAt?: string;
  /**
   * waiting: for the bots to be calm. pulling: the new code is fetched into the folder. installing:
   * packages. building: the new build, beside the running one. restarting: handed over to the job that
   * swaps the build in and starts Pobots again. done / failed: the end.
   */
  phase: "waiting" | "pulling" | "installing" | "building" | "restarting" | "done" | "failed";
  /** One plain line: "Building Pobots 0.34.1.", "Pobots updated to 0.34.1.". */
  line: string;
  from: string;
  to?: string;
}

/** Pobots's own version on a public install (protocol 25). */
export interface PobotsUpdateState {
  /** The running version. */
  current: string;
  /** The newest version on the public repository's main branch, when it was read. */
  latest?: string;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  checkedAt?: string;
  /** False when Pobots was started in a way it cannot restart itself (then the button says so). */
  canRestart: boolean;
  /** One plain sentence when the last look or the folder has a problem. Calm, never red. */
  problem?: string;
  /** The running update, or the last one (also the one before the restart, read back after it). */
  run: PobotsUpdateRun | null;
}

/** One limit window of one account. */
export interface UsageWindow {
  /** Stable across readings and accounts: "five_hour", "seven_day", "seven_day_fable", "monthly_spend", "primary", "secondary". */
  id: string;
  kind: "session" | "weekly" | "monthly";
  /** "Session", "Weekly", "Weekly · Fable", "Monthly spend". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  resetsAt?: string;
}

export interface UsageAccount {
  id: string;
  /** The account's email, when the source tells. Shown only as two letters on the bar, in full on hover. */
  email?: string;
  plan?: string;
  /** Where the reading came from: "This Mac", or the hub's host. */
  via: string;
  windows: UsageWindow[];
  /** One plain sentence when this account could not be read. */
  problem?: string;
}

export interface UsageProvider {
  id: string;
  label: string;
  accounts: UsageAccount[];
}

export interface UsageState {
  /** "hub" when a usage hub is added (its accounts), else "providers" (Claude and Codex on this Mac). */
  source: "hub" | "providers";
  providers: UsageProvider[];
  checkedAt?: string;
  reading: boolean;
  /** One plain sentence when nothing could be read. */
  problem?: string;
}

/**
 * A chat with its title: one session of a bot's main chat (between two fresh starts; `fromSeq` and
 * `toSeq` give its place, `toSeq` absent while it goes on), a fresh run's thread or a helper's thread.
 */
export interface ChatTitle {
  threadId: string;
  kind: "main" | "run" | "helper";
  fromSeq: number;
  toSeq?: number;
  title: string;
  /** When the chat began and, when it is over, when it ended. */
  startedAt: string;
  endedAt?: string;
}

export interface Snapshot {
  /** Step 7b (protocol 15). */
  settings: PobotsSettings;
  providers: ProvidersState;
}

export interface Methods {
  /** Changes settings of the settings window. Answers with all of them. "conflict" when a provider is switched off while a bot runs on it. */
  "settings.set": { params: { patch: SettingsPatch }; result: { settings: PobotsSettings } };
  /** Looks at the providers now (version, signed in, latest version). */
  "providers.check": { params: Record<string, never>; result: { providers: ProvidersState } };
  /**
   * Updates every provider that has an update: waits until every bot is calm, runs the update, then
   * closes the bots' harness processes so their next turn starts the new version. Answers at once;
   * "providers.changed" follows. "conflict" while one runs.
   */
  "providers.update": { params: Record<string, never>; result: { providers: ProvidersState } };
  /** The usage meters. `refresh`: read again now, else the last reading when it is fresh enough. */
  "usage.read": { params: { refresh?: boolean }; result: { usage: UsageState } };
  /** Local harness history, grouped for Settings > Usage. A cold scan can return reading with no figures yet. */
  "usage.overview": { params: { range: UsageRange; refresh?: boolean }; result: UsageOverviewRead };
  /** Adds a CLIProxyAPI hub: its address and its management key (or an op:// reference to it). The key is never sent back. */
  "usage.hub.add": { params: { url: string; key: string }; result: { settings: PobotsSettings } };
  "usage.hub.remove": { params: { id: string }; result: { settings: PobotsSettings } };
  /** A bot's titled chats, newest first. `before`: an ISO time, to page backwards. */
  "chat.titles": { params: { botId: string; before?: string; limit?: number }; result: { chats: ChatTitle[]; hasMore: boolean } };
}

export interface Events {
  "settings.changed": { settings: PobotsSettings };
  "providers.changed": { providers: ProvidersState };
  "usage.changed": { usage: UsageState };
  /** A chat of the bot got a title or a new one. */
  "chat.titled": { botId: string; chat: ChatTitle };
}

// ---------------------------------------------------------------- wire frames

export interface RequestFrame<M extends MethodName = MethodName> {
  t: "req";
  id: string;
  method: M;
  params: Methods[M]["params"];
}

export interface ErrorBody {
  /** Stable machine code: "bad_request", "not_found", "conflict", "protocol_mismatch", "harness_unavailable", "unavailable" (the browser cannot be reached), "too_large", "unsupported", "too_many" (attachments), "internal". */
  code: string;
  /** One plain sentence that can be shown to the person. */
  message: string;
}

export type ResponseFrame<M extends MethodName = MethodName> =
  | { t: "res"; id: string; ok: true; result: Methods[M]["result"] }
  | { t: "res"; id: string; ok: false; error: ErrorBody };

export interface EventFrame<E extends EventName = EventName> {
  t: "evt";
  event: E;
  data: Events[E];
}

export type ServerFrame = ResponseFrame | EventFrame;

/** The line the engine prints to stdout once it is listening. */
export interface EngineAnnouncement {
  pobotsEngine: { port: number; token: string };
}

/** What the desktop shell hands to the UI through `window.pobots`. */
export interface EngineEndpoint {
  url: string;
  /** The local token. Left out by a page that connects to its own origin. */
  token?: string;
}

/** `GET /api/whoami`: may this page open the engine's socket, and if not, why, in plain words. */
export interface WhoAmI {
  allowed: boolean;
  via: "local" | "tailscale" | "none";
  /** One plain sentence for the person when not allowed. */
  message?: string;
}

/** `<dataDir>/engine.json`, written by a running engine (mode 0600). Holds the token: never log it. */
export interface EngineLock {
  pid: number;
  port: number;
  token: string;
  serve: boolean;
  /** ISO 8601 time. */
  startedAt: string;
}

// ---------------------------------------------------------------- shared constants

export const ACCESS_LEVELS: { id: AccessLevel; label: string; hint: string }[] = [
  { id: "asks-first", label: "Asks first", hint: "Asks before every action that changes something, except notes in its own memory." },
  { id: "edits-freely", label: "Edits freely", hint: "Edits files in its own folder without asking. Asks for the rest." },
  { id: "decides-itself", label: "Decides itself", hint: "Decides what is safe to do. Asks when unsure." },
  { id: "full-access", label: "Full access", hint: "Does everything without asking." },
];

export const EYE_SHAPES: EyeShape[] = ["round", "tall", "wide", "square"];
export const EYE_GAPS: EyeGap[] = ["mid", "near", "far"];

// ---------------------------------------------------------------- job 7, the chat (protocol 15, step 7a)
// Added for docs/build/step-7a.md. The interfaces below merge with the ones of the same name above.

/**
 * A bot's colour: the pebble of its face takes it, everywhere the face shows. One of a small palette
 * in the design system (tokens `pebble-<colour>`), each readable in light and dark with the eyes on it.
 */
export type BotColor = "grey" | "sky" | "teal" | "moss" | "sand" | "copper" | "rose" | "lilac";

/** The palette, in the order the pickers show it. "grey" is the old face, the colour of a bot without one. */
export const BOT_COLORS: BotColor[] = ["grey", "sky", "teal", "moss", "sand", "copper", "rose", "lilac"];

export interface BotLook {
  /**
   * The colour of the face. The engine gives every bot one (a new bot one no other bot has, while
   * the palette lasts; an older bot without one gets one once, saved in its bot.json). Absent only
   * from an older engine: the app then shows grey.
   */
  color?: BotColor;
}

/** One step of a bot's own to-do list. */
export interface PlanStep {
  text: string;
  status: "pending" | "inProgress" | "completed";
}

/**
 * The to-do list the bot keeps with its harness's own tool while it works: Claude's task tools
 * (TaskCreate, TaskUpdate, TaskList) or TodoWrite, Codex's plan (turn/plan/updated). The newest state,
 * kept by the engine (also over a restart) until the bot's session starts fresh.
 */
export interface BotPlan {
  steps: PlanStep[];
  /** Codex's own few words about the plan, when it gave some. */
  explanation?: string;
  /** When the list last changed, ISO 8601. */
  updatedAt: string;
  /** The turn in which it last changed. */
  turnId?: string;
}

export interface Bot {
  /** The bot's to-do list, when it keeps one (see BotPlan). Absent when it has none. */
  plan?: BotPlan;
}

/**
 * What kind of work a line of work stands for, for its icon and for how a group of lines is summed
 * up ("Ran 3 commands"). "think" is a thinking summary: its label is the summary's first line and its
 * detail the whole summary. Absent on lines from before protocol 15: the app reads the kind from the
 * label then, or shows the plain mark.
 */
export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "think" | "plan" | "message" | "skill" | "other";

export interface ActivityItem {
  tool?: ToolKind;
}

export interface HelperItem {
  /**
   * The harness the helper runs on, for the provider's mark on its row. Set by the engine on helpers
   * started since protocol 15; for older ones the app reads it from `model`, or shows the plain arrow.
   */
  harness?: Harness;
}

export interface Methods {
  /**
   * Takes a waiting message of the person's out of the line before the bot has read it. The item is
   * removed from the thread ("item.removed"). Refused with not_found when it is no longer waiting.
   */
  "message.unqueue": { params: { botId: string; itemId: string }; result: Record<string, never> };
  /**
   * The messages of a thread that wait for the bot, oldest first, wherever they stand: the app shows
   * them above the message box, also when they are older than the page of the thread it has read.
   */
  "thread.queued": { params: { threadId: string }; result: { items: UserItem[] } };
}

export interface Events {
  /** An item is gone from a thread: a waiting message the person removed. */
  "item.removed": { threadId: string; itemId: string };
}
// ---------------------------------------------------------------- step 7c (protocol 15): to-dos for the person

/**
 * A to-do a bot puts on the person's list: something he must do or decide that can wait, such as an
 * email to send to a customer once the work is done, or input on a customer task. It stands in "Your
 * to-do" at the bottom of the right rail; a click opens a modal that Pobots draws from `blocks` and
 * `buttons` (never HTML from the bot). It is not a card: nothing expires and nothing waits in a turn.
 */
export interface Todo {
  /** "todo_" and random letters. */
  id: string;
  botId: string;
  /** Short: "Send the Nordvik summary". */
  title: string;
  /** One line on why: "The import is done; the customer waits for the summary." */
  why?: string;
  /** When the bot made it. */
  at: string;
  /** When it last changed. */
  updatedAt: string;
  /** By when, as the bot said it: a day "2026-11-20", or a day and a time "2026-11-20T15:00" (the engine's time zone). */
  due?: string;
  blocks: TodoBlock[];
  /** The bot's buttons, in order. Pressing one sends what the fields hold with it. */
  buttons: TodoButton[];
  /** True when an answer does not end it: the bot updates or removes it itself. */
  keepOpen: boolean;
  /** The person's last answer, while the to-do stays open (keepOpen). */
  answer?: { at: string; buttonId?: string; label?: string };
}

export interface TodoButton {
  id: string;
  label: string;
  /** The one to press first; drawn as the primary button. At most one. */
  primary?: boolean;
}

/**
 * One part of a to-do's modal. "file" names a file in the bot's folder; the engine serves it at
 * GET /api/todos/<todoId>/files/<index of the block> (the same rule as /api/attachments): a checked
 * picture inline, anything else as a download. "page" is one of the bot's artifacts (a page in its
 * folder), opened beside the chat.
 */
export type TodoBlock =
  /** Markdown, as a bot's message. */
  | { type: "text"; text: string }
  | { type: "facts"; facts: { label: string; value: string }[] }
  /** An https or mailto link. */
  | { type: "link"; label: string; url: string }
  /** A text to copy, such as an email draft, with a Copy button. */
  | { type: "copy"; label?: string; text: string }
  /** `picture`: a checked picture shown in a box of fixed height. `missing`: the file is gone from the bot's folder. */
  | { type: "file"; path: string; name: string; picture: boolean; size?: number; missing?: boolean }
  | { type: "page"; artifact: Artifact }
  /** A field the person fills. Its value goes to the bot by `id` with the button pressed. */
  | { type: "field"; id: string; label: string; input: "short" | "long" | "choice"; choices?: string[]; placeholder?: string; value?: string };

/** At most this many open to-dos per bot, and this many blocks and buttons in one. */
export const TODOS_PER_BOT = 50;
export const TODO_BLOCKS_MAX = 30;
export const TODO_BUTTONS_MAX = 4;

// ---------------------------------------------------------------- what a bot sees (protocol 16)

/**
 * What a bot sees of the person's own Claude Code setup (docs/sees.md). Absent: everything, as Claude
 * Code has it. Each part is "the rest, and the exceptions", so that something added to the Mac later
 * falls on the side of "the rest" by itself. Each part may be absent (that part: everything). Names
 * that do not exist on the Mac are kept and ignored. A GPT bot's Codex session follows it as far as
 * Codex allows: servers by name, Codex's plugins and apps as a whole, skills unchanged (engine 0.26.2).
 */
export interface BotSees {
  /** Connected services, by the name Claude Code gives them, such as "claude.ai Notion". Pobots' own tools are never off. */
  services?: { rest: "on" | "off"; except: string[] };
  /** Plugins, by id, such as "design@synced". A plugin that is off takes its skills and its services with it. */
  plugins?: { rest: "on" | "off"; except: string[] };
  /** Skills that are not a plugin's, by name. "name": listed by name only; the bot can still open it. */
  skills?: { rest: "full" | "name"; except: string[] };
}

export interface Bot {
  /** Protocol 16: the bot's choice of what it sees (BotSees). Absent: everything. */
  sees?: BotSees;
}

/** Where a service, a skill or a plugin's part comes from, for the window's words. */
export type SeesFrom = "claude.ai" | "mac" | "plugin" | "built-in" | "bot" | "other";

/** A connected service as one read saw it. */
export interface SeesService {
  /** Claude Code's name, the one a choice uses, such as "claude.ai Notion". */
  name: string;
  /** For people, such as "Notion". */
  label: string;
  from: SeesFrom;
  /** The plugin's id, when it comes from a plugin. */
  plugin?: string;
  state: "connected" | "needs-sign-in" | "failed" | "off";
  tools: number;
  /** About how many tokens it puts into every step: its tool names and its instructions. 0 when not connected. */
  tokens: number;
}

export interface SeesPlugin {
  /** Such as "design@synced". */
  id: string;
  name: string;
  skills: number;
  services: number;
  /** Its skills in full and its connected services, about. */
  tokens: number;
}

/** A skill that is not a plugin's. `from`: "built-in" (Claude Code's own), "mac", "claude.ai" (synced), "bot" (the bot's own folder). */
export interface SeesSkill {
  name: string;
  from: SeesFrom;
  /** In full, about. */
  tokens: number;
  /** By name only, about. */
  nameTokens: number;
}

/** A ready-made starting point for a choice. `sees` null: everything. */
export interface SeesSet {
  id: string;
  name: string;
  hint: string;
  sees: BotSees | null;
}

/** What exists for a bot's folder, read without a model call (sees.inventory). */
export interface SeesInventory {
  services: SeesService[];
  plugins: SeesPlugin[];
  skills: SeesSkill[];
  sets: SeesSet[];
  /** When it was read, ISO 8601. */
  readAt: string;
}

export interface Methods {
  /**
   * Protocol 16: what exists for this bot and what each thing costs. Read with a short session that
   * sends no message, kept for some minutes; `refresh` reads again. A read that fails is not an error:
   * `problem` says so in plain words, with the last good read when there is one.
   */
  "sees.inventory": { params: { botId: string; refresh?: boolean }; result: { inventory: SeesInventory | null; problem?: string } };
}

// ---------------------------------------------------------------- protocol 20: calendar tools (16 Nov 2026)

/**
 * The connection to the person's own Outlook calendar: a Power Automate flow, called at an address
 * the person sets once in the settings window. The address is a secret and is never sent back.
 */
export interface Snapshot {
  /** The calendar tools (protocol 20): the connection, so a bot's Settings tab knows it at once. */
  calendar: CalendarState;
}

export interface CalendarState {
  /** True when the flow's address is set. */
  connected: boolean;
  /** The mailbox the flow acts for, from the last good check. */
  mailbox?: { name?: string; address: string };
  /** When the connection was last checked, ISO 8601. */
  checkedAt?: string;
  /** What the last check found wrong, in plain words. Absent when it went well. */
  problem?: string;
  /** The email domains of people inside the company, whose free times are checked. */
  internalDomains: string[];
  /** True when the person set the domains; false when they come from the mailbox's own domain. */
  domainsSet: boolean;
}

/** Someone in a meeting on an approval card. */
export interface CardAttendee {
  name?: string;
  address: string;
  /** Inside the company (an internal domain): free times are checked. Outside: the agreed time is used. */
  internal: boolean;
  /** For internal people: free at that time (true), or could not be checked (absent). */
  free?: boolean;
  optional?: boolean;
}

/** What a calendar tool waits to do (ApprovalCard.meeting). Times are ISO 8601. */
export interface CardMeeting {
  action: "create" | "move" | "cancel" | "respond";
  subject: string;
  start: string;
  end: string;
  /** For a move: the time it has now. */
  was?: { start: string; end: string };
  /** The time zone the times are shown in, such as Europe/Stockholm. */
  timeZone: string;
  /** Everyone in it besides the person. */
  attendees: CardAttendee[];
  /** Who sent the invitation, for an answer. */
  organizer?: string;
  /** True when it is (or will be) a Teams meeting. */
  teams: boolean;
  /** For an answer to an invitation. */
  response?: "accept" | "tentative" | "decline";
  /** The meeting's text (a new one), or the message to the others (a cancel or an answer). */
  message?: string;
  /** What else the person has at that time, when something clashes in their own calendar. */
  ownClash?: string;
}

export interface Methods {
  /** The calendar connection as it stands. */
  "calendar.get": { params: Record<string, never>; result: { calendar: CalendarState } };
  /**
   * Sets the flow's address ("" removes it; a new one is checked at once) and the internal domains
   * ([] goes back to the mailbox's own domain). Only what is given changes.
   */
  "calendar.set": { params: { address?: string; internalDomains?: string[] }; result: { calendar: CalendarState } };
  /** Checks the connection now: asks the flow which mailbox it acts for. */
  "calendar.test": { params: Record<string, never>; result: { calendar: CalendarState } };
}

export interface Events {
  "calendar.changed": { calendar: CalendarState };
}

// ---------------------------------------------------------------- protocol 21: task managers (docs/build/step-task-managers.md)

/**
 * What a bot gives a task manager to use. "workers": start_helper, read_helper, steer_helper and
 * stop_helper for workers of its own. "todos": the to-do tools. "browser": it is told how to use
 * the browser. The others are the bot tools of the same name.
 */
export type TaskManagerTool = "workers" | "ask_human" | "notify_human" | "todos" | "message_bot" | "show_artifact" | "browser";

/** All of them, in the order the window shows them. */
export const TASK_MANAGER_TOOLS: TaskManagerTool[] = ["workers", "ask_human", "notify_human", "todos", "message_bot", "show_artifact", "browser"];

/**
 * A task manager: a helper a bot starts for one long task, which runs workers of its own and may
 * ask the person (engine 0.26.0). Not a bot: no entry in the bots list, no folder, no memory. Its
 * row stands in the chat where the bot started it (a HelperItem with `taskManager`), its own thread
 * is `managerThreadId`, and it stays until its bot ends it or the person does. The window lists the
 * bot's task managers in "Task managers" in the right rail.
 */
export interface TaskManagerInfo {
  /** The id of its row (a helper item). */
  id: string;
  /** Where its row stands. */
  threadId: string;
  /** Its own thread: the task, what it said and did, its workers' rows, the person's messages. */
  managerThreadId: string;
  title: string;
  harness: Harness;
  model: string;
  effort?: Effort;
  /** When it started (ISO). */
  startedAt: string;
  /** "working": a turn of it runs or its workers work. "waiting": a card of it waits for the person. "resting": done for now; it waits for a message. */
  state: "working" | "waiting" | "resting";
  /** How many of its workers work now. */
  workersNow: number;
  /** The most workers it may run at once (1 to 6). */
  maxWorkers: number;
  tools: TaskManagerTool[];
  /** The names of the bots it may message besides its own bot. */
  mayMessage: string[];
  /** The folder it and its workers work in, when it is not the bot's own. */
  folder?: string;
}

export interface Bot {
  /** Protocol 21: the bot's task managers that have not been ended, in the order they started. Absent when none. */
  taskManagers?: TaskManagerInfo[];
}

export interface HelperItem {
  /**
   * Protocol 21: set on the row of a task manager. Its settings, and `state` as on TaskManagerInfo
   * or "ended" once its bot or the person ended it. The row's `status` is "running" while it works.
   */
  taskManager?: { maxWorkers: number; tools: TaskManagerTool[]; mayMessage: string[]; folder?: string; state: TaskManagerInfo["state"] | "ended" };
}

export interface WorkingHelper {
  /** Protocol 21: the id of the task manager this worker works for, and its title. */
  managerId?: string;
  taskManager?: string;
}

export interface ApprovalCard {
  /** Protocol 21: the title of the task manager that asks (for one of its workers too). */
  taskManager?: string;
}

export interface QuestionCard {
  /** Protocol 21: the title of the task manager that asks. */
  taskManager?: string;
}

export interface NoteCard {
  /** Protocol 21: the title of the task manager that tells. */
  taskManager?: string;
}

export interface Todo {
  /** Protocol 21: the task manager that made it; its answer goes to the task manager while it is there. */
  taskManager?: { id: string; title: string };
}

export interface Methods {
  /** Writes to a task manager in its thread. While it works, the message goes into its running turn. "not_found" when it has ended. */
  "taskManager.send": { params: { botId: string; managerId: string; text: string }; result: Record<string, never> };
  /** Stops what a task manager is doing, and its workers. It stays, resting. */
  "taskManager.stop": { params: { botId: string; managerId: string }; result: Record<string, never> };
  /** Ends a task manager: its workers stop, its row says ended, and it leaves the rail. Its bot is told. */
  "taskManager.end": { params: { botId: string; managerId: string }; result: Record<string, never> };
}

// ---------------------------------------------------------------- protocol 22: a day's activity (docs/build/step-activity-day-view.md)
//
// Protocol 22 also carries the answer from a card that came back after a restart: UserItem's `from`
// of type "you" gained `card` (docs/build/step-cards-after-restart.md). One release ships both.

/** What a row of the day is: one of his actions, a bot's turn, a helper or task manager, a calendar action, a channel post. */
export type ActivityRowKind = "you" | "turn" | "helper" | "calendar" | "post";

/** One row of a day's activity. Labels only: the same words as the main bot's activity_log, never what was written. */
export interface ActivityRow {
  /** Start, "09:05" in the engine's time zone; on a day the clocks change, with its offset ("02:30+01:00"). */
  time: string;
  /** End, when it lasted a minute or more. */
  end?: string;
  kind: ActivityRowKind;
  botId?: string;
  /** The bot's name; "You" on his own actions. */
  who: string;
  /** What it was, from a capital: "Message to Kaja, from the phone, chat "Planning"". */
  words: string;
}

export interface ActivityDay {
  /** The day shown, YYYY-MM-DD in `tz`. */
  day: string;
  /** Today, YYYY-MM-DD in `tz`. */
  today: string;
  /** The engine's time zone, the times' zone. */
  tz: string;
  /** One or two short lines: his first and last action and active time, then the counts. */
  summary: string[];
  /** In time order. */
  rows: ActivityRow[];
  /** Rows left out past the limit, on a very long day. */
  more?: number;
}

export interface Methods {
  /** A day's activity, read only, for the window. `day`: YYYY-MM-DD, today when absent. "bad_request" for a bad date or a day not come yet. */
  "activity.day": { params: { day?: string }; result: { activity: ActivityDay } };
}

// ---------------------------------------------------------------- protocol 23: follow-up questions on cards (docs/build/step-card-follow-ups.md)
//
// The person may ask the bot about one of its to-dos or question cards before he acts. The question
// goes to the bot (or task manager) as his message; the bot's last message of the turn it started is
// the answer, kept with the card in `questions`. The card stays open: a question is not an answer.

/** One question the person asked about a card, and its answer. */
export interface CardQuestion {
  /** "cq_" and random letters. */
  id: string;
  /** When he asked. */
  at: string;
  /** What he asked. */
  text: string;
  /**
   * "queued": it waits for the bot to be free. "answering": the bot's turn for it runs.
   * "answered": `answer` holds the bot's reply. "unanswered": the turn ended without a word, or
   * Pobots stopped before it did.
   */
  state: "queued" | "answering" | "answered" | "unanswered";
  /** The bot's reply (Markdown, as a bot's message). */
  answer?: string;
  answeredAt?: string;
  /** His message in the bot's chat that carried the question, when it went as a message. */
  itemId?: string;
}

/** At most this many questions are kept on one card; the oldest go first. */
export const CARD_QUESTIONS_MAX = 20;
/** The longest question, in characters. */
export const CARD_QUESTION_TEXT_MAX = 2000;

export interface QuestionCard {
  /** Protocol 23: the person's questions about this card so far, oldest first. */
  questions?: CardQuestion[];
}

export interface Todo {
  /** Protocol 23: the person's questions about this to-do so far, oldest first. */
  questions?: CardQuestion[];
}

export interface Methods {
  /** Protocol 23: he asks the bot about one of its to-dos. The to-do stays open. "not_found" when it is gone. */
  "todo.ask": { params: { todoId: string; text: string }; result: Record<string, never> };
  /**
   * Protocol 23: he asks the bot about one of its question cards. The card stays open. "not_found"
   * when it is gone, "bad_request" for a card that does not take questions (an approval, a note, a
   * helper's card, Pobots' own).
   */
  "card.ask": { params: { cardId: string; text: string }; result: Record<string, never> };
}

export interface Events {
  /** Protocol 23: a card changed in place: its questions, or its words when the bot asked again. Always the whole card. */
  "card.changed": { card: Card };
}
