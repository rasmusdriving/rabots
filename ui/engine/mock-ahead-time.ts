// Ahead part B in the mock engine: "your time" items, the person's place choices and the week note.
// The slot is found simply (working hours, around other "your time" items and meetings, 30 minutes
// from now); the real placement is engine/core/ahead-slots.ts.
//
// ?ahead=time: Ahead on, two "your time" items today and tomorrow (one placed late), a week note.
// Levers on window.pobotsAheadTime: yourTime(botId, title, dayOffset, time, minutes) adds one as a
// bot would; weekNote(text) sets or clears the note as the main bot would; running(id) puts the
// slot's start a minute ago so "Now" shows.
import type { AheadItem, AheadMeetingRow, AheadSettings, Methods } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { isoDay } from "./mock-data";
import { EngineError } from "./types";

export interface AheadTimeHost {
  settings: AheadSettings;
  list: AheadItem[];
  meetingRows(): AheadMeetingRow[];
  put(botId: string | null, p: Pick<AheadItem, "kind" | "title" | "day"> & Partial<AheadItem>): AheadItem;
}

export interface AheadTimeLevers {
  yourTime(botId: string, title: string, dayOffset: number, time: string, minutes?: number): string;
  weekNote(text: string): void;
  running(id: string): void;
}

declare global {
  interface Window {
    pobotsAheadTime?: AheadTimeLevers;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return isoDay(new Date(y, m - 1, d + n));
};
const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const hhmm = (n: number) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const weekday = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return KEYS[new Date(y, m - 1, d).getDay()]!;
};

export class MockAheadTime {
  constructor(
    private readonly host: AheadTimeHost,
    private readonly mock: MockEngine,
    flag?: string,
  ) {
    if (flag === "time") this.seed();
    window.pobotsAheadTime = this.levers();
  }

  private seed(): void {
    this.host.settings.enabled = true;
    const bots = this.mock.bots.filter((b) => b.role !== "main");
    const [a, b] = [bots[0], bots[1] ?? bots[0]];
    if (a) this.mock.bots = this.mock.bots.map((x) => (x.id === a.id ? { ...x, ahead: "time" } : x));
    if (b && b !== a) this.mock.bots = this.mock.bots.map((x) => (x.id === b.id ? { ...x, ahead: "time" } : x));
    const now = new Date();
    // An hour from now, so it never runs by itself during a check; tomorrow morning late at night.
    const soon = Math.ceil((now.getHours() * 60 + now.getMinutes() + 60) / 5) * 5;
    const late = soon > 23 * 60 + 25;
    if (a) this.host.put(a.id, { kind: "your-time", title: "Look at the draft plan", day: plusDays(late ? 1 : 0), time: late ? "09:00" : hhmm(soon), minutes: 30, why: "So it can go out by Friday.", link: { threadId: a.mainThreadId } });
    if (b) this.host.put(b.id, { kind: "your-time", title: "Check the numbers in the sample report", day: plusDays(1), time: "10:35", minutes: 20, latestBy: plusDays(0) });
    this.host.settings.weekNote = { text: "A calm week. Two reviews on Tuesday; keep Thursday morning free.", at: new Date().toISOString() };
  }

  /** The first free slot from `from` (an instant, local), as the engine finds it, kept simple. */
  private slot(item: AheadItem, fromDay: string, fromMin: number, onlyThatDay = false): { day: string; time: string } | null {
    const s = this.host.settings;
    const minutes = item.minutes ?? 30;
    for (let n = 0; n < 31; n++) {
      const day = addDays(fromDay, n);
      if (!s.workDays.includes(weekday(day))) continue;
      const busy = [
        ...this.host.list.filter((i) => i.id !== item.id && i.state === "open" && i.kind === "your-time" && i.day === day && i.time).map((i) => [mins(i.time!), mins(i.time!) + (i.minutes ?? 30)] as const),
        ...this.host.meetingRows().filter((m) => m.day === day && !m.free && m.time).map((m) => [mins(m.time!), m.end ? mins(m.end) : mins(m.time!) + 30] as const),
      ];
      let t = Math.max(mins(s.workStart), n === 0 ? Math.ceil(fromMin / 5) * 5 : 0);
      for (;;) {
        if (t + minutes > mins(s.workEnd)) break;
        const clash = busy.filter(([a, b]) => a < t + minutes + 5 && b > t - 5).sort((x, y) => y[1] - x[1])[0];
        if (!clash) return { day, time: hhmm(t) };
        t = Math.ceil((clash[1] + 5) / 5) * 5;
      }
      if (onlyThatDay) return null;
    }
    return null;
  }

  /** ahead.act on a "your time" item with a place (or a picked time). Undefined when it is not one. */
  act(p: Methods["ahead.act"]["params"]): Methods["ahead.act"]["result"] | undefined {
    if (!p.place) return undefined;
    const i = this.host.list.findIndex((x) => x.id === p.itemId);
    if (i < 0) throw new EngineError({ code: "not_found", message: "That item is no longer on Ahead." });
    const was = this.host.list[i]!;
    if (was.kind !== "your-time") throw new EngineError({ code: "bad_request", message: "Only your-time is placed by Pobots. Pick a day instead." });
    const now = new Date();
    const today = plusDays(0);
    const nowMin = now.getHours() * 60 + now.getMinutes() + 30;
    let found: { day: string; time: string } | null;
    if (p.place === "today") {
      const after = was.day === today && was.time ? Math.max(nowMin, mins(was.time) + (was.minutes ?? 30)) : nowMin;
      found = this.slot(was, today, after, true);
      if (!found) throw new EngineError({ code: "bad_request", message: "There is no free slot left today. Try Tomorrow or Next free slot." });
    } else if (p.place === "tomorrow") found = this.slot(was, addDays(today, 1), 0);
    else if (p.place === "next") found = this.slot(was, today, nowMin);
    else {
      const d = new Date();
      const monday = addDays(today, 7 - ((d.getDay() + 6) % 7));
      found = this.slot(was, monday, 0);
    }
    if (!found) throw new EngineError({ code: "bad_request", message: "There is no free slot in the next 31 days. Pick a time instead." });
    const next: AheadItem = { ...was, day: found.day, time: found.time, state: "open", changedAt: new Date().toISOString(), changedBy: "you", ...(found.day !== was.day ? { movedFrom: was.day } : {}) };
    this.host.list[i] = next;
    this.mock.emit({ event: "ahead.items", data: {} });
    return { item: next };
  }

  levers(): AheadTimeLevers {
    return {
      yourTime: (botId, title, dayOffset, time, minutes = 30) => {
        const at = new Date().toISOString();
        const item = this.host.put(botId, { kind: "your-time", title, day: plusDays(dayOffset), time, minutes, createdAt: at, changedAt: at });
        this.mock.emit({ event: "ahead.items", data: {} });
        return item.id;
      },
      weekNote: (text) => {
        if (text) this.host.settings.weekNote = { text, at: new Date().toISOString() };
        else delete this.host.settings.weekNote;
        this.mock.emit({ event: "ahead.changed", data: { ahead: { ...this.host.settings } } });
      },
      running: (id) => {
        const i = this.host.list.findIndex((x) => x.id === id);
        if (i < 0) return;
        const d = new Date(Date.now() - 60_000);
        this.host.list[i] = { ...this.host.list[i]!, day: isoDay(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
        this.mock.emit({ event: "ahead.items", data: {} });
      },
    };
  }
}
