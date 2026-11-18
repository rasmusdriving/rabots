// read_helper's views of one helper (15 Nov 2026, docs/build/step-bot-reach.md): the latest steps in
// full, the whole thread as one short line a step, or a range of steps. Read from the helper's own
// thread in the store (the items the window shows), never from the harness's files. After T3 Code's
// t3_thread_read (apps/server/src/mcp/toolkits/orchestrator/tools.ts and OrchestratorMcpService.ts,
// MIT): views, positions to page by, a cap on each item and on the whole answer.
import type { Engine } from "../engine.js";
import type { BotRuntime, Helper } from "./runtime.js";
import type { ActivityItem, HelperItem, Item, ToolKind } from "../../shared/protocol.js";
import { localWhen } from "./words.js";

/** A whole answer of read_helper stays under this many characters (a few thousand tokens). */
export const READ_MAX = 12_000;
/** A tool call's short result kept in memory, and how many of them a bot keeps. */
export const SHORT_RESULT_MAX = 300;
export const SHORT_RESULTS_KEPT = 1_000;
/** At most this many steps of a helper's thread are read. */
const STEPS_READ = 5_000;

/** The id a bot uses for a helper: the start of its row's id. */
export function shortHelperId(itemId: string): string {
  return itemId.slice(0, 8);
}

/** Keeps the start of a helper's tool result for read_helper, while Pobots runs. */
export function keepShortResult(rt: BotRuntime, activityId: string, text: string | undefined): void {
  const t = text?.trim();
  if (!t) return;
  const map = (rt.helperResults ??= new Map());
  map.delete(activityId);
  map.set(activityId, t.length > SHORT_RESULT_MAX ? `${t.slice(0, SHORT_RESULT_MAX - 3).trimEnd()}...` : t);
  while (map.size > SHORT_RESULTS_KEPT) map.delete(map.keys().next().value!);
}

/**
 * Text with what could be a secret replaced by "(hidden)": the webhook and channel keys and
 * addresses Pobots knows, its own /hook/ addresses, URL signatures and tokens, bearer tokens and
 * strings shaped like API keys.
 */
export function hideSecrets(eng: Engine, text: string): string {
  let out = text;
  for (const s of knownSecrets(eng)) out = out.split(s).join("(hidden)");
  return out
    .replace(/\/hook\/[^\s"'<>)\]]+/g, "/hook/(hidden)")
    .replace(/([?&](?:sig|signature|token|access_token|refresh_token|code|key|api_key|apikey|secret|password|sv|se|sp)=)[^&\s"'<>)\]]+/gi, "$1(hidden)")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 (hidden)")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "(hidden)")
    .replace(/\b((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)["']?[^\s"',;]{6,}/gi, "$1(hidden)");
}

function knownSecrets(eng: Engine): string[] {
  const out: string[] = [];
  try {
    for (const t of eng.store.listTriggers()) if (t.secret && t.secret.length >= 6) out.push(t.secret);
    for (const c of eng.store.listChannels()) {
      if (c.secret.length >= 6) out.push(c.secret);
      if (c.replyUrl) out.push(c.replyUrl);
    }
  } catch {
    // A closed store has nothing to hide.
  }
  return out.sort((a, b) => b.length - a.length);
}

function oneLine(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t;
}

function clipBlock(text: string, n: number): string {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n - 3).trimEnd()}... (cut; ${t.length} characters)` : t;
}

/** Every item of a helper's thread, oldest first: its steps, numbered from 1. */
export function helperSteps(eng: Engine, item: HelperItem): Item[] {
  const all: Item[] = [];
  let before: number | undefined;
  for (;;) {
    const page = eng.store.readThread(item.helperThreadId, before, 500);
    all.unshift(...page.items);
    if (!page.hasMore || !page.items.length || all.length >= STEPS_READ) break;
    before = page.items[0]!.seq;
  }
  return all;
}

// ---------------------------------------------------------------- one line for a run of work

/** The kind of a line of work, as the window reads it (ui/lib/work.ts kindOf). */
function kindOf(item: ActivityItem): ToolKind {
  if (item.tool) return item.tool;
  const l = item.label;
  if (/^(Ran|Running|Watched|Watching) a command/.test(l)) return "command";
  if (/^(Read|Reading) a (web )?page|^(Searched|Searching) the web|in the browser/.test(l)) return "web";
  if (/^(Read|Reading) /.test(l)) return "read";
  if (/^(Edited|Editing|Wrote|Writing) /.test(l)) return "edit";
  if (/^(Searched|Searching|Looked|Looking) for files|^(Searched|Searching) files|^(Listed|Listing) /.test(l)) return "search";
  return "other";
}

const WORDS: Record<Exclude<ToolKind, "think">, [string, (n: number) => string]> = {
  command: ["ran a command", (n) => `ran ${n} commands`],
  read: ["read a file", (n) => `read ${n} files`],
  edit: ["changed a file", (n) => `changed ${n} files`],
  search: ["searched files", (n) => `searched files ${n} times`],
  web: ["used the web", (n) => `used the web ${n} times`],
  plan: ["updated its to-do list", () => "updated its to-do list"],
  message: ["sent a message", (n) => `sent ${n} messages`],
  skill: ["used a skill", (n) => `used ${n} skills`],
  other: ["used a tool", (n) => `used ${n} tools`],
};

/** "ran 12 commands, read 6 files and changed 2 files (1 failed)", as the window folds work (summarize in ui/lib/work.ts, after T3's summarizeToolGroup). */
export function workWords(items: ActivityItem[]): string {
  const order: Exclude<ToolKind, "think">[] = [];
  const count = new Map<ToolKind, number>();
  for (const i of items) {
    const k = kindOf(i);
    if (k === "think") continue;
    if (!count.has(k)) order.push(k);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const named = order.slice(0, 4).map((k) => (count.get(k) === 1 ? WORDS[k][0] : WORDS[k][1](count.get(k)!)));
  const rest = order.slice(4).reduce((n, k) => n + count.get(k)!, 0);
  if (rest) named.push(rest === 1 ? "1 more step" : `${rest} more steps`);
  const words = !named.length ? "thought" : named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  const failed = items.filter((i) => i.status === "failed").length;
  const running = items.some((i) => i.status === "running");
  return `${words}${failed ? ` (${failed} failed)` : ""}${running ? " (working on the last now)" : ""}`;
}

// ---------------------------------------------------------------- the views

type Ctx = { eng: Engine; owner: BotRuntime; item: HelperItem; live?: Helper; id: string };

function who(ctx: Ctx, botId: string): string {
  if (botId === ctx.owner.folder.id) return ctx.owner.folder.file.name;
  return ctx.eng.bots.get(botId)?.folder.file.name ?? botId;
}

/** One step in full, for latest and a range. */
function stepFull(ctx: Ctx, n: number, it: Item, first: boolean, last: boolean): string {
  const when = localWhen(ctx.eng, it.at);
  switch (it.kind) {
    case "user": {
      const from = it.from.type === "bot" ? who(ctx, it.from.botId) : "the person";
      if (first) return `${n}. Task from ${from} (${when}):\n${clipBlock(it.text, 1_500)}`;
      return `${n}. Message from ${from}${it.steered ? ", steered in while it worked" : ""} (${when}):\n${clipBlock(it.text, 1_500)}`;
    }
    case "bot":
      return `${n}. It said (${when}):\n${clipBlock(it.text, last ? 4_000 : 1_500)}`;
    case "activity": {
      const state = it.status === "running" ? " (working on it now)" : it.status === "failed" ? " (failed)" : "";
      const detail = it.detail ? `: ${oneLine(it.detail, 300)}` : "";
      const result = ctx.owner.helperResults?.get(it.id);
      return `${n}. ${it.label}${detail}${state}${result ? `\n   Result: ${oneLine(result, SHORT_RESULT_MAX)}` : ""}`;
    }
    case "notice":
      return `${n}. Note: ${oneLine(it.text, 300)}`;
    case "helper":
      return `${n}. Started its own helper "${it.title}" (${it.status})`;
    default:
      return `${n}. ${it.kind}`;
  }
}

/** One step as one short line, for the overview. */
function stepLine(ctx: Ctx, n: number, it: Item, first: boolean): string {
  switch (it.kind) {
    case "user":
      return first ? `${n}. Task: ${oneLine(it.text, 200)}` : `${n}. Message from ${it.from.type === "bot" ? who(ctx, it.from.botId) : "the person"}${it.steered ? " (steered)" : ""}: ${oneLine(it.text, 160)}`;
    case "bot":
      return `${n}. Said: ${oneLine(it.text, 200)}`;
    case "notice":
      return `${n}. Note: ${oneLine(it.text, 120)}`;
    case "helper":
      return `${n}. Started its own helper "${oneLine(it.title, 80)}" (${it.status})`;
    default:
      return `${n}. ${it.kind}`;
  }
}

/** The head of every view: id, title, state, model, steps, time. */
export function helperHead(eng: Engine, item: HelperItem, live?: Helper): string {
  const status = live ? live.status : item.status;
  const steps = live ? live.steps : item.steps;
  const last = live ? live.last : item.last;
  const model = item.model ? (eng.modelList().find((m) => m.id === item.model)?.label ?? item.model) : "the bot's own model";
  const effort = item.effort ? `, ${item.effort}` : "";
  const state =
    status === "running"
      ? `working now${last ? ` (${oneLine(last, 160)})` : ""}`
      : `${status === "done" ? "done" : status === "failed" ? "failed" : "stopped"}${item.endedAt ? ` ${localWhen(eng, item.endedAt)}` : ""}`;
  const kind = live?.pobots || item.model ? "start_helper" : "your own helper tool";
  return `Helper ${shortHelperId(item.id)} "${item.title}": ${state}. ${steps} step${steps === 1 ? "" : "s"} of work. ${model}${effort}. Started ${localWhen(eng, item.at)}${item.background ? ", in the background" : ""}. Started with ${kind}.`;
}

export type ReadArgs = { view?: "latest" | "overview"; from?: number; to?: number };

/** read_helper with an id: the head and one of the views, under READ_MAX. */
export function readHelperView(eng: Engine, owner: BotRuntime, item: HelperItem, live: Helper | undefined, args: ReadArgs): string {
  const ctx: Ctx = { eng, owner, item, ...(live ? { live } : {}), id: shortHelperId(item.id) };
  const steps = helperSteps(eng, item);
  const head = helperHead(eng, item, live);
  const total = steps.length;
  const ask = (a: number, b: number) => `read_helper id ${ctx.id} from ${a} to ${b}`;
  let body: string;
  if (args.from !== undefined || args.to !== undefined) body = rangeView(ctx, steps, args.from ?? 1, args.to ?? total, ask);
  else if (args.view === "overview") body = overviewView(ctx, steps, ask);
  else body = latestView(ctx, steps, ask);
  return hideSecrets(eng, `${head}\n\n${body}`);
}

function budget(): number {
  return READ_MAX - 800;
}

function latestView(ctx: Ctx, steps: Item[], ask: (a: number, b: number) => string): string {
  const total = steps.length;
  if (!total) return "Its thread is empty.";
  const out: string[] = [];
  let used = 0;
  let firstShown = total + 1;
  for (let i = total - 1; i >= 0 && out.length < 40; i--) {
    const text = stepFull(ctx, i + 1, steps[i]!, i === 0, i === total - 1);
    if (used + text.length > budget() && out.length) break;
    out.unshift(text);
    used += text.length + 1;
    firstShown = i + 1;
  }
  const before = firstShown - 1;
  const lead = before ? `${before} earlier step${before === 1 ? "" : "s"}; see them with read_helper id ${ctx.id} view overview, or ask with ${ask(1, before)}.\n\n` : "";
  return `${lead}The latest steps:\n${out.join("\n")}`;
}

/** Lines for the overview: a run of work between two messages is one counted line. */
function overviewLines(ctx: Ctx, steps: Item[]): string[] {
  const lines: string[] = [];
  let run: { start: number; items: ActivityItem[] } | undefined;
  const flush = () => {
    if (!run) return;
    const a = run.start;
    const b = run.start + run.items.length - 1;
    lines.push(a === b ? `${a}. ${run.items[0]!.label}${run.items[0]!.status === "failed" ? " (failed)" : run.items[0]!.status === "running" ? " (working on it now)" : ""}` : `${a} to ${b}. ${capital(workWords(run.items))}`);
    run = undefined;
  };
  steps.forEach((it, i) => {
    if (it.kind === "activity") {
      if (!run) run = { start: i + 1, items: [] };
      run.items.push(it);
      return;
    }
    flush();
    lines.push(stepLine(ctx, i + 1, it, i === 0));
  });
  flush();
  return lines;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function overviewView(ctx: Ctx, steps: Item[], ask: (a: number, b: number) => string): string {
  if (!steps.length) return "Its thread is empty.";
  const lines = overviewLines(ctx, steps);
  const intro = `Every step of its thread, one line each (steps ${1} to ${steps.length}). A run of work between two messages is one line. See any steps in full with ${ask(1, Math.min(10, steps.length))}.`;
  const size = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0);
  if (size(lines) <= budget()) return `${intro}\n${lines.join("\n")}`;
  // Too long even so: the start and the end stay, the middle is one counted line.
  const head: string[] = [];
  const tail: string[] = [];
  let i = 0;
  let j = lines.length - 1;
  let used = 0;
  while (i <= j) {
    const t = lines[j]!;
    if (used + t.length > budget() * 0.6) break;
    tail.unshift(t);
    used += t.length + 1;
    j--;
  }
  while (i <= j) {
    const h = lines[i]!;
    if (used + h.length > budget()) break;
    head.push(h);
    used += h.length + 1;
    i++;
  }
  const firstNum = (l: string | undefined) => Number(/^(\d+)/.exec(l ?? "")?.[1] ?? 0);
  const a = firstNum(lines[i]);
  const b = tail.length ? firstNum(tail[0]) - 1 : steps.length;
  const left = lines.slice(i, j + 1);
  const gap = `(steps ${a} to ${b} left out here: ${left.length} line${left.length === 1 ? "" : "s"}; ask with ${ask(a, b)})`;
  return `${intro}\n${[...head, gap, ...tail].join("\n")}`;
}

function rangeView(ctx: Ctx, steps: Item[], fromIn: number, toIn: number, ask: (a: number, b: number) => string): string {
  const total = steps.length;
  if (!total) return "Its thread is empty.";
  const from = Math.max(1, Math.min(total, Math.floor(fromIn)));
  const to = Math.max(from, Math.min(total, Math.floor(toIn)));
  const out: string[] = [];
  let used = 0;
  let lastShown = from - 1;
  for (let i = from - 1; i < to; i++) {
    const text = stepFull(ctx, i + 1, steps[i]!, i === 0, i === total - 1);
    if (used + text.length > budget() && out.length) break;
    out.push(text);
    used += text.length + 1;
    lastShown = i + 1;
  }
  const more = to - lastShown;
  const tail = more ? `\n\n${more} more step${more === 1 ? "" : "s"} in this range; ask with ${ask(lastShown + 1, to)}.` : "";
  const after = to < total ? `\n\nIt has ${total} steps in all.` : "";
  return `Steps ${from} to ${lastShown} of ${total}:\n${out.join("\n")}${tail}${after}`;
}
