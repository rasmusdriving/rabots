// The engine's one HTTP server, on 127.0.0.1 only.
//
//   WebSocket on /ws (and /, as before): the protocol. Every connection must be let in (see
//     `decideAccess`) and start with `hello`. Events go to every connection that has said hello.
//   GET /api/whoami: may this caller open the socket, and if not, why, in plain words.
//   Serve mode only: GET / and the files next to it, the built app window.
//   POST /hook/<id>/<secret>: a webhook call or a message on a channel (see `hook`). Built to be
//     safe on the public internet: no token or Tailscale identity is asked for or trusted there, the
//     secret in the path is the only key, the path is never logged, and wrong addresses are limited.
//   POST /api/attachments?bot=<id>&name=<name>: an upload of a picture or a file (see `upload`).
//     Passes the socket's own rule, with the origin check. GET /api/attachments/<id>/preview|full
//     gives it back (see `attachment`); only checked pictures are ever shown inline.
//   GET /page/<key>/<path>: the files of one artifact, sealed (see `page` and engine/artifacts.ts).
//     The key is the only thing that lets a caller in; it is never logged. Served in serve mode and
//     without it (the desktop window frames it from its file page).
//   POST /api/push/renew: the service worker's new push subscription, for a device the engine
//     already knows (see `renew`). Passes the socket's own rule, with the origin check. Everything
//     else about notifications goes over the socket; the service worker (/sw.js) is a file of the
//     built app, served like any other.
//
// Two ways in, nothing else:
//   1. the local token, `?token=`, for the desktop shell and the checks;
//   2. a Tailscale identity: `tailscale serve` adds `Tailscale-User-Login` to tailnet traffic and
//      strips it from what the caller sent. The login must be in `remote.allowedLogins`, and the
//      socket's Origin must be the page's own host, so another web page in the same browser cannot
//      open the socket with the person's identity.
// The login value is never logged or echoed back.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { asDownload, fileDisposition, folderDownload } from "./downloads.js";
import { listFiles as listBotFiles } from "./files.js";
import { createReadStream, createWriteStream, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ATTACHMENT_MAX_BYTES, PROTOCOL_VERSION, type EventName, type Events, type MethodName, type Methods, type ServerFrame, type WhoAmI } from "../shared/protocol.js";
import { sealHeaders, ownSources } from "./artifacts.js";
import { ATTACH_WORDS, cleanName, UPLOADS_TOTAL_MAX, type ServedFile } from "./attachments.js";
import type { BrowserConn } from "./browser.js";
import { ENGINE_VERSION, type Engine } from "./engine.js";
import { EngineError, toErrorBody } from "./errors.js";
import { linkHook } from "./core/link-hook.js";
import { ENGINE_HEADER } from "./lock.js";
import { log } from "./log.js";
import { personActionAfter, personActionBefore, whereFrom } from "./core/person-actions.js";
import { readUsageOverview } from "./core/usage-history/service.js";
import type { PersonVia } from "./activity-store.js";
import { isMethod, parseParams } from "./schemas.js";
import { HOOK_DEDUPE_MAX, HOOK_MAX_BYTES, HOOK_READ_MS } from "./triggers.js";
import { calendarState, checkConnection, setCalendar } from "./core/calendar-settings.js";
import { askOnCard, askOnTodo } from "./core/card-questions.js";
import { endTaskManagerFrom, sendToTaskManager, stopTaskManagerFrom } from "./core/task-managers.js";

export interface ServerOptions {
  /** Serve mode: the folder with the built app window. Without it there is no web page. */
  uiDir?: string;
  /** Tailscale logins allowed in. Empty or missing: remote access is off. */
  allowedLogins?: string[];
}

/** The largest body POST /api/push/renew takes. */
export const RENEW_MAX_BYTES = 8 * 1024;

export const LOGIN_HEADER = "tailscale-user-login";

export const WORDS = {
  notAllowed: "This device is not allowed to open Pobots. Open it from a device on your Tailscale network.",
  remoteOff: "Opening Pobots from other devices is switched off on this computer.",
  notOnList: "Your Tailscale account is not allowed to open Pobots on this computer.",
} as const;

export type Access =
  | { allowed: true; via: "local" | "tailscale" }
  | { allowed: false; via: "none"; /** For the log. Never holds the login. */ reason: string; message: string };

export interface AccessInput {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  remoteAddress: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** An upload that sends nothing for this long is given up. */
export const UPLOAD_IDLE_MS = 60 * 1000;
/**
 * And one that takes longer than this in all. Step 7c: 15 minutes (was 5), for files of up to 100 MB
 * over a slow connection. Node's own limit for a whole request (requestTimeout) is set a little above.
 */
export const UPLOAD_TOTAL_MS = 15 * 60 * 1000;
/**
 * Uploads taken in at the same time, over all pages and bots. The app sends up to 10 at once for one
 * message (ATTACHMENTS_PER_MESSAGE); one more is refused with 429 until one of them is done.
 */
export const UPLOADS_AT_ONCE = 10;
/** How a refusal of an upload maps to an HTTP status. */
const UPLOAD_STATUS: Record<string, number> = { too_large: 413, unsupported: 415, bad_request: 400, not_found: 404, too_many: 400 };
/** The desktop window is a file page: its requests come with Origin "null" (or "file://") and the token. */
const FILE_ORIGINS = new Set(["null", "file://"]);
/** Sealing for everything served back from an attachment: nothing in it may run on Pobots' address. */
const ATTACHMENT_CSP_DOWNLOAD = "sandbox; default-src 'none'";
const ATTACHMENT_CSP_PICTURE = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
/** Added to the page served in serve mode, on top of the policy in its own file (see `serveFile`). */
export const PAGE_CSP_NARROWER = "img-src 'self' data: blob:; connect-src 'self'";

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const v = headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
};

function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the Origin header names the same host (and port) as the Host header. */
export function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = header(headers, "origin");
  const host = header(headers, "host");
  if (!origin || !host || origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Who is this caller? `needOrigin` is true for the socket and for anything that changes
 * something; then a Tailscale caller must also come from the page's own origin.
 */
export function decideAccess(input: AccessInput, opts: { token: string; allowedLogins: string[] }, needOrigin: boolean): Access {
  const refuse = (reason: string, message: string = WORDS.notAllowed): Access => ({ allowed: false, via: "none", reason, message });

  // We only listen on 127.0.0.1, so this always holds. Checked anyway.
  if (!input.remoteAddress || !LOOPBACK.has(input.remoteAddress)) return refuse("the caller is not on this machine");

  let token: string | null = null;
  try {
    token = new URL(input.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  } catch {
    return refuse("the address could not be read");
  }
  if (token && sameText(token, opts.token)) return { allowed: true, via: "local" };

  const login = header(input.headers, LOGIN_HEADER);
  if (!login) return refuse(token ? "wrong token, no Tailscale identity" : "no token and no Tailscale identity");
  if (opts.allowedLogins.length === 0) return refuse("a Tailscale identity came, but remote access is off", WORDS.remoteOff);
  const wanted = login.toLowerCase();
  if (!opts.allowedLogins.some((l) => l.trim().toLowerCase() === wanted)) {
    return refuse("a Tailscale identity came that is not in the allowed list", WORDS.notOnList);
  }
  if (needOrigin && !sameOrigin(input.headers)) return refuse("a Tailscale identity came from another origin, or without one");
  return { allowed: true, via: "tailscale" };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Pictures of the browser for one connection. At most one waits: while the last one is still being
 * written to the connection, a newer one replaces the one waiting, so a slow receiver never makes
 * the engine hold a backlog.
 */
export class FrameSlot {
  private inFlight = false;
  private pending?: string;
  /** Pictures dropped because a newer one came first. */
  dropped = 0;
  private readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  push(text: string): void {
    if (this.inFlight) {
      if (this.pending) this.dropped++;
      this.pending = text;
      return;
    }
    this.write(text);
  }
  private write(text: string): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.inFlight = true;
    this.ws.send(text, () => {
      this.inFlight = false;
      const next = this.pending;
      this.pending = undefined;
      if (next) this.write(next);
    });
  }
  /** Bytes waiting in this process for the connection: never more than one picture. */
  get waiting(): number {
    return (this.pending?.length ?? 0) + this.ws.bufferedAmount;
  }
}

export class EngineServer {
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private greeted = new Set<WebSocket>();
  /** How each connection came in: the desktop window and local programs with the token, a browser page over Tailscale. */
  private via = new WeakMap<WebSocket, string>();
  /** Each connection's own id, for what its window says about who is looking (notify.presence). */
  private connIds = new WeakMap<WebSocket, string>();
  /** Engine 0.28.0: where each window is, for the activity log: the Mac, a computer or a phone. */
  private where = new WeakMap<WebSocket, PersonVia>();
  /** Each connection as the browser hub sees it: pictures and the end of a watch go to it alone. */
  private browserConns = new WeakMap<WebSocket, BrowserConn & { slot: FrameSlot }>();
  private slots = new Set<FrameSlot>();
  private port = 0;
  /** Uploads being taken in now (see UPLOADS_AT_ONCE). */
  private uploadsRunning = 0;
  private engine: Engine | undefined;
  private readonly token: string;
  private readonly uiDir: string | undefined;
  private readonly allowedLogins: string[];

  constructor(token: string, options: ServerOptions = {}) {
    this.token = token;
    this.uiDir = options.uiDir ? resolve(options.uiDir) : undefined;
    this.allowedLogins = (options.allowedLogins ?? []).map((l) => l.trim()).filter(Boolean);
  }

  attach(engine: Engine): void {
    this.engine = engine;
  }

  listen(port: number): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      wss.on("connection", (ws, req: IncomingMessage & { pobotsVia?: string }) => {
        this.where.set(ws, whereFrom(req.pobotsVia ?? "local", header(req.headers, "user-agent")));
        this.onConnection(ws, req.pobotsVia ?? "local");
      });
      const http = createServer({ requestTimeout: UPLOAD_TOTAL_MS + 30_000 }, (req, res) => this.onRequest(req, res));
      http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as Socket, head));
      http.once("error", reject);
      http.listen({ host: "127.0.0.1", port }, () => {
        http.off("error", reject);
        http.on("error", (err) => log.warn("Server error", err.message));
        this.http = http;
        this.wss = wss;
        this.port = (http.address() as AddressInfo).port;
        resolvePort(this.port);
      });
    });
  }

  private access(req: IncomingMessage, needOrigin: boolean): Access {
    return decideAccess(
      { url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress },
      { token: this.token, allowedLogins: this.allowedLogins },
      needOrigin,
    );
  }

  // ------------------------------------------------------------ socket

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      return reject("400 Bad Request");
    }
    if (path !== "/ws" && path !== "/") return reject("404 Not Found");
    const access = this.access(req, true);
    if (!access.allowed) {
      const present = header(req.headers, LOGIN_HEADER) ? "present" : "absent";
      log.warn(`Refused a connection: ${access.reason} (identity header ${present})`);
      return reject("401 Unauthorized");
    }
    const wss = this.wss;
    if (!wss) return reject("503 Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => {
      (req as IncomingMessage & { pobotsVia?: string }).pobotsVia = access.via;
      wss.emit("connection", ws, req);
    });
  }

  private onConnection(ws: WebSocket, via: string): void {
    log.info(`An app connected (${via === "tailscale" ? "over Tailscale" : "with the local token"})`);
    this.via.set(ws, via);
    const conn = randomUUID();
    this.connIds.set(ws, conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.onFrame(ws, String(data));
    });
    ws.on("close", () => {
      this.greeted.delete(ws);
      // A closed window says nothing more about who is looking.
      this.engine?.notifyConnectionClosed?.(conn);
      const bconn = this.browserConns.get(ws);
      if (bconn) {
        this.slots.delete(bconn.slot);
        this.engine?.browser?.dropConn(bconn);
      }
      log.info("An app disconnected");
    });
    ws.on("error", (err) => log.warn("Connection error", err.message));
  }

  // ------------------------------------------------------------ HTTP

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader(ENGINE_HEADER, ENGINE_VERSION);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    // Webhooks first: they have their own rules and never reach the checks below.
    const raw = (req.url ?? "/").split("?")[0]!;
    if (raw === "/hook" || raw.startsWith("/hook/")) return this.hook(req, res, raw);
    // Artifacts next: sealed on every answer, also the refusals.
    if (raw === "/page" || raw.startsWith("/page/")) return this.page(req, res, raw);
    // Attachments: an upload changes something and passes the socket's rule with the origin check.
    if (raw === "/api/attachments" || raw.startsWith("/api/attachments/")) return this.attachments(req, res, raw);
    // Notifications: the service worker's renewal passes the socket's rule with the origin check.
    if (raw === "/api/push/renew") return this.renew(req, res);
    // Step 7c: a file of a to-do's modal, from its bot's folder. Read only, the attachments' rule.
    if (raw.startsWith("/api/todos/")) return this.todoFile(req, res, raw);
    if (raw.startsWith("/api/bots/")) return this.botDownload(req, res, raw);

    // Nothing else over plain HTTP changes anything. The uploads and the renewal above pass
    // `this.access(req, true)` first, which holds the same origin rule as the socket; anything new
    // that changes something must too.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return this.plain(res, 405, "Method not allowed");
    }

    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      return this.plain(res, 400, "Bad request");
    }

    if (path === "/api/whoami") return this.whoami(req, res);
    if (path.startsWith("/api/")) return this.plain(res, 404, "Not found");
    if (!this.uiDir) {
      // Not in serve mode: only the socket lives here, as before.
      return this.plain(res, 426, "Upgrade required");
    }
    return this.serveFile(req, res, path);
  }

  /**
   * A webhook call or a message on a channel. Every way of getting the address wrong (unknown id,
   * wrong secret, a webhook or channel that is off, a method other than POST) gets the same plain
   * 404, and after 60 wrong calls in a minute a 429 for the rest of that minute. After that: too many
   * calls 429, not JSON 415, too large 413, too slow 408, not valid JSON (or for a channel, a body
   * without what is needed) or a too long dedupe key 400. Never logs the path or the secret, and
   * never waits for the bot.
   */
  private hook(req: IncomingMessage, res: ServerResponse, rawPath: string): void {
    res.setHeader("Cache-Control", "no-store");
    const refuse = (status: number, text: string) => {
      res.setHeader("Connection", "close");
      this.plain(res, status, text);
      req.resume();
    };
    const engine = this.engine;
    const parts = rawPath.split("/");
    const wrong = () => {
      const wait = engine ? engine.wrongHookCall() : 0;
      if (wait > 0) {
        res.setHeader("Retry-After", String(wait));
        log.debug("Refused a hook call (too many wrong addresses)");
        return refuse(429, "Too many requests");
      }
      log.debug("Refused a hook call (not found)");
      return refuse(404, "Not found");
    };
    if (req.method !== "POST" || !engine || parts.length !== 4 || !parts[2] || !parts[3]) return wrong();
    if (parts[2] === "link") return linkHook(engine.links, req, res, parts[3], wrong);
    const id = parts[2];
    const kind = engine.hookTarget(id, parts[3]);
    if (!kind) return wrong();
    const what = kind === "channel" ? `Channel ${id}` : `Webhook ${id}`;
    if (!engine.hookWithinLimits(id, kind)) {
      res.setHeader("Retry-After", "60");
      log.warn(`${what}: too many calls, refused one`);
      return refuse(429, "Too many requests");
    }
    const type = (header(req.headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return refuse(415, "Unsupported media type");
    const length = Number(header(req.headers, "content-length") ?? "0");
    if (Number.isFinite(length) && length > HOOK_MAX_BYTES) return refuse(413, "Payload too large");
    const dedupe = header(req.headers, "x-pobots-dedupe");
    if (dedupe !== undefined && dedupe.length > HOOK_DEDUPE_MAX) return refuse(400, "Bad request");

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (status: number, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      refuse(status, text);
      req.destroy();
    };
    const timer = setTimeout(() => finish(408, "Request timeout"), HOOK_READ_MS);
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > HOOK_MAX_BYTES) return finish(413, "Payload too large");
      chunks.push(chunk);
    });
    req.on("error", () => {
      done = true;
      clearTimeout(timer);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (kind === "channel") return this.channelEnd(res, refuse, engine, id, text);
      let data: { has: boolean; value?: unknown } = { has: false };
      if (text.trim()) {
        try {
          data = { has: true, value: JSON.parse(text) };
        } catch {
          return refuse(400, "Bad request");
        }
      }
      let outcome;
      try {
        outcome = engine.hookCall(id, data, dedupe);
      } catch (err) {
        log.error(`Webhook ${id}: the call could not be handled`, err);
        return refuse(500, "Internal server error");
      }
      if (outcome.status === 404) return refuse(404, "Not found");
      if (outcome.status === 503) return refuse(503, "Service unavailable");
      const body = outcome.status === 202 ? { ok: true, runId: outcome.runId } : { ok: true, duplicate: true };
      log.info(`Webhook ${id}: ${outcome.status === 202 ? "called, the bot was woken" : "a duplicate call, nothing done"}`);
      res.writeHead(outcome.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    });
  }

  /** The rest of a channel call, once its body is in. */
  private channelEnd(res: ServerResponse, refuse: (status: number, text: string) => void, engine: Engine, id: string, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refuse(400, "Bad request");
    }
    let outcome;
    try {
      outcome = engine.channelCall(id, value);
    } catch (err) {
      log.error(`Channel ${id}: the message could not be handled`, err);
      return refuse(500, "Internal server error");
    }
    if (outcome.status === 404) return refuse(404, "Not found");
    if (outcome.status === 400) return refuse(400, "Bad request");
    if (outcome.status === 503) return refuse(503, "Service unavailable");
    const body = outcome.status === 202 ? { ok: true, messageId: outcome.messageId } : outcome.body;
    res.writeHead(outcome.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  /**
   * The files of one artifact (docs/build/step-2f.md, A3). Only GET and HEAD. The key in the path is
   * the only key; what follows it names a file in the artifact's folder (see pageFile). Every answer
   * carries the seal. A request that came through a proxy (tailscale serve adds X-Forwarded-For, a
   * Funnel request is marked) must also carry an allowed Tailscale identity, so that nothing under
   * /page/ answers a caller from outside the tailnet even if a public path ever reached it. A
   * request straight to 127.0.0.1 (the desktop window) needs only the key.
   */
  private page(req: IncomingMessage, res: ServerResponse, rawPath: string): void {
    const m = /^\/page\/([A-Za-z0-9_-]{16,128})\/(.*)$/.exec(rawPath);
    const key = m?.[1];
    const refuse = (status: number, text: string) => {
      res.writeHead(status, { ...sealHeaders("error"), "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      req.resume();
      return refuse(405, "Method not allowed");
    }
    const engine = this.engine;
    if (!m || !key || !engine) return refuse(404, "Not found");
    const proxied = header(req.headers, "x-forwarded-for") !== undefined || header(req.headers, "tailscale-funnel-request") !== undefined;
    if (proxied && !this.access(req, false).allowed) {
      log.debug("Refused an artifact request that came through a proxy without an allowed identity");
      return refuse(404, "Not found");
    }
    let found;
    try {
      const forced = new URLSearchParams((req.url ?? "").split("?")[1]).has("download");
      const mode = forced ? "download" : header(req.headers, "sec-fetch-mode") === "navigate" ? "navigate" : "resource";
      found = engine.pageRequest(key, m[2] ?? "", mode);
    } catch (err) {
      log.error("An artifact file could not be looked up", err);
      return refuse(500, "Internal server error");
    }
    if (!found.ok) return refuse(404, "Not found");
    const own = ownSources(header(req.headers, "host"), key);
    if (found.download) {
      for (const [name, value] of Object.entries(sealHeaders("file", own))) res.setHeader(name, value);
      return this.sendServed(req, res, "page", asDownload(found, found.name), "no-store");
    }
    res.writeHead(200, { ...sealHeaders(found.isPage ? "page" : "file", own), "Content-Type": found.type, "Content-Length": found.size });
    if (req.method === "HEAD") return void res.end();
    const stream = createReadStream(found.full);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  // ------------------------------------------------------------ attachments (docs/build/step-files.md)

  /** The desktop window's file page may read the answer when it came with the token: CORS for it alone. */
  private fileOrigin(req: IncomingMessage, res: ServerResponse, access: Access): void {
    const origin = header(req.headers, "origin");
    if (access.allowed && access.via === "local" && origin && FILE_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }

  private attachments(req: IncomingMessage, res: ServerResponse, raw: string): void {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      // The desktop window's preflight. Only with the token in the address and from a file page.
      const access = this.access(req, true);
      const origin = header(req.headers, "origin");
      req.resume();
      if (!access.allowed || access.via !== "local" || !origin || !FILE_ORIGINS.has(origin)) return this.plain(res, 403, "Forbidden");
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, HEAD",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return void res.end();
    }
    if (raw === "/api/attachments") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        req.resume();
        return this.plain(res, 405, "Method not allowed");
      }
      return this.upload(req, res);
    }
    const m = /^\/api\/attachments\/([a-z0-9_]{1,64})\/(preview|full)$/.exec(raw);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      req.resume();
      return this.plain(res, 405, "Method not allowed");
    }
    if (!m) return this.plain(res, 404, "Not found");
    return this.attachment(req, res, m[1]!, m[2] as "preview" | "full");
  }

  /**
   * The answer to an upload that is refused. What is still coming is read into nothing (up to a
   * limit, see `drain`), so the page gets this answer instead of a broken connection.
   */
  private uploadRefusal(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  /** Reads the rest of a refused upload into nothing, and gives up the connection past twice the limit or after a while. */
  private drain(req: IncomingMessage): void {
    let left = ATTACHMENT_MAX_BYTES * 2;
    const timer = setTimeout(() => req.destroy(), UPLOAD_IDLE_MS);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      left -= chunk.length;
      if (left < 0) req.destroy();
    });
    req.on("end", () => clearTimeout(timer));
    req.on("close", () => clearTimeout(timer));
    req.resume();
  }

  /**
   * POST /api/attachments?bot=<id>&name=<name>, the body the file's bytes. Streams to disk, counts
   * the bytes and stops at the limit with 413, gives up an upload that stalls, then lets the engine
   * check what arrived. Answers AttachmentUploadResult or { error: ErrorBody }.
   */
  private upload(req: IncomingMessage, res: ServerResponse): void {
    const access = this.access(req, true);
    this.fileOrigin(req, res, access);
    if (!access.allowed) {
      const present = header(req.headers, LOGIN_HEADER) ? "present" : "absent";
      log.warn(`Refused an upload: ${access.reason} (identity header ${present})`);
      this.drain(req);
      return this.uploadRefusal(res, 401, "bad_request", access.message);
    }
    const engine = this.engine;
    let botId = "";
    let rawName = "";
    try {
      const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      botId = q.get("bot") ?? "";
      rawName = q.get("name") ?? "";
    } catch {
      // refused below
    }
    if (!engine || !botId) {
      this.drain(req);
      return this.uploadRefusal(res, 400, "bad_request", "The upload did not say which bot it is for.");
    }
    const name = cleanName(rawName);
    const length = Number(header(req.headers, "content-length") ?? "NaN");
    if (Number.isFinite(length) && length > ATTACHMENT_MAX_BYTES) {
      this.drain(req);
      return this.uploadRefusal(res, 413, "too_large", ATTACH_WORDS.tooBig(name));
    }
    if (this.uploadsRunning >= UPLOADS_AT_ONCE) {
      log.warn(`Refused an upload: ${this.uploadsRunning} are already being taken in`);
      this.drain(req);
      return this.uploadRefusal(res, 429, "bad_request", ATTACH_WORDS.busy);
    }
    // All unsent uploads together stay under 2 GB. Counted with care: what is on disk (uploads still
    // arriving included), the most each other running upload may still add, and this one.
    let held = 0;
    try {
      held = engine.uploadsSize();
    } catch {
      // counted as nothing
    }
    const coming = (Number.isFinite(length) && length >= 0 ? length : ATTACHMENT_MAX_BYTES) + this.uploadsRunning * ATTACHMENT_MAX_BYTES;
    if (held + coming > UPLOADS_TOTAL_MAX) {
      log.warn(`Refused an upload: the unsent uploads hold ${held} bytes`);
      this.drain(req);
      return this.uploadRefusal(res, 413, "too_large", ATTACH_WORDS.uploadsFull);
    }
    let started: { id: string; part: string };
    try {
      started = engine.beginUpload(botId);
    } catch (err) {
      this.drain(req);
      const body = toErrorBody(err);
      return this.uploadRefusal(res, UPLOAD_STATUS[body.code] ?? 500, body.code, body.message);
    }
    const { id, part } = started;
    // Counted as running until its answer is sent or its connection is gone.
    // An upload whose page went away still counts while the engine works on what arrived (sips, the readers).
    this.uploadsRunning++;
    let counted = true;
    let working = false;
    let prepared = false;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.uploadsRunning--;
    };
    res.on("close", () => {
      if (!working) release();
      // The page went away before it got the answer: nobody knows this upload's id, so it goes.
      if (!res.writableFinished && prepared) engine.abortUpload(id);
    });
    const out = createWriteStream(part, { flags: "wx", mode: 0o600 });
    let size = 0;
    let done = false;
    let idle: NodeJS.Timeout;
    const fail = (status: number, code: string, message: string) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(total);
      // Stop writing, and read what is still coming into nothing, so the page gets the answer.
      req.unpipe(out);
      out.destroy();
      engine.abortUpload(id);
      this.uploadRefusal(res, status, code, message);
      if (status === 408) req.destroy();
      else this.drain(req);
    };
    const again = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        log.warn(`Gave up an upload that stalled (${size} bytes in)`);
        fail(408, "bad_request", `${name} didn't upload. Try again.`);
      }, UPLOAD_IDLE_MS);
    };
    const total = setTimeout(() => fail(408, "bad_request", `${name} didn't upload. Try again.`), UPLOAD_TOTAL_MS);
    again();
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      again();
      if (size > ATTACHMENT_MAX_BYTES) return fail(413, "too_large", ATTACH_WORDS.tooBig(name));
    });
    req.on("aborted", () => fail(400, "bad_request", `${name} didn't upload. Try again.`));
    req.on("error", () => fail(400, "bad_request", `${name} didn't upload. Try again.`));
    out.on("error", (err) => {
      if (done) return;
      log.warn("An upload could not be written", err.message);
      fail(500, "internal", `${name} didn't upload. Try again.`);
    });
    out.on("finish", () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(total);
      working = true;
      engine.finishUpload(id, botId, rawName).then(
        (attachment) => {
          release();
          prepared = true;
          if (res.destroyed || res.writableEnded || req.socket.destroyed) {
            log.info("Removed an upload whose page went away before the answer");
            engine.abortUpload(id);
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ attachment }));
        },
        (err) => {
          release();
          const body = toErrorBody(err);
          this.uploadRefusal(res, UPLOAD_STATUS[body.code] ?? 500, body.code, body.message);
        },
      );
    });
    req.pipe(out);
  }

  /**
   * GET /api/attachments/<id>/preview|full. Passes the same rule as /api/whoami (an <img> sends no
   * Origin). A checked picture and its preview are shown inline; everything else is a download that
   * cannot run here. An id never changes what it names, so the answer may be kept.
   */
  private attachment(req: IncomingMessage, res: ServerResponse, id: string, which: "preview" | "full"): void {
    const access = this.access(req, false);
    this.fileOrigin(req, res, access);
    if (!access.allowed) {
      log.debug(`Refused an attachment request: ${access.reason}`);
      return this.plain(res, 401, access.message);
    }
    const download = new URLSearchParams((req.url ?? "").split("?")[1]).has("download");
    let found;
    try {
      found = this.engine?.attachmentFile(id, which);
    } catch (err) {
      log.error("An attachment could not be looked up", err);
      return this.plain(res, 500, "Internal server error");
    }
    if (!found) return this.plain(res, 404, "Not found");
    this.sendServed(req, res, access.via, download ? asDownload(found, found.name) : found, "private, max-age=31536000, immutable");
  }

  /**
   * Step 7c: GET /api/todos/<todoId>/files/<n>, the file of block n of an open to-do. The same rule
   * and sealing as an attachment; never kept by the browser, since the bot may change the file.
   */
  private todoFile(req: IncomingMessage, res: ServerResponse, raw: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      req.resume();
      return this.plain(res, 405, "Method not allowed");
    }
    const access = this.access(req, false);
    this.fileOrigin(req, res, access);
    if (!access.allowed) return this.plain(res, 401, access.message);
    const m = /^\/api\/todos\/(todo_[a-z0-9]{16})\/files\/(\d{1,3})$/.exec(raw);
    let found: ServedFile | undefined;
    try {
      found = m ? this.engine?.todoFile(m[1]!, Number(m[2])) : undefined;
    } catch (err) {
      log.error("A to-do's file could not be looked up", err);
      return this.plain(res, 500, "Internal server error");
    }
    if (!found) return this.plain(res, 404, "Not found");
    const download = new URLSearchParams((req.url ?? "").split("?")[1]).has("download");
    this.sendServed(req, res, access.via, download ? asDownload(found, found.name) : found, "private, no-cache");
  }

  /** The Files tab inventory and the checked bytes behind a bot-folder link. */
  private botDownload(req: IncomingMessage, res: ServerResponse, raw: string): void {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      req.resume();
      return this.plain(res, 405, "Method not allowed");
    }
    const access = this.access(req, false);
    this.fileOrigin(req, res, access);
    if (!access.allowed) return this.plain(res, 401, access.message);
    const m = /^\/api\/bots\/([a-z0-9_-]{1,128})\/(download|downloads)$/i.exec(raw);
    const rt = m && this.engine?.bots.get(m[1]!);
    if (!rt) return this.plain(res, 404, "Not found");
    try {
      if (m[2] === "downloads") {
        const body = JSON.stringify({ files: listBotFiles(rt.folder.dir, true) });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cross-Origin-Resource-Policy": "same-origin" });
        return void res.end(req.method === "HEAD" ? undefined : body);
      }
      const path = new URLSearchParams((req.url ?? "").split("?")[1]).get("path") ?? "";
      const found = folderDownload(rt.folder.dir, path);
      if (!found) return this.plain(res, 404, "Not found");
      this.sendServed(req, res, access.via, found, "no-store");
    } catch (err) {
      log.error("A bot's downloads could not be read", err);
      this.plain(res, 500, "Internal server error");
    }
  }

  /** Sends a stored file: a checked picture inline, anything else as a download that cannot run here. */
  private sendServed(req: IncomingMessage, res: ServerResponse, via: string, found: ServedFile, cache: string): void {
    res.writeHead(200, {
      "Content-Type": found.type,
      "Content-Length": found.size,
      "Content-Disposition": fileDisposition(found.name, found.inline),
      "Content-Security-Policy": found.inline ? ATTACHMENT_CSP_PICTURE : ATTACHMENT_CSP_DOWNLOAD,
      // The page reads it from its own origin; the desktop window (a file page, with the token) from another.
      ...(via === "tailscale" ? { "Cross-Origin-Resource-Policy": "same-origin" } : {}),
      "Cache-Control": cache,
    });
    if (req.method === "HEAD") return void res.end();
    const stream = createReadStream(found.full);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  // ------------------------------------------------------------ notifications (docs/build/step-push.md)

  /**
   * POST /api/push/renew, the body `{ old: <old address or null>, subscription }`: the service
   * worker's new subscription after the browser renewed it (pushsubscriptionchange), which has no
   * socket. Only a device the engine knows by the old address (or the new one) is changed; it never
   * adds one. JSON only, at most RENEW_MAX_BYTES. Answers `{ ok: true, deviceId }` or
   * `{ error: { code, message } }`. Never logs or echoes an address.
   */
  private renew(req: IncomingMessage, res: ServerResponse): void {
    const answer = (status: number, body: unknown) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string, message: string) => {
      req.resume();
      answer(status, { error: { code, message } });
    };
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return refuse(405, "bad_request", "Method not allowed");
    }
    const access = this.access(req, true);
    if (!access.allowed) {
      const present = header(req.headers, LOGIN_HEADER) ? "present" : "absent";
      log.warn(`Refused a renewal of a push subscription: ${access.reason} (identity header ${present})`);
      return refuse(401, "bad_request", access.message);
    }
    const type = (header(req.headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return refuse(415, "unsupported", "Send JSON.");
    const length = Number(header(req.headers, "content-length") ?? "0");
    if (Number.isFinite(length) && length > RENEW_MAX_BYTES) return refuse(413, "too_large", "Too large.");
    const engine = this.engine;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      answer(408, { error: { code: "bad_request", message: "Too slow." } });
      req.destroy();
    }, HOOK_READ_MS);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > RENEW_MAX_BYTES) {
        done = true;
        clearTimeout(timer);
        answer(413, { error: { code: "too_large", message: "Too large." } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      done = true;
      clearTimeout(timer);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!engine) return answer(503, { error: { code: "internal", message: "The engine is still starting." } });
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return answer(400, { error: { code: "bad_request", message: "Not valid JSON." } });
      }
      const parsed = renewBody(body);
      if (!parsed) return answer(400, { error: { code: "bad_request", message: "The subscription is not complete." } });
      try {
        const deviceId = engine.notifyRenew(parsed.old, parsed.subscription);
        answer(200, { ok: true, deviceId });
      } catch (err) {
        if (!(err instanceof EngineError)) log.error("A renewal of a push subscription could not be kept", err);
        const e = toErrorBody(err);
        answer(e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "internal" ? 500 : 400, { error: e });
      }
    });
  }

  private plain(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  }

  private whoami(req: IncomingMessage, res: ServerResponse): void {
    // A same-origin GET from the page carries no Origin header, so the origin rule is the socket's job.
    const access = this.access(req, false);
    const body: WhoAmI = access.allowed ? { allowed: true, via: access.via } : { allowed: false, via: "none", message: access.message };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  }

  private serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
    const root = this.uiDir!;
    const notFound = () => this.plain(res, 404, "Not found");
    if (path.includes("\0") || path.includes("\\") || path.endsWith("/") && path !== "/") return notFound();
    const rel = path === "/" ? "index.html" : path.slice(1);
    const full = resolve(root, rel);
    if (!full.startsWith(root + sep)) return notFound();

    let real: string;
    let size: number;
    let mtime: number;
    try {
      // Follow links, then check again that the file is still inside the folder.
      real = realpathSync(full);
      if (!real.startsWith(realpathSync(root) + sep)) return notFound();
      const st = statSync(real);
      if (!st.isFile()) return notFound();
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return notFound();
    }

    // Every file is checked again on each load, so a new build is never hidden behind an old copy.
    const etag = `W/"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`;
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      return void res.end();
    }
    const ext = extname(real).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Length": size,
      // The page's own policy (ui/index.html) also lets the desktop window's file page load pictures
      // from and post to http://127.0.0.1. A page served from here needs only its own origin, so it
      // gets this narrower policy on top: a browser keeps to both.
      ...(ext === ".html" ? { "Content-Security-Policy": PAGE_CSP_NARROWER } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    const stream = createReadStream(real);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  // ------------------------------------------------------------ frames

  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  broadcast<E extends EventName>(event: E, data: Events[E]): void {
    const text = JSON.stringify({ t: "evt", event, data });
    for (const ws of this.greeted) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private async onFrame(ws: WebSocket, text: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      frame = parsed as Record<string, unknown>;
    } catch {
      log.warn("Ignored a frame that is not JSON");
      return;
    }
    if (frame.t !== "req" || typeof frame.id !== "string") {
      log.warn("Ignored a frame that is not a request");
      return;
    }
    const id = frame.id;
    try {
      const result = await this.handle(ws, frame.method, frame.params);
      this.send(ws, { t: "res", id, ok: true, result } as ServerFrame);
    } catch (err) {
      if (!(err instanceof EngineError)) log.error(`Request ${String(frame.method)} failed`, err);
      this.send(ws, { t: "res", id, ok: false, error: toErrorBody(err) });
      if (err instanceof EngineError && err.code === "protocol_mismatch") setTimeout(() => ws.close(4001, "Protocol mismatch"), 50);
    }
  }

  /** The connection as the browser hub sees it. Pictures never go anywhere else. */
  browserConn(ws: WebSocket): BrowserConn & { slot: FrameSlot } {
    let conn = this.browserConns.get(ws);
    if (!conn) {
      const slot = new FrameSlot(ws);
      this.slots.add(slot);
      conn = {
        id: randomUUID(),
        slot,
        frame: (data) => slot.push(JSON.stringify({ t: "evt", event: "browser.frame", data })),
        ended: (data) => this.send(ws, { t: "evt", event: "browser.ended", data }),
        prompt: (data) => this.send(ws, { t: "evt", event: "browser.prompt", data }),
      };
      this.browserConns.set(ws, conn);
    }
    return conn;
  }

  /** For checks: what waits for each connection's pictures in this process, in bytes, and how many were dropped. */
  pictureBacklog(): { waiting: number; dropped: number }[] {
    return [...this.slots].map((s) => ({ waiting: s.waiting, dropped: s.dropped }));
  }

  /**
   * Answers one request. Engine 0.28.0: a request that is one of the person's own actions (a message,
   * a card's answer, a to-do, a Stop) is noted for the activity log once it succeeded
   * (core/person-actions.ts). Only windows reach this, so a bot's actions are never noted as his.
   */
  private async handle(ws: WebSocket, method: unknown, rawParams: unknown): Promise<unknown> {
    const engine = this.engine;
    const mine = engine && this.greeted.has(ws) ? personActionBefore(engine, method, rawParams, this.where.get(ws) ?? "mac") : undefined;
    const result = await this.answer(ws, method, rawParams);
    if (engine && mine) personActionAfter(engine, mine, result);
    return result;
  }

  private async answer(ws: WebSocket, method: unknown, rawParams: unknown): Promise<unknown> {
    if (!isMethod(method)) throw new EngineError("bad_request", "The engine does not know that request.");
    const params = parseParams(method, rawParams);
    if (params === undefined) throw new EngineError("bad_request", "That request was not filled in correctly.");
    const engine = this.engine;
    if (!engine) throw new EngineError("internal", "The engine is still starting.");

    if (method === "hello") {
      const p = params as { protocol: number; client: string };
      if (Math.floor(p.protocol) !== PROTOCOL_VERSION) {
        throw new EngineError(
          "protocol_mismatch",
          `This app and the engine do not speak the same version (app ${p.protocol}, engine ${PROTOCOL_VERSION}). Update Pobots.`,
        );
      }
      this.greeted.add(ws);
      log.info(`Said hello to ${p.client || "an app"}`);
      return { protocol: PROTOCOL_VERSION, engineVersion: ENGINE_VERSION };
    }
    if (!this.greeted.has(ws)) throw new EngineError("bad_request", "Say hello before anything else.");

    const m = method as Exclude<MethodName, "hello">;
    switch (m) {
      case "snapshot":
        return engine.snapshot();
      case "bot.create":
        return { bot: engine.createBot(params as Methods["bot.create"]["params"]) };
      case "bot.update":
        return { bot: await engine.updateBot(params as Methods["bot.update"]["params"]) };
      case "bot.vacation":
        return engine.setVacation(params as Methods["bot.vacation"]["params"]);
      case "bot.retire":
        engine.retireBot((params as Methods["bot.retire"]["params"]).botId);
        return {};
      case "bot.startFresh":
        return engine.startFresh((params as Methods["bot.startFresh"]["params"]).botId);
      case "bot.files":
        return { files: engine.listFiles((params as Methods["bot.files"]["params"]).botId) };
      case "bot.file.read":
        return engine.readFile(params as Methods["bot.file.read"]["params"]);
      case "bot.file.write":
        return engine.writeFile(params as Methods["bot.file.write"]["params"]);
      case "bot.file.delete":
        engine.deleteFile(params as Methods["bot.file.delete"]["params"]);
        return {};
      case "artifact.list":
        return { artifacts: engine.listArtifacts((params as Methods["artifact.list"]["params"]).botId) };
      case "artifact.open": {
        // The desktop window is a file page and needs the whole address; a browser page uses a path on its own origin.
        const opened = engine.openArtifact(params as Methods["artifact.open"]["params"]);
        const local = this.via.get(ws) !== "tailscale";
        return { src: local ? `http://127.0.0.1:${this.port}${opened.path}` : opened.path, rev: opened.rev };
      }
      case "artifact.remove":
        engine.removeArtifact(params as Methods["artifact.remove"]["params"]);
        return {};
      case "browser.state":
        return engine.browser.stateFor();
      case "browser.watch":
        return engine.browser.watch(this.browserConn(ws), params as Methods["browser.watch"]["params"]);
      case "browser.unwatch":
        engine.browser.unwatch(this.browserConn(ws), (params as Methods["browser.unwatch"]["params"]).watchId);
        return {};
      case "browser.view": {
        const p = params as Methods["browser.view"]["params"];
        engine.browser.view(this.browserConn(ws), p.watchId, p.ratio);
        return {};
      }
      case "browser.page.show": {
        const p = params as Methods["browser.page.show"]["params"];
        return engine.browser.pageShow(this.browserConn(ws), p.watchId, p.pageId);
      }
      case "browser.page.open": {
        const p = params as Methods["browser.page.open"]["params"];
        return engine.browser.pageOpen(this.browserConn(ws), p.watchId, p.url);
      }
      case "browser.page.close": {
        const p = params as Methods["browser.page.close"]["params"];
        await engine.browser.pageClose(this.browserConn(ws), p.watchId, p.pageId);
        return {};
      }
      case "browser.control": {
        const p = params as Methods["browser.control"]["params"];
        return engine.browser.control(this.browserConn(ws), p.watchId, p.take);
      }
      case "browser.input": {
        const p = params as Methods["browser.input"]["params"];
        await engine.browser.input(this.browserConn(ws), p.watchId, p.events);
        return {};
      }
      case "browser.go": {
        const p = params as Methods["browser.go"]["params"];
        await engine.browser.go(this.browserConn(ws), p.watchId, p.to);
        return {};
      }
      case "browser.answer": {
        const p = params as Methods["browser.answer"]["params"];
        await engine.browser.answer(this.browserConn(ws), p.watchId, p.answer);
        return {};
      }
      case "browser.selection":
        return engine.browser.selection(this.browserConn(ws), (params as Methods["browser.selection"]["params"]).watchId);
      case "browser.own":
        return engine.browser.own(params as Methods["browser.own"]["params"]);
      case "browser.close":
        await engine.browser.close(params as Methods["browser.close"]["params"]);
        return {};
      case "bot.history":
        return engine.history(params as Methods["bot.history"]["params"]);
      case "bot.history.read":
        return engine.readChange(params as Methods["bot.history.read"]["params"]);
      case "bot.history.undo":
        return engine.undoChange(params as Methods["bot.history.undo"]["params"]);
      case "rule.list":
        return { rules: engine.listRules((params as Methods["rule.list"]["params"]).botId) };
      case "rule.remove":
        engine.removeRule((params as Methods["rule.remove"]["params"]).ruleId);
        return {};
      case "thread.read":
        return engine.readThread(params as Parameters<Engine["readThread"]>[0]);
      case "message.send":
        return { item: engine.sendMessage(params as Parameters<Engine["sendMessage"]>[0]) };
      case "message.steer":
        return engine.steerQueued(params as Methods["message.steer"]["params"]);
      case "message.unqueue":
        return engine.unqueue(params as Methods["message.unqueue"]["params"]);
      case "thread.queued":
        return engine.queuedOf((params as Methods["thread.queued"]["params"]).threadId);
      case "chat.set":
        return engine.chatSet(params as Methods["chat.set"]["params"]);
      case "aboutYou.set":
        return engine.aboutYouSet((params as Methods["aboutYou.set"]["params"]).text);
      case "sees.inventory":
        return engine.seesInventory(params as Methods["sees.inventory"]["params"]);
      case "attachment.discard":
        engine.discardAttachment((params as Methods["attachment.discard"]["params"]).id);
        return {};
      case "helper.stop":
        await engine.stopHelper(params as Methods["helper.stop"]["params"]);
        return {};
      case "turn.interrupt":
        await engine.interrupt((params as { botId: string }).botId);
        return {};
      case "taskManager.send":
        sendToTaskManager(engine, params as Methods["taskManager.send"]["params"]);
        return {};
      case "taskManager.stop":
        stopTaskManagerFrom(engine, params as Methods["taskManager.stop"]["params"]);
        return {};
      case "taskManager.end":
        endTaskManagerFrom(engine, params as Methods["taskManager.end"]["params"]);
        return {};
      case "trigger.list":
        return { triggers: engine.listTriggers((params as Methods["trigger.list"]["params"]).botId) };
      case "trigger.save":
        return { trigger: engine.saveTrigger(params as Methods["trigger.save"]["params"]) };
      case "trigger.remove":
        engine.removeTrigger((params as Methods["trigger.remove"]["params"]).triggerId);
        return {};
      case "trigger.run":
        return { run: engine.runTrigger((params as Methods["trigger.run"]["params"]).triggerId) };
      case "trigger.runs":
        return engine.triggerRuns(params as Methods["trigger.runs"]["params"]);
      case "trigger.newAddress":
        return engine.newAddress((params as Methods["trigger.newAddress"]["params"]).triggerId);
      case "trigger.address":
        return engine.triggerAddress((params as Methods["trigger.address"]["params"]).triggerId);
      case "trigger.enable": {
        const p = params as Methods["trigger.enable"]["params"];
        return { trigger: engine.enableTrigger(p.triggerId, p.enabled) };
      }
      case "channel.get":
        return { channel: engine.getChannel((params as Methods["channel.get"]["params"]).channelId) };
      case "channel.save":
        return { channel: engine.saveChannel(params as Methods["channel.save"]["params"]) };
      case "channel.remove":
        engine.removeChannel((params as Methods["channel.remove"]["params"]).channelId);
        return {};
      case "channel.address":
        return engine.channelAddress((params as Methods["channel.address"]["params"]).channelId);
      case "channel.newAddress":
        return engine.channelNewAddress((params as Methods["channel.newAddress"]["params"]).channelId);
      case "channel.messages":
        return engine.channelMessages(params as Methods["channel.messages"]["params"]);
      case "card.resolve": {
        const p = params as Parameters<Engine["resolveCard"]> extends [infer A, infer B] ? { cardId: A; decision: B } : never;
        engine.resolveCard(p.cardId, p.decision);
        return {};
      }
      case "backup.setPasswordRef":
        return engine.setBackupPasswordRef((params as Methods["backup.setPasswordRef"]["params"]).passwordRef);
      case "connection.list":
        return engine.links.list();
      case "connection.set":
        return engine.links.change(params as Methods["connection.set"]["params"]);
      case "backup.run":
        return engine.runBackup();
      case "notify.setKinds":
        return engine.notifySetKinds((params as Methods["notify.setKinds"]["params"]).kinds);
      case "notify.subscribe":
        return engine.notifySubscribe(params as Methods["notify.subscribe"]["params"]);
      case "notify.forget":
        return engine.notifyForget((params as Methods["notify.forget"]["params"]).deviceId);
      case "notify.test":
        return engine.notifyTest((params as Methods["notify.test"]["params"]).deviceId);
      case "notify.presence":
        engine.notifyPresence(this.connIds.get(ws) ?? "unknown", params as Methods["notify.presence"]["params"]);
        return {};
      // Step 7b.
      case "settings.set":
        return { settings: engine.settingsSet((params as Methods["settings.set"]["params"]).patch).settings };
      case "providers.check":
        return engine.providersCheck();
      case "providers.update":
        return engine.providersUpdate();
      case "usage.overview":
        return readUsageOverview(engine, params as Methods["usage.overview"]["params"]);
      case "usage.read":
        return engine.usageRead(params as Methods["usage.read"]["params"]);
      case "activity.day":
        return engine.activityDay(params as Methods["activity.day"]["params"]);
      case "usage.hub.add":
        return engine.usageHubAdd(params as Methods["usage.hub.add"]["params"]);
      case "usage.hub.remove":
        return engine.usageHubRemove(params as Methods["usage.hub.remove"]["params"]);
      case "chat.titles":
        return engine.chatTitles(params as Methods["chat.titles"]["params"]);
      // step 7c
      case "todo.answer":
        engine.answerTodo(params as Methods["todo.answer"]["params"]);
        return {};
      case "todo.close":
        engine.closeTodo(params as Methods["todo.close"]["params"]);
        return {};
      // Engine 0.31.0: follow-up questions on cards.
      case "todo.ask":
        return askOnTodo(engine, params as Methods["todo.ask"]["params"]);
      case "card.ask":
        return askOnCard(engine, params as Methods["card.ask"]["params"]);
      // Engine 0.25.0: the calendar connection.
      case "calendar.get":
        return { calendar: calendarState(engine) };
      case "calendar.set":
        return setCalendar(engine, params as Methods["calendar.set"]["params"]);
      case "calendar.test":
        return { calendar: await checkConnection(engine) };
      default: {
        const never: never = m;
        throw new EngineError("bad_request", `The engine does not know ${String(never)}.`);
      }
    }
  }

  close(): Promise<void> {
    return new Promise((done) => {
      const http = this.http;
      if (!http) return done();
      for (const ws of this.wss?.clients ?? []) ws.close(1001, "Engine stopping");
      this.wss?.close();
      http.close(() => done());
      http.closeIdleConnections();
      setTimeout(() => {
        http.closeAllConnections();
        done();
      }, 2000).unref();
    });
  }
}

/** The body of POST /api/push/renew, checked; undefined when it is not one. */
function renewBody(body: unknown): { old?: string; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const old = b.old;
  if (old !== undefined && old !== null && (typeof old !== "string" || old.length > 2048)) return undefined;
  const sub = b.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return undefined;
  if (typeof p256dh !== "string" || !p256dh || p256dh.length > 200 || typeof auth !== "string" || !auth || auth.length > 100) return undefined;
  return { ...(typeof old === "string" && old ? { old } : {}), subscription: { endpoint, keys: { p256dh, auth } } };
}
