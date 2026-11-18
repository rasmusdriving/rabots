// Groundwork for the nightly backup (job 5, docs/build/notes-backup-groundwork.md). A trial of the
// locked file format, using only node:crypto. Not the feature: the engine side will be TypeScript.
//
// The file:   "PBTSBAK" 0x00 | u8 format (1) | u32 header length | header JSON | frames...
// A frame:    u32 length of the ciphertext | ciphertext | 16-byte GCM tag
// Each backup gets a fresh AES-256-GCM key, wrapped with the person's RSA public key (OAEP, SHA-256).
// Frame i is sealed with nonce = 4 zero bytes + u64 big-endian i, and with additional data =
// SHA-256(magic, format, header) + one byte that is 1 only on the last frame. So frames cannot be
// swapped, dropped, cut off at the end or moved to another file without unlocking failing.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, publicEncrypt, privateDecrypt, randomBytes, constants } from "node:crypto";
import { Transform } from "node:stream";

export const MAGIC = Buffer.from("PBTSBAK\0", "latin1");
export const FORMAT = 1;
export const CHUNK = 1024 * 1024;
const TAG = 16;

// ------------------------------------------------------------ the public key line he pastes

function readSshString(buf, at) {
  if (at + 4 > buf.length) throw new Error("cut short");
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) throw new Error("cut short");
  return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
}
const unsigned = (b) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};
const b64url = (b) => b.toString("base64url");

/**
 * Checks a pasted public key line and returns { key, type, bits, fingerprint, comment } or throws
 * with a plain sentence. Accepts only "ssh-rsa" of 3072 or 4096 bits (2048 with allow2048).
 */
export function parsePublicKeyLine(line, { allow2048 = false } = {}) {
  const text = String(line).trim();
  if (!text) throw new Error("Paste the public key. It starts with ssh-rsa.");
  if (/PRIVATE KEY/.test(text)) throw new Error("That is a private key. Paste the public key instead, and keep the private key in 1Password.");
  const [type, ...tokens] = text.split(/\s+/);
  if (type === "ssh-ed25519") throw new Error("That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
  if (type !== "ssh-rsa") throw new Error("That does not look like an SSH public key. It should start with ssh-rsa.");
  // The key text may have been broken over lines when copied: join pieces until the key is whole.
  let data = "";
  let inner, e, n, at, blob;
  let used = 0;
  for (; used < tokens.length && /^[A-Za-z0-9+/]+={0,2}$/.test(tokens[used]); ) {
    data += tokens[used++];
    blob = Buffer.from(data, "base64");
    try {
      [inner, at] = readSshString(blob, 0);
      [e, at] = readSshString(blob, at);
      [n, at] = readSshString(blob, at);
      if (at === blob.length) break;
    } catch {
      // not whole yet
    }
    inner = undefined;
  }
  if (!inner) throw new Error("The key is incomplete. Copy the whole public key again.");
  const rest = tokens.slice(used);
  if (inner.toString("latin1") !== "ssh-rsa" || at !== blob.length) throw new Error("The key is damaged. Copy the whole public key again.");
  const eu = unsigned(e);
  const nu = unsigned(n);
  const bits = nu.length * 8 - Math.clz32(nu[0]) + 24;
  const eValue = BigInt("0x" + eu.toString("hex"));
  if (eValue < 65537n || eValue % 2n === 0n) throw new Error("This RSA key is not usable for backups. Make a new one in 1Password.");
  if (!(bits === 4096 || bits === 3072 || (allow2048 && bits === 2048))) throw new Error(`This RSA key has ${bits} bits. Make one of 4096 bits.`);
  const key = createPublicKey({ key: { kty: "RSA", n: b64url(nu), e: b64url(eu) }, format: "jwk" });
  const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { key, type, bits, fingerprint, comment: rest.join(" ") };
}

// ------------------------------------------------------------ the private key, from stdin

/** PKCS#8 or PKCS#1 PEM go straight to node:crypto; an unencrypted OpenSSH RSA key is unpacked here. */
export function readPrivateKey(text) {
  const t = String(text).trim();
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(t)) return openSshRsa(t);
  return createPrivateKey({ key: t, format: "pem" });
}

function openSshRsa(t) {
  const body = Buffer.from(t.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = Buffer.from("openssh-key-v1\0", "latin1");
  if (!body.subarray(0, magic.length).equals(magic)) throw new Error("Not an OpenSSH private key.");
  let at = magic.length;
  let cipher, kdf, priv;
  [cipher, at] = readSshString(body, at);
  [kdf, at] = readSshString(body, at);
  [, at] = readSshString(body, at); // kdf options
  if (cipher.toString() !== "none" || kdf.toString() !== "none") throw new Error("This private key has a passphrase. Export it without one.");
  const count = body.readUInt32BE(at);
  at += 4;
  for (let i = 0; i < count; i++) [, at] = readSshString(body, at); // public keys
  [priv] = readSshString(body, at);
  let p = 8; // two check numbers
  let type, n, e, d, iqmp, pp, q;
  [type, p] = readSshString(priv, p);
  if (type.toString() !== "ssh-rsa") throw new Error(`Only RSA keys are supported, not ${type}.`);
  [n, p] = readSshString(priv, p);
  [e, p] = readSshString(priv, p);
  [d, p] = readSshString(priv, p);
  [iqmp, p] = readSshString(priv, p);
  [pp, p] = readSshString(priv, p);
  [q, p] = readSshString(priv, p);
  const big = (b) => BigInt("0x" + (unsigned(b).toString("hex") || "0"));
  const toB = (x, len) => Buffer.from(x.toString(16).padStart(len * 2, "0"), "hex");
  const D = big(d), P = big(pp), Q = big(q);
  const plen = unsigned(pp).length;
  return createPrivateKey({
    key: { kty: "RSA", n: b64url(unsigned(n)), e: b64url(unsigned(e)), d: b64url(unsigned(d)), p: b64url(unsigned(pp)), q: b64url(unsigned(q)), dp: b64url(toB(D % (P - 1n), plen)), dq: b64url(toB(D % (Q - 1n), unsigned(q).length)), qi: b64url(unsigned(iqmp)) },
    format: "jwk",
  });
}

/** The fingerprint of a private key's public half, as "SHA256:..." in ssh-keygen's way. */
export function fingerprintOfPrivate(priv) {
  const jwk = createPublicKey(priv).export({ format: "jwk" });
  const mp = (b64) => {
    let b = Buffer.from(b64, "base64url");
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const str = (b) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const blob = Buffer.concat([str(Buffer.from("ssh-rsa")), str(mp(jwk.e)), str(mp(jwk.n))]);
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

// ------------------------------------------------------------ locking and unlocking, as streams

const nonce = (i) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
};

/** A Transform that turns plain bytes into the locked file. `meta` goes into the readable header. */
export function lockStream(publicKey, fingerprint, meta = {}) {
  const fileKey = randomBytes(32);
  const header = Buffer.from(
    JSON.stringify({
      kind: "pobots-backup",
      format: FORMAT,
      cipher: "aes-256-gcm",
      wrap: "rsa-oaep-sha256",
      keyFingerprint: fingerprint,
      wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, fileKey).toString("base64"),
      chunkSize: CHUNK,
      ...meta,
    }),
  );
  const lead = Buffer.alloc(MAGIC.length + 5);
  MAGIC.copy(lead);
  lead[MAGIC.length] = FORMAT;
  lead.writeUInt32BE(header.length, MAGIC.length + 1);
  const headerHash = createHash("sha256").update(lead).update(header).digest();
  let index = 0;
  let pending = Buffer.alloc(0);
  const frame = (plain, last) => {
    const c = createCipheriv("aes-256-gcm", fileKey, nonce(index++));
    c.setAAD(Buffer.concat([headerHash, Buffer.from([last ? 1 : 0])]));
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length - TAG);
    return Buffer.concat([len, body]);
  };
  let started = false;
  return new Transform({
    transform(chunk, _enc, done) {
      if (!started) {
        this.push(lead);
        this.push(header);
        started = true;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Keep at least one byte back, so the last frame is always marked as last.
      while (pending.length > CHUNK) {
        this.push(frame(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done) {
      if (!started) {
        this.push(lead);
        this.push(header);
      }
      this.push(frame(pending, true));
      fileKey.fill(0);
      done();
    },
  });
}

/** A Transform that turns the locked file back into plain bytes, failing on any change. `onHeader` sees the header first. */
export function unlockStream(privateKey, onHeader = () => {}) {
  let buf = Buffer.alloc(0);
  let header, headerHash, fileKey;
  let index = 0;
  let sawLast = false;
  return new Transform({
    transform(chunk, _enc, done) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (!header) {
          if (buf.length < MAGIC.length + 5) return done();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This is not a Pobots backup.");
          const format = buf[MAGIC.length];
          if (format !== FORMAT) throw new Error(`This backup has format ${format}; this program reads format ${FORMAT}.`);
          const hlen = buf.readUInt32BE(MAGIC.length + 1);
          if (hlen > 64 * 1024) throw new Error("The backup's header is damaged.");
          if (buf.length < MAGIC.length + 5 + hlen) return done();
          const lead = buf.subarray(0, MAGIC.length + 5);
          const raw = buf.subarray(MAGIC.length + 5, MAGIC.length + 5 + hlen);
          header = JSON.parse(raw.toString("utf8"));
          headerHash = createHash("sha256").update(lead).update(raw).digest();
          onHeader(header);
          try {
            fileKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(header.wrappedKey, "base64"));
          } catch {
            throw new Error("This private key does not open this backup.");
          }
          buf = buf.subarray(MAGIC.length + 5 + hlen);
        }
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > header.chunkSize) throw new Error("The backup is damaged.");
          if (buf.length < 4 + len + TAG) break;
          if (sawLast) throw new Error("The backup has data after its end.");
          const ct = buf.subarray(4, 4 + len);
          const tag = buf.subarray(4 + len, 4 + len + TAG);
          buf = buf.subarray(4 + len + TAG);
          const open = (isLast) => {
            const d = createDecipheriv("aes-256-gcm", fileKey, nonce(index));
            d.setAAD(Buffer.concat([headerHash, Buffer.from([isLast ? 1 : 0])]));
            d.setAuthTag(tag);
            return Buffer.concat([d.update(ct), d.final()]);
          };
          let plain;
          try {
            plain = open(false);
          } catch {
            try {
              plain = open(true);
              sawLast = true;
            } catch {
              throw new Error("The backup is damaged or was changed.");
            }
          }
          index++;
          this.push(plain);
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      if (fileKey) fileKey.fill(0);
      if (!header) return done(new Error("The backup is empty or cut short."));
      if (buf.length || !sawLast) return done(new Error("The backup is cut short."));
      done();
    },
  });
}

/** Reads only the header, without any key: what the page and the restore script show first. */
export function readHeader(buf) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This is not a Pobots backup.");
  const hlen = buf.readUInt32BE(MAGIC.length + 1);
  return { format: buf[MAGIC.length], ...JSON.parse(buf.subarray(MAGIC.length + 5, MAGIC.length + 5 + hlen).toString("utf8")) };
}
