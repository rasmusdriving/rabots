// The calendar tools' work (engine 0.25.0, docs/build/step-calendar.md). Everything goes through the
// person's own Power Automate flow (core/calendar-flow.ts), on their own mailbox only.
//
// Rules decided on 16 Nov 2026: every meeting is a Teams meeting; people inside the company are
// checked free before a meeting is made or moved, people outside get the agreed time; every meeting
// with others, and every answer to an invitation, waits on his card, on every access level. A block
// with nobody else in it goes at once. Each create, move, cancel and answer leaves a quiet line in
// the bot's chat and a row in calendar_actions.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { BotTool, ToolResult } from "../claude/session.js";
import type { CardAttendee, CardMeeting } from "../../shared/protocol.js";
import type { CalendarActionKind, CalendarActionRow } from "../calendar-store.js";
import {
  type CalendarAttendeeArg,
  type CalendarCancelArgs,
  type CalendarCreateArgs,
  type CalendarFreeArgs,
  type CalendarListArgs,
  type CalendarMoveArgs,
  type CalendarRespondArgs,
  calendarToolList,
} from "../calendar-tools.js";
import { callFlow, type FlowAnswer } from "./calendar-flow.js";
import { ensureMailbox, flowAddress, isInternal } from "./calendar-settings.js";
import { afterNextWorkDay, dayStart, dayTime, freeRanges, fromGraph, graphTime, localIso, minutesWords, nextDay, overlaps, parseWhen, type Span, spanWords, suggestTimes } from "../calendar-time.js";
import { approval } from "./cards.js";
import { holdNotice } from "./notes.js";
import { ok, problem } from "../tool-names.js";
import { clip, iso } from "./words.js";
import { guideWords } from "./guides.js";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";

type FlowProblem = Exclude<FlowAnswer, { ok: true }>;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LIST_MAX_DAYS = 31;
const FREE_MAX_DAYS = 14;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** The calendar tools of one bot, bound to the engine. */
export function calendarToolsFor(eng: Engine, rt: BotRuntime): BotTool[] {
  return calendarToolList(
    {
      list: (a) => listFor(eng, a),
      freeTimes: (a) => freeTimesFor(eng, a),
      create: (a, s) => createFor(eng, rt, a, s),
      move: (a, s) => moveFor(eng, rt, a, s),
      cancel: (a, s) => cancelFor(eng, rt, a, s),
      respond: (a, s) => respondFor(eng, rt, a, s),
    },
    eng.tz,
  );
}

// ---------------------------------------------------------------- meetings as Graph sends them

interface Person {
  name?: string;
  address: string;
}

interface Meeting {
  id: string;
  subject: string;
  start: number;
  end: number;
  allDay: boolean;
  cancelled: boolean;
  teams: boolean;
  isOrganizer: boolean;
  organizer?: Person;
  attendees: (Person & { type: string; response?: string })[];
  myResponse?: string;
  location?: string;
  showAs?: string;
}

function person(v: unknown): Person | undefined {
  const e = v && typeof v === "object" ? (v as { emailAddress?: { name?: unknown; address?: unknown } }).emailAddress : undefined;
  const address = typeof e?.address === "string" ? e.address.trim().toLowerCase() : "";
  if (!address) return undefined;
  const name = typeof e?.name === "string" && e.name.trim() && e.name.trim().toLowerCase() !== address ? e.name.trim() : undefined;
  return { address, ...(name ? { name } : {}) };
}

export function toMeeting(v: unknown): Meeting | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const start = fromGraph(o.start);
  const end = fromGraph(o.end);
  if (typeof o.id !== "string" || start === undefined || end === undefined) return undefined;
  const attendees: Meeting["attendees"] = [];
  for (const a of Array.isArray(o.attendees) ? o.attendees : []) {
    const p = person(a);
    if (!p) continue;
    const r = a as { type?: unknown; status?: { response?: unknown } };
    attendees.push({ ...p, type: typeof r.type === "string" ? r.type : "required", ...(typeof r.status?.response === "string" ? { response: r.status.response } : {}) });
  }
  const organizer = person(o.organizer);
  const loc = (o.location as { displayName?: unknown } | undefined)?.displayName;
  const resp = (o.responseStatus as { response?: unknown } | undefined)?.response;
  return {
    id: o.id,
    subject: typeof o.subject === "string" && o.subject.trim() ? o.subject.trim() : "(no subject)",
    start,
    end,
    allDay: o.isAllDay === true,
    cancelled: o.isCancelled === true,
    teams: o.isOnlineMeeting === true || o.onlineMeetingProvider === "teamsForBusiness",
    isOrganizer: o.isOrganizer === true,
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(typeof resp === "string" ? { myResponse: resp } : {}),
    ...(typeof loc === "string" && loc.trim() ? { location: loc.trim() } : {}),
    ...(typeof o.showAs === "string" ? { showAs: o.showAs } : {}),
  };
}

const RESPONSE_WORDS: Record<string, string> = {
  accepted: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
  notResponded: "no answer",
  none: "no answer",
  organizer: "organizer",
};

function who(p: Person): string {
  return p.name ? `${p.name} <${p.address}>` : p.address;
}

/** Everyone in the meeting besides the person; rooms do not count. */
function othersIn(m: Meeting, mailbox: string | undefined): Meeting["attendees"] {
  return m.attendees.filter((a) => a.type !== "resource" && a.address !== mailbox);
}

function meetingLine(eng: Engine, m: Meeting, mailbox: string | undefined): string {
  const time = m.allDay ? `${dayTime(m.start, eng.tz).slice(0, -6)}, all day` : spanWords(m.start, m.end, eng.tz);
  const org = m.isOrganizer ? "you organize it" : m.organizer ? `organized by ${who(m.organizer)}` : "organizer unknown";
  const others = othersIn(m, mailbox).map((a) => `${who(a)}${isInternal(eng, a.address) ? "" : " (external)"}: ${RESPONSE_WORDS[a.response ?? "none"] ?? a.response}`);
  const parts = [
    `- ${time}: ${m.subject}${m.cancelled ? " (cancelled)" : ""}`,
    `  id ${m.id}`,
    `  ${org}${m.isOrganizer ? "" : `; your answer: ${RESPONSE_WORDS[m.myResponse ?? "none"] ?? m.myResponse}`}${m.teams ? "; Teams meeting" : "; no Teams link"}${m.location ? `; at ${m.location}` : ""}`,
    others.length ? `  with ${others.join(", ")}` : "  nobody else",
  ];
  return parts.join("\n");
}

// ---------------------------------------------------------------- reading

function noFlow(): ToolResult {
  return problem(`The calendar is not set up in Pobots any more. The person sets it up in Pobots settings, under Calendar. ${guideWords("calendar")}`);
}

/** A failed call's words for the bot: one that needs the person's hand on the flow points to the guide. */
function forBot(a: { why: string; setup?: boolean }): string {
  return a.setup ? `${a.why} ${guideWords("calendar")}` : a.why;
}

function when(eng: Engine, raw: string | undefined, what: string): { t: number; dateOnly: boolean } | string {
  if (!raw?.trim()) return `Give ${what}.`;
  const w = parseWhen(raw, eng.tz);
  return w ?? `${what.charAt(0).toUpperCase()}${what.slice(1)} must be a date like 2026-11-18 or a date and time like 2026-11-18T10:00.`;
}

/** calendar_list: what is in the calendar between two times. */
export async function listFor(eng: Engine, args: CalendarListArgs): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  const from = when(eng, args.from, "from");
  if (typeof from === "string") return problem(from);
  let to: number;
  if (args.to?.trim()) {
    const t = when(eng, args.to, "to");
    if (typeof t === "string") return problem(t);
    to = t.t;
  } else to = nextDay(from.t, eng.tz);
  if (to <= from.t) return problem("to must be after from.");
  if (to - from.t > LIST_MAX_DAYS * DAY) return problem(`Ask for at most ${LIST_MAX_DAYS} days at a time.`);
  const a = await callFlow(eng, address, "list", { start: iso(from.t), end: iso(to) });
  if (!a.ok) return problem(forBot(a));
  const r = a.result as { value?: unknown; "@odata.nextLink"?: unknown } | undefined;
  const meetings = (Array.isArray(r?.value) ? r.value : []).map(toMeeting).filter((m): m is Meeting => !!m).sort((x, y) => x.start - y.start);
  const mailbox = eng.store.calendar.settings().mailboxAddress;
  const head = `The person's calendar from ${dayTime(from.t, eng.tz)} to ${dayTime(to, eng.tz)} (${eng.tz}): ${meetings.length ? `${meetings.length} meeting${meetings.length === 1 ? "" : "s"}` : "nothing"}.`;
  const more = typeof r?.["@odata.nextLink"] === "string" ? "\nThere are more than these: ask for a shorter span to see the rest." : "";
  return ok([head, ...meetings.map((m) => meetingLine(eng, m, mailbox))].join("\n") + more);
}

// ---------------------------------------------------------------- free and busy

interface Schedules {
  busy: Map<string, (Span & { subject?: string })[]>;
  errors: Map<string, string>;
}

const BUSY = ["busy", "tentative", "oof"];

/** Free and busy for these people between two times, from the flow's getSchedule case. */
async function schedules(eng: Engine, address: string, people: string[], from: number, to: number): Promise<Schedules | FlowProblem> {
  const a = await callFlow(eng, address, "schedule", { schedules: people, start: graphTime(from), end: graphTime(to), interval: 30 });
  if (!a.ok) return a;
  const out: Schedules = { busy: new Map(), errors: new Map() };
  const value = (a.result as { value?: unknown } | undefined)?.value;
  for (const s of Array.isArray(value) ? value : []) {
    const o = s as { scheduleId?: unknown; scheduleItems?: unknown; error?: { message?: unknown } };
    const id = typeof o.scheduleId === "string" ? o.scheduleId.toLowerCase() : "";
    if (!id) continue;
    if (o.error) {
      out.errors.set(id, typeof o.error.message === "string" ? clip(o.error.message, 200) : "could not be read");
      continue;
    }
    const spans: (Span & { subject?: string })[] = [];
    for (const it of Array.isArray(o.scheduleItems) ? o.scheduleItems : []) {
      const i = it as { status?: unknown; start?: unknown; end?: unknown; subject?: unknown };
      const st = fromGraph(i.start);
      const en = fromGraph(i.end);
      if (st === undefined || en === undefined || typeof i.status !== "string" || !BUSY.includes(i.status)) continue;
      spans.push({ start: st, end: en, ...(typeof i.subject === "string" && i.subject.trim() ? { subject: i.subject.trim() } : {}) });
    }
    out.busy.set(id, spans);
  }
  for (const p of people) if (!out.busy.has(p) && !out.errors.has(p)) out.errors.set(p, "Outlook did not say");
  return out;
}

/** Busy spans, without the meeting being moved (it would clash with itself). */
function without(spans: Span[], ignore?: Span): Span[] {
  if (!ignore) return spans;
  return spans.filter((s) => Math.abs(s.start - ignore.start) > MIN || Math.abs(s.end - ignore.end) > MIN);
}

function cleanPeople(list: string[] | undefined): string[] | string {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const a = raw.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
    if (!EMAIL.test(a)) return `${raw.trim() || "An empty address"} is not an email address.`;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** calendar_free_times: when the person and these internal people are all free. */
export async function freeTimesFor(eng: Engine, args: CalendarFreeArgs): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  const people = cleanPeople(args.people);
  if (typeof people === "string") return problem(people);
  const mailbox = await ensureMailbox(eng);
  if (!mailbox) return problem("Pobots could not learn which mailbox the calendar flow acts for, so it cannot look up free times. The person checks the connection in Pobots settings, Calendar.");
  const outside = people.filter((p) => !isInternal(eng, p));
  if (outside.length)
    return problem(
      `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the company, so their free times cannot be looked up. For people outside the company, use the time agreed with them; look up only the people inside.`,
    );
  const minutes = Math.floor(args.minutes);
  if (!(minutes >= 5 && minutes <= 1440)) return problem("minutes must be from 5 to 1440.");
  let from = eng.clock();
  if (args.from?.trim()) {
    const f = when(eng, args.from, "from");
    if (typeof f === "string") return problem(f);
    from = Math.max(f.t, eng.clock());
  }
  let to = from + 7 * DAY;
  if (args.to?.trim()) {
    const t = when(eng, args.to, "to");
    if (typeof t === "string") return problem(t);
    to = t.t;
  }
  if (to <= from) return problem("to must be after from, and in the future.");
  if (to - from > FREE_MAX_DAYS * DAY) return problem(`Look at most ${FREE_MAX_DAYS} days at a time.`);
  const everyone = [mailbox, ...people.filter((p) => p !== mailbox)];
  const s = await schedules(eng, address, everyone, from, to);
  if ("ok" in s) return problem(forBot(s));
  const unread = [...s.errors].map(([p, why]) => `${p} (${why})`);
  if (unread.length) return problem(`The free times of ${unread.join(", ")} could not be read, so Pobots cannot say when everyone is free.`);
  const busy = [...s.busy.values()].flat();
  const count = Math.max(1, Math.min(20, Math.floor(args.count ?? 8)));
  const ranges = freeRanges(busy, { from, to, minutes, tz: eng.tz, max: count });
  const names = everyone.length === 1 ? "the person" : `everyone (the person, ${people.filter((p) => p !== mailbox).join(", ")})`;
  if (!ranges.length) return ok(`No time of ${minutesWords(minutes)} when ${names} is free, within working hours (weekdays 08:00 to 17:00, ${eng.tz}), from ${dayTime(from, eng.tz)} to ${dayTime(to, eng.tz)}. Look further ahead.`);
  const lines = ranges.map((r) => `- ${spanWords(r.start, r.end, eng.tz)} (start from ${localIso(r.start, eng.tz)})`);
  return ok(
    `Times when ${names} is free for ${minutesWords(minutes)} or more, within working hours (weekdays 08:00 to 17:00, ${eng.tz}):\n${lines.join("\n")}\nPass a start like the one in brackets to calendar_create.`,
  );
}

// ---------------------------------------------------------------- making, moving, cancelling, answering

interface Check {
  /** Who is busy, by address. */
  clash: string[];
  /** Internal people whose free times could not be read. */
  unread: string[];
  /** Start times to suggest after a clash. */
  suggest: number[];
  /** What the person has at that time. */
  ownClash?: string;
}

/**
 * Checks the internal people (and the person) at a time, before a card. One call covers the clash,
 * the person's own clash and free times on the same and the next working day.
 */
async function checkTime(eng: Engine, address: string, mailbox: string, internal: string[], span: Span, ignore?: Span): Promise<Check | FlowProblem> {
  const from = dayStart(span.start, eng.tz);
  const to = afterNextWorkDay(span.start, eng.tz);
  const everyone = [mailbox, ...internal.filter((p) => p !== mailbox)];
  const s = await schedules(eng, address, everyone, from, Math.max(to, span.end));
  if ("ok" in s) return s;
  const clash: string[] = [];
  const unread: string[] = [];
  for (const p of internal) {
    if (p === mailbox) continue;
    if (s.errors.has(p)) {
      unread.push(p);
      continue;
    }
    if (without(s.busy.get(p) ?? [], ignore).some((b) => overlaps(b, span))) clash.push(p);
  }
  const own = (s.busy.get(mailbox) ?? []).filter((b) => (!ignore || Math.abs(b.start - ignore.start) > MIN || Math.abs(b.end - ignore.end) > MIN) && overlaps(b, span));
  const ownClash = own.length ? own.map((b) => `${b.subject ?? "something"} (${spanWords(b.start, b.end, eng.tz)})`).join(", ") : undefined;
  const busyAll = everyone.flatMap((p) => without(s.busy.get(p) ?? [], ignore));
  const suggest = clash.length ? suggestTimes(busyAll, { wanted: span.start, minutes: Math.round((span.end - span.start) / MIN), now: eng.clock(), tz: eng.tz, max: 5 }) : [];
  return { clash, unread, suggest, ...(ownClash ? { ownClash } : {}) };
}

function clashAnswer(eng: Engine, check: Check, span: Span, verb: string): ToolResult {
  const times = check.suggest.length
    ? ` Times when everyone is free: ${check.suggest.map((t) => `${dayTime(t, eng.tz)} (${localIso(t, eng.tz)})`).join(", ")}. Pick one, or use calendar_free_times to look further.`
    : " No free time on that day or the next working day: use calendar_free_times to look further ahead.";
  return problem(`Not ${verb}: ${check.clash.join(", ")} ${check.clash.length === 1 ? "is" : "are"} busy at ${spanWords(span.start, span.end, eng.tz)}.${times}`);
}

function cleanAttendees(eng: Engine, list: CalendarAttendeeArg[] | undefined, mailbox: string | undefined): CardAttendee[] | string {
  const out: CardAttendee[] = [];
  for (const a of list ?? []) {
    const address = String(a.address ?? "").trim().toLowerCase();
    if (!EMAIL.test(address)) return `${a.address || "An empty address"} is not an email address.`;
    if (address === mailbox || out.some((o) => o.address === address)) continue;
    const name = typeof a.name === "string" && a.name.trim() ? clip(a.name, 200) : undefined;
    out.push({ address, internal: isInternal(eng, address), ...(name ? { name } : {}), ...(a.optional ? { optional: true } : {}) });
  }
  return out;
}

/** The new times from start and end or minutes. */
function newSpan(eng: Engine, args: { start: string; end?: string; minutes?: number }, keepMinutes: number): Span | string {
  const s = when(eng, args.start, "start");
  if (typeof s === "string") return s;
  if (s.dateOnly) return "Give the start as a date and time, like 2026-11-18T10:00.";
  let end: number;
  if (args.end?.trim()) {
    const e = when(eng, args.end, "end");
    if (typeof e === "string") return e;
    end = e.t;
  } else end = s.t + (args.minutes ?? keepMinutes) * MIN;
  if (end <= s.t) return "The end must be after the start.";
  if (end - s.t > DAY) return "A meeting can be at most 24 hours long.";
  if (s.t < eng.clock() - 5 * MIN) return `That time has passed: it is now ${dayTime(eng.clock(), eng.tz)} (${eng.tz}).`;
  return { start: s.t, end };
}

/** The card's words for an older window, and the line's details: the meeting in plain text. */
function meetingText(eng: Engine, m: CardMeeting): string {
  const lines = [`${m.subject}`, `${spanWords(Date.parse(m.start), Date.parse(m.end), eng.tz)} (${m.timeZone})`];
  if (m.was) lines.push(`Now: ${spanWords(Date.parse(m.was.start), Date.parse(m.was.end), eng.tz)}`);
  if (m.organizer) lines.push(`Organizer: ${m.organizer}`);
  if (m.attendees.length) {
    lines.push("With:");
    for (const a of m.attendees) {
      const tag = a.internal ? (a.free ? "internal, free then" : m.action === "create" || m.action === "move" ? "internal, could not be checked" : "internal") : m.action === "create" || m.action === "move" ? "external: the agreed time is used, not checked" : "external";
      lines.push(`- ${a.name ? `${a.name} <${a.address}>` : a.address}${a.optional ? " (optional)" : ""}, ${tag}`);
    }
  }
  if (m.action === "create") lines.push("Teams meeting: a link is added.");
  else lines.push(m.teams ? "Teams meeting." : "No Teams link.");
  if (m.ownClash) lines.push(`You have something else then: ${m.ownClash}`);
  if (m.message) lines.push(`${m.action === "create" ? "Text" : "Message"}: ${clip(m.message, 1500)}`);
  return lines.join("\n");
}

const TITLES: Record<CalendarActionKind, string> = { create: "Book this meeting?", move: "Move this meeting?", cancel: "Cancel this meeting?", respond: "Answer this invitation?" };
const RESPOND_TITLES = { accept: "Accept this invitation?", tentative: "Accept this invitation as tentative?", decline: "Decline this invitation?" };

/** The card, and what the person decided. */
async function ask(eng: Engine, rt: BotRuntime, m: CardMeeting, signal?: AbortSignal): Promise<string> {
  const title = m.action === "respond" && m.response ? RESPOND_TITLES[m.response] : TITLES[m.action];
  return approval(eng, rt, { title, detail: meetingText(eng, m), caption: "Calendar", meeting: m }, signal);
}

function row(rt: BotRuntime, action: CalendarActionKind, m: CardMeeting, eventId?: string): CalendarActionRow {
  return {
    id: randomUUID(),
    botId: rt.folder.id,
    at: new Date().toISOString(),
    action,
    subject: m.subject,
    start: m.start,
    end: m.end,
    attendees: m.attendees.map((a) => a.address),
    status: "unknown",
    ...(eventId ? { eventId } : {}),
    note: "Waiting",
  };
}

const DONE_WORDS: Record<CalendarActionKind, string> = { create: "Created", move: "Moved", cancel: "Cancelled", respond: "Answered" };
const FAIL_WORDS: Record<CalendarActionKind, string> = { create: "create", move: "move", cancel: "cancel", respond: "answer" };
const RESPONSE_DONE = { accept: "Accepted", tentative: "Tentatively accepted", decline: "Declined" };

/** "Created Weekly sync (Wed 18 Nov 10:00)", "Moved Weekly sync to Thu 19 Nov 10:00". */
function doneLine(eng: Engine, m: CardMeeting): string {
  const at = dayTime(Date.parse(m.start), eng.tz);
  if (m.action === "move") return `Moved ${clip(m.subject, 120)} to ${at}`;
  const verb = m.action === "respond" && m.response ? RESPONSE_DONE[m.response] : DONE_WORDS[m.action];
  return `${verb} ${clip(m.subject, 120)} (${at})`;
}

/** Calls the flow for an approved (or solo) action, with its row and its line in the chat. */
async function carryOut(eng: Engine, rt: BotRuntime, r: CalendarActionRow, m: CardMeeting, action: Parameters<typeof callFlow>[2], fields: Record<string, unknown>): Promise<FlowAnswer> {
  const address = flowAddress(eng);
  if (!address) {
    eng.store.calendar.updateAction({ ...r, status: "failed", note: "The calendar is not set up any more" });
    return { ok: false, why: "The calendar is not set up in Pobots any more, so nothing happened.", line: "the calendar is not set up", setup: true };
  }
  const a = await callFlow(eng, address, action, fields);
  if (!eng.store.isOpen) return a;
  const detail = meetingText(eng, m);
  if (a.ok) {
    const id = typeof (a.result as { id?: unknown } | undefined)?.id === "string" ? String((a.result as { id: string }).id) : r.eventId;
    eng.store.calendar.updateAction({ ...r, status: "done", ...(id ? { eventId: id } : {}), note: undefined });
    log.info(`Bot ${rt.folder.id}: calendar ${r.action} done`);
    holdNotice(eng, rt, { text: doneLine(eng, m), tone: "info", mark: "calendar", detail });
  } else {
    eng.store.calendar.updateAction({ ...r, status: a.maybeDone ? "unknown" : "failed", note: a.why });
    log.warn(`Bot ${rt.folder.id}: calendar ${r.action} ${a.maybeDone ? "may have happened" : "failed"}`);
    holdNotice(eng, rt, { text: `Could not ${FAIL_WORDS[r.action]} ${clip(m.subject, 120)}: ${a.line}`, tone: "error", mark: "calendar", detail });
  }
  return a;
}

/**
 * After a no on the card, the row says so and the bot is told the card was there (fix 0.26.3): a bot
 * never sees the person's cards, so without it a bot told the person no card went up.
 */
function declined(eng: Engine, r: CalendarActionRow, decision: string, what: string): ToolResult {
  eng.store.calendar.updateAction({ ...r, status: "denied", note: decision === "deny" ? "The person said no" : `Not approved (${decision})` });
  return cardRefused(decision, what);
}

/** The bot's words for a card that was not approved. */
export function cardRefused(decision: string, what: string): ToolResult {
  switch (decision) {
    case "expired":
      return ok(`The person's approval card was not answered in time, so ${what}.`);
    case "withdrawn":
      return problem(`The approval card was withdrawn because the turn stopped, so ${what}.`);
    case "later":
      return ok(`The person put the approval card aside for later, so ${what}. Do not ask again right away.`);
    default:
      return ok(`The person said no on their approval card, so ${what}. Do not try it another way.`);
  }
}

/**
 * Said to the bot after an action the person approved on their card (fix 0.26.3). A bot never sees
 * cards, so without this it told the person no card went up. Nothing is added when no card was needed.
 */
export const APPROVED = "The person approved it on their card.";

/** A failed flow call after the card was approved still tells the bot the card was there. */
function failedAfter(approved: boolean, why: string): ToolResult {
  return problem(approved ? `${APPROVED} But it did not go through: ${why}` : why);
}

async function mailboxOrProblem(eng: Engine): Promise<string | ToolResult> {
  const mailbox = await ensureMailbox(eng);
  return mailbox ?? problem("Pobots could not learn which mailbox the calendar flow acts for, so it cannot tell who is inside the company. The person checks the connection in Pobots settings, Calendar.");
}

/** calendar_create. */
export async function createFor(eng: Engine, rt: BotRuntime, args: CalendarCreateArgs, signal?: AbortSignal): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  const subject = args.subject?.trim();
  if (!subject) return problem("Give the meeting a subject.");
  const span = newSpan(eng, args, 30);
  if (typeof span === "string") return problem(span);
  const mailbox = await mailboxOrProblem(eng);
  if (typeof mailbox !== "string") return mailbox;
  const attendees = cleanAttendees(eng, args.attendees, mailbox);
  if (typeof attendees === "string") return problem(attendees);
  const text = args.text?.trim();
  const m: CardMeeting = {
    action: "create",
    subject: clip(subject, 255),
    start: iso(span.start),
    end: iso(span.end),
    timeZone: eng.tz,
    attendees,
    teams: true,
    ...(text ? { message: text } : {}),
  };
  const internal = attendees.filter((a) => a.internal).map((a) => a.address);
  if (attendees.length) {
    const check = await checkTime(eng, address, mailbox, internal, span);
    if ("ok" in check) return problem(forBot(check));
    if (check.clash.length) {
      eng.store.calendar.addAction({ ...row(rt, "create", m), status: "refused", note: `Busy: ${check.clash.join(", ")}` });
      return clashAnswer(eng, check, span, "booked");
    }
    for (const a of attendees) if (a.internal && !check.unread.includes(a.address)) a.free = true;
    if (check.ownClash) m.ownClash = check.ownClash;
  }
  const r = row(rt, "create", m);
  eng.store.calendar.addAction(r);
  const approved = attendees.length > 0;
  if (approved) {
    const decision = await ask(eng, rt, m, signal);
    if (decision !== "allow") return declined(eng, r, decision, "the meeting was not booked");
  }
  const event = {
    subject: m.subject,
    body: { contentType: "html", content: htmlBody(text) },
    start: graphTime(span.start, eng.tz),
    end: graphTime(span.end, eng.tz),
    attendees: attendees.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) }, type: a.optional ? "optional" : "required" })),
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    ...(args.location?.trim() ? { location: { displayName: clip(args.location, 200) } } : {}),
  };
  const a = await carryOut(eng, rt, r, m, "create", { event });
  if (!a.ok) return failedAfter(approved, forBot(a));
  const made = toMeeting(a.result);
  const teams = made ? (made.teams ? " It is a Teams meeting." : " Outlook did not add a Teams link: the person's account may not allow it.") : "";
  const sent = attendees.length ? " Outlook sent the invitations." : "";
  return ok(`Booked ${m.subject}, ${spanWords(span.start, span.end, eng.tz)}${made ? ` (id ${made.id})` : ""}.${teams}${sent}${approved ? ` ${APPROVED}` : ""}`);
}

/**
 * The meeting's text as HTML (fix 0.26.1). Outlook adds its Teams block in the body's own format: in
 * a plain-text body (or none) the block came out as bare lines with long raw links, in an HTML body it
 * is the normal formatted block. So the body is always HTML: the bot's text escaped, its line breaks
 * kept, and an empty div when there is no text.
 */
export function htmlBody(text: string | undefined): string {
  if (!text) return "<div></div>";
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<div>${esc.replace(/\r\n?/g, "\n").split("\n").join("<br>")}</div>`;
}

/** Reads one meeting for a move, a cancel or an answer. */
async function getMeeting(eng: Engine, address: string, id: string): Promise<Meeting | ToolResult> {
  const a = await callFlow(eng, address, "get", { id: id.trim() });
  if (!a.ok) return problem(forBot(a));
  const m = toMeeting(a.result);
  return m ?? problem("The flow did not send back a meeting Pobots can read.");
}

function cardAttendees(eng: Engine, m: Meeting, mailbox: string): CardAttendee[] {
  return othersIn(m, mailbox).map((a) => ({ address: a.address, internal: isInternal(eng, a.address), ...(a.name ? { name: a.name } : {}), ...(a.type === "optional" ? { optional: true } : {}) }));
}

/** calendar_move. */
export async function moveFor(eng: Engine, rt: BotRuntime, args: CalendarMoveArgs, signal?: AbortSignal): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  const mailbox = await mailboxOrProblem(eng);
  if (typeof mailbox !== "string") return mailbox;
  const got = await getMeeting(eng, address, args.id);
  if ("content" in got) return got;
  if (got.cancelled) return problem(`${got.subject} is cancelled, so it cannot be moved.`);
  if (!got.isOrganizer) return problem(`The person does not organize ${got.subject}${got.organizer ? ` (${who(got.organizer)} does)` : ""}, so it cannot be moved from here. Answer it with calendar_respond, or ask the organizer.`);
  const span = newSpan(eng, args, Math.round((got.end - got.start) / MIN));
  if (typeof span === "string") return problem(span);
  const attendees = cardAttendees(eng, got, mailbox);
  const m: CardMeeting = { action: "move", subject: got.subject, start: iso(span.start), end: iso(span.end), was: { start: iso(got.start), end: iso(got.end) }, timeZone: eng.tz, attendees, teams: got.teams };
  if (attendees.length) {
    const internal = attendees.filter((a) => a.internal).map((a) => a.address);
    const check = await checkTime(eng, address, mailbox, internal, span, { start: got.start, end: got.end });
    if ("ok" in check) return problem(forBot(check));
    if (check.clash.length) {
      eng.store.calendar.addAction({ ...row(rt, "move", m, got.id), status: "refused", note: `Busy: ${check.clash.join(", ")}` });
      return clashAnswer(eng, check, span, "moved");
    }
    for (const a of attendees) if (a.internal && !check.unread.includes(a.address)) a.free = true;
    if (check.ownClash) m.ownClash = check.ownClash;
  }
  const r = row(rt, "move", m, got.id);
  eng.store.calendar.addAction(r);
  const approved = attendees.length > 0;
  if (approved) {
    const decision = await ask(eng, rt, m, signal);
    if (decision !== "allow") return declined(eng, r, decision, "the meeting was not moved");
  }
  const a = await carryOut(eng, rt, r, m, "move", { id: got.id, start: graphTime(span.start, eng.tz), end: graphTime(span.end, eng.tz) });
  if (!a.ok) return failedAfter(approved, forBot(a));
  return ok(`Moved ${got.subject} to ${spanWords(span.start, span.end, eng.tz)}.${approved ? ` Outlook told the others. ${APPROVED}` : ""}`);
}

/** calendar_cancel. */
export async function cancelFor(eng: Engine, rt: BotRuntime, args: CalendarCancelArgs, signal?: AbortSignal): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  const mailbox = await mailboxOrProblem(eng);
  if (typeof mailbox !== "string") return mailbox;
  const got = await getMeeting(eng, address, args.id);
  if ("content" in got) return got;
  if (got.cancelled) return ok(`${got.subject} is cancelled already.`);
  if (!got.isOrganizer) return problem(`The person does not organize ${got.subject}${got.organizer ? ` (${who(got.organizer)} does)` : ""}, so it cannot be cancelled from here. Decline it with calendar_respond instead.`);
  const attendees = cardAttendees(eng, got, mailbox);
  const message = args.message?.trim();
  const m: CardMeeting = { action: "cancel", subject: got.subject, start: iso(got.start), end: iso(got.end), timeZone: eng.tz, attendees, teams: got.teams, ...(message ? { message } : {}) };
  const r = row(rt, "cancel", m, got.id);
  eng.store.calendar.addAction(r);
  const approved = attendees.length > 0;
  if (approved) {
    const decision = await ask(eng, rt, m, signal);
    if (decision !== "allow") return declined(eng, r, decision, "the meeting was not cancelled");
  }
  // A block with nobody else is deleted; a meeting with others is cancelled, which tells them.
  const a = approved ? await carryOut(eng, rt, r, m, "cancel", { id: got.id, comment: message ?? "" }) : await carryOut(eng, rt, r, m, "delete", { id: got.id });
  if (!a.ok) return failedAfter(approved, forBot(a));
  return ok(`Cancelled ${got.subject} (${spanWords(got.start, got.end, eng.tz)}).${approved ? ` Outlook told the others. ${APPROVED}` : ""}`);
}

/** calendar_respond: always on a card. */
export async function respondFor(eng: Engine, rt: BotRuntime, args: CalendarRespondArgs, signal?: AbortSignal): Promise<ToolResult> {
  const address = flowAddress(eng);
  if (!address) return noFlow();
  if (!["accept", "tentative", "decline"].includes(args.response)) return problem("response must be accept, tentative or decline.");
  const mailbox = await mailboxOrProblem(eng);
  if (typeof mailbox !== "string") return mailbox;
  const got = await getMeeting(eng, address, args.id);
  if ("content" in got) return got;
  if (got.isOrganizer) return problem(`The person organizes ${got.subject}, so there is no invitation to answer. Move or cancel it instead.`);
  if (got.cancelled) return problem(`${got.subject} is cancelled, so there is nothing to answer.`);
  const message = args.message?.trim();
  const m: CardMeeting = {
    action: "respond",
    subject: got.subject,
    start: iso(got.start),
    end: iso(got.end),
    timeZone: eng.tz,
    attendees: cardAttendees(eng, got, mailbox).filter((a) => a.address !== got.organizer?.address),
    ...(got.organizer ? { organizer: who(got.organizer) } : {}),
    teams: got.teams,
    response: args.response,
    ...(message ? { message } : {}),
  };
  const r = row(rt, "respond", m, got.id);
  eng.store.calendar.addAction(r);
  const decision = await ask(eng, rt, m, signal);
  if (decision !== "allow") return declined(eng, r, decision, "the invitation was not answered");
  const a = await carryOut(eng, rt, r, m, "respond", { id: got.id, response: args.response, comment: message ?? "" });
  if (!a.ok) return failedAfter(true, forBot(a));
  return ok(`${RESPONSE_DONE[args.response]} ${got.subject} (${spanWords(got.start, got.end, eng.tz)}). The organizer was told. ${APPROVED}`);
}
