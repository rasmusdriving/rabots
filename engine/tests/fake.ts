// A stand-in harness and an engine on temporary folders, shared by the engine tests. No model.
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { EventName, Events } from "../../shared/protocol.js";
import type { HarnessEvent, SessionSettings, ToolResult, TurnUsage } from "../claude/session.js";
import type { BackupConfig, ContextSettings, NotifyConfig } from "../config.js";
import { Engine, type EngineOptions, type HarnessSession } from "../engine.js";
import { Store } from "../store.js";
import { tempDir } from "./helpers.js";

export class FakeSession implements HarnessSession {
  closed = false;
  started = false;
  sent: { text: string; before: string[]; pictures?: { path: string; type: string }[] }[] = [];
  interrupts = 0;
  changes: string[] = [];
  readonly settings: SessionSettings;
  constructor(settings: SessionSettings) {
    this.settings = settings;
  }
  start() {
    this.started = true;
  }
  send(text: string, before: string[] = [], o: { pictures?: { path: string; type: string }[] } = {}) {
    this.sent.push({ text, before, ...(o.pictures ? { pictures: o.pictures } : {}) });
  }
  async interrupt() {
    this.interrupts++;
  }
  stopped: string[] = [];
  async stopTask(taskId: string) {
    this.stopped.push(taskId);
  }
  async setModel(m: string) {
    this.changes.push(`model:${m}`);
  }
  async setEffort(e: string) {
    this.changes.push(`effort:${e}`);
  }
  async setAccess(a: string) {
    this.changes.push(`access:${a}`);
  }
  async setFast(f: boolean) {
    this.changes.push(`fast:${f}`);
  }
  async supportedModels() {
    return [];
  }
  close() {
    this.closed = true;
  }
  emit(e: HarnessEvent) {
    this.settings.onEvent(e);
  }
  /** A whole short turn: session id, streamed text, result (with usage, when given). */
  reply(text: string, sessionId = "sess-1", usage?: TurnUsage) {
    this.emit({ type: "session", sessionId });
    this.emit({ type: "thinking" });
    this.emit({ type: "text-start", key: "m1" });
    for (const part of text.match(/[\s\S]{1,3}/g) ?? []) this.emit({ type: "text-delta", key: "m1", text: part });
    this.emit({ type: "text-full", key: "m1", text });
    this.emit({ type: "text-end", key: "m1" });
    this.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId, ...(usage ? { usage } : {}) });
  }
  // ------------------------------------------------------------ helpers, the way the real harness sends them (step 2e notes)

  /**
   * The bot (or the helper `parent`) calls the helper tool. A helper the caller waits for gets
   * task-started with background false; one in the background also gets its quick tool result.
   */
  helperStart(id: string, o: { description?: string; prompt?: string; background?: boolean; parent?: string; taskId?: string; alsoLive?: string[] } = {}) {
    const background = o.background ?? false;
    const taskId = o.taskId ?? `task-${id}`;
    const input: Record<string, unknown> = { prompt: o.prompt ?? "Read notes.txt and report the word in it.", run_in_background: background };
    if (o.description !== undefined) input.description = o.description;
    this.emit({ type: "tool-start", toolUseId: id, name: "Agent", input, ...(o.parent ? { parent: o.parent } : {}) });
    // The harness's list is whole: it names every task still in the background, so a test with an
    // earlier helper still working passes it in `alsoLive` (a list without it would end that helper
    // after the live check's moment, as the engine rightly does for one the harness dropped).
    if (background) this.emit({ type: "tasks-live", taskIds: [...(o.alsoLive ?? []), taskId] });
    this.emit({ type: "task-started", taskId, toolUseId: id, taskType: "local_agent", background, quiet: false, ...(o.parent ? { parentTaskId: `task-${o.parent}` } : {}) });
    if (background) {
      this.emit({ type: "tool-end", toolUseId: id, isError: false, text: "Async agent launched successfully.", ...(o.parent ? { parent: o.parent } : {}) });
    }
  }
  /** The helper says something (whole, never streamed). */
  helperSay(id: string, text: string, key = `hm-${Math.random()}`) {
    this.emit({ type: "text-full", key, text, parent: id });
  }
  /** The helper calls a tool and gets its result. */
  helperTool(id: string, name: string, input: Record<string, unknown>, o: { end?: boolean; isError?: boolean; toolUseId?: string } = {}) {
    const tu = o.toolUseId ?? `ht-${Math.random()}`;
    this.emit({ type: "tool-start", toolUseId: tu, name, input, parent: id });
    if (o.end !== false) this.emit({ type: "tool-end", toolUseId: tu, isError: o.isError ?? false, parent: id, text: "ok" });
    return tu;
  }
  /**
   * The helper ends. The harness sends the task notice first; for a helper the caller waited for,
   * the tool result follows. `parent` is the helper that started it, for one started by a helper.
   */
  helperEnd(id: string, status: "completed" | "failed" | "stopped" = "completed", summary = "", o: { background?: boolean; parent?: string; taskId?: string } = {}) {
    const taskId = o.taskId ?? `task-${id}`;
    this.emit({ type: "task-updated", taskId, status: status === "stopped" ? "killed" : status });
    this.emit({ type: "task-ended", taskId, toolUseId: id, status, summary });
    if (o.background) this.emit({ type: "tasks-live", taskIds: [] });
    else this.emit({ type: "tool-end", toolUseId: id, isError: status !== "completed", text: summary, ...(o.parent ? { parent: o.parent } : {}) });
  }
  /** A turn the harness begins by itself (it starts with init, which says it took up no message of ours). */
  wake(text: string, sessionId = "sess-1", usage?: TurnUsage) {
    this.emit({ type: "session", sessionId });
    this.emit({ type: "turn-start", own: false });
    this.emit({ type: "thinking" });
    this.emit({ type: "text-start", key: "w1" });
    this.emit({ type: "text-delta", key: "w1", text });
    this.emit({ type: "text-full", key: "w1", text });
    this.emit({ type: "text-end", key: "w1" });
    this.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId, own: false, ...(usage ? { usage } : {}) });
  }

  /** Calls one of the bot's own tools, as the harness would. */
  tool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ToolResult> {
    const t = this.settings.tools.find((x) => x.name === name);
    if (!t) throw new Error(`The bot has no tool ${name}`);
    return t.handler(args, signal);
  }
  toolNames(): string[] {
    return this.settings.tools.map((t) => t.name);
  }
  ask(name: string, input: Record<string, unknown>, suggestions?: unknown[]): Promise<PermissionResult | null> {
    const controller = new AbortController();
    return this.settings.canUseTool(name, input, {
      signal: controller.signal,
      toolUseID: "tu-" + Math.random(),
      requestId: "r",
      ...(suggestions ? { suggestions: suggestions as never } : {}),
    });
  }
}

/** Usage of a turn whose last request makes the session `tokens` big. */
export function usage(tokens: number, o: { cache?: "5m" | "1h"; window?: number; agoMs?: number } = {}): TurnUsage {
  const cache = o.cache ?? "1h";
  return {
    requests: 1,
    last: { input: 10, cacheRead: tokens - 110, cacheWrite: 50, output: 50 },
    turn: { cacheRead: tokens - 110, cacheWrite: 50, write5m: cache === "5m" ? 50 : 0, write1h: cache === "1h" ? 50 : 0 },
    cache,
    window: o.window ?? 200_000,
    lastSentAgoMs: o.agoMs ?? 0,
  };
}

export type Ev = { event: EventName; data: Events[EventName] };

export function setup(
  dirs?: { dataDir: string; botsDir: string },
  sessionExists: (id: string) => boolean = () => true,
  timings?: EngineOptions["timings"],
  extra: Pick<EngineOptions, "readSees" | "clock" | "links" | "timeZone" | "browser" | "browserTimings" | "backup" | "notify" | "settingsHub" | "titleMaker" | "titleTimings" | "checkClaude" | "checkCodex" | "selfUpdate"> & { settingsFile?: import("../settings.js").SettingsFile; context?: ContextSettings; fullText?: boolean; claudeReady?: boolean; backupConfig?: BackupConfig; notifyConfig?: NotifyConfig } = {},
) {
  const root = dirs ?? { dataDir: tempDir(), botsDir: tempDir() };
  const { context, fullText, claudeReady, backupConfig, notifyConfig, settingsFile, ...rest } = extra;
  const store = new Store(join(root.dataDir, "pobots.db"), fullText === false ? { fullText: false } : {});
  const events: Ev[] = [];
  const sessions: FakeSession[] = [];
  const engine = new Engine({
    config: { port: 0, dataDir: root.dataDir, botsDir: root.botsDir, machineName: "Test Mac", claude: {}, serve: false, remote: { allowedLogins: [] }, ...(context ? { context } : {}), ...(backupConfig ? { backup: backupConfig } : {}), ...(notifyConfig ? { notify: notifyConfig } : {}), ...(settingsFile ? { settings: settingsFile } : {}) },
    store,
    claude: claudeReady === false ? { ready: false, problem: "Claude is not installed.", env: {} } : { ready: true, executable: "/fake/claude", version: "9.9.9", env: {} },
    emit: (event, data) => events.push({ event, data }),
    createSession: (s) => {
      const f = new FakeSession(s);
      sessions.push(f);
      return f;
    },
    sessionExists: async (id) => sessionExists(id),
    timings,
    // Step 7b: no test reaches the network, runs a program or calls a model unless it brings its own stand-in.
    settingsHub: { fetcher: async () => ({ ok: false, status: 404, text: async () => "" }), runner: async () => ({ ok: false, out: "" }), readClaude: async () => ({ id: "c", via: "This Mac", windows: [] }), readCodex: async () => ({ id: "x", via: "This Mac", windows: [] }) },
    titleMaker: async () => undefined,
    // The old-chat title backfill waits 2 minutes; a test engine closed without shutdown would then read a
    // closed store and fail a whole run that lasts longer than that. Tests that check it bring their own.
    titleTimings: { backfillStartMs: 1e9 },
    ...rest,
    // The real browser is never used by these tests: off unless a test brings a stand-in.
    browser: rest.browser ?? null,
  });
  engine.init();
  return { engine, store, events, sessions, dirs: root };
}

export const tick = () => new Promise((r) => setImmediate(r));
export async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}
export const upserts = (events: Ev[]) => events.filter((e) => e.event === "item.upsert").map((e) => (e.data as Events["item.upsert"]).item);
/**
 * The quiet lines about changes in one chat, as the person reads them (core/notes.ts): plain notices,
 * without a mark, not the lines about a stop or a turn cut short.
 */
export const changeLines = (events: Ev[], threadId: string): string[] =>
  upserts(events)
    .filter((i) => i.kind === "notice" && i.threadId === threadId && i.tone === "info" && !i.mark && !/cut short|^Stopped|^Allowed|^Denied/.test(i.text))
    .map((i) => (i as { text: string }).text);
/** Note cards put up: nothing about a change should be one any more. */
export const noteCards = (events: Ev[]) => events.filter((e) => e.event === "card.added" && (e.data as Events["card.added"]).card.kind === "note");
export const lastState = (events: Ev[], botId: string) =>
  events
    .filter((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === botId)
    .map((e) => (e.data as Events["bot.updated"]).bot)
    .at(-1);

