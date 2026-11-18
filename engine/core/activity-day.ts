// A day's activity for the window (engine 0.30.0, docs/build/step-activity-day-view.md): the same
// reading as the main bot's activity_log (core/activity-log.ts readDay), given as rows in time order
// instead of text. Read only; nothing new is collected. Labels only, the tool's own words.
//
// As T3 Code shows a read-only page in its settings list (apps/web/src/components/settings/
// DiagnosticsSettings.tsx), this only answers what the page asks; nothing is pushed.

import type { ActivityDay, ActivityRow, ActivityRowKind } from "../../shared/protocol.js";
import { dayStart, minutesWords, parseWhen } from "../calendar-time.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { wallOf } from "../schedule.js";
import { activeMinutes, calendarWords, ctxFor, emptyDay, helperModel, postWords, q, readDay, turnWords } from "./activity-log.js";

/** At most this many rows; the rest is counted in `more`. */
export const DAY_ROWS = 500;
/** His actions closer than this many minutes are one block, as the tool's default. */
const GAP_MINUTES = 15;
const MIN = 60_000;
const ORDER: ActivityRowKind[] = ["you", "turn", "helper", "calendar", "post"];

export function activityDayFor(eng: Engine, dayAsked?: string): ActivityDay {
  const tz = eng.tz;
  const today = dayStart(eng.clock(), tz);
  let from = today;
  if (dayAsked !== undefined && dayAsked.trim()) {
    const v = dayAsked.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new EngineError("bad_request", "The day must be a date as YYYY-MM-DD.");
    const p = Number(v.slice(0, 4)) >= 2000 ? parseWhen(v, tz) : undefined;
    if (!p) throw new EngineError("bad_request", "That is not a date.");
    from = dayStart(p.t, tz);
    if (from > today) throw new EngineError("bad_request", "That day has not come yet.");
  }
  const ctx = ctxFor(eng, GAP_MINUTES);
  const d = readDay(ctx, from);
  const out: ActivityDay = {
    day: ymd(from, tz),
    today: ymd(today, tz),
    tz,
    summary: [],
    rows: [],
  };
  if (emptyDay(d)) return out;

  const rows: (ActivityRow & { t: number })[] = [];
  const row = (t: number, end: number | undefined, kind: ActivityRowKind, botId: string | undefined, who: string, words: string) =>
    rows.push({ t, time: d.hm(t), ...(end !== undefined && end - t >= MIN ? { end: d.hm(end) } : {}), kind, ...(botId ? { botId } : {}), who, words: cap(words) });

  for (const a of d.actions) row(a.t, undefined, "you", a.botId, "You", a.words);
  for (const t of d.turns) {
    const lead = t.starterKind === "reported back" && t.starter.startsWith("a helper") ? "worked after " : "worked, started by ";
    row(t.start, t.end, "turn", t.botId, d.name(t.botId), lead + turnWords(t));
  }
  for (const h of d.helpers) {
    const model = helperModel(eng, h);
    const what = h.taskManager ? "task manager" : "helper";
    const start = Date.parse(h.at);
    row(start, h.endedAt ? Date.parse(h.endedAt) : undefined, "helper", h.botId, d.name(h.botId), `${what} ${q(h.title ?? "")}${model ? ` (${model})` : ""}, ${h.status ?? "unknown"}`);
  }
  for (const c of d.calendar) row(Date.parse(c.at), undefined, "calendar", c.botId, d.name(c.botId), calendarWords(ctx, c));
  for (const p of d.posts) row(Date.parse(p.at), undefined, "post", p.botId, d.name(p.botId), postWords(ctx, p));
  rows.sort((a, b) => a.t - b.t || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  out.rows = rows.slice(0, DAY_ROWS).map(({ t: _t, ...r }) => r);
  if (rows.length > DAY_ROWS) out.more = rows.length - DAY_ROWS;
  out.summary = summaryOf(d);
  return out;
}

function summaryOf(d: ReturnType<typeof readDay>): string[] {
  const lines: string[] = [];
  if (d.actions.length) {
    const times = d.actions.map((a) => a.t).sort((x, y) => x - y);
    const n = d.blocks.length;
    lines.push(
      times.length === 1
        ? `Your one action was at ${d.hm(times[0]!)}.`
        : `You were active from ${d.hm(times[0]!)} to ${d.hm(times[times.length - 1]!)}: ${minutesWords(activeMinutes(d))} over ${n} block${n === 1 ? "" : "s"}.`,
    );
  } else lines.push("No actions of yours.");
  const turns = d.turns.reduce((s, t) => s + t.count, 0);
  const managers = d.helpers.filter((h) => h.taskManager).length;
  const parts = [
    counts(d.actions.length, "action"),
    counts(turns, "bot turn"),
    counts(d.helpers.length - managers, "helper"),
    counts(managers, "task manager"),
    counts(d.calendar.length, "calendar action"),
    counts(d.posts.length, "channel post"),
  ].filter(Boolean);
  if (parts.length) lines.push(`${cap(parts.join(", "))}.`);
  return lines;
}

function counts(n: number, noun: string): string {
  return n ? `${n} ${noun}${n === 1 ? "" : "s"}` : "";
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function ymd(t: number, tz: string): string {
  const w = wallOf(t, tz);
  return `${w.y}-${String(w.mo + 1).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
