// Web push without a device: the message locking against the RFC test vectors, the VAPID token,
// the key file, the device list, how the push services' answers are handled (engine/push.ts), the
// test relay, and the one HTTP route left (POST /api/push/renew). No network: a stand-in for fetch.
import assert from "node:assert/strict";
import { createECDH, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { EngineError } from "../errors.js";
import { aes128gcm, b64u, cleanLabel, DEAD_MAX, DEFAULT_SUBJECT, deviceId, encryptForBrowser, fromB64u, KNOWN_REASONS, problemText, PushStore, pushServiceOf, REDIRECTED, sendPush, sendResult, vapidAuthorization, type Subscription } from "../push.js";
import { EngineServer } from "../server.js";
import { setup } from "./fake.js";
import { tempDir } from "./helpers.js";
import { decryptAes128gcm, decryptAsBrowser, fakeSubscription } from "./push-browser.js";

const joinB64 = (...parts: string[]) => fromB64u(parts.join("").replace(/\s+/g, ""));

describe("RFC 8188: the aes128gcm content coding", () => {
  // The RFC's text says 54 octets, but its printed body decodes to 53 (21 header, 15 message, 1
  // delimiter, 16 tag). The bytes are what is compared.
  test("3.1, encryption of a response: the same bytes as the RFC", () => {
    const body = aes128gcm(Buffer.from("I am the walrus"), fromB64u("yqdlZ-tYemfogSmv7Ws5PQ"), fromB64u("I1BsxtFttlv3u_Oo94xnmw"));
    assert.equal(body.length, 53);
    assert.equal(b64u(body), "I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg");
  });

  test("3.2, multiple records: the RFC's body opens to the message with key id a1", () => {
    const body = joinB64("uNCkWiNYzKTnBN9ji3-qWAAAABkCYTHOG8chz_gnvgOqdGYovxyjuqRyJFjEDyoF", "1Fvkj6hQPdPHI51OEUKEpgz3SsLWIqS_uA");
    const { plaintext, keyId } = decryptAes128gcm(body, fromB64u("BO3ZVPxUlnLORbVGMpbT1Q"));
    assert.equal(plaintext.toString(), "I am the walrus");
    assert.equal(keyId.toString(), "a1");
  });

  test("a message that does not fit in one record is refused", () => {
    assert.throws(() => aes128gcm(Buffer.alloc(4096), Buffer.alloc(16), Buffer.alloc(16)));
  });
});

describe("RFC 8291: a push message locked for one browser", () => {
  const v = {
    plaintext: "When I grow up, I want to be a watermelon",
    authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: [
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    ].join(""),
  };

  // The RFC's example says Content-Length 145, but its printed body decodes to 144 (86 header,
  // 41 message, 1 delimiter, 16 tag). The bytes are what is compared.
  test("section 5: the same bytes as the RFC, from its keys and salt", () => {
    const body = encryptForBrowser(Buffer.from(v.plaintext), { p256dh: v.uaPublic, auth: v.authSecret }, { asPrivate: fromB64u(v.asPrivate), salt: fromB64u(v.salt) });
    assert.equal(body.length, 144);
    assert.equal(b64u(body), v.body);
  });

  test("section 5: the browser's side opens the RFC's message", () => {
    assert.equal(decryptAsBrowser(fromB64u(v.body), fromB64u(v.uaPrivate), fromB64u(v.authSecret)).toString(), v.plaintext);
  });

  test("a fresh key pair and salt every time, and the browser opens each one", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
    const msg = JSON.stringify({ title: "Pobots", body: "Trial: a notification from the page" });
    const a = encryptForBrowser(Buffer.from(msg), keys);
    const b = encryptForBrowser(Buffer.from(msg), keys);
    assert.notEqual(b64u(a.subarray(0, 16)), b64u(b.subarray(0, 16)), "salt differs");
    assert.notEqual(b64u(a.subarray(21, 86)), b64u(b.subarray(21, 86)), "sender key differs");
    assert.equal(decryptAsBrowser(a, ua.getPrivateKey(), auth).toString(), msg);
    assert.equal(decryptAsBrowser(b, ua.getPrivateKey(), auth).toString(), msg);
  });

  test("wrong keys from a browser are refused before anything is sent", () => {
    assert.throws(() => encryptForBrowser(Buffer.from("x"), { p256dh: b64u(Buffer.alloc(65, 4)), auth: b64u(Buffer.alloc(15)) }));
  });
});

describe("RFC 8292: VAPID", () => {
  test("an ES256 token for the push service's origin, signed with the engine's key", () => {
    const store = new PushStore(join(tempDir(), "push"));
    const keys = store.vapid();
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    const { token, header } = vapidAuthorization("https://web.push.apple.com/QGuQyavXut/some/path", keys, DEFAULT_SUBJECT, now);
    assert.equal(header, `vapid t=${token}, k=${keys.publicKey}`);
    const [h, c, s] = token.split(".") as [string, string, string];
    assert.deepEqual(JSON.parse(fromB64u(h).toString()), { typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(fromB64u(c).toString()) as { aud: string; exp: number; sub: string };
    assert.equal(claims.aud, "https://web.push.apple.com");
    assert.equal(claims.sub, DEFAULT_SUBJECT);
    assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600, "exp within 24 hours");
    const sig = fromB64u(s);
    assert.equal(sig.length, 64, "r and s, 32 bytes each");
    const pub = fromB64u(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, sig));
  });

  test("a subject that is not mailto: or https: is refused (Apple refuses it too)", () => {
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    assert.throws(() => vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", keys, "http://localhost"));
    assert.doesNotThrow(() => vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", keys, "mailto:someone@example.com"));
  });

  test("the key pair is made once, kept with mode 600, and the same next time", () => {
    const dir = join(tempDir(), "push");
    const first = new PushStore(dir).vapid();
    const path = join(dir, "vapid.json");
    assert.ok(existsSync(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const again = new PushStore(dir).vapid();
    assert.equal(again.publicKey, first.publicKey);
    assert.equal(fromB64u(first.publicKey).length, 65);
    assert.equal(fromB64u(first.privateKey).length, 32);
  });
});

describe("the push services", () => {
  test("only the known push services are accepted", () => {
    assert.equal(pushServiceOf("https://fcm.googleapis.com/fcm/send/abc"), "Google");
    assert.equal(pushServiceOf("https://android.googleapis.com/gcm/send/abc"), "Google");
    assert.equal(pushServiceOf("https://jmt17.google.com/fcm/send/abc"), "Google");
    assert.equal(pushServiceOf("https://JMT0.google.com/fcm/send/abc"), "Google");
    // Only Google's push hosts, not all of google.com.
    for (const other of ["https://www.google.com/x", "https://accounts.google.com/x", "https://google.com/x", "https://jmt.google.com/x", "https://jmt17x.google.com/x", "https://a.jmt17.google.com/x", "https://jmt17.google.com.example.com/x", "https://storage.googleapis.com/x"])
      assert.equal(pushServiceOf(other), undefined, other);
    assert.equal(pushServiceOf("https://push.apple.com/x"), undefined, "Apple's own hosts only below push.apple.com, or web.push.apple.com");
    assert.equal(pushServiceOf("https://api.push.apple.com/x"), "Apple");
    assert.equal(pushServiceOf("https://push.services.mozilla.com/x"), undefined);
    assert.equal(pushServiceOf("https://wns2-am3p.notify.windows.com/w/?token=abc"), "Microsoft");
    assert.equal(pushServiceOf("https://updates.push.services.mozilla.com/wpush/v2/abc"), "Mozilla");
    assert.equal(pushServiceOf("https://web.push.apple.com/abc"), "Apple");
    assert.equal(pushServiceOf("http://fcm.googleapis.com/fcm/send/abc"), undefined);
    assert.equal(pushServiceOf("https://fcm.googleapis.com.example.com/x"), undefined);
    assert.equal(pushServiceOf("https://google.com.example.com/x"), undefined);
    assert.equal(pushServiceOf("https://evilgoogle.com/x"), undefined);
    assert.equal(pushServiceOf("https://127.0.0.1/x"), undefined);
    assert.equal(pushServiceOf("https://fcm.googleapis.com:8443/x"), undefined);
  });

  test("the request: POST, VAPID, TTL, urgency, aes128gcm, and a body the browser can open", async () => {
    const { sub, uaPrivate, auth } = fakeSubscription("https://web.push.apple.com/made-up-path");
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const out = await sendPush(sub, '{"title":"Pobots"}', keys, { fetch: fakeFetch, ttl: 60, urgency: "high", topic: "trial" });
    assert.deepEqual(out, { kind: "sent", status: 201 });
    assert.ok(seen);
    assert.equal(seen.url, sub.endpoint);
    assert.equal(seen.init.method, "POST");
    const h = seen.init.headers as Record<string, string>;
    assert.match(h.Authorization!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(h.TTL, "60");
    assert.equal(h.Urgency, "high");
    assert.equal(h.Topic, "trial");
    assert.equal(h["Content-Encoding"], "aes128gcm");
    assert.equal(h["Content-Type"], "application/octet-stream");
    assert.equal(decryptAsBrowser(Buffer.from(seen.init.body as Uint8Array), uaPrivate, auth).toString(), '{"title":"Pobots"}');
  });

  test("the test relay: the bytes go to the relay, the real address in X-Push-Address, and the address is still checked", async () => {
    const { sub, uaPrivate, auth } = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-relay");
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const out = await sendPush(sub, '{"title":"Pobots"}', keys, { fetch: fakeFetch, relay: "http://127.0.0.1:45999" });
    assert.deepEqual(out, { kind: "sent", status: 201 });
    assert.equal(seen[0]!.url, "http://127.0.0.1:45999");
    assert.equal(seen[0]!.headers["X-Push-Address"], sub.endpoint);
    assert.match(seen[0]!.headers.Authorization!, /^vapid t=/);
    assert.equal(decryptAsBrowser(seen[0]!.body, uaPrivate, auth).toString(), '{"title":"Pobots"}');
    const bad = await sendPush({ ...sub, endpoint: "https://push.example.com/x" }, "{}", keys, { fetch: fakeFetch, relay: "http://127.0.0.1:45999" });
    assert.equal(bad.kind, "error", "an unknown push service is refused before the relay too");
    assert.equal(seen.length, 1);
  });

  test("the answers: 2xx sent, 404 and 410 gone, anything else refused in fixed words, no answer unreachable", async () => {
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    const { sub } = fakeSubscription("https://web.push.apple.com/made-up-answers");
    const answer = (status: number, body?: string) => (async () => new Response(body ?? null, { status })) as unknown as typeof fetch;
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(201) }), { kind: "sent", status: 201 });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(404) }), { kind: "gone", status: 404 });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(410) }), { kind: "gone", status: 410 });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(403, '{"reason":"BadJwtToken"}') }), { kind: "failed", status: 403, reason: "BadJwtToken" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(403, '{"reason":"ExpiredJwtToken"}') }), { kind: "failed", status: 403, reason: "ExpiredJwtToken" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(400, '{"reason":"BadDeviceToken"}') }), { kind: "failed", status: 400, reason: "BadDeviceToken" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(429, '{"reason":"TooManyRequests"}') }), { kind: "failed", status: 429, reason: "TooManyRequests" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(413, '{"reason":"PayloadTooLarge"}') }), { kind: "failed", status: 413, reason: "PayloadTooLarge" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(500) }), { kind: "failed", status: 500, reason: "push service error (500)" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(413, "too big") }), { kind: "failed", status: 413, reason: "message too large (413)" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(403, "Forbidden, see the docs") }), { kind: "failed", status: 403, reason: "status 403" }, "a plain text is never copied");
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(418, '{"reason":"BadJwtToken "}') }), { kind: "failed", status: 418, reason: "status 418" }, "only an exact name of the list counts");
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(400, '{"reason":"badjwttoken"}') }), { kind: "failed", status: 400, reason: "message not accepted (400)" });
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: answer(400, '{"message":"BadJwtToken"}') }), { kind: "failed", status: 400, reason: "message not accepted (400)" }, "only Apple's reason field is read");
    const long = await sendPush(sub, "{}", keys, { fetch: answer(400, `see https://example.com/secret-path ${"x".repeat(300)}`) });
    assert.deepEqual(long, { kind: "failed", status: 400, reason: "message not accepted (400)" });
    for (const r of KNOWN_REASONS) assert.ok(r.length <= 32 && /^[A-Za-z]+$/.test(r), "each kept name is short and plain");
    assert.equal(problemText(299, ""), "status 299");
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: broken }), { kind: "error", unreachable: true, reason: "The push service could not be reached." });
    const badKeys = await sendPush({ endpoint: sub.endpoint, keys: { p256dh: "made-up-not-a-key", auth: "made-up-not-a-secret" } }, "{}", keys, { fetch: answer(201) });
    assert.deepEqual(badKeys, { kind: "error", reason: "The message could not be made for this device." });
    const slow = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: slow, timeoutMs: 20 }), { kind: "error", unreachable: true, reason: "The push service did not answer in time." });
    assert.deepEqual(sendResult({ kind: "error", unreachable: true, reason: "x" }), { result: "unreachable", problem: "The push service could not be reached." }, "a text that is not a fixed one is never kept");
    assert.deepEqual(sendResult({ kind: "error", reason: "made-up-secret" }), { result: "refused", problem: "The message could not be made for this device." });
    assert.deepEqual(sendResult({ kind: "failed", status: 403, reason: "BadJwtToken" }), { result: "refused", problem: "BadJwtToken" });
    assert.deepEqual(sendResult({ kind: "failed", status: 403, reason: "see (address) made-up-secret" }), { result: "refused", problem: "status 403" });
    assert.deepEqual(sendResult({ kind: "sent", status: 201 }), { result: "sent" });
  });
});

describe("redirects: never followed, so the bytes go nowhere but the checked address", () => {
  test("a 307 or 308 from an accepted push service is refused in fixed words; nothing is sent to the other host", async () => {
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    const { sub } = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-redirect");
    for (const status of [301, 302, 303, 307, 308]) {
      const hosts: string[] = [];
      let redirect: RequestInit["redirect"];
      // A stand-in that does what fetch does: it follows the redirect unless told not to.
      const followFetch = (async (url: string, init: RequestInit) => {
        hosts.push(new URL(url).host);
        redirect = init.redirect;
        if (new URL(url).host === "fcm.googleapis.com") {
          const res = new Response(null, { status, headers: { Location: "https://elsewhere.example.com/collect" } });
          if (init.redirect === "manual" || init.redirect === "error") return res;
          return followFetch("https://elsewhere.example.com/collect", init);
        }
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch;
      const out = await sendPush(sub, "{}", keys, { fetch: followFetch });
      assert.deepEqual(out, { kind: "failed", status, reason: REDIRECTED }, `${status} is refused`);
      assert.deepEqual(hosts, ["fcm.googleapis.com"], `${status}: nothing went to the other host`);
      assert.equal(redirect, "manual");
    }
    // A browser-style answer to manual: an opaque redirect.
    const opaque = (async () => ({ type: "opaqueredirect", status: 0, body: null }) as unknown as Response) as unknown as typeof fetch;
    assert.deepEqual(await sendPush(sub, "{}", keys, { fetch: opaque }), { kind: "failed", status: 0, reason: REDIRECTED });
    assert.deepEqual(sendResult({ kind: "failed", status: 307, reason: REDIRECTED }), { result: "refused", problem: REDIRECTED });
  });

  test("with Node's own fetch: a 307 to another server sends it nothing (through the test relay, on this machine only)", async () => {
    const keys = new PushStore(join(tempDir(), "push")).vapid();
    const { sub } = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-real-redirect");
    let elsewhere = 0;
    const other = createServer((req, res) => {
      elsewhere++;
      req.resume();
      res.writeHead(201).end();
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherPort = (other.address() as AddressInfo).port;
    let first = 0;
    const relay = createServer((req, res) => {
      first++;
      req.resume();
      res.writeHead(307, { Location: `http://127.0.0.1:${otherPort}/collect` }).end();
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    try {
      const out = await sendPush(sub, "{}", keys, { relay: `http://127.0.0.1:${(relay.address() as AddressInfo).port}` });
      assert.deepEqual(out, { kind: "failed", status: 307, reason: REDIRECTED });
      assert.equal(first, 1);
      assert.equal(elsewhere, 0, "the other server got nothing");
    } finally {
      await new Promise((r) => relay.close(r));
      await new Promise((r) => other.close(r));
    }
  });
});

describe("the device list (subscriptions.json)", () => {
  const at = "2026-11-13T12:00:00.000Z";

  test("kept with mode 600; its view holds no address or keys; an unknown push service and bad keys are refused in plain words", () => {
    const dir = join(tempDir(), "push");
    const store = new PushStore(dir);
    const { sub } = fakeSubscription("https://updates.push.services.mozilla.com/wpush/v2/made-up");
    const { id, added } = store.keep(sub, "Firefox on Mac", { mayAdd: true, at });
    assert.equal(added, true);
    assert.equal(id, deviceId(sub.endpoint));
    assert.equal(statSync(join(dir, "subscriptions.json")).mode & 0o777, 0o600);
    const shown = JSON.stringify(store.list());
    assert.ok(!shown.includes("made-up") && !shown.includes(sub.keys.p256dh) && !shown.includes(sub.keys.auth));
    assert.deepEqual(store.list(), [{ id, label: "Firefox on Mac", service: "Mozilla", addedAt: at }]);
    assert.ok(readFileSync(join(dir, "subscriptions.json"), "utf8").includes("made-up"), "the address is in the file only");
    assert.throws(() => store.keep({ ...sub, endpoint: "https://push.example.com/x" }, "x", { mayAdd: true, at }), (e: unknown) => e instanceof EngineError && e.code === "bad_request" && /push\.example\.com/.test(e.message));
    assert.throws(() => store.keep({ endpoint: "https://fcm.googleapis.com/fcm/send/k", keys: { p256dh: b64u(Buffer.alloc(65, 4)), auth: b64u(Buffer.alloc(15)) } }, "x", { mayAdd: true, at }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
    assert.equal(store.list().length, 1);
  });

  test("the same address again updates its row; mayAdd false refuses an unknown one; a renewal's replaces takes a known row's place; at most 20", () => {
    const store = new PushStore(join(tempDir(), "push"));
    const a = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-a").sub;
    const idA = store.keep(a, "Chrome on Windows", { mayAdd: true, at }).id;
    const again = store.keep({ ...a, keys: fakeSubscription(a.endpoint).sub.keys }, "Chrome on Windows 11", { mayAdd: false, at: "2026-11-14T00:00:00.000Z" });
    assert.deepEqual(again, { id: idA, added: false });
    assert.equal(store.list()[0]!.label, "Chrome on Windows 11");
    assert.equal(store.list()[0]!.addedAt, at, "added at stays");

    const unknown = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-unknown").sub;
    assert.throws(() => store.keep(unknown, "x", { mayAdd: false, at }), (e: unknown) => e instanceof EngineError && e.code === "not_found" && !e.message.includes("made-up"));

    const moved = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-a2").sub;
    const r = store.keep(moved, "Chrome on Windows", { mayAdd: false, renewal: true, replaces: idA, at });
    assert.equal(r.id, deviceId(moved.endpoint));
    assert.deepEqual(store.list().map((d) => d.id), [r.id], "the row took the new address, in its place");

    for (let i = 0; store.list().length < 20; i++) store.keep(fakeSubscription(`https://fcm.googleapis.com/fcm/send/made-up-many-${i}`).sub, `Device ${i}`, { mayAdd: true, at });
    assert.throws(
      () => store.keep(fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-21").sub, "One too many", { mayAdd: true, at }),
      (e: unknown) => e instanceof EngineError && e.code === "too_many" && !e.message.includes("made-up"),
    );
    assert.equal(store.keep(moved, "Chrome on Windows", { mayAdd: true, at }).added, false, "a known device is still updated at 20");
  });

  test("a gone device keeps its row without address and keys, gets nothing, and works again only when turned on again", async () => {
    const dir = join(tempDir(), "push");
    let calls = 0;
    const store = new PushStore(dir, {
      fetch: (async () => {
        calls++;
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const { sub } = fakeSubscription("https://web.push.apple.com/made-up-gone");
    const { id } = store.keep(sub, "Home screen app on iPhone", { mayAdd: true, at });
    store.markGone(id, "2026-11-14T08:00:00.000Z");
    const file = readFileSync(join(dir, "subscriptions.json"), "utf8");
    assert.ok(!file.includes("made-up-gone") && !file.includes(sub.keys.p256dh) && !file.includes(sub.keys.auth), "address and keys are dropped from the file");
    assert.deepEqual(store.list(), [{ id, label: "Home screen app on iPhone", service: "Apple", addedAt: at, goneAt: "2026-11-14T08:00:00.000Z" }]);
    const out = await store.deliver(id, "{}", {});
    assert.equal(out.kind, "error");
    assert.equal(calls, 0, "nothing is sent to a gone device");
    // The page saying "still here" with the very address the push service called gone: refused, still gone.
    assert.throws(() => store.keep(sub, "Home screen app on iPhone", { mayAdd: false, at }), (e: unknown) => e instanceof EngineError && e.code === "conflict" && !e.message.includes("made-up"));
    assert.equal(store.list()[0]!.goneAt, "2026-11-14T08:00:00.000Z", "still gone");
    assert.equal((await store.deliver(id, "{}", {})).kind, "error");
    assert.equal(calls, 0, "and still nothing is sent to it");
    // A renewed address in its place (replaces), without a press: the row works again with the new address.
    const fresh = fakeSubscription("https://web.push.apple.com/made-up-gone-fresh").sub;
    const renewed = store.keep(fresh, "Home screen app on iPhone", { mayAdd: false, replaces: id, at });
    assert.equal(renewed.id, deviceId(fresh.endpoint));
    assert.deepEqual(store.list().map((d) => [d.id, d.goneAt]), [[renewed.id, undefined]], "the same row, in its place, working again");
    assert.equal((await store.deliver(renewed.id, "{}", {})).kind, "sent");
    // His press on "Turn on" (asked) with the very address the push service called gone: refused too.
    store.markGone(renewed.id, "2026-11-15T08:00:00.000Z");
    assert.throws(() => store.keep(fresh, "Home screen app on iPhone", { mayAdd: true, at }), (e: unknown) => e instanceof EngineError && e.code === "conflict" && !e.message.includes("made-up"));
    assert.equal(store.list()[0]!.goneAt, "2026-11-15T08:00:00.000Z", "still gone after the press with the dead address");
    // His press with a fresh address in the gone row's place mends it.
    const third = fakeSubscription("https://web.push.apple.com/made-up-gone-third").sub;
    const pressed = store.keep(third, "Home screen app on iPhone", { mayAdd: true, replaces: renewed.id, at });
    assert.deepEqual(pressed, { id: deviceId(third.endpoint), added: false });
    assert.deepEqual(store.list().map((d) => [d.id, d.goneAt]), [[pressed.id, undefined]]);
    assert.equal(store.forget(pressed.id), true);
    assert.equal(store.forget(pressed.id), false);
    assert.deepEqual(store.list(), []);
  });

  test("an address the push service called gone is never taken again, by any way in: a press, still here, a replaces, a renewal; also after its row was replaced or forgotten, and after a restart", () => {
    const dir = join(tempDir(), "push");
    const store = new PushStore(dir);
    const dead = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-dead").sub;
    const idDead = store.keep(dead, "Chrome on Android", { mayAdd: true, at }).id;
    store.markGone(idDead, "2026-11-14T08:00:00.000Z");
    assert.deepEqual(store.deadIds(), [idDead]);
    const file = readFileSync(join(dir, "subscriptions.json"), "utf8");
    assert.ok(!file.includes("made-up-dead"), "the dead list holds the id, never the address");
    const refused = (fn: () => unknown, why: string) => assert.throws(fn, (e: unknown) => e instanceof EngineError && e.code === "conflict" && !e.message.includes("made-up"), why);
    const same = { ...dead, keys: fakeSubscription(dead.endpoint).sub.keys };

    // The gone row itself is still there: every way in is refused.
    refused(() => store.keep(dead, "x", { mayAdd: true, at }), "a press");
    refused(() => store.keep(same, "x", { mayAdd: true, at }), "a press, with new keys for the same address");
    refused(() => store.keep(dead, "x", { mayAdd: false, at }), "still here");
    refused(() => store.keep(dead, "x", { mayAdd: true, replaces: idDead, at }), "a press naming its own row");
    refused(() => store.keep(dead, undefined, { mayAdd: false, renewal: true, at }), "a renewal");

    // A fresh address takes the gone row's place (his press). The dead address stays dead.
    const fresh = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-fresh").sub;
    const idFresh = store.keep(fresh, "Chrome on Android", { mayAdd: true, replaces: idDead, at }).id;
    refused(() => store.keep(dead, "x", { mayAdd: true, at }), "a press, after its row was replaced");
    refused(() => store.keep(dead, "x", { mayAdd: true, replaces: idFresh, at }), "a press naming the working row, after its row was replaced");
    refused(() => store.keep(dead, "x", { mayAdd: false, replaces: idFresh, at }), "a stale tab's still here naming the working row");
    refused(() => store.keep(dead, undefined, { mayAdd: false, renewal: true, replaces: idFresh, at }), "a renewal naming the working row");
    assert.deepEqual(store.list().map((d) => [d.id, d.goneAt]), [[idFresh, undefined]], "the working row is untouched");

    // Forgotten: still dead. And after a restart of the store (a new engine reading the same folder).
    assert.equal(store.forget(idFresh), true);
    const again = new PushStore(dir);
    assert.deepEqual(again.deadIds(), [idDead]);
    refused(() => again.keep(dead, "x", { mayAdd: true, at }), "a press, after a restart, with no row left");

    // The list keeps the newest DEAD_MAX ids, in the order they went.
    for (let i = 0; i < DEAD_MAX + 5; i++) {
      const id = again.keep(fakeSubscription(`https://fcm.googleapis.com/fcm/send/made-up-churn-${i}`).sub, "x", { mayAdd: true, at }).id;
      again.markGone(id, at);
      again.forget(id);
    }
    const kept = new PushStore(dir).deadIds();
    assert.equal(kept.length, DEAD_MAX);
    assert.ok(!kept.includes(idDead), "the oldest went first");
    assert.equal(kept.at(-1), deviceId(`https://fcm.googleapis.com/fcm/send/made-up-churn-${DEAD_MAX + 4}`));
  });

  test("still here (not asked) may put a new address only in a gone row's place; a working row named by a stale tab is refused and changes nothing; a renewal may", () => {
    const store = new PushStore(join(tempDir(), "push"));
    const a = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-a").sub;
    const idA = store.keep(a, "Chrome on Windows", { mayAdd: true, at }).id;
    const before = JSON.stringify(store.list());
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-old").sub;
    assert.throws(() => store.keep(old, "Chrome on Windows", { mayAdd: false, replaces: idA, at }), (e: unknown) => e instanceof EngineError && e.code === "conflict" && !e.message.includes("made-up"));
    assert.equal(JSON.stringify(store.list()), before, "nothing changed");
    // The same row gone: still here with a new address in its place works (a browser that renewed it).
    store.markGone(idA, at);
    const idOld = store.keep(old, "Chrome on Windows", { mayAdd: false, replaces: idA, at }).id;
    assert.deepEqual(store.list().map((d) => [d.id, d.goneAt]), [[idOld, undefined]]);
    // The service worker's renewal, which names the row by its old address: a working row too.
    const renewed = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-renewed").sub;
    const idRenewed = store.keep(renewed, undefined, { mayAdd: false, renewal: true, replaces: idOld, at }).id;
    assert.deepEqual(store.list().map((d) => [d.id, d.goneAt]), [[idRenewed, undefined]]);
    // His press may name a working row (the address it held before in that window).
    const pressed = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-pressed").sub;
    const idPressed = store.keep(pressed, "Chrome on Windows", { mayAdd: true, replaces: idRenewed, at }).id;
    assert.deepEqual(store.list().map((d) => d.id), [idPressed]);
  });

  test("a device list from the trial is read as it is, its last send in the new shape, and written in the same format", () => {
    const dir = join(tempDir(), "push");
    mkdirSync(dir, { recursive: true });
    const { sub } = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-trial");
    const id = deviceId(sub.endpoint);
    const trial = { devices: [{ id, endpoint: sub.endpoint, keys: sub.keys, label: "Chrome on Mac", createdAt: at, last: { at, outcome: { kind: "sent", status: 201 } } }] };
    writeFileSync(join(dir, "subscriptions.json"), JSON.stringify(trial, null, 2), { mode: 0o600 });
    const store = new PushStore(dir);
    assert.deepEqual(store.list(), [{ id, label: "Chrome on Mac", service: "Google", addedAt: at, last: { at, kind: "test", result: "sent" } }]);
    store.record(id, { at: "2026-11-14T09:00:00.000Z", kind: "needs", result: "refused", problem: "BadJwtToken" });
    const j = JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")) as { devices: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(j.devices[0]!).sort(), ["createdAt", "endpoint", "id", "keys", "label", "last"].sort(), "the trial's fields, and no new ones until needed");
    assert.deepEqual(store.list()[0]!.last, { at: "2026-11-14T09:00:00.000Z", kind: "needs", result: "refused", problem: "BadJwtToken" });
  });

  test("the subject: config.json's wins over vapid.json's, which wins over the default", () => {
    const dir = join(tempDir(), "push");
    const first = new PushStore(dir).vapid();
    assert.equal(first.subject, DEFAULT_SUBJECT);
    const path = join(dir, "vapid.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), subject: "mailto:pobots@example.com" }), { mode: 0o600 });
    assert.equal(new PushStore(dir).vapid().subject, "mailto:pobots@example.com");
    assert.equal(new PushStore(dir, { subject: "https://mac.example.ts.net:4443/" }).vapid().subject, "https://mac.example.ts.net:4443/");
  });

  test("a label is cleaned and cut at 60 characters", () => {
    assert.equal(cleanLabel("Edge on Windows <b>"), "Edge on Windows b");
    assert.equal(cleanLabel(""), "This device");
    assert.equal(Array.from(cleanLabel("x".repeat(100))).length, 60);
  });
});

describe("the engine's server: the trial is gone, the service worker is an app file, POST /api/push/renew", () => {
  const TOKEN = "push-test-token-0123456789";
  const LOGIN = "someone@example.com";
  const ORIGIN = "https://mac.example.ts.net:4444";
  let server: EngineServer;
  let port = 0;
  let ui = "";
  let w: ReturnType<typeof setup>;

  function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  }
  const tailnet = (origin?: string) => ({
    "tailscale-user-login": LOGIN,
    "x-forwarded-for": "100.64.0.2",
    host: "mac.example.ts.net:4444",
    ...(origin ? { origin } : {}),
  });
  const json = { "content-type": "application/json" };

  before(async () => {
    const dir = tempDir();
    ui = join(dir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Pobots</title>");
    w = setup();
    server = new EngineServer(TOKEN, { uiDir: ui, allowedLogins: [LOGIN] });
    server.attach(w.engine);
    port = await server.listen(0);
  });
  after(async () => {
    await server.close();
    w.engine.shutdown();
    w.store.close();
  });

  test("/sw.js is served from the built app like any file, and is Not found while it is not built; the trial's addresses are gone", async () => {
    const missing = await call("/sw.js");
    assert.equal(missing.status, 404, "not built yet: a plain 404");
    assert.match(String(missing.headers["content-type"]), /^text\/plain/);
    writeFileSync(join(ui, "sw.js"), 'self.addEventListener("push", () => {});\n');
    const sw = await call("/sw.js");
    assert.equal(sw.status, 200);
    assert.match(String(sw.headers["content-type"]), /^text\/javascript/);
    assert.equal(sw.headers["cache-control"], "no-cache");
    assert.ok(sw.headers.etag);
    assert.equal(sw.headers["content-security-policy"], undefined, "no page policy on a script");
    assert.match(sw.body, /addEventListener\("push"/);
    for (const path of ["/push-trial", "/push-trial.js", "/push-trial.webmanifest"]) assert.equal((await call(path)).status, 404, path);
    for (const path of ["/api/push/key", "/api/push/device?id=x"]) assert.equal((await call(`${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`)).status, 404, path);
    for (const path of ["/api/push/subscribe", "/api/push/test"]) assert.equal((await call(`${path}?token=${TOKEN}`, { method: "POST", headers: json, body: "{}" })).status, 405, path);
  });

  test("renew: the socket's rule with the origin check, JSON only, small; only a device the engine knows; never an address back", async () => {
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-old");
    const { deviceId: known } = w.engine.notifySubscribe({ subscription: old.sub, label: "Chrome on Android", asked: true });
    const fresh = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-new");
    const body = JSON.stringify({ old: old.sub.endpoint, subscription: fresh.sub });
    const post = (headers: Record<string, string>, b = body, path = "/api/push/renew") => call(path, { method: "POST", headers: { ...json, ...headers }, body: b });

    assert.equal((await post({})).status, 401, "no token, no identity");
    assert.equal((await post(tailnet())).status, 401, "no origin");
    assert.equal((await post(tailnet("https://elsewhere.example.com"))).status, 401, "another origin");
    assert.equal((await post({ "tailscale-user-login": "other@example.com", host: "mac.example.ts.net:4444", origin: ORIGIN })).status, 401, "a login not on the list");
    assert.equal((await call("/api/push/renew", { method: "POST", headers: tailnet(ORIGIN), body })).status, 415, "not JSON");
    assert.equal((await call(`/api/push/renew?token=${TOKEN}`)).status, 405, "GET");
    assert.equal((await post(tailnet(ORIGIN), "x".repeat(9000))).status, 413);
    assert.equal((await post(tailnet(ORIGIN), "{nope")).status, 400);
    assert.equal((await post(tailnet(ORIGIN), JSON.stringify({ subscription: { endpoint: fresh.sub.endpoint } }))).status, 400);

    const stranger = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-stranger");
    const refused = await post(tailnet(ORIGIN), JSON.stringify({ old: "https://fcm.googleapis.com/fcm/send/made-up-nobody", subscription: stranger.sub }));
    assert.equal(refused.status, 404, "never adds a device");
    assert.equal(w.engine.snapshot().notify.devices.length, 1);

    const ok = await post(tailnet(ORIGIN));
    assert.equal(ok.status, 200);
    const answer = JSON.parse(ok.body) as { ok: boolean; deviceId: string };
    assert.deepEqual(answer, { ok: true, deviceId: deviceId(fresh.sub.endpoint) });
    const devices = w.engine.snapshot().notify.devices;
    assert.deepEqual(devices.map((d) => [d.id, d.label]), [[answer.deviceId, "Chrome on Android"]], "the known row took the new address");
    assert.notEqual(answer.deviceId, known);
    for (const text of [ok.body, refused.body, JSON.stringify(w.events)]) {
      for (const secret of [old.sub.endpoint, fresh.sub.endpoint, stranger.sub.endpoint, fresh.sub.keys.p256dh, fresh.sub.keys.auth, "made-up"]) assert.ok(!text.includes(secret), "no address or key in an answer or an event");
    }
    // With the token (the checks), and with the new address only.
    const again = fakeSubscription(fresh.sub.endpoint);
    const byToken = await post({}, JSON.stringify({ old: null, subscription: again.sub }), `/api/push/renew?token=${TOKEN}`);
    assert.equal(byToken.status, 200);
  });

  test("renew: an address the push service called gone is refused (409), also naming a working row; a fresh one takes the gone row's place", async () => {
    const post = (b: unknown) => call(`/api/push/renew?token=${TOKEN}`, { method: "POST", headers: json, body: JSON.stringify(b) });
    const dead = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-renew-dead").sub;
    const { deviceId: idDead } = w.engine.notifySubscribe({ subscription: dead, label: "Chrome on Android", asked: true });
    // The push service answered 410 for it (the engine's own store reads the same folder).
    new PushStore(join(w.dirs.dataDir, "push")).markGone(idDead, "2026-11-14T08:00:00.000Z");
    const count = () => w.engine.snapshot().notify.devices.length;
    const n = count();
    assert.equal((await post({ old: null, subscription: dead })).status, 409, "the dead address by itself");
    const fresh = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-renew-fresh").sub;
    const ok = await post({ old: dead.endpoint, subscription: fresh });
    assert.equal(ok.status, 200, "a fresh address in the gone row's place");
    const idFresh = deviceId(fresh.endpoint);
    const turned = await post({ old: fresh.endpoint, subscription: dead });
    assert.equal(turned.status, 409, "the dead address naming the working row that took its place");
    assert.ok(!turned.body.includes("made-up"), "no address in the answer");
    const row = w.engine.snapshot().notify.devices.find((d) => d.id === idFresh);
    assert.ok(row && !row.goneAt && count() === n, "the working row is untouched, nothing added");
    assert.ok(!w.engine.snapshot().notify.devices.some((d) => d.id === idDead));
  });
});

describe("the --push-relay flag", () => {
  test("only http://127.0.0.1:<port>, only with =", async () => {
    const { parseFlags } = await import("../config.js");
    assert.equal(parseFlags(["--push-relay=http://127.0.0.1:45000"]).pushRelay, "http://127.0.0.1:45000");
    for (const bad of [
      ["--push-relay=https://127.0.0.1:45000"],
      ["--push-relay=http://localhost:45000"],
      ["--push-relay=http://10.0.0.2:45000"],
      ["--push-relay=http://127.0.0.1"],
      ["--push-relay=http://127.0.0.1:0"],
      ["--push-relay=http://127.0.0.1:45000/path"],
      ["--push-relay=http://127.0.0.1:99999"],
      ["--push-relay", "http://127.0.0.1:45000"],
    ]) {
      assert.throws(() => parseFlags(bad), /push-relay/, bad.join(" "));
    }
  });

  test("an engine with the relay sends there, and logs that it does", async () => {
    const got: { address: string | undefined; length: number }[] = [];
    const relay = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        got.push({ address: req.headers["x-push-address"] as string | undefined, length: Buffer.concat(chunks).length });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayAddress = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    const original = process.stderr.write.bind(process.stderr);
    let logged = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let w: ReturnType<typeof setup>;
    try {
      w = setup(undefined, () => true, undefined, { notify: { relay: relayAddress } });
    } finally {
      process.stderr.write = original;
    }
    assert.match(logged, /Notifications go to a test relay/);
    const { sub } = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-via-relay");
    const { deviceId: id } = w.engine.notifySubscribe({ subscription: sub, label: "Chrome on Mac", asked: true });
    const { notify } = await w.engine.notifyTest(id);
    assert.equal(notify.devices[0]!.last?.result, "sent");
    assert.deepEqual(got.map((g) => g.address), [sub.endpoint]);
    assert.ok(got[0]!.length > 86);
    w.engine.shutdown();
    w.store.close();
    await new Promise<void>((r) => relay.close(() => r()));
  });
});
