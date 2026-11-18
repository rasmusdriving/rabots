// The engine's HTTP server: static files, whoami, and who may open the socket. No model.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { decideAccess, EngineServer, sameOrigin, WORDS } from "../server.js";
import { tempDir } from "./helpers.js";

const TOKEN = "test-token-0123456789";
const LOGIN = "someone@example.com";

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens a socket. Resolves "open" after a successful hello, or the HTTP status of the refusal. */
function openSocket(port: number, path: string, headers: Record<string, string> = {}, origin?: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, origin });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("error", () => resolve(-1));
    ws.on("open", () => ws.send(JSON.stringify({ t: "req", id: "1", method: "hello", params: { protocol: PROTOCOL_VERSION, client: "test" } })));
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as { ok?: boolean };
      resolve(f.ok ? "open" : -2);
      ws.close();
    });
  });
}

/** Collects what the engine writes to stderr while `fn` runs. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

async function startServer(opts: { uiDir?: string; allowedLogins?: string[] }): Promise<{ server: EngineServer; port: number }> {
  const server = new EngineServer(TOKEN, opts);
  server.attach({} as Engine);
  const port = await server.listen(0);
  return { server, port };
}

describe("server: decideAccess", () => {
  const opts = { token: TOKEN, allowedLogins: [LOGIN] };
  const base = { url: "/ws", remoteAddress: "127.0.0.1" };
  const same = { host: "mac.example.ts.net", origin: "https://mac.example.ts.net" };

  test("the local token lets in, from loopback only", () => {
    assert.deepEqual(decideAccess({ ...base, url: `/ws?token=${TOKEN}`, headers: {} }, opts, true), { allowed: true, via: "local" });
    assert.deepEqual(decideAccess({ ...base, url: `/ws?token=${TOKEN}`, headers: {}, remoteAddress: "::1" }, opts, true).allowed, true);
    assert.equal(decideAccess({ ...base, url: `/ws?token=${TOKEN}`, headers: {}, remoteAddress: "100.64.0.2" }, opts, true).allowed, false);
    assert.equal(decideAccess({ ...base, url: "/ws?token=wrong", headers: {} }, opts, true).allowed, false);
  });

  test("a Tailscale identity in the list, from the same origin, lets in", () => {
    assert.deepEqual(decideAccess({ ...base, headers: { "tailscale-user-login": LOGIN, ...same } }, opts, true), { allowed: true, via: "tailscale" });
    // Compared without regard to case.
    assert.equal(decideAccess({ ...base, headers: { "tailscale-user-login": LOGIN.toUpperCase(), ...same } }, opts, true).allowed, true);
  });

  test("each refusal, and the login never in the reason", () => {
    const cases = [
      { headers: {}, message: WORDS.notAllowed },
      { headers: { "tailscale-user-login": "other@example.com", ...same }, message: WORDS.notOnList },
      { headers: { "tailscale-user-login": LOGIN, host: same.host }, message: WORDS.notAllowed },
      { headers: { "tailscale-user-login": LOGIN, host: same.host, origin: "https://evil.example" }, message: WORDS.notAllowed },
      { headers: { "tailscale-user-login": LOGIN, host: same.host, origin: "null" }, message: WORDS.notAllowed },
    ];
    for (const c of cases) {
      const a = decideAccess({ ...base, headers: c.headers }, opts, true);
      assert.equal(a.allowed, false);
      if (!a.allowed) {
        assert.equal(a.message, c.message);
        assert.ok(!a.reason.includes("example.com"));
      }
    }
    const off = decideAccess({ ...base, headers: { "tailscale-user-login": LOGIN, ...same } }, { token: TOKEN, allowedLogins: [] }, true);
    assert.equal(off.allowed, false);
    if (!off.allowed) assert.equal(off.message, WORDS.remoteOff);
  });

  test("without the origin rule (whoami) the origin is not needed", () => {
    assert.equal(decideAccess({ ...base, headers: { "tailscale-user-login": LOGIN } }, opts, false).allowed, true);
  });

  test("sameOrigin compares host and port", () => {
    assert.equal(sameOrigin({ host: "a.ts.net", origin: "https://a.ts.net" }), true);
    assert.equal(sameOrigin({ host: "A.ts.net", origin: "https://a.TS.net" }), true);
    assert.equal(sameOrigin({ host: "a.ts.net:8443", origin: "https://a.ts.net" }), false);
    assert.equal(sameOrigin({ host: "a.ts.net", origin: "https://a.ts.net.evil.example" }), false);
    assert.equal(sameOrigin({ host: "a.ts.net", origin: "file://" }), false);
    assert.equal(sameOrigin({ host: "a.ts.net" }), false);
  });
});

describe("server: serve mode", () => {
  let server: EngineServer;
  let port: number;
  let root: string;

  before(async () => {
    root = tempDir();
    const ui = join(root, "ui");
    mkdirSync(join(ui, "fonts"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Pobots</title>");
    writeFileSync(join(ui, "app.js"), "console.log(1)");
    writeFileSync(join(ui, "app.css"), "body{}");
    writeFileSync(join(ui, "manifest.webmanifest"), "{}");
    writeFileSync(join(ui, "fonts", "a.woff2"), "x");
    writeFileSync(join(root, "secret.txt"), "not for the page");
    symlinkSync(join(root, "secret.txt"), join(ui, "link.txt"));
    ({ server, port } = await startServer({ uiDir: ui, allowedLogins: [LOGIN] }));
  });
  after(() => server.close());

  test("serves the page and the files next to it, with the right types", async () => {
    const index = await get(port, "/");
    assert.equal(index.status, 200);
    assert.match(String(index.headers["content-type"]), /^text\/html/);
    assert.equal(index.headers["cache-control"], "no-cache");
    assert.ok(index.headers["x-pobots-engine"]);
    // The served page may load pictures and connect only on its own origin (the desktop window's
    // 127.0.0.1 entries in the file's own policy do not count here).
    assert.equal(index.headers["content-security-policy"], "img-src 'self' data: blob:; connect-src 'self'");
    assert.match((await get(port, "/index.html")).body, /Pobots/);
    const js = await get(port, "/app.js");
    assert.match(String(js.headers["content-type"]), /^text\/javascript/);
    assert.equal(js.headers["cache-control"], "no-cache");
    assert.equal(js.headers["content-security-policy"], undefined);
    assert.match(String((await get(port, "/app.css")).headers["content-type"]), /^text\/css/);
    assert.match(String((await get(port, "/manifest.webmanifest")).headers["content-type"]), /^application\/manifest\+json/);
    assert.equal((await get(port, "/fonts/a.woff2")).headers["content-type"], "font/woff2");
  });

  test("a file that has not changed answers 304", async () => {
    const first = await get(port, "/app.js");
    const again = await get(port, "/app.js", { headers: { "If-None-Match": String(first.headers.etag) } });
    assert.equal(again.status, 304);
  });

  test("refuses paths outside the folder, links out of it, folders and missing files", async () => {
    for (const path of ["/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/../secret.txt", "/fonts/..%2f..%2fsecret.txt", "/link.txt", "/fonts", "/fonts/", "/nope.js", "/%00", "/..%5csecret.txt"]) {
      const res = await get(port, path);
      assert.ok(res.status === 404 || res.status === 400, `${path} gave ${res.status}`);
      assert.ok(!res.body.includes("not for the page"), path);
    }
  });

  test("only GET and HEAD", async () => {
    assert.equal((await get(port, "/", { method: "POST" })).status, 405);
    assert.equal((await get(port, "/api/whoami", { method: "PUT" })).status, 405);
    const head = await get(port, "/app.js", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
  });

  test("whoami says who is let in, and never echoes the login", async () => {
    const none = await get(port, "/api/whoami");
    assert.equal(none.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(none.body), { allowed: false, via: "none", message: WORDS.notAllowed });
    assert.deepEqual(JSON.parse((await get(port, `/api/whoami?token=${TOKEN}`)).body), { allowed: true, via: "local" });
    const ts = await get(port, "/api/whoami", { headers: { "Tailscale-User-Login": LOGIN } });
    assert.deepEqual(JSON.parse(ts.body), { allowed: true, via: "tailscale" });
    assert.ok(!ts.body.includes("example.com"));
    const other = await get(port, "/api/whoami", { headers: { "Tailscale-User-Login": "stranger@example.org" } });
    assert.deepEqual(JSON.parse(other.body), { allowed: false, via: "none", message: WORDS.notOnList });
    assert.ok(!other.body.includes("stranger"));
    assert.equal((await get(port, "/api/other")).status, 404);
  });

  test("the socket: each way in and each refusal", async () => {
    const host = `127.0.0.1:${port}`;
    const self = `http://${host}`;
    const log = await captureLog(async () => {
      assert.equal(await openSocket(port, "/ws"), 401, "no token and no header");
      assert.equal(await openSocket(port, "/ws?token=wrong"), 401, "wrong token");
      assert.equal(await openSocket(port, `/ws?token=${TOKEN}`), "open", "token on /ws");
      assert.equal(await openSocket(port, `/?token=${TOKEN}`), "open", "token on /");
      assert.equal(await openSocket(port, `/other?token=${TOKEN}`), 404, "another path");
      assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": "stranger@example.org" }, self), 401, "wrong login");
      assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": LOGIN }), 401, "no Origin");
      assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": LOGIN }, "https://evil.example"), 401, "foreign Origin");
      assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": LOGIN }, self), "open", "right login, same origin");
      assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": LOGIN.toUpperCase() }, self), "open", "login in other case");
    });
    assert.match(log, /Refused a connection/);
    assert.ok(!log.includes("someone@") && !log.includes("stranger@") && !log.includes(TOKEN), "the log holds no login and no token");
  });
});

describe("server: remote access off, and without serve mode", () => {
  test("an empty allowed list refuses every Tailscale identity", async () => {
    const { server, port } = await startServer({ uiDir: tempDir(), allowedLogins: [] });
    try {
      const self = `http://127.0.0.1:${port}`;
      await captureLog(async () => {
        assert.equal(await openSocket(port, "/ws", { "Tailscale-User-Login": LOGIN }, self), 401);
      });
      const who = JSON.parse((await get(port, "/api/whoami", { headers: { "Tailscale-User-Login": LOGIN } })).body);
      assert.deepEqual(who, { allowed: false, via: "none", message: WORDS.remoteOff });
      assert.equal(await openSocket(port, `/ws?token=${TOKEN}`), "open");
    } finally {
      await server.close();
    }
  });

  test("without serve mode there is no page, but the socket and whoami work", async () => {
    const { server, port } = await startServer({});
    try {
      assert.equal((await get(port, "/")).status, 426);
      assert.equal((await get(port, "/index.html")).status, 426);
      assert.equal(JSON.parse((await get(port, "/api/whoami")).body).allowed, false);
      assert.equal(await openSocket(port, `/?token=${TOKEN}`), "open");
    } finally {
      await server.close();
    }
  });
});
