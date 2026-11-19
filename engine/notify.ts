// Notifications when the Pobots page is not open (docs/build/step-push.md). The engine decides who
// gets one; the page's service worker shows what it gets.
//
//   What counts: a card that waits for the person ("needs": a question or an approval), a note from
//     a bot or from Pobots itself ("note"), and a bot that came to rest after work the person asked
//     for ("finished", also when it stopped on an error). The engine calls `cardAdded` from its own
//     emit of "card.added", and `cameToRest` from the end of a turn; nothing else starts a push.
//   The wait: 5 seconds for needs and note, 15 for finished, then a second look (the card is still
//     open; the bot is still at rest; who is looking). Within one bot and kind, what comes in the 2
//     minutes after a push folds into one more push at the end of those 2 minutes, with the count,
//     and only when something of it is still open.
//   Who is looking: each window says whether it is visible and in front, and how long ago a key, a
//     pointer or a touch last came in it (`presence`). A device whose own window is visible and in
//     front is skipped; while any window is visible, in front and was used within 2 minutes (counted
//     from that last real use, never from when the window said so), every device is skipped. A window
//     silent for 150 seconds is gone.
//   The words: which bot and what kind of thing. Never the chat, a card's title or a note's text.
//   Sending: to each device that is not gone. 429, 5xx, a time-out or no connection get one more try
//     after 30 seconds, only when it is still due then (the same look again, and the time to live
//     worked out again). 404 and 410 mark the device gone. The last send is kept on the device's row.
//   An approval's notification never outlives the approval: its time to live is what is left of it.
//
// Nothing about a device's address or keys ever leaves engine/push.ts: not in an event, a log line,
// an error message or NotifyState.
import { createHash } from "node:crypto";
import type { Card, NotifyDevice, NotifyKind, NotifySend, NotifyState, PushMessage } from "../shared/protocol.js";
import { NOTIFY_PRESENCE_STALE_MS, NOTIFY_QUIET_AFTER_USE_MS } from "../shared/protocol.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";
import { deviceId, NOT_SENT, sendResult, type PushOutcome, type Subscription, type Urgency } from "./push.js";

/** The wait before a push, by kind. */
export const GRACE_MS: Record<NotifyKind, number> = { needs: 5_000, note: 5_000, finished: 15_000 };
/** What comes within this time after a push folds into one more push at its end. */
export const FOLD_MS = 120_000;
/** One more try after this long, for 429, 5xx, a time-out or no connection. */
export const RETRY_MS = 30_000;
/** A bot's name in a title is cut at this many characters. */
export const NAME_MAX = 40;
const HOUR_S = 3600;
/** How long a push service keeps a message for a device that is offline, in seconds. */
export const TTL_S: Record<NotifyKind | "test", number> = { needs: 12 * HOUR_S, note: 12 * HOUR_S, finished: HOUR_S, test: 300 };
export const URGENCY: Record<NotifyKind | "test", Urgency> = { needs: "high", note: "normal", finished: "normal", test: "high" };

/** What the notifier needs of the push store (engine/push.ts). Tests pass a stand-in. */
export interface PushPort {
  publicKey(): string;
  list(): NotifyDevice[];
  has(id: string): boolean;
  keep(sub: Subscription, label: string | undefined, o: { mayAdd: boolean; replaces?: string; renewal?: boolean; at: string }): { id: string; added: boolean };
  forget(id: string): boolean;
  markGone(id: string, at: string): void;
  record(id: string, last: NotifySend): void;
  /** The device's label and push service, for the log. Never the address. */
  describe(id: string): string;
  deliver(id: string, payload: string, opts: { ttl: number; urgency: Urgency; topic: string }): Promise<PushOutcome>;
}

/** The clock and timers. Tests pass a fake clock. */
export interface NotifyTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: NotifyTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** What the notifier needs of the engine. */
export interface NotifyHost {
  /** The bot's name, or undefined when there is no such bot (any more). */
  botName(botId: string): string | undefined;
  /** The cards open now. */
  openCards(): Card[];
  /** The bot is at rest: no turn runs and nothing works in the background. */
  atRest(botId: string): boolean;
  /** Notifications changed: emit "notify.changed". */
  changed(state: NotifyState): void;
  /** Saves the switches in config.json. Throws a plain sentence when it cannot. */
  saveKinds(kinds: Record<NotifyKind, boolean>): void;
}

export type RestOutcome = "finished" | "failed";

export interface Presence {
  deviceId?: string;
  visible: boolean;
  focused: boolean;
  /** How long ago the last key, pointer or touch came in the window, in ms; null when none came since it opened. */
  idleMs: number | null;
}

/** The notification kind of a card: questions and approvals wait for an answer; notes and Pobots' own cards are notes. */
export function kindOfCard(card: Card): NotifyKind {
  return card.kind === "approval" || card.kind === "question" ? "needs" : "note";
}

/**
 * The invisible "format" characters a name loses: the direction controls that can rearrange a title
 * (the marks U+200E, U+200F and U+061C, the embeddings and overrides U+202A to U+202E, the isolates
 * U+2066 to U+2069), the byte order mark and the other hidden ones (zero-width space, word joiner,
 * soft hyphen). Kept: the zero-width non-joiner and joiner (U+200C, U+200D), which Persian and
 * Arabic names and joined emoji need, and the tag characters of flag emoji (U+E0020 to U+E007F).
 */
const HIDDEN = /(?![\u200c\u200d\u{e0020}-\u{e007f}])\p{Cf}/gu;
/** What a title can show: anything but spaces, joiners and marks on nothing. */
const SHOWS = /[^\s\p{Z}\p{M}\u200c\u200d\u{e0020}-\u{e007f}]/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A bot's name for a title: one line, without control characters or the hidden characters above,
 * cut at NAME_MAX letters as a person sees them (grapheme clusters: a joined emoji or a letter with
 * its marks is one, never cut in two). Right-to-left letters stay as they are. A name with nothing
 * left to show is "A bot".
 */
export function shortName(name: string): string {
  const one = name
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  const cut = Array.from(graphemes.segment(one), (g) => g.segment)
    .slice(0, NAME_MAX)
    .join("")
    .trim();
  return SHOWS.test(cut) ? cut : "A bot";
}

/** The push service's Topic: a short hash of the tag (at most 32 characters of base64url). */
export function topicOf(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/**
 * The words of a notification (docs/build/step-push.md, 7). Only the bot's name and the kind of
 * thing; nothing from the chat. `count` above 1 gives the count's words.
 */
export function words(o: { kind: NotifyKind | "test"; name?: string; count?: number; outcome?: RestOutcome; prefix?: string }): { title: string; body: string } {
  const prefix = o.prefix ?? "";
  const name = o.name === undefined ? undefined : shortName(o.name);
  const many = (o.count ?? 1) > 1 ? o.count! : 0;
  let title: string;
  let body: string;
  switch (o.kind) {
    case "needs":
      title = `${name} needs your answer`;
      body = many ? `${many} things wait for you.` : "Open Pobots to answer.";
      break;
    case "note":
      title = name === undefined ? "Pobots has a note for you" : `${name} sent you a note`;
      body = many ? `${many} notes wait for you.` : "Open Pobots to read it.";
      break;
    case "finished":
      if (o.outcome === "failed") {
        title = `${name} stopped`;
        body = "It ran into a problem. Open Pobots to see what happened.";
      } else {
        title = `${name} finished`;
        body = "Open Pobots to read the answer.";
      }
      break;
    default:
      title = "Pobots";
      body = "This is a test. Notifications reach this device.";
  }
  return { title: `${prefix}${title}`, body };
}

/** The whole message for one push. `botId` undefined: a note from Pobots itself. */
export function pushMessage(o: { kind: NotifyKind | "test"; botId?: string; name?: string; count?: number; outcome?: RestOutcome; prefix?: string }): PushMessage {
  const { title, body } = words(o);
  if (o.kind === "test") return { v: 1, kind: "test", title, body, tag: "pobots-test", url: "/" };
  if (o.botId === undefined) return { v: 1, kind: o.kind, title, body, tag: `pobots-system-${o.kind}`, url: "/?open=needs" };
  const bot = encodeURIComponent(o.botId);
  const open = o.kind === "finished" ? "chat" : "needs";
  return { v: 1, kind: o.kind, title, body, tag: `pobots-${o.botId}-${o.kind}`, url: `/?bot=${bot}&open=${open}`, botId: o.botId };
}

/** What a push is about: the kind, the bot, the cards that came, and how the bot came to rest. */
interface Due {
  kind: NotifyKind;
  botId?: string;
  cards: Set<string>;
  outcome?: RestOutcome;
}

interface Group {
  key: string;
  kind: NotifyKind;
  /** Undefined for Pobots' own notes. */
  botId?: string;
  /** "grace": waiting before the first push; "fold": after a push, gathering what comes. */
  phase: "grace" | "fold";
  timer?: unknown;
  /** Cards that came since the last push. */
  cards: Set<string>;
  /** The last way the bot came to rest since the last push. */
  outcome?: RestOutcome;
  events: number;
  quieted?: true;
}

export interface NotifierOptions {
  push: PushPort;
  host: NotifyHost;
  kinds: Record<NotifyKind, boolean>;
  titlePrefix?: string;
  timers?: NotifyTimers;
  graceMs?: Partial<Record<NotifyKind, number>>;
  foldMs?: number;
  retryMs?: number;
}

export class Notifier {
  private readonly push: PushPort;
  private readonly host: NotifyHost;
  private readonly timers: NotifyTimers;
  private readonly prefix: string;
  private readonly graceMs: Record<NotifyKind, number>;
  private readonly foldMs: number;
  private readonly retryMs: number;
  private kinds: Record<NotifyKind, boolean>;
  private groups = new Map<string, Group>();
  private presences = new Map<string, Presence & { at: number; usedAt?: number }>();
  private sending = new Set<Promise<void>>();
  private stopped = false;
  private keyProblemLogged = false;

  constructor(o: NotifierOptions) {
    this.push = o.push;
    this.host = o.host;
    this.timers = o.timers ?? realTimers;
    this.prefix = o.titlePrefix ?? "";
    this.kinds = { ...o.kinds };
    this.graceMs = { ...GRACE_MS, ...(o.graceMs ?? {}) };
    this.foldMs = o.foldMs ?? FOLD_MS;
    this.retryMs = o.retryMs ?? RETRY_MS;
  }

  private iso(): string {
    return new Date(this.timers.now()).toISOString();
  }

  /** The whole state for the page. Never an address or a key. */
  state(): NotifyState {
    let publicKey = "";
    try {
      publicKey = this.push.publicKey();
    } catch (err) {
      if (!this.keyProblemLogged) log.error("The key pair for notifications could not be read or made", err);
      this.keyProblemLogged = true;
    }
    let devices: NotifyDevice[] = [];
    try {
      devices = this.push.list();
    } catch (err) {
      log.error("The devices for notifications could not be read", err);
    }
    return { publicKey, kinds: { ...this.kinds }, devices };
  }

  private changed(): NotifyState {
    const s = this.state();
    this.host.changed(s);
    return s;
  }

  // ------------------------------------------------------------ what happens

  /** A card was put up (the engine's own "card.added"). */
  cardAdded(card: Card): void {
    if (this.stopped) return;
    const kind = kindOfCard(card);
    if (!this.kinds[kind]) return;
    this.event(kind, card.kind === "system" ? undefined : card.botId, (g) => g.cards.add(card.id));
  }

  /** Drop a bot's waiting pushes and retries when it goes on vacation. */
  quietBot(botId: string): void {
    for (const [key, g] of this.groups) {
      if (g.botId !== botId) continue;
      if (g.timer !== undefined) this.timers.clearTimeout(g.timer);
      g.quieted = true;
      this.groups.delete(key);
    }
  }

  /** A card went. Nothing to do now: the wait looks at the open cards again when it ends. */
  cardRemoved(_cardId: string): void {}

  /**
   * A bot came to rest after a turn (and whatever its helpers brought back). Only a turn the person
   * started counts; a stop is never told here.
   */
  cameToRest(botId: string, outcome: RestOutcome, startedBy: string | undefined): void {
    if (this.stopped || startedBy !== "you" || !this.kinds.finished) return;
    this.event("finished", botId, (g) => (g.outcome = outcome));
  }

  private event(kind: NotifyKind, botId: string | undefined, add: (g: Group) => void): void {
    const key = `${botId ?? "system"}:${kind}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { key, kind, ...(botId !== undefined ? { botId } : {}), phase: "grace", cards: new Set(), events: 0 };
      this.groups.set(key, g);
      const group = g;
      g.timer = this.timers.setTimeout(() => this.waitEnded(group), this.graceMs[kind]);
    }
    add(g);
    g.events++;
  }

  /** The wait (or a fold window) ended: look again, and send when something is still due. */
  private waitEnded(g: Group): void {
    g.timer = undefined;
    if (this.stopped) return;
    // What this push is about, kept for the look again before a retry.
    const what: Due = { kind: g.kind, ...(g.botId !== undefined ? { botId: g.botId } : {}), cards: g.cards, ...(g.outcome ? { outcome: g.outcome } : {}) };
    const due = g.events > 0 ? this.due(what) : undefined;
    g.cards = new Set();
    g.events = 0;
    g.outcome = undefined;
    if (!due) {
      this.groups.delete(g.key);
      return;
    }
    const devices = this.targets();
    if (!devices.length) {
      // He is looking, or there is no device: nothing is sent, and the next event starts afresh.
      this.groups.delete(g.key);
      return;
    }
    this.track(this.dispatch(devices, due.message, due.ttl, () => g.quieted ? undefined : this.due(what)));
    g.phase = "fold";
    g.timer = this.timers.setTimeout(() => this.waitEnded(g), this.foldMs);
  }

  /** What is due now for what came (cards, or the way the bot came to rest), or nothing. */
  private due(w: Due): { message: PushMessage; ttl: number } | undefined {
    if (!this.kinds[w.kind]) return undefined;
    const name = w.botId === undefined ? undefined : this.host.botName(w.botId);
    if (w.botId !== undefined && name === undefined) return undefined;
    if (w.kind === "finished") {
      if (!w.outcome || !this.host.atRest(w.botId!)) return undefined;
      return { message: pushMessage({ kind: "finished", botId: w.botId!, name: name!, outcome: w.outcome, prefix: this.prefix }), ttl: TTL_S.finished };
    }
    const open = this.host.openCards().filter((c) => kindOfCard(c) === w.kind && (w.botId === undefined ? c.kind === "system" : c.kind !== "system" && c.botId === w.botId));
    if (!open.some((c) => w.cards.has(c.id))) return undefined;
    let ttl = TTL_S[w.kind];
    if (w.kind === "needs") {
      // Never kept past an approval's life: when every open card is an approval that ends, the time
      // to live is what is left of the last one, and nothing is sent once nothing is left.
      const ends = open.map((c) => (c.kind === "approval" && c.expiresAt ? Date.parse(c.expiresAt) : Number.NaN));
      if (ends.every((e) => Number.isFinite(e))) ttl = Math.min(ttl, Math.floor((Math.max(...ends) - this.timers.now()) / 1000));
      if (ttl < 1) return undefined;
    }
    return { message: pushMessage({ kind: w.kind, ...(w.botId !== undefined ? { botId: w.botId, name: name! } : {}), count: open.length, prefix: this.prefix }), ttl };
  }

  // ------------------------------------------------------------ who is looking

  /**
   * What a window said about itself. The moment of its last use is worked out from `idleMs` (never
   * later than now), so a heartbeat from a window nobody touches does not make the quiet longer.
   */
  presence(conn: string, p: Presence): void {
    const at = this.timers.now();
    const before = this.presences.get(conn);
    const idle = typeof p.idleMs === "number" && Number.isFinite(p.idleMs) ? Math.max(0, p.idleMs) : null;
    const usedAt = idle !== null ? at - idle : before?.usedAt;
    this.presences.set(conn, {
      ...(p.deviceId ? { deviceId: p.deviceId } : {}),
      visible: p.visible,
      focused: p.focused,
      idleMs: idle,
      at,
      ...(usedAt !== undefined ? { usedAt } : {}),
    });
  }

  /** A window's connection closed. */
  dropPresence(conn: string): void {
    this.presences.delete(conn);
  }

  /** The devices a notification goes to now (docs/build/step-push.md, 3). */
  targets(): NotifyDevice[] {
    const now = this.timers.now();
    for (const [conn, p] of this.presences) if (now - p.at >= NOTIFY_PRESENCE_STALE_MS) this.presences.delete(conn);
    const live = [...this.presences.values()];
    if (live.some((p) => p.visible && p.focused && p.usedAt !== undefined && now - p.usedAt < NOTIFY_QUIET_AFTER_USE_MS)) return [];
    const looking = new Set(live.filter((p) => p.visible && p.focused && p.deviceId).map((p) => p.deviceId!));
    let devices: NotifyDevice[] = [];
    try {
      devices = this.push.list();
    } catch (err) {
      log.error("The devices for notifications could not be read", err);
    }
    return devices.filter((d) => !d.goneAt && !looking.has(d.id));
  }

  // ------------------------------------------------------------ sending

  private track(p: Promise<void>): void {
    this.sending.add(p);
    void p.finally(() => this.sending.delete(p));
  }

  /** For tests: resolves when no send is under way. */
  async idle(): Promise<void> {
    while (this.sending.size) await Promise.all([...this.sending]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.timers.setTimeout(r, ms));
  }

  /**
   * Sends one message to the devices. `again`: for one more try after 30 seconds, what is due then
   * (looked at again); without it there is no retry (the test).
   */
  private async dispatch(devices: NotifyDevice[], message: PushMessage, ttl: number, again?: () => { message: PushMessage; ttl: number } | undefined): Promise<void> {
    const first = prepared(message, ttl);
    const retry = again
      ? (id: string) => {
          // The same look as the second look: still open (or still at rest), still switched on, and
          // this device still one to send to; with the time to live worked out again.
          const due = again();
          return due && this.targets().some((d) => d.id === id) ? prepared(due.message, due.ttl) : undefined;
        }
      : undefined;
    await Promise.all(devices.map((d) => this.sendOne(d, message.kind, first, retry)));
    if (!this.stopped) this.changed();
  }

  private async sendOne(device: Pick<NotifyDevice, "id" | "service">, kind: NotifySend["kind"], first: Prepared, retry?: (id: string) => Prepared | undefined): Promise<void> {
    const id = device.id;
    let out: PushOutcome;
    try {
      out = await this.push.deliver(id, first.payload, first.opts);
      if (retry && retryable(out) && !this.stopped) {
        log.info(`Notification to ${this.push.describe(id)}: ${problemOf(out)}; one more try in ${Math.round(this.retryMs / 1000)} seconds`);
        await this.sleep(this.retryMs);
        if (this.stopped || !this.push.has(id)) return;
        const next = retry(id);
        if (next) out = await this.push.deliver(id, next.payload, next.opts);
        else log.info(`Notification to ${this.push.describe(id)}: no longer due, so no second try`);
      }
    } catch (err) {
      log.error(`A notification to ${this.push.describe(id)} could not be sent`, err);
      out = { kind: "error", reason: NOT_SENT };
    }
    this.settle(device, kind, out);
  }

  /** Keeps what came of a send on the device's row, and says it in the log (never the address). */
  private settle(device: Pick<NotifyDevice, "id" | "service">, kind: NotifySend["kind"], out: PushOutcome): void {
    const id = device.id;
    const who = this.push.describe(id);
    try {
      if (out.kind === "gone" || isKeyMismatch(out, device.service)) {
        this.push.markGone(id, this.iso());
        log.info(`Notification to ${who}: the push service says this device no longer takes notifications (${out.kind === "gone" ? out.status : 403}); kept as stopped working`);
        return;
      }
      this.push.record(id, { at: this.iso(), kind, ...sendResult(out) });
    } catch (err) {
      log.error(`What came of a notification to ${who} could not be kept`, err);
    }
    if (out.kind === "sent") log.info(`Notification (${kind}) to ${who}: sent (${out.status})`);
    else log.warn(`Notification (${kind}) to ${who}: ${problemOf(out)}`);
  }

  // ------------------------------------------------------------ the methods

  /** "notify.setKinds". */
  setKinds(patch: Partial<Record<NotifyKind, boolean>>): { notify: NotifyState } {
    const next = { ...this.kinds };
    for (const k of ["needs", "note", "finished"] as const) if (typeof patch[k] === "boolean") next[k] = patch[k];
    try {
      this.host.saveKinds(next);
    } catch (err) {
      throw new EngineError("internal", (err as Error).message || "The settings file could not be written, so nothing was saved.");
    }
    this.kinds = next;
    log.info(`Notifications: needs ${next.needs ? "on" : "off"}, note ${next.note ? "on" : "off"}, finished ${next.finished ? "on" : "off"}`);
    return { notify: this.changed() };
  }

  /** "notify.subscribe". */
  subscribe(p: { subscription: Subscription; label: string; asked: boolean; replaces?: string }): { deviceId: string; notify: NotifyState } {
    const before = JSON.stringify(this.state().devices);
    const { id, added } = this.push.keep(p.subscription, p.label, { mayAdd: p.asked, ...(p.replaces ? { replaces: p.replaces } : {}), at: this.iso() });
    if (added) log.info(`A device was set up for notifications: ${this.push.describe(id)}`);
    else if (p.asked) log.info(`A device was set up for notifications again: ${this.push.describe(id)}`);
    const now = this.state();
    if (JSON.stringify(now.devices) !== before) this.host.changed(now);
    return { deviceId: id, notify: now };
  }

  /**
   * The service worker's renewal (POST /api/push/renew): only a device the engine knows by its old
   * address (gone or working), or by the new one. Never an address the push service called gone.
   */
  renew(old: string | undefined, subscription: Subscription): string {
    const { id } = this.push.keep(subscription, undefined, { mayAdd: false, renewal: true, ...(old ? { replaces: deviceId(old) } : {}), at: this.iso() });
    log.info(`A device renewed its subscription for notifications: ${this.push.describe(id)}`);
    this.changed();
    return id;
  }

  /** "notify.forget". Forgetting a device that is not there changes nothing. */
  forget(id: string): { notify: NotifyState } {
    const who = this.push.describe(id);
    if (this.push.forget(id)) {
      log.info(`Forgot a device for notifications: ${who}`);
      return { notify: this.changed() };
    }
    return { notify: this.state() };
  }

  /** "notify.test": the test notification to one device now, whatever the switches say and whoever is looking. */
  async test(id: string): Promise<{ notify: NotifyState }> {
    const device = this.state().devices.find((d) => d.id === id);
    if (!device) throw new EngineError("not_found", "This device is not set up for notifications.");
    if (device.goneAt) throw new EngineError("conflict", "This device stopped taking notifications. Open Pobots on it and turn notifications on again.");
    const message = pushMessage({ kind: "test", prefix: this.prefix });
    const run = this.sendOne(device, "test", prepared(message, TTL_S.test));
    this.track(run);
    await run;
    return { notify: this.changed() };
  }

  /** The engine stops: nothing more is sent. */
  shutdown(): void {
    this.stopped = true;
    for (const g of this.groups.values()) if (g.timer !== undefined) this.timers.clearTimeout(g.timer);
    this.groups.clear();
    this.presences.clear();
  }
}

/** 429, 5xx, a time-out or no connection: worth one more try. */
export function retryable(out: PushOutcome): boolean {
  if (out.kind === "failed") return out.status === 429 || out.status >= 500;
  return out.kind === "error" && out.unreachable === true;
}

/** Google's 403 when the subscription belongs to another key pair (engine/push.ts reads it): the device is as good as gone. Not confirmed against Google's exact words. */
function isKeyMismatch(out: PushOutcome, service: NotifyDevice["service"]): boolean {
  return out.kind === "failed" && out.status === 403 && service === "Google" && out.keyMismatch === true;
}

/** For the log: only the fixed words the device's row gets too. */
function problemOf(out: PushOutcome): string {
  if (out.kind === "sent") return "sent";
  if (out.kind === "gone") return `gone (${out.status})`;
  const { problem } = sendResult(out);
  return out.kind === "failed" ? `refused (${out.status}) ${problem ?? ""}`.trim() : (problem ?? "");
}

interface Prepared {
  payload: string;
  opts: { ttl: number; urgency: Urgency; topic: string };
}

function prepared(message: PushMessage, ttl: number): Prepared {
  return { payload: JSON.stringify(message), opts: { ttl, urgency: URGENCY[message.kind], topic: topicOf(message.tag) } };
}
