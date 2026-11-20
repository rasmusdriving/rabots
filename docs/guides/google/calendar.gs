// Pobots' calendar script for Google Calendar. See google-calendar.md, next to this folder.
//
// A web app in the person's own Google account. Pobots sends one POST with { action, ...fields } to the
// web app's address (with ?key= at the end), the same contract as the Power Automate calendar flow, and
// this script answers in Microsoft Graph's shape, so Pobots reads both the same way:
//   { ok: true, result }                         when it went well
//   { ok: false, graphStatus, message }          when Google Calendar said no (always with status 200,
//                                                 since Apps Script cannot set another one)
// It acts only on the person's own primary calendar. Nothing is kept besides the key.
//
// Run setup once in the editor: it makes the key and writes the end of the address in the log.

var CAL = "primary";
var KEY_NAME = "POBOTS_KEY";

/** Makes the key once, and writes what goes at the end of the web app's address in the log. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(KEY_NAME);
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    props.setProperty(KEY_NAME, key);
  }
  Logger.log("Put this at the end of the web app's address, then paste the whole address into Pobots settings, Calendar: ?key=" + key);
}

/** Makes a new key: the old address stops working. Run it if the address may have leaked. */
function newKey() {
  PropertiesService.getScriptProperties().deleteProperty(KEY_NAME);
  setup();
}

function doGet() {
  return ContentService.createTextOutput("Pobots' calendar script. It answers Pobots only.");
}

function doPost(e) {
  var key = PropertiesService.getScriptProperties().getProperty(KEY_NAME);
  var given = e && e.parameter ? String(e.parameter.key || "") : "";
  if (!key || !same(given, key)) return answer(no(401, "The key at the end of the address is not this script's key. Run setup in the script and copy the address again."));
  var req;
  try {
    req = JSON.parse((e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return answer(no(400, "The request was not JSON."));
  }
  if (!req || typeof req !== "object") return answer(no(400, "The request was not JSON."));
  try {
    var fn = ACTIONS[req.action];
    if (!fn) return answer(no(400, "The script has no case for this action."));
    return answer({ ok: true, result: fn(req) });
  } catch (err) {
    if (err && err.pobots) return answer(no(err.status, err.message));
    return answer(no(statusOf(err), messageOf(err)));
  }
}

var ACTIONS = {
  hello: function () {
    var cal = Calendar.Calendars.get(CAL);
    var address = String(cal.id || "").toLowerCase();
    var name = cal.summary && String(cal.summary).toLowerCase() !== address ? String(cal.summary) : undefined;
    return { id: cal.id, name: cal.summary, calendar: "google", owner: name ? { name: name, address: address } : { address: address } };
  },

  list: function (req) {
    var zone = calendarZone();
    var opts = { timeMin: instant(req.start), timeMax: instant(req.end), singleEvents: true, orderBy: "startTime", maxResults: 100 };
    var page = Calendar.Events.list(CAL, opts);
    var out = { value: (page.items || []).map(function (ev) { return toGraph(ev, zone); }) };
    if (page.nextPageToken) out["@odata.nextLink"] = "more";
    return out;
  },

  get: function (req) {
    var ev = Calendar.Events.get(CAL, need(req.id, "id"));
    // A removed event of the person's own is gone, as Outlook says it (404).
    if (ev.status === "cancelled" && (!ev.organizer || ev.organizer.self)) throw fail(404, "The event is not in the calendar.");
    return toGraph(ev, calendarZone());
  },

  create: function (req) {
    var event = req.event || {};
    var zone = calendarZone();
    var people = (event.attendees || []).map(guest).filter(Boolean);
    var online = event.isOnlineMeeting === true;
    var res = {
      summary: String(event.subject || ""),
      start: googleTime(event.start, req.timeZone, zone),
      end: googleTime(event.end, req.timeZone, zone),
      transparency: event.showAs === "free" ? "transparent" : "opaque",
    };
    if (event.body && event.body.content) res.description = String(event.body.content);
    if (people.length) res.attendees = people;
    if (event.location && event.location.displayName) res.location = String(event.location.displayName);
    if (event.isReminderOn === false) res.reminders = { useDefault: false, overrides: [] };
    // Pobots asks for an online meeting: Google's own, Google Meet.
    if (online) res.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    var made = Calendar.Events.insert(res, CAL, { conferenceDataVersion: online ? 1 : 0, sendUpdates: people.length ? "all" : "none" });
    return toGraph(made, zone);
  },

  move: function (req) {
    var zone = calendarZone();
    var res = { start: googleTime(req.start, req.timeZone, zone), end: googleTime(req.end, req.timeZone, zone) };
    return toGraph(Calendar.Events.patch(res, CAL, need(req.id, "id"), { sendUpdates: "all" }), zone);
  },

  // Google tells the guests, but has no message of its own for a cancellation: the comment is not sent.
  cancel: function (req) {
    Calendar.Events.remove(CAL, need(req.id, "id"), { sendUpdates: "all" });
    return null;
  },

  delete: function (req) {
    Calendar.Events.remove(CAL, need(req.id, "id"), { sendUpdates: "all" });
    return null;
  },

  respond: function (req) {
    var answers = { accept: "accepted", tentative: "tentative", decline: "declined" };
    var status = answers[req.response];
    if (!status) throw fail(400, "The answer is accept, tentative or decline.");
    var id = need(req.id, "id");
    var ev = Calendar.Events.get(CAL, id);
    if (ev.organizer && ev.organizer.self) throw fail(400, "You organize this meeting, so there is nothing to answer.");
    var list = ev.attendees || [];
    var mine = list.filter(function (a) { return a.self; })[0];
    if (!mine) throw fail(400, "You are not a guest of this meeting.");
    mine.responseStatus = status;
    if (req.comment) mine.comment = String(req.comment);
    Calendar.Events.patch({ attendees: list }, CAL, id, { sendUpdates: "all" });
    return null;
  },

  schedule: function (req) {
    var ids = (req.schedules || []).map(function (s) { return String(s).toLowerCase(); });
    var got = Calendar.Freebusy.query({ timeMin: instant(req.start), timeMax: instant(req.end), items: ids.map(function (id) { return { id: id }; }) });
    var cals = got.calendars || {};
    return {
      value: ids.map(function (id) {
        var c = cals[id];
        if (!c) return { scheduleId: id, error: { message: "Google Calendar did not say" } };
        if (c.errors && c.errors.length) {
          var reason = c.errors[0].reason;
          return { scheduleId: id, error: { message: reason === "notFound" ? "not found, or not shared" : "could not be read (" + reason + ")" } };
        }
        return {
          scheduleId: id,
          scheduleItems: (c.busy || []).map(function (b) { return { status: "busy", start: utc(b.start), end: utc(b.end) }; }),
        };
      }),
    };
  },
};

// ---------------------------------------------------------------- Google to Graph

var RESPONSES = { needsAction: "notResponded", accepted: "accepted", tentative: "tentativelyAccepted", declined: "declined" };

function toGraph(ev, zone) {
  var allDay = !!(ev.start && ev.start.date);
  var self = (ev.attendees || []).filter(function (a) { return a.self; })[0];
  var organizer = !!(ev.organizer && ev.organizer.self);
  var link = ev.hangoutLink || meetLink(ev.conferenceData);
  var out = {
    id: ev.id,
    subject: ev.summary || "",
    start: allDay ? { dateTime: ev.start.date + "T00:00:00", timeZone: zone } : utc(ev.start.dateTime),
    end: allDay ? { dateTime: ev.end.date + "T00:00:00", timeZone: zone } : utc(ev.end.dateTime),
    isAllDay: allDay,
    isCancelled: ev.status === "cancelled",
    isOrganizer: organizer,
    showAs: ev.eventType === "outOfOffice" ? "oof" : ev.transparency === "transparent" ? "free" : self && self.responseStatus === "tentative" ? "tentative" : "busy",
    responseStatus: { response: organizer ? "organizer" : self ? RESPONSES[self.responseStatus] || "none" : "none" },
    organizer: ev.organizer && ev.organizer.email ? { emailAddress: named(ev.organizer) } : undefined,
    attendees: (ev.attendees || []).map(function (a) {
      return { emailAddress: named(a), type: a.resource ? "resource" : a.optional ? "optional" : "required", status: { response: a.organizer ? "organizer" : RESPONSES[a.responseStatus] || "none" } };
    }),
    location: { displayName: ev.location || "" },
    isOnlineMeeting: !!link,
    onlineMeetingProvider: link ? "googleMeet" : "unknown",
    onlineMeeting: link ? { joinUrl: link } : null,
    bodyPreview: String(ev.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 255),
    webLink: ev.htmlLink || "",
  };
  if (!out.organizer) delete out.organizer;
  return out;
}

function named(p) {
  return p.displayName ? { name: p.displayName, address: String(p.email || "").toLowerCase() } : { address: String(p.email || "").toLowerCase() };
}

function meetLink(c) {
  var points = (c && c.entryPoints) || [];
  for (var i = 0; i < points.length; i++) if (points[i].entryPointType === "video") return points[i].uri;
  return "";
}

/** An instant as Graph gives it with Pobots' Prefer header: UTC, without the zone in the text. */
function utc(text) {
  var d = new Date(text);
  if (isNaN(d.getTime())) return { dateTime: String(text), timeZone: "UTC" };
  return { dateTime: d.toISOString().slice(0, 19), timeZone: "UTC" };
}

// ---------------------------------------------------------------- Graph to Google

/**
 * A time Pobots sent ({ dateTime, timeZone }) for Google. Pobots names zones the way Outlook does
 * ("W. Europe Standard Time"), which Google does not know, so the request's own timeZone (Pobots' zone
 * by its IANA name) is used, else the calendar's.
 */
function googleTime(t, requestZone, calZone) {
  if (!t || !t.dateTime) throw fail(400, "A start and an end are needed.");
  var dt = String(t.dateTime);
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(dt)) return { dateTime: dt };
  var tz = String(t.timeZone || "UTC");
  if (/^(utc|gmt|etc\/utc|coordinated universal time)$/i.test(tz)) return { dateTime: dt.slice(0, 19) + "Z" };
  if (tz.indexOf("/") > 0) return { dateTime: dt.slice(0, 19), timeZone: tz };
  return { dateTime: dt.slice(0, 19), timeZone: requestZone || calZone };
}

/** An instant for a query: an ISO text, or { dateTime, timeZone } in UTC. */
function instant(v) {
  if (v && typeof v === "object") {
    var g = googleTime(v, "UTC", "UTC");
    return g.timeZone ? g.dateTime + "Z" : g.dateTime;
  }
  if (!v) throw fail(400, "A start and an end are needed.");
  return String(v);
}

function guest(a) {
  var e = a && a.emailAddress;
  if (!e || !e.address) return undefined;
  var g = { email: String(e.address) };
  if (e.name) g.displayName = String(e.name);
  if (a.type === "optional") g.optional = true;
  return g;
}

// ---------------------------------------------------------------- small things

var zoneCache;
function calendarZone() {
  if (!zoneCache) zoneCache = Calendar.Calendars.get(CAL).timeZone || "UTC";
  return zoneCache;
}

function need(v, what) {
  if (!v) throw fail(400, "The " + what + " is missing.");
  return String(v);
}

function fail(status, message) {
  return { pobots: true, status: status, message: message };
}

function no(status, message) {
  return { ok: false, graphStatus: status, message: message };
}

function answer(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/** Google's status for an error the Calendar service threw. */
function statusOf(err) {
  if (err && err.details && typeof err.details.code === "number") return err.details.code;
  var m = String((err && err.message) || err);
  if (/not ?found|404/i.test(m)) return 404;
  if (/forbidden|insufficient|permission|403|not have access/i.test(m)) return 403;
  if (/rate ?limit|quota|429/i.test(m)) return 429;
  if (/unauthorized|401|login required/i.test(m)) return 401;
  if (/invalid|bad request|required|400/i.test(m)) return 400;
  return 500;
}

function messageOf(err) {
  return String((err && err.message) || err).replace(/^API call to [\w.]+ failed with error:\s*/i, "").slice(0, 300);
}

/** Compares the key without stopping at the first difference. */
function same(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
