// Engine 0.42.0 (docs/build/step-ahead-setup.md): the Google Calendar script (docs/guides/google/calendar.gs)
// run in node:vm against a stand-in for Apps Script and its Calendar service. Every action of the
// contract, the key, the error shape, a to-do block's fields, all-day events and a time in an Outlook
// zone name with the request's own zone. What it answers is read with the engine's own toMeeting.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";
import { fromGraph, graphTime } from "../calendar-time.js";
import { toMeeting } from "../core/calendar.js";
import { guidesDir } from "../core/guides.js";
import { join } from "node:path";

const SCRIPT = readFileSync(join(guidesDir(), "google", "calendar.gs"), "utf8");
const ME = "ada@example.org";
const ZONE = "Europe/Stockholm";

type Ev = Record<string, any>;

class NotFound extends Error {
  constructor(what: string) {
    super(`API call to calendar.events.${what} failed with error: Not Found`);
  }
}

/** Google's answer for a time: an RFC 3339 text with its offset, as the real service gives it. */
function rfc(t: { dateTime?: string; timeZone?: string; date?: string }): Ev {
  if (t.date) return { date: t.date };
  const ms = fromGraph({ dateTime: t.dateTime, timeZone: t.timeZone ?? "UTC" });
  assert.ok(ms !== undefined, `a time Google would refuse: ${JSON.stringify(t)}`);
  return { dateTime: new Date(ms).toISOString().replace(".000Z", "Z"), ...(t.timeZone ? { timeZone: t.timeZone } : {}) };
}

function world(opts: { key?: string; many?: boolean } = {}) {
  const events = new Map<string, Ev>();
  // Objects made inside the vm have its own prototypes: what is recorded is copied into this realm.
  const record: { what: string; args: unknown[] }[] = [];
  const calls = { push: (c: { what: string; args: unknown[] }) => record.push(JSON.parse(JSON.stringify(c))), find: (f: (c: { what: string; args: unknown[] }) => boolean) => record.find(f), filter: (f: (c: { what: string; args: unknown[] }) => boolean) => record.filter(f), get length() { return record.length; } };
  const props = new Map<string, string>(opts.key ? [["POBOTS_KEY", opts.key]] : []);
  const logged: string[] = [];
  const Calendar = {
    Calendars: { get: (id: string) => (calls.push({ what: "calendars.get", args: [id] }), { id: ME, summary: "Ada Example", timeZone: ZONE }) },
    Events: {
      list: (cal: string, o: Ev) => {
        calls.push({ what: "list", args: [cal, o] });
        const items = [...events.values()].filter((e) => e.status !== "cancelled");
        return { items, ...(opts.many ? { nextPageToken: "p2" } : {}) };
      },
      get: (cal: string, id: string) => {
        calls.push({ what: "get", args: [cal, id] });
        const e = events.get(id);
        if (!e) throw new NotFound("get");
        return structuredClone(e);
      },
      insert: (res: Ev, cal: string, o: Ev) => {
        calls.push({ what: "insert", args: [res, cal, o] });
        const id = `ev${events.size + 1}`;
        const e: Ev = { ...structuredClone(res), id, status: "confirmed", start: rfc(res.start), end: rfc(res.end), organizer: { email: ME, self: true }, htmlLink: `https://calendar.example.org/${id}` };
        if (res.conferenceData?.createRequest && o.conferenceDataVersion === 1) e.hangoutLink = "https://meet.example.org/abc-defg-hij";
        events.set(id, e);
        return structuredClone(e);
      },
      patch: (res: Ev, cal: string, id: string, o: Ev) => {
        calls.push({ what: "patch", args: [res, cal, id, o] });
        const e = events.get(id);
        if (!e) throw new NotFound("patch");
        const next = { ...e, ...structuredClone(res), ...(res.start ? { start: rfc(res.start) } : {}), ...(res.end ? { end: rfc(res.end) } : {}) };
        events.set(id, next);
        return structuredClone(next);
      },
      remove: (cal: string, id: string, o: Ev) => {
        calls.push({ what: "remove", args: [cal, id, o] });
        if (!events.delete(id)) throw new NotFound("remove");
      },
    },
    Freebusy: {
      query: (res: Ev) => {
        calls.push({ what: "freebusy", args: [res] });
        const calendars: Ev = {};
        for (const { id } of res.items) {
          calendars[id] = id.endsWith("@example.org") ? { busy: [{ start: "2026-11-23T09:00:00Z", end: "2026-11-23T10:00:00Z" }] } : { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
        }
        return { calendars };
      },
    },
  };
  const ctx = vm.createContext({
    Calendar,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => void props.set(k, v), deleteProperty: (k: string) => void props.delete(k) }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text: string) => ({ text, mime: "text", setMimeType(m: string) { this.mime = m; return this; } }) },
    Utilities: { getUuid: () => randomUUID() },
    Logger: { log: (s: string) => void logged.push(s) },
  });
  vm.runInContext(SCRIPT, ctx, { filename: "calendar.gs" });
  const post = (body: unknown, key = props.get("POBOTS_KEY") ?? ""): Ev => {
    const out = (ctx as any).doPost({ parameter: { key }, postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });
    assert.equal(out.mime, "json");
    return JSON.parse(out.text) as Ev;
  };
  return { ctx: ctx as any, events, calls, props, logged, post };
}

describe("engine 0.42.0: the Google Calendar script", () => {
  test("setup makes a key once and writes the end of the address; newKey makes another; a wrong key is refused in the contract's shape", () => {
    const w = world();
    assert.equal(w.post({ action: "hello" }, "").graphStatus, 401, "no key yet: nothing is answered");
    w.ctx.setup();
    const key = w.props.get("POBOTS_KEY")!;
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(w.logged.at(-1)!.endsWith(`?key=${key}`));
    w.ctx.setup();
    assert.equal(w.props.get("POBOTS_KEY"), key, "setup again keeps the key");
    const bad = w.post({ action: "hello" }, "wrong");
    assert.deepEqual(Object.keys(bad).sort(), ["graphStatus", "message", "ok"]);
    assert.equal(bad.ok, false);
    assert.equal(bad.graphStatus, 401);
    assert.equal(w.calls.length, 0, "a wrong key reaches nothing");
    w.ctx.newKey();
    assert.notEqual(w.props.get("POBOTS_KEY"), key);
    assert.equal(w.post({ action: "hello" }, key).graphStatus, 401, "the old key stops working");
  });

  test("hello names the owner; an unknown action and a body that is not JSON answer in the error shape", () => {
    const w = world({ key: "k" });
    const hi = w.post({ action: "hello", timeZone: ZONE });
    assert.equal(hi.ok, true);
    assert.deepEqual(hi.result.owner, { name: "Ada Example", address: ME });
    assert.equal(hi.result.calendar, "google");
    assert.deepEqual(w.post({ action: "fly" }), { ok: false, graphStatus: 400, message: "The script has no case for this action." });
    assert.equal(w.post("{nope").graphStatus, 400);
    assert.equal(w.ctx.doGet().text, "Pobots' calendar script. It answers Pobots only.");
  });

  test("create a meeting as Pobots asks for it: the Outlook zone name with the request's zone, guests told, Google Meet, read back by toMeeting", () => {
    const w = world({ key: "k" });
    const start = Date.parse("2026-11-23T09:00:00Z");
    const event = {
      subject: "Plan the launch",
      body: { contentType: "html", content: "<p>Agenda</p>" },
      start: graphTime(start, ZONE),
      end: graphTime(start + 30 * 60_000, ZONE),
      attendees: [{ emailAddress: { address: "bo@example.org", name: "Bo" }, type: "required" }, { emailAddress: { address: "cy@example.net" }, type: "optional" }],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      location: { displayName: "Room 1" },
    };
    assert.equal(event.start.timeZone, "W. Europe Standard Time");
    const r = w.post({ action: "create", event, timeZone: ZONE });
    assert.equal(r.ok, true, JSON.stringify(r));
    const ins = w.calls.find((c) => c.what === "insert")!;
    const [res, cal, o] = ins.args as [Ev, string, Ev];
    assert.equal(cal, "primary");
    assert.deepEqual(res.start, { dateTime: "2026-11-23T10:00:00", timeZone: ZONE });
    assert.deepEqual(o, { conferenceDataVersion: 1, sendUpdates: "all" });
    assert.equal(res.transparency, "opaque");
    assert.equal(res.description, "<p>Agenda</p>");
    assert.equal(res.location, "Room 1");
    assert.deepEqual(res.attendees, [{ email: "bo@example.org", displayName: "Bo" }, { email: "cy@example.net", optional: true }]);
    assert.equal(res.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
    const m = toMeeting(r.result)!;
    assert.equal(m.start, start, "the meeting is at the time Pobots asked for");
    assert.equal(m.end, start + 30 * 60_000);
    assert.equal(m.teams, true, "an online meeting");
    assert.equal(r.result.onlineMeetingProvider, "googleMeet");
    assert.equal(r.result.onlineMeeting.joinUrl, "https://meet.example.org/abc-defg-hij");
    assert.equal(m.isOrganizer, true);
    assert.equal(m.location, "Room 1");
    assert.deepEqual(m.attendees.map((a) => [a.address, a.type]), [["bo@example.org", "required"], ["cy@example.net", "optional"]]);
  });

  test("a to-do block: busy, no reminder, no online meeting, nobody told", () => {
    const w = world({ key: "k" });
    const t = Date.parse("2026-11-24T13:00:00Z");
    const r = w.post({ action: "create", timeZone: ZONE, event: { subject: "Write the plan", body: { contentType: "html", content: "x" }, start: graphTime(t, ZONE), end: graphTime(t + 3_600_000, ZONE), showAs: "busy", isOnlineMeeting: false, isReminderOn: false, attendees: [] } });
    const [res, , o] = w.calls.find((c) => c.what === "insert")!.args as [Ev, string, Ev];
    assert.equal(res.transparency, "opaque");
    assert.deepEqual(res.reminders, { useDefault: false, overrides: [] });
    assert.equal(res.conferenceData, undefined);
    assert.equal(res.attendees, undefined);
    assert.deepEqual(o, { conferenceDataVersion: 0, sendUpdates: "none" });
    const m = toMeeting(r.result)!;
    assert.equal(m.teams, false);
    assert.equal(m.showAs, "busy");
    assert.equal(m.start, t);
  });

  test("UTC times, and times without the request's zone, use the calendar's zone", () => {
    const w = world({ key: "k" });
    const t = Date.parse("2026-11-24T08:00:00Z");
    w.post({ action: "create", event: { subject: "A", start: graphTime(t), end: graphTime(t + 60_000) } });
    w.post({ action: "create", event: { subject: "B", start: { dateTime: "2026-11-24T09:00:00", timeZone: "W. Europe Standard Time" }, end: { dateTime: "2026-11-24T10:00:00", timeZone: "W. Europe Standard Time" } } });
    const [a, b] = w.calls.filter((c) => c.what === "insert").map((c) => (c.args[0] as Ev).start);
    assert.deepEqual(a, { dateTime: "2026-11-24T08:00:00Z" });
    assert.deepEqual(b, { dateTime: "2026-11-24T09:00:00", timeZone: ZONE });
  });

  test("list and get in Graph's shape; an all-day event; more than fits says so; a removed one is gone", () => {
    const w = world({ key: "k", many: true });
    w.events.set("d1", { id: "d1", status: "confirmed", summary: "Holiday", start: { date: "2026-11-25" }, end: { date: "2026-11-26" }, transparency: "transparent", organizer: { email: ME, self: true } });
    w.events.set("i1", {
      id: "i1",
      status: "confirmed",
      summary: "Their meeting",
      start: { dateTime: "2026-11-25T10:00:00+01:00" },
      end: { dateTime: "2026-11-25T11:00:00+01:00" },
      organizer: { email: "bo@example.org", displayName: "Bo" },
      attendees: [{ email: "bo@example.org", organizer: true, responseStatus: "accepted" }, { email: ME, self: true, responseStatus: "needsAction" }],
      hangoutLink: "https://meet.example.org/x",
    });
    const r = w.post({ action: "list", start: "2026-11-25T00:00:00.000Z", end: "2026-11-26T00:00:00.000Z" });
    assert.equal(r.ok, true);
    const [, o] = w.calls.find((c) => c.what === "list")!.args as [string, Ev];
    assert.deepEqual(o, { timeMin: "2026-11-25T00:00:00.000Z", timeMax: "2026-11-26T00:00:00.000Z", singleEvents: true, orderBy: "startTime", maxResults: 100 });
    assert.equal(r.result["@odata.nextLink"], "more");
    const [day, theirs] = r.result.value.map((v: unknown) => toMeeting(v)!);
    assert.equal(day.allDay, true);
    assert.equal(day.start, fromGraph({ dateTime: "2026-11-25T00:00:00", timeZone: ZONE }), "midnight in the calendar's zone");
    assert.equal(day.showAs, "free");
    assert.equal(theirs.start, Date.parse("2026-11-25T09:00:00Z"));
    assert.equal(theirs.isOrganizer, false);
    assert.equal(theirs.myResponse, "notResponded");
    assert.equal(theirs.organizer?.address, "bo@example.org");
    assert.equal(theirs.teams, true);
    assert.equal(toMeeting(w.post({ action: "get", id: "i1" }).result)!.subject, "Their meeting");
    // Removed by its organizer, the person: gone, as Outlook says it.
    w.events.set("x1", { id: "x1", status: "cancelled", organizer: { email: ME, self: true }, start: { dateTime: "2026-11-25T10:00:00Z" }, end: { dateTime: "2026-11-25T11:00:00Z" } });
    assert.equal(w.post({ action: "get", id: "x1" }).graphStatus, 404);
    assert.equal(w.post({ action: "get", id: "nope" }).graphStatus, 404, "Google's own Not Found");
    assert.equal(w.post({ action: "get" }).graphStatus, 400, "no id");
  });

  test("move, cancel, delete and respond", () => {
    const w = world({ key: "k" });
    const t = Date.parse("2026-11-26T09:00:00Z");
    const made = w.post({ action: "create", timeZone: ZONE, event: { subject: "M", start: graphTime(t, ZONE), end: graphTime(t + 1_800_000, ZONE), attendees: [{ emailAddress: { address: "bo@example.org" } }], isOnlineMeeting: true } }).result;
    const moved = w.post({ action: "move", id: made.id, start: graphTime(t + 3_600_000, ZONE), end: graphTime(t + 5_400_000, ZONE), timeZone: ZONE });
    assert.equal(toMeeting(moved.result)!.start, t + 3_600_000);
    assert.deepEqual((w.calls.find((c) => c.what === "patch")!.args as Ev[])[3], { sendUpdates: "all" });
    assert.deepEqual(w.post({ action: "cancel", id: made.id, comment: "Sorry" }), { ok: true, result: null });
    assert.deepEqual((w.calls.find((c) => c.what === "remove")!.args as Ev[])[2], { sendUpdates: "all" });
    assert.equal(w.events.has(made.id), false);
    assert.equal(w.post({ action: "delete", id: made.id }).graphStatus, 404, "already gone");

    w.events.set("inv", { id: "inv", status: "confirmed", summary: "Invite", organizer: { email: "bo@example.org" }, start: { dateTime: "2026-11-27T09:00:00Z" }, end: { dateTime: "2026-11-27T10:00:00Z" }, attendees: [{ email: "bo@example.org", organizer: true }, { email: ME, self: true, responseStatus: "needsAction" }] });
    assert.deepEqual(w.post({ action: "respond", id: "inv", response: "tentative", comment: "Maybe late" }), { ok: true, result: null });
    const mine = w.events.get("inv")!.attendees.find((a: Ev) => a.self);
    assert.equal(mine.responseStatus, "tentative");
    assert.equal(mine.comment, "Maybe late");
    assert.equal(w.post({ action: "respond", id: "inv", response: "maybe" }).graphStatus, 400);
    w.events.set("own", { id: "own", status: "confirmed", organizer: { email: ME, self: true }, start: { dateTime: "2026-11-27T09:00:00Z" }, end: { dateTime: "2026-11-27T10:00:00Z" } });
    assert.equal(w.post({ action: "respond", id: "own", response: "accept" }).graphStatus, 400, "nothing to answer on one's own meeting");
  });

  test("schedule: Google's free and busy in getSchedule's shape, an error for someone it cannot read", () => {
    const w = world({ key: "k" });
    const from = Date.parse("2026-11-23T08:00:00Z");
    const r = w.post({ action: "schedule", schedules: ["Bo@example.org", "cy@example.net"], start: graphTime(from), end: graphTime(from + 8 * 3_600_000), interval: 30 });
    assert.equal(r.ok, true);
    const q = (w.calls.find((c) => c.what === "freebusy")!.args as Ev[])[0];
    assert.deepEqual(q, { timeMin: "2026-11-23T08:00:00Z", timeMax: "2026-11-23T16:00:00Z", items: [{ id: "bo@example.org" }, { id: "cy@example.net" }] });
    const [bo, cy] = r.result.value;
    assert.equal(bo.scheduleId, "bo@example.org");
    assert.deepEqual(bo.scheduleItems, [{ status: "busy", start: { dateTime: "2026-11-23T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-23T10:00:00", timeZone: "UTC" } }]);
    assert.equal(fromGraph(bo.scheduleItems[0].start), Date.parse("2026-11-23T09:00:00Z"));
    assert.equal(cy.error.message, "not found, or not shared");
  });

  test("an error Google's service throws becomes its status, without the service's prefix", () => {
    const w = world({ key: "k" });
    w.ctx.Calendar.Events.list = () => {
      throw new Error("API call to calendar.events.list failed with error: Rate Limit Exceeded");
    };
    assert.deepEqual(w.post({ action: "list", start: "a", end: "b" }), { ok: false, graphStatus: 429, message: "Rate Limit Exceeded" });
    w.ctx.Calendar.Events.list = () => {
      throw Object.assign(new Error("Something"), { details: { code: 503 } });
    };
    assert.equal(w.post({ action: "list", start: "a", end: "b" }).graphStatus, 503);
    w.ctx.Calendar.Events.list = () => {
      throw new Error("Forbidden");
    };
    assert.equal(w.post({ action: "list", start: "a", end: "b" }).graphStatus, 403);
  });
});
