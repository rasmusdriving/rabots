// Shortening on request (docs/build/step-workers.md, part 3): a Claude worker started with
// start_helper asks, with a tool of its own, to have its conversation summarised between two jobs.
//
// A tool call cannot summarise the conversation it runs in. So the tool only notes what to keep and
// what comes next, and tells the worker to end its step. When the worker's turn ends with a request
// noted, that turn is not the worker's result: the engine sends Claude Code "/compact" with what to
// keep, waits for its compact_boundary, and then tells the worker to carry on, with its own `next`
// and `keep` again (the summary may have dropped them). Only a turn that ends with no request noted
// is the worker's result. Tried by hand first (docs/build/speed-result.md, "Summarising on request").
//
// Nothing here can hang a worker: a summary that does not end within SHORTEN_WAIT_MS is stopped and
// the worker carries on as it is; one that does not even stop within SHORTEN_STUCK_MS more ends the
// worker as failed, so the bot's call always comes back.
import { z } from "zod";
import type { BotTool, ToolResult } from "./claude/session.js";
import { SHORTEN_TOOL } from "./workers.js";

/** How long Claude Code may take to summarise a worker (tried: 4 seconds for 117,000 tokens) before it carries on as it is. */
export const SHORTEN_WAIT_MS = 5 * 60_000;
/** After that, how long the stopped summary may take to end before the worker counts as stuck and fails. */
export const SHORTEN_STUCK_MS = 60_000;
/**
 * The guard against asking again and again: a worker that asks with fewer steps of work (tool calls)
 * than this since it was last shortened has nothing new to drop. It is told so and not shortened.
 */
export const SHORTEN_MIN_STEPS = 3;
/** After this many summaries that did not work, the worker is told to go on without asking again. */
export const SHORTEN_MAX_FAILURES = 2;
/** The task is given again after a shortening when it is at most this long; a longer one stays in the summary. */
const TASK_AGAIN_MAX = 4000;

export interface ShortenHost {
  /** Hands the worker's session a message: "/compact ..." or the word to carry on. */
  send(text: string, carryOn: boolean): void;
  /** Stops the summary that takes too long. */
  interrupt(): void;
  /** A quiet line in the worker's thread. */
  line(text: string): void;
  /** What the worker's row says it is doing. */
  status(text: string): void;
  /** The worker did not come back: it ends as failed, with this for the bot. */
  fail(why: string): void;
}

const num = (n: number) => n.toLocaleString("en-US");
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export class Shortener {
  private asked?: { keep: string; next: string };
  private phase: "work" | "summarising" | "stopping" = "work";
  private timer?: NodeJS.Timeout;
  private boundary?: { pre?: number; post?: number };
  private why?: string;
  /** Steps of work since the last summary was tried. */
  private steps = 0;
  /** A summary was tried before (whether it worked or not). */
  private tried = false;
  /** How many summaries did not work. */
  private failures = 0;
  /** How many times the worker was shortened on request. */
  count = 0;
  private lastWorked = false;

  private readonly host: ShortenHost;
  private readonly task: string;
  private readonly waitMs: number;
  private readonly stuckMs: number;

  constructor(host: ShortenHost, task: string, waitMs = SHORTEN_WAIT_MS, stuckMs = SHORTEN_STUCK_MS) {
    this.host = host;
    this.task = task;
    this.waitMs = waitMs;
    this.stuckMs = stuckMs;
  }

  /** True while a summary runs: the turn that ends then is not the worker's result. */
  get busy(): boolean {
    return this.phase !== "work";
  }

  /** True when a request is noted and waits for the worker's turn to end. */
  get pending(): boolean {
    return !!this.asked;
  }

  tool(): BotTool {
    return {
      name: SHORTEN_TOOL,
      description:
        "Have your conversation shortened (summarised by Claude Code) so you carry on with less to hold, which makes every later step cheaper. Use it between two jobs, or between two parts of one job, when what comes next does not need the full history of what you read and tried. Never in the middle of something half done. Give in keep everything you must still know afterwards, and in next what you do next. Then end your turn with one line: you are shortened and told to carry on.",
      shape: {
        keep: z.string().min(1).max(20000).describe("What you must still know afterwards: decisions, file paths, what is done and verified, what failed and why, anything from the task you still need."),
        next: z.string().min(1).max(5000).describe("What you do next, in a few sentences."),
      },
      handler: async (args) => this.ask(String(args.keep ?? ""), String(args.next ?? "")),
    };
  }

  /** The tool's handler: notes the request, or says why not. */
  ask(keep: string, next: string): ToolResult {
    if (!keep.trim() || !next.trim()) return { ...ok("Give both keep and next."), isError: true };
    if (this.failures >= SHORTEN_MAX_FAILURES) return ok("Shortening has not worked for you here. Go on with your work without asking again.");
    if (this.tried && this.steps < SHORTEN_MIN_STEPS && !this.asked) {
      const when = this.steps === 0 ? "just now" : `${this.steps} step${this.steps === 1 ? "" : "s"} ago`;
      return ok(
        this.failures && !this.lastWorked
          ? `Shortening was tried ${when} and did not work. Go on with your work without asking again for now.`
          : `You were shortened only ${when}: there is nothing new to drop. Go on with your work without asking again.`,
      );
    }
    this.asked = { keep: keep.trim(), next: next.trim() };
    return ok("Noted. You are shortened as soon as you end this step. End your turn now with one line that says what you just finished, and do not start what comes next yet. Afterwards you are told to carry on, with what you gave in keep and next.");
  }

  /** The worker did a step of work: a tool call that is not this tool. */
  step(): void {
    if (this.phase === "work") this.steps++;
  }

  /**
   * A turn of the worker's session ended. True when it is handled here and is not the worker's
   * result: a turn that asked to be shortened, or the summary's own turn.
   */
  turnEnd(e: { ok: boolean; errors: string[] }): boolean {
    if (this.phase === "work") {
      if (!this.asked) return false;
      // A turn that failed is the worker's end as before; its request goes with it.
      if (!e.ok) {
        this.asked = undefined;
        return false;
      }
      this.begin();
      return true;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    const asked = this.asked!;
    const b = this.boundary;
    const why = this.why ?? (e.errors[0] ? `Claude Code said: ${oneLine(e.errors[0]).slice(0, 200)}` : "Claude Code did not say it had shortened the conversation");
    this.asked = undefined;
    this.boundary = undefined;
    this.why = undefined;
    this.phase = "work";
    this.tried = true;
    this.steps = 0;
    this.lastWorked = !!b;
    if (b) {
      this.count++;
      const sizes = b.pre && b.post ? `${num(b.pre)} to ${num(b.post)} tokens` : b.pre ? `from ${num(b.pre)} tokens` : "";
      this.host.line(`Shortened on request${sizes ? `: ${sizes}` : ""}`);
      this.host.status("Carrying on after it was shortened");
      this.host.send(this.carryOn(asked, sizes), true);
    } else {
      this.failures++;
      this.host.line(`Could not be shortened (${why}), so it carries on as it is`);
      this.host.status("Carrying on");
      this.host.send(
        `Note from Pobots: your conversation could not be shortened (${why}). Nothing was lost. Carry on as you are with what you said you do next:\n\n${asked.next}`,
        true,
      );
    }
    return true;
  }

  /** The harness shortened the session. True when it is the summary asked for here. */
  compacted(e: { trigger: "manual" | "auto"; preTokens?: number; postTokens?: number }): boolean {
    if (this.phase === "work" || e.trigger !== "manual") return false;
    this.boundary = { ...(e.preTokens ? { pre: e.preTokens } : {}), ...(e.postTokens ? { post: e.postTokens } : {}) };
    return true;
  }

  /** The worker ended: nothing more is sent. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private begin(): void {
    const asked = this.asked!;
    this.phase = "summarising";
    this.host.status("Shortening its conversation");
    // One line: the summary's instructions follow the command on its line.
    this.host.send(`/compact Summarise for a worker that carries on with its task. Keep: ${oneLine(asked.keep)} It goes on with: ${oneLine(asked.next)} Drop file contents and command output that this does not need.`, false);
    this.timer = setTimeout(() => {
      const mins = Math.max(1, Math.round(this.waitMs / 60_000));
      this.why = `it took longer than ${mins} minute${mins === 1 ? "" : "s"}`;
      this.phase = "stopping";
      this.host.interrupt();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.host.fail("The helper did not come back after it asked to be shortened.");
      }, this.stuckMs);
      this.timer.unref?.();
    }, this.waitMs);
    this.timer.unref?.();
  }

  private carryOn(asked: { keep: string; next: string }, sizes: string): string {
    const task = this.task.length <= TASK_AGAIN_MAX ? `\n\nYour task as you were given it:\n\n${this.task}` : "";
    return [
      `Note from Pobots: your conversation was shortened, as you asked${sizes ? ` (${sizes})` : ""}.`,
      `What you asked to keep:\n\n${asked.keep}`,
      `What you said you do next:\n\n${asked.next}`,
      `Carry on with it now. End with your result as before: your last message is what the bot gets.${task}`,
    ].join("\n\n");
  }
}
