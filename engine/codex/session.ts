// One `codex app-server` process for one awake bot (or one helper), speaking the same HarnessEvents
// as the Claude session (claude/session.ts), down to the tool names: a command arrives as "Bash", a
// file change as "Edit" or "Write", one of the bot's own tools as "mcp__pobots__<name>". Then rows,
// labels, cards, artifacts, the browser panel and the context rules work for a GPT bot unchanged.
// What Codex sent in the probes is written down in docs/build/notes-engine-3a.md.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AccessLevel, Effort } from "../../shared/protocol.js";
import type { BotTool, HarnessEvent, SessionSettings, TurnUsage } from "../claude/session.js";
import { TOOL_SERVER } from "../claude/session.js";
import { log } from "../log.js";
import { FAST_TIER } from "./models.js";
import { markUnnamable, refusedServer } from "./sees.js";
import { CodexRpc } from "./rpc.js";

type Loose = Record<string, unknown>;
const asLoose = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The tool name the engine sees for Codex's own agents (collabAgentToolCall, subAgentActivity). */
export const CODEX_AGENTS_TOOL = "CodexAgents";
/** The tool name of the card for Codex's request for more permissions. */
export const CODEX_PERMISSIONS_TOOL = "RequestPermissions";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Thread settings that switch Codex's plan tool on (step 7a; tried with Codex 0.165.0). */
const PLAN_CONFIG: Loose = { "tools.update_plan": { enabled: true } };

/**
 * The service tier Codex is told for fast mode on or off (step 3b). Always sent as one of these two
 * words: left out, Codex takes the person's own setting, and null means "default".
 */
export function serviceTier(fast: boolean): typeof FAST_TIER | "default" {
  return fast ? FAST_TIER : "default";
}

/** The access levels as Codex's approval policy, reviewer and sandbox (docs/build/step-3a.md, A2). Always sent. */
export const CODEX_ACCESS: Record<AccessLevel, { approvalPolicy: "untrusted" | "on-request" | "never"; approvalsReviewer: "user" | "auto_review"; sandbox: SandboxMode }> = {
  "asks-first": { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" },
  "edits-freely": { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" },
  "decides-itself": { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" },
};

/**
 * The sandbox of one turn, in turn/start's form. Network is open in both sandboxes, as it is for a
 * Claude bot (whose commands are asked about, not cut off): the bots' browser commands talk to the
 * browser over a local connection.
 */
export function sandboxPolicy(mode: SandboxMode, dir: string): Loose {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: true };
  return { type: "workspaceWrite", writableRoots: [dir], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** The bot's own tools as Codex's dynamic tools, with a JSON Schema made from each zod shape. */
export function dynamicTools(tools: BotTool[]): Loose[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t) }));
}

function jsonSchema(t: BotTool): Loose {
  const schema = z.toJSONSchema(z.object(t.shape)) as Loose;
  delete schema.$schema;
  return schema;
}

/** A short fingerprint of a tool list (names and schemas). A thread keeps the list it was started with. */
export function toolFingerprint(tools: BotTool[]): string {
  const parts = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, jsonSchema(t)]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** "/bin/zsh -lc 'echo hi > x.txt'" becomes "echo hi > x.txt". Anything else stays as it is. */
export function unwrapCommand(command: string): string {
  const m = /^\s*(?:\/[\w/.-]*\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(command);
  if (!m) return command;
  const rest = m[1]!.trim();
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return rest.slice(1, -1).replace(/'\\''/g, "'");
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1).replace(/\\"/g, '"');
  return rest;
}

/** A Codex error as one of the engine's api-error codes (see apiErrorSentence in engine.ts). */
export function codexErrorCode(error: unknown): string {
  const e = asLoose(error);
  const info = e.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] ?? "" : "";
  switch (kind) {
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
      return "codex_usage_limit";
    case "rateLimitExceeded":
      return "codex_rate_limit";
    case "unauthorized":
      return "codex_unauthorized";
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return "codex_unavailable";
    case "modelNotFound":
      return "codex_model_not_found";
    case "contextWindowExceeded":
      return "codex_context_full";
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
      return "codex_refused";
    default: {
      const msg = str(e.message).toLowerCase();
      if (/usage limit|hit your limit|quota/.test(msg)) return "codex_usage_limit";
      if (/unauthori[sz]ed|not logged in|log ?in again|sign in/.test(msg)) return "codex_unauthorized";
      return "codex_error";
    }
  }
}

function contentText(items: unknown, max: number): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((i) => asLoose(i))
    .filter((i) => i.type === "inputText" || i.type === "text")
    .map((i) => str(i.text))
    .join("\n")
    .slice(0, max);
}

interface QueuedMessage {
  text: string;
  before: string[];
  tidy: boolean;
  pictures: { path: string; type: string }[];
}

/** What a turn is told by `send`. */
export interface SendOptions {
  /** A tidy turn (docs/context.md): only reading and writes in the memory folder go on, and nothing is asked on a card. */
  tidy?: boolean;
  /** Pictures for the model: the engine's copies, sent as `localImage` items right after the message's text (the shape tried with real Codex). */
  pictures?: { path: string; type: string }[];
}

export class CodexSession {
  readonly settings: SessionSettings;
  private rpc: CodexRpc | undefined;
  private threadId: string | undefined;
  private ready = false;
  private closing = false;
  private exitSent = false;
  private queue: QueuedMessage[] = [];
  private turnRunning = false;
  private turnId: string | undefined;
  /** A tidy turn narrowed the writable roots to the memory folder; the next plain turn widens them again. */
  private rootsNarrowed = false;
  private turnTidy = false;
  private interruptAsked = false;
  private abort = new AbortController();
  /** Items of the current turn, by id, as they started (approvals name only the item). */
  private items = new Map<string, Loose>();
  private openTools = new Set<string>();
  private textOpen = new Set<string>();
  private streamed = new Set<string>();
  private thought = new Set<string>();
  private errorSaid = false;
  private compactedSaid = false;
  private usageLast: Loose | undefined;
  private usageWindow: number | undefined;
  private usageCount = 0;
  private usageCacheRead = 0;
  private usageAt = 0;
  private model: string;
  private effort: Effort;
  private access: AccessLevel;
  private fast: boolean;
  /** The tier last sent to Codex, to compare with the tier Codex reports. */
  private askedTier: string | undefined;
  /** A different tier than asked for is logged once per session. */
  private tierWarned = false;

  constructor(settings: SessionSettings) {
    this.settings = settings;
    this.model = settings.model;
    this.effort = settings.effort;
    this.access = settings.access;
    this.fast = settings.fast === true;
  }

  get closed(): boolean {
    return this.closing;
  }

  /** The thread behind this session, once it has started. */
  get thread(): string | undefined {
    return this.threadId;
  }

  start(): void {
    const s = this.settings;
    this.rpc = new CodexRpc({
      executable: s.executable,
      args: s.args ?? [],
      env: s.env,
      cwd: s.botDir,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (error) => this.onExit(error),
    });
    this.rpc.start();
    void this.boot();
  }

  private emit(e: HarnessEvent): void {
    this.settings.onEvent(e);
  }

  private async boot(): Promise<void> {
    const s = this.settings;
    const rpc = this.rpc!;
    const access = CODEX_ACCESS[this.access];
    try {
      await rpc.initialize(60_000);
      this.askedTier = serviceTier(this.fast);
      const common = {
        cwd: s.botDir,
        model: this.model,
        approvalPolicy: access.approvalPolicy,
        approvalsReviewer: access.approvalsReviewer,
        sandbox: access.sandbox,
        developerInstructions: s.systemAppend ?? "",
        serviceTier: this.askedTier,
      };
      // The plan tool is off in Codex by default; with it on, the bot's plan comes as turn/plan/updated and
      // Pobots shows it beside the chat (step 7a). An older Codex that does not know the setting refuses
      // the whole thread: then it starts without it.
      const open = (config?: Loose) =>
        s.resume
          ? rpc.request<Loose>("thread/resume", { threadId: s.resume, excludeTurns: true, ...common, ...(config ? { config } : {}) }, 60_000)
          : rpc.request<Loose>(
              "thread/start",
              { ...common, serviceName: "pobots", dynamicTools: dynamicTools(s.tools), ...(s.ephemeral ? { ephemeral: true } : {}), ...(config ? { config } : {}) },
              60_000,
            );
      // Codex summarises a thread by itself at this size (its own compaction; the person's setting,
      // ContextSettings.compactTokens). Without it Codex picks the point from the model's window.
      const compact: Loose = s.compactTokens ? { model_auto_compact_token_limit: s.compactTokens } : {};
      // A helper follows its bot's choice of services (docs/build/step-helper-sees.md). Failing to work
      // it out never stops the helper: it then gets everything, as before.
      const sees: Loose = s.codexConfig ? await s.codexConfig().catch(() => ({})) : {};
      if (this.closing) return;
      const refused = (err: unknown) => /update_plan|model_auto_compact|configuration|mcp_servers|features/i.test(err instanceof Error ? err.message : String(err));
      // A server Codex will not have named (one a plugin brings) is dropped from the choice and tried again.
      const openSees = async (cfg: Loose): Promise<Loose> => {
        const c: Loose = { ...cfg };
        for (let i = 0; ; i++) {
          try {
            return await open(c);
          } catch (err) {
            const name = refusedServer(err);
            const key = name && `mcp_servers.${name}.enabled`;
            if (!key || !(key in c) || i >= 20) throw err;
            delete c[key];
            markUnnamable(name);
            log.info(`Bot ${s.botId}: Codex cannot switch off ${name} by itself (a plugin brings it); it stays as Codex has it`);
          }
        }
      };
      let r: Loose;
      try {
        r = await openSees({ ...PLAN_CONFIG, ...compact, ...sees });
      } catch (err) {
        if (!refused(err)) throw err;
        log.info(`Bot ${s.botId}: Codex did not take the thread settings (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
        r = undefined as unknown as Loose;
        // What the bot's choice switches off alone, then nothing: the session always starts.
        if (Object.keys(sees).length) {
          try {
            r = await openSees(sees);
            log.info(`Bot ${s.botId}: it runs without the plan tool and the size at which it summarises`);
          } catch (err2) {
            if (!refused(err2)) throw err2;
          }
        }
        if (!r) {
          log.info(`Bot ${s.botId}: it runs without the thread settings${Object.keys(sees).length ? ", and sees everything of Codex's setup" : ""}`);
          r = await open();
        }
      }
      const thread = asLoose(r.thread);
      this.threadId = str(thread.id) || s.resume;
      if (!this.threadId) throw new Error("Codex gave no thread id");
      if (this.closing) return;
      this.checkTier(r.serviceTier, s.resume ? "thread/resume" : "thread/start");
      // Codex's own memory is shared by everything the person does in Codex. A Pobots bot keeps its
      // memory in its own folder, so nothing from this thread is to be turned into Codex memories.
      // Best effort: an older Codex without this request simply answers with an error.
      void rpc.request<Loose>("thread/memoryMode/set", { threadId: this.threadId, mode: "disabled" }, 15_000).catch((err) => {
        log.info(`Bot ${s.botId}: Codex's own memory could not be switched off for this thread (${err instanceof Error ? err.message : String(err)})`);
      });
      this.ready = true;
      this.emit({ type: "session", sessionId: this.threadId, model: str(r.model) || this.model });
      this.pump();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.closing) return;
      log.warn(`Bot ${s.botId}: Codex could not ${s.resume ? "resume its thread" : "start a thread"}: ${error}`);
      if (rpc.stderr.length) log.debug(`Bot ${s.botId}: last Codex output:\n  ${rpc.stderr.join("\n  ")}`);
      this.sendExit(error);
      this.closing = true;
      rpc.stop();
    }
  }

  private sendExit(error: string | undefined): void {
    if (this.exitSent) return;
    this.exitSent = true;
    this.abort.abort();
    this.emit({ type: "exit", ...(error ? { error } : {}), beforeInit: !this.ready });
  }

  private onExit(error: string | undefined): void {
    if (error && !this.closing) {
      log.warn(`Bot ${this.settings.botId}: Codex ended: ${error}`);
      const tail = this.rpc?.stderr ?? [];
      if (tail.length) log.warn(`Bot ${this.settings.botId}: last Codex output:\n  ${tail.join("\n  ")}`);
    }
    const was = this.closing;
    this.closing = true;
    this.sendExit(was ? undefined : error ?? "Codex ended");
  }

  // ------------------------------------------------------------ turns

  /** Hands Codex one message. It starts a turn now, or after the running one, in order. */
  send(text: string, before: string[] = [], o: SendOptions = {}): void {
    if (this.closing) return;
    this.queue.push({ text, before, tidy: o.tidy === true, pictures: o.pictures ?? [] });
    this.pump();
  }

  /**
   * Steering (13 Nov 2026): puts one message from the person into the running turn with Codex's
   * `turn/steer` (threadId, expectedTurnId, input; it answers with the turn's id). Tried with the real
   * app-server: the message is taken into the same turn while a command runs, and the model acts on
   * it when the command is done. Codex refuses it with "no active turn to steer" once the turn has
   * ended, or when the id is not the running turn's. False then, and in a tidy turn or while a Stop
   * is asked: the engine lets the message wait in line instead. Same shape as T3 Code's
   * CodexAdapterV2.steerTurn.
   */
  async steer(text: string, o: { id: string; pictures?: { path: string; type: string }[] }): Promise<boolean> {
    if (this.closing || !this.ready || !this.rpc || !this.threadId || !this.turnRunning || !this.turnId || this.turnTidy || this.interruptAsked) return false;
    const input = [{ type: "text", text, text_elements: [] }, ...(o.pictures ?? []).map((p) => ({ type: "localImage", path: p.path }))];
    try {
      await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input }, 15_000);
      return true;
    } catch (err) {
      log.info(`Bot ${this.settings.botId}: Codex did not take the steered message: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private pump(): void {
    if (!this.ready || this.turnRunning || this.closing) return;
    const next = this.queue.shift();
    if (next) void this.startTurn(next);
  }

  private async startTurn(m: QueuedMessage): Promise<void> {
    const s = this.settings;
    this.turnRunning = true;
    this.turnTidy = m.tidy;
    this.turnId = undefined;
    this.interruptAsked = false;
    this.abort = new AbortController();
    this.items.clear();
    this.openTools.clear();
    this.textOpen.clear();
    this.streamed.clear();
    this.thought.clear();
    this.errorSaid = false;
    this.compactedSaid = false;
    this.usageLast = undefined;
    this.usageCount = 0;
    this.usageCacheRead = 0;
    // A tidy turn (tried with real Codex, 12 Nov 2026): the sandbox itself is the gate. Only the memory
    // folder is writable, nothing is asked, and a write anywhere else simply fails. Asking does not
    // work here: Codex writes its notes with shell commands, and a gate cannot judge a shell command.
    const memory = join(s.botDir, "memory");
    const access = m.tidy ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" as SandboxMode } : CODEX_ACCESS[this.access];
    // Fast mode on or off is sent with every turn, also a tidy turn, so the person's own Codex setting never decides it.
    this.askedTier = serviceTier(this.fast);
    const params = {
      threadId: this.threadId,
      input: [
        ...m.before.map((text) => ({ type: "text", text, text_elements: [] })),
        { type: "text", text: m.text, text_elements: [] },
        ...m.pictures.map((p) => ({ type: "localImage", path: p.path })),
      ],
      model: this.model,
      effort: this.effort,
      // Reasoning summaries for the chat's work list (step 7a), said every turn like the other settings.
      summary: "auto",
      serviceTier: this.askedTier,
      approvalPolicy: access.approvalPolicy,
      approvalsReviewer: access.approvalsReviewer,
      sandboxPolicy: m.tidy
        ? { type: "workspaceWrite", writableRoots: [memory], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : sandboxPolicy(access.sandbox, s.botDir),
      // The roots stay as set for later turns, so a turn after a tidy turn puts the bot's folder back.
      ...(m.tidy ? { runtimeWorkspaceRoots: [memory] } : this.rootsNarrowed ? { runtimeWorkspaceRoots: [s.botDir] } : {}),
    };
    if (m.tidy) this.rootsNarrowed = true;
    else this.rootsNarrowed = false;
    try {
      const r = await this.rpc!.request<Loose>("turn/start", params, 60_000);
      const id = str(asLoose(r.turn).id);
      if (id && !this.turnId) this.turnId = id;
      if (this.interruptAsked) void this.interrupt();
    } catch (err) {
      if (this.closing) return;
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Bot ${s.botId}: Codex did not start the turn: ${error}`);
      this.turnRunning = false;
      this.emit({ type: "turn-end", ok: false, subtype: "start_failed", errors: [error], ...(this.threadId ? { sessionId: this.threadId } : {}), own: true });
      this.pump();
    }
  }

  private thinkingOnce(key: string): void {
    if (this.thought.has(key)) return;
    this.thought.add(key);
    this.emit({ type: "thinking" });
  }

  private onNotification(method: string, p: Loose): void {
    if (typeof p.threadId === "string" && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case "turn/started": {
        const id = str(asLoose(p.turn).id);
        if (id) this.turnId = id;
        this.emit({ type: "turn-start", own: true });
        if (this.interruptAsked) void this.interrupt();
        return;
      }
      case "item/started":
        this.itemStarted(asLoose(p.item));
        return;
      case "item/completed":
        this.itemCompleted(asLoose(p.item));
        return;
      case "item/agentMessage/delta": {
        const key = str(p.itemId);
        const delta = str(p.delta);
        if (!key || !delta) return;
        if (!this.textOpen.has(key)) {
          this.textOpen.add(key);
          this.emit({ type: "text-start", key });
        }
        this.streamed.add(key);
        this.emit({ type: "text-delta", key, text: delta });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryPartAdded":
        this.thinkingOnce(str(p.itemId) || "reasoning");
        return;
      case "turn/plan/updated": {
        // The bot's plan (update_plan), whole, at each change (step 7a).
        const plan = Array.isArray(p.plan) ? (p.plan as unknown[]).map(asLoose) : [];
        const steps = plan
          .map((x) => ({ text: str(x.step).trim(), status: x.status === "completed" ? ("completed" as const) : x.status === "inProgress" ? ("inProgress" as const) : ("pending" as const) }))
          .filter((x) => x.text);
        const explanation = str(p.explanation).trim();
        this.emit({ type: "plan", steps, ...(explanation ? { explanation } : {}) });
        return;
      }
      case "thread/tokenUsage/updated": {
        const u = asLoose(p.tokenUsage);
        this.usageLast = asLoose(u.last);
        if (typeof u.modelContextWindow === "number") this.usageWindow = u.modelContextWindow;
        this.usageCount++;
        this.usageCacheRead += Number(this.usageLast.cachedInputTokens ?? 0) || 0;
        this.usageAt = Date.now();
        return;
      }
      case "thread/settings/updated":
        this.checkTier(asLoose(p.threadSettings).serviceTier, method);
        return;
      case "thread/compacted":
        if (!this.compactedSaid) {
          this.compactedSaid = true;
          this.emit({ type: "compacted", trigger: "auto" });
        }
        return;
      case "error": {
        if (p.willRetry === true) return;
        const error = asLoose(p.error);
        this.errorSaid = true;
        this.emit({ type: "api-error", code: codexErrorCode(error), text: str(error.message) });
        return;
      }
      case "turn/completed":
        this.turnCompleted(asLoose(p.turn));
        return;
    }
  }

  private toolStart(toolUseId: string, name: string, input: Record<string, unknown>): void {
    if (this.openTools.has(toolUseId)) return;
    this.openTools.add(toolUseId);
    this.emit({ type: "tool-start", toolUseId, name, input });
  }

  private toolEnd(toolUseId: string, isError: boolean, text = ""): void {
    if (!this.openTools.has(toolUseId)) return;
    this.openTools.delete(toolUseId);
    this.emit({ type: "tool-end", toolUseId, isError, text: text.slice(0, 400), full: text.slice(0, 20_000) });
  }

  /** The tool calls one item stands for: [toolUseId, name, input]. */
  private callsOf(item: Loose): [string, string, Record<string, unknown>][] {
    const id = str(item.id);
    switch (item.type) {
      case "commandExecution":
        return [[id, "Bash", { command: unwrapCommand(str(item.command)), ...(item.cwd ? { cwd: str(item.cwd) } : {}) }]];
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? (item.changes as unknown[]).map(asLoose) : [];
        return changes.map((c, i) => [`${id}#${i}`, asLoose(c.kind).type === "add" ? "Write" : "Edit", { file_path: str(c.path) }]);
      }
      case "dynamicToolCall":
        return [[id, `mcp__${TOOL_SERVER}__${str(item.tool)}`, asLoose(item.arguments)]];
      case "mcpToolCall":
        return [[id, `mcp__${str(item.server)}__${str(item.tool)}`, asLoose(item.arguments)]];
      case "webSearch":
        return str(item.query) ? [[id, "WebSearch", { query: str(item.query) }]] : [];
      case "imageView":
        return [[id, "Read", { file_path: str(item.path) }]];
      case "collabAgentToolCall":
      case "subAgentActivity":
        return [[id, CODEX_AGENTS_TOOL, { ...(item.prompt ? { prompt: str(item.prompt) } : {}), ...(item.tool ? { action: str(item.tool) } : item.kind ? { action: str(item.kind) } : {}) }]];
      default:
        return [];
    }
  }

  private itemStarted(item: Loose): void {
    const id = str(item.id);
    if (id) this.items.set(id, item);
    switch (item.type) {
      case "reasoning":
        this.thinkingOnce(id);
        return;
      case "contextCompaction":
        if (!this.compactedSaid) {
          this.compactedSaid = true;
          this.emit({ type: "compacted", trigger: "auto" });
        }
        return;
      case "agentMessage":
        // The text opens with its first delta; a message that never streams arrives whole when it completes.
        return;
    }
    for (const [toolUseId, name, input] of this.callsOf(item)) this.toolStart(toolUseId, name, input);
  }

  private itemCompleted(item: Loose): void {
    const id = str(item.id);
    switch (item.type) {
      case "agentMessage": {
        const text = str(item.text);
        if (!this.streamed.has(id) && text.trim()) this.emit({ type: "text-full", key: id, text });
        this.textOpen.delete(id);
        this.emit({ type: "text-end", key: id });
        return;
      }
      case "reasoning": {
        // Its summary, when Codex wrote one (step 7a): one line of work per reasoning item.
        const parts = Array.isArray(item.summary) ? (item.summary as unknown[]).map((x) => (typeof x === "string" ? x : str(asLoose(x).text))).filter((x) => x.trim()) : [];
        if (parts.length && id) this.emit({ type: "thought", key: id, text: parts.join("\n\n").trim() });
        return;
      }
      case "userMessage":
        return;
      case "contextCompaction":
        if (!this.compactedSaid) {
          this.compactedSaid = true;
          this.emit({ type: "compacted", trigger: "auto" });
        }
        return;
    }
    const calls = this.callsOf(item);
    const status = str(item.status);
    let isError = status === "failed" || status === "declined";
    let text = "";
    switch (item.type) {
      case "commandExecution":
        if (typeof item.exitCode === "number" && item.exitCode !== 0) isError = true;
        text = str(item.aggregatedOutput);
        break;
      case "dynamicToolCall":
        if (item.success === false) isError = true;
        text = contentText(item.contentItems, 20_000);
        break;
      case "mcpToolCall": {
        if (item.error) isError = true;
        const result = asLoose(item.result);
        text = Array.isArray(result.content)
          ? (result.content as unknown[]).map(asLoose).filter((c) => c.type === "text").map((c) => str(c.text)).join("\n")
          : item.error
            ? str(asLoose(item.error).message)
            : "";
        break;
      }
    }
    for (const [toolUseId, name, input] of calls) {
      // A call that only shows when it ends (a search that got its words late) still gets its line.
      if (!this.openTools.has(toolUseId)) this.toolStart(toolUseId, name, input);
      this.toolEnd(toolUseId, isError, text);
    }
  }

  private usage(): TurnUsage | undefined {
    const u = this.usageLast;
    if (!u) return undefined;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cached = n(u.cachedInputTokens);
    return {
      requests: this.usageCount,
      last: { input: Math.max(0, n(u.inputTokens) - cached), cacheRead: cached, cacheWrite: 0, output: n(u.outputTokens) },
      turn: { cacheRead: this.usageCacheRead, cacheWrite: 0, write5m: 0, write1h: 0 },
      ...(this.usageWindow ? { window: this.usageWindow } : {}),
      lastSentAgoMs: Math.max(0, Date.now() - this.usageAt),
    };
  }

  private turnCompleted(turn: Loose): void {
    if (!this.turnRunning) return;
    const status = str(turn.status) || "completed";
    for (const key of [...this.textOpen]) this.emit({ type: "text-end", key });
    this.textOpen.clear();
    const error = turn.error ? asLoose(turn.error) : undefined;
    if (status === "failed" && !this.errorSaid) {
      this.emit({ type: "api-error", code: error ? codexErrorCode(error) : "codex_error", text: error ? str(error.message) : "" });
    }
    const usage = this.usage();
    this.turnRunning = false;
    this.turnId = undefined;
    this.openTools.clear();
    this.emit({
      type: "turn-end",
      ok: status === "completed" || status === "interrupted",
      subtype: status,
      errors: error && str(error.message) ? [str(error.message)] : [],
      ...(this.threadId ? { sessionId: this.threadId } : {}),
      ...(usage ? { usage } : {}),
      own: true,
    });
    this.pump();
  }

  /**
   * Codex says which tier the thread has (thread/start, thread/resume, thread/settings/updated). When
   * it is not the one asked for, one line in the log per session; nothing is shown to the person.
   */
  private checkTier(reported: unknown, where: string): void {
    // Codex's types allow null for "no tier": that is the usual speed.
    if (reported === null) reported = "default";
    if (typeof reported !== "string" || !reported || !this.askedTier) return;
    log.debug(`Bot ${this.settings.botId}: Codex reports the tier ${reported} (asked for ${this.askedTier}) in ${where}`);
    if (reported === this.askedTier || this.tierWarned) return;
    this.tierWarned = true;
    log.warn(`Bot ${this.settings.botId}: Codex reports another tier than Pobots asked for: it says "${reported}", Pobots asked for "${this.askedTier}" (fast mode ${this.askedTier === FAST_TIER ? "on" : "off"})`);
  }

  // ------------------------------------------------------------ requests from Codex

  private async onRequest(method: string, p: Loose): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.approveCommand(p);
      case "item/fileChange/requestApproval":
        return this.approveFiles(p);
      case "item/permissions/requestApproval":
        return this.approvePermissions(p);
      case "item/tool/requestUserInput":
        return this.askUser(p);
      case "item/tool/call":
        return this.callTool(p);
      case "mcpServer/elicitation/request":
        log.info(`Bot ${this.settings.botId}: Codex passed on a request from the connector ${str(p.serverName) || "(unnamed)"} (${str(p.mode) || "no mode"}); refused`);
        return { action: "decline", content: null, _meta: null };
      default:
        log.info(`Bot ${this.settings.botId}: Codex sent a request Pobots does not handle (${method}); refused`);
        throw new Error("Pobots does not handle this request.");
    }
  }

  /** Asks the engine (a card, or a rule of the moment) whether a tool may run. */
  private async permit(name: string, input: Record<string, unknown>, itemId: string): Promise<PermissionResult> {
    if (this.turnTidy && this.settings.gate) {
      const why = this.settings.gate(name, input);
      if (why) return { behavior: "deny", message: why };
    }
    if (this.abort.signal.aborted) return { behavior: "deny", message: "The turn was stopped.", interrupt: true };
    const options = { signal: this.abort.signal, toolUseID: itemId || randomUUID(), requestId: itemId, pobotsNoAlways: true } as unknown as Parameters<SessionSettings["canUseTool"]>[2];
    try {
      return (await this.settings.canUseTool(name, input, options)) ?? { behavior: "deny", message: "Not allowed." };
    } catch (err) {
      log.warn(`Bot ${this.settings.botId}: asking about a tool failed`, err);
      return { behavior: "deny", message: "Pobots could not ask about this." };
    }
  }

  /**
   * Allow answers "accept"; a no answers "decline", so the model learns it was refused and goes on (real
   * Codex took "decline" also when its list of choices named only "accept" and "cancel", 12 Nov 2026);
   * a turn that was stopped answers "cancel".
   */
  private decision(r: PermissionResult, available: unknown): string {
    const words = Array.isArray(available) ? (available as unknown[]).filter((d): d is string => typeof d === "string") : [];
    if (r.behavior === "allow") return words.length === 0 || words.includes("accept") ? "accept" : words.includes("acceptForSession") ? "acceptForSession" : "accept";
    return r.interrupt ? "cancel" : "decline";
  }

  private async approveCommand(p: Loose): Promise<unknown> {
    const itemId = str(p.itemId);
    const command = unwrapCommand(str(p.command) || str(asLoose(this.items.get(itemId)).command));
    const input: Record<string, unknown> = { command, ...(p.reason ? { description: str(p.reason) } : {}) };
    const r = await this.permit("Bash", input, itemId);
    return { decision: this.decision(r, p.availableDecisions) };
  }

  private async approveFiles(p: Loose): Promise<unknown> {
    const itemId = str(p.itemId);
    const item = this.items.get(itemId);
    const changes = Array.isArray(item?.changes) ? (item!.changes as unknown[]).map(asLoose) : [];
    const paths = changes.map((c) => str(c.path)).filter(Boolean);
    const name = changes.length === 1 && asLoose(changes[0]!.kind).type === "add" ? "Write" : "Edit";
    if (this.turnTidy && this.settings.gate) {
      for (const path of paths.length ? paths : [str(p.grantRoot)]) {
        const why = this.settings.gate(name, { file_path: path });
        if (why) return { decision: "decline" };
      }
    }
    const input: Record<string, unknown> = { file_path: paths[0] ?? str(p.grantRoot), ...(paths.length > 1 ? { files: paths } : {}), ...(p.reason ? { description: str(p.reason) } : {}) };
    const r = await this.permit(name, input, itemId);
    return { decision: this.decision(r, ["accept", "acceptForSession", "decline", "cancel"]) };
  }

  private async approvePermissions(p: Loose): Promise<unknown> {
    const asked = asLoose(p.permissions);
    const network = asLoose(asked.network);
    const fs = asLoose(asked.fileSystem);
    const input: Record<string, unknown> = {
      ...(p.reason ? { reason: str(p.reason) } : {}),
      network: network.enabled === true,
      write: Array.isArray(fs.write) ? fs.write : [],
      read: Array.isArray(fs.read) ? fs.read : [],
    };
    const r = await this.permit(CODEX_PERMISSIONS_TOOL, input, str(p.itemId));
    if (r.behavior !== "allow") return { permissions: {}, scope: "turn" };
    return { permissions: { ...(asked.network ? { network: asked.network } : {}), ...(asked.fileSystem ? { fileSystem: asked.fileSystem } : {}) }, scope: "turn" };
  }

  /** Codex's question to the person becomes the question card the engine makes for AskUserQuestion. */
  private async askUser(p: Loose): Promise<unknown> {
    const questions = (Array.isArray(p.questions) ? (p.questions as unknown[]) : []).map(asLoose).filter((q) => q.isSecret !== true);
    if (!questions.length) return { answers: {} };
    const input: Record<string, unknown> = {
      questions: questions.map((q) => ({
        question: str(q.question) || str(q.header),
        header: str(q.header),
        options: (Array.isArray(q.options) ? (q.options as unknown[]) : []).map(asLoose).map((o) => ({ label: str(o.label), description: str(o.description) })),
        multiSelect: false,
      })),
    };
    const r = await this.permit("AskUserQuestion", input, str(p.itemId));
    if (r.behavior !== "allow") return { answers: {} };
    const given = asLoose(asLoose(r.updatedInput).answers);
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of questions) {
      const a = given[str(q.question) || str(q.header)];
      if (typeof a === "string" && a) answers[str(q.id)] = { answers: [a] };
    }
    return { answers };
  }

  /** One of the bot's own tools. Its handler gets a signal that fires when the turn is stopped. */
  private async callTool(p: Loose): Promise<unknown> {
    const name = str(p.tool);
    const args = asLoose(p.arguments);
    const fail = (text: string) => ({ contentItems: [{ type: "inputText", text }], success: false });
    const tool = this.settings.tools.find((t) => t.name === name);
    if (!tool) return fail(`There is no tool called ${name}.`);
    if (this.turnTidy && this.settings.gate) {
      const why = this.settings.gate(`mcp__${TOOL_SERVER}__${name}`, args);
      if (why) return fail(why);
    }
    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) return fail(`The arguments do not fit the tool: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>, this.abort.signal);
      const text = result.content.map((c) => c.text).join("\n");
      return { contentItems: [{ type: "inputText", text }], success: !result.isError };
    } catch (err) {
      log.warn(`Bot ${this.settings.botId}: the tool ${name} failed`, err);
      return fail("The tool failed. The details are in the engine log.");
    }
  }

  // ------------------------------------------------------------ the rest of HarnessSession

  async interrupt(): Promise<void> {
    if (!this.turnRunning) return;
    this.abort.abort();
    if (!this.turnId) {
      this.interruptAsked = true;
      return;
    }
    this.interruptAsked = false;
    await this.rpc?.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 15_000);
  }

  /** Codex's own tasks are not helpers in this step; nothing to stop. */
  async stopTask(): Promise<void> {}

  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
  }

  async setAccess(access: AccessLevel): Promise<void> {
    this.access = access;
  }

  /** Fast mode on or off from the next turn, in the same thread (step 3b). */
  async setFast(fast: boolean): Promise<void> {
    this.fast = fast;
  }

  /** The engine reads Codex's model list in detect.ts, not from a session. */
  async supportedModels(): Promise<never[]> {
    return [];
  }

  close(): void {
    if (this.closing && !this.rpc?.alive) return;
    this.closing = true;
    this.abort.abort();
    this.queue = [];
    this.rpc?.stop();
  }
}
