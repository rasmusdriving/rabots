// The words of notifications in Pobots settings (docs/build/step-push.md, decided 12; the groundwork's
// section 5): what this device can do, the three switches, the device rows and the result of a test.
// Plain data and small pure functions, no DOM, so the checks can read them straight from the source.
// The words of a notification itself are made by the engine, never here.
import type { NotifyDevice, NotifyKind, NotifySend } from "../../shared/protocol";

/**
 * What this browser can do about notifications, and where it stands:
 * - "desktop": the desktop window (a file page cannot have a service worker).
 * - "insecure": not a secure address, so the browser does not allow them.
 * - "cannot": this browser has no notifications from a page.
 * - "ios-browser": an iPhone or iPad in a browser, not opened from the home screen.
 * - "ios-old": an iPhone opened from the home screen that still has no web push (before iOS 16.4).
 * - "checking": allowed before, and the page is still looking whether its subscription is there.
 * - "off": not asked yet, or allowed but this device is not kept by Pobots.
 * - "asking": the browser's own question is open, from his press on "Turn on for this device".
 * - "blocked": he said no in this browser.
 * - "on": this device gets notifications.
 */
export type Here = "desktop" | "insecure" | "cannot" | "ios-browser" | "ios-old" | "checking" | "off" | "asking" | "blocked" | "on";

export const INTRO =
  "Pobots can let this device know when a bot needs you, also when the page is closed. A notification only says which bot and what kind of thing, never what the chat says.";

/** The status line of "This device", per state. "checking" keeps the box and shows nothing. */
export const HERE_LINE: Record<Here, string> = {
  desktop: "Notifications work in Pobots in a browser, not in this window.",
  insecure: "This address is not secure, so the browser does not allow notifications.",
  cannot: "This browser cannot show notifications from Pobots.",
  "ios-browser": "On an iPhone, notifications only work when Pobots is opened from the home screen.",
  "ios-old": "This iPhone needs iOS 16.4 or later for notifications.",
  checking: "",
  off: "Off on this device.",
  asking: "Waiting for your answer in the browser.",
  blocked: "Notifications are blocked for Pobots in this browser.",
  on: "On for this device.",
};

/** The states that can change into each other while the page is open: their lines take turns in one box. */
export const LIVE_STATES: Here[] = ["checking", "off", "asking", "blocked", "on"];

export const TURN_ON = "Turn on for this device";
export const TURN_OFF = "Turn off for this device";
export const SEND_TEST = "Send a test";
export const SENDING = "Sending";
export const HOW_TO_ALLOW = "How to allow them";
/** Beside "Turn on" while the browser has not asked yet. */
export const ASKS_ONCE = "Your browser asks once. Choose Allow.";
export const NOT_KEPT = "Allowed, but Pobots could not keep this device. ";
export const BROWSER_FAILED = "Allowed, but the browser could not set up notifications here. Try again in a moment.";
/** The browser kept the address the push service called gone (it could not drop it, or gave it back). */
export const BROWSER_STUCK = "Allowed, but the browser could not set up notifications here. Reset them in the browser's settings and try again.";

/** Steps on an iPhone or iPad in a browser, not from the home screen. */
export const IOS_STEPS = [
  "Tap the share button in Safari (the square with an arrow pointing up). If you do not see it, tap the three dots first.",
  "Scroll down and tap Add to Home Screen, then Add.",
  "Close Safari, open Pobots from the home screen, and turn notifications on in Pobots settings.",
];

/** Where the browser runs, for the steps behind "How to allow them" and the device's name. */
export interface Platform {
  ios: boolean;
  ipad: boolean;
  android: boolean;
  windows: boolean;
  mac: boolean;
  /** Opened from the home screen, or installed as its own window. */
  standalone: boolean;
  browser: "Edge" | "Chrome" | "Firefox" | "Safari" | "Samsung Internet" | "A browser";
}

/** Reads the platform from a user agent and what the browser says of itself. */
export function platformOf(ua: string, { platform = "", touchPoints = 0, standalone = false } = {}): Platform {
  const ipad = /iPad/.test(ua) || (platform === "MacIntel" && touchPoints > 1);
  const ios = ipad || /iPhone|iPod/.test(ua);
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome|CriOS|Chromium/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : "A browser";
  return { ios, ipad, android: !ios && /Android/.test(ua), windows: /Windows/.test(ua), mac: !ios && /Mac OS X|Macintosh/.test(ua), standalone, browser };
}

/** The device's name in the list: "Edge on Windows", "Home screen app on iPhone". At most 60 characters. */
export function deviceLabel(p: Platform): string {
  const system = p.ios ? (p.ipad ? "iPad" : "iPhone") : p.android ? "Android" : p.windows ? "Windows" : p.mac ? "Mac" : "this computer";
  const what = (p.ios || p.android) && p.standalone ? "Home screen app" : p.browser;
  return `${what} on ${system}`.slice(0, 60);
}

/** The steps behind "How to allow them", only for the browser in use. */
export function allowSteps(p: Platform): string[] {
  if (p.ios) return ["Open the iPhone's Settings, then Notifications, choose Pobots and turn on Allow Notifications."];
  if (p.android) return ["Tap the icon left of the address, then Permissions, and turn Notifications on."];
  if (p.mac && p.browser === "Safari") return ["In Safari, open Settings, then Websites, then Notifications, and set this site to Allow."];
  const steps = ["Click the icon left of the address (a lock, or two sliders), open the site's permissions, set Notifications to Allow, then reload the page."];
  if (p.windows) steps.push("If they are allowed but none arrive, open Windows Settings, then System, then Notifications, and check that your browser may show them.");
  return steps;
}

// ------------------------------------------------------------ what to tell you

export const KINDS_NOTE = "For all your devices.";

/** The switches, in order, with their hints. `ahead`: shown only while Ahead is on (part B). */
export const KINDS: { kind: NotifyKind; label: string; hint: string; ahead?: true }[] = [
  { kind: "needs", label: "Needs your answer", hint: "A bot asks you something or asks to do something." },
  { kind: "note", label: "Sent you a note", hint: "A bot, or Pobots itself, puts a note in front of you." },
  { kind: "finished", label: "Finished", hint: "A bot finished something you asked it to do, or stopped because of a problem." },
  { kind: "yourTime", label: "Your time on Ahead", hint: "A slot of your time on Ahead starts.", ahead: true },
  { kind: "dayReady", label: "Your day is ready", hint: "Your working day starts and there is something on Ahead today.", ahead: true },
];

// ------------------------------------------------------------ times and the device rows

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "13 Nov" */
export function dayWord(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "today at 14:02", "yesterday at 14:02", "12 Nov at 14:02", in the middle of a sentence. */
export function atWord(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `today at ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `yesterday at ${hm}`;
  return `${dayWord(iso)} at ${hm}`;
}

/** The one line under a device's name. */
export function deviceLine(d: NotifyDevice, now = new Date()): string {
  if (d.goneAt) return `Stopped working on ${dayWord(d.goneAt)}. Open Pobots on that device and turn notifications on again.`;
  const added = `Added ${dayWord(d.addedAt)}.`;
  const last = d.last;
  if (!last) return `${added} Nothing sent yet.`;
  if (last.result === "sent") return `${added} Last sent ${atWord(last.at, now)}.`;
  if (last.result === "refused") return `Last try ${atWord(last.at, now)} was refused${last.problem ? `: ${last.problem}` : ""}.`;
  return `Last try ${atWord(last.at, now)} could not reach the push service.`;
}

/** The result line after "Send a test", from the device's record of the send. */
export function testLine(last: NotifySend | undefined): string {
  if (!last) return "";
  if (last.result === "sent") {
    const d = new Date(last.at);
    return `Sent at ${pad(d.getHours())}:${pad(d.getMinutes())}. It should arrive in a few seconds.`;
  }
  if (last.result === "refused") return `The push service refused it${last.problem ? `: ${last.problem}` : ""}.`;
  return "The push service could not be reached.";
}

/** Lines that keep the room of the result line: the longest it is likely to say. */
export const RESULT_ROOM = [
  ASKS_ONCE,
  "Sent at 00:00. It should arrive in a few seconds.",
  "The push service could not be reached.",
  `The push service refused it: ${"x".repeat(32)}.`,
  BROWSER_FAILED,
  BROWSER_STUCK,
  // An engine's refusal after "Allowed, but Pobots could not keep this device.", of a usual length.
  `${NOT_KEPT}Pobots sends to at most 20 devices. Forget one you no longer use first.`,
];

// ------------------------------------------------------------ the push service's tags

/** What a notification's tag says: "pobots-<botId>-needs", "pobots-system-note", "pobots-test". */
export function tagOf(tag: string): { bot?: string; kind: NotifyKind | "test" } | null {
  if (tag === "pobots-test") return { kind: "test" };
  if (tag === "pobots-system-note") return { kind: "note" };
  const m = /^pobots-(.+)-(needs|note|finished)$/.exec(tag);
  return m ? { bot: m[1], kind: m[2] as NotifyKind } : null;
}

/** base64url without padding, as the engine writes the public key and the device ids. */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
