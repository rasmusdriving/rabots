// The locked file format of the nightly backup, and the checks of the pasted key. No model, no OneDrive.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, test } from "node:test";
import { CHUNK, fingerprintOfKey, lockStream, parsePublicKeyLine, readHeader, readPrivateKey, unlockStream, type BackupHeader } from "../backup-format.js";
import { standInKeys } from "./backup-keys.js";

async function lock(plain: Buffer, line: string, meta: Record<string, unknown> = {}): Promise<Buffer> {
  const pub = parsePublicKeyLine(line);
  const out: Buffer[] = [];
  await pipeline(Readable.from(chunks(plain)), lockStream(pub.key, pub.fingerprint, meta), new Writable({ write: (c, _e, cb) => (out.push(c), cb()) }));
  return Buffer.concat(out);
}

async function unlock(file: Buffer, privatePem: string, onHeader?: (h: BackupHeader) => void): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from(chunks(file)), unlockStream(readPrivateKey(privatePem), onHeader), new Writable({ write: (c, _e, cb) => (out.push(c), cb()) }));
  return Buffer.concat(out);
}

/** Pieces of odd sizes, as a stream delivers them. */
function* chunks(buf: Buffer): Generator<Buffer> {
  let at = 0;
  let n = 1;
  while (at < buf.length) {
    const size = Math.min(buf.length - at, 1 + ((n++ * 7919) % 300_000));
    yield buf.subarray(at, at + size);
    at += size;
  }
}

/** Where frame `i` ends in a locked file. */
function frameEnd(file: Buffer, frames: number): number {
  let at = 13 + file.readUInt32BE(9);
  for (let i = 0; i < frames; i++) at += 4 + file.readUInt32BE(at) + 16;
  return at;
}

describe("backup file format", () => {
  const keys = standInKeys();
  const plain = randomBytes(CHUNK * 2 + 12345);

  test("round trip over several frames; the header is readable without the key", async () => {
    const file = await lock(plain, keys.publicLine, { createdAt: "2026-11-14T02:00:00.000Z", engineVersion: "0.12.0" });
    const header = readHeader(file);
    assert.equal(header.format, 1);
    assert.equal(header.kind, "pobots-backup");
    assert.equal(header.engineVersion, "0.12.0");
    assert.equal(header.keyFingerprint, parsePublicKeyLine(keys.publicLine).fingerprint);
    let seen: BackupHeader | undefined;
    const back = await unlock(file, keys.openssh, (h) => (seen = h));
    assert.ok(back.equals(plain));
    assert.equal(seen?.createdAt, "2026-11-14T02:00:00.000Z");
    // An empty input still makes a whole, openable file.
    assert.equal((await unlock(await lock(Buffer.alloc(0), keys.publicLine), keys.pkcs8)).length, 0);
  });

  test("refusals: wrong key, a byte changed, cut at the end, cut after a whole frame, header edited, a newer format", async () => {
    const file = await lock(plain, keys.publicLine, { engineVersion: "0.12.0" });
    await assert.rejects(unlock(file, keys.otherPrivate), /This private key does not open this backup\./);
    const changed = Buffer.from(file);
    changed[Math.floor(changed.length / 2)]! ^= 1;
    await assert.rejects(unlock(changed, keys.pkcs8), /The backup is damaged or was changed\./);
    await assert.rejects(unlock(file.subarray(0, file.length - 100), keys.pkcs8), /The backup is cut short\./);
    await assert.rejects(unlock(file.subarray(0, frameEnd(file, 2)), keys.pkcs8), /The backup is cut short\./);
    const edited = Buffer.from(file.toString("latin1").replace('"engineVersion":"0.12.0"', '"engineVersion":"0.12.1"'), "latin1");
    assert.notDeepEqual(edited, file);
    await assert.rejects(unlock(edited, keys.pkcs8), /damaged or was changed/);
    const future = Buffer.from(file);
    future[8] = 2;
    assert.throws(() => readHeader(future), /This backup was made by a newer Pobots \(format 2\)\. Use a newer Pobots to open it\./);
    await assert.rejects(unlock(future, keys.pkcs8), /newer Pobots/);
    await assert.rejects(unlock(Buffer.from("not a backup at all"), keys.pkcs8), /This is not a Pobots backup\./);
    await assert.rejects(unlock(Buffer.alloc(0), keys.pkcs8), /empty or cut short/);
    // Data after the last frame.
    await assert.rejects(unlock(Buffer.concat([file, file.subarray(frameEnd(file, 0), frameEnd(file, 1))]), keys.pkcs8), /damaged or was changed/);
  });

  test("the pasted public key: every refusal in plain words, never repeating what was pasted", () => {
    const refusal = (line: string) => {
      try {
        parsePublicKeyLine(line);
      } catch (err) {
        const message = (err as Error).message;
        const piece = line.trim().slice(10, 40);
        if (piece.length >= 8) assert.ok(!message.includes(piece), "the refusal repeats the paste");
        return message;
      }
      return "accepted";
    };
    assert.equal(refusal(""), "Paste the public key. It starts with ssh-rsa.");
    assert.equal(refusal("   \n "), "Paste the public key. It starts with ssh-rsa.");
    for (const priv of [keys.openssh, keys.pkcs8, keys.pkcs1]) {
      assert.equal(refusal(priv), "That is a private key. Paste the public key instead, and keep the private key in 1Password.");
    }
    assert.equal(refusal(keys.ed25519Line), "That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
    assert.equal(refusal("hello there"), "That does not look like a public key. It should start with ssh-rsa.");
    assert.equal(refusal("ecdsa-sha2-nistp256 AAAAE2VjZHNh"), "That does not look like a public key. It should start with ssh-rsa.");
    assert.equal(refusal(keys.publicLine.slice(0, 300)), "The key is incomplete. Copy the whole public key again.");
    assert.equal(refusal("ssh-rsa"), "The key is incomplete. Copy the whole public key again.");
    assert.equal(refusal(keys.rsa2048Line), "This RSA key has 2048 bits. Make one of 4096 bits.");
    // A key line of another type behind "ssh-rsa".
    const edBlob = keys.ed25519Line.split(" ")[1]!;
    assert.equal(refusal(`ssh-rsa ${edBlob}`), "That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
    const ecBlob = Buffer.concat([Buffer.from([0, 0, 0, 19]), Buffer.from("ecdsa-sha2-nistp256"), Buffer.from([0, 0, 0, 2]), Buffer.from("ab")]).toString("base64");
    assert.equal(refusal(`ssh-rsa ${ecBlob}`), "The key is damaged. Copy the whole public key again.");
    // Broken over lines and with spaces around it: accepted, the same key.
    const good = parsePublicKeyLine(keys.publicLine);
    assert.equal(good.bits, 4096);
    const broken = "  " + keys.publicLine.trim().replace(/(.{60})/g, "$1\n") + "  \n";
    assert.equal(parsePublicKeyLine(broken).fingerprint, good.fingerprint);
    // One character changed in the middle: still a valid key, another one. Only the fingerprint shows it.
    const line = keys.publicLine;
    const changed = line.slice(0, 400) + (line[400] === "A" ? "B" : "A") + line.slice(401);
    assert.notEqual(parsePublicKeyLine(changed).fingerprint, good.fingerprint);
    // 3072 bits are accepted. What is kept is one clean line without the comment.
    assert.equal(parsePublicKeyLine(keys.otherPublicLine).bits, 3072);
    assert.match(good.line, /^ssh-rsa [A-Za-z0-9+/]+=*$/);
    assert.ok(!good.line.includes("example.com"));
  });

  test("a key whose numbers are not in canonical SSH form is refused (its fingerprint would not match 1Password's)", () => {
    const blob = Buffer.from(keys.publicLine.split(/\s+/)[1]!, "base64");
    const fields: Buffer[] = [];
    for (let at = 0; at < blob.length; ) {
      const len = blob.readUInt32BE(at);
      fields.push(blob.subarray(at + 4, at + 4 + len));
      at += 4 + len;
    }
    const [type, e, n] = fields as [Buffer, Buffer, Buffer];
    assert.equal(n[0], 0, "a 4096-bit modulus has its top bit set, so its canonical form starts with one zero byte");
    const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, 0].map((_, i) => (b.length >>> (24 - 8 * i)) & 0xff)), b]);
    const line = (ee: Buffer, nn: Buffer) => `ssh-rsa ${Buffer.concat([str(type), str(ee), str(nn)]).toString("base64")} stand-in@example.com`;
    // The canonical one, rebuilt by hand, is the same key with the same fingerprint.
    assert.equal(parsePublicKeyLine(line(e, n)).fingerprint, parsePublicKeyLine(keys.publicLine).fingerprint);
    const zero = Buffer.from([0]);
    const cases: [string, string][] = [
      ["an extra zero before the modulus", line(e, Buffer.concat([zero, n]))],
      ["two extra zeroes before the modulus", line(e, Buffer.concat([zero, zero, n]))],
      ["a zero before the exponent", line(Buffer.concat([zero, e]), n)],
      ["the modulus without its zero (a negative number)", line(e, n.subarray(1))],
      ["an empty exponent", line(Buffer.alloc(0), n)],
    ];
    for (const [what, bad] of cases) {
      assert.throws(() => parsePublicKeyLine(bad), (err: Error) => err.message === "That key is not in the usual form. Copy the public key again from 1Password.", what);
    }
  });

  test("the fingerprint is the one ssh-keygen prints", () => {
    const fromKeygen = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", keys.publicFile], { encoding: "utf8" }).split(" ")[1];
    assert.equal(parsePublicKeyLine(keys.publicLine).fingerprint, fromKeygen);
    assert.match(fromKeygen!, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test("private keys in PKCS#8, PKCS#1 and OpenSSH form are read, and match the public key; a passphrase is refused", () => {
    const pub = parsePublicKeyLine(keys.publicLine);
    assert.match(keys.pkcs8, /BEGIN PRIVATE KEY/);
    assert.match(keys.pkcs1, /BEGIN RSA PRIVATE KEY/);
    assert.match(keys.openssh, /BEGIN OPENSSH PRIVATE KEY/);
    for (const pem of [keys.pkcs8, keys.pkcs1, keys.openssh]) {
      const k = readPrivateKey(pem);
      assert.equal(createPublicKey(k).export({ format: "jwk" }).n, pub.key.export({ format: "jwk" }).n);
      assert.equal(fingerprintOfKey(k), pub.fingerprint);
    }
    assert.throws(() => readPrivateKey(keys.withPassphrase), /This private key has a passphrase\. Export it without one\./);
    assert.throws(() => readPrivateKey(""), /No private key came in/);
    assert.throws(() => readPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /could not be read/);
  });
});
