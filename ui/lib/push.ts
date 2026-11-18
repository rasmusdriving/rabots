// Notifications when the Pobots page is not open: the browser's side (docs/build/step-push.md and
// the groundwork's sections 2, 5, 6 and 7). Started once from ui/main.tsx.
//
// - What this browser can do (a `Here` state, ui/lib/notify.ts), read once at start; the permission
//   is read again whenever the page comes back into view.
// - The service worker (/sw.js, built from ui/sw.ts) is registered at start only when notifications
//   were allowed here before; otherwise when the Notifications section is shown, so it is ready
//   before "Turn on for this device" is pressed. Never in the desktop window (a file page cannot
//   have one) and never with the mock unless a check stands in for the browser.
// - Turning on calls the browser's subscribe straight from the press, with nothing awaited before
//   it, as an iPhone needs. The page never asks for permission by itself.
// - Every start with permission "granted" says "still here" (`notify.subscribe` with asked false).
//   The engine refuses an address the push service called gone ("conflict"), by every way in: this
//   device then reads "Off", its row says it stopped working, and only "Turn on" with a fresh
//   address mends it. A subscription the browser renewed by itself reaches the engine through the
//   service worker's renewal; the page never names another device in its place from shared storage.
// - Right before the page sends an address (still here, or Turn on), it reads the browser's
//   subscription again and sends only when that address is still the browser's current one.
// - "On for this device" holds only when the browser has a subscription now and the engine has a
//   working row for exactly that address. Every tab reads the browser's subscription again when
//   notify.changed comes, when it comes into view, and when another tab says it changed something
//   (the `storage` event of the remembered id). No polling.
// - Presence (`notify.presence`): on connect, on focus, blur and visibility changes (one word after
//   300 ms of quiet), on use at most once a minute, and every NOTIFY_PRESENCE_EVERY_MS while visible.
//   It says how long ago the last key, pointer or touch came (`idleMs`), so the engine counts the
//   quiet from that moment.
// - A click on a notification: an open window gets { pobots: "open", bot, open } from the service
//   worker; a new window gets the same as "/?bot=<id>&open=needs|chat", read once after the first
//   snapshot and then taken out of the address bar.
// - Tidy on open: notifications of this device whose card is no longer open, and the "finished"
//   ones of the bot the window shows, are closed. A notification is never taken back with a push.
import { useSyncExternalStore } from "react";
import { NOTIFY_PRESENCE_EVERY_MS, type NotificationOpen, type NotifyDevice } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { forgetNotifyDevice, sayPresence, subscribeNotify, testNotify } from "../state/actions";
import { forgetChatPlace } from "../state/chat-place";
import { phoneGo } from "../state/screens";
import { store } from "../state/store";
import { inShell, params } from "./env";
import { BROWSER_FAILED, BROWSER_STUCK, deviceLabel, fromBase64url, base64url, NOT_KEPT, platformOf, tagOf, testLine, type Here, type Platform } from "./notify";
import { isPhone } from "./phone";

/**
 * This browser's own device id, as the engine last kept it, or nothing after this browser dropped
 * its subscription. Shared by the tabs: a change of it is how one tab tells the others to read the
 * browser's subscription again (the `storage` event). Never used to name a device in `replaces`.
 */
const DEVICE_KEY = "pobots.notify.device";
/** Use is said at most once in this time. */
const USE_WORD_MS = 60_000;
/** One word about presence after this much quiet, for focus, blur and visibility. */
const QUIET_MS = 300;

type Base = "desktop" | "insecure" | "cannot" | "ios-browser" | "ios-old" | "ok";
type Permission = "default" | "granted" | "denied";

declare global {
  interface Window {
    /** Set by the checks' stand-in for the browser's notifications (scripts/ui-check.mjs, --only=push). */
    __pobotsPushStandIn?: boolean;
  }
}

const mock = params.get("mock") === "1";

// ------------------------------------------------------------ what the browser is

function standaloneNow(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

const platform: Platform = platformOf(navigator.userAgent, { platform: navigator.platform, touchPoints: navigator.maxTouchPoints, standalone: standaloneNow() });
const label = deviceLabel(platform);

function baseNow(): Base {
  if (inShell) return "desktop";
  // The mock in a plain browser has no real engine to send to: it never touches the browser's own notifications.
  if (mock && window.__pobotsPushStandIn !== true) return "cannot";
  if (!window.isSecureContext) return "insecure";
  if (platform.ios && !platform.standalone) return "ios-browser";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return platform.ios ? "ios-old" : "cannot";
  return "ok";
}

function permissionNow(): Permission {
  try {
    const p = Notification.permission;
    return p === "granted" || p === "denied" ? p : "default";
  } catch {
    return "default";
  }
}

// ------------------------------------------------------------ the state, for the section

let base: Base = "cannot";
let permission: Permission = "default";
/** The browser's own question is open, from his press. */
let asking = false;
/** Looking at start whether the subscription is still there. */
let checking = false;
/** The device id of this browser's subscription, as this tab last read it, or null when it has none. */
let subId: string | null = null;
/** Turning on or off is under way in this tab: a reading again waits for it to end. */
let busy = false;
let registration: ServiceWorkerRegistration | null = null;
let registering: Promise<ServiceWorkerRegistration | null> | null = null;

export interface PushView {
  here: Here;
  /** This browser's device id when it gets notifications, else null. */
  deviceId: string | null;
  /** The device id of this browser's subscription, also when Pobots no longer sends to it ("This device" in the list). */
  ownId: string | null;
  /** The browser has not asked yet: the press on "Turn on" brings its question. */
  notAsked: boolean;
  /** "Turn on" can be pressed: the service worker is ready and the engine's key is known. */
  ready: boolean;
  platform: Platform;
  label: string;
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function hereNow(): Here {
  if (base !== "ok") return base;
  if (asking) return "asking";
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  if (checking && !subId) return "checking";
  const notify = store.get().notify;
  return subId && notify?.devices.some((d) => d.id === subId && !d.goneAt) ? "on" : "off";
}

let view: PushView | null = null;
let viewKey = "";
function viewNow(): PushView {
  const here = hereNow();
  const ready = !!registration && !!store.get().notify;
  const deviceId = here === "on" ? subId : null;
  const ownId = base === "ok" ? subId : null;
  const key = `${here}|${deviceId}|${ownId}|${permission}|${ready}`;
  if (!view || key !== viewKey) {
    viewKey = key;
    view = { here, deviceId, ownId, notAsked: permission === "default", ready, platform, label };
  }
  return view;
}

/** The state of this device for the Notifications section. */
export function usePush(): PushView {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const off = store.subscribe(l);
      return () => {
        listeners.delete(l);
        off();
      };
    },
    viewNow,
  );
}

/** This browser's device id when it gets notifications here, else undefined. */
const deviceNow = (): string | undefined => (hereNow() === "on" ? (subId ?? undefined) : undefined);

// ------------------------------------------------------------ the service worker

function register(): Promise<ServiceWorkerRegistration | null> {
  if (base !== "ok") return Promise.resolve(null);
  registering ??= navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then((r) => {
      registration = r;
      emit();
      void tidy();
      return r;
    })
    .catch(() => {
      registering = null;
      return null;
    });
  return registering;
}

/** The Notifications section is shown: the registration gets ready before "Turn on" is pressed. */
export function preparePush(): void {
  if (base === "ok") void register();
}

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // A convenience only: without it a renewed address becomes a new row.
  }
};

/** The device id the engine gives an address: SHA-256 of it, base64url, the first 22 characters. */
async function idOf(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return base64url(new Uint8Array(hash)).slice(0, 22);
}

/** Only what the engine needs: the address and the two keys, never anything else the browser adds. */
function subscriptionOf(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } };
}

/** Whether a subscription was made with the engine's key. Unknown (an older browser) counts as yes. */
function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options?.applicationServerKey;
  if (!have) return true;
  const want = fromBase64url(publicKey);
  const got = new Uint8Array(have);
  return !!want && want.length === got.length && want.every((b, i) => b === got[i]);
}

/**
 * `replaces`: the id of the address this tab actually held before, when it is another and the
 * engine still lists it. Never an id from shared storage, which another tab may have moved on.
 */
function replacesFor(id: string, before: string | null): { replaces?: string } {
  return before && before !== id && store.get().notify?.devices.some((d) => d.id === before) ? { replaces: before } : {};
}

/** Whether `sub` is still the browser's current subscription, read again right now. */
async function stillCurrent(reg: ServiceWorkerRegistration, sub: PushSubscription): Promise<boolean> {
  try {
    return (await reg.pushManager.getSubscription())?.endpoint === sub.endpoint;
  } catch {
    return false;
  }
}

let rechecking: Promise<void> | null = null;
let recheckAgain = false;
/**
 * Reads the browser's subscription again, so this tab says "on" only while the browser has one and
 * the engine works with exactly that address. On notify.changed, on coming into view, and when
 * another tab says it changed something. Never while this tab turns notifications on or off.
 */
function recheck(): void {
  if (base !== "ok" || !registration || busy || checking) return;
  if (rechecking) {
    recheckAgain = true;
    return;
  }
  const reg = registration;
  rechecking = (async () => {
    do {
      recheckAgain = false;
      let id: string | null;
      try {
        const sub = await reg.pushManager.getSubscription();
        id = sub ? await idOf(sub.endpoint) : null;
      } catch {
        return;
      }
      if (busy || checking) return;
      if (id !== subId) {
        subId = id;
        emit();
        sendPresence();
      }
    } while (recheckAgain);
  })().finally(() => {
    rechecking = null;
  });
}

/** On every start with permission "granted": tells the engine this device is still here. */
async function sayStillHere(): Promise<void> {
  checking = true;
  emit();
  try {
    const reg = await register();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    const notify = store.get().notify;
    if (!sub || !notify) {
      subId = null;
      return;
    }
    if (!sameKey(sub, notify.publicKey)) {
      // The engine has a new key pair: this subscription can never be used again.
      await sub.unsubscribe().catch(() => false);
      subId = null;
      remember(null);
      return;
    }
    const before = subId;
    const id = await idOf(sub.endpoint);
    subId = id;
    emit();
    // Another tab may have dropped or replaced it meanwhile: only the browser's current address is sent.
    if (!(await stillCurrent(reg, sub))) {
      const now = await reg.pushManager.getSubscription().catch(() => null);
      subId = now ? await idOf(now.endpoint) : null;
      return;
    }
    try {
      const { deviceId } = await subscribeNotify({ subscription: subscriptionOf(sub), label, asked: false, ...replacesFor(id, before) });
      subId = deviceId;
      remember(deviceId);
    } catch {
      // Forgotten elsewhere ("not_found"), or the engine is not reachable: this device reads "Off"
      // until he turns it on again, and is never added back by itself.
    }
  } catch {
    subId = null;
  } finally {
    checking = false;
    emit();
    sendPresence();
  }
}

// ------------------------------------------------------------ turning on and off, the test

export type Outcome = { problem?: string };

/**
 * "Turn on for this device". Must be called straight from the press: the browser's subscribe (which
 * brings its question when it has not asked yet) is the first thing that happens, with nothing
 * awaited before it. The order:
 *   1. pushManager.subscribe, straight from the press (the question, when the browser has not asked;
 *      otherwise the browser gives the subscription it has, or a new one);
 *   2. when that address is one the push service called gone (its row has goneAt), or was made with
 *      another key: unsubscribe it, then pushManager.subscribe again for a fresh address (the
 *      permission is granted by then, so nothing is asked). When the unsubscribe fails, or the
 *      browser hands back the same address, it stops there and says so (BROWSER_STUCK): that
 *      address is never sent as on;
 *   3. the browser's subscription read again: only when it is still the one in hand,
 *      notify.subscribe with asked true, and `replaces` naming the row of the address this tab held
 *      before (the gone row), so the fresh address takes that row's place.
 */
export function turnOn(): Promise<Outcome> {
  const reg = registration;
  const notify = store.get().notify;
  const key = notify && fromBase64url(notify.publicKey);
  if (!reg || !key) return Promise.resolve({});
  busy = true;
  const before = subId;
  let first: Promise<PushSubscription>;
  try {
    first = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    first = Promise.reject(e);
  }
  if (permission === "default") {
    asking = true;
    emit();
  }
  return (async (): Promise<Outcome> => {
    try {
      let sub: PushSubscription;
      try {
        sub = await first;
      } catch {
        asking = false;
        permission = permissionNow();
        // Said no: the state says blocked. Closed the question: off again. Allowed, and still failed: say so.
        return permission === "granted" ? { problem: BROWSER_FAILED } : {};
      }
      permission = permissionNow();
      let id = await idOf(sub.endpoint);
      // The address this tab held before: what a fresh one takes the place of.
      let held = before;
      // An address the push service has called gone (or one made with an older key) is replaced by a new one.
      const gone = store.get().notify?.devices.some((d) => d.id === id && d.goneAt) ?? false;
      if (gone || !sameKey(sub, store.get().notify?.publicKey ?? "")) {
        const old = sub.endpoint;
        held = id;
        const dropped = await sub.unsubscribe().catch(() => false);
        if (!dropped) return { problem: BROWSER_STUCK };
        // The other tabs read the browser's subscription again.
        remember(null);
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch {
          return { problem: BROWSER_FAILED };
        }
        // The same address handed back is as dead as before: never sent as on.
        if (sub.endpoint === old) return { problem: BROWSER_STUCK };
        id = await idOf(sub.endpoint);
      }
      // Another tab may have changed the subscription meanwhile: only the browser's current address is sent.
      if (!(await stillCurrent(reg, sub))) return { problem: BROWSER_FAILED };
      try {
        const { deviceId } = await subscribeNotify({ subscription: subscriptionOf(sub), label, asked: true, ...replacesFor(id, held) });
        subId = deviceId;
        remember(deviceId);
        return {};
      } catch (e) {
        return { problem: NOT_KEPT + messageOf(e) };
      }
    } finally {
      asking = false;
      busy = false;
      // What this tab holds now is what the browser has now, whatever happened above.
      await readAgain(reg);
      emit();
      sendPresence();
    }
  })();
}

/** After turning on or off: this tab's id is the browser's subscription now. */
async function readAgain(reg: ServiceWorkerRegistration | null): Promise<void> {
  if (!reg) return;
  try {
    const sub = await reg.pushManager.getSubscription();
    subId = sub ? await idOf(sub.endpoint) : null;
  } catch {
    // Kept as it was.
  }
}

/** "Turn off for this device": Pobots forgets it, and the browser drops its subscription. */
export async function turnOff(): Promise<Outcome> {
  const id = subId;
  busy = true;
  try {
    if (id) {
      try {
        await forgetNotifyDevice(id);
      } catch (e) {
        // Already forgotten elsewhere is as good as forgotten here.
        if (!(e instanceof EngineError && e.code === "not_found")) return { problem: messageOf(e) };
      }
    }
    try {
      const sub = await registration?.pushManager.getSubscription();
      await sub?.unsubscribe();
    } catch {
      // The engine sends nothing to it any more either way.
    }
    subId = null;
    // The other tabs read the browser's subscription again.
    remember(null);
    return {};
  } finally {
    busy = false;
    emit();
    sendPresence();
  }
}

/** "Send a test" to this device. The result line, in plain words. */
export async function sendTest(): Promise<string> {
  const id = deviceNow();
  if (!id) return "";
  try {
    const { notify } = await testNotify(id);
    return testLine(notify.devices.find((d: NotifyDevice) => d.id === id)?.last);
  } catch (e) {
    return messageOf(e);
  }
}

// ------------------------------------------------------------ presence

let lastInput = 0;
let lastInputWord = 0;
let quiet: ReturnType<typeof setTimeout> | undefined;

function sendPresence(): void {
  if (!store.get().ready || store.get().connection.phase !== "ready") return;
  const deviceId = deviceNow();
  sayPresence({
    ...(deviceId ? { deviceId } : {}),
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    idleMs: lastInput ? Math.max(0, Date.now() - lastInput) : null,
  });
}

function soon(): void {
  clearTimeout(quiet);
  quiet = setTimeout(sendPresence, QUIET_MS);
}

function listenPresence(): void {
  const changed = () => {
    if (document.visibilityState === "visible") {
      // He may have allowed or blocked notifications in the site's settings meanwhile.
      const p = base === "ok" ? permissionNow() : permission;
      if (p !== permission) {
        permission = p;
        emit();
      }
      // And another tab, or the browser, may have changed the subscription.
      recheck();
      void tidy();
    }
    soon();
  };
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  const used = () => {
    const now = Date.now();
    lastInput = now;
    // On use at most once a minute.
    if (now - lastInputWord < USE_WORD_MS) return;
    lastInputWord = now;
    soon();
  };
  for (const name of ["keydown", "pointerdown", "touchstart"]) window.addEventListener(name, used, { capture: true, passive: true });
  setInterval(() => {
    if (document.visibilityState === "visible") sendPresence();
  }, NOTIFY_PRESENCE_EVERY_MS);
}

// ------------------------------------------------------------ opening the right place

/**
 * Opens what a click on a notification asks for: the bot's chat, or Needs you. A bot that is not
 * there any more opens nothing: the app shows what it shows by itself (Bots on a phone, the bot that
 * is open on the laptop). Only a note from Pobots itself has no bot, and shows Needs you on a phone.
 */
function openAt(target: { bot?: string; open: "chat" | "needs" }): void {
  const s = store.get();
  const bot = target.bot && s.bots.some((b) => b.id === target.bot) ? target.bot : undefined;
  if (target.bot && !bot) return;
  if (isPhone()) {
    if (!bot && target.open !== "needs") return;
    store.leave(() => {
      // What is new is at the foot of the chat: a place kept from before the bot's page opened is not used.
      forgetChatPlace();
      if (bot)
        phoneGo(() => {
          store.setPanel(null);
          store.setTab(bot, "chat");
          store.openBot(bot);
        });
      // On a phone "needs" shows Needs you, one step further than the bot; back leads to the bot.
      if (target.open === "needs")
        phoneGo(() => {
          store.setPanel(null);
          store.closeAppSettings();
          store.setPhoneScreen("needs");
        });
    });
  } else if (bot) {
    // On the laptop the bot opens on its chat; the rail beside it shows what needs him.
    store.leave(() => {
      store.setTab(bot, "chat");
      store.openBot(bot);
    });
  }
  if (bot) void tidy(bot);
}

function isOpen(data: unknown): data is NotificationOpen {
  const d = data as Partial<NotificationOpen> | null;
  return !!d && typeof d === "object" && d.pobots === "open" && (d.open === "chat" || d.open === "needs") && (d.bot === undefined || typeof d.bot === "string");
}

/** The start query a click opened this window with, read once and taken out of the address bar. */
function takeStartQuery(): { bot?: string; open: "chat" | "needs" } | null {
  const open = params.get("open");
  if (open !== "chat" && open !== "needs") return null;
  const bot = params.get("bot") ?? undefined;
  try {
    const u = new URL(location.href);
    u.searchParams.delete("open");
    u.searchParams.delete("bot");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  } catch {
    // The address keeps the query; a reload then opens the same place again, which is harmless.
  }
  return { ...(bot ? { bot } : {}), open };
}

// ------------------------------------------------------------ tidy on open

/** Closes the notifications of this device whose card is no longer open, and the "finished" ones of the bot shown (or `opened`). */
async function tidy(opened?: string): Promise<void> {
  const reg = registration;
  const s = store.get();
  if (!reg || !s.ready || typeof reg.getNotifications !== "function") return;
  let list: Notification[];
  try {
    list = await reg.getNotifications();
  } catch {
    return;
  }
  const now = store.get();
  const shown = opened ?? (isPhone() ? (now.phoneScreen === "bot" && !now.openChannelId ? now.openBotId : null) : now.openChannelId ? null : now.openBotId);
  for (const n of list) {
    const t = tagOf(n.tag);
    if (!t || t.kind === "test") continue;
    let keep = true;
    if (t.kind === "needs") keep = now.cards.some((c) => (c.kind === "approval" || c.kind === "question") && c.botId === t.bot);
    else if (t.kind === "note") keep = t.bot ? now.cards.some((c) => c.kind === "note" && c.botId === t.bot) : now.cards.some((c) => c.kind === "system");
    else keep = !(shown && t.bot === shown && (opened || document.visibilityState === "visible"));
    if (!keep) n.close();
  }
}

// ------------------------------------------------------------ start

let started = false;

export function startPush(): void {
  if (started) return;
  started = true;
  base = baseNow();
  permission = base === "ok" ? permissionNow() : "default";
  listenPresence();

  /** A click that came before the first snapshot: opened once the bots are known. */
  let waiting: { bot?: string; open: "chat" | "needs" } | null = null;
  if (base === "ok") {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      if (!isOpen(e.data)) return;
      const target = { ...(e.data.bot ? { bot: e.data.bot } : {}), open: e.data.open };
      if (store.get().ready) openAt(target);
      else waiting = target;
    });
    // Messages that came before the app was listening are let through now.
    navigator.serviceWorker.startMessages?.();
    if (permission === "granted") void register();
    // Another tab turned notifications on or off, or failed to: read the browser's subscription again.
    window.addEventListener("storage", (e) => {
      if (e.key === DEVICE_KEY || e.key === null) recheck();
    });
  }

  let first = true;
  /** The start query has been read and the first word said: from now on a new connection says it again. */
  let begun = false;
  let phase = store.get().connection.phase;
  let shownBot = store.get().openBotId;
  let notifyWas = store.get().notify;
  store.subscribe(() => {
    const s = store.get();
    // The engine's devices changed (notify.changed, or an answer): read the browser's subscription again.
    if (s.notify !== notifyWas) {
      notifyWas = s.notify;
      if (begun) recheck();
    }
    // Connected (also again after a drop): say how this window stands, tidy the tray. The first
    // time this is done once the start query has been read, below.
    if (s.connection.phase !== phase) {
      phase = s.connection.phase;
      if (phase === "ready" && s.ready && begun) {
        sendPresence();
        void tidy();
      }
    }
    if (s.ready && first) {
      first = false;
      // After the first snapshot, out of the store's own change: the bots are known now.
      setTimeout(() => {
        const start = takeStartQuery() ?? waiting;
        waiting = null;
        if (start) openAt(start);
        if (base === "ok" && permission === "granted") void sayStillHere();
        sendPresence();
        void tidy();
        begun = true;
      }, 0);
    }
    // He opened another bot: its "finished" notifications have been seen.
    if (s.openBotId !== shownBot) {
      shownBot = s.openBotId;
      if (shownBot && registration) void tidy();
    }
  });
}
