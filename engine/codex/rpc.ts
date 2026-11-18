// A small JSON-RPC client for `codex app-server` over stdin and stdout: one JSON object per line,
// without the "jsonrpc" field (seen with codex-cli 0.165.0, docs/build/step-3a.md). Requests we send
// carry an id and get one answer; notifications have no id; requests from the server have an id and a
// method, and we answer them. Nothing here knows about bots.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../log.js";

type Loose = Record<string, unknown>;

export interface RpcOptions {
  executable: string;
  /** Arguments before "app-server". Empty for the real program; tests start a fake script with node. */
  args?: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** A notification from the server. */
  onNotification?: (method: string, params: Loose) => void;
  /** A request from the server. Resolve with the result; throw to answer with an error. */
  onRequest?: (method: string, params: Loose, id: number | string) => Promise<unknown>;
  /** The process ended. `error` says why, when it was not asked to stop. */
  onExit?: (error: string | undefined) => void;
}

/** An error answer from the server, with its code. */
export class RpcError extends Error {
  readonly code: number | undefined;
  constructor(method: string, error: unknown) {
    const e = error && typeof error === "object" ? (error as Loose) : {};
    super(`${method}: ${typeof e.message === "string" ? e.message : JSON.stringify(error)}`);
    this.code = typeof e.code === "number" ? e.code : undefined;
  }
}

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private waits = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  private ended = false;
  private stopping = false;
  private readonly o: RpcOptions;

  constructor(o: RpcOptions) {
    this.o = o;
  }

  get alive(): boolean {
    return !!this.child && !this.ended;
  }

  /** The last lines the program wrote to stderr, for the log. */
  get stderr(): string[] {
    return [...this.stderrTail];
  }

  start(): void {
    const child = spawn(this.o.executable, [...(this.o.args ?? []), "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.o.env as NodeJS.ProcessEnv,
      ...(this.o.cwd ? { cwd: this.o.cwd } : {}),
    });
    this.child = child;
    child.stdin.on("error", (err) => log.debug("Writing to Codex failed", err));
    child.stderr.on("data", (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.stderrTail.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
      if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    let spawnError: string | undefined;
    child.on("error", (err) => {
      spawnError = err.message;
    });
    child.on("close", (code, signal) => {
      if (this.ended) return;
      this.ended = true;
      const why = this.stopping ? undefined : spawnError ?? `the program ended (${signal ?? `code ${code}`})`;
      for (const [, w] of this.waits) {
        clearTimeout(w.timer);
        w.reject(new Error(`${w.method}: ${why ?? "the program was stopped"}`));
      }
      this.waits.clear();
      this.o.onExit?.(why);
    });
  }

  private write(o: Loose): void {
    if (!this.child || this.ended) return;
    try {
      this.child.stdin.write(JSON.stringify(o) + "\n");
    } catch (err) {
      log.debug("Writing to Codex failed", err);
    }
  }

  private onLine(line: string): void {
    let m: Loose;
    try {
      m = JSON.parse(line) as Loose;
    } catch {
      return;
    }
    const id = m.id as number | string | undefined;
    const method = typeof m.method === "string" ? m.method : undefined;
    const params = m.params && typeof m.params === "object" ? (m.params as Loose) : {};
    if (id !== undefined && method === undefined) {
      const w = typeof id === "number" ? this.waits.get(id) : undefined;
      if (!w) return;
      this.waits.delete(id as number);
      clearTimeout(w.timer);
      if (m.error !== undefined) w.reject(new RpcError(w.method, m.error));
      else w.resolve(m.result);
      return;
    }
    if (id !== undefined && method) {
      const handler = this.o.onRequest;
      if (!handler) {
        this.write({ id, error: { code: -32601, message: "not handled" } });
        return;
      }
      handler(method, params, id).then(
        (result) => this.write({ id, result: result ?? {} }),
        (err: unknown) => this.write({ id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
      );
      return;
    }
    if (method) {
      try {
        this.o.onNotification?.(method, params);
      } catch (err) {
        log.error("Could not handle a message from Codex", err);
      }
    }
  }

  /** Sends a request and waits for its answer. Rejects with RpcError on an error answer. */
  request<T = Loose>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child || this.ended) return Promise.reject(new Error(`${method}: Codex is not running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const w: { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs) {
        w.timer = setTimeout(() => {
          this.waits.delete(id);
          reject(new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        w.timer.unref?.();
      }
      this.waits.set(id, w);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** The handshake every connection begins with. */
  async initialize(timeoutMs = 30_000): Promise<Loose> {
    const r = await this.request<Loose>("initialize", { clientInfo: { name: "pobots", title: "Pobots", version: "0.1.0" }, capabilities: { experimentalApi: true } }, timeoutMs);
    this.notify("initialized");
    return r;
  }

  stop(): void {
    if (!this.child || this.ended) return;
    this.stopping = true;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    this.child.kill("SIGTERM");
    const child = this.child;
    const t = setTimeout(() => {
      if (!this.ended) child.kill("SIGKILL");
    }, 3000);
    t.unref?.();
  }
}
