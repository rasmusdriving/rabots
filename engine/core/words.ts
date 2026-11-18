// Small words and helpers of the engine with no state: lines, clipping, times, paths, plain refusals.
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { EngineError } from "../errors.js";
import { oneLine } from "../bots.js";
import { ACCESS_LEVELS, type Bot } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem } from "../team.js";
import { whenWords } from "../schedule.js";

/** A helper's line about now or about its end is cut at this length. */
export const HELPER_LAST_MAX = 160;

/** What the roster says while a bot's own turn has ended and helpers still work. */
export function waitingWords(n: number): string {
  return n === 1 ? "Waiting for a helper" : `Waiting for ${n} helpers`;
}

/** Text without the marks of markdown, on one line. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|~~|\*|`/g, "")
    .replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A helper's line: plain text on one line, at most HELPER_LAST_MAX characters. */
export function helperLine(text: string, max = HELPER_LAST_MAX): string {
  const t = plainLine(text);
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "\u2026";
}

/** A helper's title from the description the bot gave, or "Helper". */
export function helperTitle(description: unknown): string {
  const t = typeof description === "string" ? plainLine(description) : "";
  if (!t) return "Helper";
  return t.length <= 120 ? t : t.slice(0, 119).trimEnd() + "\u2026";
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * A time for a tool's answer to a bot, on the engine's own clock and time zone: "today 15:46",
 * "tomorrow 03:00", "3 Nov 09:12". Never bare UTC: a bot read "15:46Z" as the person's time, an hour
 * off (the tester's walk of 15 Nov 2026). As in list_triggers and read_chat (chatTime).
 */
export function localWhen(eng: { clock: () => number; tz: string }, at: string | undefined): string {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? whenWords(t, eng.clock(), eng.tz) : "at an unknown time";
}

export function iso(t: number): string {
  return new Date(t).toISOString();
}

export function clip(text: string, n: number): string {
  const t = text.trim().replace(/\s+\n/g, "\n");
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "..." : t;
}

/** The text around the first place one of the words is found, clipped at `n` characters. */
export function aroundMatch(text: string, words: string[], n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  const lower = flat.toLowerCase();
  const at = words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(n / 3), flat.length - n));
  const piece = flat.slice(start, start + n);
  return `${start > 0 ? "..." : ""}${piece}${start + n < flat.length ? "..." : ""}`;
}

/** The real path of a file that may not exist yet: its deepest existing folder, resolved, plus the rest. */
export function realPath(path: string): string {
  let dir = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch {
      const up = dirname(dir);
      if (up === dir) return path;
      rest.push(dir.slice(up.length).replace(/^[\\/]+/, ""));
      dir = up;
    }
  }
}

/** True when `path` (relative to `base` when not absolute) lies inside `dir`, links resolved. */
export function insideDir(base: string, path: string, dir: string): boolean {
  const full = realPath(resolve(base, path));
  const root = realPath(resolve(dir));
  const rel = relative(root, full);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new EngineError("bad_request", "A bot needs a name.");
  if (clean.length > 60) throw new EngineError("bad_request", "That name is too long. Keep it under 60 characters.");
  return clean;
}

export function cleanPurpose(purpose: string | undefined): string {
  const p = oneLine(purpose ?? "");
  if (p.length > 200) throw new EngineError("bad_request", "Keep the purpose to one short line, under 200 characters.");
  return p;
}

export function accessLabel(id: Bot["access"]): string {
  return ACCESS_LEVELS.find((a) => a.id === id)?.label ?? id;
}

/** "Po changed MEMORY.md", "Po changed 2 files". */
export function changedSummary(name: string, files: string[]): string {
  if (files.length === 1) return `${name} changed ${files[0]!.split("/").at(-1)}`;
  return `${name} changed ${files.length} files`;
}

export function refused(decision: string, what: string): ToolResult {
  switch (decision) {
    case "expired":
      return ok(`Nobody answered in time, so ${what}.`);
    case "withdrawn":
      return problem(`The request was withdrawn because the turn stopped, so ${what}.`);
    case "later":
      return ok(`The person put this aside for later, so ${what}. Do not ask again right away.`);
    default:
      return ok(`The person said no, so ${what}. Do not try it another way.`);
  }
}

export function apiErrorSentence(code: string): string {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "verification_required":
      return "Claude could not sign in. Open Claude in a terminal and sign in again.";
    case "account_on_hold":
      return "The Claude account is on hold.";
    case "billing_error":
      return "Claude reported a billing problem with the account.";
    case "rate_limit":
      return "The Claude usage limit was reached. Try again later.";
    case "overloaded":
    case "server_error":
      return "Claude is busy or having trouble right now. Try again in a moment.";
    case "model_not_found":
      return "This bot's model is not available. Pick another model.";
    case "max_output_tokens":
      return "The reply got too long and was cut off.";
    case "invalid_request":
      return "Claude turned the request down as invalid.";
    // Codex (step 3a), from codex/session.ts.
    case "codex_usage_limit":
      return "The ChatGPT usage limit was reached. Try again later.";
    case "codex_rate_limit":
      return "ChatGPT is getting too many requests right now. Try again in a moment.";
    case "codex_unauthorized":
      return "Codex is not signed in. Run codex login in a terminal on the Mac.";
    case "codex_unavailable":
      return "ChatGPT is busy or having trouble right now. Try again in a moment.";
    case "codex_model_not_found":
      return "This bot's model is not available. Pick another model.";
    case "codex_context_full":
      return "The conversation got too long for the model.";
    case "codex_refused":
      return "ChatGPT turned the request down.";
    default:
      return "Something went wrong while the bot was working.";
  }
}
