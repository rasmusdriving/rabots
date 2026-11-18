// Shared pieces for the step 3a tests: the fake app-server (fake-codex.mjs), a CodexSetup that runs
// it, a CodexSession on it, and an engine whose GPT bots run on it. No model, no real Codex.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AccessLevel, Effort } from "../../shared/protocol.js";
import type { BotTool, HarnessEvent, SessionSettings } from "../claude/session.js";
import type { CodexSetup } from "../codex/detect.js";
import { mapAllCodexModels, newestPerCodexFamily } from "../codex/models.js";
import { CodexSession } from "../codex/session.js";
import { Engine, type EngineOptions } from "../engine.js";
import { Store } from "../store.js";
import { FakeSession, type Ev } from "./fake.js";
import { after } from "node:test";
import { tempDir } from "./helpers.js";

/** Every Codex session a test made is closed at the end, also when the test failed, so no fake process is left. */
const opened: { close(): void }[] = [];
after(() => {
  for (const s of opened.splice(0)) s.close();
});

export const FAKE_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));

const fastTier = (description: string) => ({ serviceTiers: [{ id: "priority", name: "Fast", description }], additionalSpeedTiers: ["fast"] });

/**
 * Every model the fake lists, as Pobots reads them (step 3b): Sol, Terra and Luna have a fast mode,
 * Astra has none, and the older GPT-5.6 Luna says it only in the older field.
 */
export const FAKE_ALL_MODELS = mapAllCodexModels([
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "high", ...fastTier("2x speed, increased usage") },
  { id: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "medium", ...fastTier("1.5x speed") },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna", supportedReasoningEfforts: ["low", "medium", "high"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "low", ...fastTier("1.5x speed") },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", additionalSpeedTiers: ["fast"] },
  { id: "gpt-6-astra", displayName: "GPT-6 Astra", supportedReasoningEfforts: ["low", "medium"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "medium", serviceTiers: [] },
]);
/** The models the fake lists, as Pobots offers them. */
export const FAKE_MODELS = newestPerCodexFamily(FAKE_ALL_MODELS);

/** A folder for the fake's state and log, and the setup that runs it. */
export function fakeCodex(extraEnv: Record<string, string> = {}) {
  const dir = tempDir("pobots-fake-codex-");
  const state = join(dir, "state.json");
  const logFile = join(dir, "log.jsonl");
  const setup: CodexSetup = {
    ready: true,
    executable: process.execPath,
    args: [FAKE_CODEX],
    version: "0.165.0",
    env: { ...process.env, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: logFile, ...extraEnv },
    models: FAKE_MODELS,
    allModels: FAKE_ALL_MODELS,
  };
  /** What the fake received and sent, oldest first. */
  const messages = (): { dir: string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }[] =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const received = (method: string) => messages().filter((m) => m.dir === "in" && m.method === method).map((m) => m.params ?? {});
  const threads = (): Record<string, { archived?: boolean; deleted?: boolean; tools?: unknown[] }> => {
    const out: Record<string, { archived?: boolean; deleted?: boolean; tools?: unknown[] }> = {};
    const d = `${state}.d`;
    if (!existsSync(d)) return out;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        out[name.slice(0, -5)] = JSON.parse(readFileSync(join(d, name), "utf8"));
      } catch {
        // being replaced right now
      }
    }
    return out;
  };
  return { setup, dir, messages, received, threads };
}

export async function waitFor(cond: () => boolean, ms = 5000, what = "a condition"): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A CodexSession on the fake, with its events collected. */
export function codexSession(
  setup: CodexSetup,
  o: {
    botDir?: string;
    access?: AccessLevel;
    model?: string;
    effort?: Effort;
    tools?: BotTool[];
    resume?: string;
    ephemeral?: boolean;
    fast?: boolean;
    canUseTool?: SessionSettings["canUseTool"];
    gate?: SessionSettings["gate"];
  } = {},
) {
  const events: HarnessEvent[] = [];
  const asked: { name: string; input: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const settings: SessionSettings = {
    botId: "kaja",
    botName: "Kaja",
    botDir: o.botDir ?? tempDir("pobots-codex-bot-"),
    model: o.model ?? "gpt-6-luna",
    effort: o.effort ?? "low",
    access: o.access ?? "asks-first",
    executable: setup.executable!,
    args: setup.args,
    env: setup.env,
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.ephemeral ? { ephemeral: true } : {}),
    ...(o.fast !== undefined ? { fast: o.fast } : {}),
    tools: o.tools ?? [],
    rules: [],
    team: "",
    systemAppend: "You are Kaja, a test bot.",
    canUseTool: async (name, input, options) => {
      asked.push({ name, input, options: options as unknown as Record<string, unknown> });
      return o.canUseTool ? o.canUseTool(name, input, options) : ({ behavior: "allow", updatedInput: input } as PermissionResult);
    },
    ...(o.gate ? { gate: o.gate } : {}),
    onEvent: (e) => events.push(e),
  };
  const session = new CodexSession(settings);
  opened.push(session);
  const ended = () => events.filter((e) => e.type === "turn-end").length;
  /** Sends a message and waits for its turn to end. */
  const turn = async (text: string, opts?: { tidy?: boolean }) => {
    const before = ended();
    session.send(text, [], opts);
    await waitFor(() => ended() > before, 8000, `the end of the turn for "${text.slice(0, 40)}"`);
    return events.filter((e) => e.type === "turn-end").at(-1) as Extract<HarnessEvent, { type: "turn-end" }>;
  };
  const texts = () => {
    const out = new Map<string, string>();
    for (const e of events) {
      if (e.type === "text-delta") out.set(e.key, (out.get(e.key) ?? "") + e.text);
      if (e.type === "text-full") out.set(e.key, e.text);
    }
    return [...out.values()];
  };
  return { session, settings, events, asked, turn, texts };
}

/** An engine whose Claude bots run on FakeSession and whose GPT bots run on CodexSession and the fake. */
export function codexWorld(
  o: {
    dirs?: { dataDir: string; botsDir: string };
    codex?: ReturnType<typeof fakeCodex>;
    ready?: boolean;
    timings?: EngineOptions["timings"];
    /** Lists Codex's MCP servers for a helper (step helper-sees). Left out: none, Codex is not asked. */
    listCodexMcp?: EngineOptions["listCodexMcp"];
    /** What makes a title with a Claude model (step gpt-titles). Left out: none comes back. */
    titleMaker?: EngineOptions["titleMaker"];
    /** Claude helpers started with start_helper also run on FakeSession. */
  } = {},
) {
  const root = o.dirs ?? { dataDir: tempDir(), botsDir: tempDir() };
  const codex = o.codex ?? fakeCodex();
  const store = new Store(join(root.dataDir, "pobots.db"));
  const events: Ev[] = [];
  const sessions: FakeSession[] = [];
  const codexSessions: CodexSession[] = [];
  let setup: CodexSetup = o.ready === false ? { ready: false, problem: "Codex is not signed in. Run codex login in a terminal on the Mac.", env: {}, models: [] } : codex.setup;
  const engine = new Engine({
    config: { port: 0, dataDir: root.dataDir, botsDir: root.botsDir, machineName: "Test Mac", claude: {}, serve: false, remote: { allowedLogins: [] } },
    store,
    claude: { ready: true, executable: "/fake/claude", version: "9.9.9", env: {} },
    emit: (event, data) => events.push({ event, data }),
    createSession: (s, harness) => {
      if (harness === "codex") {
        const c = new CodexSession(s);
        codexSessions.push(c);
        opened.push(c);
        return c;
      }
      const f = new FakeSession(s);
      sessions.push(f);
      return f;
    },
    sessionExists: async (id, _dir, harness) => (harness === "codex" ? !!codex.threads()[id] && !codex.threads()[id]!.deleted : true),
    checkCodex: async () => setup,
    timings: { wakeGraceMs: 5, helperStopMs: 200, helperNudgeMs: 10, liveCheckMs: 20, ...o.timings },
    browser: null,
    // Step 7b: no network, no programs, no model calls.
    settingsHub: { fetcher: async () => ({ ok: false, status: 404, text: async () => "" }), runner: async () => ({ ok: false, out: "" }) },
    titleMaker: o.titleMaker ?? (async () => undefined),
    ...(o.listCodexMcp ? { listCodexMcp: o.listCodexMcp } : {}),
  });
  engine.init();
  return {
    engine,
    store,
    events,
    sessions,
    codexSessions,
    codex,
    dirs: root,
    setReady(ready: boolean) {
      setup = ready ? codex.setup : { ready: false, problem: "Codex is not signed in. Run codex login in a terminal on the Mac.", env: {}, models: [] };
    },
  };
}
