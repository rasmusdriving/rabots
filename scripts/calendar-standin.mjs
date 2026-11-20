// A stand-in for the calendar flow in Power Automate (engine 0.25.0, docs/build/step-calendar-flow.md).
// It answers the engine's calls the way the real flow does, from a small calendar of its own in
// memory, so the calendar tools can be tried without Outlook. Made-up people on example.com only.
//
//   node scripts/calendar-standin.mjs [--port=47791] [--fail=500] [--slow] [--mailbox=robin@example.com]
//
// Set Pobots settings, Calendar, to http://127.0.0.1:<port>/flow. --fail answers every call with that
// status (502 answers as the flow does when Outlook says no); --slow waits 40 seconds before each
// answer, longer than the engine waits. While it runs:
//   GET  /state            what is in its calendar and every call it got
//   POST /control {fail?, failOn?, slowMs?, busy?}   change how it answers, without a restart
//
// The tests and the checks import makeCalendarStandin() instead.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MIN = 60_000;

/** Graph's way of writing a time with `Prefer: outlook.timezone="UTC"`. */
function g(t) {
  return { dateTime: new Date(t).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" };
}
// The Windows zone names the engine sends for an event's start and end (engine/calendar-zones.ts),
// as Graph reads them. A few are enough for the tests and the checks.
const ZONES = { "W. Europe Standard Time": "Europe/Stockholm", "GMT Standard Time": "Europe/London", "Romance Standard Time": "Europe/Paris", "FLE Standard Time": "Europe/Helsinki", "Eastern Standard Time": "America/New_York", "Pacific Standard Time": "America/Los_Angeles" };
/** The UTC offset of `tz` at `t`, in ms. */
function offset(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}
function ms(v) {
  if (!v || typeof v.dateTime !== "string") return NaN;
  const s = v.dateTime.replace(/\.\d+$/, "");
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s);
  const asUtc = Date.parse(`${s}Z`);
  const zone = !v.timeZone || v.timeZone === "UTC" ? undefined : (ZONES[v.timeZone] ?? v.timeZone);
  if (!zone) return asUtc;
  try {
    // Wall time in the zone: two rounds settle it across a change of summer time.
    let t = asUtc - offset(asUtc, zone);
    t = asUtc - offset(t, zone);
    return t;
  } catch {
    return NaN;
  }
}
/** Graph's bodyPreview: the body's text without its tags. */
function preview(body) {
  const c = body?.content ?? "";
  const plain = body?.contentType?.toLowerCase() === "html" ? c.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") : c;
  return plain.slice(0, 255);
}

/**
 * A stand-in flow. `busy` maps an address to busy spans ({ start, end } in ms) of people inside the
 * company; `errors` lists addresses whose free times cannot be read; `seed` adds meetings (Graph shape).
 */
export function makeCalendarStandin(opts = {}) {
  const mailbox = { name: opts.mailboxName ?? "Robin Example", address: (opts.mailbox ?? "robin@example.com").toLowerCase() };
  const events = new Map();
  const calls = [];
  const control = { fail: opts.fail ?? 0, failOn: { ...(opts.failOn ?? {}) }, slowMs: opts.slowMs ?? 0, busy: { ...(opts.busy ?? {}) }, errors: [...(opts.errors ?? [])] };
  let next = 1;
  for (const e of opts.seed ?? []) events.set(e.id, structuredClone(e));

  const answer = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const graphNo = (res, graphStatus, message) => answer(res, 502, { ok: false, graphStatus, message });

  function run(body, res) {
    const a = body?.action;
    switch (a) {
      case "hello":
        return answer(res, 200, { ok: true, result: { id: "cal-1", name: "Calendar", owner: { ...mailbox } } });
      case "list": {
        const from = Date.parse(body.start);
        const to = Date.parse(body.end);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return graphNo(res, 400, "startDateTime and endDateTime are needed.");
        const value = [...events.values()].filter((e) => ms(e.start) < to && ms(e.end) > from).sort((x, y) => ms(x.start) - ms(y.start));
        return answer(res, 200, { ok: true, result: { value } });
      }
      case "get": {
        const e = events.get(body.id);
        return e ? answer(res, 200, { ok: true, result: e }) : graphNo(res, 404, "The specified object was not found in the store.");
      }
      case "create": {
        const ev = body.event ?? {};
        if (!ev.subject || !ev.start || !ev.end) return graphNo(res, 400, "Subject, start and end are needed.");
        const id = `AAMk-standin-${next++}`;
        const teams = ev.isOnlineMeeting === true && ev.onlineMeetingProvider === "teamsForBusiness";
        const e = {
          id,
          subject: ev.subject,
          bodyPreview: preview(ev.body),
          start: g(ms(ev.start)),
          end: g(ms(ev.end)),
          originalStartTimeZone: ev.start.timeZone ?? "UTC",
          originalEndTimeZone: ev.end.timeZone ?? "UTC",
          isAllDay: false,
          isCancelled: false,
          isOrganizer: true,
          // Kept as given, as Graph does (engine 0.41.0's to-do blocks send busy and no reminder).
          showAs: ev.showAs ?? "busy",
          isReminderOn: ev.isReminderOn ?? true,
          ...(ev.body ? { body: { contentType: ev.body.contentType ?? "text", content: ev.body.content ?? "" } } : {}),
          responseStatus: { response: "organizer" },
          organizer: { emailAddress: { ...mailbox } },
          attendees: (ev.attendees ?? []).map((x) => ({ type: x.type ?? "required", status: { response: "none" }, emailAddress: { ...x.emailAddress } })),
          location: { displayName: ev.location?.displayName ?? "" },
          isOnlineMeeting: teams,
          onlineMeetingProvider: teams ? "teamsForBusiness" : "unknown",
          ...(teams ? { onlineMeeting: { joinUrl: `https://teams.example.com/l/meetup-join/${id}` } } : {}),
        };
        events.set(id, e);
        return answer(res, 200, { ok: true, result: e });
      }
      case "move": {
        const e = events.get(body.id);
        if (!e) return graphNo(res, 404, "The specified object was not found in the store.");
        if (!e.isOrganizer) return graphNo(res, 403, "Only the organizer can change the meeting.");
        e.start = g(ms(body.start));
        e.end = g(ms(body.end));
        e.originalStartTimeZone = body.start?.timeZone ?? "UTC";
        e.originalEndTimeZone = body.end?.timeZone ?? "UTC";
        return answer(res, 200, { ok: true, result: e });
      }
      case "cancel": {
        const e = events.get(body.id);
        if (!e) return graphNo(res, 404, "The specified object was not found in the store.");
        if (!e.isOrganizer) return graphNo(res, 400, "Your request can't be completed. You need to be an organizer to cancel a meeting.");
        events.delete(body.id);
        return answer(res, 200, { ok: true, result: null });
      }
      case "delete": {
        if (!events.delete(body.id)) return graphNo(res, 404, "The specified object was not found in the store.");
        return answer(res, 200, { ok: true, result: null });
      }
      case "respond": {
        const e = events.get(body.id);
        if (!e) return graphNo(res, 404, "The specified object was not found in the store.");
        const r = { accept: "accepted", tentative: "tentativelyAccepted", decline: "declined" }[body.response];
        if (!r) return graphNo(res, 400, "Unknown response.");
        e.responseStatus = { response: r };
        return answer(res, 200, { ok: true, result: null });
      }
      case "schedule": {
        const from = ms(body.start);
        const to = ms(body.end);
        const value = (body.schedules ?? []).map((id) => {
          const who = String(id).toLowerCase();
          if (control.errors.includes(who)) return { scheduleId: who, availabilityView: "", error: { message: "The user could not be found.", responseCode: "ErrorMailRecipientNotFound" } };
          let items;
          if (who === mailbox.address)
            items = [...events.values()].filter((e) => !e.isCancelled && e.showAs !== "free" && e.responseStatus?.response !== "declined").map((e) => ({ status: e.showAs ?? "busy", subject: e.subject, start: e.start, end: e.end }));
          else items = (control.busy[who] ?? []).map((b) => ({ status: b.status ?? "busy", start: g(b.start), end: g(b.end) }));
          items = items.filter((i) => ms(i.start) < to && ms(i.end) > from);
          return { scheduleId: who, availabilityView: "", scheduleItems: items, workingHours: { daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], startTime: "08:00:00.0000000", endTime: "17:00:00.0000000", timeZone: { name: "W. Europe Standard Time" } } };
        });
        return answer(res, 200, { ok: true, result: { value } });
      }
      default:
        // The real flow's Switch has no case for it: its default answers 400.
        return answer(res, 400, { ok: false, message: `No case for ${String(a)}.` });
    }
  }

  const server = createServer((req, res) => {
    let t = "";
    req.on("data", (c) => {
      if (t.length < 2_000_000) t += c;
    });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/state") return answer(res, 200, { events: [...events.values()], calls });
      let body;
      try {
        body = t ? JSON.parse(t) : {};
      } catch {
        return answer(res, 400, { ok: false, message: "Not JSON." });
      }
      if (req.method === "POST" && req.url === "/control") {
        for (const k of ["fail", "failOn", "slowMs", "busy", "errors"]) if (body[k] !== undefined) control[k] = body[k];
        return answer(res, 200, { ok: true });
      }
      calls.push(body);
      const status = control.failOn[body?.action] ?? control.fail;
      setTimeout(() => {
        if (res.destroyed) return;
        if (status === 502) return graphNo(res, 500, "Outlook failed.");
        if (status) return answer(res, status, { ok: false });
        run(body, res);
      }, control.slowMs);
    });
  });

  return {
    server,
    mailbox,
    events,
    calls,
    control,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/flow?sig=standin-secret`)));
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** The next weekday after today, at an hour in UTC. */
function nextWeekday(hourUtc) {
  const d = new Date();
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.getTime();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const day = nextWeekday(9);
  // Alex (inside) is busy 09:00 to 10:00 UTC on the next weekday; Sam (outside) has invited the person to a demo.
  const s = makeCalendarStandin({
    mailbox: arg("mailbox"),
    fail: Number(arg("fail") ?? 0),
    slowMs: process.argv.includes("--slow") ? 40_000 : 0,
    busy: { "alex@example.com": [{ start: day, end: day + 60 * MIN }] },
    seed: [
      {
        id: "AAMk-standin-invite",
        subject: "Partner demo",
        start: g(day + 4 * 60 * MIN),
        end: g(day + 5 * 60 * MIN),
        isAllDay: false,
        isCancelled: false,
        isOrganizer: false,
        showAs: "tentative",
        responseStatus: { response: "notResponded" },
        organizer: { emailAddress: { name: "Sam Berg", address: "sam@partner.example.org" } },
        attendees: [{ type: "required", status: { response: "none" }, emailAddress: { name: "Robin Example", address: arg("mailbox") ?? "robin@example.com" } }],
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
    ],
  });
  const url = await s.listen(Number(arg("port") ?? 47791));
  console.log(`Calendar stand-in on ${url.replace(/\?.*$/, "")}${s.control.fail ? ` (answers ${s.control.fail})` : ""}${s.control.slowMs ? " (slow)" : ""}. GET /state shows what it holds.`);
}
