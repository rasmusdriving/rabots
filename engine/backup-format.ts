// The locked file of the nightly backup (docs/build/step-backup.md, groundwork in
// docs/build/notes-backup-groundwork.md). Only node:crypto. Ported from scripts/dev/backup-lock.mjs.
//
// The file:   "PBTSBAK" 0x00 | u8 format (1) | u32 header length | header JSON | frames...
// A frame:    u32 length of the ciphertext | ciphertext | 16-byte GCM tag
//
// Each backup gets a fresh AES-256-GCM key, wrapped with the person's RSA public key (OAEP, SHA-256)
// and kept in the header. The plain stream is cut into 1 MiB frames. Frame i is sealed with nonce =
// 4 zero bytes + u64 big-endian i, and with additional data = SHA-256(magic, format, header) plus one
// byte that is 1 only on the last frame. So frames cannot be swapped, dropped, edited, cut off at the
// end or moved to another file, and the header cannot be edited, without unlocking failing.
//
// Format 1 is read for good: a later Pobots that changes anything writes format 2 and keeps this reader.
//
// This file is also imported by scripts/restore.mjs, which runs it with Node's own type stripping:
// keep it free of local imports and of TypeScript that is more than erasable types.
import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";
import { Transform } from "node:stream";

export const MAGIC = Buffer.from("PBTSBAK\0", "latin1");
export const FORMAT = 1;
export const CHUNK = 1024 * 1024;
const TAG = 16;
const LEAD = MAGIC.length + 5;
/** A header is a few hundred bytes; anything far bigger is damage. */
export const MAX_HEADER = 64 * 1024;
/** Keys smaller than this are refused (weaker than the rest of the scheme). */
export const MIN_BITS = 3072;

/** The header in front of the frames. Readable without the key. Unknown fields are kept and ignored. */
export interface BackupHeader {
  kind: "pobots-backup";
  format: number;
  cipher: "aes-256-gcm";
  wrap: "rsa-oaep-sha256";
  keyFingerprint: string;
  wrappedKey: string;
  chunkSize: number;
  createdAt?: string;
  engineVersion?: string;
  protocol?: number;
  contents?: string;
  [extra: string]: unknown;
}

/** A refusal in plain words, safe to show the person. Never holds key material. */
export class BackupFormatError extends Error {}

// ------------------------------------------------------------ the public key line he pastes

function readSshString(buf: Buffer, at: number): [Buffer, number] {
  if (at + 4 > buf.length) throw new BackupFormatError("cut short");
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) throw new BackupFormatError("cut short");
  return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
}

const unsigned = (b: Buffer): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

/** A positive SSH mpint in canonical form: not empty, top bit clear, no leading zero byte unless the next byte has its top bit set. */
export function canonicalMpint(b: Buffer): boolean {
  if (!b.length) return false;
  if (b[0]! & 0x80) return false;
  if (b[0] === 0 && (b.length === 1 || !(b[1]! & 0x80))) return false;
  return true;
}

export const NOT_USUAL_FORM = "That key is not in the usual form. Copy the public key again from 1Password.";

const b64url = (b: Buffer): string => b.toString("base64url");

export interface PublicKeyInfo {
  key: KeyObject;
  bits: number;
  /** "SHA256:..." exactly as `ssh-keygen -l -E sha256` prints it. */
  fingerprint: string;
  /** The key as one clean line, "ssh-rsa AAAA...", without the comment. What is kept in config.json. */
  line: string;
}

/** "SHA256:" + base64 without padding of SHA-256 of the key's blob, as ssh-keygen prints it. */
export function fingerprintOfBlob(blob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/**
 * Checks a pasted public key line and returns the key, or throws a BackupFormatError with one plain
 * sentence. Accepts only "ssh-rsa" of 3072 bits or more. The sentences never repeat what was pasted.
 */
export function parsePublicKeyLine(line: unknown): PublicKeyInfo {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text) throw new BackupFormatError("Paste the public key. It starts with ssh-rsa.");
  if (/PRIVATE KEY/i.test(text) || /^-----BEGIN/.test(text) || /PuTTY-User-Key-File/i.test(text)) {
    throw new BackupFormatError("That is a private key. Paste the public key instead, and keep the private key in 1Password.");
  }
  const [type, ...tokens] = text.split(/\s+/);
  if (type === "ssh-ed25519") throw new BackupFormatError("That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
  if (type !== "ssh-rsa") throw new BackupFormatError("That does not look like a public key. It should start with ssh-rsa.");
  // The key text may have been broken over lines when copied: join pieces until the key is whole.
  let data = "";
  let blob: Buffer | undefined;
  let parts: { inner: Buffer; e: Buffer; n: Buffer } | undefined;
  for (let used = 0; used < tokens.length && /^[A-Za-z0-9+/]+={0,2}$/.test(tokens[used]!); used++) {
    data += tokens[used];
    const candidate = Buffer.from(data, "base64");
    try {
      let at: number;
      let inner: Buffer, e: Buffer, n: Buffer;
      [inner, at] = readSshString(candidate, 0);
      [e, at] = readSshString(candidate, at);
      [n, at] = readSshString(candidate, at);
      if (at === candidate.length) {
        blob = candidate;
        parts = { inner, e, n };
        break;
      }
    } catch {
      // not whole yet
    }
  }
  if (!blob || !parts) {
    // A whole key of another kind behind "ssh-rsa" says what it is in its first field.
    try {
      const [inner] = readSshString(Buffer.from(data, "base64"), 0);
      const kind = inner.toString("latin1");
      if (kind === "ssh-ed25519") throw new BackupFormatError("That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
      if (/^[a-z0-9.@-]{3,64}$/.test(kind) && kind !== "ssh-rsa") throw new BackupFormatError("The key is damaged. Copy the whole public key again.");
    } catch (err) {
      if (err instanceof BackupFormatError && err.message !== "cut short") throw err;
    }
    throw new BackupFormatError("The key is incomplete. Copy the whole public key again.");
  }
  if (parts.inner.toString("latin1") !== "ssh-rsa") throw new BackupFormatError("The key is damaged. Copy the whole public key again.");
  // The fingerprint is taken over the blob as pasted, and ssh-keygen and 1Password take it over the
  // canonical blob. Both are the same only when the numbers are in SSH's canonical form (RFC 4251
  // mpint: positive, no leading zero byte unless the next byte has its top bit set), so any other
  // form is refused: every backup locked to it would fail the restore's fingerprint check.
  if (!canonicalMpint(parts.e) || !canonicalMpint(parts.n)) throw new BackupFormatError(NOT_USUAL_FORM);
  const eu = unsigned(parts.e);
  const nu = unsigned(parts.n);
  if (!nu.length || nu[0] === 0 || !eu.length) throw new BackupFormatError("The key is damaged. Copy the whole public key again.");
  const bits = nu.length * 8 - (Math.clz32(nu[0]!) - 24);
  const eValue = BigInt("0x" + eu.toString("hex"));
  if (eValue < 65537n || eValue % 2n === 0n) throw new BackupFormatError("This RSA key is not usable for backups. Make a new one in 1Password.");
  if (bits < MIN_BITS) throw new BackupFormatError(`This RSA key has ${bits} bits. Make one of 4096 bits.`);
  if (bits > 16384) throw new BackupFormatError("The key is damaged. Copy the whole public key again.");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: "RSA", n: b64url(nu), e: b64url(eu) }, format: "jwk" });
  } catch {
    throw new BackupFormatError("The key is damaged. Copy the whole public key again.");
  }
  return { key, bits, fingerprint: fingerprintOfBlob(blob), line: `ssh-rsa ${blob.toString("base64")}` };
}

// ------------------------------------------------------------ the private key (restore only)

/**
 * Reads a private key from text: PKCS#8 or PKCS#1 PEM through node:crypto, an unencrypted OpenSSH RSA
 * key through the small parser below. Throws a BackupFormatError that never holds key material.
 */
export function readPrivateKey(text: string): KeyObject {
  const t = text.trim();
  if (!t) throw new BackupFormatError("No private key came in on standard input.");
  try {
    if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(t)) return openSshRsa(t);
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(t) || /Proc-Type: 4,ENCRYPTED/.test(t)) throw new BackupFormatError("This private key has a passphrase. Export it without one.");
    const key = createPrivateKey({ key: t, format: "pem" });
    if (key.asymmetricKeyType !== "rsa") throw new BackupFormatError("Only RSA keys open Pobots backups.");
    return key;
  } catch (err) {
    if (err instanceof BackupFormatError) throw err;
    throw new BackupFormatError("The private key could not be read. It should be the whole key, in PEM or OpenSSH form.");
  }
}

function openSshRsa(t: string): KeyObject {
  const body = Buffer.from(t.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = Buffer.from("openssh-key-v1\0", "latin1");
  try {
    if (!body.subarray(0, magic.length).equals(magic)) throw new BackupFormatError("Not an OpenSSH private key.");
    let at = magic.length;
    let cipher: Buffer, kdf: Buffer, priv: Buffer;
    [cipher, at] = readSshString(body, at);
    [kdf, at] = readSshString(body, at);
    [, at] = readSshString(body, at); // kdf options
    if (cipher.toString() !== "none" || kdf.toString() !== "none") throw new BackupFormatError("This private key has a passphrase. Export it without one.");
    const count = body.readUInt32BE(at);
    at += 4;
    for (let i = 0; i < count; i++) [, at] = readSshString(body, at); // public keys
    [priv] = readSshString(body, at);
    let p = 8; // two check numbers
    let type: Buffer, n: Buffer, e: Buffer, d: Buffer, iqmp: Buffer, pp: Buffer, q: Buffer;
    [type, p] = readSshString(priv, p);
    if (type.toString() !== "ssh-rsa") throw new BackupFormatError("Only RSA keys open Pobots backups.");
    [n, p] = readSshString(priv, p);
    [e, p] = readSshString(priv, p);
    [d, p] = readSshString(priv, p);
    [iqmp, p] = readSshString(priv, p);
    [pp, p] = readSshString(priv, p);
    [q, p] = readSshString(priv, p);
    const big = (b: Buffer) => BigInt("0x" + (unsigned(b).toString("hex") || "0"));
    const toB = (x: bigint, len: number) => Buffer.from(x.toString(16).padStart(len * 2, "0"), "hex");
    const D = big(d);
    const P = big(pp);
    const Q = big(q);
    const key = createPrivateKey({
      key: {
        kty: "RSA",
        n: b64url(unsigned(n)),
        e: b64url(unsigned(e)),
        d: b64url(unsigned(d)),
        p: b64url(unsigned(pp)),
        q: b64url(unsigned(q)),
        dp: b64url(toB(D % (P - 1n), unsigned(pp).length)),
        dq: b64url(toB(D % (Q - 1n), unsigned(q).length)),
        qi: b64url(unsigned(iqmp)),
      },
      format: "jwk",
    });
    // Wipe what was copied out of the key text.
    for (const b of [body, priv, d, pp, q, iqmp]) b.fill(0);
    return key;
  } catch (err) {
    body.fill(0);
    if (err instanceof BackupFormatError && err.message !== "cut short") throw err;
    throw new BackupFormatError("The private key could not be read. It should be the whole key, in PEM or OpenSSH form.");
  }
}

/** The fingerprint of a private (or public) key's public half, as "SHA256:..." in ssh-keygen's way. */
export function fingerprintOfKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const mp = (b64: string) => {
    let b = Buffer.from(b64, "base64url");
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const str = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const blob = Buffer.concat([str(Buffer.from("ssh-rsa")), str(mp(jwk.e as string)), str(mp(jwk.n as string))]);
  return fingerprintOfBlob(blob);
}

// ------------------------------------------------------------ locking and unlocking, as streams

const nonce = (i: number): Buffer => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
};

/** A Transform that turns plain bytes into the locked file. `meta` goes into the readable header. */
export function lockStream(publicKey: KeyObject, fingerprint: string, meta: Record<string, unknown> = {}): Transform {
  const fileKey = randomBytes(32);
  const header = Buffer.from(
    JSON.stringify({
      ...meta,
      kind: "pobots-backup",
      format: FORMAT,
      cipher: "aes-256-gcm",
      wrap: "rsa-oaep-sha256",
      keyFingerprint: fingerprint,
      wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, fileKey).toString("base64"),
      chunkSize: CHUNK,
    }),
  );
  const lead = Buffer.alloc(LEAD);
  MAGIC.copy(lead);
  lead[MAGIC.length] = FORMAT;
  lead.writeUInt32BE(header.length, MAGIC.length + 1);
  const headerHash = createHash("sha256").update(lead).update(header).digest();
  let index = 0;
  let pending: Buffer = Buffer.alloc(0);
  const frame = (plain: Buffer, last: boolean): Buffer => {
    const c = createCipheriv("aes-256-gcm", fileKey, nonce(index++));
    c.setAAD(Buffer.concat([headerHash, Buffer.from([last ? 1 : 0])]));
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length - TAG);
    return Buffer.concat([len, body]);
  };
  let started = false;
  const start = (t: Transform) => {
    if (started) return;
    t.push(lead);
    t.push(header);
    started = true;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      start(this);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Keep at least one byte back, so the last frame is always marked as last.
      while (pending.length > CHUNK) {
        this.push(frame(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done) {
      start(this);
      this.push(frame(pending, true));
      fileKey.fill(0);
      done();
    },
    destroy(err, cb) {
      fileKey.fill(0);
      cb(err);
    },
  });
}

/** Checks the lead and returns the header, or throws a plain sentence. `buf` holds at least the lead and the header. */
function parseLead(buf: Buffer): { header: BackupHeader; length: number } | undefined {
  if (buf.length < LEAD) return undefined;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupFormatError("This is not a Pobots backup.");
  const format = buf[MAGIC.length]!;
  if (format > FORMAT) throw new BackupFormatError(`This backup was made by a newer Pobots (format ${format}). Use a newer Pobots to open it.`);
  if (format !== FORMAT) throw new BackupFormatError("This backup's format is not known.");
  const hlen = buf.readUInt32BE(MAGIC.length + 1);
  if (hlen > MAX_HEADER || hlen < 2) throw new BackupFormatError("The backup's header is damaged.");
  if (buf.length < LEAD + hlen) return undefined;
  let header: BackupHeader;
  try {
    header = JSON.parse(buf.subarray(LEAD, LEAD + hlen).toString("utf8")) as BackupHeader;
  } catch {
    throw new BackupFormatError("The backup's header is damaged.");
  }
  if (!header || typeof header !== "object" || header.kind !== "pobots-backup" || typeof header.wrappedKey !== "string" || typeof header.chunkSize !== "number" || header.chunkSize < 1 || header.chunkSize > 64 * CHUNK) {
    throw new BackupFormatError("The backup's header is damaged.");
  }
  return { header: { ...header, format }, length: LEAD + hlen };
}

/** A Transform that turns the locked file back into plain bytes, failing on any change. `onHeader` sees the header first. */
export function unlockStream(privateKey: KeyObject, onHeader: (h: BackupHeader) => void = () => {}): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let header: BackupHeader | undefined;
  let headerHash: Buffer | undefined;
  let fileKey: Buffer | undefined;
  let index = 0;
  let sawLast = false;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (!header) {
          const lead = parseLead(buf);
          if (!lead) return done();
          header = lead.header;
          headerHash = createHash("sha256").update(buf.subarray(0, lead.length)).digest();
          onHeader(header);
          try {
            fileKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(header.wrappedKey, "base64"));
          } catch {
            throw new BackupFormatError("This private key does not open this backup.");
          }
          if (fileKey.length !== 32) throw new BackupFormatError("This private key does not open this backup.");
          buf = buf.subarray(lead.length);
        }
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > header.chunkSize) throw new BackupFormatError("The backup is damaged or was changed.");
          if (buf.length < 4 + len + TAG) break;
          if (sawLast) throw new BackupFormatError("The backup is damaged or was changed.");
          const ct = buf.subarray(4, 4 + len);
          const tag = buf.subarray(4 + len, 4 + len + TAG);
          buf = buf.subarray(4 + len + TAG);
          const open = (isLast: boolean) => {
            const d = createDecipheriv("aes-256-gcm", fileKey!, nonce(index));
            d.setAAD(Buffer.concat([headerHash!, Buffer.from([isLast ? 1 : 0])]));
            d.setAuthTag(tag);
            return Buffer.concat([d.update(ct), d.final()]);
          };
          let plain: Buffer;
          try {
            plain = open(false);
          } catch {
            try {
              plain = open(true);
              sawLast = true;
            } catch {
              throw new BackupFormatError("The backup is damaged or was changed.");
            }
          }
          index++;
          this.push(plain);
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      if (fileKey) fileKey.fill(0);
      if (!header) return done(new BackupFormatError("The backup is empty or cut short."));
      if (buf.length || !sawLast) return done(new BackupFormatError("The backup is cut short."));
      done();
    },
    destroy(err, cb) {
      if (fileKey) fileKey.fill(0);
      cb(err);
    },
  });
}

/** Reads only the header, without any key: what the restore script shows first. `buf` is the file's start (at least 64 KiB, or all of it). */
export function readHeader(buf: Buffer): BackupHeader {
  const lead = parseLead(buf);
  if (!lead) throw new BackupFormatError("The backup is empty or cut short.");
  return lead.header;
}
