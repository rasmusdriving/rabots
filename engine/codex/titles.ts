// Chat titles made by a GPT model through Codex (docs/build/step-gpt-titles.md, 18 Nov 2026).
//
// T3 Code makes such text with one `codex exec` per piece (apps/server/src/textGeneration/
// CodexTextGeneration.ts: --ephemeral, read-only sandbox, an output schema, every MCP server of the
// person's Codex setup switched off by name, plugins and apps off). Pobots uses the same switches on
// one quiet `codex app-server` of its own, kept only for titles: started on the first GPT title, a
// fresh ephemeral thread per title (nothing goes into Codex's history), one title at a time, stopped
// after IDLE_MS without a title and when the engine stops. It is a process of its own, so no bot's
// Codex session is touched.
//
// Measured on 18 Nov 2026 with codex-cli 0.170.0 and GPT-6 Luna: initialize about 30 ms, thread/start
// about 80 ms, a whole title about 2 s, about 7,500 input and 20 output tokens with everything below off.
import { mkdirSync } from "node:fs";
import { log } from "../log.js";
import { CodexRpc } from "./rpc.js";
import { isUnnamable, listCodexMcp, markUnnamable, refusedServer } from "./sees.js";

type Loose = Record<string, unknown>;

/** What the title server needs of Pobots' Codex setup. */
export interface CodexTitleSetup {
  ready: boolean;
  executable?: string;
  args?: string[];
  env: Record<string, string | undefined>;
}

/** A title, or why there is none (for the log; never chat text). */
export interface CodexTitleResult {
  title?: string;
  why?: string;
}

/** The server stops after this long without a title. */
export const CODEX_TITLE_IDLE_MS = 2 * 60 * 1000;
/** One title may take this long; then the server is stopped and the title is made elsewhere. */
export const CODEX_TITLE_MS = 60_000;
/** The server is started afresh after this many titles, so a long backfill does not grow it. */
const TITLES_PER_SERVER = 50;

/** The title's shape: Codex answers `{"title": "..."}`. */
const TITLE_SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

/**
 * Everything a title does not need, off for the thread (never written to ~/.codex). A Codex that does
 * not know one of these keys may refuse the thread; it is then tried with the servers, plugins and
 * apps off alone, and then with nothing.
 */
const EXTRAS_OFF: Loose = {
  web_search: "disabled",
  "tools.view_image": false,
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.js_repl": false,
  "features.image_generation": false,
  "features.skills": false,
  "features.tool_suggest": false,
  "features.multi_agent": false,
  "agents.enabled": false,
  "features.memories": false,
  "features.chronicle": false,
  "features.default_mode_request_user_input": false,
  "features.context_management.experimental_mode": false,
  project_doc_max_bytes: 0,
  include_apply_patch_tool: false,
  include_permissions_instructions: false,
  include_environment_context: false,
};

const keyable = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 160);

interface Waiting {
  threadId: string;
  text: string;
  resolve: (r: { status: string; text: string; error?: string }) => void;
}

export class CodexTitles {
  private rpc?: CodexRpc;
  private starting?: Promise<CodexRpc>;
  /** The servers to switch off by name, listed once per start. */
  private servers: string[] = [];
  private made = 0;
  private idleTimer?: NodeJS.Timeout;
  private waiting?: Waiting;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly o: { setup: () => CodexTitleSetup; workDir: string; system: string; idleMs?: number; titleMs?: number };

  constructor(o: { setup: () => CodexTitleSetup; workDir: string; system: string; idleMs?: number; titleMs?: number }) {
    this.o = o;
  }

  /** Whether the server runs now. For tests. */
  get running(): boolean {
    return !!this.rpc?.alive;
  }

  /** One title from `prompt` on `model`, one at a time. Never throws. */
  make(prompt: string, model: string, canStart = () => true): Promise<CodexTitleResult> {
    const next = this.chain.then(() => this.makeOne(prompt, model, canStart));
    this.chain = next.catch(() => undefined);
    return next.catch((err: unknown) => ({ why: firstLine(err) }));
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }

  /** Stops the server; the next title starts a new one. */
  private halt(): void {
    clearTimeout(this.idleTimer);
    const rpc = this.rpc;
    this.rpc = undefined;
    this.starting = undefined;
    this.waiting?.resolve({ status: "stopped", text: "" });
    this.waiting = undefined;
    rpc?.stop();
  }

  private async makeOne(prompt: string, model: string, canStart: () => boolean): Promise<CodexTitleResult> {
    if (this.stopped) return { why: "Pobots is stopping" };
    if (!canStart()) return { why: "the bot is on vacation" };
    clearTimeout(this.idleTimer);
    try {
      const rpc = await this.ensure();
      if (!canStart()) return { why: "the bot is on vacation" };
      const threadId = await this.openThread(rpc, model);
      if (!canStart()) return { why: "the bot is on vacation" };
      const turnMs = this.o.titleMs ?? CODEX_TITLE_MS;
      const done = new Promise<{ status: string; text: string; error?: string }>((resolve) => {
        this.waiting = { threadId, text: "", resolve };
      });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<{ status: string; text: string }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", text: "" }), turnMs);
        timer.unref?.();
      });
      try {
        await rpc.request(
          "turn/start",
          { threadId, input: [{ type: "text", text: prompt }], effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, outputSchema: TITLE_SCHEMA },
          turnMs,
        );
        const r = await Promise.race([done, timedOut]);
        if (r.status === "timeout") {
          // A turn that hangs is ended with its server; the next title starts a new one.
          this.halt();
          return { why: `no answer within ${Math.round(turnMs / 1000)} s` };
        }
        if (r.status !== "completed") return { why: r.status === "stopped" ? "Codex stopped" : `the turn ${r.status}${"error" in r && r.error ? `: ${r.error}` : ""}` };
        return r.text.trim() ? { title: r.text } : { why: "Codex gave no text" };
      } finally {
        clearTimeout(timer);
        this.waiting = undefined;
        // The thread is ephemeral; letting go of it keeps the server small.
        if (this.rpc === rpc) rpc.request("thread/unsubscribe", { threadId }, 5_000).catch(() => undefined);
      }
    } catch (err) {
      this.halt();
      return { why: firstLine(err) };
    } finally {
      this.made++;
      if (this.made >= TITLES_PER_SERVER) {
        this.made = 0;
        this.halt();
      }
      this.armIdle();
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.rpc || this.stopped) return;
    this.idleTimer = setTimeout(() => this.halt(), this.o.idleMs ?? CODEX_TITLE_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private ensure(): Promise<CodexRpc> {
    if (this.rpc?.alive) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;
    const s = this.o.setup();
    if (!s.ready || !s.executable) return Promise.reject(new Error("Codex is not ready"));
    const executable = s.executable;
    const p = (async () => {
      mkdirSync(this.o.workDir, { recursive: true });
      const rpc: CodexRpc = new CodexRpc({
        executable,
        ...(s.args ? { args: s.args } : {}),
        env: s.env,
        cwd: this.o.workDir,
        onNotification: (method, params) => this.onNote(method, params),
        // A title never needs approval for anything: every ask is declined.
        onRequest: async () => ({ decision: "decline" }),
        onExit: (why) => {
          if (this.rpc === rpc) {
            this.rpc = undefined;
            this.waiting?.resolve({ status: "stopped", text: "" });
            this.waiting = undefined;
          }
          if (why) log.debug(`Chat titles: Codex's title server ended (${why})`);
        },
      });
      rpc.start();
      try {
        await rpc.initialize(15_000);
        const listed = await listCodexMcp({ executable, ...(s.args ? { args: s.args } : {}), env: s.env, cwd: this.o.workDir, timeoutMs: 10_000 });
        this.servers = listed.filter((x) => x.enabled && keyable(x.name)).map((x) => x.name);
        if (this.stopped) throw new Error("Pobots is stopping");
      } catch (err) {
        rpc.stop();
        throw err;
      }
      this.rpc = rpc;
      this.made = 0;
      return rpc;
    })();
    this.starting = p;
    return p.finally(() => {
      if (this.starting === p) this.starting = undefined;
    });
  }

  private onNote(method: string, p: Loose): void {
    const w = this.waiting;
    if (!w || p.threadId !== w.threadId) return;
    if (method === "item/completed") {
      const item = p.item && typeof p.item === "object" ? (p.item as Loose) : {};
      if (item.type === "agentMessage" && typeof item.text === "string") w.text = item.text;
    } else if (method === "turn/completed") {
      const turn = p.turn && typeof p.turn === "object" ? (p.turn as Loose) : {};
      const err = turn.error && typeof turn.error === "object" ? (turn.error as Loose) : undefined;
      const info = err ? (typeof err.codexErrorInfo === "string" ? err.codexErrorInfo : typeof err.message === "string" ? firstLine(err.message) : "") : "";
      w.resolve({ status: typeof turn.status === "string" ? turn.status : "completed", text: w.text, ...(info ? { error: info } : {}) });
    }
  }

  /** An ephemeral, read-only thread with the title rules as its only instructions and everything else off. */
  private async openThread(rpc: CodexRpc, model: string): Promise<string> {
    const servers: Loose = {};
    for (const n of this.servers) if (!isUnnamable(n)) servers[`mcp_servers.${n}.enabled`] = false;
    const base: Loose = { ...servers, "features.plugins": false, "features.apps": false };
    const start = (config: Loose) =>
      rpc.request<Loose>(
        "thread/start",
        { cwd: this.o.workDir, model, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, serviceName: "pobots", baseInstructions: this.o.system, developerInstructions: "", config },
        15_000,
      );
    // A server a plugin brings cannot be named: dropped and tried again, as a bot's session does.
    const startDropping = async (config: Loose): Promise<Loose> => {
      const c = { ...config };
      for (let i = 0; ; i++) {
        try {
          return await start(c);
        } catch (err) {
          const name = refusedServer(err);
          const key = name && `mcp_servers.${name}.enabled`;
          if (!key || !(key in c) || i >= 20) throw err;
          delete c[key];
          markUnnamable(name);
        }
      }
    };
    const refused = (err: unknown) => /configuration|features|unknown|invalid/i.test(err instanceof Error ? err.message : String(err));
    let r: Loose;
    try {
      r = await startDropping({ ...base, ...EXTRAS_OFF });
    } catch (err) {
      if (!refused(err)) throw err;
      log.debug(`Chat titles: Codex did not take the extra switches (${firstLine(err)})`);
      try {
        r = await startDropping(base);
      } catch (err2) {
        if (!refused(err2)) throw err2;
        r = await start({});
      }
    }
    const thread = r.thread && typeof r.thread === "object" ? (r.thread as Loose) : {};
    if (typeof thread.id !== "string") throw new Error("thread/start gave no thread");
    return thread.id;
  }
}
