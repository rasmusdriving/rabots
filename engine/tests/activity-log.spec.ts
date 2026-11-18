// activity_log, the main bot's day of activity for the person's time reporting (engine 0.28.0,
// docs/build/step-activity-log.md): a seeded day with several bots and every kind of starter, local
// times with the offset, his active blocks, the folding of turns, ranges, the bot filter, and that
// nothing that was written ever comes back. And the person's own actions, noted by the server only,
// with where he was. Stand-in harness, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import type { NewItem } from "../store.js";
import type { ToolResult } from "../claude/session.js";
import { whereFrom } from "../core/person-actions.js";
import { activityLogFor, DAY_CAP } from "../core/activity-log.js";
import { activityDayFor } from "../core/activity-day.js";
import { EngineError } from "../errors.js";
import { EngineServer } from "../server.js";
import { TIDY_ALLOWED_TOOLS } from "../team.js";
import { settle, setup } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const SECRET = "SECRET-WORDS";
const NOW = Date.parse("2026-11-16T16:00:00Z");

/** A day in Stockholm (UTC+01:00 in November): Po the main bot, Kaja, and what each did. */
function seeded() {
  const w = setup(undefined, undefined, undefined, { clock: () => NOW, timeZone: "Europe/Stockholm" });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Writes the weekly note" });
  const s = w.store;
  const add = (thread: string, item: Record<string, unknown>) => s.addItem(thread, item as unknown as NewItem);
  const user = (thread: string, at: string, turnId: string, from: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    add(thread, { kind: "user", at, turnId, text: `${SECRET} message`, from, queued: false, ...extra });
  const bot = (thread: string, botId: string, at: string, turnId: string) => add(thread, { kind: "bot", botId, at, turnId, text: `${SECRET} reply`, streaming: false });
  const work = (thread: string, botId: string, at: string, turnId: string, durationMs: number) =>
    add(thread, { kind: "activity", botId, at, turnId, label: `Read ${SECRET}.txt`, detail: `cat ${SECRET}`, status: "done", durationMs });

  s.addTrigger({ id: "trg1", botId: kaja.id, kind: "schedule", name: "Morning round", prompt: `${SECRET} prompt`, where: "main", enabled: true, createdBy: "you", createdAt: "2026-11-01T00:00:00Z" });
  s.addTrigger({ id: "trg2", botId: kaja.id, kind: "webhook", name: "Ticket in", prompt: `${SECRET} prompt`, where: "main", enabled: true, createdBy: "you", createdAt: "2026-11-01T00:00:00Z" });
  s.addChannel({ id: "ch1", kind: "teams", name: "Delivery", enabled: true, allowedSenders: ["alex@example.com"], routes: [], contextCount: 3, secret: "s3cr3t-0123456789", mayPost: [], createdAt: "2026-11-01T00:00:00Z" } as never);
  s.calendar.saveSettings({ mailboxName: "Pat Person", mailboxAddress: "pat@example.com" });

  // The day before: never shown on the 16th.
  user(po.mainThreadId, "2026-11-15T20:00:00.000Z", "t0", { type: "you" });
  bot(po.mainThreadId, po.id, "2026-11-15T20:00:05.000Z", "t0");
  // Kaja: the morning schedule twice, 10 minutes apart: one line, 2 turns.
  user(kaja.mainThreadId, "2026-11-16T06:00:00.000Z", "t2", { type: "trigger", label: "Morning round", triggerId: "trg1" });
  work(kaja.mainThreadId, kaja.id, "2026-11-16T06:00:02.000Z", "t2", 60_000);
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T06:10:00.000Z", "t2");
  user(kaja.mainThreadId, "2026-11-16T06:20:00.000Z", "t3", { type: "trigger", label: "Morning round", triggerId: "trg1" });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T06:20:03.000Z", "t3");
  // Po: a message from him, its work and a helper.
  const mine = user(po.mainThreadId, "2026-11-16T08:00:00.000Z", "t1", { type: "you" });
  bot(po.mainThreadId, po.id, "2026-11-16T08:00:05.000Z", "t1");
  add(po.mainThreadId, { kind: "helper", botId: po.id, at: "2026-11-16T08:01:00.000Z", turnId: "t1", title: "Check the import", helperThreadId: "h1", status: "done", background: false, steps: 3, model: "claude-haiku-5-5", effort: "low", endedAt: "2026-11-16T08:30:00.000Z", last: `${SECRET} last` });
  work(po.mainThreadId, po.id, "2026-11-16T08:02:00.000Z", "t1", 120_000);
  s.setChatTitle({ threadId: po.mainThreadId, fromSeq: 1, botId: po.id, kind: "main", title: "Planning the week", uptoSeq: 3, startedAt: "2026-11-15T20:00:00.000Z" } as never);
  // Kaja: a Teams writer, then him in Teams, then Po telling it something, then a helper reporting back, then a tidy turn.
  user(kaja.mainThreadId, "2026-11-16T10:00:00.000Z", "t4", { type: "channel", channelId: "ch1", label: "Delivery", sender: "Alex Example", tag: "kaja", messageId: "m1", context: [{ sender: "Alex Example", text: `${SECRET} context` }] });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T10:00:04.000Z", "t4");
  user(kaja.mainThreadId, "2026-11-16T10:30:00.000Z", "t8", { type: "channel", channelId: "ch1", label: "Delivery", sender: "pat person", tag: "kaja", messageId: "m2" });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T10:30:04.000Z", "t8");
  user(kaja.mainThreadId, "2026-11-16T11:00:00.000Z", "t5", { type: "bot", botId: po.id, expectsReply: false });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T11:00:04.000Z", "t5");
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T12:00:00.000Z", "t6");
  user(kaja.mainThreadId, "2026-11-16T12:30:00.000Z", "t7", { type: "app", reason: "tidy" });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T12:30:04.000Z", "t7");
  user(kaja.mainThreadId, "2026-11-16T12:40:00.000Z", "t9", { type: "trigger", label: "Ticket in", triggerId: "trg2" });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T12:40:04.000Z", "t9");
  // A message to Kaja from before the server noted his actions: shown, without where from.
  const old = user(kaja.mainThreadId, "2026-11-16T14:00:00.000Z", "t10", { type: "you" });
  bot(kaja.mainThreadId, kaja.id, "2026-11-16T14:00:03.000Z", "t10");

  // What the server noted.
  s.activity.addPersonAction({ id: "a1", at: mine.at, kind: "message", botId: po.id, threadId: po.mainThreadId, ref: mine.id, via: "computer" });
  s.activity.addPersonAction({ id: "a2", at: "2026-11-16T08:05:00.000Z", kind: "card", botId: po.id, threadId: po.mainThreadId, via: "phone", what: "approval, allowed once" });
  s.activity.addPersonAction({ id: "a3", at: "2026-11-16T08:06:00.000Z", kind: "stop", botId: po.id, via: "phone" });
  s.calendar.addAction({ id: "c1", botId: kaja.id, at: "2026-11-16T09:00:00.000Z", action: "create", subject: "Weekly sync", start: "2026-11-18T09:00:00.000Z", end: "2026-11-18T09:30:00.000Z", attendees: ["someone@example.com"], status: "done", note: `${SECRET} note` });
  s.posts.add({ id: "p1", channelId: "ch1", botId: kaja.id, at: "2026-11-16T13:00:00.000Z", text: `${SECRET} post`, status: "posted" });
  return { ...w, po, kaja, mine, old };
}

describe("activity_log: one day", () => {
  test("his actions, the bots' turns and who started them, helpers, calendar and posts, in local time; nothing that was written", () => {
    const w = seeded();
    const out = text(activityLogFor(w.engine, { day: "2026-11-16" }));
    assert.match(out, /^Activity in Pobots on Mon 16 Nov 2026, Europe\/Stockholm \(UTC\+01:00\)\. Labels only, never what was written\./);
    // His actions, with where from and the chat's title.
    assert.match(out, /- 09:00 message to Po, from a computer, chat "Planning the week"/);
    assert.match(out, /- 09:05 answered a card of Po: approval, allowed once, from the phone/);
    assert.match(out, /- 09:06 pressed Stop on Po, from the phone/);
    assert.match(out, /- 15:00 message to Kaja\n/, "an older message, without where from");
    // Active blocks by the 15-minute gap.
    assert.match(out, /Your first action 09:00, last 15:00\./);
    assert.match(out, /09:00 to 09:06 \(6 minutes, 3 actions\); 15:00 \(1 action\)\. In all 6 minutes over 2 blocks/);
    assert.match(out, /Your actions: 4 \(2 messages, 1 card answer, 1 Stop\)/);
    // Turns, by bot, with their starters; the two schedule turns folded; the tidy turn left out.
    assert.match(out, /- 07:00 to 07:20 schedule "Morning round", 2 turns\n/);
    assert.match(out, /- 09:00 to 09:04 you: "Planning the week"/);
    assert.match(out, /- 11:00 channel "Delivery", from Alex Example\n/);
    assert.match(out, /- 11:30 you, in channel "Delivery"\n/);
    assert.match(out, /- 12:00 bot Po\n/);
    assert.match(out, /- 13:00 a helper or background task reported back\n/);
    assert.match(out, /- 13:40 webhook "Ticket in"\n/);
    assert.ok(!/13:30/.test(out), "the tidy turn is not shown");
    assert.match(out, /Bot turns: 9 \(Kaja 8, Po 1\)\. Started by you 3, schedules 2, /);
    assert.ok(!/20:00|Sun 15/.test(out), "nothing from the day before");
    // Helpers, calendar, posts.
    assert.match(out, /- 09:01 to 09:30 Po's helper "Check the import" \([^)]*, low\), done/);
    assert.match(out, /- 10:00 Kaja made the meeting "Weekly sync" for Wed 18 Nov 10:00, done/);
    assert.match(out, /- 14:00 Kaja wrote a post in channel "Delivery", posted/);
    assert.match(out, /Helpers 1, task managers 0, calendar actions 1, channel posts 1\./);
    // Never what was written, no attendees, no addresses.
    assert.ok(!out.includes(SECRET), "something written came back");
    assert.ok(!/@example\.com/.test(out), "an address came back");
    w.engine.shutdown();
    w.store.close();
  });

  test("today when nothing is given; a quiet day; the bot filter; a wider gap joins blocks", () => {
    const w = seeded();
    assert.match(text(activityLogFor(w.engine, {})), /on Mon 16 Nov 2026/);
    assert.match(text(activityLogFor(w.engine, { day: "2026-11-10" })), /Nothing happened in Pobots on this day\./);
    const k = text(activityLogFor(w.engine, { day: "2026-11-16", bot: "kaja" }));
    assert.match(k, /Only Kaja\./);
    assert.ok(!/message to Po|Po's helper|Stop on Po/.test(k), "Po's day under Kaja");
    assert.match(k, /message to Kaja/);
    assert.match(k, /schedule "Morning round", 2 turns/);
    assert.match(k, /Bot turns: 8 \(Kaja 8\)/);
    const wide = text(activityLogFor(w.engine, { day: "2026-11-16", gap_minutes: 120 }));
    assert.match(wide, /09:00 to 09:06 \(6 minutes, 3 actions\); 15:00/, "15:00 is more than 2 hours after 09:06");
    assert.match(text(activityLogFor(w.engine, { day: "2026-11-16", bot: "Nobody" })), /There is no bot "Nobody"/);
    w.engine.shutdown();
    w.store.close();
  });

  test("a day with two offsets carries the offset on each time", () => {
    const w = seeded();
    // 25 Oct 2026: summer time ends in Stockholm at 03:00.
    w.store.addItem(w.kaja.mainThreadId, { kind: "bot", botId: w.kaja.id, at: "2026-10-25T08:00:00.000Z", turnId: "dst", text: "x", streaming: false } as unknown as NewItem);
    const out = text(activityLogFor(w.engine, { day: "2026-10-25" }));
    assert.match(out, /\(UTC\+02:00, later \+01:00: each time carries its offset\)/);
    assert.match(out, /- 09:00\+01:00 a helper or background task reported back/);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("activity.day: the window's day (protocol 22)", () => {
  test("the same day as rows in time order: his actions, turns, a helper, calendar and a post; local times; nothing that was written", () => {
    const w = seeded();
    const d = activityDayFor(w.engine);
    assert.equal(d.day, "2026-11-16");
    assert.equal(d.today, "2026-11-16");
    assert.equal(d.tz, "Europe/Stockholm");
    assert.deepEqual(activityDayFor(w.engine, "2026-11-16"), d);
    const times = d.rows.map((r) => r.time);
    assert.deepEqual([...times].sort(), times, "in time order");
    assert.deepEqual([...new Set(d.rows.map((r) => r.kind))].sort(), ["calendar", "helper", "post", "turn", "you"]);
    const find = (re: RegExp) => d.rows.find((r) => re.test(r.words));
    assert.deepEqual(find(/^Message to Po/), { time: "09:00", kind: "you", botId: w.po.id, who: "You", words: 'Message to Po, from a computer, chat "Planning the week"' });
    assert.equal(find(/^Pressed Stop on Po/)?.time, "09:06");
    assert.equal(find(/^Message to Kaja$/)?.time, "15:00");
    assert.deepEqual(find(/Morning round/), { time: "07:00", end: "07:20", kind: "turn", botId: w.kaja.id, who: "Kaja", words: 'Worked, started by schedule "Morning round", 2 turns' });
    assert.equal(find(/^Worked after a helper or background task reported back/)?.who, "Kaja");
    const helper = find(/^Helper "Check the import"/)!;
    assert.equal(helper.kind, "helper");
    assert.equal(helper.time, "09:01");
    assert.equal(helper.end, "09:30");
    assert.match(helper.words, /\(.*low\), done$/);
    assert.deepEqual(find(/^Made the meeting/), { time: "10:00", kind: "calendar", botId: w.kaja.id, who: "Kaja", words: 'Made the meeting "Weekly sync" for Wed 18 Nov 10:00, done' });
    assert.deepEqual(find(/^Wrote a post/), { time: "14:00", kind: "post", botId: w.kaja.id, who: "Kaja", words: 'Wrote a post in channel "Delivery", posted' });
    assert.ok(!d.rows.some((r) => r.end !== undefined && r.end === r.time), "an end only when it lasted a minute or more");
    assert.equal(d.summary[0], "You were active from 09:00 to 15:00: 6 minutes over 2 blocks.");
    assert.match(d.summary[1]!, /^4 actions, \d+ bot turns, 1 helper, 1 calendar action, 1 channel post\.$/);
    assert.ok(!JSON.stringify(d).includes(SECRET), "something that was written");
    assert.ok(!JSON.stringify(d).includes("example.com"), "an address");
    w.engine.shutdown();
    w.store.close();
  });

  test("the day before; a quiet day is empty; a day not come yet or a bad date is refused", () => {
    const w = seeded();
    const y = activityDayFor(w.engine, "2026-11-15");
    assert.deepEqual([y.day, y.today], ["2026-11-15", "2026-11-16"]);
    assert.equal(y.rows[0]?.time, "21:00");
    assert.equal(y.summary[0], "Your one action was at 21:00.");
    const quiet = activityDayFor(w.engine, "2026-11-10");
    assert.deepEqual([quiet.day, quiet.rows, quiet.summary], ["2026-11-10", [], []]);
    const refused = (day: string, words: RegExp) =>
      assert.throws(() => activityDayFor(w.engine, day), (e: unknown) => e instanceof EngineError && e.code === "bad_request" && words.test(e.message));
    refused("2026-11-17", /has not come yet/);
    refused("16/11/2026", /YYYY-MM-DD/);
    refused("2026-02-30", /not a date/);
    refused("0099-01-01", /not a date/);
    w.engine.shutdown();
    w.store.close();
  });

  test("on a day the clocks change each time carries its offset", () => {
    const w = seeded();
    w.store.addItem(w.kaja.mainThreadId, { kind: "bot", botId: w.kaja.id, at: "2026-10-25T08:00:00.000Z", turnId: "dst", text: "x", streaming: false } as unknown as NewItem);
    const d = activityDayFor(w.engine, "2026-10-25");
    assert.equal(d.rows[0]?.time, "09:00+01:00");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("activity_log: ranges", () => {
  test("up to 7 days gives each day's summary; 8 days, a mixed ask or a bad date says why", () => {
    const w = seeded();
    const r = activityLogFor(w.engine, { from: "2026-11-10", to: "2026-11-16" });
    const out = text(r);
    assert.equal(r.isError, undefined);
    assert.equal(out.match(/^Activity in Pobots on /gm)?.length, 7);
    assert.match(out, /on Mon 16 Nov 2026[^\n]*\nSummary\n- Your first action 09:00/);
    assert.ok(!/Your actions\n|Bot turns, by bot/.test(out), "a range shows summaries only");
    assert.match(out, /For one day in full, ask with day \(YYYY-MM-DD\)\.$/);
    const eight = activityLogFor(w.engine, { from: "2026-11-09", to: "2026-11-16" });
    assert.equal(eight.isError, true);
    assert.match(text(eight), /At most 7 days at a time/);
    assert.equal(activityLogFor(w.engine, { day: "2026-11-16", from: "2026-11-10" }).isError, true);
    assert.equal(activityLogFor(w.engine, { day: "16/11/2026" }).isError, true);
    assert.equal(activityLogFor(w.engine, { from: "2026-11-16", to: "2026-11-10" }).isError, true);
    w.engine.shutdown();
    w.store.close();
  });

  test("a very long day is cut with a line saying how to ask for less", () => {
    const w = seeded();
    for (let i = 0; i < 400; i++) {
      const at = new Date(Date.parse("2026-11-16T15:00:00Z") + i * 20_000).toISOString();
      w.store.activity.addPersonAction({ id: `x${i}`, at, kind: "stop", botId: w.kaja.id, via: "computer" });
    }
    const out = text(activityLogFor(w.engine, { day: "2026-11-16" }));
    assert.ok(out.length <= DAY_CAP + 200, `too long: ${out.length}`);
    assert.match(out, /Cut here: the day is too long to show at once\. Ask with bot for one bot's day\.$/);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("activity_log: the tool", () => {
  test("only the main bot has it, also in a tidy turn, and it answers", async () => {
    const w = setup(undefined, undefined, undefined, { clock: () => NOW, timeZone: "Europe/Stockholm" });
    const po = w.engine.createBot("Po");
    const kaja = w.engine.createBot({ name: "Kaja", purpose: "Writes" });
    w.engine.sendMessage({ botId: po.id, text: "hi" });
    w.engine.sendMessage({ botId: kaja.id, text: "hi" });
    await settle();
    const ps = w.sessions.find((x) => x.settings.botId === po.id)!;
    const ks = w.sessions.find((x) => x.settings.botId === kaja.id)!;
    assert.ok(ps.toolNames().includes("activity_log"));
    assert.ok(TIDY_ALLOWED_TOOLS.includes("activity_log"), "it only reads, so a tidy turn may use it");
    assert.ok(!ks.toolNames().includes("activity_log"));
    const out = text(await ps.tool("activity_log", {}));
    assert.match(out, /^Activity in Pobots on Mon 16 Nov 2026/);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("the person's own actions", () => {
  test("where a window is: the local token is the Mac; over Tailscale a phone or a computer", () => {
    assert.equal(whereFrom("local", "Mozilla/5.0 (iPhone)"), "mac");
    assert.equal(whereFrom("tailscale", "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Mobile/15E148"), "phone");
    assert.equal(whereFrom("tailscale", "Mozilla/5.0 (Linux; Android 16; Pixel) Mobile Safari"), "phone");
    assert.equal(whereFrom("tailscale", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0"), "computer");
    assert.equal(whereFrom("tailscale", undefined), "computer");
  });

  test("the server notes his message and Stop with where from, after they succeeded; a refused request and a bot's message are not noted", async () => {
    const TOKEN = "test-token-0123456789";
    const LOGIN = "someone@example.com";
    const w = setup(undefined, undefined, undefined, { clock: () => NOW, timeZone: "Europe/Stockholm" });
    const po = w.engine.createBot("Po");
    const kaja = w.engine.createBot({ name: "Kaja", purpose: "Writes" });
    const server = new EngineServer(TOKEN, { allowedLogins: [LOGIN] });
    server.attach(w.engine);
    const port = await server.listen(0);
    const open = (headers: Record<string, string>, path: string) =>
      new Promise<(method: string, params: unknown) => Promise<{ ok: boolean; result?: unknown }>>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, origin: headers.origin });
        const waiting = new Map<string, (f: { ok: boolean; result?: unknown }) => void>();
        let n = 0;
        const call = (method: string, params: unknown) =>
          new Promise<{ ok: boolean; result?: unknown }>((res) => {
            const id = String(++n);
            waiting.set(id, res);
            ws.send(JSON.stringify({ t: "req", id, method, params }));
          });
        ws.on("message", (raw) => {
          const f = JSON.parse(String(raw)) as { t: string; id?: string; ok: boolean; result?: unknown };
          if (f.id && waiting.has(f.id)) waiting.get(f.id)!(f);
        });
        ws.on("error", reject);
        ws.on("open", async () => {
          await call("hello", { protocol: PROTOCOL_VERSION, client: "test" });
          resolve(call);
        });
        after.push(() => ws.close());
      });
    const after: (() => void)[] = [];
    const host = "mac.example.ts.net";
    const phone = await open({ "tailscale-user-login": LOGIN, host, origin: `https://${host}`, "user-agent": "Mozilla/5.0 (iPhone) Mobile/15E148" }, "/ws");
    const mac = await open({}, `/ws?token=${TOKEN}`);
    const sent = await phone("message.send", { botId: po.id, text: `${SECRET} from the phone` });
    assert.equal(sent.ok, true);
    await settle();
    assert.equal((await mac("turn.interrupt", { botId: po.id })).ok, true);
    assert.equal((await mac("todo.close", { todoId: "todo_nothere", how: "done" })).ok, false, "no such to-do");
    assert.equal((await phone("message.send", { botId: "nobody", text: "x" })).ok, false, "no such bot");
    await settle();
    const rows = w.store.activity.personActions("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    assert.deepEqual(
      rows.map((r) => [r.kind, r.botId, r.via]),
      [
        ["message", po.id, "phone"],
        ["stop", po.id, "mac"],
      ],
    );
    const item = (sent.result as { item: { id: string; at: string; threadId: string } }).item;
    assert.equal(rows[0]!.ref, item.id);
    assert.equal(rows[0]!.at, item.at);
    assert.ok(!JSON.stringify(rows).includes(SECRET), "a row holds what was written");
    // Protocol 22: reading a day in the window is not one of his actions; a day not come yet is refused.
    const read = await phone("activity.day", {});
    assert.equal(read.ok, true);
    assert.equal((read.result as { activity: { tz: string } }).activity.tz, "Europe/Stockholm");
    assert.equal((await mac("activity.day", { day: "2999-01-01" })).ok, false);
    assert.equal((await mac("activity.day", { day: 5 })).ok, false, "not a string");
    // Po's own message to Kaja is not his.
    const ps = w.sessions.find((x) => x.settings.botId === po.id);
    try {
      if (ps) await ps.tool("message_bot", { bot: "Kaja", message: "hello", mode: "tell" });
    } catch {
      // Its turn was stopped; what matters is that nothing more is noted.
    }
    await settle();
    assert.equal(w.store.activity.personActions("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z").length, 2);
    // The rows are stamped on the real clock (the server notes them as they happen), so ask for the
    // day they fall on in the engine's zone, not the fake clock's day: the test holds on any date.
    const rowDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(rows[0]!.at));
    const day = text(activityLogFor(w.engine, { day: rowDay }));
    assert.match(day, /message to Po, from the phone/);
    assert.match(day, /pressed Stop on Po, on the Mac/);
    assert.ok(!/message to Kaja/.test(day));
    for (const f of after) f();
    await server.close();
    w.engine.shutdown();
    w.store.close();
    void kaja;
  });
});
