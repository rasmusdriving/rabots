// Ahead (protocol 31), the mock engine's side: the settings, the items, the view and the person's
// actions. The view is built as the engine builds it (engine/core/ahead-view.ts), from the items,
// the to-dos with a date and, with ?ahead=1, a few meetings.
//
// ?ahead= picks the start: (absent) off, on (on, nothing on it), 1 (on, with items of the scene's
// bots, a dated to-do, a meeting or two, an item from earlier and one later).
// Levers on window.pobotsAhead: state(), add(botId, title, dayOffset, kind?) adds an item as a bot
// would (the window then holds it behind "1 new · Show"), items().
import type { AheadCarry, AheadItem, AheadItemRow, AheadKind, AheadMeetingRow, AheadRow, AheadSettings, AheadView, Methods } from "../../shared/protocol";
import { AHEAD_DAYS, AHEAD_DEFAULTS } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { isoDay } from "./mock-data";
import { EngineError } from "./types";
import { MockAheadTime } from "./mock-ahead-time";

export interface AheadLevers {
  state(): AheadSettings;
  items(): AheadItem[];
  move(id: string, dayOffset: number): void;
  workDays(days: AheadSettings["workDays"]): void;
  add(botId: string | null, title: string, dayOffset: number, kind?: AheadKind, time?: string): string;
}

declare global {
  interface Window {
    pobotsAhead?: AheadLevers;
  }
}

const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return isoDay(new Date(y, m - 1, d + n));
};
const mondayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wd = new Date(y, m - 1, d).getDay();
  return addDays(day, -((wd + 6) % 7));
};

type Handlers = Pick<Methods, "ahead.view" | "ahead.settings.set" | "ahead.act" | "ahead.add" | "ahead.seen">;

export class MockAhead {
  settings: AheadSettings = { ...AHEAD_DEFAULTS };
  private list: AheadItem[] = [];
  private meetings: AheadMeetingRow[] = [];
  private n = 1;
  private time: MockAheadTime;

  constructor(private readonly mock: MockEngine, flag?: string) {
    if (flag === "on" || flag === "1") this.settings.enabled = true;
    if (flag === "1") this.seed();
    // Part B: "your time" (ui/engine/mock-ahead-time.ts).
    const self = this;
    this.time = new MockAheadTime({ get settings() { return self.settings; }, get list() { return self.list; }, meetingRows: () => self.meetings, put: (b, x) => self.put(b, x) }, mock, flag);
  }

  private seed(): void {
    const ids = this.mock.bots.map((b) => b.id);
    const [first, second, third] = [ids[0], ids[1] ?? ids[0], ids[2] ?? ids[0]];
    for (const id of [second, third]) if (id) this.mock.bots = this.mock.bots.map((b) => (b.id === id && b.role !== "main" ? { ...b, ahead: "items" } : b));
    if (first) this.put(first, { kind: "note", title: "Plan the week with the team", day: plusDays(0), time: "16:00" });
    if (second) {
      this.put(second, { kind: "will-do", title: "Send the sample summary", day: plusDays(1), time: "15:00", label: "Sample project", why: "Promised in the chat this morning." });
      this.put(second, { kind: "waiting", title: "Answer from the example team", day: plusDays(3) });
      this.put(second, { kind: "will-do", title: "Call back about the report", day: plusDays(-2) });
    }
    if (third) {
      this.put(third, { kind: "deadline", title: "Quarter report due", day: plusDays(6), label: "Reports" });
      this.put(third, { kind: "deadline", title: "Year plan due", day: plusDays(40) });
    }
    this.put(null, { kind: "note", title: "Dentist", day: plusDays(2), time: "08:30" });
    this.meetings = [
      { source: "meeting", key: "meeting:m1", day: plusDays(1), time: "10:00", end: "10:30", title: "Weekly sync" },
      { source: "meeting", key: "meeting:m2", day: plusDays(1), time: "12:00", end: "13:00", title: "Lunch walk", free: true },
      { source: "meeting", key: "meeting:m3", day: plusDays(4), allDay: true, title: "Team day" },
    ];
  }

  private put(botId: string | null, p: Pick<AheadItem, "kind" | "title" | "day"> & Partial<AheadItem>): AheadItem {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const item: AheadItem = { id: `ahd_mock${this.n++}`, ...(botId ? { botId } : {}), state: "open", createdAt: at, changedAt: at, changedBy: botId ? "bot" : "you", ...p };
    this.list.push(item);
    return item;
  }

  private needOn(): void {
    if (!this.settings.enabled) throw new EngineError({ code: "bad_request", message: "Ahead is off. Switch it on in Settings, Ahead." });
  }

  view(p: Methods["ahead.view"]["params"]): AheadView {
    this.needOn();
    const readAt = new Date().toISOString();
    const today = plusDays(0);
    const from = p?.from ?? today;
    const to = addDays(from, (p?.days ?? AHEAD_DAYS) - 1);
    const live = (botId?: string) => !botId || this.mock.bots.some((b) => b.id === botId);
    const away = (botId?: string) => !!botId && !!this.mock.bots.find((b) => b.id === botId)?.vacationSince;
    const all: AheadRow[] = [
      ...this.list.filter((i) => i.state === "open" && live(i.botId)).map((i) => this.row(i, away(i.botId))),
      ...this.mock
        .todosState()
        .filter((t) => t.due && t.due.slice(0, 10) >= today && live(t.botId) && !away(t.botId))
        .map((t) => ({ source: "todo" as const, key: `todo:${t.id}`, day: t.due!.slice(0, 10), ...(/T(\d{2}:\d{2})/.exec(t.due!) ? { time: /T(\d{2}:\d{2})/.exec(t.due!)![1] } : {}), todoId: t.id, botId: t.botId, title: t.title })),
      ...this.mock.triggers.flatMap((t) => {
        if (!t.enabled || t.schedule?.type !== "once" || !t.nextAt || !live(t.botId) || away(t.botId)) return [];
        const next = new Date(t.nextAt);
        const day = isoDay(next);
        if (day < today) return [];
        const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next);
        return [{ source: "run" as const, key: `run:${t.id}`, day, time, triggerId: t.id, botId: t.botId, title: t.name }];
      }),
    ];
    const rows: AheadRow[] = [];
    const earlier: AheadRow[] = [];
    const later: AheadRow[] = [];
    for (const r of all) {
      if (r.day < from) {
        if (r.source === "item" && r.day < today) earlier.push(r);
      } else if (r.day > to) later.push(r);
      else rows.push(r);
    }
    rows.push(...this.meetings.filter((m) => m.day >= from && m.day <= to));
    const title = (r: AheadRow) => (r.source === "item" ? r.item.title : r.title);
    const by = (a: AheadRow, b: AheadRow) => a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "") || title(a).localeCompare(title(b));
    const since = mondayOf(today);
    const done = this.list
      .filter((i) => i.state !== "open" && i.changedAt.slice(0, 10) >= since)
      .map((i) => ({ source: "item" as const, key: `item:${i.id}`, day: i.day, item: i }));
    const end = addDays(since, 6);
    const carrying = this.mock.bots.map((b): AheadCarry => {
      const own = all.filter((r) => (r.source === "item" ? r.item.botId : r.source === "meeting" ? undefined : r.botId) === b.id);
      const todos = b.vacationSince ? [] : this.mock.todosState().filter((t) => t.botId === b.id);
      const cards = b.vacationSince ? 0 : this.mock.cards.filter((c) => c.kind !== "system" && c.botId === b.id).length;
      const due = (day?: string) => !!day && day >= since && day <= end;
      return { botId: b.id, onAhead: own.length, due: own.filter((r) => r.source !== "todo" && due(r.day)).length + todos.filter((t) => due(t.due?.slice(0, 10))).length,
        waiting: cards + todos.length + (b.role === "main" ? 0 : own.filter((r) => r.source === "item" && r.item.kind === "your-time" && r.day <= end).length), helpers: b.workingHelpers?.filter((h) => !h.managerId).length ?? 0,
        managers: b.taskManagers?.filter((m) => m.state === "working").length ?? 0 };
    }).filter((c) => c.onAhead || c.waiting || c.helpers || c.managers);
    return { today, from, to, rows: rows.sort(by), earlier: earlier.sort(by), later: later.sort(by), done, meetings: this.meetings.length ? "on" : "none",
      screen: { carrying, readAt, seenAt: this.settings.lastOpenedAt, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
  }

  private row(item: AheadItem, away: boolean): AheadItemRow {
    const at = this.settings.lastOpenedAt;
    let changed: AheadItemRow["changed"];
    if (at && item.changedAt > at && item.changedBy !== "you") {
      changed = item.createdAt > at ? { kind: "new" } : item.movedFrom ? { kind: "moved", from: item.movedFrom } : undefined;
    }
    return { source: "item", key: `item:${item.id}`, day: item.day, time: item.time, item, ...(away ? { away: true } : {}), changed };
  }

  readonly handlers: { [K in keyof Handlers]: (p: Handlers[K]["params"]) => Handlers[K]["result"] } = {
    "ahead.view": (p) => this.view(p),
    "ahead.settings.set": (p) => {
      this.settings = { ...this.settings, ...p };
      this.mock.emit({ event: "ahead.changed", data: { ahead: this.settings } });
      return { ahead: this.settings };
    },
    "ahead.act": (p) => {
      this.needOn();
      const placed = this.time.act(p);
      if (placed) return placed;
      const i = this.list.findIndex((x) => x.id === p.itemId);
      if (i < 0) throw new EngineError({ code: "not_found", message: "That item is no longer on Ahead." });
      const was = this.list[i]!;
      const next: AheadItem = { ...was, changedAt: new Date().toISOString(), changedBy: "you" };
      if (p.action === "done") next.state = "done";
      else if (p.action === "drop") next.state = "dropped";
      else if (p.action === "reopen") next.state = "open";
      else {
        if (!p.day) throw new EngineError({ code: "bad_request", message: "Pick a day." });
        if (p.day !== was.day) next.movedFrom = was.day;
        next.day = p.day;
        if (p.time === null) delete next.time;
        else if (p.time) next.time = p.time;
        next.state = "open";
      }
      this.list[i] = next;
      this.mock.emit({ event: "ahead.items", data: {} });
      return { item: next };
    },
    "ahead.add": (p) => {
      this.needOn();
      const item = this.put(null, { kind: p.kind ?? "note", title: p.title, day: p.day, ...(p.time ? { time: p.time } : {}), ...(p.label ? { label: p.label } : {}) });
      this.mock.emit({ event: "ahead.items", data: {} });
      return { item };
    },
    "ahead.seen": (p) => {
      if (!this.settings.enabled) return { ahead: this.settings };
      const now = new Date().toISOString();
      const at = p?.through && p.through < now ? p.through : now;
      if (!this.settings.lastOpenedAt || at > this.settings.lastOpenedAt) {
        this.settings = { ...this.settings, lastOpenedAt: at };
        this.mock.emit({ event: "ahead.changed", data: { ahead: this.settings } });
      }
      return { ahead: this.settings };
    },
  };

  levers(): AheadLevers {
    return {
      state: () => this.settings,
      items: () => this.list,
      workDays: (workDays) => { this.handlers["ahead.settings.set"]({ workDays }); },
      move: (id, dayOffset) => {
        const item = this.list.find((i) => i.id === id);
        if (!item) return;
        const day = plusDays(dayOffset);
        if (day === item.day) return;
        this.list = this.list.map((i) => i.id === id ? { ...i, day, movedFrom: i.day, changedBy: "bot", changedAt: new Date().toISOString() } : i);
        this.mock.emit({ event: "ahead.items", data: {} });
      },
      add: (botId, title, dayOffset, kind = "note", time) => {
        const item = this.put(botId, { kind, title, day: plusDays(dayOffset), ...(time ? { time } : {}), createdAt: new Date().toISOString(), changedAt: new Date().toISOString() });
        this.mock.emit({ event: "ahead.items", data: {} });
        return item.id;
      },
    };
  }
}
