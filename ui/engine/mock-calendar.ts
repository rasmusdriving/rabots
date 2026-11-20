// The calendar tools (engine 0.25.0), the mock engine's side: the connection in the settings window,
// a meeting waiting on an approval card and the lines a calendar action leaves in the chat.
//
// ?calendar= picks the start: (absent) not set up, set (set up, nothing waiting), 1 (set up, and Kaja
// has a meeting waiting on a card with a line of one it made and one that failed), fail (set up, but
// the check fails), google (set up, a Google script). Addresses are made up, on example.com.
// Levers on window.pobotsCalendar: state(), addMeetingCard(kind) adds a card and returns its id,
// connect() sets the calendar up, setupTurn() writes Pobots' line and Kaja's setup turn (protocol 33).
import type { ActivityItem, BotItem, CalendarService, CalendarState, CardMeeting, Methods, NoticeItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { minutesAgo } from "./mock-data";
import { EngineError } from "./types";

export interface CalendarLevers {
  state(): CalendarState;
  addMeetingCard(kind?: "create" | "move" | "respond"): string;
  /** The calendar set up as if the person saved its address (protocol 33: the line on Ahead). */
  connect(): void;
  /** Ahead switched on without a calendar: Pobots' line in Kaja's chat, then Kaja's setup turn, as the engine writes them. */
  setupTurn(): void;
}

declare global {
  interface Window {
    pobotsCalendar?: CalendarLevers;
  }
}

export const CAL_MAILBOX = { name: "Robin Example", address: "robin@example.com" };
export const CAL_SUBJECT = "Nordvik kickoff";
const TZ = "Europe/Stockholm";

/** A time on a coming weekday, in UTC: days ahead and an hour of the clock in Stockholm (winter: UTC+1). */
function ahead(days: number, hour: number, min = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour - 1, min, 0, 0);
  return d.toISOString();
}

export function meetingFor(kind: "create" | "move" | "respond"): CardMeeting {
  const start = ahead(2, 10);
  const end = ahead(2, 11);
  if (kind === "move")
    return {
      action: "move",
      subject: "Weekly sync",
      start: ahead(3, 13),
      end: ahead(3, 13, 30),
      was: { start: ahead(2, 9), end: ahead(2, 9, 30) },
      timeZone: TZ,
      attendees: [{ name: "Alex Lund", address: "alex@example.com", internal: true, free: true }],
      teams: true,
    };
  if (kind === "respond")
    return {
      action: "respond",
      subject: "Partner demo",
      start,
      end,
      timeZone: TZ,
      organizer: "Sam Berg <sam@partner.example.org>",
      attendees: [],
      teams: true,
      response: "accept",
      message: "Thanks, see you there.",
    };
  return {
    action: "create",
    subject: CAL_SUBJECT,
    start,
    end,
    timeZone: TZ,
    attendees: [
      { name: "Alex Lund", address: "alex@example.com", internal: true, free: true },
      { name: "Kim Nordvik", address: "kim@nordvik.example.net", internal: false },
    ],
    teams: true,
    message: "Kickoff for the Nordvik onboarding: scope, timeline and who does what.",
    ownClash: "Lunch (12:00 to 13:00)",
  };
}

const TITLES = { create: "Book this meeting?", move: "Move this meeting?", respond: "Accept this invitation?" };

export class MockCalendar {
  private s: CalendarState;
  private readonly failCheck: boolean;

  constructor(
    private readonly mock: MockEngine,
    flag: string | undefined,
  ) {
    this.failCheck = flag === "fail";
    const on = flag === "1" || flag === "set" || flag === "fail" || flag === "google";
    this.s = on ? this.connected(flag === "google" ? "google" : "outlook") : { connected: false, service: "outlook", internalDomains: [], domainsSet: false };
  }

  private connected(service: CalendarService = "outlook"): CalendarState {
    if (this.failCheck)
      return { connected: true, service, checkedAt: minutesAgo(3), problem: "The calendar flow said no (status 401). The flow may be off, or the address in Pobots is not its current one.", internalDomains: [], domainsSet: false };
    return { connected: true, service, mailbox: { ...CAL_MAILBOX }, checkedAt: minutesAgo(3), internalDomains: ["example.com"], domainsSet: false };
  }

  levers(): CalendarLevers {
    return {
      state: () => structuredClone(this.s),
      addMeetingCard: (kind = "create") => this.addMeetingCard(kind),
      connect: () => {
        this.s = this.connected();
        this.changed();
      },
      setupTurn: () => {
        const kaja = this.mock.bot("kaja");
        const line = this.mock.add<NoticeItem>(kaja.mainThreadId, { kind: "notice", tone: "info", text: "You switched on Ahead. Your calendar is not set up yet, so the setup starts here.", startsTurn: true });
        this.mock.upsert(line);
        const said = this.mock.add<BotItem>(kaja.mainThreadId, { kind: "bot", botId: "kaja", streaming: false, turnId: `setup-${line.id}`, text: "Ahead needs your calendar. Do you have Power Automate with premium connectors?" });
        this.mock.upsert(said);
      },
    };
  }

  private changed(): void {
    this.mock.emit({ event: "calendar.changed", data: { calendar: structuredClone(this.s) } });
  }

  readonly handlers = {
    "calendar.get": (_p: Methods["calendar.get"]["params"]): Methods["calendar.get"]["result"] => ({ calendar: structuredClone(this.s) }),
    "calendar.set": (p: Methods["calendar.set"]["params"]): Methods["calendar.set"]["result"] => {
      if (p.address !== undefined) {
        const a = p.address.trim();
        if (!a) this.s = { connected: false, service: "outlook", internalDomains: this.s.domainsSet ? this.s.internalDomains : [], domainsSet: this.s.domainsSet };
        else {
          if (!/^https:\/\//.test(a) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(a)) throw new EngineError({ code: "bad_request", message: "The flow's address must start with https://." });
          const domains = this.s.domainsSet ? this.s.internalDomains : null;
          // Like the engine: a Google script's address is on script.google.com (protocol 33).
          this.s = this.connected(/^https:\/\/script\.google\.com\//.test(a) ? "google" : "outlook");
          if (domains) this.s = { ...this.s, internalDomains: domains, domainsSet: true };
        }
      }
      if (p.internalDomains !== undefined) {
        const d = p.internalDomains.map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
        for (const x of d) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)) throw new EngineError({ code: "bad_request", message: `${x} is not an email domain. Write it like example.com.` });
        this.s = d.length ? { ...this.s, internalDomains: [...new Set(d)], domainsSet: true } : { ...this.s, internalDomains: this.s.mailbox ? [this.s.mailbox.address.split("@")[1]!] : [], domainsSet: false };
      }
      this.changed();
      return { calendar: structuredClone(this.s) };
    },
    "calendar.test": (_p: Methods["calendar.test"]["params"]): Methods["calendar.test"]["result"] => {
      if (this.s.connected) this.s = { ...this.s, checkedAt: new Date().toISOString() };
      this.changed();
      return { calendar: structuredClone(this.s) };
    },
  };

  /** A meeting card from Kaja; on Approve a "Created" line follows in its chat, as the engine writes it. */
  addMeetingCard(kind: "create" | "move" | "respond"): string {
    const kaja = this.mock.bot("kaja");
    const meeting = meetingFor(kind);
    const id = `c${this.mock.nextId++}`;
    const card = {
      kind: "approval" as const,
      id,
      botId: kaja.id,
      threadId: kaja.mainThreadId,
      at: new Date().toISOString(),
      title: TITLES[kind],
      detail: `${meeting.subject}\n${meeting.attendees.map((a) => a.address).join(", ")}`,
      caption: "Calendar",
      noAlways: true,
      meeting,
    };
    this.mock.cards.push(card);
    this.mock.emit({ event: "card.added", data: { card } });
    this.mock.onAllow.set(id, () => {
      const verb = kind === "move" ? "Moved" : kind === "respond" ? "Accepted" : "Created";
      const n = this.mock.add<NoticeItem>(kaja.mainThreadId, { kind: "notice", tone: "info", text: `${verb} ${meeting.subject} (${dayTime(meeting.start)})`, mark: "calendar", detail: `${meeting.subject}\nTeams meeting.` });
      this.mock.upsert(n);
    });
    return id;
  }

  /** Kaja's chat: a block it made at once, a meeting that waits on the card, and a move that failed. */
  seed(): void {
    const kaja = this.mock.bots.find((b) => b.id === "kaja");
    if (!kaja) return;
    const t = kaja.mainThreadId;
    const turn = "tk-cal";
    this.mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: turn, text: "Block two hours on Thursday morning for the Nordvik report." }, minutesAgo(40));
    this.mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId: turn, label: "Booked Nordvik report", status: "done", durationMs: 2_000 }, minutesAgo(39));
    this.mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId: turn, text: "Done: Thursday 08:00 to 10:00 is blocked for the Nordvik report." }, minutesAgo(39));
    this.mock.add<NoticeItem>(t, { kind: "notice", tone: "info", text: `Created Nordvik report (${dayTime(ahead(3, 8))})`, mark: "calendar", detail: `Nordvik report\n${dayTime(ahead(3, 8))} to 10:00 (${TZ})\nTeams meeting: a link is added.` }, minutesAgo(39));
    const failed = "tk-cal-failed";
    this.mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: failed, text: "Move the weekly sync to Friday at 13:00." }, minutesAgo(12));
    this.mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId: failed, label: "Could not move a meeting", status: "failed", durationMs: 30_000, detail: "The flow did not answer in time. The move may still have happened; check the calendar before trying again." }, minutesAgo(11));
    this.mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId: failed, text: "The flow did not answer in time, so the move may still have happened. I will look at the calendar before trying again." }, minutesAgo(11));
    this.mock.add<NoticeItem>(t, { kind: "notice", tone: "error", text: "Could not move Weekly sync: no answer in time. Check the calendar before trying again", mark: "calendar", detail: `Weekly sync\n${dayTime(ahead(4, 13))} to 13:30 (${TZ})` }, minutesAgo(11));
    this.addMeetingCard("create");
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 18 Nov 10:00" in Stockholm, as the engine words it. */
function dayTime(isoTime: string): string {
  const d = new Date(isoTime);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = DAYS.findIndex((x) => get("weekday").startsWith(x));
  return `${DAYS[wd] ?? get("weekday")} ${Number(get("day"))} ${MONTHS[Number(get("month")) - 1]} ${get("hour")}:${get("minute")}`;
}
