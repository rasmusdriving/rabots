// The Ahead view (engine 0.39.0, docs/build/step-ahead.md): one read that gathers what is coming for
// a range of days, from each source: Ahead items, to-dos with a date, one-off scheduled runs that are
// on, and meetings when the calendar is set up. Nothing here is computed while Ahead is off.
//
// Sources are a list (SOURCES) so part B and C can add theirs without editing the others.
import type { Engine } from "../engine.js";
import type { AheadItem, AheadItemRow, AheadRow, AheadSettings, AheadView, Methods } from "../../shared/protocol.js";
import { AHEAD_DAYS } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { aheadSettings } from "./ahead-settings.js";
import { aheadMeetings } from "./ahead-meetings.js";
import { settleYourTime } from "./ahead-time.js";
import { addDays, dayOf, isDay, mondayOf, startOf, timeOf } from "./ahead-days.js";
import { away } from "./vacation.js";
import { aheadCarrying } from "./ahead-carrying.js";
import { openBlockIds } from "./todo-blocks.js";
import { followOutlook } from "./todo-block-sync.js";

interface Range {
  today: string;
  from: string;
  to: string;
  settings: AheadSettings;
}

/** Every row a source has on or after `from` (and before it for "From earlier" where it applies). */
type Source = (eng: Engine, r: Range) => AheadRow[];

export function itemRow(eng: Engine, item: AheadItem, settings: AheadSettings): AheadItemRow {
  const rt = item.botId ? eng.bots.get(item.botId) : undefined;
  const seen = settings.lastOpenedAt;
  let changed: AheadItemRow["changed"];
  if (seen && item.changedBy !== "you" && item.changedAt > seen) {
    changed = item.createdAt > seen ? { kind: "new" } : item.movedFrom ? { kind: "moved", from: item.movedFrom } : undefined;
  }
  return {
    source: "item",
    key: `item:${item.id}`,
    day: item.day,
    ...(item.time ? { time: item.time } : {}),
    item,
    ...(away(rt) ? { away: true as const } : {}),
    ...(changed ? { changed } : {}),
  };
}

const items: Source = (eng, r) =>
  eng.store.ahead
    .list()
    // A retired bot's items are kept in the store and left out here.
    .filter((i) => !i.botId || eng.bots.has(i.botId))
    .map((i) => itemRow(eng, i, r.settings));

const todos: Source = (eng, r) => {
  const out: AheadRow[] = [];
  // A to-do with an open block shows only as its block (engine 0.41.0).
  const blocked = openBlockIds(eng);
  for (const t of eng.store.openTodos()) {
    // As the to-do list: a bot on vacation keeps its to-dos out of sight.
    if (!t.due || blocked.has(t.id) || !eng.bots.has(t.botId) || away(eng.bots.get(t.botId))) continue;
    const day = t.due.slice(0, 10);
    if (!isDay(day) || day < r.today) continue;
    const time = /T(\d{2}:\d{2})/.exec(t.due)?.[1];
    out.push({ source: "todo", key: `todo:${t.id}`, day, ...(time ? { time } : {}), todoId: t.id, botId: t.botId, title: t.title });
  }
  return out;
};

const runs: Source = (eng, r) => {
  const out: AheadRow[] = [];
  for (const row of eng.store.listTriggers()) {
    if (row.kind !== "schedule" || row.schedule?.type !== "once" || !row.enabled || !row.nextAt) continue;
    const rt = eng.bots.get(row.botId);
    if (!rt || away(rt)) continue;
    const t = Date.parse(row.nextAt);
    if (!Number.isFinite(t)) continue;
    const day = dayOf(t, eng.tz);
    if (day < r.today) continue;
    out.push({ source: "run", key: `run:${row.id}`, day, time: timeOf(t, eng.tz), triggerId: row.id, botId: row.botId, title: row.name });
  }
  return out;
};

/** The sources besides meetings, in order. Part B and C add theirs here. */
export const SOURCES: Source[] = [items, todos, runs];

/** Whole-day rows first, then by time, then by title, so the order stays put between reads. */
function byTime(a: AheadRow, b: AheadRow): number {
  return a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "") || titleOf(a).localeCompare(titleOf(b)) || a.key.localeCompare(b.key);
}

const titleOf = (r: AheadRow) => (r.source === "item" ? r.item.title : r.title);

export async function aheadView(eng: Engine, params: Methods["ahead.view"]["params"] = {}): Promise<AheadView> {
  const settings = aheadSettings(eng);
  if (!settings.enabled) throw new EngineError("bad_request", "Ahead is off. Switch it on in Settings, Ahead.");
  const today = dayOf(eng.clock(), eng.tz);
  if (params.from !== undefined && !isDay(params.from)) throw new EngineError("bad_request", "from is a day as YYYY-MM-DD.");
  const days = Math.max(1, Math.min(62, Math.round(params.days ?? AHEAD_DAYS)));
  const from = params.from ?? today;
  const to = addDays(from, days - 1);
  const range: Range = { today, from, to, settings };

  await settleYourTime(eng, from, to);
  // Blocks the person moved or deleted in Outlook follow before the rows are gathered.
  const meetingsRead = aheadMeetings(eng, from, to);
  await followOutlook(eng, await meetingsRead);
  const rows: AheadRow[] = [];
  const earlier: AheadRow[] = [];
  const later: AheadRow[] = [];
  const readAt = new Date(eng.clock()).toISOString();
  const sourceRows = SOURCES.flatMap((source) => source(eng, range));
  const carrying = aheadCarrying(eng, today, sourceRows);
  for (const row of sourceRows) {
    if (row.day < from) {
      if (row.source === "item" && row.day < today) earlier.push(row);
    } else if (row.day > to) later.push(row);
    else rows.push(row);
  }

  const since = new Date(startOf(mondayOf(today), eng.tz)).toISOString();
  const done = eng.store.ahead
    .closedSince(since)
    .filter((i) => !i.botId || eng.bots.has(i.botId))
    .map((i) => itemRow(eng, i, settings));

  const m = await meetingsRead;
  if (m.state === "on") rows.push(...m.rows.filter((r) => r.day >= from && r.day <= to));

  return {
    today,
    from,
    to,
    rows: rows.sort(byTime),
    earlier: earlier.sort(byTime),
    later: later.sort(byTime),
    done,
    meetings: m.state,
    screen: { carrying, readAt, seenAt: settings.lastOpenedAt, timeZone: eng.tz },
  };
}
