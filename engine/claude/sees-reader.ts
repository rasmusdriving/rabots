// Reading what exists for a bot's folder (docs/sees.md): a short Claude session that is never given a
// message (so nothing reaches a model) and saves nothing, set up like a bot's session but with none of
// the bot's choice applied. It reports its services and its context breakdown, then stops. The hub
// keeps the result per bot for some minutes, shares one read between requests that come together,
// and remembers the last good read, so a bot whose choice says "the rest: off" knows what "the rest" is.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotSees, SeesInventory } from "../../shared/protocol.js";
import { log } from "../log.js";
import { buildInventory, seesNeedsNames, type RawSees } from "./sees.js";

export interface SeesReadOptions {
  cwd: string;
  executable: string;
  /** The harness's environment. Holds env file values: never log it. */
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Reads what exists. Tests pass a fake, as they pass `createSession`. */
export type SeesReader = (o: SeesReadOptions) => Promise<RawSees>;

const READ_TIMEOUT_MS = 45_000;
/** How long services may take to connect before the read takes what it has. */
const SETTLE_MS = 20_000;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The real reader: Claude Code on this Mac, no message, `persistSession: false`. */
export const readSeesWithClaude: SeesReader = async (o) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? READ_TIMEOUT_MS);
  const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Claude Code did not answer in time.")), { once: true }));
  stopped.catch(() => undefined);
  try {
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
    const q = query({
      prompt,
      options: {
        cwd: o.cwd,
        pathToClaudeCodeExecutable: o.executable,
        env: { ...o.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
        abortController: abort,
        persistSession: false,
        settingSources: ["user", "project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        stderr: () => {},
      },
    });
    await Promise.race([q.initializationResult(), stopped]);
    const t0 = Date.now();
    let servers: unknown[] = [];
    for (;;) {
      servers = await Promise.race([q.mcpServerStatus(), stopped]);
      if (!servers.some((s) => (s as { status?: string }).status === "pending") || Date.now() - t0 > SETTLE_MS) break;
      await Promise.race([pause(500), stopped]);
    }
    const usage = await Promise.race([q.getContextUsage(), stopped]);
    return { servers, usage };
  } finally {
    clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
  }
};

/** Used when the engine runs with stand-in sessions and no reader was given: never a real Claude in a test. */
export const noReader: SeesReader = async () => {
  throw new Error("No reader in this engine.");
};

export interface SeesHubOptions {
  read: SeesReader;
  /** The harness as the engine knows it now (it can change after an update). */
  claude: () => { executable?: string; env: Record<string, string | undefined> };
  ttlMs?: number;
  clock?: () => number;
}

/** How long a read is kept before the window's next open reads again. */
export const SEES_TTL_MS = 5 * 60_000;

const FAILED = "What this bot can see could not be read just now. Try again in a moment.";

export class SeesHub {
  private kept = new Map<string, { inventory: SeesInventory; at: number }>();
  private reading = new Map<string, Promise<SeesInventory>>();
  /** When a read before a session last failed: not tried again before a session for a while. */
  private failedAt = new Map<string, number>();

  private readonly o: SeesHubOptions;

  constructor(o: SeesHubOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  /** One read for a bot, shared by every request that comes while it runs. */
  private read(botId: string, cwd: string): Promise<SeesInventory> {
    const running = this.reading.get(botId);
    if (running) return running;
    const c = this.o.claude();
    const p = this.o
      .read({ cwd, executable: c.executable ?? "claude", env: c.env })
      .then((raw) => {
        const inventory = buildInventory(raw, new Date(this.now()).toISOString());
        this.kept.set(botId, { inventory, at: this.now() });
        this.failedAt.delete(botId);
        return inventory;
      })
      .finally(() => this.reading.delete(botId));
    this.reading.set(botId, p);
    return p;
  }

  /** For the window: a kept read while it is fresh, else a new one. A failed read is a sentence, never a throw. */
  async inventory(botId: string, cwd: string, refresh = false): Promise<{ inventory: SeesInventory | null; problem?: string }> {
    const k = this.kept.get(botId);
    if (k && !refresh && this.now() - k.at < (this.o.ttlMs ?? SEES_TTL_MS)) return { inventory: k.inventory };
    try {
      return { inventory: await this.read(botId, cwd) };
    } catch (err) {
      log.warn(`Bot ${botId}: could not read what it can see: ${err instanceof Error ? err.message : String(err)}`);
      return { inventory: this.kept.get(botId)?.inventory ?? null, problem: FAILED };
    }
  }

  /** The last good read for a bot, however old, or undefined. */
  known(botId: string): SeesInventory | undefined {
    return this.kept.get(botId)?.inventory;
  }

  /**
   * Before a bot's session starts (rule 6): when its choice needs the names of everything and none
   * were read since the engine started, read them now. A failure is logged and the session goes on.
   */
  async ensureKnown(botId: string, cwd: string, sees: BotSees | undefined): Promise<SeesInventory | undefined> {
    const k = this.known(botId);
    if (k || !seesNeedsNames(sees)) return k;
    const failed = this.failedAt.get(botId);
    if (failed !== undefined && this.now() - failed < (this.o.ttlMs ?? SEES_TTL_MS)) return undefined;
    try {
      return await this.read(botId, cwd);
    } catch (err) {
      this.failedAt.set(botId, this.now());
      log.warn(`Bot ${botId}: could not read what exists before its session, so only the choice's own exceptions apply: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  forget(botId: string): void {
    this.kept.delete(botId);
  }
}
