// Bots reach their helpers and each other (15 Nov 2026, docs/build/step-bot-reach.md): a helper's
// id at once, read_helper (the list, latest, overview, a range, the cut, hidden secrets), stop_helper
// (own, the main bot's for another bot, refusals) and steer_helper (Claude and Codex stand-ins, one
// that ended, one of the harness's own tool). Fake harnesses, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { changeLines, settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const inThread = (events: Ev[], threadId: string) => items(events).filter((i) => i.threadId === threadId);
const helperRows = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
type World = ReturnType<typeof setup>;
type Steered = { text: string; id: string };

/** A bot in a turn on its fake session. */
async function inTurn(w: World, name: string, o: { model?: string } = {}) {
  const bot = w.engine.createBot({ name, model: o.model ?? "claude-haiku-5-5", access: "edits-freely" });
  w.engine.sendMessage({ botId: bot.id, text: "Do the work" });
  await settle();
  const s = w.sessions.at(-1)!;
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  return { bot, s };
}

/** The bot starts a Claude helper with start_helper (wait false); its fake session and the call's answer. */
async function startHelper(w: World, s: FakeSession, title = "Count words", o: { wait?: boolean } = {}) {
  const input = { title, task: `Count the words in ${title}.txt`, model: "claude-haiku-5-5", effort: "low", wait: o.wait ?? false };
  const before = w.sessions.length;
  const tu = `tu-${Math.random()}`;
  s.emit({ type: "tool-start", toolUseId: tu, name: "mcp__pobots__start_helper", input });
  const call = s.tool("start_helper", input);
  await settle();
  const h = w.sessions.length > before ? w.sessions.at(-1)! : undefined;
  const answer = o.wait === true ? undefined : await call;
  return { h: h!, answer, call, tu };
}

function steerable(s: FakeSession, accept: () => boolean = () => true): Steered[] {
  const got: Steered[] = [];
  (s as FakeSession & { steer(text: string, o: { id: string }): Promise<boolean> }).steer = async (t, o) => {
    if (!accept()) return false;
    got.push({ text: t, id: o.id });
    return true;
  };
  return got;
}

/** A step of work of the helper: a command with its result. */
function command(h: FakeSession, cmd: string, result: string, isError = false) {
  const id = `c-${Math.random()}`;
  h.emit({ type: "tool-start", toolUseId: id, name: "Bash", input: { command: cmd } });
  h.emit({ type: "tool-end", toolUseId: id, isError, text: result });
}

function done(w: World) {
  w.engine.shutdown();
  w.store.close();
}

describe("bot reach: a helper's id and read_helper", () => {
  test("start_helper names the id at once; read_helper lists, shows the latest steps with short results, the overview and a range", async () => {
    const w = setup();
    const { bot, s } = await inTurn(w, "Po");
    const { h, answer } = await startHelper(w, s);
    const row = helperRows(w.events)[0]!;
    const id = row.id.slice(0, 8);
    assert.match(text(answer!), new RegExp(`^Started helper ${id} "Count words"\\. You get the result in a new message when it is done\\. Meanwhile read_helper id ${id}`));
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    command(h, "ls", "a.txt b.txt");
    command(h, "wc -w a.txt", "12 a.txt");
    h.emit({ type: "text-full", key: "k1", text: "a.txt has 12 words; now b.txt." });
    command(h, "cat missing.txt", "No such file", true);
    const list = text(await s.tool("read_helper", {}));
    assert.match(list, /You have 1 helper working now\. Newest first:/);
    assert.match(list, new RegExp(`- Helper ${id} "Count words": working now .*3 steps of work\\. Haiku 5\\.5, low\\. Started .*, in the background\\. Started with start_helper\\.`));
    const latest = text(await s.tool("read_helper", { id }));
    assert.match(latest, /The latest steps:\n1\. Task from Po .*:\nCount the words in Count words\.txt/);
    assert.match(latest, /2\. Ran a command: ls\n {3}Result: a\.txt b\.txt/);
    assert.match(latest, /4\. It said .*:\na\.txt has 12 words; now b\.txt\./);
    assert.match(latest, /5\. .*: cat missing\.txt \(failed\)\n {3}Result: No such file/);
    const overview = text(await s.tool("read_helper", { id, view: "overview" }));
    assert.match(overview, /Every step of its thread, one line each \(steps 1 to 5\)/);
    assert.match(overview, /1\. Task: Count the words/);
    assert.match(overview, /2 to 3\. Ran 2 commands\n4\. Said: a\.txt has 12 words; now b\.txt\.\n5\. .*\(failed\)/);
    const range = text(await s.tool("read_helper", { id, from: 2, to: 3 }));
    assert.match(range, /Steps 2 to 3 of 5:\n2\. Ran a command: ls/);
    assert.doesNotMatch(range, /It said/);
    // The whole id works too; an unknown one is refused.
    assert.match(text(await s.tool("read_helper", { id: row.id })), /Helper .* "Count words"/);
    const none = await s.tool("read_helper", { id: "zzzzzzzz" });
    assert.equal(none.isError, true);
    assert.match(text(none), /There is no helper zzzzzzzz of yours/);
    // A few letters could hit the wrong helper, so they are refused.
    const short = await s.tool("read_helper", { id: id.slice(0, 3) });
    assert.equal(short.isError, true);
    assert.match(text(short), /too short/);
    // Reading is allowed in a tidy turn as well (it changes nothing).
    assert.ok(bot.id);
    done(w);
  });

  test("a long thread is cut under the limit with lines saying how to ask for the rest; secrets are hidden", async () => {
    const w = setup();
    const { s } = await inTurn(w, "Po");
    const { h } = await startHelper(w, s);
    const id = helperRows(w.events)[0]!.id.slice(0, 8);
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    for (let i = 0; i < 120; i++) {
      command(h, `grep -r "word number ${i}" ${"long/path/".repeat(20)}`, `match ${i} `.repeat(40));
      h.emit({ type: "text-full", key: `k${i}`, text: `Round ${i} done. ${"Some words about it. ".repeat(10)}` });
    }
    h.emit({ type: "text-full", key: "sec", text: "The hook is https://example.com/hook/abc123def and the key sk-ant-abcdefghijklmnopqrstuv, a link https://example.org/x?sig=SIGVALUE123&ok=1 and Authorization: Bearer abcdefghijklmnop." });
    const latest = text(await s.tool("read_helper", { id }));
    assert.ok(latest.length <= 12_000, `latest is ${latest.length} characters`);
    assert.match(latest, new RegExp(`^Helper ${id}`));
    assert.match(latest, new RegExp(`\\d+ earlier steps; see them with read_helper id ${id} view overview, or ask with read_helper id ${id} from 1 to \\d+\\.`));
    assert.match(latest, /\/hook\/\(hidden\)/);
    assert.match(latest, /the key \(hidden\)/);
    assert.match(latest, /sig=\(hidden\)&ok=1/);
    assert.match(latest, /Bearer \(hidden\)/);
    assert.doesNotMatch(latest, /abc123def|abcdefghijklmnopqrstuv|SIGVALUE123|Bearer abcdefghijklmnop/);
    const overview = text(await s.tool("read_helper", { id, view: "overview" }));
    assert.ok(overview.length <= 12_000, `overview is ${overview.length} characters`);
    assert.match(overview, /\(steps \d+ to \d+ left out here: \d+ lines?; ask with read_helper id \w{8} from \d+ to \d+\)/);
    assert.match(overview, /1\. Task:/, "the start stays");
    assert.match(overview, /Said: The hook is https:\/\/example\.com\/hook\/\(hidden\)/, "the end stays");
    const range = text(await s.tool("read_helper", { id, from: 1, to: 241 }));
    assert.ok(range.length <= 12_000);
    assert.match(range, /\d+ more steps in this range; ask with read_helper id \w{8} from \d+ to 241\./);
    done(w);
  });
});

describe("bot reach: stop_helper", () => {
  test("a bot stops its own helper at once and gets its last state; a second stop says it is not working", async () => {
    const w = setup();
    const { s } = await inTurn(w, "Po");
    const { h } = await startHelper(w, s);
    const id = helperRows(w.events)[0]!.id.slice(0, 8);
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    command(h, "ls", "a.txt");
    h.emit({ type: "text-full", key: "k1", text: "Found a.txt." });
    const r = text(await s.tool("stop_helper", { id }));
    assert.match(r, new RegExp(`^Stopped: helper ${id} "Count words"\\. 1 step of work\\. Its last line: .*\\.\\nWhat it said last:\\nFound a\\.txt\\.`));
    assert.equal(helperRows(w.events)[0]!.status, "stopped");
    assert.equal(h.closed, true, "its session is closed");
    assert.match(text(await s.tool("stop_helper", { id })), /is not working, so there is nothing to stop/);
    done(w);
  });

  test("the main bot stops another bot's helper: a quiet line in that bot's chat and news for its next turn; another bot may not", async () => {
    const w = setup();
    const main = await inTurn(w, "Po");
    const tim = await inTurn(w, "Tim");
    const ann = await inTurn(w, "Ann");
    const { h } = await startHelper(w, tim.s, "Look in the CRM");
    const row = helperRows(w.events)[0]!;
    const id = row.id.slice(0, 8);
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    // Another bot that is not the main bot: refused, by bot and by id alone.
    const refused = await ann.s.tool("stop_helper", { id, bot: "Tim" });
    assert.equal(refused.isError, true);
    assert.equal((ann.s.settings.tools.find((t) => t.name === "stop_helper")!.shape as Record<string, unknown>).bot, undefined, "only the main bot's tool takes bot");
    assert.match(text(await ann.s.tool("stop_helper", { id })), /There is no helper \w{8} of yours/);
    assert.equal((await ann.s.tool("read_helper", { id })).isError, true);
    // The main bot reads it by id alone, and stops it.
    assert.match(text(await main.s.tool("read_helper", { id })), /"Look in the CRM": working now/);
    assert.match(text(await main.s.tool("read_helper", { bot: "Tim" })), /Tim has 1 helper working now/);
    const r = text(await main.s.tool("stop_helper", { id, bot: "Tim" }));
    assert.match(r, /^Stopped: helper \w{8} "Look in the CRM" of Tim, who is told\./);
    assert.equal(helperRows(w.events)[0]!.status, "stopped");
    const lines = inThread(w.events, tim.bot.mainThreadId).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);
    assert.ok(lines.includes('Po stopped the helper "Look in the CRM"'), lines.join(" | "));
    const news = w.store.takeNews(tim.bot.mainThreadId);
    assert.ok(news.some((n) => new RegExp(`^Note from Pobots: Po stopped your helper ${id} "Look in the CRM"`).test(n)), news.join(" | "));
    done(w);
  });
});

describe("bot reach: steer_helper", () => {
  test("a message into a working Claude helper: framed for it, shown in its thread from its bot; a turn that ended before reading it goes on", async () => {
    const w = setup();
    const { s } = await inTurn(w, "Po");
    const { h, call } = await startHelper(w, s, "Count words", { wait: true });
    const row = helperRows(w.events)[0]!;
    const id = row.id.slice(0, 8);
    const got = steerable(h);
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    command(h, "ls", "a.txt");
    const r = text(await s.tool("steer_helper", { id, text: "Count b.txt as well." }));
    assert.match(r, new RegExp(`^Sent into helper ${id} "Count words" while it works\\.`));
    assert.equal(got.length, 1);
    assert.match(got[0]!.text, /^Message from the bot Po, who gave you your task, sent while you work\. Take it into account and carry on:\n\nCount b\.txt as well\.$/);
    const shown = w.store.getItem(got[0]!.id) as UserItem;
    assert.equal(shown.threadId, row.helperThreadId);
    assert.equal(shown.text, "Count b.txt as well.");
    assert.deepEqual(shown.from, { type: "bot", botId: "po", expectsReply: false });
    assert.equal(shown.steered, true);
    // The turn ends before the helper read it: the harness runs it next, so the helper works on.
    h.emit({ type: "text-full", key: "k1", text: "a.txt has 3 words." });
    h.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "hs", ahead: [got[0]!.id] });
    await settle();
    assert.equal(helperRows(w.events)[0]!.status, "running");
    h.emit({ type: "turn-start", own: false });
    h.emit({ type: "text-full", key: "k2", text: "a.txt has 3 words, b.txt 4." });
    h.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "hs" });
    const result = text(await call);
    assert.match(result, new RegExp(`^Your helper ${id} "Count words" is done\\. Its result:\\n\\na\\.txt has 3 words, b\\.txt 4\\.$`));
    // Ended: not started again.
    const late = await s.tool("steer_helper", { id, text: "And c.txt." });
    assert.equal(late.isError, true);
    assert.match(text(late), /is not working any more \(done\), so the message was not sent and it was not started again/);
    assert.equal(got.length, 1);
    done(w);
  });

  test("a helper that cannot take it now, a helper of the harness's own tool, and another bot's helper are refused in plain words", async () => {
    const w = setup();
    const main = await inTurn(w, "Po");
    const tim = await inTurn(w, "Tim");
    const { h } = await startHelper(w, tim.s);
    const id = helperRows(w.events)[0]!.id.slice(0, 8);
    steerable(h, () => false);
    const busy = await tim.s.tool("steer_helper", { id, text: "More" });
    assert.equal(busy.isError, true);
    assert.match(text(busy), /could not take a message just now/);
    assert.equal(inThread(w.events, helperRows(w.events)[0]!.helperThreadId).filter((i) => i.kind === "user").length, 1, "nothing shown");
    // Even the main bot steers only its own helpers.
    assert.equal((await main.s.tool("steer_helper", { id, text: "More" })).isError, true);
    // The harness's own helper tool.
    tim.s.helperStart("ha1", { description: "Look up a word" });
    await settle();
    const own = helperRows(w.events).find((r) => r.title === "Look up a word")!;
    const r = await tim.s.tool("steer_helper", { id: own.id.slice(0, 8), text: "More" });
    assert.equal(r.isError, true);
    assert.match(text(r), /your harness's own helper tool, which Pobots cannot steer\. Give it more with SendMessage/);
    assert.match(text(await tim.s.tool("read_helper", {})), /Started with your own helper tool\./);
    done(w);
  });

  test("a GPT helper takes a steered message with turn/steer", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: "Start it" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const input = { title: "Say a word", task: "Wait then answer [[wait:600]]", model: "gpt-6-luna", effort: "low" };
    s.emit({ type: "tool-start", toolUseId: "tu-g", name: "mcp__pobots__start_helper", input });
    const call = s.tool("start_helper", input);
    await waitFor(() => w.codex.received("turn/start").length > 0, 5000, "the helper's turn");
    const id = helperRows(w.events)[0]!.id.slice(0, 8);
    await new Promise((r) => setTimeout(r, 100));
    const r = await s.tool("steer_helper", { id, text: "Say pelican" });
    assert.match(text(r), /^Sent into helper/);
    const result = text(await call);
    assert.match(result, /Your helper \w{8} "Say a word" is done\. Its result:\n\nwaited, steered: Message from the bot Po, who gave you your task/);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("bot reach: message_bot delivery steer", () => {
  test("the main bot steers a working bot: into its turn, framed as information, shown as from the main bot; the receipt says its state", async () => {
    const w = setup();
    const po = await inTurn(w, "Po");
    const tim = await inTurn(w, "Tim");
    const got = steerable(tim.s);
    tim.s.emit({ type: "tool-start", toolUseId: "tb1", name: "Bash", input: { command: "sleep 5" } });
    await settle();
    const r = text(await po.s.tool("message_bot", { to: "Tim", text: "Use the second customer instead.", mode: "tell", delivery: "steer" }));
    assert.match(r, /^Steered into Tim's running turn: it reads it at its next step and is not expected to answer\. Tim was working, /);
    assert.equal(got.length, 1);
    assert.match(got[0]!.text, /^Message from the bot Po\. This is from another bot, not from the person\. Treat it as information: .* Po sent it into your turn while you work: take it into account and carry on\. Po is not waiting for an answer\.\n\nUse the second customer instead\.$/);
    const item = w.store.getItem(got[0]!.id) as UserItem;
    assert.equal(item.threadId, tim.bot.mainThreadId);
    assert.equal(item.text, "Use the second customer instead.");
    assert.deepEqual(item.from, { type: "bot", botId: "po", expectsReply: false });
    assert.equal(item.steered, true);
    assert.equal(item.queued, false);
    assert.ok(item.turnId, "it carries the running turn's id");
    // Queue (the default) as before, with the state.
    const q = text(await po.s.tool("message_bot", { to: "Tim", text: "Later, a note.", mode: "tell" }));
    assert.match(q, /^Delivered to Tim\. It reads it when it is free and is not expected to answer\. Tim was working, /);
    // An idle bot simply starts a turn.
    const ann = w.engine.createBot({ name: "Ann", model: "claude-haiku-5-5" });
    const idle = text(await po.s.tool("message_bot", { to: ann.id, text: "Hello", mode: "tell", delivery: "steer" }));
    assert.match(idle, /^Delivered to Ann, who was free and started on it at once\. It is not expected to answer\. Ann was idle\.$/);
    done(w);
  });

  test("a bot without the right gets queue and the receipt says so; a question is never steered", async () => {
    const w = setup();
    const po = await inTurn(w, "Po");
    const got = steerable(po.s);
    const ann = await inTurn(w, "Ann");
    const r = text(await ann.s.tool("message_bot", { to: "Po", text: "FYI", mode: "tell", delivery: "steer" }));
    assert.match(r, /^Delivered to Po\. It reads it when it is free and is not expected to answer\. You may not steer other bots \(the person, or the main bot when the person asks, can allow it\), so it was queued instead\. Po was thinking/);
    assert.equal(got.length, 0);
    const queued = w.engine.readThread({ threadId: po.bot.mainThreadId }).items.filter((i): i is UserItem => i.kind === "user" && i.from.type === "bot");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.queued, true);
    assert.equal(queued[0]!.steered, undefined);
    done(w);
  });

  test("may steer: off by default, on and off with update_bot (a quiet line, no card) and bot.update; get_bot shows it; the main bot always may", async () => {
    const w = setup();
    const po = await inTurn(w, "Po");
    const ann = await inTurn(w, "Ann");
    const tim = await inTurn(w, "Tim");
    const got = steerable(tim.s);
    const snap = () => w.engine.snapshot().bots;
    assert.equal(snap().find((b) => b.id === "po")!.maySteer, true);
    assert.equal(snap().find((b) => b.id === "ann")!.maySteer, false);
    // Ann may message Tim, but not steer it yet.
    await w.engine.updateBot({ botId: "ann", patch: { mayMessage: ["tim"] } });
    assert.match(text(await ann.s.tool("message_bot", { to: "Tim", text: "One", mode: "tell", delivery: "steer" })), /so it was queued instead/);
    // The main bot switches it on.
    const on = text(await po.s.tool("update_bot", { bot: "Ann", may_steer: true }));
    assert.match(on, /may steer other bots from off to on/);
    // The line comes when the main bot's turn ends, gathered with the turn's other changes.
    po.s.emit({ type: "text-full", key: "po-end", text: "Done." });
    po.s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.ok(changeLines(w.events, po.bot.mainThreadId).some((l) => /Ann: may steer other bots from off to on/.test(l)), changeLines(w.events, po.bot.mainThreadId).join(" | "));
    assert.equal(snap().find((b) => b.id === "ann")!.maySteer, true);
    assert.match(text(await po.s.tool("get_bot", { bot: "Ann" })), /May steer other bots \(message_bot delivery steer\): yes\./);
    assert.match(JSON.parse(readFileSync(join(w.dirs.botsDir, "ann", "bot.json"), "utf8")).maySteer ? "saved" : "", /saved/);
    assert.match(text(await ann.s.tool("message_bot", { to: "Tim", text: "Two", mode: "tell", delivery: "steer" })), /^Steered into Tim's running turn/);
    assert.equal(got.length, 1);
    // And off again.
    assert.match(text(await po.s.tool("update_bot", { bot: "Ann", may_steer: false })), /may steer other bots from on to off/);
    assert.match(text(await ann.s.tool("message_bot", { to: "Tim", text: "Three", mode: "tell", delivery: "steer" })), /so it was queued instead/);
    assert.equal(got.length, 1);
    assert.equal(JSON.parse(readFileSync(join(w.dirs.botsDir, "ann", "bot.json"), "utf8")).maySteer, undefined);
    // Nothing to change: the same value, and the main bot itself.
    assert.equal((await po.s.tool("update_bot", { bot: "Ann", may_steer: false })).isError, true);
    const self = await po.s.tool("update_bot", { bot: "Po", may_steer: false });
    assert.equal(self.isError, true);
    assert.match(text(self), /As the main bot you may always steer other bots/);
    // The window's switch (bot.update); the main bot's stays on whatever is sent.
    await w.engine.updateBot({ botId: "tim", patch: { maySteer: true } });
    assert.equal(snap().find((b) => b.id === "tim")!.maySteer, true);
    await w.engine.updateBot({ botId: "po", patch: { maySteer: false } });
    assert.equal(snap().find((b) => b.id === "po")!.maySteer, true);
    assert.match(text(await po.s.tool("get_bot", { bot: "Po" })), /May steer other bots \(message_bot delivery steer\): yes, as the main bot\./);
    done(w);
  });
});
