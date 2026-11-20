// Engine 0.42.0 (docs/build/step-ahead-setup.md): Ahead switched from off to on without a calendar
// starts the setup with the main bot: by itself in its chat when the person switched it in Settings, in
// the tool's answer when the main bot did. Never on a restart, never with a calendar that is fine. Also
// the calendar client's Google part: the one redirect it follows, Google's no in a 200, the time zone.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import type { ToolResult } from "../claude/session.js";
import { aheadSetupWords, setAheadByPerson } from "../core/ahead-setup.js";
import { aheadOn } from "../core/ahead-settings.js";
import { callFlow } from "../core/calendar-flow.js";
import { calendarState, setCalendar } from "../core/calendar-settings.js";
import { guidePath } from "../core/guides.js";
import { type FakeSession, settle, setup } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionsOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId);
/** Every text the main bot was sent, in all its sessions. */
const sentTo = (sessions: FakeSession[], botId: string) => sessionsOf(sessions, botId).flatMap((s) => s.sent.map((m) => m.text));
const SETUP = /Ahead needs the person's calendar/;

interface Call {
  method: string;
  path: string;
  body: string;
}

async function standIn(handle: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse, calls: Call[]) => void): Promise<{ server: Server; base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", path: req.url ?? "", body });
      handle(req, body, res, calls);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A calendar flow that knows hello: the calendar is set up and fine. */
const goodFlow = () =>
  standIn((_req, body, res) => {
    const a = JSON.parse(body || "{}") as { action?: string };
    if (a.action === "hello") return json(res, 200, { ok: true, result: { owner: { name: "Ada Example", address: "ada@example.com" } } });
    json(res, 200, { ok: true, result: { value: [] } });
  });

describe("engine 0.42.0: turning Ahead on starts the calendar setup", () => {
  test("switched on in Settings without a calendar: one turn of the main bot, with the setup note, not in the chat", async () => {
    const w = setup();
    try {
      const po = w.engine.createBot("Po");
      const bo = w.engine.createBot("Bo");
      await settle();
      assert.equal(aheadOn(w.engine), false);
      setAheadByPerson(w.engine, { enabled: true });
      await settle();
      const sent = sentTo(w.sessions, po.id);
      assert.equal(sent.length, 1, "one turn");
      assert.match(sent[0]!, /^Note from Pobots: the person switched Ahead on/);
      assert.match(sent[0]!, SETUP);
      assert.match(sent[0]!, /Microsoft 365/);
      assert.match(sent[0]!, /premium/);
      assert.match(sent[0]!, /ask their IT/);
      assert.match(sent[0]!, /only if they say yes and watch/);
      assert.match(sent[0]!, /change_settings about_you/);
      assert.match(sent[0]!, /paste it into Pobots settings, Calendar/);
      assert.match(sent[0]!, /never the guide's path/);
      assert.ok(sent[0]!.includes(guidePath("calendar")) && sent[0]!.includes(guidePath("google")));
      assert.equal(sentTo(w.sessions, bo.id).length, 0, "only the main bot");
      const items = w.engine.readThread({ threadId: w.engine.snapshot().bots.find((b) => b.id === po.id)!.mainThreadId }).items;
      assert.ok(!items.some((i) => i.kind === "user"), "the note is not a message in the chat");
      const lines = items.filter((i) => i.kind === "notice" && i.startsTurn);
      assert.equal(lines.length, 1, "one quiet line says why the turn starts");
      assert.equal(lines[0]!.kind === "notice" && lines[0]!.text, "You switched on Ahead. Your calendar is not set up yet, so the setup starts here.");
      sessionsOf(w.sessions, po.id).at(-1)!.reply("Ahead needs your calendar. Do you use Outlook?");
      await settle();

      // A change of working hours with Ahead already on starts nothing.
      setAheadByPerson(w.engine, { workStart: "09:00" });
      await settle();
      assert.equal(sentTo(w.sessions, po.id).length, 1);

      // Off and on again while still not set up: again.
      setAheadByPerson(w.engine, { enabled: false });
      await settle();
      assert.equal(sentTo(w.sessions, po.id).length, 1, "off starts nothing");
      setAheadByPerson(w.engine, { enabled: true });
      await settle();
      assert.equal(sentTo(w.sessions, po.id).length, 2, "on again starts it again");
    } finally {
      w.engine.shutdown();
      w.store.close();
    }
  });

  test("off and on quickly while the main bot works: one setup turn waits, not two", async () => {
    const w = setup();
    try {
      const po = w.engine.createBot("Po");
      w.engine.sendMessage({ botId: po.id, text: "Busy with something" });
      await settle();
      setAheadByPerson(w.engine, { enabled: true });
      setAheadByPerson(w.engine, { enabled: false });
      setAheadByPerson(w.engine, { enabled: true });
      sessionsOf(w.sessions, po.id).at(-1)!.reply("Done with that.");
      await settle();
      const setups = sentTo(w.sessions, po.id).filter((t) => SETUP.test(t));
      assert.equal(setups.length, 1, "one setup turn");
      // Its line waited for the turn the bot was in, so it stands after that turn's answer.
      const items = w.engine.readThread({ threadId: w.engine.snapshot().bots.find((b) => b.id === po.id)!.mainThreadId }).items;
      const line = items.findIndex((i) => i.kind === "notice" && i.startsTurn);
      assert.equal(items.filter((i) => i.kind === "notice" && i.startsTurn).length, 1, "one line");
      assert.ok(line > items.findIndex((i) => i.kind === "bot" && i.text === "Done with that."), "after the answer of the turn it waited for");
    } finally {
      w.engine.shutdown();
      w.store.close();
    }
  });

  test("a restart with Ahead on and no calendar starts nothing", async () => {
    const w = setup();
    const po = w.engine.createBot("Po");
    setAheadByPerson(w.engine, { enabled: true });
    await settle();
    sessionsOf(w.sessions, po.id).at(-1)!.reply("Let us set it up.");
    await settle();
    w.engine.shutdown();
    w.store.close();
    const again = setup(w.dirs);
    try {
      await settle();
      assert.equal(aheadOn(again.engine), true);
      assert.equal(sentTo(again.sessions, po.id).length, 0, "no turn after a restart");
    } finally {
      again.engine.shutdown();
      again.store.close();
    }
  });

  test("with the calendar set up and fine, nothing starts; with a problem from the last check, it does", async () => {
    const flow = await goodFlow();
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const po = w.engine.createBot("Po");
      await settle();
      const state = (await setCalendar(w.engine, { address: `${flow.base}/flow` })).calendar;
      assert.equal(state.problem, undefined);
      assert.equal(state.service, "outlook");
      setAheadByPerson(w.engine, { enabled: true });
      await settle();
      assert.equal(sentTo(w.sessions, po.id).length, 0, "a calendar that is fine: nothing starts");
      setAheadByPerson(w.engine, { enabled: false });
      // The flow goes away: the next check finds a problem.
      await new Promise((r) => flow.server.close(r));
      await setCalendar(w.engine, { address: `${flow.base}/other` });
      assert.ok(calendarState(w.engine).problem);
      setAheadByPerson(w.engine, { enabled: true });
      await settle();
      const sent = sentTo(w.sessions, po.id);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /the last check found a problem/);
    } finally {
      w.engine.shutdown();
      w.store.close();
      flow.server.close();
    }
  });

  test("switched on by the main bot's change_settings: the words come back in its answer, and no second turn starts", async () => {
    const w = setup();
    try {
      const po = w.engine.createBot("Po");
      w.engine.sendMessage({ botId: po.id, text: "Switch Ahead on" });
      await settle();
      const ps = sessionsOf(w.sessions, po.id).at(-1)!;
      const said = text(await ps.tool("change_settings", { ahead: true }));
      assert.match(said, /Ahead from off to on/);
      assert.match(said, SETUP);
      assert.ok(said.includes(aheadSetupWords(w.engine)));
      ps.reply("Ahead is on. It needs your calendar: do you use Outlook?");
      await settle();
      assert.equal(sentTo(w.sessions, po.id).length, 1, "no turn of its own after the tool");
      // Off by the tool: no words. Already on: nothing changed, no words.
      assert.doesNotMatch(text(await ps.tool("change_settings", { ahead: false })), SETUP);
      assert.doesNotMatch(text(await ps.tool("change_settings", { ahead: false })), SETUP);
    } finally {
      w.engine.shutdown();
      w.store.close();
    }
  });

  test("the main bot's change_settings with a calendar that is fine: no setup words", async () => {
    const flow = await goodFlow();
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const po = w.engine.createBot("Po");
      await setCalendar(w.engine, { address: `${flow.base}/flow` });
      w.engine.sendMessage({ botId: po.id, text: "Switch Ahead on" });
      await settle();
      const said = text(await sessionsOf(w.sessions, po.id).at(-1)!.tool("change_settings", { ahead: true }));
      assert.match(said, /Ahead from off to on/);
      assert.doesNotMatch(said, SETUP);
    } finally {
      w.engine.shutdown();
      w.store.close();
      flow.server.close();
    }
  });
});

describe("engine 0.42.0: the calendar client and a Google script", () => {
  test("a script's address: one redirect followed by GET without the body, the zone sent, Google's words", async () => {
    const s = await standIn((req, body, res) => {
      if (req.method === "POST" && req.url?.startsWith("/macros/s/x/exec")) {
        res.writeHead(302, { location: "/macros/echo?user_content_key=abc" });
        return res.end();
      }
      if (req.method === "GET" && req.url?.startsWith("/macros/echo")) {
        assert.equal(body, "");
        return json(res, 200, { ok: true, result: { owner: { address: "ada@example.org" } } });
      }
      json(res, 404, {});
    });
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 }, { timeZone: "Europe/Stockholm" });
    try {
      const state = (await setCalendar(w.engine, { address: `${s.base}/macros/s/x/exec?key=k` })).calendar;
      assert.equal(state.service, "google");
      assert.equal(state.mailbox?.address, "ada@example.org");
      assert.equal(s.calls.length, 2);
      assert.deepEqual(JSON.parse(s.calls[0]!.body), { action: "hello", timeZone: "Europe/Stockholm" });
      assert.equal(s.calls[1]!.method, "GET");
    } finally {
      w.engine.shutdown();
      w.store.close();
      s.server.close();
    }
  });

  test("Google's no in a 200 is read like the flow's 502, in Google's words", async () => {
    const s = await standIn((_req, body, res) => {
      const a = JSON.parse(body || "{}") as { action?: string };
      if (a.action === "get") return json(res, 200, { ok: false, graphStatus: 404, message: "Not Found" });
      if (a.action === "create") return json(res, 200, { ok: false, graphStatus: 403, message: "Forbidden" });
      json(res, 200, { ok: false, graphStatus: 400, message: "The script has no case for this action." });
    });
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const address = `${s.base}/macros/s/x/exec?key=k`;
      const gone = await callFlow(w.engine, address, "get", { id: "e1" });
      assert.ok(!gone.ok && gone.gone);
      const no = await callFlow(w.engine, address, "create", { event: {} });
      assert.ok(!no.ok && no.setup);
      assert.match(no.ok ? "" : no.why, /^Google Calendar did not allow it \(status 403\)\. The script's connection may need to be allowed again in Apps Script\. Google Calendar said: Forbidden$/);
      const other = await callFlow(w.engine, address, "schedule", {});
      assert.match(other.ok ? "" : other.why, /Google Calendar refused it \(status 400\)/);
    } finally {
      w.engine.shutdown();
      w.store.close();
      s.server.close();
    }
  });

  test("an Outlook flow: no time zone added, a redirect is not followed, and the words are as before", async () => {
    const s = await standIn((req, _body, res) => {
      if (req.url === "/flow") {
        res.writeHead(302, { location: "/elsewhere" });
        return res.end();
      }
      json(res, 200, { ok: true, result: {} });
    });
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const a = await callFlow(w.engine, `${s.base}/flow`, "list", { start: "a", end: "b" });
      assert.equal(s.calls.length, 1, "the redirect is not followed");
      assert.deepEqual(JSON.parse(s.calls[0]!.body), { action: "list", start: "a", end: "b" });
      assert.ok(!a.ok);
      assert.equal(a.ok ? "" : a.why, "The calendar flow said no (status 302). The flow may be off, or the address in Pobots is not its current one. The person checks Pobots settings, Calendar.");
    } finally {
      w.engine.shutdown();
      w.store.close();
      s.server.close();
    }
  });

  test("a script's redirect elsewhere is not followed", async () => {
    const other = await standIn((_req, _body, res) => json(res, 200, { ok: true, result: { owner: { address: "x@example.net" } } }));
    const s = await standIn((_req, _body, res) => {
      res.writeHead(302, { location: `${other.base}/macros/echo` });
      res.end();
    });
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const a = await callFlow(w.engine, `${s.base}/macros/s/x/exec?key=k`, "hello");
      assert.ok(!a.ok);
      assert.equal(other.calls.length, 0, "another host is never asked");
    } finally {
      w.engine.shutdown();
      w.store.close();
      s.server.close();
      other.server.close();
    }
  });
});
