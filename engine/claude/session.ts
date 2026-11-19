// One live Claude process for one awake bot, driven through the Agent SDK's `query()` in
// streaming input mode. The session turns the SDK's messages into a short list of plain events
// (HarnessEvent) and leaves threads, items, cards and bot state to the engine.
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodRawShape } from "zod";
import type { AccessLevel, Effort } from "../../shared/protocol.js";
import { AsyncQueue } from "../async-queue.js";
import { log } from "../log.js";
import { isLinkTool } from "../tool-names.js";
import type { SeesSessionSettings } from "./sees.js";

/** The picture types the harness takes as image blocks. The engine's copies for the model are always one of these. */
/** How long a helper's prompt cache lasts: an hour, like the bot's own, instead of the harness's 5 minutes. */
export const HELPER_CACHE = "1h" as const;
const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** The harness's names for the tool that starts a helper (a subagent). "Task" in older versions. */
export const HELPER_TOOLS = new Set(["Agent", "Task"]);
/** The harness's tool with which a helper hands its result back (also seen with a server prefix). */
export const HANDBACK_TOOL = /(^|__)SubagentHandback$/;
/** What the harness says in place of a result after such a hand-back: it only points at the call. */
export const HANDBACK_POINTER = /SubagentHandback|report was delivered to you/i;

export type HarnessEvent =
  | { type: "session"; sessionId: string; model?: string }
  /**
   * A turn of the harness began (its init message). `own` is true when it takes up a message Pobots
   * sent, false when the harness began it by itself, as when a helper in the background reports back.
   */
  | { type: "turn-start"; own: boolean }
  | { type: "thinking" }
  /**
   * A thinking summary the model wrote (step 7a): Claude's summarized thinking block, Codex's
   * reasoning summary. Never empty. `key` is unique for the block. Only for the bot's own thinking.
   */
  | { type: "thought"; key: string; text: string }
  /** The whole to-do list as the harness now has it (step 7a; Codex's turn/plan/updated). */
  | { type: "plan"; steps: { text: string; status: "pending" | "inProgress" | "completed" }[]; explanation?: string }
  | { type: "text-start"; key: string }
  | { type: "text-delta"; key: string; text: string }
  /** Whole text. With `parent`: said by the helper started by that tool call (helpers' text is never streamed). */
  | { type: "text-full"; key: string; text: string; parent?: string }
  | { type: "text-end"; key: string }
  /** A tool call. With `parent`: made by the helper started by that tool call. */
  | { type: "tool-start"; toolUseId: string; name: string; input: Record<string, unknown>; parent?: string }
  /**
   * A tool call came back. `text` is the start of its result, for telling a helper that went to the
   * background. `full` is more of its text (up to 20,000 characters) and `result` the harness's
   * structured result when the message carried one for this call alone (the SDK's tool_use_result),
   * for telling what a publish to Claude made.
   */
  | { type: "tool-end"; toolUseId: string; isError: boolean; parent?: string; text?: string; full?: string; result?: unknown }
  | { type: "api-error"; code: string; text: string }
  /**
   * `own`: the turn took up a message Pobots sent (see turn-start). False for a turn the harness began by itself.
   * `ahead` (steering): the engine's ids of messages steered into this turn that it ended before taking
   * up. The harness runs them next by itself, at once, in a turn of their own: the engine must not
   * send them again.
   */
  | { type: "turn-end"; ok: boolean; subtype: string; errors: string[]; sessionId?: string; usage?: TurnUsage; own?: boolean; ahead?: string[] }
  /**
   * Steering: messages steered into the turn that the harness gave back unread (a Stop took them out
   * of its line, or the process ended). The engine's ids; the engine puts them in line again.
   */
  | { type: "steer-returned"; ids: string[] }
  /**
   * The harness registered a task. Helpers are `taskType` "local_agent" with a `toolUseId`; `quiet` is
   * true for tasks the harness marks as not activity (skip_transcript or ambient).
   */
  | { type: "task-started"; taskId: string; toolUseId?: string; taskType?: string; background?: boolean; parentTaskId?: string; quiet: boolean }
  /** A task changed: moved to the background, or a new status. */
  | { type: "task-updated"; taskId: string; background?: boolean; status?: string }
  /** A task ended. `summary` is a helper's last words when it completed, else a short description. */
  | { type: "task-ended"; taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; summary: string }
  /**
   * The whole set of live background tasks, to be taken as the truth. `tasks` says more about each
   * (step 3b): its type, the helper that started it, and whether it is not activity.
   */
  | { type: "tasks-live"; taskIds: string[]; tasks?: LiveTaskInfo[] }
  /** The harness shortened the session (the SDK's compact boundary): by itself ("auto") or asked with /compact ("manual"). */
  | { type: "compacted"; trigger: "manual" | "auto"; preTokens?: number; postTokens?: number }
  /** The process ended. `beforeInit` is true when it never got as far as starting a session. */
  | { type: "exit"; error?: string; beforeInit: boolean };

/** One task in the harness's list of what runs in the background (step 3b). */
export interface LiveTaskInfo {
  taskId: string;
  /** "local_agent" for a helper, "local_bash" for a command, and others. */
  taskType?: string;
  /** The helper's task that started it, when a helper did. */
  parentTaskId?: string;
  /** The harness marks it as not activity (ambient). */
  quiet: boolean;
}

/**
 * What the model was sent and answered in one turn of the session, from the usage the requests
 * report. Only requests of the session itself count, not those of subagents.
 */
export interface TurnUsage {
  /** Main-session requests in the turn. */
  requests: number;
  /** The last request: input, cache read, cache written and output tokens. Their sum is the session's size. */
  last: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Over the turn's requests. `write5m` and `write1h` are the cache writes whose life the requests reported. */
  turn: { cacheRead: number; cacheWrite: number; write5m: number; write1h: number };
  /**
   * How long the cache lives, from the last request that wrote to it and said for how long. A write
   * that holds both kinds counts as five minutes: the shorter life decides whether the whole session
   * is still warm. Absent when no request said.
   */
  cache?: "5m" | "1h";
  /** The model's window, from the result's per-model usage. */
  window?: number;
  /** How long before the result the last request was sent, in ms. */
  lastSentAgoMs: number;
}

/** Usage of one request, gathered from its stream events and its assistant messages. */
interface RequestUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  write5m: number;
  write1h: number;
  output: number;
  startedAt: number;
}

/** The access levels mapped to the harness's own permission modes (docs/architecture.md). */
export const PERMISSION_MODES: Record<AccessLevel, PermissionMode> = {
  "asks-first": "default",
  "edits-freely": "acceptEdits",
  "decides-itself": "auto",
  "full-access": "bypassPermissions",
};

/** What a bot tool hands back to the harness. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** One tool of the bot's own "pobots" server. The engine builds the list per bot. */
export interface BotTool {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

/** The name of the bot tool server, as the harness sees it. */
export const TOOL_SERVER = "pobots";
/** How long the harness lets one bot tool call run: a question for the person may wait a long time. */
const TOOL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export function toolId(name: string): string {
  return `mcp__${TOOL_SERVER}__${name}`;
}

export interface SessionSettings {
  botId: string;
  botName: string;
  botDir: string;
  model: string;
  effort: Effort;
  access: AccessLevel;
  executable: string;
  env: Record<string, string | undefined>;
  /** The harness session to resume, when the thread has one. */
  resume?: string;
  /** The size in tokens at which the harness summarises the conversation by itself (ContextSettings.compactTokens). Unset: the harness's own point. */
  compactTokens?: number;
  /** The bot's own tools ("pobots" server). Tools the bot may not use are left out. */
  tools: BotTool[];
  /** Saved "Always allow" rules, in the harness's own rule format. */
  rules: string[];
  /** A few sentences about the team, added to the system prompt. */
  team: string;
  canUseTool: CanUseTool;
  /**
   * Asked before every tool call, whatever the access level (a PreToolUse hook). A sentence refuses
   * the call without a card; undefined lets it go on as usual. Used in tidy turns.
   */
  gate?: (toolName: string, input: Record<string, unknown>) => string | undefined;
  onEvent: (event: HarnessEvent) => void;
  // ---- optional, added in step 3a; a bot's own Claude session sets none of them
  /** Replaces the text appended to the system prompt (a helper's own paragraph). Codex gets it as its developer instructions. */
  systemAppend?: string;
  /** Claude only: tools the session may not use (a helper may not start helpers of its own). */
  disallowedTools?: string[];
  /** Claude only: false keeps the session off the disk (a helper). */
  persist?: boolean;
  /** Codex only: a thread that is never written to Codex's history (helpers, fresh runs). */
  ephemeral?: boolean;
  /** Codex only: arguments before "app-server". Tests start a fake app-server script with node. */
  args?: string[];
  // ---- optional, added in step 3b
  /**
   * Whether the session runs in fast mode: already the answer, worked out by the engine (the bot's or
   * the call's choice, and the model has a fast mode). Codex sends it on every thread start, resume
   * and turn; Claude has no fast mode and ignores it. Absent: not fast.
   */
  fast?: boolean;
  // ---- optional, added with what a bot sees (docs/sees.md)
  /** Claude only: what the bot's choice adds to the session's own settings. Absent: nothing, everything as Claude Code has it. */
  sees?: SeesSessionSettings;
  /**
   * Codex only: what the bot's choice switches off for a helper's thread, as `thread/start` config
   * overrides, worked out when the thread starts (docs/build/step-helper-sees.md). Absent or empty: everything.
   */
  codexConfig?: () => Promise<Record<string, unknown>>;
}

export function systemPromptAppend(name: string, team = ""): string {
  const parts = [
    `You are ${name}, a persistent bot that lives in Pobots, an app where the person keeps their bots and talks with them.`,
    "Your folder is your working directory. Your job and standing rules are in AGENTS.md there, and your memory is in the memory folder.",
    "You keep the same chat with the person over weeks and months, so keep your memory short and up to date.",
    "Now and then Pobots gives you a fresh session in the same chat, after you have written down what matters: what you need later must be in your memory folder, and search_chat finds what was said before.",
    `When you talk about yourself, you are ${name}.`,
  ].join(" ");
  return team ? `${parts}\n\n${team}` : parts;
}

/**
 * The model's window from the result's per-model usage: the entry of the session's model, else the
 * one that read the most (the main loop), else nothing.
 */
export function windowOf(modelUsage: unknown, model: string): { window?: number } {
  const all = asLoose(modelUsage);
  const entries = Object.entries(all).map(([key, v]) => ({ key, u: asLoose(v) }));
  const pick =
    entries.find((e) => e.key === model) ??
    entries.find((e) => e.key.startsWith(model) || model.startsWith(e.key)) ??
    [...entries].sort((a, b) => Number(b.u.inputTokens ?? 0) + Number(b.u.cacheReadInputTokens ?? 0) - Number(a.u.inputTokens ?? 0) - Number(a.u.cacheReadInputTokens ?? 0))[0];
  const w = pick ? Number(pick.u.contextWindow) : NaN;
  return Number.isFinite(w) && w > 0 ? { window: w } : {};
}

/** The abort signal the MCP layer passes to a tool handler, when there is one. */
function signalOf(extra: unknown): AbortSignal | undefined {
  const sig = extra && typeof extra === "object" ? (extra as { signal?: unknown }).signal : undefined;
  return sig instanceof AbortSignal ? sig : undefined;
}

type Loose = Record<string, unknown>;

/** The start of a tool result's text, from a string or a list of text blocks. */
function resultText(content: unknown, max = 400): string {
  if (typeof content === "string") return content.slice(0, max);
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => asLoose(b))
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .slice(0, max);
}
const asLoose = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});

export class ClaudeSession {
  readonly settings: SessionSettings;
  private inbox = new AsyncQueue<SDKUserMessage>();
  private q: Query | undefined;
  private sawInit = false;
  private closing = false;
  private stderrTail: string[] = [];
  /** Message id of the streamed assistant message in progress. */
  private currentMessage: string | undefined;
  /** Usage of this turn's main-session requests, by message id, in the order they started. */
  private requests = new Map<string, RequestUsage>();
  private model: string | undefined;
  sessionId: string | undefined;
  /** Ids of messages Pobots sent whose turn has not ended yet. */
  private pending = new Set<string>();
  /** The harness said it started one of our messages; the next init begins that turn. */
  private ownNext = false;
  /** The harness echoes the ids of messages it took up. Until it has, every turn counts as our own. */
  private echoes = false;
  /** Between a turn's init and its result. */
  private inTurn = false;
  /**
   * Steering (13 Nov 2026): messages pushed into the running turn and not yet taken up by a result, by
   * the uuid sent with them, to the engine's id. `steerStarted` holds those the harness said it began.
   */
  private steering = new Map<string, string>();
  private steerStarted = new Set<string>();
  /** Leftover steers the harness runs next by itself (see turn-end's `ahead`), uuid to the engine's id. */
  private aheadIds = new Map<string, string>();
  /**
   * The harness can take a Stop that also cancels what waits in its line (the init's capability
   * "interrupt_cancel_queued_v1"). Without it nothing is steered: a steer that waited there would run
   * after a Stop.
   */
  private cancelsQueued = false;

  constructor(settings: SessionSettings) {
    this.settings = settings;
  }

  get closed(): boolean {
    return this.closing;
  }

  start(): void {
    const s = this.settings;
    const permissionMode = PERMISSION_MODES[s.access];
    const gate = s.gate;
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const prefix = `mcp__${TOOL_SERVER}__`;
      const why = input.agent_id && input.tool_name.startsWith(prefix) && isLinkTool(input.tool_name.slice(prefix.length))
        ? "Only the main bot can use connections." : gate?.(input.tool_name, asLoose(input.tool_input));
      if (!why) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
    };
    const server = createSdkMcpServer({
      name: TOOL_SERVER,
      alwaysLoad: true,
      timeout: TOOL_TIMEOUT_MS,
      tools: s.tools.map((t) => tool(t.name, t.description, t.shape, (args, extra) => t.handler(args as Record<string, unknown>, signalOf(extra)))),
    });
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: s.botDir,
        pathToClaudeCodeExecutable: s.executable,
        // The harness's own to-do tools (TaskCreate, TaskUpdate, ...) are only offered with this on
        // current models (Claude Code 2.1.325); Pobots shows the list beside the chat (step 7a).
        env: { ...s.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
        model: s.model,
        effort: s.effort,
        permissionMode,
        // Needed so the bot can be moved to "Full access" without a restart.
        allowDangerouslySkipPermissions: true,
        // An interrupt ends the turn and spares helpers in the background, so a turn the harness began
        // in a session set aside can be ended without ending them; Stop asks each helper to stop
        // itself (engine 0.24.1, core/aside.ts and core/stop.ts).
        perTaskStopAffordance: true,
        canUseTool: s.canUseTool,
        settingSources: ["user", "project"],
        // Thinking comes as a short summary instead of empty (step 7a; T3 Code does the same). All the
        // current Claude models think adaptively.
        thinking: { type: "adaptive", display: "summarized" },
        // Without this only a helper's tool calls are forwarded, not what it says.
        forwardSubagentText: true,
        // snapshot: false, because by default Claude Code records the instructions AND the tool list
        // of a conversation on its first request and sends that record on every resume, whatever
        // this launch passes. Found on 15 Nov 2026 by a tester on the test copy: after an update a
        // bot that carried its chat on did not know its tools' new options, and a bot whose services
        // were switched off was never told so. Tried on Haiku 5.5 (docs/build/release-0.19-result.md):
        // with the record off, a resume with the same instructions and tools reads everything from
        // cache as before, and a resume with changed ones writes the conversation to the cache once.
        systemPrompt: { type: "preset", preset: "claude_code", append: s.systemAppend ?? systemPromptAppend(s.botName, s.team), snapshot: false },
        settings: {
          autoMemoryDirectory: join(s.botDir, "memory"),
          // Helpers started with the harness's own tool were 89% of all tokens over three days of
          // development (measured 14 Nov 2026, docs/decisions.md). Two causes, two settings:
          // their cache lasted 5 minutes while the bot's own lasts an hour, so every wait longer
          // than that (a long check) sent the helper's whole conversation again at the write price,
          // 102 times; and they never summarised, so a long worker carried up to 718 000 tokens on
          // every step. The size is the person's setting (ContextSettings.compactTokens); a helper
          // takes it over from its bot, and the summarising is Claude Code's own.
          subagentPromptCacheTtl: HELPER_CACHE,
          ...(s.compactTokens ? { autoCompactWindow: s.compactTokens } : {}),
          ...(s.rules.length ? { permissions: { allow: s.rules } } : {}),
          ...(s.sees ?? {}),
        },
        mcpServers: { [TOOL_SERVER]: server },
        // The bot's own tools never raise the harness's permission prompt; their gates are the engine's.
        allowedTools: s.tools.map((t) => toolId(t.name)),
        includePartialMessages: true,
        ...((gate || s.tools.some(t => isLinkTool(t.name))) ? { hooks: { PreToolUse: [{ hooks: [preToolUse] }] } } : {}),
        resume: s.resume,
        ...(s.disallowedTools?.length ? { disallowedTools: s.disallowedTools } : {}),
        ...(s.persist === false ? { persistSession: false } : {}),
        stderr: (data: string) => {
          for (const line of data.split(/\r?\n/)) if (line.trim()) this.stderrTail.push(line);
          if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
        },
      },
    });
    void this.consume(this.q);
  }

  private async consume(q: Query): Promise<void> {
    let error: string | undefined;
    try {
      for await (const msg of q) {
        try {
          this.handle(msg);
        } catch (err) {
          log.error(`Bot ${this.settings.botId}: could not handle a harness message`, err);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error || !this.closing) {
      log.warn(`Bot ${this.settings.botId}: the harness process ended${error ? ` with an error: ${error}` : ""}`);
      if (this.stderrTail.length) log.warn(`Bot ${this.settings.botId}: last harness output:\n  ${this.stderrTail.join("\n  ")}`);
    }
    this.closing = true;
    this.inbox.end();
    // Steers the harness had not taken up are not lost with it: they go back in line with the engine.
    const unread = [...this.steering.values()];
    this.steering.clear();
    if (unread.length) this.settings.onEvent({ type: "steer-returned", ids: unread });
    this.settings.onEvent({ type: "exit", error, beforeInit: !this.sawInit });
  }

  private emit(e: HarnessEvent): void {
    this.settings.onEvent(e);
  }

  private handle(msg: SDKMessage): void {
    log.debug(`Bot ${this.settings.botId}: harness message ${msg.type}${"subtype" in msg ? "/" + String(msg.subtype) : ""}`);
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          this.sawInit = true;
          this.inTurn = true;
          const caps = (msg as unknown as Loose).capabilities;
          this.cancelsQueued = Array.isArray(caps) && caps.includes("interrupt_cancel_queued_v1");
          this.sessionId = msg.session_id;
          this.model = msg.model;
          this.emit({ type: "session", sessionId: msg.session_id, model: msg.model });
          // Every turn of the harness begins with init, also one it begins by itself.
          const own = this.ownNext || !this.echoes;
          this.ownNext = false;
          this.emit({ type: "turn-start", own });
        } else if (msg.subtype === "task_started") {
          this.emit({
            type: "task-started",
            taskId: msg.task_id,
            ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
            ...(msg.task_type ? { taskType: msg.task_type } : {}),
            ...(typeof msg.is_backgrounded === "boolean" ? { background: msg.is_backgrounded } : {}),
            ...(msg.parent_task_id ? { parentTaskId: msg.parent_task_id } : {}),
            quiet: msg.skip_transcript === true || msg.ambient === true,
          });
        } else if (msg.subtype === "task_updated") {
          const p = msg.patch ?? {};
          this.emit({ type: "task-updated", taskId: msg.task_id, ...(typeof p.is_backgrounded === "boolean" ? { background: p.is_backgrounded } : {}), ...(p.status ? { status: p.status } : {}) });
        } else if (msg.subtype === "task_notification") {
          this.emit({ type: "task-ended", taskId: msg.task_id, ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}), status: msg.status, summary: msg.summary ?? "" });
        } else if (msg.subtype === "background_tasks_changed") {
          const tasks = msg.tasks ?? [];
          this.emit({
            type: "tasks-live",
            taskIds: tasks.map((t) => t.task_id),
            tasks: tasks.map((t) => ({
              taskId: t.task_id,
              ...(t.task_type ? { taskType: t.task_type } : {}),
              ...(t.parent_task_id ? { parentTaskId: t.parent_task_id } : {}),
              quiet: t.ambient === true,
            })),
          });
        } else if (msg.subtype === "compact_boundary") {
          const meta = msg.compact_metadata;
          this.emit({
            type: "compacted",
            trigger: meta.trigger,
            ...(typeof meta.pre_tokens === "number" ? { preTokens: meta.pre_tokens } : {}),
            ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
          });
        }
        return;
      }
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = asLoose(msg.event);
        const kind = ev.type;
        if (kind === "message_start") {
          const message = asLoose(ev.message);
          this.currentMessage = String(message.id ?? msg.uuid);
          this.noteUsage(this.currentMessage, message.usage);
          this.emit({ type: "thinking" });
        } else if (kind === "content_block_start") {
          const block = asLoose(ev.content_block);
          if (block.type === "text" && this.currentMessage) this.emit({ type: "text-start", key: this.currentMessage });
        } else if (kind === "content_block_delta") {
          const delta = asLoose(ev.delta);
          if (delta.type === "text_delta" && typeof delta.text === "string" && this.currentMessage) {
            this.emit({ type: "text-delta", key: this.currentMessage, text: delta.text });
          }
        } else if (kind === "message_delta") {
          if (this.currentMessage) this.noteUsage(this.currentMessage, ev.usage);
        } else if (kind === "message_stop") {
          if (this.currentMessage) this.emit({ type: "text-end", key: this.currentMessage });
          this.currentMessage = undefined;
        }
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) {
          this.handleHelperMessage(msg.parent_tool_use_id, asLoose(msg.message), msg.uuid);
          return;
        }
        const message = asLoose(msg.message);
        const key = String(message.id ?? msg.uuid);
        if (!msg.error) this.noteUsage(key, message.usage);
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        if (msg.error) {
          const text = content
            .map((b) => asLoose(b))
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("\n");
          this.emit({ type: "api-error", code: msg.error, text });
          return;
        }
        let thought = 0;
        for (const raw of content) {
          const b = asLoose(raw);
          // A thinking summary (asked for with display "summarized"); an empty one (omitted) is left out.
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) this.emit({ type: "thought", key: `${String(msg.uuid ?? key)}:${thought++}`, text: b.thinking.trim() });
          else if (b.type === "text" && typeof b.text === "string") this.emit({ type: "text-full", key, text: b.text });
          else if (b.type === "tool_use") {
            this.emit({ type: "tool-start", toolUseId: String(b.id), name: String(b.name), input: asLoose(b.input) });
          }
        }
        return;
      }
      case "user": {
        // A helper's first message (its task) and other text it was given are not needed: the task
        // is in the tool call that started it. Only its tool results matter.
        const parent = msg.parent_tool_use_id ?? undefined;
        const content = asLoose(msg.message).content;
        if (!Array.isArray(content)) return;
        const results = content.map((raw) => asLoose(raw)).filter((b) => b.type === "tool_result");
        // The structured result belongs to the message; it is only taken when the message answers one call.
        const structured = results.length === 1 ? (msg as unknown as Loose).tool_use_result : undefined;
        for (const b of results) {
          this.emit({
            type: "tool-end",
            toolUseId: String(b.tool_use_id),
            isError: b.is_error === true,
            ...(parent ? { parent } : {}),
            text: resultText(b.content),
            full: resultText(b.content, 20_000),
            ...(structured !== undefined ? { result: structured } : {}),
          });
        }
        return;
      }
      case "result": {
        this.sessionId = msg.session_id || this.sessionId;
        this.inTurn = false;
        const ids = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : msg.user_message_uuid ? [msg.user_message_uuid] : [];
        let own = !this.echoes;
        for (const id of ids) {
          if (this.pending.delete(id)) {
            own = true;
            this.echoes = true;
          }
          this.aheadIds.delete(id);
        }
        // Steers this turn took up are done. One it ended before taking up runs next, by itself, in a
        // turn of its own (seen with the real harness, 13 Nov 2026): from now on it is one of ours.
        const ahead: string[] = [];
        for (const [uuid, itemId] of this.steering) {
          if (ids.includes(uuid)) continue;
          ahead.push(itemId);
          this.pending.add(uuid);
          this.aheadIds.set(uuid, itemId);
          if (this.steerStarted.has(uuid)) this.ownNext = true;
        }
        this.steering.clear();
        this.steerStarted.clear();
        const errors = msg.subtype === "success" ? [] : msg.errors ?? [];
        const usage = this.turnUsage(msg.modelUsage);
        this.emit({
          type: "turn-end",
          ok: msg.subtype === "success" && !msg.is_error,
          subtype: msg.subtype,
          errors,
          sessionId: msg.session_id,
          ...(usage ? { usage } : {}),
          own,
          ...(ahead.length ? { ahead } : {}),
        });
        return;
      }
      default: {
        // Not in the SDK's message types yet: the harness says when it queues, starts, completes or cancels a message we sent.
        const loose = msg as unknown as Loose;
        if (loose.type !== "command_lifecycle" || typeof loose.command_uuid !== "string") return;
        const uuid = loose.command_uuid;
        if (loose.state === "started") {
          // A steer the running turn takes in at its next step: it starts no turn.
          if (this.steering.has(uuid)) this.steerStarted.add(uuid);
          else if (this.pending.has(uuid)) {
            this.ownNext = true;
            this.echoes = true;
          }
        } else if (loose.state === "cancelled") {
          // A Stop took a steer out of the harness's line before it was read: it goes back in line with the engine.
          const itemId = this.steering.get(uuid) ?? this.aheadIds.get(uuid);
          if (itemId === undefined) return;
          this.steering.delete(uuid);
          this.steerStarted.delete(uuid);
          this.aheadIds.delete(uuid);
          this.pending.delete(uuid);
          this.emit({ type: "steer-returned", ids: [itemId] });
        }
        return;
      }
    }
  }

  /** What a helper said or did, forwarded whole with the id of the tool call that started it. */
  private handleHelperMessage(parent: string, message: Loose, uuid: string): void {
    const key = String(message.id ?? uuid);
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    for (const raw of content) {
      const b = asLoose(raw);
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) this.emit({ type: "text-full", key, text: b.text, parent });
      else if (b.type === "tool_use") this.emit({ type: "tool-start", toolUseId: String(b.id), name: String(b.name), input: asLoose(b.input), parent });
    }
  }

  /**
   * Keeps the usage a request reports. The stream's message_start carries the input and cache
   * fields, message_delta the output so far, and the assistant messages the same again; the largest
   * value seen for each field wins, so the order does not matter.
   */
  private noteUsage(id: string, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const u = raw as Loose;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const split = asLoose(u.cache_creation);
    const prev = this.requests.get(id);
    const next: RequestUsage = {
      input: Math.max(prev?.input ?? 0, n(u.input_tokens)),
      cacheRead: Math.max(prev?.cacheRead ?? 0, n(u.cache_read_input_tokens)),
      cacheWrite: Math.max(prev?.cacheWrite ?? 0, n(u.cache_creation_input_tokens)),
      write5m: Math.max(prev?.write5m ?? 0, n(split.ephemeral_5m_input_tokens)),
      write1h: Math.max(prev?.write1h ?? 0, n(split.ephemeral_1h_input_tokens)),
      output: Math.max(prev?.output ?? 0, n(u.output_tokens)),
      startedAt: prev?.startedAt ?? Date.now(),
    };
    this.requests.set(id, next);
  }

  /** Sums up the turn's requests and forgets them. Undefined when the turn sent nothing to the model. */
  private turnUsage(modelUsage: unknown): TurnUsage | undefined {
    const reqs = [...this.requests.values()];
    this.requests.clear();
    const last = reqs.at(-1);
    if (!last) return undefined;
    let cache: TurnUsage["cache"];
    for (const r of reqs) {
      if (r.write5m > 0) cache = "5m";
      else if (r.write1h > 0) cache = "1h";
    }
    return {
      requests: reqs.length,
      last: { input: last.input, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite, output: last.output },
      turn: {
        cacheRead: reqs.reduce((a, r) => a + r.cacheRead, 0),
        cacheWrite: reqs.reduce((a, r) => a + r.cacheWrite, 0),
        write5m: reqs.reduce((a, r) => a + r.write5m, 0),
        write1h: reqs.reduce((a, r) => a + r.write1h, 0),
      },
      ...(cache ? { cache } : {}),
      ...windowOf(modelUsage, this.model ?? this.settings.model),
      lastSentAgoMs: Math.max(0, Date.now() - last.startedAt),
    };
  }

  /**
   * Hands the harness one user message. Extra text blocks (a handoff) go before it. Pictures
   * (`o.pictures`, the engine's copies made for the model) go as image blocks right before the
   * message's own text. A picture that cannot be read is left out; it never stops the message.
   */
  send(text: string, before: string[] = [], o: { tidy?: boolean; pictures?: { path: string; type: string }[] } = {}): void {
    // The id comes back on the turn that takes the message up, which tells our turns from the harness's own.
    const uuid = randomUUID();
    this.pending.add(uuid);
    this.inbox.push({
      type: "user",
      message: { role: "user", content: this.blocks(text, before, o.pictures) },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
  }

  /** A message's content: extra text blocks first, then the pictures, then its own text; plain text when that is all. */
  private blocks(text: string, before: string[], pictures: { path: string; type: string }[] = []): SDKUserMessage["message"]["content"] {
    const images: { type: "image"; source: { type: "base64"; media_type: string; data: string } }[] = [];
    for (const p of pictures) {
      if (!CLAUDE_IMAGE_TYPES.has(p.type)) continue;
      try {
        images.push({ type: "image", source: { type: "base64", media_type: p.type, data: readFileSync(p.path).toString("base64") } });
      } catch (err) {
        log.warn(`Bot ${this.settings.botId}: a picture could not be read for the message`, err);
      }
    }
    const blocks = [...before.map((t) => ({ type: "text" as const, text: t })), ...images, { type: "text" as const, text }];
    return (blocks.length === 1 ? text : blocks) as SDKUserMessage["message"]["content"];
  }

  /**
   * Steering (13 Nov 2026): puts one message from the person into the running turn. It goes with
   * priority "next": the harness takes it in at the turn's next step, after the tool call it is in,
   * without stopping anything (tried with the real harness: the turn goes on and its one result lists
   * both messages). T3 Code sends "now", which cuts the running step short and ends the turn early
   * with a result of its own; Pobots counts one result as one turn, so it takes "next". `id` is the
   * engine's id for the message. False when no turn of the harness runs now, or the harness cannot
   * cancel what waits in its line at a Stop: the engine then lets the message wait in line instead.
   */
  async steer(text: string, o: { id: string; pictures?: { path: string; type: string }[] }): Promise<boolean> {
    if (this.closing || !this.q || !this.inTurn || !this.cancelsQueued) return false;
    const uuid = randomUUID();
    this.steering.set(uuid, o.id);
    this.inbox.push({
      type: "user",
      message: { role: "user", content: this.blocks(text, [], o.pictures) },
      parent_tool_use_id: null,
      uuid,
      priority: "next",
    } as SDKUserMessage);
    return true;
  }

  /** Stops one task of the harness, such as a helper. The harness confirms with a task notification. */
  async stopTask(taskId: string): Promise<void> {
    await this.q?.stopTask(taskId);
  }

  /**
   * Stops the turn. While steers wait in the harness's line it also cancels what waits there (the
   * SDK's `cancelQueued`, which its typings do not list yet), so they do not run after the Stop: they
   * go back to the engine, which holds them. Without steers it is the plain interrupt it always was.
   */
  async interrupt(): Promise<void> {
    const q = this.q as (Query & { interrupt(o?: { cancelQueued?: boolean }): Promise<{ cancelled?: string[] } | undefined> }) | undefined;
    const steers = this.steering.size > 0 || this.aheadIds.size > 0;
    const receipt = await (steers ? q?.interrupt({ cancelQueued: true }) : q?.interrupt());
    const back: string[] = [];
    for (const uuid of receipt?.cancelled ?? []) {
      const itemId = this.steering.get(uuid) ?? this.aheadIds.get(uuid);
      if (itemId === undefined) continue;
      this.steering.delete(uuid);
      this.steerStarted.delete(uuid);
      this.aheadIds.delete(uuid);
      this.pending.delete(uuid);
      back.push(itemId);
    }
    if (back.length) this.emit({ type: "steer-returned", ids: back });
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
  }

  async setEffort(effort: Effort): Promise<void> {
    await this.q?.applyFlagSettings({ effortLevel: effort });
  }

  async setAccess(access: AccessLevel): Promise<void> {
    await this.q?.setPermissionMode(PERMISSION_MODES[access]);
  }

  /** Claude has no fast mode (step 3b): taken and ignored. */
  async setFast(_fast: boolean): Promise<void> {}

  async supportedModels() {
    return this.q ? await this.q.supportedModels() : [];
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.inbox.end();
    try {
      this.q?.close();
    } catch (err) {
      log.debug("Closing the harness failed", err);
    }
  }
}
