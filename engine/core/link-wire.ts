// Public pairing codes and the versioned wire format. Private material stays inside the engine.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, timingSafeEqual, verify,
  type KeyObject,
} from "node:crypto";

export const LINK_DAY = 86_400_000;
export const LINK_CLOCK_SKEW = 120_000;
export const LINK_TEXT_MAX = 20_000;
export const LINK_CODE_MAX = 2048;
export const LINK_BODY_MAX = 128 * 1024;
const PREFIX = "pobots-link-1.";
const DOMAIN = "pobots-link-1";
const BAD_CODE = "That pairing code is not complete or has a typo.";
export const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Invite {
  id: string;
  name: string;
  base: string | null;
  at: number;
  signing: string;
  exchange: string;
}

export interface Identity {
  invite: Invite;
  signingKey: string;
  exchangeKey: string;
}

export interface LinkKeys {
  sign: KeyObject;
  verify: KeyObject;
  send: { auth: Buffer; box: Buffer };
  receive: { auth: Buffer; box: Buffer };
}

export function linkName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 60 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name)) throw new Error("Enter a name of 1 to 60 characters.");
  return name;
}

export function linkBase(input: string, loopback = false): string {
  const url = new URL(input);
  const local = loopback && url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port;
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || input !== url.origin || input.length > 300) throw new Error("Invalid public address.");
  return url.origin;
}

export function makeIdentity(name: string, base: string | null, at: number): Identity {
  const signing = generateKeyPairSync("ed25519");
  const exchange = generateKeyPairSync("x25519");
  return {
    invite: { id: randomUUID(), name: linkName(name), base, at,
      signing: signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      exchange: exchange.publicKey.export({ type: "spki", format: "der" }).toString("base64url") },
    signingKey: signing.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    exchangeKey: exchange.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

function publicKey(value: string, type: "ed25519" | "x25519"): KeyObject {
  if (!/^[\w-]{59}$/.test(value)) throw new Error(BAD_CODE);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error(BAD_CODE);
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== type || !key.export({ type: "spki", format: "der" }).equals(bytes)) throw new Error(BAD_CODE);
  return key;
}

function privateKey(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, "base64url"), type: "pkcs8", format: "der" });
}

function inviteBytes(invite: Invite): Buffer {
  return Buffer.from(JSON.stringify([1, invite.id, invite.name, invite.base, invite.at, invite.signing, invite.exchange]));
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(DOMAIN + ":code:").update(bytes).digest().subarray(0, 12).toString("base64url");
}

export function pairingCode(invite: Invite): string {
  const bytes = inviteBytes(invite);
  return PREFIX + bytes.toString("base64url") + "." + checksum(bytes);
}

export function readPairingCode(code: string, now: number, loopback = false): Invite {
  let invite: Invite;
  try {
    if (code.length > LINK_CODE_MAX || !code.startsWith(PREFIX)) throw new Error();
    const match = /^([\w-]+)\.([\w-]{16})$/.exec(code.slice(PREFIX.length));
    if (!match) throw new Error();
    const bytes = Buffer.from(match[1]!, "base64url");
    if (checksum(bytes) !== match[2]) throw new Error();
    const parts: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== 7) throw new Error();
    const [version, id, name, base, at, signing, exchange] = parts;
    if (version !== 1 || typeof id !== "string" || !LINK_ID.test(id) || typeof name !== "string" ||
        (base !== null && typeof base !== "string") || !Number.isSafeInteger(at) || typeof signing !== "string" || typeof exchange !== "string") throw new Error();
    invite = { id, name: linkName(name), base: base === null ? null : linkBase(base, loopback), at, signing, exchange };
    if (pairingCode(invite) !== code) throw new Error();
    publicKey(signing, "ed25519");
    publicKey(exchange, "x25519");
  } catch {
    throw new Error(BAD_CODE);
  }
  if (invite.at + LINK_DAY <= now) throw new Error("That pairing code has expired. Ask for a new one.");
  if (invite.at > now + LINK_CLOCK_SKEW) throw new Error("That pairing code was made in the future. Check the clocks on both Pobots.");
  return invite;
}

export function agree(ours: Identity, theirs: Invite): LinkKeys {
  if (ours.invite.id === theirs.id || ours.invite.signing === theirs.signing || ours.invite.exchange === theirs.exchange) {
    throw new Error("Enter their pairing code. You entered your own.");
  }
  try {
    const secret = diffieHellman({ privateKey: privateKey(ours.exchangeKey), publicKey: publicKey(theirs.exchange, "x25519") });
    const invites = [ours.invite, theirs].sort((a, b) => a.id < b.id ? -1 : 1);
    const salt = createHash("sha256").update(JSON.stringify(invites.map(pairingCode))).digest();
    const forSender = (id: string) => {
      const derive = (use: string) => Buffer.from(hkdfSync("sha256", secret, salt, `${DOMAIN}:${use}:${id}`, 32));
      return { auth: derive("auth"), box: derive("box") };
    };
    return { sign: privateKey(ours.signingKey), verify: publicKey(theirs.signing, "ed25519"),
      send: forSender(ours.invite.id), receive: forSender(theirs.id) };
  } catch {
    throw new Error("That pairing code could not be used. Ask for a new one.");
  }
}

export interface LinkMessage {
  id: string;
  at: number;
  kind: "ask" | "tell" | "answer";
  text: string;
  replyTo?: string;
}

export function readLinkMessage(value: unknown, now: number): LinkMessage | undefined {
  if (!value || typeof value !== "object") return;
  const m = value as LinkMessage;
  if (typeof m.id !== "string" || !LINK_ID.test(m.id) || !Number.isSafeInteger(m.at) ||
      m.at <= now - LINK_DAY || m.at > now + LINK_CLOCK_SKEW || typeof m.text !== "string" ||
      !m.text.trim() || m.text.length > LINK_TEXT_MAX) return;
  if (m.kind === "answer" ? typeof m.replyTo !== "string" || !LINK_ID.test(m.replyTo)
    : (m.kind !== "ask" && m.kind !== "tell") || m.replyTo !== undefined) return;
  return { id: m.id, at: m.at, kind: m.kind, text: m.text, ...(m.replyTo ? { replyTo: m.replyTo } : {}) };
}

export function payloadDigest(body: Buffer): Buffer {
  return createHash("sha256").update(body).digest();
}

export function makeAuth(key: Buffer, id: string, at: number, exchange: string, digest: Buffer): string {
  const mac = createHmac("sha256", key).update(`${DOMAIN}:auth:${id}:${at}:${exchange}:`).update(digest).digest("base64url");
  return `${at}.${exchange}.${digest.toString("base64url")}.${mac}`;
}

export function checkAuth(key: Buffer, id: string, header: string, now: number): { exchange: string; digest: Buffer; at: number } | undefined {
  const match = /^(\d{13})\.([0-9a-f-]{36})\.([\w-]{43})\.([\w-]{43})$/.exec(header);
  if (!match || !LINK_ID.test(match[2]!)) return;
  const at = Number(match[1]);
  const exchange = match[2]!;
  const digest = Buffer.from(match[3]!, "base64url");
  const expected = makeAuth(key, id, at, exchange, digest);
  if (timingSafeEqual(Buffer.from(expected), Buffer.from(header)) && Math.abs(now - at) <= LINK_CLOCK_SKEW) return { exchange, digest, at };
}

function associated(kind: "request" | "response", id: string, exchange: string): Buffer {
  return Buffer.from(`${DOMAIN}:${kind}:${id}:${exchange}`);
}

export function seal(keys: LinkKeys, kind: "request" | "response", id: string, exchange: string, value: unknown): Buffer {
  const aad = associated(kind, id, exchange);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.send.box, nonce);
  cipher.setAAD(aad);
  const crypt = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const data = Buffer.concat([nonce, cipher.getAuthTag(), crypt]);
  return Buffer.concat([sign(null, Buffer.concat([aad, data]), keys.sign), data]);
}

export function open(keys: LinkKeys, kind: "request" | "response", id: string, exchange: string, body: Buffer): unknown {
  if (body.length <= 92 || body.length > LINK_BODY_MAX) return;
  const aad = associated(kind, id, exchange);
  const data = body.subarray(64);
  try {
    if (!verify(null, Buffer.concat([aad, data]), keys.verify, body.subarray(0, 64))) return;
    const cipher = createDecipheriv("aes-256-gcm", keys.receive.box, data.subarray(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8"));
  } catch {
    return;
  }
}
