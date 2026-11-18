// What a worker (a helper started with start_helper) is told, in three layers (docs/build/step-workers.md, part 4):
//   1. Pobots' own few fixed lines (helperInstructions in team.ts);
//   2. WORKERS.md in the bot's folder: what every worker of this bot is told, a built-in text when
//      the file is absent or empty;
//   3. a kind, when the bot names one: workers/<kind>.md in the bot's folder, with optional lines at
//      its top between --- marks (description, model, effort, shorten_at, shorten).
// The task is the first message, as before. What the call says wins over the kind's lines, and
// those win over the defaults. Kinds are read when start_helper is called, so a bot can write one
// and use it in the same turn.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort, Harness } from "../shared/protocol.js";
import { COMPACT_MAX, COMPACT_MIN } from "./config.js";
import { git, hasRepo, savePaths } from "./history.js";
import { log } from "./log.js";
import { helperInstructions } from "./team.js";

export const WORKERS_FILE = "WORKERS.md";
export const KINDS_DIR = "workers";
/** The name of the tool with which a Claude worker asks to be shortened. */
export const SHORTEN_TOOL = "shorten_conversation";
/** A kind file or WORKERS.md bigger than this is not read. */
const MAX_BYTES = 100 * 1024;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const KIND_NAME = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const KIND_KEYS = ["description", "model", "effort", "shorten_at", "shorten"] as const;

/** What every worker is told when the bot's WORKERS.md is absent or empty. The person's to tune; under 150 words. */
export const DEFAULT_WORKERS_MD = [
  "# What every worker is told",
  "",
  "- Work in the folder you are given.",
  "- Read only what the task needs: a part of a long file, not the whole.",
  "- From a long command, print only what failed.",
  `- When you move from one job to the next and do not need the full history to know what to do next, first call ${SHORTEN_TOOL} with what you must keep.`,
  "- Never shorten in the middle of something half done.",
  "- End with a result the bot can act on: what you did, what you verified and how, and what you did not verify.",
  "",
].join("\n");

export interface WorkerKind {
  name: string;
  description?: string;
  model?: string;
  effort?: Effort;
  shortenAt?: number;
  shorten?: boolean;
  /** What a worker of this kind is told, after WORKERS.md. */
  body: string;
}

/** Reads a kind file's text: its top block and the rest. A broken top block is refused in a plain sentence. */
export function parseKind(name: string, text: string): WorkerKind | { problem: string } {
  const file = `${KINDS_DIR}/${name}.md`;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const kind: WorkerKind = { name, body: "" };
  if (lines[0]?.trim() !== "---") {
    kind.body = lines.join("\n").trim();
    return kind;
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return { problem: `The top block of ${file} has no closing --- line.` };
  for (let i = 1; i < close; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return { problem: `Line ${i + 1} of ${file} is not "name: value".` };
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    switch (key) {
      case "description":
        kind.description = value.replace(/\s+/g, " ").slice(0, 300);
        break;
      case "model":
        if (value) kind.model = value;
        break;
      case "effort":
        if (!EFFORTS.includes(value as Effort)) return { problem: `effort in ${file} must be one of ${EFFORTS.join(", ")}.` };
        kind.effort = value as Effort;
        break;
      case "shorten_at": {
        const n = Number(value.replace(/[_,\s]/g, ""));
        if (!Number.isInteger(n) || n < COMPACT_MIN || n > COMPACT_MAX) return { problem: `shorten_at in ${file} must be a whole number of tokens from 150000 to 1000000.` };
        kind.shortenAt = n;
        break;
      }
      case "shorten":
        if (/^(true|yes|on)$/i.test(value)) kind.shorten = true;
        else if (/^(false|no|off)$/i.test(value)) kind.shorten = false;
        else return { problem: `shorten in ${file} must be true or false.` };
        break;
      default:
        return { problem: `${file} has a line "${m[1]}" at its top; the lines there can be ${KIND_KEYS.join(", ")}.` };
    }
  }
  kind.body = lines.slice(close + 1).join("\n").trim();
  return kind;
}

function readSmall(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The names of the kind files in a bot's folder, sorted. */
export function kindNames(botDir: string): string[] {
  try {
    return readdirSync(join(botDir, KINDS_DIR), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md") && KIND_NAME.test(d.name.slice(0, -3)))
      .map((d) => d.name.slice(0, -3))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The kinds a bot has, each with its description or why it cannot be used, for the tool's description. */
export function listKinds(botDir: string): { name: string; description?: string; problem?: string }[] {
  return kindNames(botDir).map((name) => {
    const text = readSmall(join(botDir, KINDS_DIR, `${name}.md`));
    if (text === undefined) return { name, problem: "too big or unreadable" };
    const k = parseKind(name, text);
    return "problem" in k ? { name, problem: k.problem } : { name, ...(k.description ? { description: k.description } : {}) };
  });
}

/** A kind by name (any case), read now. A kind that does not exist is refused with the names of those that do. */
export function readKind(botDir: string, ref: string): WorkerKind | { problem: string } {
  const want = ref.trim().replace(/\.md$/i, "");
  const names = kindNames(botDir);
  const name = KIND_NAME.test(want) ? names.find((n) => n.toLowerCase() === want.toLowerCase()) : undefined;
  if (!name) {
    return {
      problem: names.length
        ? `There is no kind called ${want || "(none)"}. Your kinds: ${names.join(", ")}.`
        : `There is no kind called ${want || "(none)"}. You have no kinds yet: a kind is a file ${KINDS_DIR}/<kind>.md in your folder.`,
    };
  }
  const text = readSmall(join(botDir, KINDS_DIR, `${name}.md`));
  if (text === undefined) return { problem: `${KINDS_DIR}/${name}.md could not be read, or is bigger than 100 KB.` };
  return parseKind(name, text);
}

/** What every worker of the bot is told: its WORKERS.md, or the built-in text when that is absent or empty. */
export function workersText(botDir: string): string {
  const text = readSmall(join(botDir, WORKERS_FILE))?.trim();
  return text || DEFAULT_WORKERS_MD.trim();
}

/** A worker's whole instructions: Pobots' lines, WORKERS.md, the kind. */
export function workerInstructions(o: { botName: string; browser: boolean; botDir: string; kind?: WorkerKind; shortenTool: boolean }): string {
  const parts = [helperInstructions(o.botName, o.browser)];
  if (!o.shortenTool) parts.push(`You have no ${SHORTEN_TOOL} tool here: where the lines below mention it, carry on without it.`);
  parts.push(workersText(o.botDir));
  if (o.kind?.body) parts.push(o.kind.body);
  return parts.join("\n\n");
}

/** What a start_helper call asks for, after its kind and the defaults. */
export interface WorkerChoice {
  model: string;
  effort?: Effort;
  shortenAt: number;
  shorten: boolean;
}

/**
 * The call wins over the kind, the kind over the defaults. `harnessOf` tells a model's kind of
 * harness; `sizeFor` the person's setting for that harness. A worker on a GPT model never gets the
 * tool in this step.
 */
export function chooseWorker(
  call: { model?: string; effort?: Effort; shortenAt?: number; shorten?: boolean },
  kind: WorkerKind | undefined,
  harnessOf: (model: string) => Harness,
  sizeFor: (h: Harness) => number,
): WorkerChoice | { problem: string } {
  const model = call.model?.trim() || kind?.model;
  if (!model) return { problem: kind ? `The kind ${kind.name} names no model, so the call needs one.` : "A helper needs a model, or a kind that names one." };
  const harness = harnessOf(model);
  const effort = call.effort ?? kind?.effort;
  return {
    model,
    ...(effort ? { effort } : {}),
    shortenAt: call.shortenAt ?? kind?.shortenAt ?? sizeFor(harness),
    shorten: harness === "claude" && (call.shorten ?? kind?.shorten ?? true),
  };
}

/**
 * A bot from before this step gets WORKERS.md with the built-in text once, saved as a change of its
 * own by the app, so nothing else in its folder's history moves. A file the person removed later
 * (it is in the history) is not put back: the built-in text is used without it.
 */
export function ensureWorkersFile(botDir: string): boolean {
  const path = join(botDir, WORKERS_FILE);
  if (existsSync(path)) return false;
  try {
    if (hasRepo(botDir)) {
      let seen = "";
      try {
        seen = git(botDir, ["log", "-n", "1", "--format=%H", "--", WORKERS_FILE]).trim();
      } catch {
        seen = "";
      }
      if (seen) return false;
    }
    writeFileSync(path, DEFAULT_WORKERS_MD);
    try {
      savePaths(botDir, [WORKERS_FILE], "app", "Added WORKERS.md, what every worker of this bot is told");
    } catch (err) {
      log.warn(`Could not save WORKERS.md in a bot's history`, err);
    }
    return true;
  } catch (err) {
    log.warn(`Could not add WORKERS.md to a bot's folder`, err);
    return false;
  }
}
