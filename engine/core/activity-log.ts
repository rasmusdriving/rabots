// activity_log: what happened in Pobots over a day, with times, for the person's time reporting
// (engine 0.28.0, docs/build/step-activity-log.md). Main bot only, and allowed in a tidy turn: it
// only reads.
//
// As T3 Code reads a thread's activity from stored rows (projection_thread_activities in
// apps/server/src/persistence/Migrations/005_Projections.ts) instead of keeping a log of its own,
// this reads what Pobots already keeps: items, chat titles, triggers, channels, calendar actions and
// channel posts, plus the person's own actions the server notes (core/person-actions.ts).
//
// Labels only: times, bots, who started what, chat titles, helper titles, meeting subjects. Never a
// message's text, a tool's input, a card's text, a file's contents, attendees or addresses.

import type { ToolResult } from "../claude/session.js";
import type { ActivityItemRow, PersonActionRow, PersonVia } from "../activity-store.js";
import { dayStart, dayTime, minutesWords, nextDay, parseWhen } from "../calendar-time.js";
import type { Engine } from "../engine.js";
import { wallOf } from "../schedule.js";
import { ok, problem } from "../tool-names.js";

export interface ActivityLogArgs {
  day?: string;
  from?: string;
  to?: string;
  bot?: string;
  gap_minutes?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** At most this many days at once. */
export const MAX_DAYS = 7;
/** A day's text is cut at about this many characters. */
export const DAY_CAP = 14_000;
/** Turns are looked for from this long before the day, so a turn's starter is found when it waited a while. */
const LOOK_BACK = 12 * HOUR;

const VIA_WORDS: Record<PersonVia, string> = { mac: "on the Mac", computer: "from a computer", phone: "from the phone" };

/** One bot turn as the log shows it. */
export interface Turn {
  botId: string;
  start: number;
  end: number;
  /** Who started it, in words. */
  starter: string;
  /** For the summary's counts. */
  starterKind: "you" | "schedule" | "webhook" | "fresh run" | "channel" | "bot" | "task manager" | "reported back";
  title?: string;
  run: boolean;
  count: number;
}

/** One of his actions as the log shows it. */
export interface Action {
  t: number;
  kind: PersonActionRow["kind"];
  botId?: string;
  words: string;
}

export interface Ctx {
  eng: Engine;
  tz: string;
  gapMs: number;
  botId?: string;
  names: Map<string, string>;
  triggers: Map<string, { kind: string; name: string }>;
  channels: Map<string, string>;
  /** The calendar mailbox's name: a channel message from that name is his. */
  me?: string;
  /** Titles of the helpers whose threads people wrote in (task managers), by thread id. */
  managers: Map<string, string | undefined>;
}

export function activityLogFor(eng: Engine, args: ActivityLogArgs): ToolResult {
  const tz = eng.tz;
  const days = pickDays(args, eng.clock(), tz);
  if (typeof days === "string") return problem(days);
  let botId: string | undefined;
  if (args.bot?.trim()) {
    const rt = eng.findBot(args.bot.trim());
    if (!rt) return problem(`There is no bot "${args.bot.trim()}". list_bots shows them.`);
    botId = rt.folder.id;
  }
  const gap = Math.min(120, Math.max(5, Math.round(args.gap_minutes ?? 15)));
  const ctx = ctxFor(eng, gap, botId);
  if (days.length === 1) return ok(dayText(ctx, readDay(ctx, days[0]!), true));
  const parts = days.map((d) => dayText(ctx, readDay(ctx, d), false));
  parts.push(`For one day in full, ask with day (YYYY-MM-DD).`);
  return ok(parts.join("\n\n"));
}

/** What a day is read with: the bots' names, triggers, channels, his mailbox name. */
export function ctxFor(eng: Engine, gapMinutes: number, botId?: string): Ctx {
  return {
    eng,
    tz: eng.tz,
    gapMs: gapMinutes * MIN,
    ...(botId ? { botId } : {}),
    names: new Map([...eng.bots.values()].map((rt) => [rt.folder.id, rt.folder.file.name])),
    triggers: eng.store.activity.triggers(),
    channels: eng.store.activity.channelNames(),
    ...(eng.store.calendar.settings().mailboxName ? { me: eng.store.calendar.settings().mailboxName!.trim().toLowerCase() } : {}),
    managers: new Map(),
  };
}

/** The days asked for, as day starts, or why not. */
function pickDays(args: ActivityLogArgs, nowMs: number, tz: string): number[] | string {
  const parse = (s: string, what: string): number | string => {
    const v = s.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${what} must be a date as YYYY-MM-DD.`;
    const p = parseWhen(v, tz);
    return p ? p.t : `${what} is not a date.`;
  };
  if (args.day && (args.from || args.to)) return "Give either day, or from and to, not both.";
  if (!args.from && !args.to) {
    const d = args.day ? parse(args.day, "day") : dayStart(nowMs, tz);
    return typeof d === "string" ? d : [d];
  }
  const a = parse(args.from ?? args.to!, "from");
  const b = parse(args.to ?? args.from!, "to");
  if (typeof a === "string") return a;
  if (typeof b === "string") return b;
  if (b < a) return "to comes before from.";
  const out: number[] = [];
  for (let d = a; d <= b; d = nextDay(d, tz)) {
    out.push(d);
    if (out.length > MAX_DAYS) return `At most ${MAX_DAYS} days at a time. Ask for fewer days.`;
  }
  return out;
}

/** The offset of `tz` at `t`: "+01:00". */
function offsetAt(t: number, tz: string): string {
  const w = wallOf(t, tz);
  const whole = Math.floor(t / MIN) * MIN;
  const mins = Math.round((Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - whole) / MIN);
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function iso(t: number): string {
  return new Date(t).toISOString();
}

export function q(s: string): string {
  return `"${s.replace(/\s+/g, " ").trim()}"`;
}

/** A day as read once, for the tool's text (dayText) and the window's rows (core/activity-day.ts). */
export interface Day {
  from: number;
  to: number;
  offA: string;
  offB: string;
  twoOffsets: boolean;
  /** "09:05", with the offset on a day the clocks change. */
  hm: (t: number) => string;
  /** "09:05 to 09:40", or the start alone when it lasted under a minute. */
  span: (a: number, b: number) => string;
  name: (botId: string) => string;
  actions: Action[];
  turns: Turn[];
  helpers: ActivityItemRow[];
  calendar: ReturnType<Engine["store"]["activity"]["calendarBetween"]>;
  posts: ReturnType<Engine["store"]["activity"]["postsBetween"]>;
  /** His actions closer than the gap, as blocks of first to last action. */
  blocks: { a: number; b: number; n: number }[];
}

/** Reads one day: his actions, the bots' turns folded, helpers, calendar actions and channel posts. */
export function readDay(ctx: Ctx, from: number): Day {
  const { eng, tz } = ctx;
  const to = nextDay(from, tz);
  const offA = offsetAt(from, tz);
  const offB = offsetAt(to - 1, tz);
  const twoOffsets = offA !== offB;
  const hm = (t: number) => {
    const w = wallOf(t, tz);
    const s = `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
    return twoOffsets ? `${s}${offsetAt(t, tz)}` : s;
  };
  const span = (a: number, b: number) => (b - a >= MIN ? `${hm(a)} to ${hm(b)}` : hm(a));

  const items = eng.store.activity.itemsBetween(iso(from - LOOK_BACK), iso(to));
  const inDay = (at: string) => {
    const t = Date.parse(at);
    return t >= from && t < to;
  };
  const mine = (b?: string) => !ctx.botId || b === ctx.botId;

  const actions = personActions(ctx, items, eng.store.activity.personActions(iso(from), iso(to)), from, to).filter((a) => mine(a.botId));
  const turns = findTurns(ctx, items, from, to).filter((t) => mine(t.botId));
  const helpers = items.filter((i) => i.kind === "helper" && inDay(i.at) && mine(i.botId));
  const calendar = eng.store.activity.calendarBetween(iso(from), iso(to)).filter((c) => mine(c.botId));
  const posts = eng.store.activity.postsBetween(iso(from), iso(to)).filter((p) => mine(p.botId));
  const name = (b: string) => ctx.names.get(b) ?? b;

  const blocks: Day["blocks"] = [];
  for (const t of actions.map((a) => a.t).sort((x, y) => x - y)) {
    const last = blocks[blocks.length - 1];
    if (last && t - last.b <= ctx.gapMs) {
      last.b = t;
      last.n++;
    } else blocks.push({ a: t, b: t, n: 1 });
  }
  return { from, to, offA, offB, twoOffsets, hm, span, name, actions, turns, helpers, calendar, posts, blocks };
}

/** True when nothing happened on the day. */
export function emptyDay(d: Day): boolean {
  return !d.actions.length && !d.turns.length && !d.helpers.length && !d.calendar.length && !d.posts.length;
}

/** Minutes active over the day's blocks, first to last action of each. */
export function activeMinutes(d: Day): number {
  return d.blocks.reduce((s, b) => s + Math.round((b.b - b.a) / MIN), 0);
}

/** A helper's model and effort in words: "Haiku 5.5, low". */
export function helperModel(eng: Engine, h: ActivityItemRow): string | undefined {
  return h.model ? [eng.modelLabel(h.model), h.effort].filter(Boolean).join(", ") : h.effort;
}

/** The words of a calendar action and of a channel post, without the time and the bot. */
export function calendarWords(ctx: Ctx, c: Day["calendar"][number]): string {
  const s = c.start ? Date.parse(c.start) : NaN;
  const when = Number.isFinite(s) ? ` for ${dayTime(s, ctx.tz)}` : "";
  return `${CALENDAR_WORDS[c.action] ?? c.action} ${q(c.subject)}${when}, ${c.status}`;
}

export function postWords(ctx: Ctx, p: Day["posts"][number]): string {
  return `wrote a post in channel ${q(ctx.channels.get(p.channelId) ?? p.channelId)}, ${p.status}`;
}

/** A turn's words after its time: who started it, how many, the chat's title. */
export function turnWords(t: Turn): string {
  const n = t.count > 1 ? `, ${t.count} turns` : "";
  return `${t.starter}${n}${t.run ? ", fresh run" : ""}${t.title ? `: ${q(t.title)}` : ""}`;
}

function dayText(ctx: Ctx, day: Day, full: boolean): string {
  const { eng, tz } = ctx;
  const { from, offA, offB, twoOffsets, hm, span, name, actions, turns, helpers, calendar, posts, blocks } = day;
  const dayName = dayTime(from, tz).slice(0, -6);
  const heading =
    `Activity in Pobots on ${dayName} ${wallOf(from, tz).y}, ${tz} (UTC${twoOffsets ? `${offA}, later ${offB}: each time carries its offset` : offA}). ` +
    `Labels only, never what was written.${ctx.botId ? ` Only ${ctx.names.get(ctx.botId) ?? ctx.botId}.` : ""}`;

  if (emptyDay(day)) {
    return `${heading}\nNothing happened in Pobots on this day${ctx.botId ? " for this bot" : ""}.`;
  }

  // ---- summary
  const summary: string[] = ["Summary"];
  if (actions.length) {
    const times = actions.map((a) => a.t).sort((x, y) => x - y);
    summary.push(`- Your first action ${hm(times[0]!)}, last ${hm(times[times.length - 1]!)}.`);
    const total = activeMinutes(day);
    const blockWords = blocks.map((b) => `${span(b.a, b.b)} (${b.b - b.a >= MIN ? `${minutesWords(Math.round((b.b - b.a) / MIN))}, ` : ""}${b.n} action${b.n === 1 ? "" : "s"})`);
    summary.push(`- Active, your actions closer than ${ctx.gapMs / MIN} minutes as one block: ${blockWords.join("; ")}. In all ${minutesWords(total)} over ${blocks.length} block${blocks.length === 1 ? "" : "s"}, first to last action of each.`);
    summary.push(`- Your actions: ${actions.length} (${counted(actions.map((a) => ACTION_NOUN[a.kind]))}).`);
  } else summary.push("- No actions of yours.");
  if (turns.length) {
    const perBot = new Map<string, number>();
    for (const t of turns) perBot.set(t.botId, (perBot.get(t.botId) ?? 0) + t.count);
    const n = turns.reduce((s, t) => s + t.count, 0);
    const starters = new Map<string, number>();
    for (const t of turns) starters.set(STARTER_NOUN[t.starterKind], (starters.get(STARTER_NOUN[t.starterKind]) ?? 0) + t.count);
    const by = [...starters].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(", ");
    summary.push(`- Bot turns: ${n} (${[...perBot].map(([b, c]) => `${name(b)} ${c}`).join(", ")}). Started by ${by}.`);
  }
  const managers = helpers.filter((h) => h.taskManager).length;
  summary.push(`- Helpers ${helpers.length - managers}, task managers ${managers}, calendar actions ${calendar.length}, channel posts ${posts.length}.`);

  if (!full) return [heading, ...summary].join("\n");

  // ---- the sections
  const sections: string[][] = [];
  if (actions.length) sections.push(["Your actions", ...actions.map((a) => `- ${hm(a.t)} ${a.words}`)]);
  if (turns.length) {
    const lines = ["Bot turns, by bot (start to end, what started it, the chat's title)"];
    const bots = [...new Set(turns.map((t) => t.botId))];
    for (const b of bots) {
      lines.push(name(b));
      for (const t of turns.filter((x) => x.botId === b)) lines.push(`- ${span(t.start, t.end)} ${turnWords(t)}`);
    }
    sections.push(lines);
  }
  if (helpers.length) {
    const lines = ["Helpers and task managers"];
    for (const h of helpers) {
      const start = Date.parse(h.at);
      const end = h.endedAt ? Date.parse(h.endedAt) : undefined;
      const model = helperModel(eng, h);
      const what = h.taskManager ? "task manager" : "helper";
      const time = end !== undefined ? span(start, end) : `${hm(start)}, still running`;
      lines.push(`- ${time} ${name(h.botId)}'s ${what} ${q(h.title ?? "")}${model ? ` (${model})` : ""}, ${h.status ?? "unknown"}`);
    }
    sections.push(lines);
  }
  if (calendar.length) sections.push(["Calendar", ...calendar.map((c) => `- ${hm(Date.parse(c.at))} ${name(c.botId)} ${calendarWords(ctx, c)}`)]);
  if (posts.length) sections.push(["Channel posts", ...posts.map((p) => `- ${hm(Date.parse(p.at))} ${name(p.botId)} ${postWords(ctx, p)}`)]);
  return capped([heading, ...summary].join("\n"), sections, ctx.botId !== undefined);
}

/** Joins the sections; past the cap, cuts at the end of a line and says how to ask for less. */
function capped(head: string, sections: string[][], filtered: boolean): string {
  let out = head;
  for (const s of sections) {
    for (let i = 0; i < s.length; i++) {
      const line = (i === 0 ? "\n\n" : "\n") + s[i];
      if (out.length + line.length > DAY_CAP) {
        return `${out}\n\nCut here: the day is too long to show at once. ${filtered ? "Ask for a shorter range." : "Ask with bot for one bot's day."}`;
      }
      out += line;
    }
  }
  return out;
}

export const ACTION_NOUN: Record<PersonActionRow["kind"], string> = {
  message: "message",
  card: "card answer",
  todo: "to-do",
  stop: "Stop",
  "stop-helper": "helper stopped",
  "end-task-manager": "task manager ended",
  question: "question on a card",
};

const STARTER_NOUN: Record<Turn["starterKind"], string> = {
  you: "you",
  schedule: "schedules",
  webhook: "webhooks",
  "fresh run": "fresh runs' results",
  channel: "channels",
  bot: "other bots",
  "task manager": "task managers",
  "reported back": "helpers or background tasks reporting back",
};

const CALENDAR_WORDS: Record<string, string> = { create: "made the meeting", move: "moved the meeting", cancel: "cancelled the meeting", respond: "answered the invitation" };

/** "3 messages, 1 card answer", most first. */
function counted(nouns: string[]): string {
  const m = new Map<string, number>();
  for (const n of nouns) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${c === 1 ? n : plural(n)}`)
    .join(", ");
}

function plural(n: string): string {
  if (n === "Stop") return "Stops";
  const words = n.split(" ");
  const i = words.findIndex((w) => w === "stopped" || w === "ended");
  const at = i > 0 ? i - 1 : words.length - 1;
  words[at] = words[at]!.endsWith("s") ? words[at]! : `${words[at]}s`;
  return words.join(" ");
}

/** The title of a task manager's thread, by its helper item. */
function managerTitle(ctx: Ctx, threadId: string): string | undefined {
  if (!ctx.managers.has(threadId)) ctx.managers.set(threadId, ctx.eng.store.activity.helperFor(threadId)?.title);
  return ctx.managers.get(threadId);
}

/** Where a message stands, in words: the chat's title, a fresh run, a task manager. */
function placeWords(ctx: Ctx, threadId: string, threadKind: string | undefined, seq: number | undefined): string {
  if (threadKind === "helper") {
    const t = managerTitle(ctx, threadId);
    return t ? ` to its task manager ${q(t)}` : " to a helper";
  }
  const title = seq !== undefined ? ctx.eng.store.titleAt(threadId, seq) : undefined;
  return `${threadKind === "run" ? " in a fresh run" : ""}${title ? `, chat ${q(title)}` : ""}`;
}

/** His actions: what the server noted, and his messages from before it noted them (or not through a window). */
function personActions(ctx: Ctx, items: ActivityItemRow[], rows: PersonActionRow[], from: number, to: number): Action[] {
  const name = (b?: string) => (b ? (ctx.names.get(b) ?? b) : "Pobots");
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: Action[] = [];
  const noted = new Set(rows.map((r) => r.ref).filter(Boolean) as string[]);
  const loose = rows.filter((r) => r.kind === "message" && !r.ref);
  for (const r of rows) {
    const via = r.via ? `, ${VIA_WORDS[r.via]}` : "";
    const t = Date.parse(r.at);
    let words: string;
    switch (r.kind) {
      case "message": {
        const it = r.ref ? byId.get(r.ref) : undefined;
        const threadKind = it?.threadKind ?? (r.threadId && managerTitle(ctx, r.threadId) !== undefined ? "helper" : undefined);
        words = `message to ${name(r.botId)}${via}${r.threadId ? placeWords(ctx, r.threadId, threadKind, it?.seq) : ""}`;
        break;
      }
      case "card":
        words = `answered a card of ${name(r.botId)}: ${r.what ?? "a card"}${via}`;
        break;
      case "todo":
        words = `to-do of ${name(r.botId)} ${r.what ?? ""}${via}`;
        break;
      case "stop":
        words = `pressed Stop on ${name(r.botId)}${via}`;
        break;
      case "stop-helper":
        words = `stopped ${name(r.botId)}'s ${r.what?.startsWith("task manager: ") ? `task manager ${q(r.what.slice(14))}` : `helper ${q(r.what ?? "")}`}${via}`;
        break;
      case "end-task-manager":
        words = `ended ${name(r.botId)}'s task manager ${q((r.what ?? "").replace(/^task manager: /, ""))}${via}`;
        break;
      case "question":
        words = `asked ${name(r.botId)} about ${r.what ?? "a card"}${via}`;
        break;
    }
    out.push({ t, kind: r.kind, ...(r.botId ? { botId: r.botId } : {}), words });
  }
  for (const i of items) {
    if (i.kind !== "user" || i.fromType !== "you") continue;
    const t = Date.parse(i.at);
    if (t < from || t >= to || noted.has(i.id)) continue;
    if (i.todoId && noted.has(i.todoId)) continue;
    // His question about a card is counted from its own row (engine 0.31.0).
    if (i.question) continue;
    // A message to a task manager: noted without its item's id, at the same time in the same thread.
    if (loose.some((r) => r.threadId === i.threadId && Math.abs(Date.parse(r.at) - t) < 5_000)) continue;
    const words = i.todoId
      ? `to-do of ${name(i.botId)} answered: ${i.todoTitle ?? ""}`
      : `message to ${name(i.botId)}${placeWords(ctx, i.threadId, i.threadKind, i.seq)}`;
    out.push({ t, kind: i.todoId ? "todo" : "message", botId: i.botId, words });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The bots' turns that started on the day, folded where they repeat. Tidy turns are left out. */
function findTurns(ctx: Ctx, items: ActivityItemRow[], from: number, to: number): Turn[] {
  const groups = new Map<string, ActivityItemRow[]>();
  for (const i of items) {
    if (!i.turnId || (i.threadKind !== "main" && i.threadKind !== "run")) continue;
    const g = groups.get(i.turnId);
    if (g) g.push(i);
    else groups.set(i.turnId, [i]);
  }
  const turns: Turn[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.seq - b.seq);
    const users = g.filter((i) => i.kind === "user");
    const starter = users.find((u) => !u.steered) ?? users[0];
    if (starter?.fromType === "app") continue;
    const work = g.filter((i) => i.kind !== "user");
    const start = work.length ? Math.min(...work.map((i) => Date.parse(i.at))) : Date.parse(starter!.at);
    if (!(start >= from && start < to)) continue;
    const end = Math.max(start, ...work.map((i) => Date.parse(i.at) + (i.durationMs ?? 0)));
    const first = g[0]!;
    const who = starterWords(ctx, starter);
    const title = ctx.eng.store.titleAt(first.threadId, starter?.seq ?? first.seq);
    turns.push({ botId: first.botId, start, end, ...who, ...(title ? { title } : {}), run: first.threadKind === "run", count: 1 });
  }
  turns.sort((a, b) => a.start - b.start);
  // Fold a bot's turns in a row with the same starter and title, closer than the gap.
  const out: Turn[] = [];
  const lastOf = new Map<string, Turn>();
  for (const t of turns) {
    const last = lastOf.get(t.botId);
    if (last && last.starter === t.starter && last.title === t.title && last.run === t.run && t.start - last.end <= ctx.gapMs) {
      last.end = Math.max(last.end, t.end);
      last.count++;
      continue;
    }
    out.push(t);
    lastOf.set(t.botId, t);
  }
  return out;
}

function starterWords(ctx: Ctx, u: ActivityItemRow | undefined): Pick<Turn, "starter" | "starterKind"> {
  if (!u) return { starter: "a helper or background task reported back", starterKind: "reported back" };
  switch (u.fromType) {
    case "you":
      return { starter: u.question ? "you, a question on a card" : u.todoId ? "you, from a to-do" : "you", starterKind: "you" };
    case "bot":
      if (u.fromTaskManager) return { starter: `its task manager ${q(u.fromTaskManager)}`, starterKind: "task manager" };
      return { starter: `bot ${ctx.names.get(u.fromBot ?? "") ?? u.fromBot ?? "unknown"}`, starterKind: "bot" };
    case "trigger": {
      const tr = u.fromTriggerId ? ctx.triggers.get(u.fromTriggerId) : undefined;
      const label = u.fromLabel ?? tr?.name ?? "a trigger";
      if (u.fromResult) return { starter: `the result of fresh run ${q(label)}`, starterKind: "fresh run" };
      if (tr?.kind === "webhook") return { starter: `webhook ${q(label)}`, starterKind: "webhook" };
      return { starter: tr ? `schedule ${q(label)}` : `trigger ${q(label)}`, starterKind: "schedule" };
    }
    case "channel": {
      const ch = q(ctx.channels.get(u.fromChannelId ?? "") ?? u.fromLabel ?? "a channel");
      const sender = u.fromSender?.trim();
      if (sender && ctx.me && sender.toLowerCase() === ctx.me) return { starter: `you, in channel ${ch}`, starterKind: "you" };
      return { starter: `channel ${ch}${sender ? `, from ${sender}` : ""}`, starterKind: "channel" };
    }
    default:
      return { starter: "something else", starterKind: "reported back" };
  }
}
