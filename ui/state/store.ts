// The app's state: one immutable object, changed only here, read in React with useAppState.
// The engine is the source of truth; this holds what the window has seen of it.
import { useSyncExternalStore } from "react";
import type { Artifact, BackupState, Bot, BrowserSpace, BrowserState, CalendarState, Card, Channel, ChannelMessage, ChatSettings, ChatTitle, ConnectionsState, EngineStatus, Events, HelperItem, Item, Machine, ModelInfo, NotifyState, PobotsSettings, ProvidersState, Snapshot, Todo, Trigger, TriggerRun, Upcoming, UsageState, UserItem } from "../../shared/protocol";
import type { ConnectionInfo, EngineEvent } from "../engine/types";
import { engineHereAtStart } from "../lib/env";
import { isPhone } from "../lib/phone";
import { notePlace } from "../lib/place";
import { viewIn, type PhoneScreen } from "./phone-view";

/** The quiet text tabs on a bot's page. Chat is the default. */
export type BotTab = "chat" | "job" | "files" | "artifacts" | "triggers" | "history" | "settings";
export const BOT_TABS: { id: BotTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "job", label: "Job" },
  { id: "files", label: "Files" },
  { id: "artifacts", label: "Artifacts" },
  { id: "triggers", label: "Triggers" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
];

/** Bumped on every "bot.files.changed": open editors and lists watch it and read again. */
export interface FilesTick {
  n: number;
  paths: string[];
  /** Who changed them: you (in this or another window), the bot in a turn, or the app (an undo). */
  by: Events["bot.files.changed"]["by"];
}

/** A trigger's runs as far as they have been read, newest first. Kept up to date by "trigger.run". */
export interface RunsState {
  runs: TriggerRun[];
  hasMore: boolean;
  loaded: boolean;
}

/** What came in on a channel as far as it has been read, newest first. Kept up to date by "channel.message". */
export interface ChannelMessagesState {
  messages: ChannelMessage[];
  hasMore: boolean;
  loaded: boolean;
}

/** "Show in chat": the chat of this bot scrolls to this turn, or to the newest row of this artifact, once it is open. */
export interface ChatFocus {
  botId: string;
  turnId?: string;
  artifactId?: string;
  n: number;
}

/**
 * The artifact open in the panel beside the chat, in the place of the "Needs you" rail. One at a
 * time. `full` makes the panel fill the whole main area, with the chat hidden behind it.
 */
export interface ArtifactPanel {
  kind: "artifact";
  botId: string;
  artifactId: string;
  full: boolean;
}

/**
 * The browser open in the same panel: the live picture of one workspace. It is not one bot's, so it
 * stays open across bots, tabs and channels. Opening it while an artifact is open swaps the content.
 */
export interface BrowserPanel {
  kind: "browser";
  spaceId: string;
  full: boolean;
}

/** What the one panel beside the chat shows: an artifact or the browser. */
export type Panel = ArtifactPanel | BrowserPanel;

/** The rows in the chat that belong to what the panel shows, for keeping the chat's place and giving the focus back. */
export const panelRows = (p: Panel): string =>
  p.kind === "browser" ? `.pb-browser[data-space-id="${CSS.escape(p.spaceId)}"]` : `.pb-artifact[data-artifact-id="${CSS.escape(p.artifactId)}"]`;

const samePanel = (a: Panel | null, b: Panel | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.full !== b.full) return false;
  return a.kind === "browser" ? a.spaceId === (b as BrowserPanel).spaceId : a.botId === (b as ArtifactPanel).botId && a.artifactId === (b as ArtifactPanel).artifactId;
};

/** One picture of the watched page, what the page shows outside it, or the end of a watch. They go to the panel straight, never through the state. */
export type BrowserFeed =
  | { event: "browser.frame"; data: Events["browser.frame"] }
  | { event: "browser.prompt"; data: Events["browser.prompt"] }
  | { event: "browser.ended"; data: Events["browser.ended"] };
const feeds = new Set<(e: BrowserFeed) => void>();
/** The browser panel listens to pictures here. Returns the way to stop. */
export function onBrowserFeed(listener: (e: BrowserFeed) => void): () => void {
  feeds.add(listener);
  return () => feeds.delete(listener);
}

/** Before the first snapshot or "browser.changed": nothing known, not shown. */
export const NO_BROWSER: BrowserState = { available: false, spaces: [] };

const PANEL_KEY = "pobots.artifactPanel";
const SHARE_KEY = "pobots.artifactShare";
const BROWSER_SHARE_KEY = "pobots.browserShare";
/** An artifact's panel takes about half of the space beside the roster by default. */
export const DEFAULT_SHARE = 0.5;
/**
 * The browser's panel is as wide as the divider allows by default (the chat at its readable
 * minimum): a page is hard to read at half size. Its width is remembered apart from an artifact's.
 */
export const DEFAULT_BROWSER_SHARE = 1;

/** The open panel is kept for this tab, so a reload of the page keeps it open. */
const panelAtStart = (): Panel | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(PANEL_KEY) ?? "null") as { kind?: string; botId?: unknown; artifactId?: unknown; spaceId?: unknown; full?: unknown } | null;
    if (!v) return null;
    if (v.kind === "browser") return typeof v.spaceId === "string" ? { kind: "browser", spaceId: v.spaceId, full: v.full === true } : null;
    return typeof v.botId === "string" && typeof v.artifactId === "string" ? { kind: "artifact", botId: v.botId, artifactId: v.artifactId, full: v.full === true } : null;
  } catch {
    return null;
  }
};

/** How much of the space beside the roster the panel takes, remembered on this device. */
const shareAtStart = (key = SHARE_KEY, fallback = DEFAULT_SHARE): number => {
  try {
    const raw = localStorage.getItem(key);
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
  } catch {
    return fallback;
  }
};

/** The share of the panel that is open (or would open): the browser's or an artifact's. */
export const shareOf = (s: { panel: Panel | null; panelShare: number; browserShare: number }, kind = s.panel?.kind): number =>
  kind === "browser" ? s.browserShare : s.panelShare;

/** Newest change first, as "artifact.list" gives them. */
const byNewest = (a: Artifact, b: Artifact) => b.updatedAt.localeCompare(a.updatedAt);

/** Text typed in an editor that is not saved yet. Leaving it asks first. */
export interface Unsaved {
  botId: string;
  /** "the job", "memory/topics/customers.md" */
  what: string;
}

/** A question the window asks before it goes on: leaving unsaved text. */
export interface LeaveAsk {
  unsaved: Unsaved;
  go(): void;
}

/**
 * One open helper thread. Each bot has a stack of them: the helper opened from its chat, then a
 * helper opened from that helper's thread, and so on. Back goes one level up. The title and status
 * are a copy for when the helper item itself is not loaded (after a reload); the live item wins.
 */
export interface HelperFrame {
  botId: string;
  /** The helper item's id. */
  itemId: string;
  /** The thread the helper's row stands in: the bot's chat, a fresh run's thread or a helper's thread. */
  threadId: string;
  helperThreadId: string;
  title: string;
  status: HelperItem["status"];
}

/** The open helper threads per bot, innermost last. */
export type HelperStacks = Record<string, HelperFrame[]>;

const HELPER_STATE_KEY = "pobotsHelpers";

// The screen a phone shows (docs/build/step-phone.md): the bots, a bot's chat (or a channel's page),
// or what needs you. The sheets over them (the bot's page, an artifact, the browser, Pobots settings)
// are the tab, the panel and the settings page as the laptop has them. Not used on the laptop.
export type { PhoneScreen };

/** On a phone, what the history entry the window opens on shows (a reload keeps the screen). */
const phoneAtStart = () => {
  if (!isPhone()) return null;
  try {
    return viewIn(history.state) ?? { screen: "bots" as const };
  } catch {
    return { screen: "bots" as const };
  }
};
const PHONE_START = phoneAtStart();

/** The helper stacks kept in a history entry, so the browser's back button and a reload keep them. */
export function helperStacksOf(state: unknown): HelperStacks {
  const value = (state && typeof state === "object" ? (state as Record<string, unknown>)[HELPER_STATE_KEY] : undefined) as unknown;
  if (!value || typeof value !== "object") return {};
  const out: HelperStacks = {};
  for (const [botId, frames] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(frames)) continue;
    const ok = frames.filter(
      (f): f is HelperFrame => !!f && typeof f === "object" && typeof f.itemId === "string" && typeof f.helperThreadId === "string" && typeof f.threadId === "string",
    );
    if (ok.length) out[botId] = ok;
  }
  return out;
}

/**
 * The current history entry's state with these helper stacks in it. `before` is what the entry
 * before it holds, when this entry was pushed on top of it, so going back knows it may use the
 * browser's own back.
 */
export function historyStateWith(stacks: HelperStacks, before?: HelperStacks): Record<string, unknown> {
  const now = history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {};
  return { ...now, [HELPER_STATE_KEY]: stacks, [HELPER_STATE_KEY + "Before"]: before ?? null };
}

/** What the history entry before this one holds, when this one was pushed by opening a helper. */
export function helperStacksBefore(state: unknown): HelperStacks | null {
  const value = state && typeof state === "object" ? (state as Record<string, unknown>)[HELPER_STATE_KEY + "Before"] : null;
  return value && typeof value === "object" ? helperStacksOf({ [HELPER_STATE_KEY]: value }) : null;
}

/**
 * The helper row that takes the focus again when the chat it stands in shows again after going
 * back from its thread. Set by going back (the back control or the browser's), read once by the chat.
 */
export const helperReturn: { itemId: string | null } = { itemId: null };

/** The history entry's mark that Pobots' settings page is open: a reload keeps the page, as it keeps a helper's thread. */
const APP_SETTINGS_STATE_KEY = "pobotsAppSettings";

/** A history state with the settings mark set or taken off: what the laptop keeps for a reload (state/screens.ts, leaving the phone). */
export function withAppSettingsMark(state: Record<string, unknown>, open: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...state };
  if (open) next[APP_SETTINGS_STATE_KEY] = true;
  else delete next[APP_SETTINGS_STATE_KEY];
  return next;
}

const appSettingsAtStart = (): boolean => {
  try {
    return !!history.state && typeof history.state === "object" && (history.state as Record<string, unknown>)[APP_SETTINGS_STATE_KEY] === true;
  } catch {
    return false;
  }
};

/** Marks (or unmarks) the current history entry, so a reload opens on the same page. A new navigation starts without it. */
const markAppSettings = (open: boolean): void => {
  // On a phone the settings page is a history entry of its own (state/screens.ts), which a reload keeps.
  if (isPhone()) return;
  try {
    const now = history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...now };
    if (open) next[APP_SETTINGS_STATE_KEY] = true;
    else delete next[APP_SETTINGS_STATE_KEY];
    history.replaceState(next, "");
  } catch {
    // Keeping the page open across a reload is a convenience only.
  }
};

const helperStacksAtStart = (): HelperStacks => {
  try {
    return helperStacksOf(history.state);
  } catch {
    return {};
  }
};

export interface ThreadState {
  /** Sorted by seq, oldest first. */
  items: Item[];
  hasMore: boolean;
  loading: boolean;
  /** True once the newest page has been read at least once. */
  loaded: boolean;
  error?: string;
  /**
   * Waiting messages older than the pages read (step 7a, "thread.queued"): they stand in the stack
   * above the message box. Those in `items` are not repeated here.
   */
  waiting?: UserItem[];
}

/** Step 7b: the sections of the settings window. */
export type SettingsSection = "general" | "chats" | "providers" | "calendar" | "usage" | "connections" | "activity";
export const SETTINGS_SECTIONS: SettingsSection[] = ["general", "chats", "providers", "calendar", "usage", "connections", "activity"];

/** The history entry's mark of the section the settings window shows, so a reload keeps it. */
const SETTINGS_SECTION_KEY = "pobotsSettingsSection";
const sectionAtStart = (): SettingsSection => {
  try {
    const v = history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>)[SETTINGS_SECTION_KEY] : undefined;
    return SETTINGS_SECTIONS.includes(v as SettingsSection) ? (v as SettingsSection) : "general";
  } catch {
    return "general";
  }
};
const markSection = (section: SettingsSection): void => {
  try {
    const now = history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {};
    history.replaceState({ ...now, [SETTINGS_SECTION_KEY]: section }, "");
  } catch {
    // A convenience only.
  }
};

export interface AppState {
  connection: ConnectionInfo;
  /** True after the first snapshot. Before that the window shows nothing but the ground. */
  ready: boolean;
  status: EngineStatus | null;
  bots: Bot[];
  cards: Card[];
  models: ModelInfo[];
  machines: Machine[];
  threads: Record<string, ThreadState>;
  openBotId: string | null;
  /** The open tab per bot, while the app is open. */
  tabs: Record<string, BotTab>;
  /** The open file in the Files tab per bot, while the app is open. */
  openFiles: Record<string, string>;
  filesTicks: Record<string, FilesTick>;
  /** Why each recently removed card left, so the rail can let an expired one go quietly. */
  removedReasons: Record<string, Events["card.removed"]["reason"]>;
  /** The engine runs on the machine this window runs on. False for a page opened on another device. */
  engineHere: boolean;
  unsaved: Unsaved | null;
  leaveAsk: LeaveAsk | null;
  /** The sheet for adding a bot is open. */
  adding: boolean;
  /** Scheduled runs in the next 24 hours, soonest first. */
  upcoming: Upcoming[];
  /** Each bot's triggers in the order they were made, once read. */
  triggers: Record<string, Trigger[]>;
  /** Runs per trigger id, once read. */
  runs: Record<string, RunsState>;
  /** The trigger open in each bot's Triggers tab, while the app is open. */
  openTriggers: Record<string, string>;
  chatFocus: ChatFocus | null;
  /** Bumped on "rules.changed": an open Settings tab reads the saved rules again. */
  rulesTicks: Record<string, number>;
  /** The outside channels, in the order they were made. */
  channels: Channel[];
  /** What came in per channel id, once read. */
  channelMessages: Record<string, ChannelMessagesState>;
  /** The channel whose page is open in the reading panel, in place of a bot's page. */
  openChannelId: string | null;
  /** The sheet for making a channel is open. */
  addingChannel: boolean;
  /** The helper threads open in each bot's chat, innermost last. */
  helpers: HelperStacks;
  /** Each bot's artifacts, newest change first, once read. Kept current by "artifact.changed". */
  artifacts: Record<string, Artifact[]>;
  /** Artifacts taken off their bot's list while the app is open (or found gone when opened). Their rows stay as lines. */
  removedArtifacts: Record<string, true>;
  /** What is open beside the chat (an artifact or the browser), or null. */
  panel: Panel | null;
  /** The browser on the engine's machine, as the engine last said. */
  browser: BrowserState;
  /** How much of the space beside the roster an artifact's panel takes (0 to 1). */
  panelShare: number;
  /** How much the browser's panel takes (0 to 1; 1 is as wide as the divider allows). */
  browserShare: number;
  /** A page on Claude whose window the browser blocked: shown as a plain link to click. */
  blockedLink: { url: string; title: string } | null;
  /** The nightly backup as the engine last said. Null before the first snapshot. */
  backup: BackupState | null;
  connections: ConnectionsState | null;
  /** Notifications when the page is not open: the switches and the devices, as the engine last said. Null before the first snapshot. */
  notify: NotifyState | null;
  /** The chat settings (protocol 14): what a message sent while a bot works does by default. */
  chat: ChatSettings;
  /** Protocol 24: "About you", the note about the person every bot gets. Empty when none. */
  aboutYou: string;
  /** Step 7c: the person's open to-dos, as the engine keeps them (oldest first; the rail sorts them). */
  todos: Todo[];
  /**
   * The settings page for Pobots as a whole is open in the reading panel, over the open bot's or
   * channel's page, which stays where it was underneath, so going back shows it unchanged.
   */
  appSettings: boolean;
  /** Cards from Pobots itself that a newer card of the same topic took the place of. They do not leave; the new one stands in their place. */
  replacedCards: Record<string, true>;
  /** Step 7b: the section the settings window shows. */
  appSettingsSection: SettingsSection;
  /** Step 7b: the settings window's settings, the providers and the usage meters, as the engine last said. Null before the first snapshot (usage: before the first reading). */
  settings: PobotsSettings | null;
  providers: ProvidersState | null;
  usage: UsageState | null;
  /** The calendar tools' connection (16 Nov 2026), as the engine last said. Null until first read. */
  calendar: CalendarState | null;
  /** Step 7b: each bot's titled chats, newest first, as far as read. */
  chatTitles: Record<string, { chats: ChatTitle[]; hasMore: boolean; loaded: boolean }>;
  /** The screen a phone shows. Kept in step with history by state/screens.ts; the laptop does not use it. */
  phoneScreen: PhoneScreen;
}

const LAST_BOT_KEY = "pobots.openBot";
/** How long a withdrawn card from Pobots waits for a newer one on its topic before it leaves. Too short to see. */
const SYSTEM_SWAP_MS = 250;

const rememberedBot = (): string | null => {
  try {
    return localStorage.getItem(LAST_BOT_KEY);
  } catch {
    return null;
  }
};

export const emptyThread: ThreadState = { items: [], hasMore: false, loading: false, loaded: false };

/** Merges items by id and keeps them in seq order. Later copies win. */
export function mergeItems(current: Item[], incoming: Item[]): Item[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((i) => [i.id, i]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

type Listener = () => void;

export class Store {
  private state: AppState = {
    connection: { phase: "connecting", since: Date.now() },
    ready: false,
    status: null,
    bots: [],
    cards: [],
    models: [],
    machines: [],
    threads: {},
    openBotId: PHONE_START?.bot ?? rememberedBot(),
    tabs: PHONE_START?.bot && PHONE_START.tab ? { [PHONE_START.bot]: PHONE_START.tab } : {},
    openFiles: {},
    filesTicks: {},
    removedReasons: {},
    engineHere: engineHereAtStart(),
    unsaved: null,
    leaveAsk: null,
    adding: false,
    upcoming: [],
    triggers: {},
    runs: {},
    openTriggers: {},
    chatFocus: null,
    rulesTicks: {},
    channels: [],
    channelMessages: {},
    openChannelId: PHONE_START?.channel ?? null,
    addingChannel: false,
    helpers: helperStacksAtStart(),
    artifacts: {},
    removedArtifacts: {},
    // On a phone the panel is a sheet of the screen the entry shows, kept in history like the screen.
    panel: PHONE_START
      ? PHONE_START.panel?.kind === "browser"
        ? { kind: "browser", spaceId: PHONE_START.panel.id, full: false }
        : PHONE_START.panel?.kind === "artifact"
          ? { kind: "artifact", botId: PHONE_START.panel.bot, artifactId: PHONE_START.panel.id, full: false }
          : null
      : panelAtStart(),
    browser: NO_BROWSER,
    panelShare: shareAtStart(),
    browserShare: shareAtStart(BROWSER_SHARE_KEY, DEFAULT_BROWSER_SHARE),
    blockedLink: null,
    backup: null,
    connections: null,
    notify: null,
    chat: { followUp: "steer" },
    aboutYou: "",
    todos: [],
    // On a phone the history entry's view says whether settings show; on the laptop its own mark does.
    appSettings: PHONE_START ? PHONE_START.settings === true : appSettingsAtStart(),
    replacedCards: {},
    phoneScreen: PHONE_START?.screen ?? "bots",
    appSettingsSection: sectionAtStart(),
    settings: null,
    providers: null,
    usage: null,
    calendar: null,
    chatTitles: {},
  };
  private readonly listeners = new Set<Listener>();
  /** How many "backup.changed" events have come, so an answer that is older than one of them is not used. */
  backupEvents = 0;
  /** How many "notify.changed" events have come, for the same reason. */
  notifyEvents = 0;
  /** How many "chat.changed" events have come, for the same reason. */
  chatEvents = 0;
  /** How many "aboutYou.changed" events have come, for the same reason. */
  aboutYouEvents = 0;
  /** Step 7b: how many "settings.changed" events have come, for the same reason. */
  settingsEvents = 0;
  /** How many "calendar.changed" events have come, for the same reason. */
  calendarEvents = 0;
  /**
   * A card from Pobots that the engine withdrew a moment ago, by topic: it stays a moment in case a
   * newer card on the same topic follows at once, which then takes its place instead of the old one
   * leaving and the new one arriving elsewhere. The engine may send the two in either order.
   */
  private withdrawing = new Map<string, { cardId: string; timer: ReturnType<typeof setTimeout> }>();

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------ from the engine

  connection(info: ConnectionInfo): void {
    this.set({ connection: info });
  }

  snapshot(s: Snapshot): void {
    for (const w of this.withdrawing.values()) clearTimeout(w.timer);
    this.withdrawing.clear();
    const keep = s.bots.some((b) => b.id === this.state.openBotId);
    this.set({
      ready: true,
      status: s.status,
      bots: s.bots,
      cards: s.cards,
      models: s.models,
      machines: s.machines,
      upcoming: s.upcoming ?? [],
      openBotId: keep ? this.state.openBotId : (s.bots[0]?.id ?? null),
      channels: s.channels ?? [],
      browser: s.browser ?? NO_BROWSER,
      backup: s.backup ?? null,
      connections: s.connections ?? null,
      notify: s.notify ?? null,
      chat: s.chat ?? { followUp: "steer" },
      aboutYou: s.aboutYou ?? "",
      settings: s.settings ?? null,
      providers: s.providers ?? null,
      todos: s.todos ?? [],
      calendar: s.calendar ?? null,
      openChannelId: (s.channels ?? []).some((c) => c.id === this.state.openChannelId) ? this.state.openChannelId : null,
    });
  }

  event(e: EngineEvent): void {
    switch (e.event) {
      case "bot.added": {
        const exists = this.state.bots.some((b) => b.id === e.data.bot.id);
        const bots = exists ? this.state.bots.map((b) => (b.id === e.data.bot.id ? e.data.bot : b)) : [...this.state.bots, e.data.bot];
        this.set({ bots, openBotId: this.state.openBotId ?? e.data.bot.id });
        return;
      }
      case "bot.updated": {
        const { bot } = e.data;
        const at = this.state.bots.findIndex((b) => b.id === bot.id);
        if (at < 0) return this.event({ event: "bot.added", data: e.data });
        const bots = this.state.bots.map((b) => b.id === bot.id ? bot : b);
        if (bot.vacationSince && !this.state.bots[at]?.vacationSince && this.state.openBotId === bot.id) {
          const next = bots.slice(at + 1).find((b) => !b.vacationSince) ?? bots.slice(0, at).findLast((b) => !b.vacationSince);
          if (next) {
            try { localStorage.setItem(LAST_BOT_KEY, next.id); } catch { /* Keep the choice in this window. */ }
            this.set({ bots, openBotId: next.id, tabs: { ...this.state.tabs, [next.id]: "chat" },
              ...(this.state.panel?.kind === "artifact" && this.state.panel.botId === bot.id ? { panel: null } : {}) });
            return;
          }
        }
        this.set({ bots });
        return;
      }
      case "item.upsert": {
        const t = this.state.threads[e.data.item.threadId] ?? emptyThread;
        const item = e.data.item;
        // A waiting message older than the pages read stays out of them (paging goes by the first seq).
        const older = item.kind === "user" && item.queued && t.hasMore && t.items.length > 0 && item.seq < t.items[0]!.seq && !t.items.some((i) => i.id === item.id);
        const waiting = t.waiting?.filter((w) => w.id !== item.id);
        if (older) this.putThread(item.threadId, { ...t, waiting: [...(waiting ?? []), item].sort((a, b) => a.seq - b.seq) });
        else this.putThread(item.threadId, { ...t, items: mergeItems(t.items, [item]), ...(t.waiting ? { waiting } : {}) });
        return;
      }
      case "item.removed": {
        const t = this.state.threads[e.data.threadId];
        if (!t) return;
        this.putThread(e.data.threadId, { ...t, items: t.items.filter((i) => i.id !== e.data.itemId), ...(t.waiting ? { waiting: t.waiting.filter((w) => w.id !== e.data.itemId) } : {}) });
        return;
      }
      case "item.delta": {
        const t = this.state.threads[e.data.threadId];
        if (!t) return;
        let found = false;
        const items = t.items.map((i) => {
          if (i.id !== e.data.itemId || i.kind !== "bot") return i;
          found = true;
          return { ...i, text: i.text + e.data.textDelta };
        });
        if (found) this.putThread(e.data.threadId, { ...t, items });
        return;
      }
      case "card.added": {
        const card = e.data.card;
        if (this.state.cards.some((c) => c.id === card.id)) return;
        // A card from Pobots itself takes the place of an older one on the same topic, where it stands:
        // there is at most one per topic, and the rail must not lose one card and gain another.
        const old = card.kind === "system" ? this.state.cards.find((c) => c.kind === "system" && c.topic === card.topic) : undefined;
        if (old && card.kind === "system") {
          const w = this.withdrawing.get(card.topic);
          if (w) {
            clearTimeout(w.timer);
            this.withdrawing.delete(card.topic);
          }
          this.set({ cards: this.state.cards.map((c) => (c.id === old.id ? card : c)), replacedCards: { ...this.state.replacedCards, [old.id]: true } });
          return;
        }
        const cards = [...this.state.cards, card].sort((a, b) => a.at.localeCompare(b.at));
        this.set({ cards });
        return;
      }
      // Protocol 23: a card changed in place (his questions, or the bot asked again): it keeps its spot.
      case "card.changed": {
        const card = e.data.card;
        if (!this.state.cards.some((c) => c.id === card.id)) {
          this.set({ cards: [...this.state.cards, card].sort((a, b) => a.at.localeCompare(b.at)) });
          return;
        }
        this.set({ cards: this.state.cards.map((c) => (c.id === card.id ? card : c)) });
        return;
      }
      case "card.removed": {
        const { cardId, reason } = e.data;
        const card = this.state.cards.find((c) => c.id === cardId);
        if (card?.kind === "system" && reason === "withdrawn" && !this.withdrawing.has(card.topic)) {
          // Held a moment: a newer card on the topic may follow and take its place.
          const topic = card.topic;
          const timer = setTimeout(() => {
            this.withdrawing.delete(topic);
            this.dropCard(cardId, reason);
          }, SYSTEM_SWAP_MS);
          this.withdrawing.set(topic, { cardId, timer });
          return;
        }
        if (card?.kind === "system") {
          const w = this.withdrawing.get(card.topic);
          if (w?.cardId === cardId) {
            clearTimeout(w.timer);
            this.withdrawing.delete(card.topic);
          }
        }
        this.dropCard(cardId, reason);
        return;
      }
      case "bot.removed": {
        const bots = this.state.bots.filter((b) => b.id !== e.data.botId);
        const open = this.state.openBotId === e.data.botId ? (bots.find((b) => b.role === "main") ?? bots.find((b) => !b.vacationSince))?.id ?? null : this.state.openBotId;
        const unsaved = this.state.unsaved?.botId === e.data.botId ? null : this.state.unsaved;
        const triggers = { ...this.state.triggers };
        delete triggers[e.data.botId];
        const helpers = { ...this.state.helpers };
        delete helpers[e.data.botId];
        const artifacts = { ...this.state.artifacts };
        delete artifacts[e.data.botId];
        if (this.state.panel?.kind === "artifact" && this.state.panel.botId === e.data.botId) this.setPanel(null);
        this.set({
          artifacts,
          helpers,
          bots,
          cards: this.state.cards.filter((c) => c.kind === "system" || c.botId !== e.data.botId),
          openBotId: open,
          unsaved,
          triggers,
          upcoming: this.state.upcoming.filter((u) => u.botId !== e.data.botId),
        });
        return;
      }
      case "bot.files.changed": {
        const tick = this.state.filesTicks[e.data.botId];
        // An engine before version 3 does not say who; then it is not blamed on anyone.
        this.set({ filesTicks: { ...this.state.filesTicks, [e.data.botId]: { n: (tick?.n ?? 0) + 1, paths: e.data.paths, by: e.data.by } } });
        return;
      }
      case "rules.changed":
        this.set({ rulesTicks: { ...this.state.rulesTicks, [e.data.botId]: (this.state.rulesTicks[e.data.botId] ?? 0) + 1 } });
        return;
      case "trigger.changed": {
        const list = this.state.triggers[e.data.botId];
        if (e.data.removedId) {
          const openTriggers = { ...this.state.openTriggers };
          if (openTriggers[e.data.botId] === e.data.removedId) delete openTriggers[e.data.botId];
          this.set({ openTriggers, ...(list ? { triggers: { ...this.state.triggers, [e.data.botId]: list.filter((t) => t.id !== e.data.removedId) } } : {}) });
        } else if (e.data.trigger && list) this.putTrigger(e.data.trigger);
        return;
      }
      case "trigger.run":
        this.putRun(e.data.run);
        return;
      case "channel.changed": {
        if (e.data.removedId) {
          const id = e.data.removedId;
          const channelMessages = { ...this.state.channelMessages };
          delete channelMessages[id];
          this.set({
            channels: this.state.channels.filter((c) => c.id !== id),
            channelMessages,
            openChannelId: this.state.openChannelId === id ? null : this.state.openChannelId,
          });
        } else if (e.data.channel) this.putChannel(e.data.channel);
        return;
      }
      case "channel.message":
        this.putChannelMessage(e.data.message);
        return;
      case "artifact.changed":
        this.artifactChanged(e.data);
        return;
      case "browser.changed":
        this.set({ browser: e.data.state });
        return;
      case "browser.frame":
      case "browser.prompt":
      case "browser.ended":
        for (const l of feeds) l(e);
        return;
      case "connection.changed":
        this.set({ connections: e.data });
        return;
      case "backup.changed":
        this.backupEvents++;
        this.set({ backup: e.data.backup });
        return;
      case "notify.changed":
        this.notifyEvents++;
        this.set({ notify: e.data.notify });
        return;
      case "chat.changed":
        this.chatEvents++;
        this.set({ chat: e.data.chat });
        return;
      case "aboutYou.changed":
        this.aboutYouEvents++;
        this.set({ aboutYou: e.data.aboutYou });
        return;
      // step 7c: to-dos for the person
      case "todo.changed": {
        const todo = e.data.todo;
        const at = this.state.todos.findIndex((t) => t.id === todo.id);
        this.set({ todos: at < 0 ? [...this.state.todos, todo] : this.state.todos.map((t, i) => (i === at ? todo : t)) });
        return;
      }
      case "todo.removed":
        this.set({ todos: this.state.todos.filter((t) => t.id !== e.data.todoId) });
        return;
      case "upcoming.updated":
        this.set({ upcoming: e.data.upcoming });
        return;
      // Step 7b.
      case "settings.changed":
        this.settingsEvents++;
        this.set({ settings: e.data.settings });
        return;
      case "calendar.changed":
        this.calendarEvents++;
        this.set({ calendar: e.data.calendar });
        return;
      case "providers.changed":
        this.set({ providers: e.data.providers });
        return;
      case "usage.changed":
        this.set({ usage: e.data.usage });
        return;
      case "chat.titled": {
        const had = this.state.chatTitles[e.data.botId];
        if (!had?.loaded) return;
        const key = (c: ChatTitle) => `${c.threadId}:${c.fromSeq}`;
        const rest = had.chats.filter((c) => key(c) !== key(e.data.chat));
        const chats = [e.data.chat, ...rest].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        this.set({ chatTitles: { ...this.state.chatTitles, [e.data.botId]: { ...had, chats } } });
        return;
      }
      case "status.updated":
        this.set(e.data.models ? { status: e.data.status, models: e.data.models } : { status: e.data.status });
        return;
    }
  }

  private dropCard(cardId: string, reason: Events["card.removed"]["reason"]): void {
    this.set({
      cards: this.state.cards.filter((c) => c.id !== cardId),
      removedReasons: { ...this.state.removedReasons, [cardId]: reason },
    });
  }

  // ------------------------------------------------------------ from the window

  openBot(botId: string): void {
    try {
      localStorage.setItem(LAST_BOT_KEY, botId);
    } catch {
      // Remembering the open bot is a convenience only.
    }
    // An artifact belongs to the bot it was opened for: choosing another bot closes it. The browser stays.
    if (this.state.panel?.kind === "artifact" && this.state.panel.botId !== botId) this.setPanel(null);
    if (this.state.appSettings) this.closeAppSettings();
    // On a phone a bot opens on a screen of its own.
    this.set(isPhone() ? { openBotId: botId, openChannelId: null, phoneScreen: "bot" } : { openBotId: botId, openChannelId: null });
  }

  /** On a phone: shows a screen (state/screens.ts pushes its history entry). */
  setPhoneScreen(screen: PhoneScreen): void {
    if (screen !== this.state.phoneScreen) this.set({ phoneScreen: screen });
  }

  /** On a phone: shows what a history entry holds, in one change, without what opening a bot by hand also does. */
  showPhoneView(v: { screen: PhoneScreen; bot?: string; channel?: string; tab?: BotTab; settings: boolean }): void {
    const next: Partial<AppState> = { phoneScreen: v.screen, appSettings: v.settings };
    if (v.bot) {
      next.openBotId = v.bot;
      next.openChannelId = null;
      next.tabs = { ...this.state.tabs, [v.bot]: v.tab ?? "chat" };
      try {
        localStorage.setItem(LAST_BOT_KEY, v.bot);
      } catch {
        // A convenience only.
      }
    } else if (v.channel) next.openChannelId = v.channel;
    if (v.settings !== this.state.appSettings && this.state.panel) notePlace();
    this.set(next);
  }

  /** Opens a channel's page in the reading panel, or goes back to the open bot with null. */
  openChannel(channelId: string | null): void {
    if (channelId && this.state.panel?.kind === "artifact") this.setPanel(null);
    if (this.state.appSettings) this.closeAppSettings();
    this.set(isPhone() && channelId ? { openChannelId: channelId, phoneScreen: "bot" } : { openChannelId: channelId });
  }

  /**
   * Opens the settings page for Pobots as a whole. The page that was open (a bot's or a channel's)
   * stays laid out underneath, out of sight, and so does what is open beside it, so closing shows
   * both exactly as they were.
   */
  openAppSettings(section?: SettingsSection): void {
    if (section && section !== this.state.appSettingsSection) this.setSettingsSection(section);
    if (this.state.appSettings) return;
    // What was open beside the chat steps aside while the page is open; the chat keeps its place.
    if (this.state.panel) notePlace();
    markAppSettings(true);
    this.set({ appSettings: true });
  }

  closeAppSettings(): void {
    if (!this.state.appSettings) return;
    if (this.state.panel) notePlace();
    markAppSettings(false);
    this.set({ appSettings: false });
  }

  setBackup(backup: BackupState): void {
    this.set({ backup });
  }

  /** Step 7b: shows another section of the settings window. */
  setSettingsSection(section: SettingsSection): void {
    if (section === this.state.appSettingsSection) return;
    markSection(section);
    this.set({ appSettingsSection: section });
  }

  setSettings(settings: PobotsSettings): void {
    this.set({ settings });
  }

  setCalendar(calendar: CalendarState): void {
    this.set({ calendar });
  }

  setProviders(providers: ProvidersState): void {
    this.set({ providers });
  }

  setUsage(usage: UsageState): void {
    this.set({ usage });
  }

  setChatTitles(botId: string, page: { chats: ChatTitle[]; hasMore: boolean }, more: boolean): void {
    const had = this.state.chatTitles[botId];
    const chats = more && had ? [...had.chats, ...page.chats.filter((c) => !had.chats.some((x) => x.threadId === c.threadId && x.fromSeq === c.fromSeq))] : page.chats;
    this.set({ chatTitles: { ...this.state.chatTitles, [botId]: { chats, hasMore: page.hasMore, loaded: true } } });
  }

  setChat(chat: ChatSettings): void {
    this.set({ chat });
  }

  setAboutYou(aboutYou: string): void {
    this.set({ aboutYou });
  }

  setNotify(notify: NotifyState): void {
    this.set({ notify });
  }

  setAddingChannel(adding: boolean): void {
    this.set({ addingChannel: adding });
  }

  /** Adds or replaces a channel, keeping the order they were made in. A newer last message is kept. */
  putChannel(channel: Channel): void {
    const old = this.state.channels.find((c) => c.id === channel.id);
    const last = newerMessage(old?.lastMessage, channel.lastMessage);
    const next: Channel = { ...channel, ...(last ? { lastMessage: last } : {}) };
    this.set({ channels: old ? this.state.channels.map((c) => (c.id === channel.id ? next : c)) : [...this.state.channels, next] });
  }

  /** A message came in on a channel or changed: put it in the channel's list (newest first) and as its last. */
  putChannelMessage(message: ChannelMessage): void {
    const next: Partial<AppState> = {};
    const m = this.state.channelMessages[message.channelId];
    if (m) {
      const known = m.messages.some((x) => x.id === message.id);
      const messages = known ? m.messages.map((x) => (x.id === message.id ? message : x)) : [message, ...m.messages].sort((a, b) => b.at.localeCompare(a.at));
      next.channelMessages = { ...this.state.channelMessages, [message.channelId]: { ...m, messages } };
    }
    const c = this.state.channels.find((x) => x.id === message.channelId);
    if (c && newerMessage(c.lastMessage, message) === message)
      next.channels = this.state.channels.map((x) => (x.id === c.id ? { ...x, lastMessage: message } : x));
    if (next.channelMessages || next.channels) this.set(next);
  }

  setChannelMessages(channelId: string, state: ChannelMessagesState): void {
    this.set({ channelMessages: { ...this.state.channelMessages, [channelId]: state } });
  }

  setTab(botId: string, tab: BotTab): void {
    this.set({ tabs: { ...this.state.tabs, [botId]: tab } });
  }

  setOpenFile(botId: string, path: string | null): void {
    const openFiles = { ...this.state.openFiles };
    if (path === null) delete openFiles[botId];
    else openFiles[botId] = path;
    this.set({ openFiles });
  }

  setEngineHere(here: boolean): void {
    if (here !== this.state.engineHere) this.set({ engineHere: here });
  }

  setUnsaved(unsaved: Unsaved | null): void {
    const now = this.state.unsaved;
    if (now === unsaved || (now && unsaved && now.botId === unsaved.botId && now.what === unsaved.what)) return;
    this.set({ unsaved });
  }

  setAdding(adding: boolean): void {
    this.set({ adding });
  }

  /**
   * Goes somewhere else in the window: another bot, tab or file. With unsaved text in an editor,
   * asks first and only goes on when the person says so.
   */
  leave(go: () => void): void {
    const unsaved = this.state.unsaved;
    if (!unsaved) return go();
    this.set({
      leaveAsk: {
        unsaved,
        go: () => {
          this.set({ leaveAsk: null, unsaved: null });
          go();
        },
      },
    });
  }

  stayHere(): void {
    this.set({ leaveAsk: null });
  }

  putBot(bot: Bot): void {
    this.event({ event: "bot.updated", data: { bot } });
  }

  /** Adds or replaces a trigger in its bot's list, keeping the order it was made in. */
  putTrigger(trigger: Trigger): void {
    const list = this.state.triggers[trigger.botId];
    if (!list) return;
    const known = list.some((t) => t.id === trigger.id);
    // A run event may be newer than the trigger copy that comes with a save; keep the newer run.
    const old = list.find((t) => t.id === trigger.id);
    const lastRun = newerRun(old?.lastRun, trigger.lastRun);
    const next = { ...trigger, ...(lastRun ? { lastRun } : {}) };
    this.set({ triggers: { ...this.state.triggers, [trigger.botId]: known ? list.map((t) => (t.id === trigger.id ? next : t)) : [...list, next] } });
  }

  setTriggers(botId: string, triggers: Trigger[]): void {
    this.set({ triggers: { ...this.state.triggers, [botId]: triggers } });
  }

  /** A run started or changed: put it in the trigger's runs (newest first) and as its last run. */
  putRun(run: TriggerRun): void {
    const next: Partial<AppState> = {};
    const r = this.state.runs[run.triggerId];
    if (r) {
      const known = r.runs.some((x) => x.id === run.id);
      const runs = known ? r.runs.map((x) => (x.id === run.id ? run : x)) : [run, ...r.runs].sort((a, b) => b.at.localeCompare(a.at));
      next.runs = { ...this.state.runs, [run.triggerId]: { ...r, runs } };
    }
    const list = this.state.triggers[run.botId];
    const t = list?.find((x) => x.id === run.triggerId);
    if (list && t && newerRun(t.lastRun, run) === run)
      next.triggers = { ...this.state.triggers, [run.botId]: list.map((x) => (x.id === t.id ? { ...x, lastRun: run } : x)) };
    if (next.runs || next.triggers) this.set(next);
  }

  setRuns(triggerId: string, runs: RunsState): void {
    this.set({ runs: { ...this.state.runs, [triggerId]: runs } });
  }

  /** Opens a trigger in its bot's Triggers tab, or the list when `triggerId` is null. */
  openTrigger(botId: string, triggerId: string | null): void {
    const openTriggers = { ...this.state.openTriggers };
    if (triggerId === null) delete openTriggers[botId];
    else openTriggers[botId] = triggerId;
    this.set({ openTriggers });
  }

  /** Replaces the open helper threads of every bot at once: from a history entry, or after a change. */
  setHelperStacks(helpers: HelperStacks): void {
    // Going back from the open bot's helper thread: its row takes the focus again.
    const open = this.state.openBotId;
    const was = open ? this.state.helpers[open] : undefined;
    const now = open ? helpers[open] : undefined;
    if (was?.length && (now?.length ?? 0) < was.length) helperReturn.itemId = was[(now?.length ?? 0)]!.itemId;
    this.set({ helpers });
  }

  focusChat(botId: string, turnId: string): void {
    this.set({ chatFocus: { botId, turnId, n: (this.state.chatFocus?.n ?? 0) + 1 }, tabs: { ...this.state.tabs, [botId]: "chat" } });
  }

  /** "Show in chat" from the Artifacts tab: the chat scrolls to the newest row of this artifact. */
  focusArtifactInChat(botId: string, artifactId: string): void {
    this.set({ chatFocus: { botId, artifactId, n: (this.state.chatFocus?.n ?? 0) + 1 }, tabs: { ...this.state.tabs, [botId]: "chat" } });
  }

  // ------------------------------------------------------------ artifacts

  setArtifacts(botId: string, artifacts: Artifact[]): void {
    // What arrived by event while the list was read is at least as new as the list.
    const now = this.state.artifacts[botId] ?? [];
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    for (const a of now) {
      const listed = byId.get(a.id);
      if (!listed || listed.updatedAt < a.updatedAt || listed.rev < a.rev) byId.set(a.id, a);
    }
    const removed = this.state.removedArtifacts;
    this.set({ artifacts: { ...this.state.artifacts, [botId]: [...byId.values()].filter((a) => !removed[a.id]).sort(byNewest) } });
  }

  private artifactChanged({ botId, artifact, removedId }: Events["artifact.changed"]): void {
    if (removedId) {
      const list = this.state.artifacts[botId];
      this.set({
        removedArtifacts: { ...this.state.removedArtifacts, [removedId]: true },
        ...(list ? { artifacts: { ...this.state.artifacts, [botId]: list.filter((a) => a.id !== removedId) } } : {}),
      });
      if (this.state.panel?.kind === "artifact" && this.state.panel.artifactId === removedId) this.setPanel(null);
      return;
    }
    if (artifact) this.putArtifact(artifact);
  }

  /** Adds or replaces an artifact in its bot's list, newest change first. Known before the list is read, too. */
  putArtifact(artifact: Artifact): void {
    const list = this.state.artifacts[artifact.botId] ?? [];
    const removedArtifacts = { ...this.state.removedArtifacts };
    delete removedArtifacts[artifact.id];
    const next = [artifact, ...list.filter((a) => a.id !== artifact.id)].sort(byNewest);
    this.set({ artifacts: { ...this.state.artifacts, [artifact.botId]: next }, removedArtifacts });
  }

  /** An artifact the engine no longer knows (opened after it was removed elsewhere): its rows stay as lines. */
  forgetArtifact(botId: string, artifactId: string): void {
    const list = this.state.artifacts[botId];
    this.set({
      removedArtifacts: { ...this.state.removedArtifacts, [artifactId]: true },
      ...(list ? { artifacts: { ...this.state.artifacts, [botId]: list.filter((a) => a.id !== artifactId) } } : {}),
    });
    if (this.state.panel?.kind === "artifact" && this.state.panel.artifactId === artifactId) this.setPanel(null);
  }

  /** Opens an artifact or the browser in the panel (swapping what it showed), changes it, or closes it with null. */
  setPanel(panel: Panel | null): void {
    const now = this.state.panel;
    if (samePanel(now, panel)) return;
    // Opening, closing or filling changes the chat's width: it keeps the row being opened or closed, or the line at its top, in place.
    const which = panel ?? now;
    // Swapping an artifact for the browser changes the width too: each has its own.
    const swapped = !!now && !!panel && now.kind !== panel.kind && shareOf(this.state, now.kind) !== shareOf(this.state, panel.kind);
    if (!now !== !panel || now?.full !== panel?.full || swapped) notePlace(which ? panelRows(which) : undefined);
    try {
      if (panel) sessionStorage.setItem(PANEL_KEY, JSON.stringify(panel));
      else sessionStorage.removeItem(PANEL_KEY);
    } catch {
      // Keeping the panel open across a reload is a convenience only.
    }
    this.set({ panel });
  }

  setBrowser(state: BrowserState): void {
    this.set({ browser: state });
  }

  /** A workspace the window learned of before "browser.changed" brought it (the person's own, just made). */
  putBrowserSpace(space: BrowserSpace): void {
    const b = this.state.browser;
    const spaces = b.spaces.some((x) => x.id === space.id) ? b.spaces.map((x) => (x.id === space.id ? space : x)) : [...b.spaces, space];
    this.set({ browser: { ...b, available: true, spaces } });
  }

  setBlockedLink(link: { url: string; title: string } | null): void {
    this.set({ blockedLink: link });
  }

  /** The width of the open panel: the browser's own, or an artifact's. */
  setPanelShare(share: number): void {
    const browser = this.state.panel?.kind === "browser";
    if (share === shareOf(this.state)) return;
    if (this.state.panel) notePlace();
    try {
      localStorage.setItem(browser ? BROWSER_SHARE_KEY : SHARE_KEY, String(share));
    } catch {
      // Remembering the width is a convenience only.
    }
    this.set(browser ? { browserShare: share } : { panelShare: share });
  }

  clearChatFocus(): void {
    if (this.state.chatFocus) this.set({ chatFocus: null });
  }

  putThread(threadId: string, thread: ThreadState): void {
    this.set({ threads: { ...this.state.threads, [threadId]: thread } });
  }

  thread(threadId: string): ThreadState {
    return this.state.threads[threadId] ?? emptyThread;
  }
}

/** The newer of two runs of the same trigger: the same run in a later state, or a later run. */
function newerRun(a: TriggerRun | undefined, b: TriggerRun | undefined): TriggerRun | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.id === b.id) return b;
  return b.at >= a.at ? b : a;
}

/** The newer of two channel messages: the same one in a later state, or a later one. */
function newerMessage(a: ChannelMessage | undefined, b: ChannelMessage | undefined): ChannelMessage | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.id === b.id) return b;
  return b.at >= a.at ? b : a;
}

export const store = new Store();

/** Reads one slice of the state. The selector must return something stable (a value from the state). */
export function useAppState<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
