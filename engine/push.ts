// Web push from the engine to the person's own devices, with only node:crypto and fetch.
//
//   VAPID (RFC 8292): every message carries a short ES256 token signed with the engine's own key
//     pair, so a push service knows it comes from the same sender the browser subscribed to. The key
//     pair is made once and kept in <data dir>/push/vapid.json (mode 600). The private key is never
//     printed, logged or sent anywhere.
//   Message encryption (RFC 8291, with the aes128gcm content coding of RFC 8188): the message is
//     locked for the one browser that subscribed, so the push service in between (Google, Microsoft,
//     Mozilla or Apple) can carry it but not read it. Even so, a message should hold as little as
//     possible: which bot and what kind of thing, never what the chat says.
//   The devices: <data dir>/push/subscriptions.json (mode 600). A subscription's address and keys are
//     a way to reach the person's device, so they are never logged or shown; only a short id, the
//     device's label and the push service's name leave this file. A device the push service calls
//     gone keeps its row without its address and keys (`goneAt`) until it is turned on again there
//     or forgotten, and its id (the hash, never the address) goes on a short list of dead ids
//     (`dead`, the newest DEAD_MAX) so that address is never taken again by any way in. The file's
//     format is the trial's with `dead` added, so devices of the trial carry over.
//   The test relay (--push-relay): every address is checked as always, but the bytes go to a local
//     relay with the real address in the header X-Push-Address. Only for checks; nothing reaches a
//     push service then.
//
// Proven without a device by engine/tests/push.spec.ts, with the test vectors of RFC 8291 section 5
// and RFC 8188 section 3.
import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFY_MAX_DEVICES, type NotifyDevice, type NotifySend } from "../shared/protocol.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";

// ------------------------------------------------------------ bytes

export const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
export const fromB64u = (text: string): Buffer => Buffer.from(text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

// ------------------------------------------------------------ RFC 8188: the aes128gcm content coding

/** The record size we send. The push services take at most 4096 bytes of body, which one record of this size always fits. */
export const RECORD_SIZE = 4096;

/**
 * Locks `plaintext` with the aes128gcm content coding (RFC 8188) as a single record: the header
 * (salt, record size, key id) and then the record, which is the plaintext, the last-record
 * delimiter 0x02 and `pad` zero bytes, sealed with AES-128-GCM.
 */
export function aes128gcm(plaintext: Buffer, ikm: Buffer, salt: Buffer, keyId: Buffer = Buffer.alloc(0), rs: number = RECORD_SIZE, pad = 0): Buffer {
  if (salt.length !== 16) throw new Error("The salt must be 16 bytes.");
  if (keyId.length > 255) throw new Error("The key id is too long.");
  if (plaintext.length + 1 + pad + 16 > rs) throw new Error("The message does not fit in one record.");
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  // A single record is also the last one, so its sequence number is 0 and the nonce is used as it is.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2]), Buffer.alloc(pad)])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + keyId.length);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(keyId.length, 20);
  keyId.copy(header, 21);
  return Buffer.concat([header, record]);
}

// ------------------------------------------------------------ RFC 8291: locking a message for one browser

export interface SubscriptionKeys {
  /** The browser's P-256 public key, 65 bytes uncompressed, base64url (`keys.p256dh`). */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url (`keys.auth`). */
  auth: string;
}

/**
 * Locks a push message for one browser (RFC 8291). A fresh key pair and salt are made for every
 * message; the tests pass fixed ones to compare with the RFC's example.
 */
export function encryptForBrowser(plaintext: Buffer, keys: SubscriptionKeys, fixed: { asPrivate?: Buffer; salt?: Buffer; pad?: number } = {}): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("The browser's public key is not a P-256 key.");
  if (authSecret.length !== 16) throw new Error("The browser's authentication secret is not 16 bytes.");
  const ecdh = createECDH("prime256v1");
  if (fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const salt = fixed.salt ?? randomBytes(16);
  return aes128gcm(plaintext, ikm, salt, asPublic, RECORD_SIZE, fixed.pad ?? 0);
}

// ------------------------------------------------------------ RFC 8292: VAPID

export interface VapidKeys {
  /** P-256 public key, 65 bytes uncompressed, base64url: the browser's `applicationServerKey`. */
  publicKey: string;
  /** P-256 private key, 32 bytes, base64url. Never printed. */
  privateKey: string;
}

/**
 * The `sub` claim. Apple refuses a token without a well-formed `mailto:` or `https:` subject. This
 * one is made up on a reserved domain: no real address is ever in the code. It can be changed with
 * `notify.subject` in config.json (read first) or "subject" in vapid.json (the trial's way).
 */
export const DEFAULT_SUBJECT = "https://pobots.example.com/";

/** How long a token is good for. RFC 8292 allows at most 24 hours. */
export const TOKEN_HOURS = 12;

export function makeVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function signingKey(keys: VapidKeys) {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** The VAPID token (an ES256 JWT) for one push service, and the Authorization header that carries it. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string = DEFAULT_SUBJECT, now: number = Date.now()): { token: string; header: string } {
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/[^\s]+)$/.test(subject)) throw new Error('The VAPID subject must be a "mailto:" or "https:" address.');
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + TOKEN_HOURS * 3600, sub: subject })));
  const input = `${head}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key: signingKey(keys), dsaEncoding: "ieee-p1363" });
  const token = `${input}.${b64u(signature)}`;
  return { token, header: `vapid t=${token}, k=${keys.publicKey}` };
}

// ------------------------------------------------------------ the push services

export type PushService = NotifyDevice["service"];

/**
 * The push services browsers use today, by host. A subscription to any other host is refused:
 *   Google     fcm.googleapis.com, android.googleapis.com, and jmt<digits>.google.com (Chrome hands
 *              these out since 2025; jmt17.google.com was seen in a Chromium on 13 Nov 2026)
 *   Microsoft  *.notify.windows.com
 *   Mozilla    *.push.services.mozilla.com
 *   Apple      web.push.apple.com and *.push.apple.com
 */
export function pushServiceOf(endpoint: string): PushService | undefined {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return undefined;
  const h = u.hostname.toLowerCase();
  if (h === "fcm.googleapis.com" || h === "android.googleapis.com" || /^jmt\d+\.google\.com$/.test(h)) return "Google";
  if (h.endsWith(".notify.windows.com")) return "Microsoft";
  if (h === "updates.push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com")) return "Mozilla";
  if (h === "web.push.apple.com" || h.endsWith(".push.apple.com")) return "Apple";
  return undefined;
}

export interface Subscription {
  endpoint: string;
  keys: SubscriptionKeys;
}

export type PushOutcome =
  | { kind: "sent"; status: number }
  | { kind: "gone"; status: number }
  /**
   * `reason`: always one of the fixed texts of this file (problemText), never words of the answer.
   * `keyMismatch`: Google's 403 for a subscription made with another key pair.
   */
  | { kind: "failed"; status: number; reason: string; keyMismatch?: true }
  /** `unreachable`: no answer in time, or no connection. Otherwise the message could not be made (bad keys). */
  | { kind: "error"; reason: string; unreachable?: true };

export type Urgency = "very-low" | "low" | "normal" | "high";

export interface SendOptions {
  subject?: string;
  /** Seconds the push service keeps the message for a device that is offline. */
  ttl?: number;
  urgency?: Urgency;
  /** A message with the same topic replaces one that still waits at the push service. */
  topic?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The test relay: the bytes go here, with the real address in X-Push-Address. */
  relay?: string;
}

/** The time a push service has to answer. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * Sends one push message. 201 (any 2xx) is sent; 404 and 410 mean the subscription is gone; a
 * redirect is refused and never followed (the bytes go only to the checked address); anything else
 * is reported in fixed words (problemText), never with words of the answer. Never logs the address.
 */
export async function sendPush(sub: Subscription, payload: string, keys: VapidKeys, opts: SendOptions = {}): Promise<PushOutcome> {
  if (!pushServiceOf(sub.endpoint)) return { kind: "error", reason: "The address is not one of a known push service." };
  let body: Buffer;
  let auth: string;
  try {
    body = encryptForBrowser(Buffer.from(payload, "utf8"), sub.keys);
    auth = vapidAuthorization(sub.endpoint, keys, opts.subject).header;
  } catch {
    return { kind: "error", reason: MESSAGE_NOT_MADE };
  }
  const headers: Record<string, string> = {
    Authorization: auth,
    TTL: String(Math.max(0, Math.floor(opts.ttl ?? 300))),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Urgency: opts.urgency ?? "normal",
  };
  if (opts.topic) headers.Topic = opts.topic;
  let target = sub.endpoint;
  if (opts.relay) {
    headers["X-Push-Address"] = sub.endpoint;
    target = opts.relay;
  }
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    // A redirect is never followed: an accepted push service could otherwise send the bytes elsewhere.
    res = await doFetch(target, { method: "POST", headers, body: new Uint8Array(body), redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    return { kind: "error", unreachable: true, reason: e.name === "TimeoutError" ? NOT_IN_TIME : NO_CONNECTION };
  }
  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => {});
    return { kind: "sent", status: res.status };
  }
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    return { kind: "gone", status: res.status };
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    return { kind: "failed", status: res.status, reason: REDIRECTED };
  }
  let text = "";
  try {
    text = (await res.text()).slice(0, 4096);
  } catch {
    // no reason given
  }
  const keyMismatch = res.status === 403 && pushServiceOf(sub.endpoint) === "Google" && /(do(es)? not (match|correspond))|mismatch/i.test(text);
  return { kind: "failed", status: res.status, reason: problemText(res.status, text), ...(keyMismatch ? { keyMismatch: true as const } : {}) };
}

// ------------------------------------------------------------ the push services' answers, in fixed words
//
// What a push service answers may echo a device's address, its token or a key. None of it may reach
// the window, an event or the log, so an answer is never copied: an Apple reason (JSON `reason`) that
// is exactly one of KNOWN_REASONS is kept as that name, a status with a known meaning gets its fixed
// words, and anything else is only its status number. The texts are short, so the page's result line
// keeps its size.

/** Apple's reasons (web push answers as APNs does) that are kept by name; nothing else is. */
export const KNOWN_REASONS = [
  "BadJwtToken",
  "ExpiredJwtToken",
  "InvalidProviderToken",
  "MissingProviderToken",
  "TooManyProviderTokenUpdates",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
  "TooManyRequests",
  "PayloadTooLarge",
  "BadExpirationDate",
  "BadPriority",
  "BadTopic",
  "BadCollapseId",
  "Forbidden",
  "InternalServerError",
  "ServiceUnavailable",
  "Shutdown",
] as const;

/** A plain status with a known meaning. */
const STATUS_TEXT: Record<number, string> = {
  400: "message not accepted (400)",
  401: "sender not accepted (401)",
  413: "message too large (413)",
  429: "too many messages (429)",
  500: "push service error (500)",
  502: "push service unavailable (502)",
  503: "push service unavailable (503)",
  504: "push service unavailable (504)",
};

/** A redirect, refused and not followed. */
export const REDIRECTED = "redirected, not followed";
/** The message could not be made (the browser's keys, the engine's own key pair). */
export const MESSAGE_NOT_MADE = "The message could not be made for this device.";
export const NOT_IN_TIME = "The push service did not answer in time.";
export const NO_CONNECTION = "The push service could not be reached.";
export const NOT_SET_UP = "This device is not set up for notifications.";
export const NOT_SENT = "The engine could not send it.";
export const GONE_TEXT = "The push service says this device no longer takes notifications.";

/** The fixed words for a push service's answer: a known Apple reason by name, a known status, or the status alone. */
export function problemText(status: number, body: string): string {
  let reason: unknown;
  try {
    reason = (JSON.parse(body) as { reason?: unknown } | null)?.reason;
  } catch {
    // not JSON: only the status counts
  }
  if (typeof reason === "string" && (KNOWN_REASONS as readonly string[]).includes(reason)) return reason;
  return STATUS_TEXT[status] ?? `status ${Math.trunc(status) || 0}`;
}

/** Whether a text is one of the fixed words above. A text that is not is never shown. */
export function isFixedProblem(text: unknown): text is string {
  if (typeof text !== "string") return false;
  return (
    (KNOWN_REASONS as readonly string[]).includes(text) ||
    Object.values(STATUS_TEXT).includes(text) ||
    /^status \d{1,3}$/.test(text) ||
    [REDIRECTED, MESSAGE_NOT_MADE, NOT_IN_TIME, NO_CONNECTION, NOT_SET_UP, NOT_SENT, GONE_TEXT].includes(text)
  );
}

// ------------------------------------------------------------ the engine's push folder

/** One device as kept in subscriptions.json. A gone device has no address and keys. */
export interface Device {
  id: string;
  endpoint?: string;
  keys?: SubscriptionKeys;
  /** Made by the page from the browser's name, for example "Edge on Windows". */
  label: string;
  /** Kept since the address may go; the trial's rows lack it and get it from the address. */
  service?: PushService;
  createdAt: string;
  /** The last send. The trial kept `{ at, outcome }`; read as such and written in the NotifySend shape. */
  last?: NotifySend | { at: string; outcome: PushOutcome };
  goneAt?: string;
}

/** How many dead ids are kept: the newest. A device goes dead rarely, so this lasts for years. */
export const DEAD_MAX = 200;

/** The words for an address the push service called gone, whatever way it comes back. */
export const DEAD_WORDS = "This device stopped taking notifications. Turn notifications on again here.";

const writePrivate = (path: string, text: string) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/** The id of a device: a hash of its address, so the address itself never has to be shown or sent. */
export const deviceId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url").slice(0, 22);

/** A trial's record of the last send, in the NotifySend shape. A problem that is not one of the fixed texts is not shown. */
function lastOf(d: Device): NotifySend | undefined {
  const l = d.last;
  if (!l || typeof l !== "object" || typeof l.at !== "string") return undefined;
  if ("result" in l) return { at: l.at, kind: l.kind, result: l.result, ...(isFixedProblem(l.problem) ? { problem: l.problem } : {}) };
  if (!("outcome" in l) || !l.outcome) return undefined;
  return { at: l.at, kind: "test", ...sendResult(l.outcome) };
}

/** What an outcome comes to in the device's row: only fixed words (a trial's free text becomes its status). */
export function sendResult(o: PushOutcome): Pick<NotifySend, "result" | "problem"> {
  if (o.kind === "sent") return { result: "sent" };
  if (o.kind === "gone") return { result: "refused", problem: GONE_TEXT };
  if (o.kind === "failed") return { result: "refused", problem: isFixedProblem(o.reason) ? o.reason : problemText(o.status, "") };
  const problem = isFixedProblem(o.reason) ? o.reason : o.unreachable ? NO_CONNECTION : MESSAGE_NOT_MADE;
  return o.unreachable ? { result: "unreachable", problem } : { result: "refused", problem };
}

/** A label from the page: letters, digits and a few signs, at most 60 characters. */
export function cleanLabel(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[^\p{L}\p{N} .,()+/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, 60).join("").trim() || "This device";
}

/** The browser's keys, checked before they are kept: a P-256 public key and a 16-byte secret. */
function checkKeys(keys: SubscriptionKeys): void {
  let ok = false;
  try {
    const pub = fromB64u(keys.p256dh);
    ok = pub.length === 65 && pub[0] === 4 && fromB64u(keys.auth).length === 16;
  } catch {
    ok = false;
  }
  if (!ok) throw new EngineError("bad_request", "This browser's notification keys are not complete. Turn notifications off and on again.");
}

export interface PushStoreOptions {
  /** `notify.subject` from config.json: wins over vapid.json's. */
  subject?: string;
  /** The test relay (--push-relay). */
  relay?: string;
  /** A stand-in for fetch, for tests. */
  fetch?: typeof fetch;
}

export class PushStore {
  readonly dir: string;
  private keys: (VapidKeys & { subject: string }) | undefined;
  private readonly o: PushStoreOptions;

  constructor(dir: string, options: PushStoreOptions = {}) {
    this.dir = dir;
    this.o = options;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** The engine's VAPID keys, made on first use. */
  vapid(): VapidKeys & { subject: string } {
    if (this.keys) return this.keys;
    this.ensureDir();
    const path = join(this.dir, "vapid.json");
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys> & { subject?: string };
      if (typeof j.publicKey !== "string" || typeof j.privateKey !== "string") throw new Error("vapid.json is not complete.");
      chmodSync(path, 0o600);
      this.keys = { publicKey: j.publicKey, privateKey: j.privateKey, subject: this.o.subject || (typeof j.subject === "string" && j.subject ? j.subject : DEFAULT_SUBJECT) };
    } else {
      const made = makeVapidKeys();
      writePrivate(path, `${JSON.stringify({ ...made, createdAt: new Date().toISOString() }, null, 2)}\n`);
      log.info("Made the engine's key pair for notifications");
      this.keys = { ...made, subject: this.o.subject || DEFAULT_SUBJECT };
    }
    return this.keys;
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  /** The file: the devices, and the ids of addresses the push service called gone (oldest first). */
  private load(): { devices: Device[]; dead: string[] } {
    const path = join(this.dir, "subscriptions.json");
    if (!existsSync(path)) return { devices: [], dead: [] };
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { devices?: Device[]; dead?: unknown };
      return {
        devices: Array.isArray(j.devices) ? j.devices.filter((d) => d && typeof d.id === "string") : [],
        dead: Array.isArray(j.dead) ? j.dead.filter((x): x is string => typeof x === "string").slice(-DEAD_MAX) : [],
      };
    } catch {
      log.warn("The list of devices for notifications could not be read; starting it again");
      return { devices: [], dead: [] };
    }
  }

  private read(): Device[] {
    return this.load().devices;
  }

  private write(devices: Device[], dead: string[] = this.load().dead): void {
    this.ensureDir();
    writePrivate(join(this.dir, "subscriptions.json"), `${JSON.stringify({ devices, ...(dead.length ? { dead: dead.slice(-DEAD_MAX) } : {}) }, null, 2)}\n`);
  }

  /** The ids of addresses the push service called gone, oldest first. For tests. */
  deadIds(): string[] {
    return this.load().dead;
  }

  /**
   * Keeps a subscription (notify.subscribe and the service worker's renewal). The same address again
   * updates its row. An address the push service called gone (its id on the dead list, or its row
   * marked gone) is refused with conflict by every way in, whatever `mayAdd` and `replaces` say,
   * so a dead device never reads as on. `replaces` names the row a new address takes the place of:
   * for his press (`mayAdd`) and for the service worker's renewal (`renewal`, which names the row
   * by its old address) any row; for the page saying "still here" only a row that is gone, and a
   * working one is refused with conflict (a stale tab cannot put an old address in a working
   * device's place). `mayAdd`: true only for his press on "Turn on" (asked); otherwise an unknown
   * address is refused with not_found. Returns the device's id.
   */
  keep(sub: Subscription, label: string | undefined, o: { mayAdd: boolean; replaces?: string; renewal?: boolean; at: string }): { id: string; added: boolean } {
    const service = pushServiceOf(sub.endpoint);
    if (!service) {
      let host = "an unknown address";
      try {
        host = new URL(sub.endpoint).hostname || host;
      } catch {
        // keep the plain words
      }
      throw new EngineError("bad_request", `This browser's push service (${host.slice(0, 80)}) is not one Pobots knows.`);
    }
    checkKeys(sub.keys);
    const id = deviceId(sub.endpoint);
    const { devices, dead } = this.load();
    let row = devices.find((d) => d.id === id);
    if (dead.includes(id) || row?.goneAt) throw new EngineError("conflict", DEAD_WORDS);
    let added = false;
    if (!row && o.replaces) {
      const named = devices.find((d) => d.id === o.replaces);
      if (named && !named.goneAt && !o.mayAdd && !o.renewal) throw new EngineError("conflict", "Another window changed this device's notifications. Open Pobots here again.");
      row = named;
      if (row) row.id = id;
    }
    if (!row) {
      if (!o.mayAdd) throw new EngineError("not_found", "Pobots does not know this device. Turn notifications on for it again.");
      if (devices.length >= NOTIFY_MAX_DEVICES) throw new EngineError("too_many", `Pobots sends notifications to at most ${NOTIFY_MAX_DEVICES} devices. Forget one first.`);
      row = { id, label: cleanLabel(label), service, createdAt: o.at };
      devices.push(row);
      added = true;
    }
    row.endpoint = sub.endpoint;
    row.keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
    row.service = service;
    if (label !== undefined) row.label = cleanLabel(label);
    delete row.goneAt;
    // Another row with the same id (a replaced row that met a known one) is dropped.
    const kept = devices.filter((d) => d === row || d.id !== id);
    this.write(kept, dead);
    return { id, added };
  }

  /** Forgets a device. True when there was one. */
  forget(id: string): boolean {
    const { devices, dead } = this.load();
    const kept = devices.filter((d) => d.id !== id);
    if (kept.length === devices.length) return false;
    this.write(kept, dead);
    return true;
  }

  /**
   * The push service called this device gone: its address and keys are dropped, its row stays, and
   * its id goes on the dead list (the newest DEAD_MAX), which outlives the row.
   */
  markGone(id: string, at: string): void {
    const { devices, dead } = this.load();
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    delete d.endpoint;
    delete d.keys;
    d.goneAt = at;
    this.write(devices, [...dead.filter((x) => x !== id), id]);
  }

  record(id: string, last: NotifySend): void {
    const { devices, dead } = this.load();
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    d.last = last;
    this.write(devices, dead);
  }

  /** What may leave the engine about a device: never its address or keys. */
  view(d: Device): NotifyDevice {
    const last = lastOf(d);
    return {
      id: d.id,
      label: d.label,
      service: d.service ?? (d.endpoint ? pushServiceOf(d.endpoint) : undefined) ?? "Google",
      addedAt: d.createdAt,
      ...(last ? { last } : {}),
      ...(d.goneAt ? { goneAt: d.goneAt } : {}),
    };
  }

  /** Oldest first, as kept. */
  list(): NotifyDevice[] {
    return this.read().map((d) => this.view(d));
  }

  has(id: string): boolean {
    return this.read().some((d) => d.id === id);
  }

  /** The device's label and push service, for the log. Never the address. */
  describe(id: string): string {
    const d = this.read().find((x) => x.id === id);
    return d ? `${d.label} (${this.view(d).service})` : "an unknown device";
  }

  /**
   * Sends to one device, without recording anything (the caller records the result, after a retry).
   * A device that is gone or unknown is not sent to.
   */
  async deliver(id: string, payload: string, opts: Omit<SendOptions, "subject" | "relay" | "fetch"> = {}): Promise<PushOutcome> {
    const d = this.read().find((x) => x.id === id);
    if (!d || !d.endpoint || !d.keys) return { kind: "error", reason: NOT_SET_UP };
    const keys = this.vapid();
    return sendPush({ endpoint: d.endpoint, keys: d.keys }, payload, keys, {
      ...opts,
      subject: keys.subject,
      ...(this.o.relay ? { relay: this.o.relay } : {}),
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }
}
