// The levers the mock engine gives scripted checks on `window.pobotsMock` (types only; the levers
// themselves are made in MockEngine's constructor and in its chat7Levers). Moved out of mock.ts
// unchanged on 15 Nov 2026 (docs/build/step-split.md).
import type {
  Artifact,
  BackupState,
  BrowserInput,
  BrowserState,
  CardDecision,
  Effort,
  HelperItem,
  NotifySend,
  NotifyState,
  Schedule,
  PlanStep,
  ToolKind,
} from "../../shared/protocol";
import type { BackupOutcome } from "./mock-backup";
import { at, later, type ChannelPost, type PostOutcome } from "./mock-data";

/** Levers for scripted checks, on `window.pobotsMock`. */
export interface MockLevers {
  /** The bot changes a file in its folder, as in a turn. */
  botWrites(botId: string, path: string, text: string): void;
  /** A card runs out now. */
  expire(cardId: string): void;
  /** The current text of a file, or null. */
  read(botId: string, path: string): string | null;
  /** A schedule comes due now, as if its time had come. */
  fire(triggerId: string): void;
  /** Another system calls a webhook with this body. */
  callHook(triggerId: string, body: unknown): void;
  /** The bot saves a schedule with its own tool. */
  botSchedules(botId: string, name: string, schedule: Schedule): void;
  /** A rule is saved by "Always allow" somewhere else, such as another window. */
  addRule(botId: string, label: string, detail?: string): void;
  /** The ids of a bot's triggers, in order. */
  triggerIds(botId: string): string[];
  /** The engine writes a new activity line for a bot, as "Next run ..." for an idle one. */
  setActivity(botId: string, activity: string): void;
  /** Protocol 35 checks: a bot goes on vacation or comes back, stopping what it does. */
  vacation(botId: string, on: boolean): void;
  /** A Power Automate flow posts this body to a channel's address. Says what the engine answered. */
  channelPost(channelId: string, body: ChannelPost): PostOutcome;
  /** The ids of the channels, in order. */
  channelIds(): string[];
  /** Posting answers to this channel's answer address fails from now on, or works again. */
  replyFails(channelId: string, fails: boolean): void;
  /** Whether the engine holds this exact answer address for the channel. The window never learns it. */
  hasReplyUrl(channelId: string, url: string): boolean;
  /** The main bot changes a tag and the writers of a channel at once: one quiet line in its chat, no card. */
  channelChanges(): void;
  /** These quiet lines about changes are written in a bot's main chat when its next turn ends, as the engine does. */
  linesAfterTurn(lines: string[]): void;
  /** How many requests of each method the window has made since the page opened. */
  requests(): Record<string, number>;
  /** Tidy turns wait before their end (steps done, note written) until this is turned off again. */
  holdTidy(hold: boolean): void;
  /** Steering: plain answer turns wait after their step, before the answer, until this is turned off again. */
  holdTurns(hold: boolean): void;
  /** Tidy turns end without a note from now on, or work again. Nothing is added to the chat then. */
  tidyFails(fails: boolean): void;
  /** The engine says the tidying is over a moment before the "fresh" notice comes, or after it (the default). */
  tidyEndsFirst(on: boolean): void;
  /** The engine's own clock begins a tidy turn now, without a request from the window. */
  startFresh(botId: string): boolean | string;
  /** Helpers wait before their end (steps done, result written) until this is turned off again. */
  holdHelpers(hold: boolean): void;
  /** Helpers end as failed from now on, or work again. */
  helperFails(fails: boolean): void;
  /** A bot woken by a helper that ended waits before it speaks until this is turned off again. */
  holdWake(hold: boolean): void;
  /** The helper rows in a bot's chat, in order. */
  helperRows(botId: string): { id: string; status: HelperItem["status"]; title: string; last?: string; steps: number; helperThreadId: string }[];
  /** How many times each helper row has been sent, by item id: the engine sends a changed row at most about once a second. */
  helperUpserts(): Record<string, number[]>;
  /** The engine sends a helper row again with this model and effort (none: no label), as if the bot had chosen them. */
  helperModel(itemId: string, model?: string, effort?: Effort, fast?: boolean): void;
  /** The ids of the models the engine lists now, in order. */
  models(): string[];
  /** A "step by step" turn waits at every moment until `stepOn`, from now on, or goes straight through again. */
  holdSteps(hold: boolean): void;
  /** Lets a held "step by step" turn go on to its next moment. */
  stepOn(): void;
  /** The moment a held "step by step" turn waits at, or "" when it is not waiting. */
  stepPhase(): string;
  /** The bot changes the files of a page: its rev goes up and "artifact.changed" is sent, with no line in the chat. */
  changeArtifact(botId: string, artifactId: string): number;
  /** The file of a page is deleted (gone) or comes back. */
  artifactFile(botId: string, artifactId: string, there: boolean): void;
  /** `artifact.open` answers this many ms later from now on (0 for the usual). */
  artifactOpenDelay(ms: number): void;
  /** `artifact.open` fails from now on, or works again. */
  artifactOpenFails(fails: boolean): void;
  /** A bot's artifacts as the engine holds them, newest change first. */
  artifacts(botId: string): Artifact[];
  /** A new card arrives in the rail. */
  addCard(): string;
  /** Every answer to a card, in order (the phone layout's checks read a typed answer here). */
  cardDecisions(): { cardId: string; decision: CardDecision }[];
  /** The browser as the engine holds it. */
  browserState(): BrowserState;
  /** Every batch of input that reached a page, in order. */
  browserInputs(): BrowserInput[][];
  /** How many pictures were sent. */
  browserFrames(): number;
  /** What the window watches now, or null: the workspace, the page it stays on (none: the front page), the page shown, the ratio. */
  browserWatching(): { spaceId: string; pageId?: string; shown?: string; ratio?: number } | null;
  /** The page in front of a workspace as the engine holds it: its address, title, typed text, scroll, clicks and selection. */
  browserPage(spaceId: string): { url: string; title: string; text: string; scroll: number; clicks: { x: number; y: number }[]; selected: string; lists: string[]; heard: string; asking: boolean } | null;
  /** Where the drop-down lists and the asking buttons are on the made-up page, in its own pixels. */
  browserPlaces(): { lists: { x: number; y: number; w: number; h: number }[]; ask: { x: number; y: number; w: number; h: number }; name: { x: number; y: number; w: number; h: number }; link: { x: number; y: number; w: number; h: number }; field: { x: number; y: number; w: number; h: number } };
  /** The page in front of a workspace asks a question by itself; null: someone else (the bot) answered it. */
  browserAsk(spaceId: string, dialog: { type: "alert" | "confirm" | "prompt"; message: string; defaultText?: string } | null, pageId?: string): void;
  /** A new page opens in front in a workspace (as when a bot opens one); gives its id. */
  browserOpenPage(spaceId: string, url: string, title: string): string;
  /** A page of a workspace closes (as when its bot closes it). */
  browserClosePage(spaceId: string, pageId: string): void;
  /** Another page of a workspace comes to the front (as when its bot works in it). */
  browserFront(spaceId: string, pageId: string): void;
  /** Every ratio the window sent with "browser.watch" and "browser.view", in order. */
  browserRatios(): number[];
  /** Every "browser.page.show" the window sent, in order (null: follow the front page). */
  browserShows(): (string | null)[];
  /** How long a page stands still before its sharp picture, in ms. */
  browserStill(ms: number): void;
  /** Pictures as before step 2g's third round (JPEG at the page's own size, no sharp one), for comparing. */
  browserBefore(on: boolean): void;
  /** A workspace is closed in the browser, as when its bot is done with it. Its rows turn "closed". */
  closeBrowserSpace(spaceId: string): void;
  /** The first picture of each watch comes this many ms later from now on. */
  browserFirstPicture(ms: number): void;
  /** The browser can be reached, or not (with the engine's sentence). */
  browserAvailable(on: boolean, problem?: string): void;
  /** A bot's command runs in a workspace, or ends. */
  browserBusy(spaceId: string, busy: boolean): void;
  /** The page in front of a workspace moves somewhere else, as when its bot clicks a link. */
  browserNavigate(spaceId: string, url: string, title: string): void;
  /** Ids of uploads that are not sent yet (neither sent nor thrown away). */
  uploadsWaiting(): string[];
  /** The connection to the engine drops (events are lost, requests fail), or comes back with a new snapshot. */
  dropConnection(): void;
  /** Protocol 32: the engine comes back with another version, as after an update (the page reloads once when it may). */
  newEngineVersion(version: string): void;
  restoreConnection(): void;
  /**
   * The next `message.send` is stored by the engine, but its answer never reaches the window: with
   * "drop" the connection drops right after (as if the socket broke), with "timeout" the request
   * fails as the real client's does when no answer comes. False takes it back.
   */
  loseSendReply(how: "drop" | "timeout" | false): void;
  /** The backup as the engine holds it. */
  backupState(): BackupState;
  /** The next backup run ends this way (they queue up), with this sentence when it is not saved. */
  backupNext(outcome: BackupOutcome, problem?: string): void;
  /** How long a backup run takes, in ms. */
  backupRunMs(ms: number): void;
  /** The engine's clock starts the nightly backup now. */
  backupNight(): void;
  /** Nothing was saved for two days: the card says so. */
  backupStale(): void;
  /** The id of the backup's card on the rail, or null. */
  backupCard(): string | null;
  /** The backup folder is usable, or not. */
  backupFolder(ok: boolean, problem?: string): void;
  /** Every text the window sent with "backup.setPasswordRef", in order. */
  backupReferenceTexts(): string[];
  /** A newer card from Pobots comes after the older one is withdrawn (as the engine does it), or before. */
  backupCardOrder(order: "withdraw-first" | "add-first"): void;
  /** Notifications as the engine holds them: the switches and the devices. */
  notifyState(): NotifyState;
  /** The next "Send a test" ends this way (they queue up). */
  notifyTestNext(result: NotifySend["result"], problem?: string): void;
  /** "notify.test" answers this many ms later from now on. */
  notifyTestMs(ms: number): void;
  /** The next "notify.subscribe" is refused with this code and sentence (they queue up). */
  notifySubscribeNext(code: string, message: string): void;
  /** Every presence the window sent, in order, with when it came (ms since the page opened). */
  notifyPresence(): { deviceId?: string; visible: boolean; focused: boolean; idleMs: number | null; at: number }[];
  /** Every "notify.subscribe", in order: asked or not, the label, what it replaced, the push service, the device id. */
  notifySubscribes(): { asked: boolean; label: string; replaces?: string; service: string | null; deviceId: string }[];
  /** Another device turned notifications on; gives its id. */
  notifyAddDevice(label: string, endpoint?: string): string;
  /** The push service said this device is gone. */
  notifyGone(deviceId: string): void;
  /** A notification was sent (or tried) to this device just now. */
  notifySent(deviceId: string, kind: NotifySend["kind"], result: NotifySend["result"], problem?: string): void;
  // Step 7b (ui/engine/mock-settings.ts).
  /** The settings as the mock keeps them. */
  settingsState(): import("../../shared/protocol").PobotsSettings;
  providersState(): import("../../shared/protocol").ProvidersState;
  usageState(): import("../../shared/protocol").UsageState | null;
  /** The update waits while these bots "work" (null: the bots' real state). */
  updateHold(names: string[] | null): void;
  /** The next update works or fails. */
  updateNext(next: "ok" | "fail"): void;
  /** How many hub keys the mock keeps (never sent back). */
  hubKeysKept(): number;
  /** A chat of a bot gets a title now. */
  titleChat(botId: string, chat: import("../../shared/protocol").ChatTitle): void;
  /** The next usage reading: "one", "several" or "none". */
  usageNext(kind: string): void;
}

declare global {
  interface Window {
    pobotsMock?: MockLevers;
  }
}

// ------------------------------------------------------------ job 7, the chat (step 7a): levers

export interface MockLevers {
  /** Sets a bot's to-do list from [text, status] pairs; null takes it away. */
  setPlan(botId: string, steps: [string, PlanStep["status"]][] | null): void;
  /** Adds a line of work to the bot's running turn (its kind for the icon); returns its id. */
  addWork(botId: string, label: string, tool: ToolKind, o?: { running?: boolean; detail?: string }): string;
  /** A running line of work is done, with its past-tense label. */
  finishWork(botId: string, itemId: string, label?: string): void;
  /** The bot takes the first waiting message now: a turn of its own starts with it. Returns its id. */
  takeQueued(botId: string): string | null;
  /** The bot's running turn ends with this text. */
  endWork(botId: string, text: string): void;
}
