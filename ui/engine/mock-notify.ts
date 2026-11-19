// The mock engine's notifications (job 4, docs/build/step-push.md): the switches and the devices as
// the engine keeps them, subscribe with each refusal, forget, a test that ends sent, refused or
// unreachable, and presence written down for the checks. Nothing is ever sent anywhere: this only
// acts it out for the window.
//
// ?notify= picks the starting point (any scene):
//   devices   (the default) two devices, an iPhone's home screen app that got one yesterday and Edge on Windows
//   none      no devices yet
//   gone      as devices, with the iPhone's stopped working yesterday
//   full      20 devices, the most there can be
// Levers on window.pobotsMock: notifyState, notifyTestNext, notifyTestMs, notifySubscribeNext,
// notifyPresence, notifySubscribes, notifyAddDevice, notifyGone, notifySent.
import { NOTIFY_MAX_DEVICES, type Events, type Methods, type NotifyDevice, type NotifySend, type NotifyState } from "../../shared/protocol";
import { base64url } from "../lib/notify";
import { sha256 } from "./mock-sha256";
import { EngineError } from "./types";

type Service = NotifyDevice["service"];
type NotifyMethod = "notify.setKinds" | "notify.subscribe" | "notify.forget" | "notify.test" | "notify.presence";

/** The push services the engine sends to, by the host of a subscription's address. */
function serviceOf(endpoint: string): Service | null {
  let host: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || u.port) return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (host === "fcm.googleapis.com" || host === "android.googleapis.com" || /^jmt\d+\.google\.com$/.test(host)) return "Google";
  if (host.endsWith(".notify.windows.com")) return "Microsoft";
  if (host.endsWith(".push.services.mozilla.com")) return "Mozilla";
  if (host.endsWith(".push.apple.com")) return "Apple";
  return null;
}

/** The engine's device id: SHA-256 of the address, base64url, the first 22 characters. */
export const deviceIdOf = (endpoint: string) => base64url(sha256(new TextEncoder().encode(endpoint))).slice(0, 22);

/** A day and time `days` days ago, at h:m, on the local clock. */
function daysAgo(days: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** A made-up public key of the right shape (an uncompressed P-256 point, 65 bytes). Nobody holds it. */
const PUBLIC_KEY = base64url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37 + 11) % 256)));

export class MockNotify {
  private s: NotifyState;
  /** Each device's address, as the engine keeps it. Never in the state or an event. */
  private addresses = new Map<string, string>();
  /** The ids of addresses the push service called gone: never taken again, as the engine does it. */
  private dead = new Set<string>();
  private testNext: { result: NotifySend["result"]; problem?: string }[] = [];
  private subscribeNext: { code: string; message: string }[] = [];
  /** How long "notify.test" takes before it answers, in ms. */
  testMs = 0;
  /** Every presence the window sent, with when it came (ms since the page opened). */
  readonly presence: (Methods["notify.presence"]["params"] & { at: number })[] = [];
  /** Every subscribe: asked or not, the label, what it replaces, and the push service. Never the address. */
  readonly subscribes: { asked: boolean; label: string; replaces?: string; service: Service | null; deviceId: string }[] = [];

  constructor(private readonly emit: (e: { event: "notify.changed"; data: Events["notify.changed"] }) => void, seed: string | null) {
    this.s = { publicKey: PUBLIC_KEY, kinds: { needs: true, note: true, finished: false }, devices: [] };
    this.seed(seed ?? "devices");
  }

  state(): NotifyState {
    return structuredClone(this.s);
  }

  private changed(): void {
    this.emit({ event: "notify.changed", data: { notify: this.state() } });
  }

  private seed(seed: string): void {
    if (seed === "none") return;
    const add = (endpoint: string, label: string, addedAt: string, extra: Partial<NotifyDevice> = {}) => {
      const id = deviceIdOf(endpoint);
      this.addresses.set(id, endpoint);
      this.s.devices.push({ id, label, service: serviceOf(endpoint)!, addedAt, ...extra });
    };
    add("https://web.push.apple.com/mock-iphone", "Home screen app on iPhone", daysAgo(3, 20, 15), {
      last: { at: daysAgo(1, 18, 40), kind: "needs", result: "sent" },
      ...(seed === "gone" ? { goneAt: daysAgo(1, 18, 40), last: { at: daysAgo(1, 18, 40), kind: "needs", result: "refused", problem: "Gone" } } : {}),
    });
    if (seed === "gone") this.dead.add(deviceIdOf("https://web.push.apple.com/mock-iphone"));
    add("https://wns2-db5p.notify.windows.com/w/?token=mock-laptop", "Edge on Windows", daysAgo(2, 9, 30));
    if (seed === "full") for (let i = this.s.devices.length; i < NOTIFY_MAX_DEVICES; i++) add(`https://fcm.googleapis.com/fcm/send/mock-${i}`, `Chrome on Android ${i - 1}`, daysAgo(2, 10, i));
  }

  readonly handlers: { [M in NotifyMethod]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "notify.setKinds": (p) => {
      this.s.kinds = { ...this.s.kinds, ...p.kinds };
      this.changed();
      return { notify: this.state() };
    },
    "notify.subscribe": (p) => {
      const refusal = this.subscribeNext.shift();
      const service = serviceOf(p.subscription.endpoint);
      const id = deviceIdOf(p.subscription.endpoint);
      this.subscribes.push({ asked: p.asked, label: p.label, ...(p.replaces ? { replaces: p.replaces } : {}), service, deviceId: id });
      if (refusal) throw new EngineError(refusal);
      if (!service) throw new EngineError({ code: "bad_request", message: "Pobots can only send to the push services of Google, Microsoft, Mozilla and Apple." });
      const known = this.s.devices.find((d) => d.id === id);
      const old = p.replaces && p.replaces !== id ? this.s.devices.find((d) => d.id === p.replaces) : undefined;
      // An address the push service called gone is never taken again, asked or not; only a fresh one mends the row.
      if (this.dead.has(id) || known?.goneAt) throw new EngineError({ code: "conflict", message: "This device stopped taking notifications. Turn notifications on again here." });
      // Saying still here cannot put an address in a working device's place.
      if (!known && old && !old.goneAt && !p.asked) throw new EngineError({ code: "conflict", message: "Another window changed this device's notifications. Open Pobots here again." });
      if (known) {
        // The same address again: the row stays where it is, working again.
        Object.assign(known, { label: p.label.slice(0, 60) });
        delete known.goneAt;
        if (old) this.forget(old.id);
      } else if (old) {
        // A renewed address takes the place of the one this device had.
        this.addresses.delete(old.id);
        Object.assign(old, { id, label: p.label.slice(0, 60), service });
        delete old.goneAt;
      } else if (!p.asked) {
        throw new EngineError({ code: "not_found", message: "Pobots does not know this device any more. Turn notifications on again here." });
      } else {
        if (this.s.devices.length >= NOTIFY_MAX_DEVICES) throw new EngineError({ code: "too_many", message: `Pobots sends to at most ${NOTIFY_MAX_DEVICES} devices. Forget one you no longer use first.` });
        this.s.devices.push({ id, label: p.label.slice(0, 60), service, addedAt: new Date().toISOString() });
      }
      this.addresses.set(id, p.subscription.endpoint);
      this.changed();
      return { deviceId: id, notify: this.state() };
    },
    "notify.forget": (p) => {
      if (!this.s.devices.some((d) => d.id === p.deviceId)) throw new EngineError({ code: "not_found", message: "That device is not in the list any more." });
      this.forget(p.deviceId);
      this.changed();
      return { notify: this.state() };
    },
    "notify.test": (p) => {
      const d = this.s.devices.find((x) => x.id === p.deviceId);
      if (!d) throw new EngineError({ code: "not_found", message: "That device is not in the list any more." });
      const next = this.testNext.shift() ?? { result: "sent" as const };
      d.last = { at: new Date().toISOString(), kind: "test", result: next.result, ...(next.problem ? { problem: next.problem } : {}) };
      this.changed();
      return { notify: this.state() };
    },
    "notify.presence": (p) => {
      this.presence.push({ ...p, at: Math.round(performance.now()) });
      return {};
    },
  };

  private forget(id: string): void {
    this.s.devices = this.s.devices.filter((d) => d.id !== id);
    this.addresses.delete(id);
  }

  // ------------------------------------------------------------ levers

  /** The next test ends this way (they queue up). */
  setTestNext(result: NotifySend["result"], problem?: string): void {
    this.testNext.push({ result, ...(problem ? { problem } : {}) });
  }

  /** The next subscribe is refused with this code and sentence (they queue up). */
  setSubscribeNext(code: string, message: string): void {
    this.subscribeNext.push({ code, message });
  }

  /** Another device turned notifications on: it comes at the bottom of the list. Gives its id. */
  addDevice(label: string, endpoint = `https://fcm.googleapis.com/fcm/send/mock-added-${this.s.devices.length}`): string {
    const id = deviceIdOf(endpoint);
    this.addresses.set(id, endpoint);
    this.s.devices.push({ id, label, service: serviceOf(endpoint) ?? "Google", addedAt: new Date().toISOString() });
    this.changed();
    return id;
  }

  /** The push service said this device is gone (404 or 410): its row stays, without its address. */
  gone(id: string): void {
    const d = this.s.devices.find((x) => x.id === id);
    if (!d) return;
    d.goneAt = new Date().toISOString();
    this.addresses.delete(id);
    this.dead.add(id);
    this.changed();
  }

  /** A notification of this kind was sent (or tried) to a device just now. */
  sent(id: string, kind: NotifySend["kind"], result: NotifySend["result"], problem?: string): void {
    const d = this.s.devices.find((x) => x.id === id);
    if (!d) return;
    d.last = { at: new Date().toISOString(), kind, result, ...(problem ? { problem } : {}) };
    this.changed();
  }
}
