// The real engine client: a WebSocket to the engine, as described in shared/protocol.ts.
//
// On every (re)connect: open the engine's socket (with the token inside the desktop shell, without
// one on a page served by the engine itself), send `hello`, then `snapshot`, then hand the snapshot
// to the app. Requests made while the connection is down wait for it to come back (up to a limit).
// A dropped connection is retried quietly with a growing pause. When the socket cannot open and an
// `explain` function is given (a page in a plain browser), it asks the engine why and shows that.
import {
  PROTOCOL_VERSION,
  type Attachment,
  type AttachmentUploadResult,
  type EngineEndpoint,
  type ErrorBody,
  type MethodName,
  type Methods,
  type RequestFrame,
  type ServerFrame,
  type WhoAmI,
} from "../../shared/protocol";
import { attachmentAddress, botDownloadAddress, httpOriginOf, todoFileAddress } from "../lib/env";
import { reloadOnceForUpdate } from "../lib/update";
import { EngineError, type ConnectionInfo, type EngineClient, type EngineEvent, type EngineListener, type UploadRequest } from "./types";

const RETRY_STEPS_MS = [250, 500, 1000, 2000, 4000];
/** How long a request may wait for the connection to come back before it fails. */
const WAIT_FOR_READY_MS = 15_000;
/** How long a sent request may wait for its answer. */
const ANSWER_TIMEOUT_MS = 60_000;

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiting {
  send(): void;
  fail(): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The socket on the page's own origin, for a page the engine serves itself. Null for a file page. */
export function sameOriginEndpoint(): EngineEndpoint | null {
  const { protocol, host } = window.location;
  if ((protocol !== "http:" && protocol !== "https:") || !host) return null;
  return { url: `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws` };
}

/** Asks the engine that served this page whether this device may open it. Null when it does not answer. */
export async function askWhoAmI(): Promise<WhoAmI | null> {
  try {
    const res = await fetch("/api/whoami", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WhoAmI>;
    return typeof body.allowed === "boolean" ? (body as WhoAmI) : null;
  } catch {
    return null;
  }
}

/** An upload that sends nothing for this long has stalled; the person can try again. */
const UPLOAD_STALL_MS = 60_000;

/** The words for an upload the engine refused, when its answer carries none. */
const UPLOAD_REFUSED: Record<number, ErrorBody> = {
  413: { code: "too_large", message: "That file is too big." },
  415: { code: "unsupported", message: "The bot can't read that kind of file." },
};

/**
 * Sends one file's bytes to the engine with a POST and reports how far it got. XMLHttpRequest, not
 * fetch, because only it says how much of the body has gone out.
 */
function postFile(url: string, request: UploadRequest): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      clearTimeout(stall);
      request.signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        xhr.abort();
        fail(new Error("The upload stalled."));
      }, UPLOAD_STALL_MS);
    };
    const onAbort = () => {
      xhr.abort();
      fail(new DOMException("The upload was stopped.", "AbortError"));
    };
    if (request.signal.aborted) return onAbort();
    request.signal.addEventListener("abort", onAbort);
    xhr.open("POST", url);
    // The engine decides the kind by the file's own bytes; the browser's word is not sent as if it counted.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      watch();
      if (e.lengthComputable && e.total > 0) request.progress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      clearTimeout(stall);
      request.signal.removeEventListener("abort", onAbort);
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status === 200 && body && typeof body === "object" && "attachment" in body) {
        request.progress(1);
        return resolve((body as AttachmentUploadResult).attachment);
      }
      const error = body && typeof body === "object" && "error" in body ? (body as { error: ErrorBody }).error : undefined;
      if (error && typeof error.code === "string") return reject(new EngineError(error));
      const known = UPLOAD_REFUSED[xhr.status];
      reject(known ? new EngineError(known) : new Error(`The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => fail(new Error("The upload did not reach the engine."));
    watch();
    xhr.send(request.file);
  });
}

const notReachable = () =>
  new EngineError({ code: "disconnected", message: "The engine is not reachable right now. Try again in a moment." });

export class WsEngineClient implements EngineClient {
  private listener: EngineListener | undefined;
  private socket: WebSocket | undefined;
  private ready = false;
  private stopped = false;
  private refused = false;
  private attempt = 0;
  private nextId = 1;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, Pending>();
  private waiting: Waiting[] = [];
  private everReady = false;
  /** The engine says this device may not open it. Keeps trying slowly, so access added later just works. */
  private blocked = false;
  /** The address the socket last connected to: also where uploads go and pictures come from. */
  private known: EngineEndpoint | null = null;

  /**
   * `uploads`: whether this window may send files. A page the engine served posts to its own origin;
   * the desktop window (a file page) posts to 127.0.0.1 with its token, and the engine answers it
   * with CORS for a file page alone.
   */
  constructor(
    private readonly endpoint: () => Promise<EngineEndpoint | null>,
    private readonly explain?: () => Promise<WhoAmI | null>,
    uploads = false,
  ) {
    if (!uploads) this.upload = undefined;
  }

  upload?: (request: UploadRequest) => Promise<Attachment> = (request) => {
    const endpoint = this.known;
    if (!endpoint) return Promise.reject(notReachable());
    // encodeURIComponent, not URLSearchParams, so a space is %20 and never a "+" the engine might keep.
    const query = [`bot=${encodeURIComponent(request.botId)}`, `name=${encodeURIComponent(request.name)}`];
    if (endpoint.token) query.push(`token=${encodeURIComponent(endpoint.token)}`);
    return postFile(`${httpOriginOf(endpoint)}/api/attachments?${query.join("&")}`, request);
  };

  attachmentUrl(id: string, which: "preview" | "full" | "download"): string | undefined {
    return this.known ? attachmentAddress(this.known, id, which) : undefined;
  }

  todoFileUrl(todoId: string, index: number, version: string, download?: boolean): string | undefined {
    return this.known ? todoFileAddress(this.known, todoId, index, version, download) : undefined;
  }

  botDownloadUrl(botId: string, path?: string): string | undefined {
    return this.known ? botDownloadAddress(this.known, botId, path) : undefined;
  }

  start(listener: EngineListener): void {
    this.listener = listener;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.failAll();
  }

  request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    if (this.ready && this.socket) return this.send(this.socket, method, params);
    if (this.refused || this.stopped) return Promise.reject(notReachable());
    return new Promise((resolve, reject) => {
      const entry: Waiting = {
        send: () => {
          clearTimeout(entry.timer);
          this.send(this.socket!, method, params).then(resolve, reject);
        },
        fail: () => {
          clearTimeout(entry.timer);
          reject(notReachable());
        },
        timer: setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== entry);
          reject(notReachable());
        }, WAIT_FOR_READY_MS),
      };
      this.waiting.push(entry);
    });
  }

  // ------------------------------------------------------------ connection

  private lastPhase: string | undefined;

  /** Tells the app about a change of phase. Retries within one phase keep its start time. */
  private phase(info: Omit<ConnectionInfo, "since">): void {
    const key = `${info.phase}|${info.message ?? ""}`;
    if (key === this.lastPhase) return;
    this.lastPhase = key;
    this.listener?.connection({ ...info, since: Date.now() });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (!this.blocked) this.phase({ phase: this.everReady ? "reconnecting" : "connecting" });

    let endpoint: EngineEndpoint | null = null;
    try {
      endpoint = await this.endpoint();
    } catch {
      endpoint = null;
    }
    if (!endpoint) return this.retry();
    this.known = endpoint;

    let url: string;
    try {
      const u = new URL(endpoint.url);
      if (endpoint.token) u.searchParams.set("token", endpoint.token);
      url = u.toString();
    } catch {
      return this.retry();
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => void this.greet(socket);
    socket.onmessage = (message) => this.receive(socket, message.data);
    socket.onclose = () => this.dropped(socket);
    // An error is always followed by close, which does the work.
    socket.onerror = () => undefined;
  }

  private async greet(socket: WebSocket): Promise<void> {
    try {
      await this.send(socket, "hello", { protocol: PROTOCOL_VERSION, client: "pobots-ui" });
      const snapshot = await this.send(socket, "snapshot", {});
      if (socket !== this.socket) return;
      this.ready = true;
      this.everReady = true;
      this.blocked = false;
      this.attempt = 0;
      this.listener?.ready(snapshot);
      this.phase({ phase: "ready" });
      const waiting = this.waiting;
      this.waiting = [];
      for (const w of waiting) w.send();
    } catch (error) {
      if (error instanceof EngineError && error.code === "protocol_mismatch") {
        this.refused = true;
        // A page in a browser has most likely just missed a new build: reload once by itself first.
        if (this.explain && reloadOnceForUpdate()) return;
        for (const w of this.waiting) w.fail();
        this.waiting = [];
        this.phase({ phase: "refused", message: "This version of the app does not match the engine. Update Pobots and open it again." });
      }
      socket.close();
    }
  }

  private dropped(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.ready = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(notReachable());
      this.pending.delete(id);
    }
    if (this.refused) return;
    if (this.explain) void this.checkAccess().then(() => this.retry());
    else this.retry();
  }

  /** Asks the engine why the socket would not open, and says so when this device is not let in. */
  private async checkAccess(): Promise<void> {
    const who = await this.explain!().catch(() => null);
    if (this.stopped || this.ready) return;
    if (who && !who.allowed) {
      this.blocked = true;
      this.phase({ phase: "refused", message: who.message ?? "This device is not allowed to open Pobots." });
    } else if (this.blocked) {
      this.blocked = false;
      this.phase({ phase: this.everReady ? "reconnecting" : "connecting" });
    }
  }

  private retry(): void {
    if (this.stopped || this.refused) return;
    if (this.everReady && !this.blocked) this.phase({ phase: "reconnecting" });
    const step = this.blocked ? RETRY_STEPS_MS.length - 1 : Math.min(this.attempt, RETRY_STEPS_MS.length - 1);
    const wait = RETRY_STEPS_MS[step]!;
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }

  private failAll(): void {
    for (const w of this.waiting) w.fail();
    this.waiting = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(notReachable());
    }
    this.pending.clear();
  }

  // ------------------------------------------------------------ frames

  private send<M extends MethodName>(socket: WebSocket, method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(notReachable());
      const id = `r${this.nextId++}`;
      const frame: RequestFrame<M> = { t: "req", id, method, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError({ code: "timeout", message: "The engine did not answer in time. Try again." }));
      }, ANSWER_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      socket.send(JSON.stringify(frame));
    });
  }

  private receive(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket || typeof data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (frame.t === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new EngineError(frame.error));
      return;
    }
    if (frame.t === "evt") {
      // Events sent before the snapshot answer are already part of the snapshot.
      if (!this.ready) return;
      this.listener?.event({ event: frame.event, data: frame.data } as EngineEvent);
    }
  }
}
