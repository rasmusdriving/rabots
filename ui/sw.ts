// The Pobots service worker, built to dist/ui/sw.js and served at /sw.js like any file of the app
// (docs/build/step-push.md, decided 9). It does three things and nothing else:
//
// - "push": shows the message it gets, as it is. The engine made the words (which bot, what kind of
//   thing, never what the chat says) and decided who gets one, so every push is shown: a push that
//   shows nothing is punished by the browsers. A shape it does not know is shown titled "Pobots".
// - "notificationclick": brings an open Pobots window to the front and tells it where to go
//   ({ pobots: "open", bot, open }), or opens the message's address when no window is open.
// - "pushsubscriptionchange": subscribes again with the same key and tells the engine the new
//   address (POST /api/push/renew), which only replaces a device the engine already knows.
//
// It never stands between the page and the engine: no handler for the page's requests, nothing
// stored, no preloading. An update of Pobots is never held back by it. A check reads the built file
// and fails if that ever changes.
import type { NotificationOpen, PushMessage } from "../shared/protocol";

// The parts of the service worker's world used here. The app's own type check knows the page's
// world (DOM), not a worker's, so they are written down here instead.
interface WindowClientLike {
  url: string;
  visibilityState: DocumentVisibilityState;
  focused: boolean;
  focus(): Promise<WindowClientLike>;
  postMessage(message: unknown): void;
}
interface ExtendableEvent extends Event {
  waitUntil(work: Promise<unknown>): void;
}
interface PushEventLike extends ExtendableEvent {
  data: { json(): unknown; text(): string } | null;
}
interface NotificationEventLike extends ExtendableEvent {
  notification: Notification;
}
interface SubscriptionChangeEventLike extends ExtendableEvent {
  oldSubscription: PushSubscription | null;
  newSubscription: PushSubscription | null;
}
interface WorkerScope {
  location: Location;
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<WindowClientLike | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (e: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (e: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (e: NotificationEventLike) => void): void;
  addEventListener(type: "pushsubscriptionchange", listener: (e: SubscriptionChangeEventLike) => void): void;
}

const sw = self as unknown as WorkerScope;
const KINDS = ["needs", "note", "finished", "test"];

// A new version takes over at once: with nothing stored there is nothing to keep in step.
sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

/**
 * A path on the page's own origin, or "/". Never another site. The address is read the way the
 * browser reads it (a tab, a newline or a backslash can turn "/..." into another host), its origin
 * must be the worker's own, and only its path, query and fragment are kept.
 */
function ownPath(url: unknown): string {
  if (typeof url !== "string") return "/";
  try {
    const u = new URL(url, sw.location.origin);
    if (u.origin !== sw.location.origin) return "/";
    const path = u.pathname + u.search + u.hash;
    // A path that starts with two slashes would be read as another host when opened.
    return path.startsWith("/") && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}

/** What a push holds, as the engine sends it, or a plain "Pobots" for a shape this worker does not know. */
function readMessage(data: unknown): { title: string; options: NotificationOptions & { renotify?: boolean } } {
  const m = (data && typeof data === "object" ? data : {}) as Partial<PushMessage>;
  const known = m.v === 1 && typeof m.title === "string" && m.title !== "" && typeof m.body === "string" && typeof m.kind === "string" && KINDS.includes(m.kind);
  const tag = typeof m.tag === "string" && m.tag.startsWith("pobots-") ? m.tag : "";
  return {
    title: known ? m.title! : "Pobots",
    options: {
      body: known ? m.body! : "Open Pobots to see what is new.",
      icon: "/icon-192.png",
      // Android draws this in the status bar; only its shape counts.
      badge: "/badge-96.png",
      data: { url: ownPath(m.url), kind: known ? m.kind : undefined, botId: typeof m.botId === "string" ? m.botId : undefined },
      // One notification per bot and kind: a newer one takes the place of the older and is heard again.
      ...(tag ? { tag, renotify: true } : {}),
    },
  };
}

sw.addEventListener("push", (e) => {
  let data: unknown = null;
  try {
    data = e.data ? e.data.json() : null;
  } catch {
    data = null;
  }
  const { title, options } = readMessage(data);
  e.waitUntil(sw.registration.showNotification(title, options));
});

/** Where a click leads, as the window's message says it: the bot and what to open. Null for the test (just the window). */
function openOf(url: string): NotificationOpen | null {
  let q: URLSearchParams;
  try {
    const u = new URL(ownPath(url), sw.location.origin);
    if (u.origin !== sw.location.origin) return null;
    q = u.searchParams;
  } catch {
    return null;
  }
  const open = q.get("open");
  if (open !== "chat" && open !== "needs") return null;
  const bot = q.get("bot");
  return { pobots: "open", ...(bot ? { bot } : {}), open };
}

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = ownPath((e.notification.data as { url?: unknown } | null)?.url);
  e.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = all.filter((c) => {
        try {
          return new URL(c.url).origin === sw.location.origin;
        } catch {
          return false;
        }
      });
      // A window he can see first, then the one in front, then any.
      const win = mine.find((c) => c.visibilityState === "visible") ?? mine.find((c) => c.focused) ?? mine[0];
      if (!win) {
        await sw.clients.openWindow(url);
        return;
      }
      // Not navigate(): that would load the page again. The window opens the place itself.
      const front = await win.focus().catch(() => win);
      const message = openOf(url);
      if (message) (front ?? win).postMessage(message);
    })(),
  );
});

sw.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      const old = e.oldSubscription;
      let sub = e.newSubscription;
      if (!sub) {
        const key = old?.options?.applicationServerKey;
        if (!key) return;
        sub = await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const json = sub.toJSON();
      await fetch("/api/push/renew", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: old?.endpoint ?? null, subscription: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } } }),
      });
    })().catch(() => undefined),
  );
});
