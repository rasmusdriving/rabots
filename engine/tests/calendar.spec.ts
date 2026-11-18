// The calendar tools (engine 0.25.0, docs/build/step-calendar.md): the switch and the tool list,
// update_bot calendar, the connection's settings, the free-time sums, every tool against the local
// stand-in flow (scripts/calendar-standin.mjs), the card for a meeting with others (Approve, Deny),
// a block with nobody else without a card, a clash refused with free times, a meeting the person
// does not organize, every error, and that the flow's address shows up nowhere. Stand-in harness,
// no model, nothing sent outside this computer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Events, NoticeItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { EngineError } from "../errors.js";
import { parseParams } from "../schemas.js";
import { calendarState, checkConnection, setCalendar } from "../core/calendar-settings.js";
import { freeRanges, graphTime, parseWhen, spanWords, suggestTimes } from "../calendar-time.js";
import { cardRefused, htmlBody } from "../core/calendar.js";
import { CALENDAR_TOOL_NAMES } from "../calendar-tools.js";
import { type CalendarStandin, makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { changeLines, type Ev, type FakeSession, settle, setup, upserts } from "./fake.js";

const TZ = "Europe/Stockholm";
/** Monday 16 Nov 2026, 08:00 in Stockholm. */
const NOW = Date.parse("2026-11-16T07:00:00Z");
const H = 3600_000;
/** Tuesday 17 Nov 2026 at an hour in Stockholm (UTC+1 in November). */
const tue = (h: number, m = 0) => Date.parse("2026-11-17T00:00:00Z") + (h - 1) * H + m * 60_000;
const CAL = Object.values(CALENDAR_TOOL_NAMES);

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const approvals = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).filter((c): c is ApprovalCard => c.kind === "approval");
const calendarLines = (events: Ev[]) => upserts(events).filter((i): i is NoticeItem => i.kind === "notice" && (i.mark === "calendar" || (i.tone === "error" && /^Could not/.test(i.text))));
const g = (t: number) => ({ dateTime: new Date(t).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" });

/** A meeting the person organizes with Alex, and an invitation from someone outside. */
const SEED = [
  {
    id: "AAMk-sync",
    subject: "Weekly sync",
    start: g(tue(14)),
    end: g(tue(14, 30)),
    isOrganizer: true,
    showAs: "busy",
    responseStatus: { response: "organizer" },
    organizer: { emailAddress: { name: "Robin Example", address: "robin@example.com" } },
    attendees: [{ type: "required", status: { response: "accepted" }, emailAddress: { name: "Alex Lund", address: "alex@example.com" } }],
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  },
  {
    id: "AAMk-focus",
    subject: "Focus",
    start: g(tue(8)),
    end: g(tue(9)),
    isOrganizer: true,
    showAs: "busy",
    responseStatus: { response: "organizer" },
    organizer: { emailAddress: { name: "Robin Example", address: "robin@example.com" } },
    attendees: [],
    isOnlineMeeting: false,
  },
  {
    id: "AAMk-invite",
    subject: "Partner demo",
    start: g(tue(15)),
    end: g(tue(16)),
    isOrganizer: false,
    showAs: "tentative",
    responseStatus: { response: "notResponded" },
    organizer: { emailAddress: { name: "Sam Berg", address: "sam@partner.example.org" } },
    attendees: [
      { type: "required", status: { response: "none" }, emailAddress: { name: "Robin Example", address: "robin@example.com" } },
      { type: "required", status: { response: "accepted" }, emailAddress: { name: "Sam Berg", address: "sam@partner.example.org" } },
    ],
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  },
];

const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;

async function waitFor<T>(get: () => T | undefined, what: string, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > until) throw new Error(`waited in vain for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Po (the main bot) and Kaja, with the calendar set up against a stand-in flow unless `connect` is false. */
async function world(o: { connect?: boolean; flow?: Parameters<typeof makeCalendarStandin>[0]; timeoutMs?: number } = {}) {
  const flow: CalendarStandin = makeCalendarStandin({ busy: { "alex@example.com": [{ start: tue(10), end: tue(11) }] }, seed: SEED, ...o.flow });
  const url = await flow.listen();
  const w = setup(undefined, undefined, { calendarTimeoutMs: o.timeoutMs ?? 2000 }, { timeZone: TZ, clock: () => NOW });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot("Kaja");
  if (o.connect !== false) await setCalendar(w.engine, { address: url });
  w.engine.sendMessage({ botId: po.id, text: "Go" });
  w.engine.sendMessage({ botId: kaja.id, text: "Go" });
  await settle();
  const close = async () => {
    w.engine.shutdown();
    await flow.close();
    w.store.close();
  };
  /** Calls a tool, waits for its card and decides it. */
  const decide = async (s: FakeSession, tool: string, args: Record<string, unknown>, decision: "allow-once" | "deny") => {
    const before = approvals(w.events).length;
    const p = s.tool(tool, args);
    const card = await waitFor(() => approvals(w.events)[before], "a card");
    w.engine.resolveCard(card.id, { type: decision });
    return { card, result: await p };
  };
  return { ...w, flow, url, po, kaja, close, decide, ps: sessionOf(w.sessions, po.id), ks: sessionOf(w.sessions, kaja.id) };
}

/** Ends a bot's turn, so the lines it held are written. */
async function endTurn(s: FakeSession) {
  s.reply("Done.");
  await settle();
}

describe("calendar: times and free times", () => {
  test("times a bot gives are read in the engine's time zone; Graph's are UTC", () => {
    assert.equal(parseWhen("2026-11-17T10:00", TZ)?.t, tue(10));
    assert.deepEqual(parseWhen("2026-11-17", TZ), { t: tue(0), dateOnly: true });
    assert.equal(parseWhen("2026-11-17T10:00:00+01:00", TZ)?.t, tue(10));
    assert.equal(parseWhen("2026-11-17T09:00Z", TZ)?.t, tue(10));
    assert.equal(parseWhen("tomorrow", TZ), undefined);
    assert.equal(parseWhen("2026-02-30T10:00", TZ), undefined);
    assert.equal(spanWords(tue(10), tue(10, 30), TZ), "Tue 17 Nov 10:00 to 10:30");
  });

  test("a meeting's times go to Graph as wall time in the person's own zone, by its Windows name, winter and summer (fix 0.26.1)", () => {
    // Winter: Stockholm is UTC+1. Summer: UTC+2. Graph applies the zone's rules to the wall time.
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z"), TZ), { dateTime: "2026-11-17T10:00:00", timeZone: "W. Europe Standard Time" });
    assert.deepEqual(graphTime(Date.parse("2026-07-14T08:30:00Z"), TZ), { dateTime: "2026-07-14T10:30:00", timeZone: "W. Europe Standard Time" });
    // The nights summer time starts and ends: 03:00 local on 29 March is 01:00 UTC; 02:30 on 25 October (the second one) is 01:30 UTC.
    assert.deepEqual(graphTime(Date.parse("2026-03-29T01:00:00Z"), TZ), { dateTime: "2026-03-29T03:00:00", timeZone: "W. Europe Standard Time" });
    assert.deepEqual(graphTime(Date.parse("2026-10-25T01:30:00Z"), TZ), { dateTime: "2026-10-25T02:30:00", timeZone: "W. Europe Standard Time" });
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z"), "Europe/London"), { dateTime: "2026-11-17T09:00:00", timeZone: "GMT Standard Time" });
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z"), "America/New_York"), { dateTime: "2026-11-17T04:00:00", timeZone: "Eastern Standard Time" });
    // One of Graph's own IANA names, a zone Graph does not take, no zone: as before.
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z"), "Asia/Tehran"), { dateTime: "2026-11-17T12:30:00", timeZone: "Asia/Tehran" });
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z"), "Antarctica/Troll"), { dateTime: "2026-11-17T09:00:00", timeZone: "UTC" });
    assert.deepEqual(graphTime(Date.parse("2026-11-17T09:00:00Z")), { dateTime: "2026-11-17T09:00:00", timeZone: "UTC" });
  });

  test("a meeting's text goes as HTML, escaped, with its line breaks; no text is an empty div (fix 0.26.1)", () => {
    assert.equal(htmlBody(undefined), "<div></div>");
    assert.equal(htmlBody("Scope & timeline.\nBring <notes>.\r\nSay \"hi\" or 'hej'."), "<div>Scope &amp; timeline.<br>Bring &lt;notes&gt;.<br>Say &quot;hi&quot; or &#39;hej&#39;.</div>");
  });

  test("free ranges within working hours, around everyone's busy times, and suggestions near the wanted time", () => {
    const busy = [
      { start: tue(8), end: tue(9) },
      { start: tue(10), end: tue(11, 10) },
      { start: tue(12), end: tue(16, 45) },
    ];
    const r = freeRanges(busy, { from: tue(0), to: tue(24), minutes: 30, tz: TZ, max: 10 });
    assert.deepEqual(
      r.map((x) => spanWords(x.start, x.end, TZ)),
      ["Tue 17 Nov 09:00 to 10:00", "Tue 17 Nov 11:15 to 12:00"],
    );
    // 16:45 to 17:00 is too short for 30 minutes; the weekend has no working hours.
    const weekend = freeRanges([], { from: Date.parse("2026-11-21T00:00:00Z"), to: Date.parse("2026-11-23T00:00:00Z"), minutes: 30, tz: TZ, max: 10 });
    assert.equal(weekend.length, 0);
    const s = suggestTimes(busy, { wanted: tue(10), minutes: 30, now: NOW, tz: TZ, max: 5 });
    assert.equal(s.length, 5);
    assert.ok(s.every((t) => !busy.some((b) => t < b.end && t + 30 * 60_000 > b.start)), "a suggestion clashes");
    assert.ok(s.includes(tue(9)) && s.includes(tue(11, 15)), s.map((t) => spanWords(t, t, TZ)).join(", "));
  });
});

describe("calendar: the switch, the connection and the tool list", () => {
  test("on for the main bot and off for others; the tools come only with the flow set up; update_bot calendar with a quiet line", async () => {
    const w = await world({ connect: false });
    const bots = () => w.engine.snapshot().bots;
    assert.equal(bots().find((b) => b.id === w.po.id)!.calendar, true);
    assert.equal(bots().find((b) => b.id === w.kaja.id)!.calendar, false);
    // No flow yet: no tools, and the main bot is told where the person sets it up.
    assert.ok(!w.ps.toolNames().some((n) => CAL.includes(n as never)));
    assert.match(w.ps.settings.team, /the connection is not set up yet, so you have no calendar tools.*Pobots settings, under Calendar/);
    assert.doesNotMatch(w.ks.settings.team, /Calendar:/);
    // The person sets it up: the main bot's session starts again between turns, with the tools.
    await endTurn(w.ps);
    await endTurn(w.ks);
    await setCalendar(w.engine, { address: w.url });
    w.engine.sendMessage({ botId: w.po.id, text: "Again" });
    w.engine.sendMessage({ botId: w.kaja.id, text: "Again" });
    await settle();
    const ps = sessionOf(w.sessions, w.po.id);
    const ks = sessionOf(w.sessions, w.kaja.id);
    assert.notEqual(ps, w.ps, "the main bot kept its old session");
    assert.deepEqual(ps.toolNames().filter((n) => CAL.includes(n as never)), CAL);
    assert.ok(!ks.toolNames().some((n) => CAL.includes(n as never)));
    assert.match(ps.settings.team, /Every meeting is a Teams meeting.*People outside the company are not checked: use the time agreed with them.*goes on the person's card first/);
    // The main bot switches it on for Kaja: at once, a quiet line, no card.
    const on = await ps.tool("update_bot", { bot: "Kaja", calendar: true });
    assert.match(text(on), /calendar from off to on/);
    assert.equal(approvals(w.events).length, 0);
    assert.equal(JSON.parse(readFileSync(join(w.dirs.botsDir, w.kaja.id, "bot.json"), "utf8")).calendar, true);
    assert.match(text(await ps.tool("get_bot", { bot: "Kaja" })), /Calendar tools: on\./);
    await endTurn(ps);
    assert.ok(changeLines(w.events, w.po.mainThreadId).some((l) => /^Kaja: calendar from off to on/.test(l)), changeLines(w.events, w.po.mainThreadId).join(" | "));
    // Kaja's next turn has them.
    await endTurn(ks);
    w.engine.sendMessage({ botId: w.kaja.id, text: "Once more" });
    await settle();
    assert.deepEqual(sessionOf(w.sessions, w.kaja.id).toolNames().filter((n) => CAL.includes(n as never)), CAL);
    // The window's switch: the main bot off, and the same value again is refused for update_bot.
    await w.engine.updateBot({ botId: w.po.id, patch: { calendar: false } });
    assert.equal(bots().find((b) => b.id === w.po.id)!.calendar, false);
    assert.equal((await ps.tool("update_bot", { bot: "Kaja", calendar: true })).isError, true);
    await w.close();
  });

  test("the connection: checked, the mailbox learned, domains from it or set, the address never sent back, removed", async () => {
    const w = await world({ connect: false });
    await assert.rejects(setCalendar(w.engine, { address: "http://flows.example.com/x" }), (e: unknown) => e instanceof EngineError && /must start with https/.test(e.message));
    await assert.rejects(setCalendar(w.engine, { address: "https://user:pw@flows.example.com/x" }), (e: unknown) => e instanceof EngineError && /user name or password/.test(e.message));
    await assert.rejects(setCalendar(w.engine, { internalDomains: ["not a domain"] }), (e: unknown) => e instanceof EngineError && /not an email domain/.test(e.message));
    assert.deepEqual(parseParams("calendar.set", { address: w.url, internalDomains: ["example.com"] }), { address: w.url, internalDomains: ["example.com"] });
    const set = await setCalendar(w.engine, { address: w.url });
    assert.deepEqual(set.calendar.mailbox, { name: "Robin Example", address: "robin@example.com" });
    assert.deepEqual(set.calendar.internalDomains, ["example.com"]);
    assert.equal(set.calendar.domainsSet, false);
    assert.equal(set.calendar.connected, true);
    const own = await setCalendar(w.engine, { internalDomains: ["Example.com", "@example.net", "example.com"] });
    assert.deepEqual(own.calendar.internalDomains, ["example.com", "example.net"]);
    assert.equal(own.calendar.domainsSet, true);
    // A check that fails says so in plain words.
    w.flow.control.fail = 404;
    const bad = await checkConnection(w.engine);
    assert.match(bad.problem ?? "", /said no \(status 404\).*Pobots settings, Calendar/);
    w.flow.control.fail = 0;
    assert.equal((await checkConnection(w.engine)).problem, undefined);
    // The main bot's get_settings says it is set and who for; never the address.
    const words = text(await w.ps.tool("get_settings", {}));
    assert.match(words, /Calendar: set up, the flow acts for Robin Example \(robin@example\.com\)\..*Only the person sets or removes the address/);
    // The main bot changes the domains with change_settings, with a quiet line; a bad one changes nothing.
    const refused = text(await w.ps.tool("change_settings", { calendar_internal_domains: ["not a domain"] }));
    assert.match(refused, /not an email domain/);
    assert.deepEqual(calendarState(w.engine).internalDomains, ["example.com", "example.net"]);
    const changed = text(await w.ps.tool("change_settings", { calendar_internal_domains: ["example.org"] }));
    assert.match(changed, /calendar, inside the company: example\.org \(was example\.com, example\.net\)/);
    assert.deepEqual(calendarState(w.engine).internalDomains, ["example.org"]);
    assert.match(text(await w.ps.tool("change_settings", { calendar_internal_domains: [] })), /example\.com \(the mailbox's\)/);
    assert.equal(calendarState(w.engine).domainsSet, false);
    await setCalendar(w.engine, { internalDomains: ["example.com", "example.net"] });
    // Removed: back to not set up; the domains the person set stay.
    const off = await setCalendar(w.engine, { address: "" });
    assert.equal(off.calendar.connected, false);
    assert.equal(off.calendar.mailbox, undefined);
    assert.deepEqual(calendarState(w.engine).internalDomains, ["example.com", "example.net"]);
    // The address is in no event, and the state never holds it.
    const all = JSON.stringify(w.events) + JSON.stringify(set) + JSON.stringify(own);
    assert.ok(!all.includes("standin-secret") && !all.includes(w.url), "the flow's address left the engine");
    await w.close();
  });
});

describe("calendar: reading", () => {
  test("calendar_list: each meeting with its id, organizer, others and answers; a span too long is refused", async () => {
    const w = await world();
    const r = text(await w.ps.tool("calendar_list", { from: "2026-11-17" }));
    assert.match(r, /^The person's calendar from Tue 17 Nov 00:00 to Wed 18 Nov 00:00 \(Europe\/Stockholm\): 3 meetings\./);
    assert.match(r, /- Tue 17 Nov 08:00 to 09:00: Focus\n {2}id AAMk-focus\n {2}you organize it; no Teams link\n {2}nobody else/);
    assert.match(r, /- Tue 17 Nov 14:00 to 14:30: Weekly sync\n {2}id AAMk-sync\n {2}you organize it; Teams meeting\n {2}with Alex Lund <alex@example\.com>: accepted/);
    assert.match(r, /Partner demo\n {2}id AAMk-invite\n {2}organized by Sam Berg <sam@partner\.example\.org>; your answer: no answer; Teams meeting\n {2}with Sam Berg <sam@partner\.example\.org> \(external\): accepted/);
    assert.deepEqual(w.flow.calls.at(-1), { action: "list", start: new Date(tue(0)).toISOString(), end: new Date(tue(24)).toISOString() });
    assert.match(text(await w.ps.tool("calendar_list", { from: "2026-11-01", to: "2026-12-15" })), /at most 31 days/);
    assert.match(text(await w.ps.tool("calendar_list", { from: "next week" })), /must be a date/);
    await w.close();
  });

  test("calendar_free_times: around everyone's busy times; people outside the company are refused", async () => {
    const w = await world();
    const out = await w.ps.tool("calendar_free_times", { people: ["alex@example.com", "kim@nordvik.example.net"], minutes: 30, from: "2026-11-17" });
    assert.equal(out.isError, true);
    assert.match(text(out), /kim@nordvik\.example\.net is outside the company, so their free times cannot be looked up\. For people outside the company, use the time agreed with them/);
    const r = text(await w.ps.tool("calendar_free_times", { people: ["Alex Lund <alex@example.com>"], minutes: 60, from: "2026-11-17", to: "2026-11-18" }));
    assert.match(r, /free for 1 hour or more/);
    // Focus 08:00 to 09:00 (the person), Alex 10:00 to 11:00, Weekly sync 14:00, the demo 15:00 to 16:00 (tentative counts as busy).
    assert.match(r, /- Tue 17 Nov 11:00 to 14:00 \(start from 2026-11-17T11:00\)/);
    assert.match(r, /- Tue 17 Nov 16:00 to 17:00/);
    assert.match(r, /- Tue 17 Nov 09:00 to 10:00/);
    const sched = w.flow.calls.find((c) => c.action === "schedule")!;
    assert.deepEqual(sched.schedules, ["robin@example.com", "alex@example.com"]);
    assert.deepEqual(sched.start, { dateTime: "2026-11-16T23:00:00", timeZone: "UTC" });
    await w.close();
  });
});

describe("calendar: making, moving, cancelling, answering", () => {
  test("a block with nobody else: made at once as a Teams meeting, no card, a line when the turn ends, a row", async () => {
    const w = await world();
    const r = await w.ps.tool("calendar_create", { subject: "Nordvik report", start: "2026-11-18T08:00", minutes: 120 });
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /^Booked Nordvik report, Wed 18 Nov 08:00 to 10:00 \(id AAMk-standin-1\)\. It is a Teams meeting\.$/);
    assert.equal(approvals(w.events).length, 0);
    const create = w.flow.calls.find((c) => c.action === "create")!;
    assert.deepEqual(create.event, {
      subject: "Nordvik report",
      body: { contentType: "html", content: "<div></div>" },
      start: { dateTime: "2026-11-18T08:00:00", timeZone: "W. Europe Standard Time" },
      end: { dateTime: "2026-11-18T10:00:00", timeZone: "W. Europe Standard Time" },
      attendees: [],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    });
    assert.ok(!w.flow.calls.some((c) => c.action === "schedule"), "a solo block checked free times");
    assert.equal(calendarLines(w.events).length, 0, "the line came before the turn ended");
    await endTurn(w.ps);
    const line = calendarLines(w.events).at(-1)!;
    assert.equal(line.text, "Created Nordvik report (Wed 18 Nov 08:00)");
    assert.equal(line.mark, "calendar");
    assert.match(line.detail ?? "", /Nordvik report\nWed 18 Nov 08:00 to 10:00 \(Europe\/Stockholm\)\nTeams meeting: a link is added\./);
    assert.deepEqual(
      w.store.calendar.actions(w.po.id).map((a) => [a.action, a.status, a.eventId]),
      [["create", "done", "AAMk-standin-1"]],
    );
    await w.close();
  });

  test("a meeting with others: internal people checked free, a card with the meeting; Approve makes it, Deny does not", async () => {
    const w = await world();
    const args = {
      subject: "Nordvik kickoff",
      start: "2026-11-17T11:00",
      end: "2026-11-17T12:00",
      attendees: [{ address: "alex@example.com", name: "Alex Lund" }, { address: "Kim@Nordvik.example.net" }, { address: "robin@example.com" }],
      text: "Scope and timeline.",
    };
    const yes = await w.decide(w.ps, "calendar_create", args, "allow-once");
    assert.equal(yes.card.title, "Book this meeting?");
    assert.equal(yes.card.noAlways, true);
    assert.deepEqual(yes.card.meeting, {
      action: "create",
      subject: "Nordvik kickoff",
      start: new Date(tue(11)).toISOString(),
      end: new Date(tue(12)).toISOString(),
      timeZone: TZ,
      attendees: [
        { address: "alex@example.com", internal: true, name: "Alex Lund", free: true },
        { address: "kim@nordvik.example.net", internal: false },
      ],
      teams: true,
      message: "Scope and timeline.",
    });
    assert.match(yes.card.detail, /alex@example\.com>, internal, free then\n- kim@nordvik\.example\.net, external: the agreed time is used, not checked\nTeams meeting: a link is added\./);
    assert.match(text(yes.result), /^Booked Nordvik kickoff, Tue 17 Nov 11:00 to 12:00 \(id AAMk-standin-1\)\. It is a Teams meeting\. Outlook sent the invitations\. The person approved it on their card\.$/);
    const made = w.flow.calls.filter((c) => c.action === "create");
    assert.equal(made.length, 1);
    assert.deepEqual(made[0]!.event.attendees, [
      { emailAddress: { address: "alex@example.com", name: "Alex Lund" }, type: "required" },
      { emailAddress: { address: "kim@nordvik.example.net" }, type: "required" },
    ]);
    assert.deepEqual(made[0]!.event.body, { contentType: "html", content: "<div>Scope and timeline.</div>" });
    assert.deepEqual(made[0]!.event.start, { dateTime: "2026-11-17T11:00:00", timeZone: "W. Europe Standard Time" });
    // Graph reads it in the person's zone: the meeting stands at 11:00 local, 10:00 UTC.
    const booked = await w.ps.tool("calendar_list", { from: "2026-11-17", to: "2026-11-18" });
    assert.match(text(booked), /Tue 17 Nov 11:00 to 12:00[^\n]*Nordvik kickoff|Nordvik kickoff[^\n]*Tue 17 Nov 11:00 to 12:00/);
    // Deny: nothing reaches the flow, the row says so.
    const no = await w.decide(w.ps, "calendar_create", { ...args, subject: "Second kickoff" }, "deny");
    assert.match(text(no.result), /^The person said no on their approval card, so the meeting was not booked\. Do not try it another way\.$/);
    assert.doesNotMatch(text(no.result), /approved it/);
    assert.equal(w.flow.calls.filter((c) => c.action === "create").length, 1);
    assert.deepEqual(
      w.store.calendar.actions(w.po.id).map((a) => [a.subject, a.status]),
      [
        ["Second kickoff", "denied"],
        ["Nordvik kickoff", "done"],
      ],
    );
    await endTurn(w.ps);
    assert.deepEqual(
      calendarLines(w.events).map((l) => l.text),
      ["Created Nordvik kickoff (Tue 17 Nov 11:00)"],
    );
    await w.close();
  });

  test("on Full access too, a meeting with others waits on the card", async () => {
    const w = await world();
    await w.engine.updateBot({ botId: w.po.id, patch: { access: "full-access" } });
    const { card } = await w.decide(w.ps, "calendar_create", { subject: "Check-in", start: "2026-11-17T16:00", attendees: [{ address: "kim@nordvik.example.net" }] }, "allow-once");
    assert.equal(card.meeting?.attendees[0]?.internal, false);
    await w.close();
  });

  test("an internal person busy then: no card, the clash named and free times to pick from; the person's own clash is on the card", async () => {
    const w = await world();
    const r = await w.ps.tool("calendar_create", { subject: "Sync", start: "2026-11-17T10:00", minutes: 30, attendees: [{ address: "alex@example.com" }] });
    assert.equal(r.isError, true);
    assert.match(text(r), /^Not booked: alex@example\.com is busy at Tue 17 Nov 10:00 to 10:30\. Times when everyone is free: .*Tue 17 Nov 09:00 \(2026-11-17T09:00\).*Tue 17 Nov 11:00 \(2026-11-17T11:00\)/);
    assert.equal(approvals(w.events).length, 0);
    assert.ok(!w.flow.calls.some((c) => c.action === "create"));
    assert.equal(w.store.calendar.actions(w.po.id)[0]?.status, "refused");
    // Over the person's own Focus block: allowed, said on the card.
    const { card } = await w.decide(w.ps, "calendar_create", { subject: "Early", start: "2026-11-17T08:00", minutes: 30, attendees: [{ address: "kim@nordvik.example.net" }] }, "deny");
    assert.equal(card.meeting?.ownClash, "Focus (Tue 17 Nov 08:00 to 09:00)");
    assert.match(card.detail, /You have something else then: Focus/);
    await w.close();
  });

  test("move: read first, the card shows the old and the new time, only start and end change; a meeting someone else organizes is refused", async () => {
    const w = await world();
    const { card, result } = await w.decide(w.ps, "calendar_move", { id: "AAMk-sync", start: "2026-11-17T13:00" }, "allow-once");
    assert.equal(card.title, "Move this meeting?");
    assert.deepEqual(card.meeting?.was, { start: new Date(tue(14)).toISOString(), end: new Date(tue(14, 30)).toISOString() });
    assert.equal(card.meeting?.end, new Date(tue(13, 30)).toISOString(), "the length was not kept");
    assert.equal(text(result), "Moved Weekly sync to Tue 17 Nov 13:00 to 13:30. Outlook told the others. The person approved it on their card.");
    assert.deepEqual(w.flow.calls.at(-1), { action: "move", id: "AAMk-sync", start: { dateTime: "2026-11-17T13:00:00", timeZone: "W. Europe Standard Time" }, end: { dateTime: "2026-11-17T13:30:00", timeZone: "W. Europe Standard Time" } });
    // Moving into its own old time does not clash with itself.
    await w.decide(w.ps, "calendar_move", { id: "AAMk-sync", start: "2026-11-17T13:15" }, "deny");
    const theirs = await w.ps.tool("calendar_move", { id: "AAMk-invite", start: "2026-11-18T10:00" });
    assert.match(text(theirs), /does not organize Partner demo \(Sam Berg <sam@partner\.example\.org> does\).*calendar_respond/);
    const gone = await w.ps.tool("calendar_move", { id: "AAMk-nothing", start: "2026-11-18T10:00" });
    assert.match(text(gone), /That meeting is not in the calendar \(any more\)\. Look again with calendar_list/);
    await w.close();
  });

  test("cancel: a block with nobody else is deleted at once; a meeting with others on the card, cancelled with the message", async () => {
    const w = await world();
    const solo = await w.ps.tool("calendar_cancel", { id: "AAMk-focus" });
    assert.equal(text(solo), "Cancelled Focus (Tue 17 Nov 08:00 to 09:00).", "no card, so nothing is said about one");
    assert.deepEqual(w.flow.calls.at(-1), { action: "delete", id: "AAMk-focus" });
    assert.equal(approvals(w.events).length, 0);
    const { card, result } = await w.decide(w.ps, "calendar_cancel", { id: "AAMk-sync", message: "Moved to next week." }, "allow-once");
    assert.equal(card.title, "Cancel this meeting?");
    assert.equal(card.meeting?.message, "Moved to next week.");
    assert.match(text(result), /^Cancelled Weekly sync .*Outlook told the others\. The person approved it on their card\.$/);
    assert.deepEqual(w.flow.calls.at(-1), { action: "cancel", id: "AAMk-sync", comment: "Moved to next week." });
    assert.match(text(await w.ps.tool("calendar_cancel", { id: "AAMk-invite" })), /Decline it with calendar_respond instead/);
    await endTurn(w.ps);
    assert.deepEqual(
      calendarLines(w.events).map((l) => l.text),
      ["Cancelled Focus (Tue 17 Nov 08:00)", "Cancelled Weekly sync (Tue 17 Nov 14:00)"],
    );
    await w.close();
  });

  test("respond: always on a card, with the organizer; the person's own meeting has no invitation to answer", async () => {
    const w = await world();
    const { card, result } = await w.decide(w.ps, "calendar_respond", { id: "AAMk-invite", response: "tentative", message: "Might be late." }, "allow-once");
    assert.equal(card.title, "Accept this invitation as tentative?");
    assert.equal(card.meeting?.organizer, "Sam Berg <sam@partner.example.org>");
    assert.deepEqual(card.meeting?.attendees, []);
    assert.match(text(result), /^Tentatively accepted Partner demo .*The organizer was told\. The person approved it on their card\.$/);
    assert.deepEqual(w.flow.calls.at(-1), { action: "respond", id: "AAMk-invite", response: "tentative", comment: "Might be late." });
    assert.match(text(await w.ps.tool("calendar_respond", { id: "AAMk-sync", response: "accept" })), /organizes Weekly sync, so there is no invitation to answer/);
    await w.close();
  });
});

describe("calendar: what the bot is told about the card (fix 0.26.3)", () => {
  test("a card that was not approved is named as the person's approval card, for every way it can end", () => {
    const words = (d: string) => text(cardRefused(d, "the meeting was not booked"));
    assert.equal(words("deny"), "The person said no on their approval card, so the meeting was not booked. Do not try it another way.");
    assert.equal(words("expired"), "The person's approval card was not answered in time, so the meeting was not booked.");
    assert.equal(words("later"), "The person put the approval card aside for later, so the meeting was not booked. Do not ask again right away.");
    assert.equal(words("withdrawn"), "The approval card was withdrawn because the turn stopped, so the meeting was not booked.");
    assert.equal(cardRefused("withdrawn", "x").isError, true);
    assert.equal(cardRefused("deny", "x").isError, undefined);
  });
});

describe("calendar: when the flow fails", () => {
  test("every status in plain words, one try each, an error line; a late create may have happened", async () => {
    const w = await world({ timeoutMs: 300 });
    const block = { subject: "Block", start: "2026-11-18T08:00", minutes: 30 };
    const cases: [number, RegExp][] = [
      [400, /has no case for "create" yet.*Nothing was changed/],
      [500, /failed \(status 500\)\. Ask the person to look at the flow's run history/],
      [502, /Outlook failed \(status 500\)\. It may still have happened, so do not try again before you have looked with calendar_list/],
      [401, /said no \(status 401\).*Pobots settings, Calendar/],
    ];
    for (const [status, why] of cases) {
      w.flow.control.failOn = { create: status };
      const before = w.flow.calls.length;
      const r = await w.ps.tool("calendar_create", block);
      assert.equal(r.isError, true);
      assert.match(text(r), why);
      assert.equal(w.flow.calls.length, before + 1, `status ${status} was tried again`);
    }
    w.flow.control.failOn = {};
    w.flow.control.slowMs = 1000;
    const late = await w.ps.tool("calendar_create", block);
    assert.match(text(late), /did not answer within 1 seconds\. It may still have happened, so do not try again before you have looked with calendar_list/);
    assert.equal(w.store.calendar.actions(w.po.id)[0]?.status, "unknown");
    w.flow.control.slowMs = 0;
    await endTurn(w.ps);
    const lines = calendarLines(w.events).map((l) => [l.tone, l.text]);
    assert.deepEqual(lines.at(-1), ["error", "Could not create Block: no answer in time. Check the calendar before trying again"]);
    assert.equal(lines.length, 5);
    // An address nobody answers: nothing happened. (A fresh port: a closed server's pooled socket can
    // race inside Node's fetch, which the engine logs and lives through, but the test runner does not.)
    w.store.calendar.saveSettings({ ...w.store.calendar.settings(), address: "http://127.0.0.1:9/flow?sig=standin-secret" });
    assert.match(text(await w.ps.tool("calendar_list", { from: "2026-11-17" })), /could not be reached, so nothing happened/);
    // The address is in no answer, event or row.
    const all = JSON.stringify(w.events) + JSON.stringify(w.store.calendar.actions(w.po.id));
    assert.ok(!all.includes("standin-secret"), "the flow's address left the engine");
    await w.close();
  });

  test("an approved action that fails still tells the bot the card was there (fix 0.26.3)", async () => {
    const w = await world();
    w.flow.control.failOn = { create: 500 };
    const { result } = await w.decide(w.ps, "calendar_create", { subject: "Check-in", start: "2026-11-17T16:00", attendees: [{ address: "kim@nordvik.example.net" }] }, "allow-once");
    assert.equal(result.isError, true);
    assert.match(text(result), /^The person approved it on their card\. But it did not go through: .*failed \(status 500\)/);
    // A solo block that fails says nothing about a card.
    const solo = await w.ps.tool("calendar_create", { subject: "Block", start: "2026-11-18T08:00", minutes: 30 });
    assert.doesNotMatch(text(solo), /card/);
    await w.close();
  });

  test("an internal person whose free times cannot be read: on the card as not checked, never as free", async () => {
    const w = await world({ flow: { errors: ["new@example.com"] } });
    const { card } = await w.decide(w.ps, "calendar_create", { subject: "Intro", start: "2026-11-17T16:00", attendees: [{ address: "new@example.com" }] }, "deny");
    assert.deepEqual(card.meeting?.attendees, [{ address: "new@example.com", internal: true }]);
    assert.match(card.detail, /new@example\.com, internal, could not be checked/);
    await w.close();
  });
});
