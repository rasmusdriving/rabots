// The browser's side of web push, for the tests: opening a message the engine locked (RFC 8188 and
// RFC 8291), and made-up subscriptions with real key pairs on made-up addresses.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { b64u, type Subscription } from "../push.js";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** The receiving side of RFC 8188, records of any size: what a browser does with the body. */
export function decryptAes128gcm(body: Buffer, ikm: Buffer): { plaintext: Buffer; keyId: Buffer } {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const keyId = body.subarray(21, 21 + idlen);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const out: Buffer[] = [];
  let pos = 21 + idlen;
  for (let seq = 0; pos < body.length; seq++) {
    const record = body.subarray(pos, Math.min(pos + rs, body.length));
    pos += record.length;
    const iv = Buffer.from(nonce);
    // The record's sequence number is XORed into the end of the nonce (never above 2^32 records here).
    iv.writeUInt32BE((iv.readUInt32BE(8) ^ seq) >>> 0, 8);
    const d = createDecipheriv("aes-128-gcm", cek, iv);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    const delimiter = plain[end];
    assert.equal(delimiter, pos >= body.length ? 2 : 1, "padding delimiter");
    out.push(plain.subarray(0, end));
  }
  return { plaintext: Buffer.concat(out), keyId };
}

/** The receiving side of RFC 8291: what the browser does with a push message. */
export function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const uaPublic = ua.getPublicKey();
  const prkKey = hmac(authSecret, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  return decryptAes128gcm(body, ikm).plaintext;
}

/** A made-up subscription with a real key pair, so the body can be opened in the test. */
export function fakeSubscription(endpoint: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("fedcba9876543210");
  const sub: Subscription = { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  return { sub, uaPrivate: ua.getPrivateKey(), auth };
}

