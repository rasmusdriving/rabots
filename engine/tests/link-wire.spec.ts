import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agree, checkAuth, LINK_CLOCK_SKEW, LINK_DAY, makeAuth, makeIdentity, open, pairingCode, payloadDigest, readLinkMessage, readPairingCode, seal } from "../core/link-wire.js";

const at = 1_795_000_000_000;
const a = makeIdentity("Sam", "https://example.com:10000", at);
const b = makeIdentity("Kim", null, at);
const keysA = agree(a, b.invite);
const keysB = agree(b, a.invite);

test("pairing codes round trip and only carry public material", () => {
  const code = pairingCode(a.invite);
  assert.deepEqual(readPairingCode(code, at), a.invite);
  assert.deepEqual(readPairingCode(pairingCode(b.invite), at), b.invite);
  assert.match(code, /^pobots-link-1\.[\w.-]+$/);
  const decoded = Buffer.from(code.split(".")[1]!, "base64url").toString();
  assert.ok(!decoded.includes(a.signingKey) && !decoded.includes(a.exchangeKey));
  assert.throws(() => agree(a, a.invite), /your own/);
});

test("a cut-off, mistyped, expired or future code is refused", () => {
  const code = pairingCode(a.invite);
  assert.throws(() => readPairingCode(code.slice(0, -1), at), /typo/);
  assert.throws(() => readPairingCode(code.slice(0, 30) + "!" + code.slice(31), at), /typo/);
  assert.throws(() => readPairingCode(code, at + LINK_DAY), /expired/);
  assert.throws(() => readPairingCode(code, at - LINK_CLOCK_SKEW - 1), /future/);
});

test("each direction is signed and encrypted; a response cannot be replayed against another request", () => {
  const rid = randomUUID();
  const value = { text: "A message for the other side" };
  const body = seal(keysA, "request", b.invite.id, rid, value);
  assert.ok(!body.includes(Buffer.from(value.text)));
  assert.deepEqual(open(keysB, "request", b.invite.id, rid, body), value);
  assert.equal(open(keysB, "response", b.invite.id, rid, body), undefined);
  assert.equal(open(keysB, "request", b.invite.id, randomUUID(), body), undefined);
  assert.equal(open(keysA, "request", b.invite.id, rid, body), undefined);
  const forged = Buffer.from(body);
  forged[0] = forged[0]! ^ 1;
  assert.equal(open(keysB, "request", b.invite.id, rid, forged), undefined);
  const reply = seal(keysB, "response", b.invite.id, rid, value);
  assert.deepEqual(open(keysA, "response", b.invite.id, rid, reply), value);
});

test("short proof binds the envelope and rejects a stale replay or an unrelated link", () => {
  const rid = randomUUID();
  const digest = payloadDigest(Buffer.from("example"));
  const proof = makeAuth(keysA.send.auth, b.invite.id, at, rid, digest);
  assert.deepEqual(checkAuth(keysB.receive.auth, b.invite.id, proof, at), { exchange: rid, at, digest });
  assert.equal(checkAuth(keysB.receive.auth, b.invite.id, proof, at + LINK_CLOCK_SKEW + 1), undefined);
  assert.equal(checkAuth(keysB.receive.auth, randomUUID(), proof, at), undefined);
  assert.equal(checkAuth(keysA.receive.auth, b.invite.id, proof, at), undefined);
});

test("only a recent message of a known type and permitted size can be delivered", () => {
  const m = { id: randomUUID(), at, kind: "ask", text: "Hello" };
  assert.deepEqual(readLinkMessage(m, at), m);
  assert.equal(readLinkMessage(m, at + LINK_DAY), undefined);
  assert.equal(readLinkMessage({ ...m, text: "x".repeat(20_001) }, at), undefined);
  assert.equal(readLinkMessage({ ...m, kind: "answer" }, at), undefined);
});
